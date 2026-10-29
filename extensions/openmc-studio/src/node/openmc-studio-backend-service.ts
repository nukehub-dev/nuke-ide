// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * OpenMC Studio Backend Service Implementation
 *
 * Main backend service for the OpenMC Studio extension.
 * Implements the JSON-RPC interface for frontend-backend communication.
 *
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { resolvePythonScript } from 'nuke-core/lib/node/utils/script-resolver';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as path from 'path';

import {
    OpenMCStudioBackendService,
    OpenMCStudioClient,
    DAGMCCreateGraveyardResult,
    XMLGenerationRequest,
    XMLGenerationResult,
    XMLImportRequest,
    XMLImportResult,
    XMLValidationResult,
    SimulationRunRequest,
    SimulationRunResult,
    SimulationLogResult,
    ActiveSimulationInfo,
    StartSimulationResponse,
    ValidationRequest,
    ValidationResult,
    OverlapCheckRequest,
    OverlapCheckResult,
    ProjectCreateRequest,
    ProjectCreateResult,
    ProjectSaveRequest,
    ProjectLoadResult,
    TemplatesResponse,
    ApplyTemplateRequest,
    VolumeCalculationRequest,
    VolumeCalculationResult,
    PlotGenerationRequest,
    PlotGenerationResult,
    NCrystalImportResult,
    MgxsGenerationRequest,
    MgxsGenerationResult,
    OpenMCCompat,
    OPENMC_STATE_SCHEMA_VERSION
} from '../common/openmc-studio-protocol';

import {
    OpenMCState,
    OpenMCProjectFile,
    OpenMCIndependentSource,
    OpenMCSettings,
    OpenMCTally,
    OpenMCTallyFilter,
    OpenMCMesh,
    OpenMCPlotConfig,
    OpenMCDepletion,
    OpenMCVarianceReduction
} from '../common/openmc-state-schema';

import { deriveKineticsFromTallies } from '../common/kinetics-ifp';
import {
    fromOpenMcMaskComponents,
    plotSupportsBackground,
    plotSupportsMask,
    plotSupportsOverlaps,
    validatePlotAppearance
} from '../common/plot-appearance';
import {
    getMeshElementCount,
    inferUnstructuredMeshLibrary,
    validateRectilinearMesh,
    validateUnstructuredMeshFilename
} from '../common/mesh-utils';
import { parseAngleXml, parseSpatialXml, parseTimeXml, parseUnivariateXml, validateSourceDistributions } from '../common/source-utils';
import {
    normalizeWeightWindowSets,
    resolveWeightWindowGeneratorMesh,
    sourceHasBias,
    validateVarianceReduction,
    VarianceReductionIssue
} from '../common/variance-reduction';
import { migrateProjectFile } from '../common/openmc-state-migration';
import { validateDepletionAdvanced, parseDepletionBlock } from '../common/depletion-config';
import { calculateGeometryBounds, boxOverlapsBounds, pointInBounds } from '../common/geometry-bounds';
import { reshapeHexLatticeUniverses } from '../common/geometry-lattices';
import { validateGeometryModel } from '../common/geometry-validation';
import { validateRuntimeSettings } from '../common/settings-validation';
import { pairsFromBins } from '../common/tally-filter-utils';
import { validateTallyFilterSet } from '../common/tally-filter-validation';
import { OpenMCRunnerService } from './openmc-runner-service';
import { XMLGenerationService } from './xml-generation-service';
import { OpenMCCADImportService } from './cad-import-service';
import { DAGMCEditorService } from './dagmc-editor-service';
import { OptimizationBackendService } from './optimization-backend-service';
import { OpenMCCompatProbeService } from './openmc-compat-probe';

/**
 * OpenMC Studio Backend Service Implementation
 *
 * Main backend service implementing the {@link OpenMCStudioBackendService} interface.
 * Coordinates between specialized services (runner, XML generation, CAD import, etc.)
 * and exposes functionality via JSON-RPC to the frontend.
 *
 * @implements {OpenMCStudioBackendService}
 * @implements {BackendApplicationContribution}
 */
/**
 * Read a child element text from an xml2js node.
 * @param node - xml2js element.
 * @param name - Child element name.
 * @returns The child text, or undefined.
 */
function xmlValueFromElement(node: any, name: string): any {
    return node?.[name];
}

/**
 * Collapse a weight-bound array whose entries are all equal back to a scalar.
 * @param values - Bound array from XML.
 * @returns The shared scalar, or the array when it varies.
 */
function collapseUniformBound(values: number[]): number | number[] {
    return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : values;
}

/**
 * One variance-reduction validation finding mapped for the backend.
 * @param issue - Common validation issue.
 * @returns Backend validation issue.
 */
function varianceReductionValidationIssue(issue: VarianceReductionIssue): {
    severity: 'error' | 'warning';
    category: 'settings';
    message: string;
    suggestion: string;
} {
    return {
        severity: issue.severity,
        category: 'settings',
        message: issue.message,
        suggestion: issue.suggestion
    };
}

@injectable()
export class OpenMCStudioBackendServiceImpl implements OpenMCStudioBackendService, BackendApplicationContribution {
    @inject(OpenMCRunnerService)
    protected readonly runnerService: OpenMCRunnerService;

    @inject(XMLGenerationService)
    protected readonly xmlService: XMLGenerationService;

    @inject(OpenMCCADImportService)
    protected readonly cadService: OpenMCCADImportService;

    @inject(DAGMCEditorService)
    protected readonly dagmcEditorService: DAGMCEditorService;

    @inject(OptimizationBackendService)
    protected readonly optimizationService: OptimizationBackendService;

    @inject(OpenMCCompatProbeService)
    protected readonly compatProbe: OpenMCCompatProbeService;

    /**
     * Set the client for receiving log messages and events.
     * @param client - The frontend client interface
     */
    setClient(client: OpenMCStudioClient): void {
        // Forward client to runner service for simulation output streaming
        this.runnerService.setClient(client);
        // Forward client to optimization service for progress updates
        this.optimizationService.registerClient(client);
    }

    /**
     * Set Python configuration (called from nuke-visualizer preferences).
     * @param config - Python path and/or conda environment
     */
    async setPythonConfig(config: { pythonPath?: string; condaEnv?: string }): Promise<void> {
        await this.runnerService.setPythonConfig(config);
        this.dagmcEditorService.setPythonConfig(config);
    }

    /**
     * Log a message to the console (client logging disabled to prevent disconnect errors).
     * @param message - Message to log
     */
    protected log(message: string): void {
        console.log(`[OpenMC Studio] ${message}`);
    }

    /**
     * Log an error to the console (client logging disabled to prevent disconnect errors).
     * @param message - Error message to log
     */
    protected error(message: string): void {
        console.error(`[OpenMC Studio] ${message}`);
    }

    // ============================================================================
    // Lifecycle
    // ============================================================================

    /**
     * Cleanup on application shutdown. Terminates any running simulations.
     */
    onStop(): void {
        console.log('[OpenMC Studio] Shutting down backend service');
        // Cleanup any running simulations
        this.runnerService.cleanup();
    }

    // ============================================================================
    // XML Generation
    // ============================================================================

    /**
     * Generate OpenMC XML files from simulation state.
     * @param request - Generation request with state and output configuration
     * @returns Result with generated file paths
     */
    async generateXML(request: XMLGenerationRequest): Promise<XMLGenerationResult> {
        this.log(`Generating XML files in ${request.outputDirectory}`);
        return this.xmlService.generateXML(await this.withOpenMCCompat(request));
    }

    /**
     * Get the probed OpenMC version compatibility for the configured python
     * environment (cached per python command by the probe service).
     * @returns OpenMC compatibility descriptor
     */
    async getOpenMCCompat(): Promise<OpenMCCompat> {
        return this.compatProbe.getOpenMCCompat();
    }

