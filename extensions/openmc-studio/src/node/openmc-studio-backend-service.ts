// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
import { BackendApplicationContribution } from '@theia/core/lib/node';

import {
    OpenMCStudioBackendService,
    OpenMCStudioClient,
    XMLGenerationRequest,
    XMLGenerationResult,
    XMLImportRequest,
    XMLImportResult,
    XMLValidationResult,
    SimulationRunRequest,
    SimulationRunResult,
    SimulationLogResult,
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
    OPENMC_STATE_SCHEMA_VERSION
} from '../common/openmc-studio-protocol';

import { OpenMCState, OpenMCProjectFile } from '../common/openmc-state-schema';
import { OpenMCRunnerService } from './openmc-runner-service';
import { XMLGenerationService } from './xml-generation-service';
import { OpenMCCADImportService } from './cad-import-service';
import { DAGMCEditorService } from './dagmc-editor-service';
import { OptimizationBackendService } from './optimization-backend-service';

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
@injectable()
export class OpenMCStudioBackendServiceImpl
    implements OpenMCStudioBackendService, BackendApplicationContribution {

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
        return this.xmlService.generateXML(request);
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
            if (fs.existsSync(materialsPath)) {
                try {
                    const materialsData = await this.parseMaterialsXML(materialsPath);
                    state.materials = materialsData.materials;
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
            if (fs.existsSync(settingsPath)) {
                try {
                    const settingsData = await this.parseSettingsXML(settingsPath);
                    state.settings = settingsData.settings;
                    warnings.push(...settingsData.warnings);
                    this.log(`Imported settings`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to parse settings.xml: ${msg}`);
                }
            } else {
                warnings.push('settings.xml not found');
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
                universes: [{
                    id: 0,
                    name: 'root',
                    cellIds: [],
                    isRoot: true
                }],
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
    
    private async parseMaterialsXML(filePath: string): Promise<{ materials: any[]; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');
        
        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(xml);
        
        const materials: any[] = [];
        
        if (!result.materials || !result.materials.material) {
            warnings.push('No materials found in materials.xml');
            return { materials, warnings };
        }
        
        const materialArray = Array.isArray(result.materials.material) 
            ? result.materials.material 
            : [result.materials.material];
        
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
                
                // Parse nuclides
                if (mat.nuclide) {
                    const nuclides = Array.isArray(mat.nuclide) ? mat.nuclide : [mat.nuclide];
                    for (const nuc of nuclides) {
                        material.nuclides.push({
                            name: nuc.$.name,
                            fraction: parseFloat(nuc.$.ao || nuc.$.wo || '1.0'),
                            fractionType: nuc.$.ao ? 'ao' : 'wo'
                        });
                    }
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
                
                // Parse temperature
                if (mat.$.temperature) {
                    material.temperature = parseFloat(mat.$.temperature);
                }
                
                materials.push(material);
            } catch (err) {
                warnings.push(`Failed to parse material ${mat.$.id}: ${err}`);
            }
        }
        
        return { materials, warnings };
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
            universes: [{
                id: 0,
                name: 'root',
                cellIds: [] as number[],
                isRoot: true
            }],
            lattices: [] as any[],
            rootUniverseId: 0
        };
        
        if (!result.geometry) {
            warnings.push('No geometry element found in geometry.xml');
            return { geometry, warnings };
        }
        
        // Parse surfaces
        if (result.geometry.surface) {
            const surfaces = Array.isArray(result.geometry.surface) 
                ? result.geometry.surface 
                : [result.geometry.surface];
            
            for (const surf of surfaces) {
                try {
                    const surface: any = {
                        id: parseInt(surf.$.id),
                        type: surf.$.type,
                        coefficients: this.parseCoeffs(surf.$.type, surf.$.coeffs),
                        boundary: surf.$.boundary || 'transmission'
                    };
                    if (surf.$.name) surface.name = surf.$.name;
                    geometry.surfaces.push(surface);
                } catch (err) {
                    warnings.push(`Failed to parse surface ${surf.$.id}: ${err}`);
                }
            }
        }
        
        // Parse cells
        if (result.geometry.cell) {
            const cells = Array.isArray(result.geometry.cell) 
                ? result.geometry.cell 
                : [result.geometry.cell];
            
            for (const cell of cells) {
                try {
                    const cellObj: any = {
                        id: parseInt(cell.$.id),
                        fillType: 'void'
                    };
                    if (cell.$.name) cellObj.name = cell.$.name;
                    if (cell.$.temperature) cellObj.temperature = parseFloat(cell.$.temperature);
                    
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
                            cellObj.fillType = 'material';
                            cellObj.fillId = parseInt(materialAttr);
                        }
                    } else if (fillAttr !== undefined) {
                        // New format: fill as attribute (universe)
                        cellObj.fillType = 'universe';
                        cellObj.fillId = parseInt(fillAttr);
                    } else if (materialElem) {
                        // Old format: material as child element
                        if (materialElem === '' || materialElem === 'void') {
                            cellObj.fillType = 'void';
                        } else {
                            cellObj.fillType = 'material';
                            cellObj.fillId = parseInt(materialElem);
                        }
                    } else if (fillElem) {
                        // Old format: fill as child element (universe)
                        cellObj.fillType = 'universe';
                        cellObj.fillId = parseInt(fillElem);
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
                    let universe = geometry.universes.find((u: any) => u.id === universeId);
                    if (!universe) {
                        universe = {
                            id: universeId,
                            name: `Universe ${universeId}`,
                            cellIds: [],
                            isRoot: universeId === 0
                        };
                        geometry.universes.push(universe);
                    }
                    
                    // Add cell to its universe
                    if (!universe.cellIds.includes(cellObj.id)) {
                        universe.cellIds.push(cellObj.id);
                    }
                } catch (err) {
                    warnings.push(`Failed to parse cell ${cell.$.id}: ${err}`);
                }
            }
        }
        
        return { geometry, warnings };
    }
    
    private parseCoeffs(surfaceType: string, coeffsStr: string): any {
        const values = coeffsStr.split(/\s+/).map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
        
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
    
    private async parseSettingsXML(filePath: string): Promise<{ settings: any; warnings: string[] }> {
        const fs = await import('fs');
        const xml2js = await import('xml2js');
        
        const warnings: string[] = [];
        const xml = fs.readFileSync(filePath, 'utf-8');
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
            return { settings, warnings };
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
        
        // Source
        if (s.source) {
            const sources = Array.isArray(s.source) ? s.source : [s.source];
            
            for (const src of sources) {
                const source: any = {
                    spatial: { type: 'point', origin: [0, 0, 0] },
                    energy: { type: 'discrete', energies: [1e6] }
                };
                
                // Parse spatial distribution
                if (src.space) {
                    const spaceType = src.space.$.type || 'point';
                    source.spatial.type = spaceType;
                    
                    // Parse parameters
                    if (src.space.parameters) {
                        const params = src.space.parameters.toString().trim().split(/\s+/).map(Number);
                        
                        if ((spaceType === 'box' || spaceType === 'cartesian') && params.length >= 6) {
                            source.spatial.lowerLeft = params.slice(0, 3);
                            source.spatial.upperRight = params.slice(3, 6);
                        } else if (spaceType === 'point' && params.length >= 3) {
                            source.spatial.origin = params.slice(0, 3);
                        } else if ((spaceType === 'sphere' || spaceType === 'spherical') && params.length >= 4) {
                            source.spatial.center = params.slice(0, 3);
                            source.spatial.radius = params[3];
                        }
                    }
                }
                
                // Parse energy distribution
                if (src.energy) {
                    const energyType = src.energy.$.type || 'discrete';
                    source.energy.type = energyType;
                    
                    if (src.energy.parameters) {
                        const params = src.energy.parameters.toString().trim().split(/\s+/).map(Number);
                        
                        if (energyType === 'discrete') {
                            source.energy.energies = params;
                        } else if (energyType === 'uniform' && params.length >= 2) {
                            source.energy.min = params[0];
                            source.energy.max = params[1];
                        } else if (energyType === 'maxwell' && params.length >= 1) {
                            source.energy.temperature = params[0];
                        } else if (energyType === 'watt' && params.length >= 2) {
                            source.energy.a = params[0];
                            source.energy.b = params[1];
                        }
                    }
                }
                
                // Parse angle distribution
                if (src.angle) {
                    source.angle = {
                        type: src.angle.$.type || 'isotropic'
                    };
                }
                
                settings.sources.push(source);
            }
        }
        
        return { settings, warnings };
    }

    /**
     * Validate OpenMC XML files without importing.
     * @param directory - Directory containing XML files
     * @returns Validation result
     */
    async validateXML(directory: string): Promise<XMLValidationResult> {
        this.log(`Validating XML in ${directory}`);
        // TODO: Implement XML validation in Phase 1
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

    // ============================================================================
    // Validation
    // ============================================================================

    /**
     * Validate simulation state for geometry, materials, settings, and tallies.
     * @param request - Validation request with state and level
     * @returns Validation result with issues and summary
     */
    async validateState(request: ValidationRequest): Promise<ValidationResult> {
        this.log('Validating simulation state');
        
        const issues: ValidationResult['issues'] = [];
        const { geometry, materials, settings } = request.state;
        
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
        
        // For DAGMC: check that OpenMC materials match DAGMC material names
        if (settings.dagmcFile && dagmcMaterials) {
            const dagmcMaterialNames = Object.keys(dagmcMaterials);
            
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
                const openMCMaterialNames = new Set(materials.map(m => m.name.toLowerCase()));
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
            const surfaceIds = new Set(geometry.surfaces.map(s => s.id));
            
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
        
        // For DAGMC: validate source is within geometry bounds
        if (settings.dagmcFile && settings.dagmcInfo?.boundingBox && settings.sources.length > 0) {
            const geomBounds = settings.dagmcInfo.boundingBox;
            for (const source of settings.sources) {
                const spatial = source.spatial as any;
                if (spatial.type === 'box' && spatial.lowerLeft && spatial.upperRight) {
                    // Check if source box extends beyond geometry bounds
                    const sourceExtendsBeyond = 
                        spatial.lowerLeft[0] < geomBounds.min[0] ||
                        spatial.lowerLeft[1] < geomBounds.min[1] ||
                        spatial.lowerLeft[2] < geomBounds.min[2] ||
                        spatial.upperRight[0] > geomBounds.max[0] ||
                        spatial.upperRight[1] > geomBounds.max[1] ||
                        spatial.upperRight[2] > geomBounds.max[2];
                    
                    if (sourceExtendsBeyond) {
                        issues.push({
                            severity: 'warning',
                            category: 'settings',
                            message: `Source extends beyond DAGMC geometry bounds`,
                            suggestion: `Source box [${spatial.lowerLeft.join(',')}] to [${spatial.upperRight.join(',')}] ` +
                                      `extends beyond geometry [${geomBounds.min.join(',')}] to [${geomBounds.max.join(',')}]. ` +
                                      `Particles born outside volumes will be lost. Use "Snap to Geometry" to fix.`
                        });
                    }
                }
            }
        }
        
        // Check for fissile material in eigenvalue mode (skip for DAGMC - materials are in the file)
        if (settings.run.mode === 'eigenvalue' && !settings.dagmcFile) {
            const fissileNuclides = ['U233', 'U235', 'Pu238', 'Pu239', 'Pu240', 'Pu241', 'Pu242', 
                                     'Am241', 'Am242', 'Am243', 'Cm242', 'Cm243', 'Cm244', 'Cm245', 'Cm246'];
            
            let hasFissileMaterial = false;
            for (const material of materials) {
                for (const nuclide of material.nuclides) {
                    if (fissileNuclides.some(fn => nuclide.name.includes(fn))) {
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
                    suggestion: 'Add a fissile nuclide like U235 or Pu239 to a material. Eigenvalue calculations require fission chain reactions.'
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
            
            // Check for depletable materials
            const hasDepletableMaterials = materials.some(m => m.isDepletable);
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
        }
        
        return {
            valid: issues.filter(i => i.severity === 'error').length === 0,
            issues,
            summary: {
                errors: issues.filter(i => i.severity === 'error').length,
                warnings: issues.filter(i => i.severity === 'warning').length,
                info: issues.filter(i => i.severity === 'info').length
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
        // TODO: Implement overlap checking in Phase 2
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
        // TODO: Implement region validation in Phase 2
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
                    universes: [{
                        id: 0,
                        name: 'root',
                        cellIds: [],
                        isRoot: true
                    }],
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
            const content = fs.readFileSync(projectPath, 'utf-8');
            const project: OpenMCProjectFile = JSON.parse(content);
            
            return {
                success: true,
                project
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
            
            const projectFile: OpenMCProjectFile = {
                version: OPENMC_STATE_SCHEMA_VERSION,
                state: request.state
            };
            
            fs.writeFileSync(request.projectPath, JSON.stringify(projectFile, null, 2));
            
            // Also generate XML if requested
            if (request.generateXml) {
                const path = await import('path');
                const outputDir = path.dirname(request.projectPath);
                await this.xmlService.generateXML({
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
                });
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
        const ids = state.materials.map(m => m.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available cell ID.
     * @param state - Current simulation state
     * @returns Suggested cell ID
     */
    async suggestCellId(state: OpenMCState): Promise<number> {
        const ids = state.geometry.cells.map(c => c.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available surface ID.
     * @param state - Current simulation state
     * @returns Suggested surface ID
     */
    async suggestSurfaceId(state: OpenMCState): Promise<number> {
        const ids = state.geometry.surfaces.map(s => s.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available tally ID.
     * @param state - Current simulation state
     * @returns Suggested tally ID
     */
    async suggestTallyId(state: OpenMCState): Promise<number> {
        const ids = state.tallies.map(t => t.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    /**
     * Suggest the next available mesh ID.
     * @param state - Current simulation state
     * @returns Suggested mesh ID
     */
    async suggestMeshId(state: OpenMCState): Promise<number> {
        const ids = state.meshes.map(m => m.id);
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
    async importCAD(request: import('../common/openmc-studio-protocol').CADImportRequest): Promise<import('../common/openmc-studio-protocol').CADImportResult> {
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
    async dagmcAssignMaterial(filePath: string, volumeId: number, materialName: string): Promise<{
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
    async dagmcCreateGroup(filePath: string, groupName: string, volumeIds?: number[]): Promise<{
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
    async dagmcDeleteGroup(filePath: string, groupName: string): Promise<{
        success: boolean;
        message?: string;
        error?: string;
    }> {
        this.log(`Deleting group "${groupName}" from ${filePath}`);
        return this.dagmcEditorService.deleteGroup(filePath, groupName);
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
    async exportWWINP(request: {
        filePath: string;
        weightWindows: any;
        meshes: any[]
    }): Promise<{
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
            const extensionPath = await this.getExtensionPath();
            let scriptPath = path.resolve(extensionPath, 'python/statepoint_reader.py');
            
            if (!fs.existsSync(scriptPath)) {
                // Fallback paths
                const fallbackPaths = [
                    path.resolve(__dirname, '../../../../extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(process.cwd(), 'extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(__dirname, '../../python/statepoint_reader.py'),
                ];
                
                for (const fp of fallbackPaths) {
                    if (fs.existsSync(fp)) {
                        scriptPath = fp;
                        break;
                    }
                }
            }
            
            if (!fs.existsSync(scriptPath)) {
                return {
                    success: false,
                    filePath: request.filePath,
                    fileName: path.basename(request.filePath),
                    fileSizeMB: Math.round(stats.size / (1024 * 1024) * 100) / 100,
                    error: 'Statepoint reader script not found'
                };
            }
            
            this.log(`Using script: ${scriptPath}`);
            
            // Get Python command from runner service
            const pythonInfo = await this.runnerService['detectPythonCommand']?.() 
                || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';
            
            this.log(`Using Python: ${pythonCommand}`);
            
            // Execute the Python script - capture both stdout and stderr
            let output: string;
            try {
                output = execSync(
                    `"${pythonCommand}" "${scriptPath}" "${request.filePath}" --json`,
                    { encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }
                );
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
                        if (!result.fileSizeMB) result.fileSizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;
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
                result.fileSizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;
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
                fileSizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;
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
    async compareStatepoints(request: { filePaths: string[] }): Promise<import('../common/openmc-studio-protocol').CompareStatepointsResult> {
        this.log(`Comparing ${request.filePaths.length} statepoint files`);
        
        try {
            const fs = await import('fs');
            const path = await import('path');
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
            const extensionPath = await this.getExtensionPath();
            let scriptPath = path.resolve(extensionPath, 'python/statepoint_reader.py');
            
            if (!fs.existsSync(scriptPath)) {
                // Fallback paths
                const fallbackPaths = [
                    path.resolve(__dirname, '../../../../extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(process.cwd(), 'extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(__dirname, '../../python/statepoint_reader.py'),
                ];
                
                for (const fp of fallbackPaths) {
                    if (fs.existsSync(fp)) {
                        scriptPath = fp;
                        break;
                    }
                }
            }
            
            if (!fs.existsSync(scriptPath)) {
                return {
                    success: false,
                    statepoints: [],
                    errors: request.filePaths.map(fp => ({ file: fp, error: 'Statepoint reader script not found' }))
                };
            }
            
            // Get Python command
            const pythonInfo = await this.runnerService['detectPythonCommand']?.() 
                || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';
            
            // Build file arguments
            const fileArgs = request.filePaths.map(fp => `"${fp}"`).join(' ');
            
            // Execute the Python script with compare flag and stats
            const output = execSync(
                `"${pythonCommand}" "${scriptPath}" ${fileArgs} --compare --stats --json`,
                { encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            
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
                errors: request.filePaths.map(fp => ({ file: fp, error: msg }))
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
            const extensionPath = await this.getExtensionPath();
            let scriptPath = path.resolve(extensionPath, 'python/statepoint_reader.py');
            
            if (!fs.existsSync(scriptPath)) {
                const fallbackPaths = [
                    path.resolve(__dirname, '../../../../extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(process.cwd(), 'extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(__dirname, '../../python/statepoint_reader.py'),
                ];
                
                for (const fp of fallbackPaths) {
                    if (fs.existsSync(fp)) {
                        scriptPath = fp;
                        break;
                    }
                }
            }
            
            const pythonInfo = await this.runnerService['detectPythonCommand']?.() 
                || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';
            
            const output = execSync(
                `"${pythonCommand}" "${scriptPath}" --depletion "${request.filePath}" --json`,
                { encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            
            const result = JSON.parse(output);
            
            if (!result.filePath) result.filePath = request.filePath;
            if (!result.fileName) result.fileName = path.basename(request.filePath);
            if (!result.fileSizeMB) result.fileSizeMB = Math.round(stats.size / (1024 * 1024) * 100) / 100;
            
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
            const path = await import('path');
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
            const extensionPath = await this.getExtensionPath();
            let scriptPath = path.resolve(extensionPath, 'python/statepoint_reader.py');
            
            if (!fs.existsSync(scriptPath)) {
                const fallbackPaths = [
                    path.resolve(__dirname, '../../../../extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(process.cwd(), 'extensions/openmc-studio/python/statepoint_reader.py'),
                    path.resolve(__dirname, '../../python/statepoint_reader.py'),
                ];
                
                for (const fp of fallbackPaths) {
                    if (fs.existsSync(fp)) {
                        scriptPath = fp;
                        break;
                    }
                }
            }
            
            const pythonInfo = await this.runnerService['detectPythonCommand']?.() 
                || { command: 'python' };
            const pythonCommand = pythonInfo.command || 'python';
            
            const output = execSync(
                `"${pythonCommand}" "${scriptPath}" --convergence "${request.filePath}" --json`,
                { encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            
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

    /**
     * Get the extension root path.
     */
    private async getExtensionPath(): Promise<string> {
        const path = await import('path');
        try {
            return path.dirname(require.resolve('openmc-studio/package.json'));
        } catch (e) {
            return path.resolve(__dirname, '../..');
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
    async startOptimization(request: import('../common/openmc-studio-protocol').StartOptimizationRequest):
        Promise<import('../common/openmc-studio-protocol').StartOptimizationResult> {
        this.log(`Starting optimization run: ${request.runId}`);
        return this.optimizationService.startOptimization(request);
    }

    /**
     * Stop/cancel a running optimization.
     * @param request - Stop request with run ID
     * @returns Stop result
     */
    async stopOptimization(request: import('../common/openmc-studio-protocol').StopOptimizationRequest):
        Promise<import('../common/openmc-studio-protocol').StopOptimizationResult> {
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
    async getIterationLog(runId: string, iteration: number): Promise<{
        success: boolean;
        logContent?: string;
        error?: string;
    }> {
        return this.optimizationService.getIterationLog(runId, iteration);
    }

}