    /**
     * Check a local file for the mesh editor's missing-file hint.
     * @param filePath - Absolute path to check.
     * @returns Existence, size in bytes, and a diagnostic on failure.
     */
    async checkFileExists(filePath: string): Promise<{ exists: boolean; size?: number; error?: string }> {
        try {
            const fs = await import('fs');
            const path = await import('path');
            if (!path.isAbsolute(filePath)) {
                return { exists: false, error: 'path is not absolute' };
            }
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                return { exists: false, error: 'path is a directory' };
            }
            return { exists: true, size: stat.size };
        } catch (error) {
            return { exists: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    /**
     * Fill in the OpenMC version compatibility from the environment probe
     * unless the caller already specified it. Applied on every
     * frontend-driven generation (XML export, run preparation, project save).
     * @param request - Generation request
     * @returns Request with randomRayCompat resolved
     */
    protected async withOpenMCCompat(request: XMLGenerationRequest): Promise<XMLGenerationRequest> {
        if (!request.files.settings || request.randomRayCompat) {
            return request;
        }
        return { ...request, randomRayCompat: await this.compatProbe.getOpenMCCompat() };
    }

    /**
     * Import OpenMC XML files into simulation state.
     * @param request - Import request with directory and file options
     * @returns Result with imported state, errors, and warnings
     */
    async importXML(request: XMLImportRequest): Promise<XMLImportResult> {
        this.log(`Importing XML from ${request.directory}`);

        try {
            const fs = await import('fs');
            const path = await import('path');

            const materialsPath = path.join(request.directory, 'materials.xml');
            const geometryPath = path.join(request.directory, 'geometry.xml');
            const settingsPath = path.join(request.directory, 'settings.xml');

            const warnings: string[] = [];
            const errors: string[] = [];

            // Use directory name as project name
            const dirName = path.basename(request.directory);
            const state = this.createDefaultState(dirName);

            // Import materials.xml
            let materialsCrossSections: string | undefined;
            if (fs.existsSync(materialsPath)) {
                try {
                    const materialsData = await this.parseMaterialsXML(materialsPath);
                    state.materials = materialsData.materials;
                    materialsCrossSections = materialsData.crossSections;
                    warnings.push(...materialsData.warnings);
                    this.log(`Imported ${materialsData.materials.length} materials`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse materials.xml: ${msg}`);
                }
            } else {
                warnings.push('materials.xml not found');
            }

            // Import geometry.xml
            if (fs.existsSync(geometryPath)) {
                try {
                    const geometryData = await this.parseGeometryXML(geometryPath);
                    state.geometry = geometryData.geometry;
                    warnings.push(...geometryData.warnings);
                    this.log(`Imported ${geometryData.geometry.cells.length} cells, ${geometryData.geometry.surfaces.length} surfaces`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse geometry.xml: ${msg}`);
                }
            } else {
                warnings.push('geometry.xml not found');
            }

            // Import settings.xml
            let settingsMeshes: OpenMCMesh[] = [];
            if (fs.existsSync(settingsPath)) {
                try {
                    const settingsData = await this.parseSettingsXML(settingsPath, request.directory);
                    state.settings = settingsData.settings;
                    state.depletion = settingsData.depletion;
                    settingsMeshes = settingsData.meshes;
                    warnings.push(...settingsData.warnings);
                    // Variance reduction (weight windows/UFS/generator) lives
                    // on OpenMCState.varianceReduction, not settings.
                    state.varianceReduction = settingsData.varianceReduction;
                    this.log(`Imported settings`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse settings.xml: ${msg}`);
                }
            } else {
                warnings.push('settings.xml not found');
            }

            // A <cross_sections> reference in materials.xml fills settings.mgxsLibrary
            // when settings.xml did not provide one (openmc.Materials.cross_sections)
            if (materialsCrossSections && !state.settings.mgxsLibrary) {
                state.settings.mgxsLibrary = materialsCrossSections;
            }

            // Import tallies.xml
            const talliesPath = path.join(request.directory, 'tallies.xml');
            if (fs.existsSync(talliesPath)) {
                try {
                    const talliesData = await this.parseTalliesXML(talliesPath, request.directory);
                    state.tallies = talliesData.tallies;
                    state.meshes = talliesData.meshes;
                    warnings.push(...talliesData.warnings);
                    this.log(`Imported ${talliesData.tallies.length} tallies, ${talliesData.meshes.length} meshes`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse tallies.xml: ${msg}`);
                }
            }

            // Merge meshes carried by settings.xml (MeshSource meshes are
            // written there per settings.py _create_source_subelement) that
            // tallies.xml did not provide
            for (const mesh of settingsMeshes) {
                if (!state.meshes.some((m) => m.id === mesh.id)) {
                    state.meshes.push(mesh);
                }
            }

            // Derive kinetics settings from any IFP tallies found (keeps re-export idempotent)
            const derivedKinetics = deriveKineticsFromTallies(state.tallies, state.settings.kinetics);
            if (derivedKinetics) {
                state.settings.kinetics = derivedKinetics;
            }

            // Import plots.xml
            const plotsPath = path.join(request.directory, 'plots.xml');
            if (fs.existsSync(plotsPath)) {
                try {
                    const plotsData = await this.parsePlotsXML(plotsPath, state);
                    state.plots = plotsData.plots;
                    warnings.push(...plotsData.warnings);
                    for (const plot of state.plots) {
                        warnings.push(...validatePlotAppearance(plot, state).map((issue) => issue.message));
                    }
                    this.log(`Imported ${plotsData.plots.length} plots`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse plots.xml: ${msg}`);
                }
            }

            if (state.materials.length === 0 && state.geometry.cells.length === 0) {
                errors.push('No materials or geometry found in XML files');
                return {
                    success: false,
                    state: undefined,
                    errors,
                    warnings
                };
            }

            return {
                success: true,
                state,
                errors: errors.length > 0 ? errors : [],
                warnings: warnings.length > 0 ? warnings : []
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.error(`XML import failed: ${msg}`);
            return {
                success: false,
                state: undefined,
                errors: [msg],
                warnings: []
            };
        }
    }

    private createDefaultState(name?: string): OpenMCState {
        const now = new Date().toISOString();
        return {
            metadata: {
                version: OPENMC_STATE_SCHEMA_VERSION,
                name: name || 'Untitled Project',
                created: now,
                modified: now
            },
            geometry: {
                surfaces: [],
                cells: [],
                universes: [
                    {
                        id: 0,
                        name: 'root',
                        cellIds: []
                    }
                ],
                lattices: [],
                rootUniverseId: 0
            },
            materials: [],
            settings: {
                run: {
                    mode: 'eigenvalue',
                    particles: 1000,
                    inactive: 10,
                    batches: 100
                },
                sources: []
            },
            tallies: [],
            meshes: []
        };
    }

    private async parseMaterialsXML(filePath: string): Promise<{ materials: any[]; warnings: string[]; crossSections?: string }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');

        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);

        const materials: any[] = [];

        // Multi-group library reference (openmc.Materials.cross_sections)
        const crossSections = result.materials?.cross_sections?.toString();

        if (!result.materials || !result.materials.material) {
            warnings.push('No materials found in materials.xml');
            return { materials, warnings, crossSections };
        }

        const materialArray = Array.isArray(result.materials.material) ? result.materials.material : [result.materials.material];

        for (const mat of materialArray) {
            try {
                const material: any = {
                    id: parseInt(mat.$.id),
                    name: mat.$.name || `Material ${mat.$.id}`,
                    density: 1.0,
                    densityUnit: 'g/cm3',
                    nuclides: [],
                    thermalScattering: []
                };

                // Parse density
                if (mat.density) {
                    material.density = parseFloat(mat.density.$.value);
                    material.densityUnit = mat.density.$.units as any;
                }

                // Parse nuclides and elements
                const materialNuclides = [
                    ...(Array.isArray(mat.nuclide) ? mat.nuclide : mat.nuclide ? [mat.nuclide] : []),
                    ...(Array.isArray(mat.element) ? mat.element : mat.element ? [mat.element] : [])
                ];
                for (const nuc of materialNuclides) {
                    material.nuclides.push({
                        name: nuc.$.name,
                        fraction: parseFloat(nuc.$.ao || nuc.$.wo || '1.0'),
                        fractionType: nuc.$.ao ? 'ao' : 'wo'
                    });
                }

                // Parse S(alpha,beta)
                if (mat.sab) {
                    const sabs = Array.isArray(mat.sab) ? mat.sab : [mat.sab];
                    for (const sab of sabs) {
                        material.thermalScattering.push({
                            name: sab.$.name,
                            fraction: 1.0
                        });
                    }
                }

                // Parse macroscopic (multigroup) data set
                if (mat.macroscopic?.$?.name) {
                    material.macroscopic = { name: mat.macroscopic.$.name };
                }

                // Parse NCrystal configuration (material cfg attribute)
                if (mat.$.cfg) {
                    material.ncrystalCfg = mat.$.cfg;
                }

                // Parse isotropic-in-lab elastic scattering nuclides
                if (mat.isotropic !== undefined) {
                    const isotropic = Array.isArray(mat.isotropic) ? mat.isotropic : [mat.isotropic];
                    material.isotropic = isotropic
                        .flatMap((entry: any) => entry.toString().trim().split(/\s+/))
                        .filter((name: string) => name.length > 0);
                }

                // Parse temperature
                if (mat.$.temperature) {
                    material.temperature = parseFloat(mat.$.temperature);
                }

                materials.push(material);
            } catch (err) {
                warnings.push(`Failed to parse material ${mat.$.id}: ${err}`);
            }
        }

        return { materials, warnings, crossSections };
    }

    private async parseGeometryXML(filePath: string): Promise<{ geometry: any; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');

        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);

        const geometry = {
            surfaces: [] as any[],
            cells: [] as any[],
            universes: [] as any[],
            lattices: [] as any[],
            rootUniverseId: 0
        };

        if (!result.geometry) {
            warnings.push('No geometry element found in geometry.xml');
            return { geometry, warnings };
        }

        const asArray = <T>(value: T | T[] | undefined): T[] => {
            if (value === undefined) return [];
            return Array.isArray(value) ? value : [value];
        };
        const numberList = (text: unknown): number[] =>
            String(text ?? '')
                .trim()
                .split(/\s+/)
                .filter((entry) => entry.length > 0)
                .map((entry) => Number(entry));

        const ensureUniverse = (id: number): any => {
            if (!Number.isFinite(id)) {
                return undefined;
            }
            let universe = geometry.universes.find((u: any) => u.id === id);
            if (!universe) {
                universe = {
                    id,
                    name: id === 0 ? 'root' : `Universe ${id}`,
                    cellIds: []
                };
                geometry.universes.push(universe);
            }
            return universe;
        };

        // Parse surfaces
        for (const surf of asArray(result.geometry.surface)) {
            try {
                const surface: any = {
                    id: parseInt(surf.$.id),
                    type: surf.$.type,
                    coefficients: this.parseCoeffs(surf.$.type, surf.$.coeffs)
                };
                if (surf.$.name) surface.name = surf.$.name;
                // OpenMC defaults an omitted boundary to transmission; leaving it
                // unset keeps that default and keeps interior surfaces unset.
                if (surf.$.boundary) surface.boundary = surf.$.boundary;
                if (surf.$.albedo !== undefined) {
                    const albedo = parseFloat(surf.$.albedo);
                    if (Number.isFinite(albedo)) {
                        surface.albedo = albedo;
                        if (!(surf.$.boundary === 'reflective' || surf.$.boundary === 'periodic' || surf.$.boundary === 'white')) {
                            warnings.push(`Surface ${surf.$.id}: albedo is only meaningful on reflective, periodic, or white boundaries`);
                        }
                    } else {
                        warnings.push(`Surface ${surf.$.id}: could not parse albedo '${surf.$.albedo}'`);
                    }
                }
                if (surf.$.periodic_surface_id !== undefined) {
                    const periodicId = parseInt(surf.$.periodic_surface_id);
                    if (Number.isFinite(periodicId)) {
                        surface.periodicSurfaceId = periodicId;
                        if (surf.$.boundary !== 'periodic') {
                            warnings.push(`Surface ${surf.$.id}: periodic_surface_id is set but the boundary is not periodic`);
                        }
                    } else {
                        warnings.push(`Surface ${surf.$.id}: could not parse periodic_surface_id '${surf.$.periodic_surface_id}'`);
                    }
                } else if (surf.$.boundary === 'periodic') {
                    warnings.push(`Surface ${surf.$.id}: periodic boundary has no periodic_surface_id partner`);
                }
                geometry.surfaces.push(surface);
            } catch (err) {
                warnings.push(`Failed to parse surface ${surf.$.id}: ${err}`);
            }
        }

        // Parse lattices before cells so a cell fill ID can be classified as a
        // lattice or a universe (they share the fill namespace).
        for (const lat of asArray(result.geometry.lattice)) {
            const lattice = this.parseRectLatticeElement(lat, warnings);
            if (lattice) {
                geometry.lattices.push(lattice);
            }
        }
        for (const lat of asArray(result.geometry.hex_lattice)) {
            const lattice = this.parseHexLatticeElement(lat, warnings);
            if (lattice) {
                geometry.lattices.push(lattice);
            }
        }
        const latticeIds = new Set<number>(geometry.lattices.map((lattice: any) => lattice.id));

        // Parse cells
        for (const cell of asArray(result.geometry.cell)) {
            try {
                const cellObj: any = {
                    id: parseInt(cell.$.id),
                    fillType: 'void'
                };
                if (cell.$.name) cellObj.name = cell.$.name;
                if (cell.$.temperature) cellObj.temperature = parseFloat(cell.$.temperature);
                if (cell.$.density !== undefined) {
                    const density = parseFloat(cell.$.density);
                    if (Number.isFinite(density)) {
                        cellObj.density = density;
                    } else {
                        warnings.push(`Cell ${cell.$.id}: could not parse density '${cell.$.density}'`);
                    }
                }
                if (cell.$.translation !== undefined) {
                    const translation = numberList(cell.$.translation);
                    if (translation.length === 3 && translation.every(Number.isFinite)) {
                        cellObj.translation = translation;
                    } else {
                        warnings.push(`Cell ${cell.$.id}: translation must be three numbers; got '${cell.$.translation}'`);
                    }
                }
                if (cell.$.rotation !== undefined) {
                    const rotation = numberList(cell.$.rotation);
                    if (rotation.length === 3 && rotation.every(Number.isFinite)) {
                        cellObj.rotation = rotation;
                    } else if (rotation.length === 9) {
                        warnings.push(
                            `Cell ${cell.$.id}: a 9-element rotation matrix cannot be represented as Tait-Bryan angles; rotation was not imported`
                        );
                    } else {
                        warnings.push(`Cell ${cell.$.id}: rotation must be three angles; got '${cell.$.rotation}'`);
                    }
                }

                // Parse fill - check both attributes (new format) and child elements (old format)
                const materialAttr = cell.$.material;
                const fillAttr = cell.$.fill;
                const materialElem = cell.material;
                const fillElem = cell.fill;

                if (materialAttr !== undefined) {
                    // New format: material as attribute
                    if (materialAttr === '' || materialAttr === 'void') {
                        cellObj.fillType = 'void';
                    } else {
                        const materialId = parseInt(materialAttr);
                        if (Number.isFinite(materialId)) {
                            cellObj.fillType = 'material';
                            cellObj.fillId = materialId;
                        } else {
                            warnings.push(`Cell ${cell.$.id}: could not parse material ID '${materialAttr}'`);
                        }
                    }
                } else if (fillAttr !== undefined) {
                    // New format: fill as attribute (universe or lattice)
                    const fillId = parseInt(fillAttr);
                    if (Number.isFinite(fillId)) {
                        cellObj.fillId = fillId;
                        cellObj.fillType = latticeIds.has(fillId) ? 'lattice' : 'universe';
                    } else {
                        warnings.push(`Cell ${cell.$.id}: could not parse fill ID '${fillAttr}'`);
                    }
                } else if (materialElem) {
                    // Old format: material as child element
                    if (materialElem === '' || materialElem === 'void') {
                        cellObj.fillType = 'void';
                    } else {
                        const materialId = parseInt(materialElem);
                        if (Number.isFinite(materialId)) {
                            cellObj.fillType = 'material';
                            cellObj.fillId = materialId;
                        } else {
                            warnings.push(`Cell ${cell.$.id}: could not parse material ID '${materialElem}'`);
                        }
                    }
                } else if (fillElem) {
                    // Old format: fill as child element (universe or lattice)
                    const fillId = parseInt(fillElem);
                    if (Number.isFinite(fillId)) {
                        cellObj.fillId = fillId;
                        cellObj.fillType = latticeIds.has(fillId) ? 'lattice' : 'universe';
                    } else {
                        warnings.push(`Cell ${cell.$.id}: could not parse fill ID '${fillElem}'`);
                    }
                }

                // Parse region - check both attribute and child element
                if (cell.$.region) {
                    cellObj.regionString = cell.$.region;
                } else if (cell.region) {
                    cellObj.regionString = cell.region;
                }

                geometry.cells.push(cellObj);

                // Get universe ID (default to 0 if not specified)
                const universeId = cell.$.universe ? parseInt(cell.$.universe) : 0;

                // Find or create the universe
                const universe = ensureUniverse(universeId);
                if (!universe) {
                    warnings.push(`Cell ${cellObj.id}: could not parse universe ID '${cell.$.universe}'`);
                    continue;
                }

                // Add cell to its universe
                if (!universe.cellIds.includes(cellObj.id)) {
                    universe.cellIds.push(cellObj.id);
                }
            } catch (err) {
                warnings.push(`Failed to parse cell ${cell.$.id}: ${err}`);
            }
        }

        // Lattice universes and the outer universe can exist without holding
        // cells directly (they are usually filled by nested lattice entries).
        // Keep them in the model so import round-trips preserve membership.
        for (const lattice of geometry.lattices) {
            for (const slice of lattice.universes ?? []) {
                for (const ring of slice ?? []) {
                    for (const universeId of ring ?? []) {
                        ensureUniverse(universeId);
                    }
                }
            }
            if (lattice.outer !== undefined) {
                ensureUniverse(lattice.outer);
            }
        }
        ensureUniverse(0);

        // Empty universes are legal in the state model but not in geometry.xml:
        // OpenMC builds its universe map from cells, so every referenced
        // universe needs at least one cell. Warn now instead of failing at run.
        const universeById = new Map(geometry.universes.map((universe: any) => [universe.id, universe]));
        for (const lattice of geometry.lattices) {
            const referenced = new Set<number>((lattice.universes ?? []).flat(2) as number[]);
            if (lattice.outer !== undefined) {
                referenced.add(lattice.outer);
            }
            const empty = Array.from(referenced).filter((id) => (universeById.get(id)?.cellIds?.length ?? 0) === 0);
            if (empty.length > 0) {
                warnings.push(
                    `Lattice ${lattice.id}: universe ${empty.map((id) => `#${id}`).join(', ')} ${
                        empty.length === 1 ? 'has' : 'have'
                    } no cells; add a cell or OpenMC will reject the geometry`
                );
            }
        }

        return { geometry, warnings };
    }

    /**
     * Parse a `<lattice>` element into the canonical `[z][y][x]` model.
     * @param lat - xml2js element.
     * @param warnings - Warning collector.
     * @returns Parsed lattice, or undefined when required fields are missing.
     */
    private parseRectLatticeElement(lat: any, warnings: string[]): any | undefined {
        if (!lat?.$) {
            warnings.push('Skipping malformed <lattice> element');
            return undefined;
        }
        const id = parseInt(lat.$.id);
        if (!Number.isFinite(id)) {
            warnings.push('Skipping <lattice> without a valid id');
            return undefined;
        }
        const numberList = (text: unknown): number[] =>
            String(text ?? '')
                .trim()
                .split(/\s+/)
                .filter((entry) => entry.length > 0)
                .map(Number);
        const dimensions = numberList(lat.dimension).map((value) => Math.trunc(value));
        if (dimensions.length !== 2 && dimensions.length !== 3) {
            warnings.push(`Lattice ${id}: dimension must be two or three integers; skipped`);
            return undefined;
        }
        if (!dimensions.every((value) => Number.isFinite(value) && value > 0)) {
            warnings.push(`Lattice ${id}: dimension entries must be positive integers; skipped`);
            return undefined;
        }
        const pitch = numberList(lat.pitch);
        const lowerLeft = numberList(lat.lower_left);
        if (pitch.length !== dimensions.length || lowerLeft.length !== dimensions.length) {
            warnings.push(`Lattice ${id}: pitch/lower_left must match the ${dimensions.length} dimension entries; skipped`);
            return undefined;
        }
        const flat = numberList(lat.universes).map((value) => Math.trunc(value));
        const expected = dimensions.reduce((product, value) => product * value, 1);
        if (flat.length !== expected) {
            warnings.push(`Lattice ${id}: expected ${expected} universes but found ${flat.length}`);
        }
        const lattice: any = {
            id,
            type: 'rect',
            lowerLeft,
            pitch,
            dimensions,
            universes: this.reshapeRectUniverses(flat, dimensions as [number, number] | [number, number, number])
        };
        if (lat.$.name) lattice.name = lat.$.name;
        if (lat.outer !== undefined) {
            const outer = parseInt(lat.outer);
            if (Number.isFinite(outer)) {
                lattice.outer = outer;
            } else {
                warnings.push(`Lattice ${id}: could not parse outer universe '${lat.outer}'`);
            }
        }
        return lattice;
    }

    /**
     * Parse a `<hex_lattice>` element into the canonical `[z][ring][theta]` model.
     * @param lat - xml2js element.
     * @param warnings - Warning collector.
     * @returns Parsed lattice, or undefined when required fields are missing.
     */
    private parseHexLatticeElement(lat: any, warnings: string[]): any | undefined {
        if (!lat?.$) {
            warnings.push('Skipping malformed <hex_lattice> element');
            return undefined;
        }
        const id = parseInt(lat.$.id);
        if (!Number.isFinite(id)) {
            warnings.push('Skipping <hex_lattice> without a valid id');
            return undefined;
        }
        const rings = parseInt(lat.$.n_rings);
        if (!Number.isFinite(rings) || rings < 1) {
            warnings.push(`Hex lattice ${id}: n_rings must be a positive integer; skipped`);
            return undefined;
        }
        const orientation = lat.$.orientation === 'x' ? 'x' : 'y';
        if (lat.$.orientation !== undefined && lat.$.orientation !== 'x' && lat.$.orientation !== 'y') {
            warnings.push(`Hex lattice ${id}: orientation '${lat.$.orientation}' is not 'x' or 'y'; using 'y'`);
        }
        const numberList = (text: unknown): number[] =>
            String(text ?? '')
                .trim()
                .split(/\s+/)
                .filter((entry) => entry.length > 0)
                .map(Number);
        const nAxialRaw = lat.$.n_axial !== undefined ? parseInt(lat.$.n_axial) : undefined;
        const nAxial = nAxialRaw !== undefined && Number.isFinite(nAxialRaw) && nAxialRaw > 1 ? nAxialRaw : undefined;
        if (nAxialRaw === 1) {
            warnings.push(`Hex lattice ${id}: n_axial="1" is treated as a 2D lattice (OpenMC C++ requires 3D center/pitch for n_axial)`);
        }
        const is3d = nAxial !== undefined;
        const center = numberList(lat.center);
        const pitch = numberList(lat.pitch);
        if (center.length !== (is3d ? 3 : 2) || pitch.length !== (is3d ? 2 : 1)) {
            warnings.push(
                `Hex lattice ${id}: center/pitch must have ${is3d ? '3 center values and 2 pitches' : '2 center values and 1 pitch'}; skipped`
            );
            return undefined;
        }
        const flat = numberList(lat.universes).map((value) => Math.trunc(value));
        const expected = (3 * rings * rings - 3 * rings + 1) * (nAxial ?? 1);
        if (flat.length !== expected) {
            warnings.push(`Hex lattice ${id}: expected ${expected} universes but found ${flat.length}`);
        }
        const lattice: any = {
            id,
            type: 'hex',
            rings,
            center,
            pitch,
            universes: this.reshapeHexUniverses(flat, rings, orientation, nAxial ?? 1)
        };
        if (orientation === 'x') {
            lattice.orientation = 'x';
        }
        if (nAxial !== undefined) {
            lattice.nAxial = nAxial;
        }
        if (lat.$.name) lattice.name = lat.$.name;
        if (lat.outer !== undefined) {
            const outer = parseInt(lat.outer);
            if (Number.isFinite(outer)) {
                lattice.outer = outer;
            } else {
                warnings.push(`Hex lattice ${id}: could not parse outer universe '${lat.outer}'`);
            }
        }
        return lattice;
    }

    /**
     * Reshape a flat `<lattice><universes>` list into `[z][y][x]`.
     * @param flat - Universe IDs in XML order.
     * @param dimensions - `[nx, ny]` or `[nx, ny, nz]`.
     * @returns Nested universe array.
     */
    private reshapeRectUniverses(flat: number[], dimensions: [number, number] | [number, number, number]): number[][][] {
        const [nx, ny, nz = 1] = dimensions;
        const universes: number[][][] = [];
        let index = 0;
        for (let z = 0; z < nz; z++) {
            const slice: number[][] = [];
            for (let y = 0; y < ny; y++) {
                const row: number[] = [];
                for (let x = 0; x < nx; x++) {
                    row.push(flat[index++] ?? 0);
                }
                slice.push(row);
            }
            universes.push(slice);
        }
        return universes;
    }

    /**
     * Reshape a flat `<hex_lattice><universes>` list into `[z][ring][theta]`.
     * @param flat - Universe IDs in XML order.
     * @param rings - Number of rings including the center ring.
     * @param orientation - Hexagon orientation.
     * @param nAxial - Number of axial slices.
     * @returns Nested universe array.
     */
    private reshapeHexUniverses(flat: number[], rings: number, orientation: 'x' | 'y', nAxial: number): number[][][] {
        return reshapeHexLatticeUniverses(flat, rings, orientation, nAxial);
    }

    private parseCoeffs(surfaceType: string, coeffsStr: string): any {
        const values = coeffsStr
            .split(/\s+/)
            .map((v) => parseFloat(v.trim()))
            .filter((v) => !isNaN(v));

        // Return as structured object based on surface type
        switch (surfaceType) {
            case 'sphere':
                // coeffs: x0 y0 z0 r
                if (values.length >= 4) {
                    return { x0: values[0], y0: values[1], z0: values[2], r: values[3] };
                }
                break;
            case 'x-cylinder':
                // coeffs: y0 z0 r
                if (values.length >= 3) {
                    return { y0: values[0], z0: values[1], r: values[2] };
                }
                break;
            case 'y-cylinder':
                // coeffs: x0 z0 r
                if (values.length >= 3) {
                    return { x0: values[0], z0: values[1], r: values[2] };
                }
                break;
            case 'z-cylinder':
                // coeffs: x0 y0 r
                if (values.length >= 3) {
                    return { x0: values[0], y0: values[1], r: values[2] };
                }
                break;
            case 'x-plane':
                // coeffs: x0
                if (values.length >= 1) {
                    return { x0: values[0] };
                }
                break;
            case 'y-plane':
                // coeffs: y0
                if (values.length >= 1) {
                    return { y0: values[0] };
                }
                break;
            case 'z-plane':
                // coeffs: z0
                if (values.length >= 1) {
                    return { z0: values[0] };
                }
                break;
            case 'plane':
                // coeffs: a b c d
                if (values.length >= 4) {
                    return { a: values[0], b: values[1], c: values[2], d: values[3] };
                }
                break;
            case 'x-cone':
            case 'y-cone':
            case 'z-cone':
                // coeffs: x0 y0 z0 r2
                if (values.length >= 4) {
                    return { x0: values[0], y0: values[1], z0: values[2], r2: values[3] };
                }
                break;
        }

        // Fallback: return as array if type unknown or insufficient values
        return values;
    }

    private async parseSettingsXML(
        filePath: string,
        baseDirectory?: string
    ): Promise<{
        settings: any;
        depletion?: OpenMCDepletion;
        weightWindowGenerator?: any;
        varianceReduction?: OpenMCVarianceReduction;
        meshes: OpenMCMesh[];
        warnings: string[];
    }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');

        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parsedDepletion = parseDepletionBlock(xml);
        if (parsedDepletion) {
            warnings.push(...parsedDepletion.warnings);
        }
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);

        const settings: any = {
            run: {
                mode: 'eigenvalue',
                particles: 1000,
                inactive: 10,
                batches: 100
            },
            sources: []
        };

        if (!result.settings) {
            warnings.push('No settings element found in settings.xml');
            return { settings, depletion: parsedDepletion?.depletion, meshes: [], warnings };
        }

        const s = result.settings;

        // Run mode
        if (s.run_mode) {
            settings.run.mode = s.run_mode;
        }

        // Particles and batches
        if (s.particles) {
            settings.run.particles = parseInt(s.particles);
        }
        if (s.batches) {
            settings.run.batches = parseInt(s.batches);
        }
        if (s.inactive) {
            settings.run.inactive = parseInt(s.inactive);
        }

        // Source rejection fraction
        if (s.source_rejection_fraction) {
            settings.sourceRejectionFraction = parseFloat(s.source_rejection_fraction);
        }

        // Seed
        if (s.seed) {
            settings.seed = parseInt(s.seed);
        }

        // IFP kinetics generations
        if (s.ifp_n_generation !== undefined) {
            settings.kinetics = { ...(settings.kinetics ?? {}), enabled: true, ifpNGenerations: parseInt(s.ifp_n_generation) };
        }

        // Photon transport and photon physics
        if (s.photon_transport !== undefined) {
            settings.photonTransport = this.parseXmlBool(s.photon_transport);
        }
        if (s.electron_treatment) {
            settings.electronTreatment = s.electron_treatment.toString();
        }
        if (s.atomic_relaxation !== undefined) {
            settings.atomicRelaxation = this.parseXmlBool(s.atomic_relaxation);
        }

        // Output control
        if (s.output) {
            const output: any = {};
            if (s.output.summary !== undefined) {
                output.summary = this.parseXmlBool(s.output.summary);
            }
            if (s.output.tallies !== undefined) {
                output.tallies = this.parseXmlBool(s.output.tallies);
            }
            if (s.output.path) {
                output.path = s.output.path.toString();
            }
            settings.output = output;
        }

        // Statepoint batches
        if (s.state_point?.batches) {
            settings.statepointBatches = this.parseNumberList(s.state_point.batches).map((n) => Math.trunc(n));
        }

        // Sourcepoint options
        if (s.source_point) {
            const sp: any = {};
            if (s.source_point.batches) {
                sp.batches = this.parseNumberList(s.source_point.batches).map((n) => Math.trunc(n));
            }
            if (s.source_point.separate !== undefined) {
                sp.separate = this.parseXmlBool(s.source_point.separate);
            }
            if (s.source_point.write !== undefined) {
                sp.write = this.parseXmlBool(s.source_point.write);
            }
            if (s.source_point.overwrite_latest !== undefined) {
                sp.overwrite = this.parseXmlBool(s.source_point.overwrite_latest);
            }
            if (s.source_point.mcpl !== undefined) {
                sp.mcpl = this.parseXmlBool(s.source_point.mcpl);
            }
            settings.sourcePoint = sp;
        }

        // Surface source writing
        if (s.surf_source_write) {
            const ssw: any = {};
            if (s.surf_source_write.surface_ids) {
                ssw.surfaceIds = this.parseNumberList(s.surf_source_write.surface_ids).map((n) => Math.trunc(n));
            }
            if (s.surf_source_write.mcpl !== undefined) {
                ssw.mcpl = this.parseXmlBool(s.surf_source_write.mcpl);
            }
            if (s.surf_source_write.max_particles !== undefined) {
                ssw.maxParticles = parseInt(s.surf_source_write.max_particles);
            }
            if (s.surf_source_write.max_source_files !== undefined) {
                ssw.maxSourceFiles = parseInt(s.surf_source_write.max_source_files);
            }
            if (s.surf_source_write.cell !== undefined) {
                ssw.cell = parseInt(s.surf_source_write.cell);
            }
            if (s.surf_source_write.cellfrom !== undefined) {
                ssw.cellfrom = parseInt(s.surf_source_write.cellfrom);
            }
            if (s.surf_source_write.cellto !== undefined) {
                ssw.cellto = parseInt(s.surf_source_write.cellto);
            }
            settings.surfaceSourceWrite = ssw;
        }

        // Surface source reading
        if (s.surf_source_read?.path) {
            settings.surfaceSourceRead = { path: s.surf_source_read.path.toString() };
        }

        // Particle tracks (flattened [batch, generation, particle] triples)
        if (s.track) {
            const values = this.parseNumberList(s.track).map((n) => Math.trunc(n));
            const tracks: [number, number, number][] = [];
            for (let i = 0; i + 2 < values.length; i += 3) {
                tracks.push([values[i], values[i + 1], values[i + 2]]);
            }
            settings.tracks = tracks;
        }
        if (s.max_tracks !== undefined) {
            settings.maxTracks = parseInt(s.max_tracks);
        }

        // Collision track output
        if (s.collision_track) {
            const ct: any = {};
            if (s.collision_track.cell_ids) {
                ct.cellIds = this.parseNumberList(s.collision_track.cell_ids).map((n) => Math.trunc(n));
            }
            if (s.collision_track.reactions) {
                ct.reactions = s.collision_track.reactions
                    .toString()
                    .trim()
                    .split(/\s+/)
                    .map((token: string) => (/^-?\d+$/.test(token) ? parseInt(token) : token));
            }
            if (s.collision_track.universe_ids) {
                ct.universeIds = this.parseNumberList(s.collision_track.universe_ids).map((n) => Math.trunc(n));
            }
            if (s.collision_track.material_ids) {
                ct.materialIds = this.parseNumberList(s.collision_track.material_ids).map((n) => Math.trunc(n));
            }
            if (s.collision_track.nuclides) {
                ct.nuclides = s.collision_track.nuclides.toString().trim().split(/\s+/);
            }
            if (s.collision_track.deposited_E_threshold !== undefined) {
                ct.depositedEnergyThreshold = parseFloat(s.collision_track.deposited_E_threshold);
            }
            if (s.collision_track.max_collisions !== undefined) {
                ct.maxCollisions = parseInt(s.collision_track.max_collisions);
            }
            if (s.collision_track.max_collision_track_files !== undefined) {
                ct.maxCollisionTrackFiles = parseInt(s.collision_track.max_collision_track_files);
            }
            if (s.collision_track.mcpl !== undefined) {
                ct.mcpl = this.parseXmlBool(s.collision_track.mcpl);
            }
            settings.collisionTrack = ct;
        }

        // Shannon entropy mesh (reference + inline <mesh> element)
        if (s.entropy_mesh !== undefined) {
            const entropyMeshId = parseInt(s.entropy_mesh);
            const meshElems = Array.isArray(s.mesh) ? s.mesh : s.mesh ? [s.mesh] : [];
            const meshElem = meshElems.find((m: any) => parseInt(m.$?.id) === entropyMeshId);
            if (meshElem) {
                settings.entropyMesh = {
                    id: entropyMeshId,
                    lowerLeft: this.parseNumberList(meshElem.lower_left) as [number, number, number],
                    upperRight: this.parseNumberList(meshElem.upper_right) as [number, number, number],
                    shape: this.parseNumberList(meshElem.dimension).map((n) => Math.trunc(n)) as [number, number, number]
                };
            } else {
                warnings.push(`Entropy mesh with ID ${entropyMeshId} referenced but not found in settings.xml`);
            }
        }

        // Energy mode and MGXS library (multi-group / random ray)
        if (s.energy_mode) {
            settings.energyMode = s.energy_mode.toString() === 'multi-group' ? 'multigroup' : s.energy_mode.toString();
        }
        if (s.cross_sections) {
            settings.mgxsLibrary = s.cross_sections.toString();
        }

        // Random ray solver settings
        if (s.random_ray) {
            const rr = s.random_ray;
            const randomRay: any = {};
            if (rr.distance_inactive !== undefined) {
                randomRay.distanceInactive = parseFloat(rr.distance_inactive);
            }
            if (rr.distance_active !== undefined) {
                randomRay.distanceActive = parseFloat(rr.distance_active);
            }
            if (rr.volume_estimator) {
                randomRay.volumeEstimator = rr.volume_estimator.toString();
            }
            if (rr.source_shape) {
                randomRay.sourceShape = rr.source_shape.toString();
            }
            if (rr.volume_normalized_flux_tallies !== undefined) {
                randomRay.volumeNormalizedFluxTallies = this.parseXmlBool(rr.volume_normalized_flux_tallies);
            }
            if (rr.sample_method) {
                randomRay.sampleMethod = rr.sample_method.toString();
            }
            if (rr.diagonal_stabilization_rho !== undefined) {
                randomRay.diagonalStabilizationRho = parseFloat(rr.diagonal_stabilization_rho);
            }
            if (rr.adjoint !== undefined) {
                randomRay.adjoint = this.parseXmlBool(rr.adjoint);
            }
            // ray_source: 0.16.0+ wraps <source> in <ray_source>; 0.15.3
            // puts <source> directly under <random_ray> — accept both
            const raySourceElem = rr.ray_source?.source ?? rr.source;
            const raySrc = Array.isArray(raySourceElem) ? raySourceElem[0] : raySourceElem;
            if (raySrc?.space?.parameters) {
                const params = this.parseNumberList(raySrc.space.parameters);
                if (params.length >= 6) {
                    randomRay.raySource = {
                        lowerLeft: params.slice(0, 3),
                        upperRight: params.slice(3, 6)
                    };
                }
            }
            if (rr.adjoint_source?.source?.space?.parameters) {
                // Single-source UI model; take the first entry if a list
                const adjSrc = Array.isArray(rr.adjoint_source.source) ? rr.adjoint_source.source[0] : rr.adjoint_source.source;
                const params = this.parseNumberList(adjSrc.space.parameters);
                if (params.length >= 6) {
                    randomRay.adjointSource = {
                        lowerLeft: params.slice(0, 3),
                        upperRight: params.slice(3, 6)
                    };
                }
            }
            if (rr.source_region_meshes?.mesh) {
                const srMesh = rr.source_region_meshes.mesh;
                randomRay.sourceRegionMeshId = parseInt(srMesh.$?.id);
                const domainElems = Array.isArray(srMesh.domain) ? srMesh.domain : srMesh.domain ? [srMesh.domain] : [];
                randomRay.sourceRegionDomainIds = domainElems.map((d: any) => parseInt(d.$?.id)).filter((n: number) => !isNaN(n));
                if (domainElems.length > 0 && domainElems[0].$?.type) {
                    randomRay.sourceRegionDomainType = domainElems[0].$.type;
                }
            }
            settings.randomRay = randomRay;
        }

        // Weight window generator (real OpenMC format); returned via the
        // varianceReduction side channel since it lives on OpenMCState, not OpenMCSettings
        let parsedWeightWindowGenerator: any;
        if (s.weight_window_generators?.weight_windows_generator) {
            const wwgElems = Array.isArray(s.weight_window_generators.weight_windows_generator)
                ? s.weight_window_generators.weight_windows_generator
                : [s.weight_window_generators.weight_windows_generator];
            const wwg = wwgElems[0];
            const weightWindowGenerator: any = {};
            if (wwg.mesh !== undefined) {
                weightWindowGenerator.meshId = parseInt(wwg.mesh);
            }
            if (wwg.energy_bounds) {
                weightWindowGenerator.energyBounds = this.parseNumberList(wwg.energy_bounds);
            }
            if (wwg.particle_type) {
                weightWindowGenerator.particleType = wwg.particle_type.toString();
            }
            if (wwg.max_realizations !== undefined) {
                weightWindowGenerator.maxRealizations = parseInt(wwg.max_realizations);
            }
            if (wwg.update_interval !== undefined) {
                weightWindowGenerator.updateInterval = parseInt(wwg.update_interval);
            }
            if (wwg.on_the_fly !== undefined) {
                weightWindowGenerator.onTheFly = this.parseXmlBool(wwg.on_the_fly);
            }
            if (wwg.method) {
                weightWindowGenerator.method = wwg.method.toString();
            }
            if (wwg.targets) {
                weightWindowGenerator.targetTallyIds = this.parseNumberList(wwg.targets).map((n) => Math.trunc(n));
            }
            parsedWeightWindowGenerator = weightWindowGenerator;
        }

        const parsedVarianceReduction = this.parseVarianceReductionSettings(s, parsedWeightWindowGenerator, warnings);

        // Source
        if (s.source) {
            const sources = Array.isArray(s.source) ? s.source : [s.source];

            for (const src of sources) {
                const source = this.parseSourceElement(src, warnings);
                if (source) {
                    settings.sources.push(source);
                }
            }
        }

        // Temperature settings (separate temperature_* elements)
        const temperature: NonNullable<OpenMCSettings['temperature']> = {};
        if (s.temperature_default !== undefined) {
            temperature.default = parseFloat(s.temperature_default);
        }
        if (s.temperature_method) {
            temperature.method = s.temperature_method.toString() as NonNullable<OpenMCSettings['temperature']>['method'];
        }
        if (s.temperature_tolerance !== undefined) {
            temperature.tolerance = parseFloat(s.temperature_tolerance);
        }
        if (s.temperature_multipole !== undefined) {
            temperature.multipole = this.parseXmlBool(s.temperature_multipole);
        }
        if (Object.keys(temperature).length > 0) {
            settings.temperature = temperature;
        }

        // Cutoff block (weight, energy, and time)
        if (s.cutoff) {
            const cutoff: NonNullable<OpenMCSettings['cutoff']> = {};
            if (s.cutoff.weight !== undefined) {
                cutoff.weight = parseFloat(s.cutoff.weight);
            }
            if (s.cutoff.weight_avg !== undefined) {
                cutoff.weightAvg = parseFloat(s.cutoff.weight_avg);
            }
            if (s.cutoff.energy_neutron !== undefined) {
                cutoff.energyNeutron = parseFloat(s.cutoff.energy_neutron);
            }
            if (s.cutoff.energy_photon !== undefined) {
                cutoff.energyPhoton = parseFloat(s.cutoff.energy_photon);
            }
            if (s.cutoff.time_neutron !== undefined) {
                cutoff.time = parseFloat(s.cutoff.time_neutron);
            }
            if (s.cutoff.time_photon !== undefined) {
                cutoff.timePhoton = parseFloat(s.cutoff.time_photon);
            }
            if (Object.keys(cutoff).length > 0) {
                settings.cutoff = cutoff;
            }
        }

        // Resonance elastic scattering
        if (s.resonance_scattering) {
            const resonance: NonNullable<OpenMCSettings['resonanceScattering']> = {};
            const rs = s.resonance_scattering;
            if (rs.enable !== undefined) {
                resonance.enable = this.parseXmlBool(rs.enable);
            }
            if (rs.method) {
                resonance.method = rs.method.toString() as NonNullable<OpenMCSettings['resonanceScattering']>['method'];
            }
            if (rs.energy_min !== undefined) {
                resonance.energyMin = parseFloat(rs.energy_min);
            }
            if (rs.energy_max !== undefined) {
                resonance.energyMax = parseFloat(rs.energy_max);
            }
            if (Object.keys(resonance).length > 0) {
                settings.resonanceScattering = resonance;
            }
        }

        // Particle trace triplet
        if (s.trace !== undefined) {
            const trace = this.parseNumberList(s.trace).map((n) => Math.trunc(n));
            if (trace.length === 3) {
                settings.trace = trace as [number, number, number];
            } else {
                warnings.push('settings.xml <trace> must contain exactly three integers (batch generation particle); ignored');
            }
        }

        // Combined k-eff trigger
        if (s.keff_trigger) {
            const type = s.keff_trigger.type?.toString();
            const threshold = s.keff_trigger.threshold !== undefined ? parseFloat(s.keff_trigger.threshold) : undefined;
            if ((type === 'variance' || type === 'std_dev' || type === 'rel_err') && threshold !== undefined) {
                settings.keffTrigger = { type, threshold };
            } else {
                warnings.push('settings.xml <keff_trigger> needs a valid type and threshold; ignored');
            }
        }

        // Confidence intervals, free-gas threshold, and 0.16 surface/settings
        if (s.confidence_intervals !== undefined) {
            settings.confidenceIntervals = this.parseXmlBool(s.confidence_intervals);
        }
        if (s.free_gas_threshold !== undefined) {
            settings.freeGasThreshold = parseFloat(s.free_gas_threshold);
        }
        if (s.shared_secondary_bank !== undefined) {
            settings.sharedSecondaryBank = this.parseXmlBool(s.shared_secondary_bank);
        }
        if (s.surface_grazing_cutoff !== undefined) {
            settings.surfaceGrazingCutoff = parseFloat(s.surface_grazing_cutoff);
        }
        if (s.surface_grazing_ratio !== undefined) {
            settings.surfaceGrazingRatio = parseFloat(s.surface_grazing_ratio);
        }

        // Particle limits and diagnostics
        if (s.max_particle_events !== undefined) {
            settings.maxParticleEvents = parseInt(s.max_particle_events);
        }
        if (s.max_particles_in_flight !== undefined) {
            settings.maxParticlesInFlight = parseInt(s.max_particles_in_flight);
        }
        if (s.max_secondaries !== undefined) {
            settings.maxSecondaries = parseInt(s.max_secondaries);
        }
        if (s.max_history_splits !== undefined) {
            settings.maxHistorySplits = parseInt(s.max_history_splits);
        }
        if (s.max_write_lost_particles !== undefined) {
            settings.maxWriteLostParticles = parseInt(s.max_write_lost_particles);
        }
        if (s.no_reduce !== undefined) {
            settings.noReduce = this.parseXmlBool(s.no_reduce);
        }
        if (s.stride !== undefined) {
            settings.stride = parseInt(s.stride);
        }
        if (s.plot_seed !== undefined) {
            settings.plotSeed = parseInt(s.plot_seed);
        }
        if (s.properties_file !== undefined) {
            settings.propertiesFile = s.properties_file.toString();
        }
        if (s.verbosity !== undefined) {
            settings.verbosity = parseInt(s.verbosity);
        }
        if (s.material_cell_offsets !== undefined) {
            settings.materialCellOffsets = this.parseXmlBool(s.material_cell_offsets);
        }

        // Advanced scalar settings (element names match settings.py _create_*_subelement)
        if (s.event_based !== undefined) {
            settings.eventBased = this.parseXmlBool(s.event_based);
        }
        if (s.ptables !== undefined) {
            settings.probabilityTables = this.parseXmlBool(s.ptables);
        }
        if (s.max_lost_particles !== undefined) {
            settings.maxLostParticles = parseInt(s.max_lost_particles);
        }
        if (s.rel_max_lost_particles !== undefined) {
            settings.relLostParticleRate = parseFloat(s.rel_max_lost_particles);
        }
        if (s.create_fission_neutrons !== undefined) {
            settings.createFissionNeutrons = this.parseXmlBool(s.create_fission_neutrons);
        }
        if (s.create_delayed_neutrons !== undefined) {
            settings.createDelayedNeutrons = this.parseXmlBool(s.create_delayed_neutrons);
        }
        if (s.delayed_photon_scaling !== undefined) {
            settings.delayedPhotonScaling = this.parseXmlBool(s.delayed_photon_scaling);
        }
        if (s.use_decay_photons !== undefined) {
            settings.useDecayPhotons = this.parseXmlBool(s.use_decay_photons);
        }
        if (s.log_grid_bins !== undefined) {
            settings.logGridBins = parseInt(s.log_grid_bins);
        }
        if (s.survival_biasing !== undefined) {
            settings.survivalBiasing = this.parseXmlBool(s.survival_biasing);
        }
        if (s.generations_per_batch !== undefined) {
            settings.generationsPerBatch = parseInt(s.generations_per_batch);
        }
        if (s.max_order !== undefined) {
            settings.maxOrder = parseInt(s.max_order);
        }
        if (s.write_initial_source !== undefined) {
            settings.writeInitialSource = this.parseXmlBool(s.write_initial_source);
        }
        if (s.uniform_source_sampling !== undefined) {
            settings.uniformSourceSampling = this.parseXmlBool(s.uniform_source_sampling);
        }
        if (s.tabular_legendre) {
            const tabularLegendre: { enable?: boolean; numPoints?: number } = {};
            if (s.tabular_legendre.enable !== undefined) {
                tabularLegendre.enable = this.parseXmlBool(s.tabular_legendre.enable);
            }
            if (s.tabular_legendre.num_points !== undefined) {
                tabularLegendre.numPoints = parseInt(s.tabular_legendre.num_points);
            }
            if (tabularLegendre.enable !== undefined || tabularLegendre.numPoints !== undefined) {
                settings.tabularLegendre = tabularLegendre;
            }
        }

        // Run-level tally trigger settings (settings.py _trigger_from_xml_element)
        if (s.trigger) {
            const triggerBlock: { maxBatches?: number; batchInterval?: number } = {};
            if (s.trigger.max_batches !== undefined) {
                triggerBlock.maxBatches = parseInt(s.trigger.max_batches);
            }
            if (s.trigger.batch_interval !== undefined) {
                triggerBlock.batchInterval = parseInt(s.trigger.batch_interval);
            }
            if (triggerBlock.maxBatches !== undefined || triggerBlock.batchInterval !== undefined) {
                settings.triggers = triggerBlock;
            }
        }

        // Meshes referenced by mesh sources live at the settings root
        // (settings.py _create_source_subelement); parse them so the caller
        // can merge them into state.meshes
        const sourceMeshes: OpenMCMesh[] = [];
        const referencedMeshIds = new Set<number>();
        for (const source of settings.sources as any[]) {
            if (source.type === 'mesh' && source.meshId !== undefined) {
                referencedMeshIds.add(source.meshId);
            }
            if (
                (source.type ?? 'independent') === 'independent' &&
                source.spatial?.type === 'mesh' &&
                source.spatial.meshId !== undefined
            ) {
                referencedMeshIds.add(source.spatial.meshId);
            }
        }
        for (const set of parsedVarianceReduction?.weightWindows ?? []) {
            if (set.meshId !== undefined) {
                referencedMeshIds.add(set.meshId);
            }
        }
        const generatorMeshId = resolveWeightWindowGeneratorMesh(parsedVarianceReduction);
        if (generatorMeshId !== undefined) {
            referencedMeshIds.add(generatorMeshId);
        }
        if (parsedVarianceReduction?.ufs?.enabled && parsedVarianceReduction.ufs.meshId !== undefined) {
            referencedMeshIds.add(parsedVarianceReduction.ufs.meshId);
        }
        if (referencedMeshIds.size > 0) {
            const meshElems = Array.isArray(s.mesh) ? s.mesh : s.mesh ? [s.mesh] : [];
            for (const meshElem of meshElems) {
                if (referencedMeshIds.has(parseInt(meshElem.$?.id))) {
                    sourceMeshes.push(this.parseMeshElement(meshElem, baseDirectory));
                }
            }
            for (const id of referencedMeshIds) {
                if (!sourceMeshes.some((m) => m.id === id)) {
                    warnings.push(`settings.xml references mesh ${id} but no <mesh> element with that ID was found`);
                }
            }
        }

        return {
            settings,
            depletion: parsedDepletion?.depletion,
            weightWindowGenerator: parsedWeightWindowGenerator,
            varianceReduction: parsedVarianceReduction,
            meshes: sourceMeshes,
            warnings
        };
    }

    /**
     * Parse variance-reduction elements from settings.xml. OpenMC writes one
     * `<weight_windows id="...">` block per set, plus `<weight_windows_on>`,
     * `<weight_windows_file>`, `<weight_window_checkpoints>`, and `<ufs_mesh>`.
     * @param s - Parsed `<settings>` element.
     * @param weightWindowGenerator - Parsed generator side channel.
     * @param warnings - Import warning sink.
     * @returns Variance-reduction state, or undefined when nothing is set.
     */
    private parseVarianceReductionSettings(s: any, weightWindowGenerator: any, warnings: string[]): OpenMCVarianceReduction | undefined {
        const varianceReduction: OpenMCVarianceReduction = {};
        const wwElems = Array.isArray(s.weight_windows) ? s.weight_windows : s.weight_windows ? [s.weight_windows] : [];
        const sets = wwElems
            .map((element: any): any => {
                const meshId = parseInt(String(xmlValueFromElement(element, 'mesh') ?? ''));
                const lowerBound = this.parseNumberList(xmlValueFromElement(element, 'lower_ww_bounds'));
                const upperBound = this.parseNumberList(xmlValueFromElement(element, 'upper_ww_bounds'));
                const energyBounds = this.parseNumberList(xmlValueFromElement(element, 'energy_bounds'));
                const set: any = {
                    id: parseInt(String(element?.$?.id ?? '')) || undefined,
                    meshId: Number.isFinite(meshId) ? meshId : undefined,
                    lowerBound: lowerBound.length > 0 ? collapseUniformBound(lowerBound) : 0.5,
                    particleType: String(xmlValueFromElement(element, 'particle_type') ?? 'neutron')
                };
                if (upperBound.length > 0) {
                    set.upperBound = collapseUniformBound(upperBound);
                }
                if (energyBounds.length > 0) {
                    set.energyBounds = energyBounds;
                }
                const survivalRatio = parseFloat(String(xmlValueFromElement(element, 'survival_ratio') ?? ''));
                if (Number.isFinite(survivalRatio) && Math.abs(survivalRatio - 3) > 1e-12) {
                    set.survivalWeight = survivalRatio;
                }
                const maxSplit = parseInt(String(xmlValueFromElement(element, 'max_split') ?? ''));
                if (Number.isFinite(maxSplit) && maxSplit !== 10) {
                    set.maxSplit = maxSplit;
                }
                const weightCutoff = parseFloat(String(xmlValueFromElement(element, 'weight_cutoff') ?? ''));
                if (Number.isFinite(weightCutoff) && weightCutoff !== 1e-38) {
                    set.weightCutoff = weightCutoff;
                }
                return set;
            })
            .filter((set: any) => set.meshId !== undefined);
        const normalizedSets = normalizeWeightWindowSets(sets);
        if (normalizedSets) {
            varianceReduction.weightWindows = normalizedSets;
        } else if (wwElems.length > 0) {
            warnings.push('Weight-window blocks were found but none had a valid mesh reference');
        }

        const file = xmlValueFromElement(s, 'weight_windows_file');
        if (file !== undefined && file !== null && String(file).length > 0) {
            varianceReduction.weightWindowsFile = String(file);
        }
        const on = xmlValueFromElement(s, 'weight_windows_on');
        if (on !== undefined && on !== null) {
            varianceReduction.weightWindowsOn = this.parseXmlBool(on);
        }
        const checkpoints = s.weight_window_checkpoints;
        if (checkpoints) {
            const parsed: { collision?: boolean; surface?: boolean } = {};
            if (checkpoints.collision !== undefined) {
                parsed.collision = this.parseXmlBool(checkpoints.collision);
            }
            if (checkpoints.surface !== undefined) {
                parsed.surface = this.parseXmlBool(checkpoints.surface);
            }
            if (parsed.collision !== undefined || parsed.surface !== undefined) {
                varianceReduction.weightWindowCheckpoints = parsed;
            }
        }
        if (weightWindowGenerator) {
            varianceReduction.weightWindowGenerator = weightWindowGenerator;
        }
        const ufsMesh = xmlValueFromElement(s, 'ufs_mesh');
        if (ufsMesh !== undefined && ufsMesh !== null && String(ufsMesh).length > 0) {
            const meshId = parseInt(String(ufsMesh));
            varianceReduction.ufs = { enabled: true, meshId: Number.isFinite(meshId) ? meshId : undefined };
        }
        return Object.keys(varianceReduction).length > 0 ? varianceReduction : undefined;
    }

    /**
     * Parse a boolean XML text value ('true'/'false'/'1'/'0').
     */
    private parseXmlBool(value: any): boolean {
        const text = value.toString().toLowerCase();
        return text === 'true' || text === '1';
    }

    /**
     * Parse a whitespace-separated XML number list.
     */
    private parseNumberList(value: any): number[] {
        return value
            .toString()
            .trim()
            .split(/\s+/)
            .filter((token: string) => token.length > 0)
            .map(Number);
    }

    /**
     * Parse a <source> element (independent, file, or compiled) into schema form.
     * Attribute/element names match openmc/source.py.
     */
    private parseSourceElement(src: any, warnings: string[] = []): any {
        const attrs = src.$ || {};
        const sourceType = attrs.type || 'independent';

        const source: any = {};
        if (attrs.strength !== undefined) {
            source.strength = parseFloat(attrs.strength);
        }

        if (sourceType === 'file') {
            source.type = 'file';
            source.path = attrs.file || '';
        } else if (sourceType === 'compiled') {
            source.type = 'compiled';
            source.library = attrs.library || '';
            if (attrs.parameters !== undefined) {
                source.parameters = attrs.parameters;
            }
        } else if (sourceType === 'mesh') {
            // Mesh source (openmc/source.py MeshSource.from_xml_element): mesh
            // attribute references a settings-root <mesh> element; children
            // are per-element sub-sources. Strength is computed (sum of
            // sub-source strengths), so the parsed attribute is dropped.
            source.type = 'mesh';
            delete source.strength;
            if (attrs.mesh !== undefined) {
                source.meshId = parseInt(attrs.mesh);
            }
            source.sources = [];
            const subElems = Array.isArray(src.source) ? src.source : src.source ? [src.source] : [];
            for (const subElem of subElems) {
                const sub = this.parseSourceElement(subElem, warnings);
                if (sub) {
                    source.sources.push(sub);
                }
            }
        } else if (sourceType === 'tokamak') {
            // Tokamak source (openmc/source.py TokamakSource.from_xml_element):
            // geometry/profile values are text sub-elements; the emission
            // profile is two parallel space-separated arrays. Only a single
            // energy distribution is modeled (per-radius lists are not).
            source.type = 'tokamak';
            source.majorRadius = parseFloat(src.major_radius ?? '0');
            source.minorRadius = parseFloat(src.minor_radius ?? '0');
            source.elongation = parseFloat(src.elongation ?? '1');
            source.triangularity = parseFloat(src.triangularity ?? '0');
            source.shafranovShift = parseFloat(src.shafranov_shift ?? '0');
            if (src.phi_start !== undefined) {
                source.phiStart = parseFloat(src.phi_start);
            }
            if (src.phi_extent !== undefined) {
                source.phiExtent = parseFloat(src.phi_extent);
            }
            if (src.n_alpha !== undefined) {
                source.nAlpha = parseInt(src.n_alpha);
            }
            if (src.vertical_shift !== undefined) {
                source.verticalShift = parseFloat(src.vertical_shift);
            }
            const rOverA = src.r_over_a ? this.parseNumberList(src.r_over_a) : [];
            const emission = src.emission_density ? this.parseNumberList(src.emission_density) : [];
            source.profile = rOverA.map((r, i) => ({ r, s: emission[i] ?? 0 }));
            source.energy = this.parseSourceEnergy(src.energy, warnings);
            if (src.time) {
                const time = parseTimeXml(Array.isArray(src.time) ? src.time[0] : src.time);
                if (time) {
                    source.time = time;
                } else {
                    warnings.push('Tokamak source has an unsupported time distribution; it was not imported');
                }
            }
        } else {
            // Independent source (type attribute absent means 'independent')
            if (attrs.particle) {
                source.particle = attrs.particle;
            }

            const spatial = parseSpatialXml(src.space, warnings);
            if (spatial) {
                source.spatial = spatial;
            } else {
                if (src.space) {
                    warnings.push('Source spatial distribution could not be imported; using a point at the origin');
                }
                source.spatial = { type: 'point', origin: [0, 0, 0] };
            }

            source.energy = this.parseSourceEnergy(src.energy, warnings);

            if (src.angle) {
                const angle = parseAngleXml(src.angle, warnings);
                if (angle) {
                    source.angle = angle;
                }
            }

            if (src.time) {
                const time = parseTimeXml(src.time);
                if (time) {
                    source.time = time;
                } else {
                    warnings.push('Source time distribution could not be imported');
                }
            }
        }

        // Parse constraints sub-element (valid for all source types)
        if (src.constraints) {
            const c = src.constraints;
            const constraints: any = {};
            if (c.domain_type) {
                constraints.domainType = c.domain_type.toString();
            }
            if (c.domain_ids) {
                constraints.domainIds = this.parseNumberList(c.domain_ids).map((n) => Math.trunc(n));
            }
            if (c.time_bounds) {
                constraints.timeBounds = this.parseNumberList(c.time_bounds).slice(0, 2);
            }
            if (c.energy_bounds) {
                constraints.energyBounds = this.parseNumberList(c.energy_bounds).slice(0, 2);
            }
            if (c.fissionable !== undefined) {
                constraints.fissionable = this.parseXmlBool(c.fissionable);
            }
            if (c.rejection_strategy) {
                constraints.rejectionStrategy = c.rejection_strategy.toString();
            }
            if (Object.keys(constraints).length > 0) {
                source.constraints = constraints;
            }
        }

        return source;
    }

    /**
     * Parse an `<energy>` element into the shared univariate model.
     * When several elements are present (e.g. per-radius tokamak energy lists),
     * the first one is used. Defaults to a 1 MeV discrete line when absent.
     * @param energyElem - The parsed XML energy element (or array of them).
     * @param warnings - Import warning sink.
     * @returns The energy distribution in schema form.
     */
    private parseSourceEnergy(energyElem: any, warnings: string[] = []): any {
        const elem = Array.isArray(energyElem) ? energyElem[0] : energyElem;
        if (!elem) {
            return { type: 'discrete', energies: [1e6] };
        }
        const energy = parseUnivariateXml(elem);
        if (energy) {
            return energy;
        }
        warnings.push(`Unsupported energy distribution type "${elem.$?.type ?? 'unknown'}"; using a 1 MeV discrete line`);
        return { type: 'discrete', energies: [1e6] };
    }

    /**
     * Parse tallies.xml into state tallies and meshes.
     * Handles every filter type the generator emits, including expansion and
     * energy-function filters.
     * @param filePath - Path to tallies.xml
     * @returns Parsed tallies, meshes, and warnings
     */
    private async parseTalliesXML(
        filePath: string,
        baseDirectory?: string
    ): Promise<{ tallies: OpenMCTally[]; meshes: OpenMCMesh[]; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');

        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);

        const tallies: OpenMCTally[] = [];
        const meshes: OpenMCMesh[] = [];

        if (!result.tallies) {
            warnings.push('No tallies element found in tallies.xml');
            return { tallies, meshes, warnings };
        }

        const t = result.tallies;

        // Meshes
        const meshElems = Array.isArray(t.mesh) ? t.mesh : t.mesh ? [t.mesh] : [];
        for (const meshElem of meshElems) {
            meshes.push(this.parseMeshElement(meshElem, baseDirectory));
        }

        // Filter definitions (top-level, referenced by ID from tallies)
        const filterDefs = new Map<number, OpenMCTallyFilter>();
        const filterElems = Array.isArray(t.filter) ? t.filter : t.filter ? [t.filter] : [];
        for (const filterElem of filterElems) {
            const id = parseInt(filterElem.$?.id);
            if (!isNaN(id)) {
                filterDefs.set(id, this.parseFilterElement(filterElem, warnings));
            }
        }

        // Derivative definitions (top-level, referenced by ID from tallies,
        // per tally_derivative.py TallyDerivative.from_xml_element)
        const derivativeDefs = new Map<number, NonNullable<OpenMCTally['derivative']>>();
        const derivElems = Array.isArray(t.derivative) ? t.derivative : t.derivative ? [t.derivative] : [];
        for (const derivElem of derivElems) {
            const attrs = derivElem.$ || {};
            const id = parseInt(attrs.id);
            if (isNaN(id)) {
                continue;
            }
            const derivative: NonNullable<OpenMCTally['derivative']> = {
                id,
                variable: attrs.variable,
                materialId: parseInt(attrs.material)
            };
            if (attrs.variable === 'nuclide_density' && attrs.nuclide) {
                derivative.nuclide = attrs.nuclide;
            }
            derivativeDefs.set(id, derivative);
        }

        // Tallies
        const tallyElems = Array.isArray(t.tally) ? t.tally : t.tally ? [t.tally] : [];
        for (const tallyElem of tallyElems) {
            const tally: OpenMCTally = {
                id: parseInt(tallyElem.$?.id) || tallies.length + 1,
                name: tallyElem.$?.name,
                scores: tallyElem.scores ? tallyElem.scores.toString().trim().split(/\s+/) : [],
                nuclides: [],
                filters: []
            };

            // Derivative reference (text sub-element carrying the derivative ID)
            if (tallyElem.derivative !== undefined) {
                const derivId = parseInt(tallyElem.derivative.toString());
                const deriv = derivativeDefs.get(derivId);
                if (deriv) {
                    tally.derivative = deriv;
                } else {
                    warnings.push(`Tally ${tally.id} references unknown derivative ID ${derivId}`);
                }
            }

            // multiply_density attribute (written when false)
            if (tallyElem.$?.multiply_density !== undefined) {
                tally.multiplyDensity = this.parseXmlBool(tallyElem.$.multiply_density);
            }

            // Higher-moment accumulation (openmc.Tally.to_xml_element)
            if (tallyElem.higher_moments !== undefined) {
                tally.higherMoments = this.parseXmlBool(tallyElem.higher_moments);
            }

            // Nuclides: real OpenMC writes a single space-joined <nuclides>
            // element; tolerate repeated <nuclide> elements from older exports
            if (tallyElem.nuclides) {
                tally.nuclides = tallyElem.nuclides.toString().trim().split(/\s+/);
            } else if (tallyElem.nuclide) {
                const nuclideElems = Array.isArray(tallyElem.nuclide) ? tallyElem.nuclide : [tallyElem.nuclide];
                tally.nuclides = nuclideElems.map((n: any) => n.toString());
            }

            // Filters: space-separated filter IDs referencing top-level definitions
            if (tallyElem.filters) {
                const filterIds = this.parseNumberList(tallyElem.filters).map((n) => Math.trunc(n));
                for (const filterId of filterIds) {
                    const def = filterDefs.get(filterId);
                    if (def) {
                        tally.filters.push({ ...def });
                    } else {
                        warnings.push(`Tally ${tally.id} references unknown filter ID ${filterId}`);
                    }
                }
            }

            // Estimator
            if (tallyElem.estimator) {
                tally.estimator = tallyElem.estimator.toString() as OpenMCTally['estimator'];
            }

            // Per-tally triggers (openmc/trigger.py: scores is a space-separated attribute)
            const triggerElems = Array.isArray(tallyElem.trigger) ? tallyElem.trigger : tallyElem.trigger ? [tallyElem.trigger] : [];
            if (triggerElems.length > 0) {
                tally.triggers = triggerElems.map((triggerElem: any) => {
                    const trigger: NonNullable<OpenMCTally['triggers']>[number] = {
                        type: (triggerElem.$?.type ?? 'rel_err') as NonNullable<OpenMCTally['triggers']>[number]['type'],
                        threshold: parseFloat(triggerElem.$?.threshold ?? '0')
                    };
                    if (triggerElem.$?.scores) {
                        trigger.scores = triggerElem.$.scores.toString().trim().split(/\s+/);
                    }
                    if (triggerElem.$?.ignore_zeros !== undefined) {
                        trigger.ignoreZeros = this.parseXmlBool(triggerElem.$.ignore_zeros);
                    }
                    return trigger;
                });
            }

            tallies.push(tally);
        }

        return { tallies, meshes, warnings };
    }

    /**
     * Parse a <mesh> element from tallies.xml/settings.xml.
     *
     * @param meshElem - Parsed XML element.
     * @param baseDirectory - Directory containing the XML file; relative
     * unstructured mesh filenames resolve against it.
     */
    private parseMeshElement(meshElem: any, baseDirectory?: string): OpenMCMesh {
        const id = parseInt(meshElem.$?.id) || 0;
        const type = meshElem.$?.type || 'regular';
        const name = meshElem.$?.name || undefined;

        if (type === 'rectilinear') {
            return {
                type: 'rectilinear',
                id,
                name,
                xGrid: meshElem.x_grid ? this.parseNumberList(meshElem.x_grid) : [],
                yGrid: meshElem.y_grid ? this.parseNumberList(meshElem.y_grid) : [],
                zGrid: meshElem.z_grid ? this.parseNumberList(meshElem.z_grid) : []
            };
        }

        if (type === 'unstructured') {
            const rawFilename = meshElem.filename ? meshElem.filename.toString().trim() : '';
            const filename =
                rawFilename && baseDirectory && !path.isAbsolute(rawFilename) ? path.resolve(baseDirectory, rawFilename) : rawFilename;
            const explicitLibrary = meshElem.$?.library === 'libmesh' ? 'libmesh' : meshElem.$?.library === 'moab' ? 'moab' : undefined;
            const library = explicitLibrary ?? inferUnstructuredMeshLibrary(filename) ?? 'moab';
            const lengthMultiplier = meshElem.$?.length_multiplier !== undefined ? parseFloat(meshElem.$.length_multiplier) : undefined;
            const options = meshElem.$?.options ? meshElem.$.options.toString() : undefined;
            return {
                type: 'unstructured',
                id,
                name,
                filename,
                library,
                lengthMultiplier,
                options
            };
        }

        if (type === 'cylindrical') {
            return {
                type: 'cylindrical',
                id,
                name,
                origin: meshElem.origin ? (this.parseNumberList(meshElem.origin) as [number, number, number]) : undefined,
                axis: meshElem.axis ? (this.parseNumberList(meshElem.axis) as [number, number, number]) : undefined,
                rGrid: meshElem.r_grid ? this.parseNumberList(meshElem.r_grid) : [],
                phiGrid: meshElem.phi_grid ? this.parseNumberList(meshElem.phi_grid) : [],
                zGrid: meshElem.z_grid ? this.parseNumberList(meshElem.z_grid) : []
            };
        }

        if (type === 'spherical') {
            return {
                type: 'spherical',
                id,
                name,
                origin: meshElem.origin ? (this.parseNumberList(meshElem.origin) as [number, number, number]) : undefined,
                rGrid: meshElem.r_grid ? this.parseNumberList(meshElem.r_grid) : [],
                thetaGrid: meshElem.theta_grid ? this.parseNumberList(meshElem.theta_grid) : [],
                phiGrid: meshElem.phi_grid ? this.parseNumberList(meshElem.phi_grid) : []
            };
        }

        return {
            type: 'regular',
            id,
            name,
            lowerLeft: meshElem.lower_left ? (this.parseNumberList(meshElem.lower_left) as [number, number, number]) : [0, 0, 0],
            upperRight: meshElem.upper_right ? (this.parseNumberList(meshElem.upper_right) as [number, number, number]) : [0, 0, 0],
            dimension: meshElem.dimension
                ? (this.parseNumberList(meshElem.dimension).map((n) => Math.trunc(n)) as [number, number, number])
                : [1, 1, 1]
        };
    }

    /**
     * Parse a <filter> element from tallies.xml into schema form.
     *
     * @param filterElem - Parsed XML element.
     * @param warnings - Optional warning sink for unsupported rotation matrices.
     */
    private parseFilterElement(filterElem: any, warnings?: string[]): OpenMCTallyFilter {
        const type = filterElem.$?.type || 'cell';
        const filter: OpenMCTallyFilter = { type, bins: [] };

        switch (type) {
            case 'mesh':
            case 'meshsurface':
            case 'meshborn': {
                const meshIds = filterElem.bins ? this.parseNumberList(filterElem.bins).map((n) => Math.trunc(n)) : [];
                filter.bins = meshIds;
                filter.meshId = meshIds[0];
                if (filterElem.$?.translation) {
                    const translation = this.parseNumberList(filterElem.$.translation);
                    if (translation.length === 3) {
                        filter.meshTranslation = translation as [number, number, number];
                    } else {
                        warnings?.push(
                            `Mesh filter ${filterElem.$?.id ?? ''} has a translation with ${translation.length} values (expected 3); ignored`
                        );
                    }
                }
                if (filterElem.$?.rotation) {
                    const rotation = this.parseNumberList(filterElem.$.rotation);
                    if (rotation.length === 3) {
                        filter.meshRotation = rotation as [number, number, number];
                    } else if (rotation.length === 9) {
                        warnings?.push(
                            `Mesh filter ${filterElem.$?.id ?? ''} uses a 3×3 rotation matrix; only intrinsic Euler angles (phi theta psi) are editable and the matrix was ignored`
                        );
                    } else {
                        warnings?.push(
                            `Mesh filter ${filterElem.$?.id ?? ''} has a rotation with ${rotation.length} values (expected 3); ignored`
                        );
                    }
                }
                break;
            }

            case 'meshmaterial': {
                const meshId = parseInt(filterElem.$?.mesh ?? '', 10);
                filter.meshId = Number.isFinite(meshId) ? meshId : undefined;
                if (filter.meshId === undefined) {
                    warnings?.push(
                        `Mesh-material filter ${filterElem.$?.id ?? ''} has no mesh attribute; select a mesh in the filter editor`
                    );
                }
                const flat = filterElem.bins ? this.parseNumberList(filterElem.bins).map((n) => Math.trunc(n)) : [];
                if (flat.length % 2 !== 0) {
                    warnings?.push(
                        `Mesh-material filter ${filterElem.$?.id ?? ''} has an odd number of bins (${flat.length}); the last value was left unpaired`
                    );
                }
                filter.bins = flat;
                filter.pairs = pairsFromBins(flat);
                if (filterElem.$?.translation) {
                    const translation = this.parseNumberList(filterElem.$.translation);
                    if (translation.length === 3) {
                        filter.meshTranslation = translation as [number, number, number];
                    } else {
                        warnings?.push(
                            `Mesh-material filter ${filterElem.$?.id ?? ''} has a translation with ${translation.length} values (expected 3); ignored`
                        );
                    }
                }
                break;
            }

            case 'cellinstance': {
                const flat = filterElem.bins ? this.parseNumberList(filterElem.bins).map((n) => Math.trunc(n)) : [];
                if (flat.length % 2 !== 0) {
                    warnings?.push(
                        `Cell-instance filter ${filterElem.$?.id ?? ''} has an odd number of bins (${flat.length}); the last value was left unpaired`
                    );
                }
                filter.bins = flat;
                filter.pairs = pairsFromBins(flat);
                break;
            }

            case 'parentnuclide':
                filter.nuclideBins = filterElem.bins
                    ? filterElem.bins
                          .toString()
                          .trim()
                          .split(/\s+/)
                          .filter((name: string) => name.length > 0)
                    : [];
                filter.bins = [];
                break;

            case 'reaction':
                filter.reactionBins = filterElem.bins
                    ? filterElem.bins
                          .toString()
                          .trim()
                          .split(/\s+/)
                          .filter((name: string) => name.length > 0)
                    : [];
                filter.bins = [];
                break;

            case 'particleproduction': {
                filter.particleTypes = filterElem.particles
                    ? filterElem.particles
                          .toString()
                          .trim()
                          .split(/\s+/)
                          .filter((particle: string) => particle.length > 0)
                    : [];
                filter.productionEnergyBins = filterElem.energies ? this.parseNumberList(filterElem.energies) : [];
                filter.bins = [];
                if ((filter.particleTypes ?? []).length === 0) {
                    warnings?.push(`Particle-production filter ${filterElem.$?.id ?? ''} has no <particles> values`);
                }
                break;
            }

            case 'legendre':
            case 'spatiallegendre':
            case 'sphericalharmonics':
            case 'zernike':
            case 'zernikeradial':
                filter.order = filterElem.order !== undefined ? parseInt(filterElem.order) : 0;
                if (type === 'spatiallegendre') {
                    filter.axis = (filterElem.axis ?? 'z').toString() as 'x' | 'y' | 'z';
                    filter.min = filterElem.min !== undefined ? parseFloat(filterElem.min) : 0;
                    filter.max = filterElem.max !== undefined ? parseFloat(filterElem.max) : 0;
                }
                if (type === 'sphericalharmonics' && filterElem.$?.cosine) {
                    filter.cosine = filterElem.$.cosine as 'scatter' | 'particle';
                }
                if (type === 'zernike' || type === 'zernikeradial') {
                    filter.center = {
                        x: filterElem.x !== undefined ? parseFloat(filterElem.x) : 0,
                        y: filterElem.y !== undefined ? parseFloat(filterElem.y) : 0,
                        r: filterElem.r !== undefined ? parseFloat(filterElem.r) : 1
                    };
                }
                break;

            case 'energyfunction':
                filter.energyValues = filterElem.energy ? this.parseNumberList(filterElem.energy) : [];
                filter.responseValues = filterElem.y ? this.parseNumberList(filterElem.y) : [];
                if (filterElem.interpolation) {
                    filter.interpolation = filterElem.interpolation.toString() as OpenMCTallyFilter['interpolation'];
                }
                break;

            case 'particle':
                // Real OpenMC writes particle names; map back to numeric bins (1=neutron, 2=photon)
                filter.bins = filterElem.bins
                    ? filterElem.bins
                          .toString()
                          .trim()
                          .split(/\s+/)
                          .map((token: string) => (token === 'photon' ? 2 : token === 'neutron' ? 1 : parseInt(token) || 1))
                    : [];
                break;

            default:
                filter.bins = filterElem.bins ? this.parseNumberList(filterElem.bins) : [];
        }

        return filter;
    }

    /**
     * Parse plots.xml into plot configurations.
     * Handles slice, voxel, solid_raytrace, and wireframe_raytrace plots
     * (element names per openmc/plots.py to_xml_element methods).
     * @param filePath - Path to plots.xml
     * @param state - Imported geometry/materials, used to invert mask components
     * @returns Parsed plots and warnings
     */
    private async parsePlotsXML(filePath: string, state: OpenMCState): Promise<{ plots: OpenMCPlotConfig[]; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');

        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);

        const plots: OpenMCPlotConfig[] = [];
        if (!result.plots) {
            warnings.push('No plots element found in plots.xml');
            return { plots, warnings };
        }

        const plotElems = Array.isArray(result.plots.plot) ? result.plots.plot : result.plots.plot ? [result.plots.plot] : [];
        for (const plotElem of plotElems) {
            plots.push(this.parsePlotElement(plotElem, plots.length + 1, state, warnings));
        }

        return { plots, warnings };
    }

    /**
     * Parse an RGB triple from a plots.xml color element or attribute.
     */
    private parsePlotRgb(value: any): [number, number, number] | undefined {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        const values = this.parseNumberList(value);
        if (values.length !== 3 || values.some((component) => !Number.isFinite(component))) {
            return undefined;
        }
        return values.map((component) => Math.trunc(component)) as [number, number, number];
    }

    /**
     * Parse a single <plot> element from plots.xml.
     */
    private parsePlotElement(plotElem: any, fallbackId: number, state: OpenMCState, warnings: string[]): OpenMCPlotConfig {
        const attrs = plotElem.$ || {};
        const xmlType = attrs.type || 'slice';
        const type: OpenMCPlotConfig['type'] =
            xmlType === 'solid_raytrace' ? 'solid-raytrace' : xmlType === 'wireframe_raytrace' ? 'wireframe-raytrace' : xmlType;

        const plot: OpenMCPlotConfig = {
            id: parseInt(attrs.id) || fallbackId,
            type,
            basis: (attrs.basis || 'xy') as OpenMCPlotConfig['basis'],
            origin: [0, 0, 0],
            colorBy: (attrs.color_by || 'cell') as OpenMCPlotConfig['colorBy']
        };

        if (attrs.name) {
            plot.name = attrs.name;
        }

        // Appearance fields: background/mask apply to slice and ray-traced
        // plots; overlap highlighting is slice-only (openmc/plots.py, src/plot.cpp).
        const hasBackground = plotElem.background !== undefined;
        const hasMask = plotElem.mask !== undefined;
        if (!plotSupportsBackground(type) && (hasBackground || hasMask)) {
            warnings.push(`Plot ${plot.id}: background/mask elements are not applied to ${type} plots and were ignored`);
        } else {
            if (hasBackground) {
                const background = this.parsePlotRgb(plotElem.background);
                if (background) {
                    plot.background = background;
                } else {
                    warnings.push(`Plot ${plot.id}: background color must be three RGB integers; ignored`);
                }
            }
            if (hasMask && plotSupportsMask(type)) {
                const maskElem = plotElem.mask;
                const maskAttrs = maskElem?.$ ?? {};
                const componentsRaw = maskAttrs.components ?? maskElem?.components;
                const hidden = componentsRaw !== undefined ? this.parseNumberList(componentsRaw).map((n) => Math.trunc(n)) : [];
                if (hidden.length === 0) {
                    warnings.push(`Plot ${plot.id}: mask has no components; ignored`);
                } else {
                    // OpenMC paints listed components with the mask background;
                    // the schema stores the visible complement.
                    const selection = fromOpenMcMaskComponents(hidden, state, plot.colorBy);
                    if (selection.missing.length > 0) {
                        warnings.push(`Plot ${plot.id}: mask components not in the current geometry: ${selection.missing.join(', ')}`);
                    }
                    if (selection.visible.length === 0) {
                        warnings.push(`Plot ${plot.id}: mask hides every domain; imported without a mask`);
                    } else {
                        plot.mask = { components: selection.visible };
                        const backgroundRaw = maskAttrs.background ?? maskElem?.background;
                        if (backgroundRaw !== undefined) {
                            const maskBackground = this.parsePlotRgb(backgroundRaw);
                            if (maskBackground) {
                                plot.mask.background = maskBackground;
                            } else {
                                warnings.push(`Plot ${plot.id}: mask background must be three RGB integers; ignored`);
                            }
                        }
                    }
                }
            }
        }

        const hasShowOverlaps = plotElem.show_overlaps !== undefined;
        const hasOverlapColor = plotElem.overlap_color !== undefined;
        if (plotSupportsOverlaps(type)) {
            const showOverlapsValue = plotElem.show_overlaps;
            const showOverlaps =
                showOverlapsValue === true || showOverlapsValue === 'true' || showOverlapsValue === '1' || showOverlapsValue === 1;
            if (showOverlaps) {
                plot.showOverlaps = true;
                if (hasOverlapColor) {
                    const overlapColor = this.parsePlotRgb(plotElem.overlap_color);
                    if (overlapColor) {
                        plot.overlapColor = overlapColor;
                    } else {
                        warnings.push(`Plot ${plot.id}: overlap color must be three RGB integers; ignored`);
                    }
                }
            } else if (hasOverlapColor) {
                warnings.push(`Plot ${plot.id}: overlap_color requires show_overlaps; ignored`);
            }
        } else if (hasShowOverlaps || hasOverlapColor) {
            warnings.push(`Plot ${plot.id}: overlap highlighting applies only to slice plots and was ignored`);
        }

        const pixels = plotElem.pixels ? this.parseNumberList(plotElem.pixels).map((n) => Math.trunc(n)) : [];

        if (type === 'slice') {
            plot.origin = (plotElem.origin ? this.parseNumberList(plotElem.origin) : [0, 0, 0]) as [number, number, number];
            const width = plotElem.width ? this.parseNumberList(plotElem.width) : [];
            plot.width = width[0];
            plot.height = width.length > 1 ? width[1] : width[0];
            if (pixels.length >= 2) {
                plot.pixels = [pixels[0], pixels[1]];
            }
            if (plotElem.meshlines !== undefined) {
                plot.meshlines = true;
            }
        } else if (type === 'voxel') {
            // Real OpenMC voxel: center origin + 3-value width + voxel counts in pixels
            const origin = plotElem.origin ? this.parseNumberList(plotElem.origin) : [0, 0, 0];
            const width = plotElem.width ? this.parseNumberList(plotElem.width) : [0, 0, 0];
            plot.origin = origin as [number, number, number];
            plot.lowerLeft = origin.map((v, i) => v - (width[i] ?? 0) / 2) as [number, number, number];
            plot.upperRight = origin.map((v, i) => v + (width[i] ?? 0) / 2) as [number, number, number];
            if (pixels.length >= 3) {
                plot.voxels = [pixels[0], pixels[1], pixels[2]];
            }
        } else {
            // Ray-trace plots
            if (pixels.length >= 2) {
                plot.pixels = [pixels[0], pixels[1]];
            }
            if (plotElem.camera_position) {
                plot.cameraPosition = this.parseNumberList(plotElem.camera_position) as [number, number, number];
            }
            if (plotElem.look_at) {
                plot.lookAt = this.parseNumberList(plotElem.look_at) as [number, number, number];
            }
            if (plotElem.horizontal_field_of_view !== undefined) {
                plot.horizontalFieldOfView = parseFloat(plotElem.horizontal_field_of_view);
            }
            if (plotElem.orthographic_width !== undefined) {
                plot.orthographicWidth = parseFloat(plotElem.orthographic_width);
            }
            if (type === 'solid-raytrace') {
                if (plotElem.light_position) {
                    plot.lightPosition = this.parseNumberList(plotElem.light_position) as [number, number, number];
                }
                if (plotElem.diffuse_fraction !== undefined) {
                    plot.diffuseFraction = parseFloat(plotElem.diffuse_fraction);
                }
                if (plotElem.opaque_ids) {
                    plot.opaqueIds = this.parseNumberList(plotElem.opaque_ids).map((n) => Math.trunc(n));
                }
            } else {
                if (plotElem.wireframe_thickness !== undefined) {
                    plot.wireframeThickness = parseInt(plotElem.wireframe_thickness);
                }
                if (plotElem.wireframe_color) {
                    plot.wireframeColor = this.parseNumberList(plotElem.wireframe_color).map((n) => Math.trunc(n)) as [
                        number,
                        number,
                        number
                    ];
                }
                if (plotElem.wireframe_ids) {
                    plot.wireframeIds = this.parseNumberList(plotElem.wireframe_ids).map((n) => Math.trunc(n));
                }
            }
        }

        return plot;
    }

    /**
     * Validate OpenMC XML files without importing.
     * @param directory - Directory containing XML files
     * @returns Validation result
     */
    async validateXML(directory: string): Promise<XMLValidationResult> {
        this.log(`Validating XML in ${directory}`);
        // TODO: Implement XML validation.
        return {
            valid: true,
            errors: [],
            warnings: []
        };
    }

    // ============================================================================
    // Simulation Runner
    // ============================================================================

    /**
     * Run OpenMC simulation (blocking - returns when complete).
     * @param request - Simulation run configuration
     * @returns Simulation result with output and timing
     */
    async runSimulation(request: SimulationRunRequest): Promise<SimulationRunResult> {
        this.log(`Running simulation in ${request.workingDirectory}`);
        return this.runnerService.runSimulation(request);
    }

    /**
     * Start OpenMC simulation (non-blocking - returns immediately with processId).
     * @param request - Simulation run configuration
     * @returns Response with process ID for tracking
     */
    async startSimulation(request: SimulationRunRequest): Promise<StartSimulationResponse> {
        this.log(`Starting simulation in ${request.workingDirectory}`);
        return this.runnerService.startSimulation(request);
    }

    /**
     * Cancel a running simulation.
     * @param processId - Process ID from startSimulation
     * @returns Whether cancellation was successful
     */
    async cancelSimulation(processId: string): Promise<boolean> {
        this.log(`Cancelling simulation ${processId}`);
        return this.runnerService.cancelSimulation(processId);
    }

    /**
     * Get simulation log file content.
     * @param processId - Process ID from startSimulation
     * @returns Log content and status
     */
    async getSimulationLog(processId: string): Promise<SimulationLogResult> {
        return this.runnerService.getSimulationLog(processId);
    }

    /**
     * List simulations currently running in the backend (for frontend re-attach).
     * @returns Active runs with process IDs, working directories, and log paths
     */
    async getActiveSimulations(): Promise<ActiveSimulationInfo[]> {
        return this.runnerService.getActiveSimulations();
    }

    /**
     * Check if OpenMC is available in the configured environment.
     * @returns Availability status, version, and path information
     */
    async checkOpenMC(): Promise<{ available: boolean; version?: string; path?: string; error?: string }> {
        return this.runnerService.checkOpenMC();
    }

    /**
     * Check if MPI is available for parallel simulations.
     * @returns MPI availability and process count
     */
    async checkMPI(): Promise<{ available: boolean; version?: string; processes?: number; error?: string }> {
        return this.runnerService.checkMPI();
    }

    /**
     * Run a stochastic volume calculation.
     * @param request - Volume calculation configuration
     * @returns Volume calculation result with per-domain volumes
     */
    async runVolumeCalculation(request: VolumeCalculationRequest): Promise<VolumeCalculationResult> {
        this.log(`Running volume calculation in ${request.workingDirectory}`);
        return this.runnerService.runVolumeCalculation(request);
    }

    /**
     * Generate native OpenMC plots.
     * @param request - Plot generation configuration
     * @returns Plot generation result with generated file paths
     */
    async generatePlots(request: PlotGenerationRequest): Promise<PlotGenerationResult> {
        this.log(`Generating plots in ${request.workingDirectory}`);
        return this.runnerService.generatePlots(request);
    }

    /**
     * Import a material composition from an NCrystal configuration string.
     * @param cfg - NCrystal configuration string
     * @returns The imported material composition
     */
    async importNCrystalMaterial(cfg: string): Promise<NCrystalImportResult> {
        this.log(`Importing NCrystal material: ${cfg}`);
        return this.runnerService.importNCrystalMaterial(cfg);
    }

    /**
     * Generate an MGXS library from the model.
     * @param request - MGXS generation configuration
     * @returns The generated library path
     */
    async generateMgxs(request: MgxsGenerationRequest): Promise<MgxsGenerationResult> {
        this.log(`Generating MGXS library in ${request.workingDirectory}`);
        return this.runnerService.generateMgxs(request);
    }

    /**
     * Build a custom depletion chain.
     * @param request - Chain build configuration
     * @returns The build result with the output chain path
     */
    async buildChain(
        request: import('../common/openmc-studio-protocol').ChainBuildRequest
    ): Promise<import('../common/openmc-studio-protocol').ChainBuildResult> {
        this.log(`Building depletion chain → ${request.output}`);
        return this.runnerService.buildChain(request);
    }

    /**
     * Generate a fine-grained MGXS library (openmc.mgxs.Library mode).
     * @param request - Library generation configuration
     * @returns The generated library path
     */
    async generateMgxsLibrary(
        request: import('../common/openmc-studio-protocol').MgxsLibraryGenerationRequest
    ): Promise<import('../common/openmc-studio-protocol').MgxsLibraryGenerationResult> {
        return this.runnerService.generateMgxsLibrary(request);
    }

    /**
     * Convert a CE project to multi-group (MGXS generation + material mapping).
     * @param request - Conversion configuration
     * @returns The library path and material/XS-data mapping
     */
    async convertToMultigroupProject(
        request: import('../common/openmc-studio-protocol').MgConversionRequest
    ): Promise<import('../common/openmc-studio-protocol').MgConversionResult> {
        return this.runnerService.convertToMultigroupProject(request);
    }

    /**
     * Read the material/XS-data mapping from an existing MGXS library.
     * @param mgxsPath - Path to the MGXS library HDF5 file
     * @returns Result with the list of material-name / XS-data-name mappings
     */
    async getMgxsDataNames(mgxsPath: string): Promise<import('../common/openmc-studio-protocol').MgxsDataNamesResult> {
        return this.runnerService.getMgxsDataNames(mgxsPath);
    }

    // ============================================================================
    // Validation
    // ============================================================================

    /**
     * Validate simulation state for geometry, materials, settings, and tallies.
     * @param request - Validation request with state and level
     * @returns Validation result with issues and summary
     */
    /**
     * Validate a tokamak source against openmc.TokamakSource's own rules
     * (source.py setters + _validate, versionadded 0.16.0).
     * @param source - The tokamak source to validate.
     * @param issues - Issue list to append to.
     */
    private validateTokamakSource(source: any, issues: ValidationResult['issues']): void {
        const error = (message: string, suggestion: string): void => {
            issues.push({ severity: 'error', category: 'settings', message, suggestion });
        };

        if (!(source.majorRadius > 0)) {
            error('Tokamak source major radius must be positive', 'Set a major radius R0 > 0 cm');
        }
        if (!(source.minorRadius > 0)) {
            error('Tokamak source minor radius must be positive', 'Set a minor radius a > 0 cm');
        } else if (source.minorRadius >= source.majorRadius) {
            error(
                `Tokamak source minor radius (${source.minorRadius}) must be smaller than the major radius (${source.majorRadius})`,
                'Reduce the minor radius or increase the major radius'
            );
        }
        if (!(source.elongation > 0)) {
            error('Tokamak source elongation must be positive', 'Set elongation κ > 0 (1.0 is circular)');
        }
        if (source.triangularity < -1 || source.triangularity > 1) {
            error('Tokamak source triangularity must be in [-1, 1]', 'Set triangularity δ within [-1, 1]');
        }
        if (source.shafranovShift < 0 || source.shafranovShift >= 0.5 * source.minorRadius) {
            error(
                `Tokamak source Shafranov shift must be >= 0 and < half the minor radius (${0.5 * source.minorRadius} cm)`,
                'Reduce the Shafranov shift below a/2'
            );
        }
        if (source.phiExtent !== undefined && (source.phiExtent <= 0 || source.phiExtent > 2 * Math.PI)) {
            error('Tokamak source φ extent must be in (0, 2π]', 'Set the toroidal angle extent within (0, 2π]');
        }
        if (source.nAlpha !== undefined && source.nAlpha <= 2) {
            error('Tokamak source poloidal grid points must be > 2', 'Use the default (101) or a value above 50');
        }

        const profile: { r: number; s: number }[] = source.profile ?? [];
        if (profile.length < 2) {
            error('Tokamak source emission profile needs at least 2 points', 'Add (r/a, S) points from 0 to 1');
        } else {
            if (profile[0].r !== 0 || profile[profile.length - 1].r !== 1) {
                error('Tokamak source emission profile r/a grid must start at 0 and end at 1', 'Fix the first/last r/a values');
            }
            if (profile.some((p, i) => i > 0 && p.r <= profile[i - 1].r)) {
                error('Tokamak source emission profile r/a values must strictly increase', 'Sort or remove duplicate r/a points');
            }
            if (profile.some((p) => p.s < 0)) {
                error('Tokamak source emission density values cannot be negative', 'Set all S values >= 0');
            } else if (!profile.some((p) => p.s > 0)) {
                error('Tokamak source emission density must contain a positive value', 'Set at least one S value above 0');
            }
        }
    }

    async validateState(request: ValidationRequest): Promise<ValidationResult> {
        this.log('Validating simulation state');

        const issues: ValidationResult['issues'] = [];
        const { geometry, materials, settings, meshes, tallies } = request.state;

        // Runtime/advanced settings: threads, MPI, triggers, physics, limits,
        // diagnostics. 0.16-only fields are gated with the probed compat.
        const sourceBiasConfigured = (settings.sources ?? []).some((source) => sourceHasBias(source));
        const needsCompat =
            sourceBiasConfigured ||
            settings.sharedSecondaryBank !== undefined ||
            settings.surfaceGrazingCutoff !== undefined ||
            settings.surfaceGrazingRatio !== undefined;
        let runtimeCompat: OpenMCCompat | undefined;
        if (needsCompat) {
            try {
                runtimeCompat = await this.compatProbe.getOpenMCCompat();
            } catch {
                runtimeCompat = undefined;
            }
        }
        for (const finding of validateRuntimeSettings(settings, runtimeCompat)) {
            issues.push({
                severity: finding.severity,
                category: 'settings',
                message: finding.message,
                suggestion: finding.suggestion
            });
        }
        if (sourceBiasConfigured && runtimeCompat?.sourceBias === false) {
            issues.push({
                severity: 'error',
                category: 'settings',
                message: 'Source-distribution bias requires OpenMC 0.16.0 or newer',
                suggestion: 'Remove the bias, or select an environment whose OpenMC build accepts distribution bias'
            });
        }

        // Random ray (multi-group) restrictions — random ray only exists as
        // multi-group in this OpenMC generation. Ground truth: the C++ error
        // 'Invalid score specified. Only flux, total, fission, nu-fission,
        // kappa-fission, and event scores are supported in random ray mode.'
        if (settings.energyMode === 'multigroup') {
            if (settings.kinetics?.enabled) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'IFP kinetics is not supported in random ray mode — disable kinetics in the Simulation tab',
                    suggestion:
                        'IFP scores are continuous-energy Monte Carlo only; disable kinetics or switch back to continuous-energy mode'
                });
            }
            const RANDOM_RAY_SCORES = new Set(['flux', 'total', 'fission', 'nu-fission', 'kappa-fission', 'events']);
            const invalidScores: string[] = [];
            for (const tally of tallies ?? []) {
                const bad = (tally.scores ?? []).filter((score) => !RANDOM_RAY_SCORES.has(score));
                if (bad.length > 0) {
                    invalidScores.push(`tally ${tally.id}${tally.name ? ` (${tally.name})` : ''}: ${bad.join(', ')}`);
                }
            }
            if (invalidScores.length > 0) {
                issues.push({
                    severity: 'error',
                    category: 'tallies',
                    message: `Scores not supported in random ray mode: ${invalidScores.join('; ')}`,
                    suggestion: 'Random ray supports only flux, total, fission, nu-fission, kappa-fission, and event scores'
                });
            }

            // Ground truth: docs/source/usersguide/random_ray.rst "Supported
            // Filters": cell, cell instance, distribcell, energy, material,
            // mesh, universe. cellinstance is explicitly supported.
            const RANDOM_RAY_FILTERS = new Set(['cell', 'cellinstance', 'distribcell', 'energy', 'material', 'mesh', 'universe']);
            const invalidFilters: string[] = [];
            for (const tally of tallies ?? []) {
                const bad = (tally.filters ?? []).filter((filter) => !RANDOM_RAY_FILTERS.has(filter.type));
                if (bad.length > 0) {
                    invalidFilters.push(
                        `tally ${tally.id}${tally.name ? ` (${tally.name})` : ''}: ${bad.map((filter) => filter.type).join(', ')}`
                    );
                }
            }
            if (invalidFilters.length > 0) {
                issues.push({
                    severity: 'error',
                    category: 'tallies',
                    message: `Filters not supported in random ray mode: ${invalidFilters.join('; ')}`,
                    suggestion:
                        'Random ray supports cell, cell instance, distribcell, energy, material, mesh, and universe filters; remove the others or switch to continuous-energy mode'
                });
            }
        }

        // Basic validation - skip materials check for DAGMC (materials are in the file)
        const dagmcMaterials = settings.dagmcInfo?.materials;
        const hasDagmcMaterials = dagmcMaterials && Object.keys(dagmcMaterials).length > 0;
        const hasOpenMCMaterials = materials && materials.length > 0;

        if (!hasOpenMCMaterials && !hasDagmcMaterials) {
            issues.push({
                severity: 'error',
                category: 'materials',
                message: 'No materials defined',
                suggestion: 'Add at least one material to the model'
            });
        }

        // For DAGMC: check that OpenMC materials match DAGMC material names.
        // "graveyard" is a DAGMC sentinel material and is excluded from matching.
        if (settings.dagmcFile && dagmcMaterials) {
            const dagmcMaterialNames = Object.keys(dagmcMaterials).filter((name) => name.toLowerCase() !== 'graveyard');

            if (dagmcMaterialNames.length === 0) {
                // DAGMC file has no materials - this might be an issue with the export
                issues.push({
                    severity: 'warning',
                    category: 'materials',
                    message: 'DAGMC file contains no material assignments',
                    suggestion: 'Check your geometry export - materials should be assigned to volumes before faceting'
                });
            } else if (!hasOpenMCMaterials) {
                // DAGMC has materials but no OpenMC materials defined
                issues.push({
                    severity: 'warning',
                    category: 'materials',
                    message: `DAGMC geometry requires ${dagmcMaterialNames.length} material(s): ${dagmcMaterialNames.join(', ')}`,
                    suggestion: 'Create OpenMC materials with matching names in the Materials tab'
                });
            } else {
                // Check for missing materials
                const openMCMaterialNames = new Set(materials.map((m) => m.name.toLowerCase()));
                const missingMaterials: string[] = [];

                for (const dagmcMatName of dagmcMaterialNames) {
                    if (!openMCMaterialNames.has(dagmcMatName.toLowerCase())) {
                        missingMaterials.push(dagmcMatName);
                    }
                }

                if (missingMaterials.length > 0) {
                    issues.push({
                        severity: 'warning',
                        category: 'materials',
                        message: `Missing OpenMC materials: ${missingMaterials.join(', ')}`,
                        suggestion: `Create these materials in the Materials tab to match DAGMC material names`
                    });
                }
            }
        }

        // Only check for CSG cells if not using DAGMC geometry
        if (!settings.dagmcFile && (!geometry.cells || geometry.cells.length === 0)) {
            issues.push({
                severity: 'error',
                category: 'geometry',
                message: 'No cells defined',
                suggestion: 'Add at least one cell to the geometry or import a DAGMC file'
            });
        }

        // Geometry region validation
        if (geometry.cells && geometry.cells.length > 0) {
            const surfaceIds = new Set(geometry.surfaces.map((s) => s.id));

            for (const cell of geometry.cells) {
                // Get region string from either regionString or convert from region tree
                let regionStr = cell.regionString;
                if (!regionStr && cell.region && typeof cell.region === 'string') {
                    regionStr = cell.region;
                }
                if (!regionStr) continue;

                // Extract surface references from region
                const surfaceRefs: Array<{ id: number; side: string }> = [];
                const surfacePattern = /([+-~]?)(\d+)/g;
                let match;

                while ((match = surfacePattern.exec(regionStr)) !== null) {
                    const side = match[1] || '+';
                    const id = parseInt(match[2], 10);
                    surfaceRefs.push({ id, side });
                }

                // Check for undefined surfaces
                for (const ref of surfaceRefs) {
                    if (!surfaceIds.has(ref.id)) {
                        issues.push({
                            severity: 'error',
                            category: 'geometry',
                            message: `Cell ${cell.id}: Region references undefined surface ${ref.id}`,
                            suggestion: `Remove surface ${ref.id} from region or create the surface first`
                        });
                    }
                }

                // Check for contradictory regions (same surface with both + and -)
                const surfaceSides = new Map<number, Set<string>>();
                for (const ref of surfaceRefs) {
                    if (!surfaceSides.has(ref.id)) {
                        surfaceSides.set(ref.id, new Set());
                    }
                    surfaceSides.get(ref.id)!.add(ref.side);
                }

                for (const [id, sides] of surfaceSides) {
                    const hasPositive = sides.has('+') || sides.has('~');
                    const hasNegative = sides.has('-');
                    if (hasPositive && hasNegative) {
                        issues.push({
                            severity: 'error',
                            category: 'geometry',
                            message: `Cell ${cell.id}: Contradictory region - surface ${id} used with both + and -`,
                            suggestion: `Use only one side of surface ${id}. A cell cannot be both inside and outside the same surface`
                        });
                    }
                }
            }
        }

        // Lattice/transform/periodic model checks. OpenMC derives the root
        // universe from fill usage and resolves fill IDs against separate
        // universe/lattice maps, so structural errors must be caught here.
        if (!settings.dagmcFile) {
            issues.push(...validateGeometryModel(geometry));
        }

        // Check for source in fixed source mode
        if (settings.run.mode === 'fixed source') {
            if (!settings.sources || settings.sources.length === 0) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'Fixed source mode requires at least one source definition',
                    suggestion: 'Add an external source in the settings'
                });
            }
        }

        // Mesh sources: valid mesh reference and exactly one sub-source per
        // mesh element (openmc/source.py MeshSource sources setter)
        const sourceEntries = settings.sources ?? [];
        for (let sourceIndex = 0; sourceIndex < sourceEntries.length; sourceIndex++) {
            const source = sourceEntries[sourceIndex];
            if (source.type === 'tokamak') {
                this.validateTokamakSource(source, issues);
                continue;
            }
            if ((source.type ?? 'independent') === 'independent') {
                const label = source.id ?? `source ${sourceIndex + 1}`;
                for (const issue of validateSourceDistributions(source as OpenMCIndependentSource, meshes)) {
                    issues.push({
                        severity: 'error',
                        category: 'settings',
                        message: `${label}: ${issue.message}`,
                        suggestion: issue.suggestion
                    });
                }
                continue;
            }
            if (source.type !== 'mesh') {
                continue;
            }
            if (source.meshId === undefined) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'Mesh source has no mesh selected',
                    suggestion: 'Select a mesh for the mesh source (create one in the Tally Configurator if none exist)'
                });
                continue;
            }
            const mesh = meshes.find((m) => m.id === source.meshId);
            if (!mesh) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: `Mesh source references mesh ${source.meshId} which does not exist`,
                    suggestion: 'Select an existing mesh or create one in the Tally Configurator'
                });
                continue;
            }
            const subCount = source.sources?.length ?? 0;
            if (subCount === 0) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'Mesh source requires at least one sub-source',
                    suggestion: 'Add sub-sources in the source editor (one per mesh element)'
                });
                continue;
            }
            const elementCount = getMeshElementCount(mesh);
            if (elementCount !== undefined && subCount !== elementCount) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: `Mesh source requires exactly ${elementCount} sub-sources (one per mesh element), got ${subCount}`,
                    suggestion: 'Use the Fill button in the source editor to replicate a sub-source across all elements'
                });
            }
            (source.sources ?? []).forEach((sub, subIndex) => {
                for (const issue of validateSourceDistributions(sub, meshes)) {
                    issues.push({
                        severity: 'error',
                        category: 'settings',
                        message: `${source.id ?? 'Mesh source'} element ${subIndex + 1}: ${issue.message}`,
                        suggestion: issue.suggestion
                    });
                }
            });
        }

        // Mesh definitions: structured grids must be usable by OpenMC and
        // unstructured files must match the selected library.
        const fs = await import('fs');
        for (const mesh of meshes ?? []) {
            const label = mesh.name ? `Mesh ${mesh.id} (${mesh.name})` : `Mesh ${mesh.id}`;
            if (mesh.type === 'rectilinear') {
                for (const issue of validateRectilinearMesh(mesh)) {
                    issues.push({
                        severity: 'error',
                        category: 'tallies',
                        message: `${label} ${issue.axis}-grid is invalid: ${issue.message}`,
                        suggestion: `Fix the ${issue.axis.toUpperCase()} grid in the Tally Configurator — rectilinear grids need at least two strictly increasing boundaries`
                    });
                }
            } else if (mesh.type === 'unstructured') {
                if (mesh.lengthMultiplier !== undefined && (!Number.isFinite(mesh.lengthMultiplier) || mesh.lengthMultiplier <= 0)) {
                    issues.push({
                        severity: 'error',
                        category: 'tallies',
                        message: `${label} length multiplier must be greater than 0`,
                        suggestion: 'Set a positive length multiplier (default 1 applies no scaling)'
                    });
                }
                const filenameError = validateUnstructuredMeshFilename(mesh.filename, mesh.library);
                if (filenameError) {
                    issues.push({
                        severity: 'error',
                        category: 'tallies',
                        message: `${label}: ${filenameError}`,
                        suggestion: 'Choose a mesh file whose extension matches the selected MOAB/libMesh library'
                    });
                } else if (!path.isAbsolute(mesh.filename)) {
                    issues.push({
                        severity: 'warning',
                        category: 'tallies',
                        message: `${label} uses a project-relative mesh file (${mesh.filename}) that cannot be verified before generation`,
                        suggestion: 'Save the project (paths resolve on load) or choose the file again to store an absolute path'
                    });
                } else {
                    try {
                        if (!fs.existsSync(mesh.filename)) {
                            issues.push({
                                severity: 'error',
                                category: 'tallies',
                                message: `${label} file does not exist: ${mesh.filename}`,
                                suggestion: 'Choose an existing mesh file in the Tally Configurator or copy it back to that path'
                            });
                        }
                    } catch {
                        issues.push({
                            severity: 'warning',
                            category: 'tallies',
                            message: `${label} file could not be checked: ${mesh.filename}`,
                            suggestion: 'Verify the file exists and is readable before running'
                        });
                    }
                }
            }
        }

        // Filter references and bin shapes: mesh filters need an existing
        // mesh, structured pair filters need valid pairs, reaction/weight/
        // collision/mu bins need valid ranges, and mu-surface needs its
        // surface + current companions.
        for (const tally of tallies ?? []) {
            const tallyLabel = `Tally ${tally.id}${tally.name ? ` (${tally.name})` : ''}`;
            for (const issue of validateTallyFilterSet(
                { filters: tally.filters ?? [], scores: tally.scores ?? [] },
                { cells: geometry.cells, materials, meshes }
            )) {
                issues.push({
                    severity: issue.severity,
                    category: 'tallies',
                    message: `${tallyLabel}: ${issue.message}`,
                    suggestion: issue.fix
                });
            }
        }

        // IFP kinetics: requires eigenvalue mode; ifp_n_generation must not exceed inactive batches
        if (settings.kinetics?.enabled) {
            const eigenRun = settings.run.mode === 'eigenvalue' ? settings.run : undefined;
            if (!eigenRun) {
                issues.push({
                    severity: 'warning',
                    category: 'settings',
                    message: 'IFP kinetics requires eigenvalue (criticality) run mode',
                    suggestion: 'Switch the run mode to eigenvalue or disable kinetics'
                });
            } else if (settings.kinetics.ifpNGenerations !== undefined && settings.kinetics.ifpNGenerations > eigenRun.inactive) {
                issues.push({
                    severity: 'warning',
                    category: 'settings',
                    message: `IFP generations (${settings.kinetics.ifpNGenerations}) exceed inactive batches (${eigenRun.inactive})`,
                    suggestion: 'Reduce IFP generations or increase the number of inactive batches'
                });
            }
        }

        // Multi-group mode requires an MGXS library
        if (settings.energyMode === 'multigroup' && !settings.mgxsLibrary) {
            issues.push({
                severity: 'warning',
                category: 'settings',
                message: 'Multi-group energy mode requires an MGXS library',
                suggestion: 'Set the MGXS library path in the Random Ray tab (generate one with the MGXS Generator window)'
            });
        }

        // Multi-group mode requires macroscopic materials — unless the project
        // uses a nuclide-wise MGXS library (settings.nuclideWiseMgxs), where
        // materials stay nuclide-decomposed and each nuclide resolves against
        // a same-named micro XSdata set. Nuclide-decomposed materials with a
        // material-wise library reference produce "Could not find nuclide"
        // errors because the library contains cross-section sets, not isotopes.
        if (settings.energyMode === 'multigroup' && settings.nuclideWiseMgxs !== true) {
            const nonMacroscopic = materials.filter((m) => !m.macroscopic && m.nuclides && m.nuclides.length > 0);
            if (nonMacroscopic.length > 0) {
                issues.push({
                    severity: 'error',
                    category: 'materials',
                    message: `Multi-group mode requires macroscopic materials, but ${nonMacroscopic
                        .map((m) => m.name || `material ${m.id}`)
                        .join(', ')} ${nonMacroscopic.length === 1 ? 'still contains nuclides' : 'still contain nuclides'}`,
                    suggestion:
                        'Convert the project to multi-group in the Random Ray tab (Convert to Multi-group button), or switch the model back to continuous-energy in the Simulation tab'
                });
            }
        }
        // A nuclide-wise library only helps nuclide-decomposed materials; a
        // macroscopic material would still resolve against a nuclide library.
        if (settings.energyMode === 'multigroup' && settings.nuclideWiseMgxs === true) {
            const macroscopic = materials.filter((m) => m.macroscopic);
            if (macroscopic.length > 0) {
                issues.push({
                    severity: 'error',
                    category: 'materials',
                    message: `Nuclide-wise multi-group mode keeps materials nuclide-decomposed, but ${macroscopic
                        .map((m) => m.name || `material ${m.id}`)
                        .join(', ')} ${macroscopic.length === 1 ? 'is' : 'are'} macroscopic`,
                    suggestion: 'Revert to continuous-energy in the Random Ray tab and convert again with the nuclide-wise option'
                });
            }
        }

        // CMFD acceleration: eigenvalue-only, valid mesh required
        if (settings.cmfd?.enabled) {
            if (settings.run.mode !== 'eigenvalue') {
                issues.push({
                    severity: 'warning',
                    category: 'settings',
                    message: 'CMFD acceleration requires eigenvalue (criticality) run mode',
                    suggestion: 'CMFD accelerates fission source convergence during inactive batches — switch to eigenvalue or disable CMFD'
                });
            }

            const cmfdMesh = settings.cmfd.mesh;
            if (settings.cmfd.meshRef === undefined && !cmfdMesh) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'CMFD is enabled but no mesh is defined',
                    suggestion: 'Select a state mesh or define inline mesh bounds in the Convergence section'
                });
            }
            if (settings.cmfd.meshRef !== undefined) {
                const ref = meshes.find((m) => m.id === settings.cmfd!.meshRef);
                if (!ref) {
                    issues.push({
                        severity: 'error',
                        category: 'settings',
                        message: `CMFD references mesh ${settings.cmfd.meshRef} which does not exist`,
                        suggestion: 'Select an existing mesh or create one in the Tally Configurator'
                    });
                } else if (ref.type !== 'regular') {
                    issues.push({
                        severity: 'error',
                        category: 'settings',
                        message: `CMFD references mesh ${settings.cmfd.meshRef} which is not a regular mesh (CMFDMesh needs structured bounds/dimension)`,
                        suggestion: 'Select a regular mesh or define inline mesh bounds in the Convergence section'
                    });
                }
            }
            if (settings.cmfd.meshRef === undefined && cmfdMesh) {
                const ll = cmfdMesh.lowerLeft;
                const ur = cmfdMesh.upperRight;
                if (!ll || !ur || ll.some((v, i) => v >= (ur[i] ?? Infinity))) {
                    issues.push({
                        severity: 'error',
                        category: 'settings',
                        message: 'CMFD inline mesh bounds are invalid (lower-left must be below upper-right on every axis)',
                        suggestion: 'Fix the mesh bounds or use Auto-detect from Geometry'
                    });
                }
                if (cmfdMesh.dimension && cmfdMesh.dimension.some((d) => d < 1)) {
                    issues.push({
                        severity: 'error',
                        category: 'settings',
                        message: 'CMFD mesh dimensions must be positive (>= 1 cell per axis)',
                        suggestion: 'Increase the mesh dimension values'
                    });
                }
                if (cmfdMesh.albedo && cmfdMesh.albedo.some((a) => a < 0 || a > 1)) {
                    issues.push({
                        severity: 'error',
                        category: 'settings',
                        message: 'CMFD albedo values must be between 0 and 1',
                        suggestion: 'Set each face albedo within [0, 1]'
                    });
                }
            }
        }

        // Random ray on DAGMC geometries: OpenMC rejects macroscopic multi-group
        // materials there, so the only working configuration is multi-group mode
        // with a nuclide-wise MGXS library and nuclide-decomposed materials.
        if (settings.randomRay && settings.dagmcFile) {
            if (materials.some((m) => m.macroscopic)) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message:
                        'Random ray on DAGMC geometries does not support macroscopic multi-group materials (OpenMC aborts at initialization)',
                    suggestion:
                        'Regenerate the MGXS library with the nuclide-wise option in the Random Ray tab (materials stay nuclide-decomposed)'
                });
            }
            if (settings.energyMode !== 'multigroup') {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'Random ray requires multi-group energy mode',
                    suggestion: 'Convert the project to multi-group in the Random Ray tab'
                });
            } else if (settings.nuclideWiseMgxs !== true) {
                issues.push({
                    severity: 'error',
                    category: 'settings',
                    message: 'Random ray on DAGMC geometries requires a nuclide-wise MGXS library (materials stay nuclide-decomposed)',
                    suggestion: 'Enable the nuclide-wise option when converting to multi-group in the Random Ray tab'
                });
            }
        }

        // Random ray requires inactive batches in both run modes (random_ray.rst:108)
        if (settings.randomRay) {
            const inactiveBatches =
                settings.run.mode === 'eigenvalue'
                    ? settings.run.inactive
                    : settings.run.mode === 'fixed source'
                      ? settings.run.inactive
                      : 0;
            if (!inactiveBatches || inactiveBatches <= 0) {
                issues.push({
                    severity: 'warning',
                    category: 'settings',
                    message: 'Random ray requires inactive batches in both eigenvalue and fixed source mode',
                    suggestion: 'Set inactive batches > 0 (Random Ray mode needs them to develop the scattering source)'
                });
            }
            // Ray source should cover the geometry domain when bounds are verifiable
            if (settings.randomRay.raySource) {
                const hasGeometry = request.state.geometry.cells.length > 0 || !!settings.dagmcFile;
                if (!hasGeometry) {
                    issues.push({
                        severity: 'warning',
                        category: 'settings',
                        message: 'Cannot verify ray source coverage: no geometry defined',
                        suggestion: 'Define geometry before relying on the ray source box'
                    });
                }
            }

            // Fixed-source random ray requires each source to be constrained to a
            // domain (cell, material, or universe) or be a point source.
            if (settings.run.mode === 'fixed source') {
                for (const source of settings.sources) {
                    const spatial = (source as OpenMCIndependentSource).spatial;
                    const isPointSource = spatial?.type === 'point';
                    const hasDomainConstraint =
                        source.constraints?.domainType && source.constraints.domainIds && source.constraints.domainIds.length > 0;
                    if (!isPointSource && !hasDomainConstraint) {
                        issues.push({
                            severity: 'error',
                            category: 'settings',
                            message: `Fixed-source random ray requires the source "${source.id ?? 'source'}" to be a point source or constrained to a domain`,
                            suggestion:
                                'Add a domain constraint (cell, material, or universe) to the source in the Sources tab, use the Random Ray tab helper, or switch to a point source'
                        });
                    }
                }
            }
        }

        // FW-CADIS weight window generation runs an adjoint solve that only
        // exists in the random ray solver (C++: 'FW-CADIS can only be run in
        // random ray solver mode').
        if (request.state.varianceReduction?.weightWindowGenerator?.method === 'fw_cadis' && !settings.randomRay) {
            issues.push({
                severity: 'error',
                category: 'settings',
                message: 'FW-CADIS weight window generation requires random ray mode',
                suggestion: 'Enable the random ray solver in the Random Ray tab (requires multi-group energy mode)'
            });
        }

        // Weight windows, checkpoints, the weight-window generator, and UFS.
        for (const finding of validateVarianceReduction(request.state.varianceReduction, meshes, settings.run.mode)) {
            issues.push(varianceReductionValidationIssue(finding));
        }
        const weightWindowsFile = request.state.varianceReduction?.weightWindowsFile;
        if (weightWindowsFile && path.isAbsolute(weightWindowsFile) && !fs.existsSync(weightWindowsFile)) {
            issues.push({
                severity: 'error',
                category: 'settings',
                message: `Weight-window file does not exist: ${weightWindowsFile}`,
                suggestion: 'Pick the generated weight_windows.h5 file or run the generator first'
            });
        }

        // Source/geometry overlap check: warn when independent sources are placed
        // outside the verifiable geometry bounds. This catches point sources in void
        // and source boxes that do not overlap the model.
        const geomBounds = calculateGeometryBounds(request.state);
        if (geomBounds && settings.sources.length > 0) {
            const materialIds = new Set(materials.map((m) => m.id));
            const cellIds = new Set(request.state.geometry.cells.map((c) => c.id));
            const universeIds = new Set(request.state.geometry.universes.map((u) => u.id));
            // DAGMC volumes are also valid cell IDs for domain constraints
            for (const vol of settings.dagmcInfo?.volumes ?? []) {
                cellIds.add(vol.id);
            }

            for (const source of settings.sources) {
                const spatial = (source as OpenMCIndependentSource).spatial as any;
                if (!spatial) {
                    continue;
                }

                if (spatial.type === 'point' && spatial.origin) {
                    if (!pointInBounds(spatial.origin as [number, number, number], geomBounds)) {
                        issues.push({
                            severity: 'warning',
                            category: 'settings',
                            message: `Point source "${source.id ?? 'source'}" is outside the geometry bounds`,
                            suggestion:
                                `Origin [${spatial.origin.join(',')}] lies outside [${geomBounds.min.join(',')}] to [${geomBounds.max.join(',')}]. ` +
                                'Move the source inside the model or constrain it to a material/cell/universe domain.'
                        });
                    }
                } else if (spatial.type === 'box' && spatial.lowerLeft && spatial.upperRight) {
                    if (
                        !boxOverlapsBounds(
                            {
                                lowerLeft: spatial.lowerLeft as [number, number, number],
                                upperRight: spatial.upperRight as [number, number, number]
                            },
                            geomBounds
                        )
                    ) {
                        issues.push({
                            severity: 'warning',
                            category: 'settings',
                            message: `Source box "${source.id ?? 'source'}" does not overlap the geometry`,
                            suggestion:
                                `Box [${spatial.lowerLeft.join(',')}] to [${spatial.upperRight.join(',')}] does not overlap ` +
                                `[${geomBounds.min.join(',')}] to [${geomBounds.max.join(',')}]. ` +
                                'Snap the source to the geometry bounds or constrain it to a domain.'
                        });
                    }
                }

                // Validate domain constraint IDs exist in the model
                if (source.constraints?.domainType && source.constraints.domainIds && source.constraints.domainIds.length > 0) {
                    const idSet =
                        source.constraints.domainType === 'material'
                            ? materialIds
                            : source.constraints.domainType === 'cell'
                              ? cellIds
                              : universeIds;
                    const invalidIds = source.constraints.domainIds.filter((id) => !idSet.has(id));
                    if (invalidIds.length > 0) {
                        issues.push({
                            severity: 'error',
                            category: 'settings',
                            message: `Source "${source.id ?? 'source'}" references unknown ${source.constraints.domainType} IDs: ${invalidIds.join(', ')}`,
                            suggestion: `Check the ${source.constraints.domainType} IDs in the Sources tab or Random Ray tab helper.`
                        });
                    }
                }
            }
        }

        // Plot appearance: missing mask domains and controls OpenMC ignores
        // for the selected plot type are configuration warnings.
        for (const plot of request.state.plots ?? []) {
            for (const issue of validatePlotAppearance(plot, request.state)) {
                issues.push({
                    severity: 'warning',
                    category: 'settings',
                    message: issue.message,
                    suggestion: issue.suggestion,
                    path: `plots.${plot.id}.${issue.field}`
                });
            }
        }

        // Check for fissile material in eigenvalue mode (skip for DAGMC - materials are in the file)
        if (settings.run.mode === 'eigenvalue' && !settings.dagmcFile) {
            const fissileNuclides = [
                'U233',
                'U235',
                'Pu238',
                'Pu239',
                'Pu240',
                'Pu241',
                'Pu242',
                'Am241',
                'Am242',
                'Am243',
                'Cm242',
                'Cm243',
                'Cm244',
                'Cm245',
                'Cm246'
            ];

            let hasFissileMaterial = false;
            for (const material of materials) {
                for (const nuclide of material.nuclides) {
                    if (fissileNuclides.some((fn) => nuclide.name.includes(fn))) {
                        hasFissileMaterial = true;
                        break;
                    }
                }
                if (hasFissileMaterial) break;
            }

            if (!hasFissileMaterial) {
                issues.push({
                    severity: 'error',
                    category: 'materials',
                    message: 'Eigenvalue mode requires at least one fissile material',
                    suggestion:
                        'Add a fissile nuclide like U235 or Pu239 to a material. Eigenvalue calculations require fission chain reactions.'
                });
            }
        }

        // Check depletion settings
        const depletion = request.state.depletion;
        if (depletion?.enabled) {
            // Check for power
            const powerValue = depletion.power !== undefined ? depletion.power : depletion.powerDensity;
            if (powerValue === undefined || powerValue <= 0) {
                issues.push({
                    severity: 'error',
                    category: 'depletion',
                    message: 'Depletion requires power level to be set',
                    suggestion: 'Set the power level in the Depletion tab under Physics Configuration'
                });
            }

            // Check for chain file
            if (!depletion.chainFile) {
                issues.push({
                    severity: 'warning',
                    category: 'depletion',
                    message: 'Depletion chain file not specified',
                    suggestion: 'Select a chain file in the Depletion tab (e.g., chain_endfb71.xml)'
                });
            }

            // Macroscopic (multigroup) materials have no nuclides — they can
            // never deplete, in any mode or operator
            const macroscopicDepletable = materials.filter((m) => m.isDepletable && m.macroscopic);
            if (macroscopicDepletable.length > 0) {
                issues.push({
                    severity: 'error',
                    category: 'depletion',
                    message: `Depletion requires nuclide-decomposed materials; ${macroscopicDepletable.map((m) => m.name).join(', ')} ${macroscopicDepletable.length === 1 ? 'is' : 'are'} macroscopic`,
                    suggestion:
                        'Macroscopic materials carry cross-section sets, not nuclides — use nuclide-decomposed materials for depletion'
                });
            }

            // Coupled depletion is continuous-energy only in this OpenMC
            // version (CoupledOperator needs a CE cross_sections.xml)
            if (settings.energyMode === 'multigroup' && (depletion.operator ?? 'coupled') !== 'independent') {
                issues.push({
                    severity: 'error',
                    category: 'depletion',
                    message:
                        'Coupled depletion requires continuous-energy mode; multigroup depletion uses the Independent operator (flux/MicroXS)',
                    suggestion:
                        'Switch the operator to Independent in the Depletion tab Advanced section (or switch the model to continuous-energy)'
                });
            }

            // MicroXS generation needs a CE transport solve with per-nuclide data
            if (
                settings.energyMode === 'multigroup' &&
                (depletion.operator ?? 'coupled') === 'independent' &&
                depletion.generateFromModel
            ) {
                issues.push({
                    severity: 'error',
                    category: 'depletion',
                    message: 'MicroXS generation requires continuous-energy mode',
                    suggestion: 'Provide flux/MicroXS files instead, or switch the model to continuous-energy'
                });
            }

            // Independent operator needs precomputed flux/MicroXS per
            // depletable material, or model-based generation
            if ((depletion.operator ?? 'coupled') === 'independent' && !depletion.generateFromModel) {
                const depletableCount = Math.max(materials.filter((m) => m.isDepletable).length, 1);
                const fluxFiles = (depletion.fluxFiles ?? []).filter((f) => f.trim().length > 0);
                const microxsFiles = (depletion.microxsFiles ?? []).filter((f) => f.trim().length > 0);
                if (fluxFiles.length < depletableCount || microxsFiles.length < depletableCount) {
                    issues.push({
                        severity: 'error',
                        category: 'depletion',
                        message: 'Independent depletion operator requires flux and MicroXS files for each depletable material',
                        suggestion:
                            'Provide flux/MicroXS files in the Depletion tab Advanced section, or enable "Generate flux & MicroXS from current model"'
                    });
                }
            }

            // Check for depletable materials
            const hasDepletableMaterials = materials.some((m) => m.isDepletable);
            if (!hasDepletableMaterials) {
                issues.push({
                    severity: 'error',
                    category: 'depletion',
                    message: 'No depletable materials configured',
                    suggestion: 'Enable "Depletable" for at least one material in the Materials tab'
                });
            }

            // Check for time steps
            if (!depletion.timeSteps || depletion.timeSteps.length === 0) {
                issues.push({
                    severity: 'error',
                    category: 'depletion',
                    message: 'No depletion time steps defined',
                    suggestion: 'Add at least one time step in the Depletion tab under Operational Timeline'
                });
            }

            // Advanced run controls: substeps, reactivity search, external
            // feed/removal rates, and continuation. Pure rules live in the
            // shared module so the tab and backend cannot diverge.
            for (const issue of validateDepletionAdvanced(request.state)) {
                issues.push({
                    severity: issue.severity,
                    category: 'depletion',
                    message: issue.message,
                    suggestion: issue.suggestion
                });
            }
            if (depletion.continueFromResults) {
                const fs = await import('fs');
                if (!fs.existsSync(depletion.continueFromResults)) {
                    issues.push({
                        severity: 'error',
                        category: 'depletion',
                        message: `Previous depletion results file not found: ${depletion.continueFromResults}`,
                        suggestion: 'Select the depletion_results.h5 produced by the earlier run, or clear continuation.'
                    });
                }
            }
        }

        return {
            valid: issues.filter((i) => i.severity === 'error').length === 0,
            issues,
            summary: {
                errors: issues.filter((i) => i.severity === 'error').length,
                warnings: issues.filter((i) => i.severity === 'warning').length,
                info: issues.filter((i) => i.severity === 'info').length
            }
        };
    }

    /**
     * Check for geometry overlaps using sampling.
     * @param request - Overlap check request with geometry
     * @returns Overlap detection results
     */
    async checkOverlaps(request: OverlapCheckRequest): Promise<OverlapCheckResult> {
        this.log('Checking for geometry overlaps');
        // TODO: Implement overlap checking.
        return {
            complete: true,
            overlaps: [],
            samplesChecked: 0,
            elapsedTime: 0
        };
    }

    /**
     * Validate a region expression string.
     * @param region - Region expression (e.g., "-1 2 -3")
     * @param surfaces - Available surfaces for reference checking
     * @returns Validation result
     */
    async validateRegion(region: string, surfaces: any[]): Promise<{ valid: boolean; error?: string }> {
        this.log(`Validating region expression: ${region}`);
        // TODO: Implement region validation.
        return { valid: true };
    }

    // ============================================================================
    // Project Management
    // ============================================================================

    /**
     * Create a new project with initial state.
     * @param request - Project creation parameters
     * @returns Creation result with project file path and initial state
     */
    async createProject(request: ProjectCreateRequest): Promise<ProjectCreateResult> {
        this.log(`Creating new project: ${request.name}`);

        try {
            const fs = await import('fs');
            const path = await import('path');

            // Create directory if it doesn't exist
            if (!fs.existsSync(request.directory)) {
                fs.mkdirSync(request.directory, { recursive: true });
            }

            // Create initial state
            const now = new Date().toISOString();
            const initialState: OpenMCState = {
                metadata: {
                    version: OPENMC_STATE_SCHEMA_VERSION,
                    name: request.name,
                    description: request.description || '',
                    author: request.author,
                    created: now,
                    modified: now
                },
                geometry: {
                    surfaces: [],
                    cells: [],
                    universes: [
                        {
                            id: 0,
                            name: 'root',
                            cellIds: []
                        }
                    ],
                    lattices: [],
                    rootUniverseId: 0
                },
                materials: [],
                settings: {
                    run: {
                        mode: 'eigenvalue',
                        particles: 1000,
                        inactive: 10,
                        batches: 100
                    },
                    sources: []
                },
                tallies: [],
                meshes: []
            };

            // Create project file
            const projectFile: OpenMCProjectFile = {
                version: OPENMC_STATE_SCHEMA_VERSION,
                state: initialState
            };

            const projectPath = path.join(request.directory, `${request.name}.nuke-openmc`);
            fs.writeFileSync(projectPath, JSON.stringify(projectFile, null, 2));

            return {
                success: true,
                projectFile: projectPath,
                initialState
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: msg
            };
        }
    }

    /**
     * Load a project file from disk.
     * @param projectPath - Path to .nuke-openmc file
     * @returns Load result with project data
     */
    async loadProject(projectPath: string): Promise<ProjectLoadResult> {
        this.log(`Loading project: ${projectPath}`);

        try {
            const fs = await import('fs');
            const path = await import('path');
            const content = fs.readFileSync(projectPath, 'utf-8');
            const parsed: OpenMCProjectFile = JSON.parse(content);
            const { project, migratedFrom, warnings: migrationWarnings } = migrateProjectFile(parsed);

            if (migratedFrom) {
                this.log(`Migrated project from schema ${migratedFrom} to ${OPENMC_STATE_SCHEMA_VERSION}`);
            }
            for (const warning of migrationWarnings ?? []) {
                this.log(`Project normalization: ${warning}`);
            }

            // Resolve project-relative paths back to absolute paths.
            const projectDir = path.dirname(projectPath);
            if (project.state.settings.dagmcInfo?.filePath && !path.isAbsolute(project.state.settings.dagmcInfo.filePath)) {
                project.state.settings.dagmcInfo.filePath = path.resolve(projectDir, project.state.settings.dagmcInfo.filePath);
            }
            if (project.state.settings.dagmcFile && !path.isAbsolute(project.state.settings.dagmcFile)) {
                project.state.settings.dagmcFile = path.resolve(projectDir, project.state.settings.dagmcFile);
            }
            if (project.state.settings.mgxsLibrary && !path.isAbsolute(project.state.settings.mgxsLibrary)) {
                project.state.settings.mgxsLibrary = path.resolve(projectDir, project.state.settings.mgxsLibrary);
            }
            if (project.state.settings.randomRay?.mgxsLibraryPath && !path.isAbsolute(project.state.settings.randomRay.mgxsLibraryPath)) {
                project.state.settings.randomRay.mgxsLibraryPath = path.resolve(
                    projectDir,
                    project.state.settings.randomRay.mgxsLibraryPath
                );
            }
            // Unstructured mesh files are stored project-relative when possible.
            for (const mesh of project.state.meshes ?? []) {
                if (mesh.type === 'unstructured' && mesh.filename && !path.isAbsolute(mesh.filename)) {
                    mesh.filename = path.resolve(projectDir, mesh.filename);
                }
            }

            return {
                success: true,
                project,
                warnings: migrationWarnings
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: msg
            };
        }
    }

    /**
     * Save project file to disk, optionally generating XML.
     * @param request - Save request with project path and state
     * @returns Save result
     */
    async saveProject(request: ProjectSaveRequest): Promise<{ success: boolean; error?: string }> {
        this.log(`Saving project: ${request.projectPath}`);

        try {
            const fs = await import('fs');
            const path = await import('path');

            // Deep-copy state so serialization changes do not mutate the live IDE state.
            const projectDir = path.dirname(request.projectPath);
            const stateToSave: OpenMCState = JSON.parse(JSON.stringify(request.state));

            // Convert absolute, existing DAGMC/MGXS paths to project-relative for portability.
            if (stateToSave.settings.dagmcInfo?.filePath && path.isAbsolute(stateToSave.settings.dagmcInfo.filePath)) {
                try {
                    if (fs.existsSync(stateToSave.settings.dagmcInfo.filePath)) {
                        stateToSave.settings.dagmcInfo.filePath = path.relative(projectDir, stateToSave.settings.dagmcInfo.filePath);
                    }
                } catch {
                    // ignore
                }
            }
            if (stateToSave.settings.dagmcFile && path.isAbsolute(stateToSave.settings.dagmcFile)) {
                try {
                    if (fs.existsSync(stateToSave.settings.dagmcFile)) {
                        stateToSave.settings.dagmcFile = path.relative(projectDir, stateToSave.settings.dagmcFile);
                    }
                } catch {
                    // ignore
                }
            }
            if (stateToSave.settings.mgxsLibrary && path.isAbsolute(stateToSave.settings.mgxsLibrary)) {
                try {
                    if (fs.existsSync(stateToSave.settings.mgxsLibrary)) {
                        stateToSave.settings.mgxsLibrary = path.relative(projectDir, stateToSave.settings.mgxsLibrary);
                    }
                } catch {
                    // ignore
                }
            }
            for (const mesh of stateToSave.meshes ?? []) {
                if (mesh.type === 'unstructured' && mesh.filename && path.isAbsolute(mesh.filename)) {
                    try {
                        if (fs.existsSync(mesh.filename)) {
                            mesh.filename = path.relative(projectDir, mesh.filename);
                        }
                    } catch {
                        // ignore
                    }
                }
            }

            const projectFile: OpenMCProjectFile = {
                version: OPENMC_STATE_SCHEMA_VERSION,
                state: stateToSave
            };

            fs.writeFileSync(request.projectPath, JSON.stringify(projectFile, null, 2));

            // Also generate XML if requested
            if (request.generateXml) {
                const path = await import('path');
                const outputDir = path.dirname(request.projectPath);
                await this.xmlService.generateXML(
                    await this.withOpenMCCompat({
                        state: request.state,
                        outputDirectory: outputDir,
                        files: {
                            geometry: true,
                            materials: true,
                            settings: true,
                            tallies: true,
                            plots: false
                        },
                        overwrite: true
                    })
                );
            }

            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: msg
            };
        }
    }

    /**
     * Get available project templates.
     * @returns List of templates with metadata
     */
    async getTemplates(): Promise<TemplatesResponse> {
        this.log('Getting available templates');

        return {
            templates: [
                {
                    id: 'pin-cell',
                    name: 'Pin Cell',
                    description: 'Basic fuel pin cell with cladding and moderator',
                    icon: 'fa fa-circle',
                    defaultState: {}
                },
                {
                    id: 'fuel-assembly',
                    name: 'Fuel Assembly',
                    description: '17x17 PWR fuel assembly with guide tubes',
                    icon: 'fa fa-th',
                    defaultState: {}
                },
                {
                    id: 'full-core',
                    name: 'Full Core',
                    description: 'Full reactor core with multiple assemblies',
                    icon: 'fa fa-dot-circle-o',
                    defaultState: {}
                },
                {
                    id: 'shielding',
                    name: 'Shielding',
                    description: 'Shielding and criticality safety model',
                    icon: 'fa fa-shield',
                    defaultState: {}
                },
                {
                    id: 'blank',
                    name: 'Blank Project',
                    description: 'Start from scratch',
                    icon: 'fa fa-file-o',
                    defaultState: {}
                }
            ]
        };
    }

    /**
     * Apply a template to create or modify state.
     * @param request - Template application request
     * @returns Result with modified state
     */
    async applyTemplate(request: ApplyTemplateRequest): Promise<{ success: boolean; state?: OpenMCState; error?: string }> {
        this.log(`Applying template: ${request.templateId}`);
        // TODO: Implement template application with specific configurations
        return {
            success: false,
            error: 'Template application not yet implemented'
        };
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Get cross-sections path from environment.
     * @returns Path and existence status
     */
    async getCrossSectionsPath(): Promise<{ path?: string; found: boolean }> {
        const crossSectionsEnv = process.env.OPENMC_CROSS_SECTIONS;

        if (crossSectionsEnv) {
            const fs = await import('fs');
            const exists = fs.existsSync(crossSectionsEnv);
            return {
                path: crossSectionsEnv,
                found: exists
            };
        }

        return { found: false };
    }

    /**
     * Suggest the next available material ID.
     * @param state - Current simulation state
     * @returns Suggested material ID
     */
    async suggestMaterialId(state: OpenMCState): Promise<number> {
        const ids = state.materials.map((m) => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available cell ID.
     * @param state - Current simulation state
     * @returns Suggested cell ID
     */
    async suggestCellId(state: OpenMCState): Promise<number> {
        const ids = state.geometry.cells.map((c) => c.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available surface ID.
     * @param state - Current simulation state
     * @returns Suggested surface ID
     */
    async suggestSurfaceId(state: OpenMCState): Promise<number> {
        const ids = state.geometry.surfaces.map((s) => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available tally ID.
     * @param state - Current simulation state
     * @returns Suggested tally ID
     */
    async suggestTallyId(state: OpenMCState): Promise<number> {
        const ids = state.tallies.map((t) => t.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available mesh ID.
     * @param state - Current simulation state
     * @returns Suggested mesh ID
     */
    async suggestMeshId(state: OpenMCState): Promise<number> {
        const ids = state.meshes.map((m) => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    // ============================================================================
    // CAD Import
    // ============================================================================

    /**
     * Check if CAD import dependencies are available.
     * @returns CAD library availability and Python path
     */
    async checkCADSupport(): Promise<{
        available: boolean;
        libraries: {
            openCascade: boolean;
            gmsh: boolean;
            cadQuery: boolean;
        };
        pythonPath?: string;
    }> {
        return this.cadService.checkCADSupport();
    }

    /**
     * Import a CAD file and convert to OpenMC-compatible CSG.
     * @param request - CAD import request with file path and options
     * @returns Import result with surfaces, cells, and metadata
     */
    async importCAD(
        request: import('../common/openmc-studio-protocol').CADImportRequest
    ): Promise<import('../common/openmc-studio-protocol').CADImportResult> {
        return this.cadService.importCAD(request);
    }

    /**
     * Preview CAD file info without full import.
     * @param filePath - Path to CAD file
     * @returns Basic file information
     */
    async previewCAD(filePath: string): Promise<{
        format: string;
        solidCount: number;
        faceCount: number;
        bounds?: { min: [number, number, number]; max: [number, number, number] };
    }> {
        return this.cadService.previewCAD(filePath);
    }

    /**
     * Import a DAGMC model produced by nuke-cad into the current OpenMC project.
     * @param request - Import request with h5m path and optional manifest path
     * @returns Import result with DAGMC info and material names
     */
    async importNukeCAD(
        request: import('../common/openmc-studio-protocol').NukeCADImportRequest
    ): Promise<import('../common/openmc-studio-protocol').NukeCADImportResult> {
        this.log(`Importing nuke-cad model from ${request.h5mPath}`);
        return this.cadService.importNukeCAD(request);
    }

    // ============================================================================
    // DAGMC Editor
    // ============================================================================

    /**
     * Load DAGMC file and return model information.
     * @param filePath - Path to DAGMC .h5m file
     * @returns Model data with volumes, materials, and groups
     */
    async dagmcLoad(filePath: string): Promise<{
        success: boolean;
        data?: {
            filePath: string;
            fileName: string;
            fileSizeMB: number;
            volumeCount: number;
            surfaceCount: number;
            vertices: number;
            materials: Record<string, { volumeCount: number; volumes: number[] }>;
            volumes: Array<{
                id: number;
                material?: string;
                numTriangles: number;
                boundingBox: { min: number[]; max: number[] };
            }>;
            groups: Array<{
                name: string;
                type: string;
                volumeCount: number;
                volumes: number[];
            }>;
            boundingBox: { min: number[]; max: number[] };
        };
        error?: string;
    }> {
        this.log(`Loading DAGMC file: ${filePath}`);
        return this.dagmcEditorService.loadModel(filePath);
    }

    /**
     * Assign material to a volume in DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @param volumeId - Volume ID to modify
     * @param materialName - Material name to assign
     * @returns Operation result
     */
    async dagmcAssignMaterial(
        filePath: string,
        volumeId: number,
        materialName: string
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }> {
        this.log(`Assigning material "${materialName}" to volume ${volumeId} in ${filePath}`);
        return this.dagmcEditorService.assignMaterial(filePath, volumeId, materialName);
    }

    /**
     * Create a new group in DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @param groupName - Name for the new group
     * @param volumeIds - Optional volume IDs to include
     * @returns Operation result
     */
    async dagmcCreateGroup(
        filePath: string,
        groupName: string,
        volumeIds?: number[]
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }> {
        this.log(`Creating group "${groupName}" in ${filePath}`);
        return this.dagmcEditorService.createGroup(filePath, groupName, volumeIds);
    }

    /**
     * Delete a group from DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @param groupName - Name of group to delete
     * @returns Operation result
     */
    async dagmcDeleteGroup(
        filePath: string,
        groupName: string
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }> {
        this.log(`Deleting group "${groupName}" from ${filePath}`);
        return this.dagmcEditorService.deleteGroup(filePath, groupName);
    }

    /**
     * Replace a material by name across all volumes in a DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @param oldName - Material name to replace
     * @param newName - Material name to assign instead
     * @returns Operation result
     */
    async dagmcReplaceMaterial(
        filePath: string,
        oldName: string,
        newName: string
    ): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }> {
        this.log(`Replacing material "${oldName}" with "${newName}" in ${filePath}`);
        return this.dagmcEditorService.replaceMaterial(filePath, oldName, newName);
    }

    /**
     * Detect whether a DAGMC file has a properly tagged graveyard volume.
     * @param filePath - Path to DAGMC .h5m file
     * @returns Detection result with candidate volume ID when applicable
     */
    async dagmcDetectGraveyard(filePath: string): Promise<{
        success: boolean;
        needsTag?: boolean;
        canCreate?: boolean;
        volumeId?: number;
        material?: string;
        message?: string;
        bounds?: { min: number[]; max: number[] };
        suggestedPadding?: number;
        error?: string;
    }> {
        this.log(`Detecting graveyard in ${filePath}`);
        return this.dagmcEditorService.detectGraveyard(filePath);
    }

    /**
     * Tag a volume as the DAGMC graveyard.
     * @param filePath - Path to DAGMC .h5m file
     * @param volumeId - Optional volume ID to tag; auto-detected if omitted
     * @returns Operation result with tagged volume ID
     */
    async dagmcTagGraveyard(
        filePath: string,
        volumeId?: number
    ): Promise<{
        success: boolean;
        volumeId?: number;
        oldMaterial?: string;
        message?: string;
        error?: string;
    }> {
        this.log(`Tagging graveyard in ${filePath}${volumeId !== undefined ? ` (volume ${volumeId})` : ''}`);
        return this.dagmcEditorService.tagGraveyard(filePath, volumeId);
    }

    /**
     * Create a new axis-aligned bounding-box graveyard volume.
     * @param filePath - Path to DAGMC .h5m file
     * @param padding - Optional clearance fraction (default 0.1)
     * @returns Operation result with created volume ID and bounding box
     */
    async dagmcCreateGraveyard(filePath: string, padding?: number): Promise<DAGMCCreateGraveyardResult> {
        this.log(`Creating graveyard bounding box in ${filePath}${padding !== undefined ? ` (padding ${padding})` : ''}`);
        return this.dagmcEditorService.createGraveyardBox(filePath, padding);
    }

    /**
     * Synchronize DAGMC universes for depletion.
     * @param workingDirectory - Directory containing the model XML files
     * @returns Sync result with cell/material counts
     */
    async dagmcSyncForDepletion(workingDirectory: string): Promise<{
        success: boolean;
        cellCount?: number;
        materialCount?: number;
        materialNames?: string[];
        geometryXml?: string;
        error?: string;
        output?: string;
    }> {
        this.log(`Synchronizing DAGMC universes for depletion in ${workingDirectory}`);
        return this.dagmcEditorService.syncForDepletion(workingDirectory);
    }

    /**
     * Get faceting parameters from a DAGMC file.
     * @param filePath - Path to DAGMC .h5m file
     * @returns Faceting tolerance and triangle count
     */
    async dagmcGetFacetingParams(filePath: string): Promise<{
        success: boolean;
        data?: { facetingTolerance: number; totalTriangles: number; volumeCount: number; surfaceCount: number };
        error?: string;
    }> {
        this.log(`Getting faceting params for ${filePath}`);
        return this.dagmcEditorService.getFacetingParams(filePath);
    }

    /**
     * Re-export a DAGMC file from source CAD with new faceting tolerance.
     * @param filePath - Path to existing DAGMC .h5m file
     * @param sourceCadPath - Path to source CAD file
     * @param tolerance - Desired faceting tolerance
     * @returns Operation result with output path
     */
    async dagmcRefacet(
        filePath: string,
        sourceCadPath: string,
        tolerance: number,
        imprint?: boolean
    ): Promise<{
        success: boolean;
        data?: { outputPath: string; message?: string };
        error?: string;
    }> {
        this.log(`Re-faceting ${filePath} from ${sourceCadPath} with tolerance ${tolerance}`);
        return this.dagmcEditorService.refacet(filePath, sourceCadPath, tolerance, imprint);
    }

    async dagmcCancelRefacet(): Promise<void> {
        this.log('Cancelling active re-faceting operation');
        this.dagmcEditorService.cancelRefacet();
    }

    // ============================================================================
    // WWINP Import/Export
    // ============================================================================

    /**
     * Import MCNP WWINP weight window file.
     * @param request - Import request with file path
     * @returns Imported weight windows data
     */
    async importWWINP(request: { filePath: string }): Promise<{
        success: boolean;
        weightWindows?: {
            meshId: number;
            lowerBound: number | number[];
            upperBound?: number | number[];
            energyBounds?: number[];
            particleType?: 'neutron' | 'photon';
        };
        error?: string;
    }> {
        this.log(`Importing WWINP from ${request.filePath}`);

        try {
            // For now, return a placeholder response
            // Full implementation would parse WWINP binary format
            this.log('WWINP import: Using placeholder implementation');
            return {
                success: true,
                weightWindows: {
                    meshId: 1,
                    lowerBound: 0.5,
                    upperBound: 1.0,
                    particleType: 'neutron' as const
                }
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`WWINP import failed: ${msg}`);
            return { success: false, error: msg };
        }
    }

    /**
     * Export to MCNP WWINP weight window file.
     * @param request - Export request with weight windows and mesh data
     * @returns Export result
     */
    async exportWWINP(request: { filePath: string; weightWindows: any; meshes: any[] }): Promise<{
        success: boolean;
        error?: string;
    }> {
        this.log(`Exporting WWINP to ${request.filePath}`);

        try {
            const fs = await import('fs');

            // Create a simple text-based WWINP format
            // Note: Full WWINP is binary, this is a simplified text representation
            const lines: string[] = [];
            lines.push('MCNP Weight Window File');
            lines.push(`Generated by OpenMC Studio - ${new Date().toISOString()}`);
            lines.push('');
            lines.push('MESH DIMENSIONS:');

            // Find mesh info
            const mesh = request.meshes.find((m: any) => m.id === request.weightWindows.meshId);
            if (mesh && mesh.type === 'regular') {
                lines.push(`  NX: ${mesh.dimension[0]}`);
                lines.push(`  NY: ${mesh.dimension[1]}`);
                lines.push(`  NZ: ${mesh.dimension[2]}`);
                lines.push(`  Lower Left: ${mesh.lowerLeft.join(' ')}`);
                lines.push(`  Upper Right: ${mesh.upperRight.join(' ')}`);
            }

            lines.push('');
            lines.push('PARTICLE TYPE: ' + (request.weightWindows.particleType || 'neutron'));
            lines.push('');
            lines.push('LOWER BOUNDS:');

            // Write bounds
            const lowerBounds = Array.isArray(request.weightWindows.lowerBound)
                ? request.weightWindows.lowerBound
                : [request.weightWindows.lowerBound];
            lines.push(lowerBounds.join(' '));

            lines.push('');
            lines.push('UPPER BOUNDS:');
            const upperBounds = Array.isArray(request.weightWindows.upperBound)
                ? request.weightWindows.upperBound
                : [request.weightWindows.upperBound || request.weightWindows.lowerBound * 2];
            lines.push(upperBounds.join(' '));

            if (request.weightWindows.energyBounds && request.weightWindows.energyBounds.length > 0) {
                lines.push('');
                lines.push('ENERGY BOUNDS:');
                lines.push(request.weightWindows.energyBounds.join(' '));
            }

            // Write file
            fs.writeFileSync(request.filePath, lines.join('\n'));
            this.log(`WWINP exported successfully to ${request.filePath}`);

            return { success: true };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`WWINP export failed: ${msg}`);
            return { success: false, error: msg };
        }
    }

    // ============================================================================
    // Statepoint Comparison
    // ============================================================================

    /**
     * Read a single statepoint file and extract data.
     * @param request - Read request with file path
     * @returns Statepoint information and data
     */
    async readStatepoint(request: { filePath: string }): Promise<import('../common/openmc-studio-protocol').ReadStatepointResult> {
        this.log(`Reading statepoint file: ${request.filePath}`);

        try {
            const fs = await import('fs');
            const path = await import('path');
            const { execSync } = await import('child_process');

            // Check if file exists
            if (!fs.existsSync(request.filePath)) {
                return {
                    success: false,
                    filePath: request.filePath,
                    fileName: path.basename(request.filePath),
                    fileSizeMB: 0,
                    error: `File not found: ${request.filePath}`
                };
            }

            // Get file stats
            const stats = fs.statSync(request.filePath);

            // Find the statepoint reader script
            const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'statepoint_reader.py' });

            if (!scriptPath) {
                return {
                    success: false,
                    filePath: request.filePath,
                    fileName: path.basename(request.filePath),
                    fileSizeMB: Math.round((stats.size / (1024 * 1024)) * 100) / 100,
                    error: 'Statepoint reader script not found'
                };
            }

            this.log(`Using script: ${scriptPath}`);

            // Get Python command from runner service
            const pythonInfo = (await this.runnerService['detectPythonCommand']?.()) || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';

            this.log(`Using Python: ${pythonCommand}`);

            // Execute the Python script - capture both stdout and stderr
            let output: string;
            try {
                output = execSync(`"${pythonCommand}" "${scriptPath}" "${request.filePath}" --json`, {
                    encoding: 'utf-8',
                    timeout: 60000,
                    stdio: ['pipe', 'pipe', 'pipe']
                });
            } catch (execError: any) {
                // Capture stderr from the error
                const stderr = execError.stderr ? execError.stderr.toString() : '';
                const stdout = execError.stdout ? execError.stdout.toString() : '';
                this.error(`Python script failed with code ${execError.status}`);
                this.error(`Stderr: ${stderr}`);
                this.error(`Stdout: ${stdout}`);

                // Try to parse stdout if it contains JSON
                if (stdout) {
                    try {
                        const result = JSON.parse(stdout);
                        if (!result.filePath) result.filePath = request.filePath;
                        if (!result.fileName) result.fileName = path.basename(request.filePath);
                        if (!result.fileSizeMB) result.fileSizeMB = Math.round((stats.size / (1024 * 1024)) * 100) / 100;
                        return result;
                    } catch {}
                }

                throw new Error(`Python error: ${stderr || execError.message}`);
            }

            // Parse the result
            const result = JSON.parse(output);

            // Add file info if not present
            if (!result.filePath) {
                result.filePath = request.filePath;
            }
            if (!result.fileName) {
                result.fileName = path.basename(request.filePath);
            }
            if (!result.fileSizeMB) {
                result.fileSizeMB = Math.round((stats.size / (1024 * 1024)) * 100) / 100;
            }

            this.log(`Successfully read statepoint: ${result.fileName}`);
            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.error(`Failed to read statepoint: ${msg}`);

            const path = await import('path');
            const fs = await import('fs');

            let fileSizeMB = 0;
            try {
                const stats = fs.statSync(request.filePath);
                fileSizeMB = Math.round((stats.size / (1024 * 1024)) * 100) / 100;
            } catch {}

            return {
                success: false,
                filePath: request.filePath,
                fileName: path.basename(request.filePath),
                fileSizeMB,
                error: `Failed to read statepoint: ${msg}`
            };
        }
    }

    /**
     * Compare multiple statepoint files.
     * @param request - Comparison request with file paths
     * @returns Comparison statistics and results
     */
    async compareStatepoints(request: {
        filePaths: string[];
    }): Promise<import('../common/openmc-studio-protocol').CompareStatepointsResult> {
        this.log(`Comparing ${request.filePaths.length} statepoint files`);

        try {
            const fs = await import('fs');
            const { execSync } = await import('child_process');

            // Check if files exist
            for (const filePath of request.filePaths) {
                if (!fs.existsSync(filePath)) {
                    return {
                        success: false,
                        statepoints: [],
                        errors: [{ file: filePath, error: `File not found: ${filePath}` }]
                    };
                }
            }

            // Find the statepoint reader script
            const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'statepoint_reader.py' });

            if (!scriptPath) {
                return {
                    success: false,
                    statepoints: [],
                    errors: request.filePaths.map((fp) => ({ file: fp, error: 'Statepoint reader script not found' }))
                };
            }

            // Get Python command
            const pythonInfo = (await this.runnerService['detectPythonCommand']?.()) || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';

            // Build file arguments
            const fileArgs = request.filePaths.map((fp) => `"${fp}"`).join(' ');

            // Execute the Python script with compare flag and stats
            const output = execSync(`"${pythonCommand}" "${scriptPath}" ${fileArgs} --compare --stats --json`, {
                encoding: 'utf-8',
                timeout: 120000,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            // Parse the result
            const result = JSON.parse(output);

            this.log(`Successfully compared ${result.statepoints?.length || 0} statepoints`);
            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.error(`Failed to compare statepoints: ${msg}`);

            return {
                success: false,
                statepoints: [],
                errors: request.filePaths.map((fp) => ({ file: fp, error: msg }))
            };
        }
    }

    /**
     * Read depletion results file.
     * @param request - Read request with file path
     * @returns Depletion analysis data
     */
    async readDepletionResults(request: { filePath: string }): Promise<import('../common/openmc-studio-protocol').DepletionResults> {
        this.log(`Reading depletion results: ${request.filePath}`);

        try {
            const fs = await import('fs');
            const path = await import('path');
            const { execSync } = await import('child_process');

            if (!fs.existsSync(request.filePath)) {
                return {
                    success: false,
                    filePath: request.filePath,
                    fileName: path.basename(request.filePath),
                    fileSizeMB: 0,
                    materials: {},
                    numberOfMaterials: 0,
                    error: `File not found: ${request.filePath}`
                };
            }

            const stats = fs.statSync(request.filePath);

            // Find script
            const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'statepoint_reader.py' });
            if (!scriptPath) {
                throw new Error('Statepoint reader script not found');
            }

            const pythonInfo = (await this.runnerService['detectPythonCommand']?.()) || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';

            const output = execSync(`"${pythonCommand}" "${scriptPath}" --depletion "${request.filePath}" --json`, {
                encoding: 'utf-8',
                timeout: 60000,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            const result = JSON.parse(output);

            if (!result.filePath) result.filePath = request.filePath;
            if (!result.fileName) result.fileName = path.basename(request.filePath);
            if (!result.fileSizeMB) result.fileSizeMB = Math.round((stats.size / (1024 * 1024)) * 100) / 100;

            return result;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.error(`Failed to read depletion results: ${msg}`);

            const path = await import('path');

            return {
                success: false,
                filePath: request.filePath,
                fileName: path.basename(request.filePath),
                fileSizeMB: 0,
                materials: {},
                numberOfMaterials: 0,
                error: `Failed to read depletion results: ${msg}`
            };
        }
    }

    /**
     * Analyze k-effective convergence from statepoint.
     * @param request - Analysis request with file path
     * @returns Convergence statistics and recommendations
     */
    async analyzeConvergence(request: { filePath: string }): Promise<import('../common/openmc-studio-protocol').KeffConvergenceAnalysis> {
        this.log(`Analyzing k-effective convergence: ${request.filePath}`);

        try {
            const fs = await import('fs');
            const { execSync } = await import('child_process');

            if (!fs.existsSync(request.filePath)) {
                return {
                    success: false,
                    error: `File not found: ${request.filePath}`,
                    runningAverage: [],
                    finalValue: 0
                };
            }

            // Find script
            const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'statepoint_reader.py' });
            if (!scriptPath) {
                throw new Error('Statepoint reader script not found');
            }

            const pythonInfo = (await this.runnerService['detectPythonCommand']?.()) || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';

            const output = execSync(`"${pythonCommand}" "${scriptPath}" --convergence "${request.filePath}" --json`, {
                encoding: 'utf-8',
                timeout: 60000,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            return JSON.parse(output);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.error(`Failed to analyze convergence: ${msg}`);

            return {
                success: false,
                error: `Failed to analyze convergence: ${msg}`,
                runningAverage: [],
                finalValue: 0
            };
        }
    }

    // ============================================================================
    // Optimization Framework Methods
    // ============================================================================

    /**
     * Start an optimization run with parameter sweeps.
     * @param request - Optimization request with sweeps and base state
     * @returns Start result with total iterations
     */
    async startOptimization(
        request: import('../common/openmc-studio-protocol').StartOptimizationRequest
    ): Promise<import('../common/openmc-studio-protocol').StartOptimizationResult> {
        this.log(`Starting optimization run: ${request.runId}`);
        return this.optimizationService.startOptimization(request);
    }

    /**
     * Stop/cancel a running optimization.
     * @param request - Stop request with run ID
     * @returns Stop result
     */
    async stopOptimization(
        request: import('../common/openmc-studio-protocol').StopOptimizationRequest
    ): Promise<import('../common/openmc-studio-protocol').StopOptimizationResult> {
        this.log(`Stopping optimization run: ${request.runId}`);
        return this.optimizationService.stopOptimization(request);
    }

    /**
     * Get status of an optimization run.
     * @param runId - Optimization run ID
     * @returns Current status and iteration counts
     */
    async getOptimizationStatus(runId: string): Promise<{
        running: boolean;
        currentIteration: number;
        totalIterations: number;
        status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    }> {
        return this.optimizationService.getOptimizationStatus(runId);
    }

    /**
     * Get iteration logs index for an optimization run.
     * @param runId - Optimization run ID
     * @returns Index of available iteration logs
     */
    async getIterationLogsIndex(runId: string): Promise<{
        iterations: { iteration: number; hasLog: boolean; timestamp: string }[];
        outputDirectory: string;
    }> {
        return this.optimizationService.getIterationLogsIndex(runId);
    }

    /**
     * Get log content for a specific iteration.
     * @param runId - Optimization run ID
     * @param iteration - Iteration number
     * @returns Log content
     */
    async getIterationLog(
        runId: string,
        iteration: number
    ): Promise<{
        success: boolean;
        logContent?: string;
        error?: string;
    }> {
        return this.optimizationService.getIterationLog(runId, iteration);
    }

    /**
     * Run a criticality (k-eff) search.
     * @param request - Search configuration
     * @returns Search result with per-iteration history
     */
    async runKeffSearch(
        request: import('../common/openmc-studio-protocol').StartKeffSearchRequest
    ): Promise<import('../common/openmc-studio-protocol').KeffSearchResult> {
        return this.optimizationService.runKeffSearch(request);
    }

    /**
     * Cancel a running k-eff search.
     * @param runId - The search run ID
     * @returns Whether a running search was found and killed
     */
    async cancelKeffSearch(runId: string): Promise<{ success: boolean; error?: string }> {
        return this.optimizationService.cancelKeffSearch(runId);
    }
}
