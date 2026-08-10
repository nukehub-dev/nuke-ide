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
 * XML Generation Service
 *
 * Backend service for generating OpenMC XML files from the simulation state.
 *
 * @module openmc-studio/node
 */

import { injectable } from '@theia/core/shared/inversify';
import * as path from 'path';
import * as fs from 'fs';

import { XMLGenerationRequest, XMLGenerationResult, OpenMCCompat, DEFAULT_OPENMC_COMPAT } from '../common/openmc-studio-protocol';
import { resolveMgxsLibrary } from '../common/mgxs-library';
import { resolveDepletionSolver } from '../common/depletion-solvers';
import { expandMaterialNuclides } from '../common/material-utils';

import {
    OpenMCState,
    OpenMCSurface,
    OpenMCCell,
    OpenMCMaterial,
    OpenMCTally,
    OpenMCMesh,
    OpenMCRegularMesh,
    OpenMCCylindricalMesh,
    OpenMCSphericalMesh,
    OpenMCLattice,
    OpenMCEigenvalueSettings,
    OpenMCFixedSourceSettings
} from '../common/openmc-state-schema';

import { getAutoIfpTallies } from '../common/kinetics-ifp';

import { OpenMCStudioClient } from '../common/openmc-studio-protocol';

/**
 * XML Generation Service
 *
 * Backend service for generating OpenMC XML input files (geometry.xml, materials.xml,
 * settings.xml, tallies.xml, plots.xml) from the simulation state.
 *
 * @module openmc-studio/node
 * @see {@link OpenMCStudioBackendService.generateXML}
 */
@injectable()
export class XMLGenerationService {
    /**
     * Set the client for log messages.
     * Note: Currently unused - client notifications disabled to prevent disconnect errors.
     * @param _client - Frontend client interface
     */
    setClient(_client: OpenMCStudioClient): void {
        // Client logging disabled - see log() method
    }

    /**
     * Log a message to the console (client logging disabled to prevent disconnect errors).
     */
    protected log(message: string): void {
        console.log(`[XML Generation] ${message}`);
    }

    // ============================================================================
    // XML Generation
    // ============================================================================

    /**
     * Generate OpenMC XML files from simulation state.
     * @param request - Generation request with state, output directory, and file flags
     * @returns Generation result with file paths and any warnings
     */
    async generateXML(request: XMLGenerationRequest): Promise<XMLGenerationResult> {
        const generatedFiles: string[] = [];
        const warnings: string[] = [];

        try {
            const fs = await import('fs');
            const path = await import('path');

            // Create output directory if it doesn't exist
            if (!fs.existsSync(request.outputDirectory)) {
                fs.mkdirSync(request.outputDirectory, { recursive: true });
            }

            // OpenMC writes summary/statepoint/tallies files under settings.output.path
            // but does not create the directory itself, so pre-create it here.
            if (request.state.settings.output?.path) {
                const outputSubdir = path.isAbsolute(request.state.settings.output.path)
                    ? request.state.settings.output.path
                    : path.join(request.outputDirectory, request.state.settings.output.path);
                if (!fs.existsSync(outputSubdir)) {
                    fs.mkdirSync(outputSubdir, { recursive: true });
                }
            }

            // Load available neutron nuclides from the data library so element
            // expansion only emits isotopes that OpenMC can actually resolve.
            // Fall back to the environment variable in case the frontend did not
            // pass an explicit path.
            const crossSectionsPath = request.crossSectionsPath || process.env.OPENMC_CROSS_SECTIONS;
            const availableNuclides = crossSectionsPath ? this.loadAvailableNuclides(crossSectionsPath) : undefined;

            // Generate materials.xml
            if (request.files.materials) {
                const materialsPath = path.join(request.outputDirectory, 'materials.xml');
                const materialsXml = this.generateMaterialsXML(request.state, request.outputDirectory, availableNuclides);
                fs.writeFileSync(materialsPath, materialsXml);
                generatedFiles.push(materialsPath);
                this.log(`Generated materials.xml`);
            }

            // Resolve DAGMC source path and decide whether to copy or reference relatively.
            let dagmcFilename = 'geometry.h5m';
            let dagmcSource: string | undefined;
            if (request.state.settings.dagmcFile) {
                dagmcSource = this.resolveDagmcSourcePath(request.state, request.outputDirectory);
                if (dagmcSource && request.state.settings.copyDagmcToRunDirectory !== true) {
                    const relativeDagmc = path.relative(request.outputDirectory, dagmcSource).replace(/\\/g, '/');
                    if (relativeDagmc && !path.isAbsolute(relativeDagmc)) {
                        dagmcFilename = relativeDagmc;
                    } else {
                        this.log(`Warning: Could not compute relative DAGMC path; copying file instead`);
                    }
                } else if (request.state.settings.copyDagmcToRunDirectory === true) {
                    this.log(`Copying DAGMC file because copyDagmcToRunDirectory is enabled`);
                }
            }

            // Generate geometry.xml (empty for DAGMC - geometry is in the .h5m file)
            if (request.files.geometry) {
                const geometryPath = path.join(request.outputDirectory, 'geometry.xml');
                if (request.state.settings.dagmcFile) {
                    // DAGMC mode: generate geometry.xml with dagmc_universe reference
                    const dagmcGeometryXml = this.generateDAGMCGeometryXML(request.state, dagmcFilename);
                    fs.writeFileSync(geometryPath, dagmcGeometryXml);
                    generatedFiles.push(geometryPath);
                    this.log(`Generated geometry.xml with DAGMC reference to ${dagmcFilename}`);
                } else {
                    // CSG mode: generate full geometry.xml
                    const geometryXml = this.generateGeometryXML(request.state);
                    fs.writeFileSync(geometryPath, geometryXml);
                    generatedFiles.push(geometryPath);
                    this.log(`Generated geometry.xml`);
                }
            }

            // Generate settings.xml
            if (request.files.settings) {
                const settingsPath = path.join(request.outputDirectory, 'settings.xml');
                const settingsXml = this.generateSettingsXML(request.state, request.randomRayCompat, warnings);
                fs.writeFileSync(settingsPath, settingsXml);
                generatedFiles.push(settingsPath);
                this.log(`Generated settings.xml`);
            }

            // Copy DAGMC file to output directory when requested or when a relative reference is not possible.
            if (request.state.settings.dagmcFile) {
                if (dagmcSource && dagmcFilename === 'geometry.h5m') {
                    const dagmcDest = path.join(request.outputDirectory, 'geometry.h5m');
                    try {
                        fs.copyFileSync(dagmcSource, dagmcDest);
                        generatedFiles.push(dagmcDest);
                        this.log(`Copied DAGMC file from ${dagmcSource} to geometry.h5m`);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        this.log(`Warning: Failed to copy DAGMC file: ${msg}`);
                    }
                } else if (!dagmcSource) {
                    this.log(`Warning: Could not locate DAGMC file ${request.state.settings.dagmcFile}`);
                }
            }

            // Generate tallies.xml (also when only auto-generated IFP kinetics tallies would be present)
            if (request.files.tallies && (request.state.tallies.length > 0 || request.state.settings.kinetics?.enabled)) {
                const talliesPath = path.join(request.outputDirectory, 'tallies.xml');
                const talliesXml = this.generateTalliesXML(request.state, warnings);
                fs.writeFileSync(talliesPath, talliesXml);
                generatedFiles.push(talliesPath);
                this.log(`Generated tallies.xml`);
            }

            // Generate plots.xml
            if (request.files.plots && request.state.plots && request.state.plots.length > 0) {
                const plotsPath = path.join(request.outputDirectory, 'plots.xml');
                const plotsXml = this.generatePlotsXML(request.state);
                fs.writeFileSync(plotsPath, plotsXml);
                generatedFiles.push(plotsPath);
                this.log(`Generated plots.xml`);
            }

            return {
                success: true,
                generatedFiles,
                warnings: warnings.length > 0 ? warnings : undefined
            };
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.log(`Error generating XML: ${msg}`);

            return {
                success: false,
                generatedFiles,
                error: msg,
                warnings: warnings.length > 0 ? warnings : undefined
            };
        }
    }

    // ============================================================================
    // Materials XML
    // ============================================================================

    /**
     * Generate materials.xml from state materials.
     * @param state - Simulation state
     * @returns materials.xml content
     */

    /**
     * Resolve the MGXS library FILE path for emission (fs-aware): a `.h5`
     * value is used as-is; an existing extension-less FILE is used as-is;
     * anything else is treated as a directory and resolved to the `mgxs.h5`
     * inside it. Canonical `settings.mgxsLibrary` wins over the legacy
     * `randomRay.mgxsLibraryPath` (see `resolveMgxsLibrary`).
     * @param settings - Simulation settings.
     * @returns Path to the `mgxs.h5` file, or undefined when unconfigured.
     */
    private resolveMgxsLibraryFile(settings: OpenMCState['settings']): string | undefined {
        const raw = resolveMgxsLibrary(settings);
        if (!raw) {
            return undefined;
        }
        if (raw.toLowerCase().endsWith('.h5')) {
            return raw;
        }
        try {
            if (fs.existsSync(raw) && !fs.statSync(raw).isDirectory()) {
                return raw;
            }
        } catch {
            // Stat failed — fall through to the directory assumption
        }
        return `${raw.replace(/[\\/]+$/, '')}/mgxs.h5`;
    }

    /**
     * Parse a cross_sections.xml file and return the set of available neutron
     * nuclide names. Falls back to an empty set if the file cannot be read.
     */
    private loadAvailableNuclides(crossSectionsPath: string): Set<string> | undefined {
        const fs = require('fs');
        try {
            const xml = fs.readFileSync(crossSectionsPath, 'utf-8');
            const available = new Set<string>();
            // Match <library materials="X" ... type="neutron" />
            const regex = /<library\s+[^>]*?materials="([^"]+)"[^>]*?type="neutron"[^>]*\/>/gi;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(xml)) !== null) {
                match[1].split(/\s+/).forEach((name) => {
                    if (name) {
                        available.add(name);
                    }
                });
            }
            if (available.size > 0) {
                this.log(`Loaded ${available.size} available neutron nuclides from ${crossSectionsPath}`);
                return available;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`Warning: Could not read cross-sections library ${crossSectionsPath}: ${msg}`);
        }
        return undefined;
    }

    private generateMaterialsXML(state: OpenMCState, outputDirectory?: string, availableNuclides?: Set<string>): string {
        const lines: string[] = ['<?xml version="1.0"?>', '<materials>', ''];

        // Multi-group cross sections library reference (openmc.Materials.cross_sections
        // — the settings.xml element is deprecated in favor of this one). First
        // child of <materials> per the verified export format.
        if (state.settings.energyMode === 'multigroup') {
            const mgxs = this.resolveMgxsLibraryFile(state.settings);
            if (mgxs) {
                const resolved = path.isAbsolute(mgxs) || !outputDirectory ? mgxs : path.resolve(outputDirectory, mgxs);
                lines.push(`  <cross_sections>${this.escapeXml(resolved)}</cross_sections>`);
                lines.push('');
            }
        }

        // Debug logging for DAGMC
        if (state.settings.dagmcFile) {
            this.log(`DAGMC mode detected. dagmcFile: ${state.settings.dagmcFile}`);
            this.log(`dagmcInfo present: ${!!state.settings.dagmcInfo}`);
            if (state.settings.dagmcInfo?.materials) {
                const matNames = Object.keys(state.settings.dagmcInfo.materials);
                this.log(`DAGMC materials found: ${matNames.join(', ')}`);
            } else {
                this.log('No DAGMC materials found in dagmcInfo');
            }
        }

        // Add user-defined materials
        for (const material of state.materials) {
            lines.push(this.generateMaterialElement(material, availableNuclides));
        }

        // For DAGMC mode: check for missing materials (user must create them)
        if (state.settings.dagmcInfo?.materials) {
            const dagmcMaterials = state.settings.dagmcInfo.materials;
            const existingMaterialNames = new Set(state.materials.map((m) => m.name.toLowerCase()));

            const missingMaterials: string[] = [];

            for (const dagmcMaterialName of Object.keys(dagmcMaterials)) {
                // "graveyard" is a DAGMC sentinel material; OpenMC kills particles
                // that enter it and does not require a matching <material> element.
                if (dagmcMaterialName.toLowerCase() === 'graveyard') {
                    continue;
                }
                if (!existingMaterialNames.has(dagmcMaterialName.toLowerCase())) {
                    missingMaterials.push(dagmcMaterialName);
                }
            }

            if (missingMaterials.length > 0) {
                this.log(
                    `WARNING: DAGMC materials not defined: ${missingMaterials.join(', ')}. ` +
                        `Create these materials in the Materials tab with appropriate nuclides.`
                );
            }
        }

        lines.push('</materials>');

        return lines.join('\n');
    }

    private generateMaterialElement(material: OpenMCMaterial, availableNuclides?: Set<string>): string {
        const lines: string[] = [];

        const depletableAttr = material.isDepletable ? ' depletable="true"' : '';
        const volumeAttr = material.volume ? ` volume="${material.volume}"` : '';
        const tempAttr = material.temperature ? ` temperature="${material.temperature}"` : '';

        lines.push(`  <material id="${material.id}" name="${this.escapeXml(material.name)}"${depletableAttr}${volumeAttr}${tempAttr}>`);
        lines.push(`    <density units="${material.densityUnit}" value="${material.density}"/>`);

        if (material.macroscopic) {
            // Macroscopic (multigroup) material: no nuclide decomposition (openmc/material.py:1823)
            lines.push(`    <macroscopic name="${this.escapeXml(material.macroscopic.name)}"/>`);
        } else {
            // Expand bare element symbols (Fe, Pb, W) to their natural isotopes.
            // The OpenMC binary XML reader no longer accepts the <element> tag,
            // so elements must be expanded before emission. When a cross-sections
            // library is known, only emit isotopes present in that library and
            // renormalize the remaining abundances.
            const expanded = expandMaterialNuclides(material.nuclides, availableNuclides);
            for (const nuclide of expanded) {
                lines.push(`    <nuclide ao="${nuclide.fraction}" name="${nuclide.name}"/>`);
            }

            // Add S(alpha,beta) if present
            for (const sab of material.thermalScattering) {
                lines.push(`    <sab name="${sab.name}"/>`);
            }
        }

        lines.push('  </material>');
        lines.push('');

        return lines.join('\n');
    }

    // ============================================================================
    // Geometry XML
    // ============================================================================

    /**
     * Generate geometry.xml from state geometry.
     * @param state - Simulation state
     * @returns geometry.xml content
     */

    private generateGeometryXML(state: OpenMCState): string {
        const lines: string[] = ['<?xml version="1.0"?>', '<geometry>', ''];

        // Add surfaces
        for (const surface of state.geometry.surfaces) {
            lines.push(this.generateSurfaceElement(surface));
        }

        // Add cells with their universe assignments
        for (const cell of state.geometry.cells) {
            // Find which universe this cell belongs to
            const universe = state.geometry.universes.find((u) => u.cellIds.includes(cell.id));
            lines.push(this.generateCellElement(cell, universe?.id ?? 0));
        }

        // Add lattices
        for (const lattice of state.geometry.lattices) {
            lines.push(this.generateLatticeElement(lattice));
        }

        lines.push('</geometry>');

        return lines.join('\n');
    }

    /**
     * Generate a geometry.xml for DAGMC mode.
     * Contains a dagmc_universe element referencing the DAGMC file,
     * with auto_geom_ids/auto_mat_ids attributes when enabled.
     * @param state - Simulation state (uses settings.dagmcInfo for the ID flags)
     * @param dagmcFilename - Filename to reference in the dagmc_universe element (default: geometry.h5m)
     */
    private generateDAGMCGeometryXML(state: OpenMCState, dagmcFilename = 'geometry.h5m'): string {
        const autoGeomAttr = state.settings.dagmcInfo?.autoGeomIds ? ' auto_geom_ids="true"' : '';
        const autoMatAttr = state.settings.dagmcInfo?.autoMatIds ? ' auto_mat_ids="true"' : '';
        return `<?xml version="1.0"?>
<geometry>
  <dagmc_universe filename="${dagmcFilename}" id="1"${autoGeomAttr}${autoMatAttr} />
</geometry>`;
    }

    /**
     * Locate the source DAGMC .h5m file. Tries, in order:
     * 1. The absolute path stored in dagmcInfo.filePath
     * 2. dagmcFile as an absolute path
     * 3. dagmcFile relative to the output directory's parent (typical when the
     *    output folder is a sub-directory of the project)
     * 4. dagmcFile relative to the output directory
     */
    private resolveDagmcSourcePath(state: OpenMCState, outputDirectory: string): string | undefined {
        const fs = require('fs');
        const path = require('path');
        const dagmcFile = state.settings.dagmcFile;
        if (!dagmcFile) {
            return undefined;
        }

        const candidates: string[] = [];
        if (state.settings.dagmcInfo?.filePath) {
            const infoPath = state.settings.dagmcInfo.filePath;
            if (path.isAbsolute(infoPath)) {
                candidates.push(infoPath);
            } else {
                // Project-relative path: try project dir first, then output dir.
                candidates.push(path.resolve(outputDirectory, '..', infoPath));
                candidates.push(path.resolve(outputDirectory, infoPath));
            }
        }
        candidates.push(dagmcFile);
        candidates.push(path.resolve(outputDirectory, '..', dagmcFile));
        candidates.push(path.resolve(outputDirectory, dagmcFile));

        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            } catch {
                // ignore
            }
        }

        return undefined;
    }

    private generateSurfaceElement(surface: OpenMCSurface): string {
        // Emit a boundary condition only when the model sets one. OpenMC
        // defaults to transmission when no boundary attribute is present;
        // stamping vacuum on every surface kills particles at interior
        // surfaces and silently breaks any multi-region model.
        const boundaryAttr = surface.boundary ? ` boundary="${surface.boundary}"` : '';
        const nameAttr = surface.name ? ` name="${this.escapeXml(surface.name)}"` : '';

        // Map internal surface type to OpenMC-compatible type
        const openmcType = this.mapSurfaceTypeToOpenMC(surface);

        return `  <surface coeffs="${this.coeffsToString(surface)}" id="${surface.id}" type="${openmcType}"${boundaryAttr}${nameAttr}/>`;
    }

    /**
     * Map internal surface type to OpenMC-compatible surface type.
     * OpenMC doesn't support generic 'cylinder' type - only x-cylinder, y-cylinder, z-cylinder.
     */
    private mapSurfaceTypeToOpenMC(surface: OpenMCSurface): string {
        const type = surface.type;
        const coeffs = surface.coefficients as any;

        // Handle generic cylinder type - determine axis from direction vector
        if (type === 'cylinder') {
            // Generic cylinder has: x0, y0, z0, r, vx, vy, vz (center and direction vector)
            const vx = coeffs.vx ?? 0;
            const vy = coeffs.vy ?? 0;
            const vz = coeffs.vz ?? 1; // default to z-axis

            // Determine principal axis from direction vector
            const absVx = Math.abs(vx);
            const absVy = Math.abs(vy);
            const absVz = Math.abs(vz);

            if (absVx >= absVy && absVx >= absVz) {
                return 'x-cylinder';
            } else if (absVy >= absVx && absVy >= absVz) {
                return 'y-cylinder';
            } else {
                return 'z-cylinder';
            }
        }

        // All other types map directly
        return type;
    }

    private coeffsToString(surface: OpenMCSurface): string {
        const type = surface.type;
        const coeffs = surface.coefficients as any;

        // Handle generic cylinder - need to output only relevant coefficients for axis-aligned
        if (type === 'cylinder') {
            const x0 = coeffs.x0 ?? 0;
            const y0 = coeffs.y0 ?? 0;
            const z0 = coeffs.z0 ?? 0;
            const r = coeffs.r ?? 1;
            const vx = coeffs.vx ?? 0;
            const vy = coeffs.vy ?? 0;
            const vz = coeffs.vz ?? 1;

            // Determine which axis the cylinder is aligned with
            const absVx = Math.abs(vx);
            const absVy = Math.abs(vy);
            const absVz = Math.abs(vz);

            if (absVx >= absVy && absVx >= absVz) {
                // x-cylinder: y0, z0, r
                return `${y0} ${z0} ${r}`;
            } else if (absVy >= absVx && absVy >= absVz) {
                // y-cylinder: x0, z0, r
                return `${x0} ${z0} ${r}`;
            } else {
                // z-cylinder: x0, y0, r
                return `${x0} ${y0} ${r}`;
            }
        }

        // All other types - format coefficients directly
        const values = Object.values(coeffs);
        return values.join(' ');
    }

    private generateCellElement(cell: OpenMCCell, universeId: number = 0): string {
        const nameAttr = cell.name ? ` name="${this.escapeXml(cell.name)}"` : '';
        const tempAttr = cell.temperature ? ` temperature="${cell.temperature}"` : '';
        const universeAttr = universeId !== 0 ? ` universe="${universeId}"` : '';

        // Build attributes for self-closing tag (compatible with OpenMC geometry viewer)
        let fillAttr = '';
        if (cell.fillType === 'material' && cell.fillId !== undefined) {
            fillAttr = ` material="${cell.fillId}"`;
        } else if (cell.fillType === 'universe' && cell.fillId !== undefined) {
            fillAttr = ` fill="${cell.fillId}"`;
        } else if (cell.fillType === 'lattice' && cell.fillId !== undefined) {
            fillAttr = ` fill="${cell.fillId}"`;
        }
        // Note: void cells don't need a material attribute (empty cell)

        // Build region attribute
        let regionAttr = '';
        let regionValue = '';
        if (cell.regionString) {
            regionValue = cell.regionString;
        } else if (cell.region) {
            regionValue = this.regionNodeToString(cell.region);
        }
        if (regionValue) {
            regionAttr = ` region="${this.escapeXml(regionValue)}"`;
        }

        // Use self-closing tag format for cleaner XML
        return `  <cell id="${cell.id}"${nameAttr}${fillAttr}${regionAttr}${tempAttr}${universeAttr}/>\n`;
    }

    private regionNodeToString(node: any): string {
        if (!node) return '';

        if (node.type === 'surface') {
            return node.surfaceId > 0 ? `+${node.surfaceId}` : `${node.surfaceId}`;
        }

        if (node.type === 'operator') {
            const children = node.children?.map((c: any) => this.regionNodeToString(c)).filter(Boolean) || [];

            if (node.operator === 'intersection') {
                return children.join(' ');
            } else if (node.operator === 'union') {
                return children.join(' | ');
            } else if (node.operator === 'complement') {
                return `~${children[0] || ''}`;
            }
        }

        return '';
    }

    private generateLatticeElement(lattice: OpenMCLattice): string {
        const lines: string[] = [];

        // This is a simplified implementation
        // Full implementation would handle different lattice types
        lines.push(`  <!-- Lattice ${lattice.id} generation not yet fully implemented -->`);

        return lines.join('\n');
    }

    // ============================================================================
    // Settings XML
    // ============================================================================

    /**
     * Generate settings.xml from state settings.
     * @param state - Simulation state
     * @param randomRayCompat - Random ray XML format compatibility (probed per
     *   python env by the caller); defaults to the release-compatible form
     * @param warnings - Optional array to collect generation warnings
     * @returns settings.xml content
     */

    private generateSettingsXML(state: OpenMCState, compat: OpenMCCompat = DEFAULT_OPENMC_COMPAT, warnings?: string[]): string {
        const lines: string[] = ['<?xml version="1.0"?>', '<settings>', ''];

        // Mesh IDs already emitted as elements into settings.xml (dedup guard
        // for the variance-reduction mesh references below)
        const emittedMeshIds = new Set<number>();

        const settings = state.settings;
        const run = settings.run;

        // Run mode
        lines.push(`  <run_mode>${run.mode}</run_mode>`);

        // Handle different run modes
        if (run.mode === 'eigenvalue') {
            const eigenRun = run as OpenMCEigenvalueSettings;
            lines.push(`  <particles>${eigenRun.particles}</particles>`);
            lines.push(`  <batches>${eigenRun.batches}</batches>`);
            lines.push(`  <inactive>${eigenRun.inactive}</inactive>`);
        } else if (run.mode === 'fixed source') {
            const fixedRun = run as OpenMCFixedSourceSettings;
            lines.push(`  <particles>${fixedRun.particles}</particles>`);
            lines.push(`  <batches>${fixedRun.batches}</batches>`);
            if (fixedRun.inactive !== undefined) {
                lines.push(`  <inactive>${fixedRun.inactive}</inactive>`);
            }
        }

        // Energy mode (multi-group / random ray); real OpenMC value is 'multi-group'
        if (settings.energyMode) {
            lines.push(`  <energy_mode>${settings.energyMode === 'multigroup' ? 'multi-group' : settings.energyMode}</energy_mode>`);
        }

        // MGXS library path for multi-group runs (deprecated-but-read settings.xml element, src/settings.cpp:450)
        // Resolves canonical settings.mgxsLibrary, falling back to the legacy randomRay.mgxsLibraryPath.
        const mgxsLibrary = settings.energyMode === 'multigroup' ? this.resolveMgxsLibraryFile(settings) : undefined;
        if (mgxsLibrary) {
            lines.push(`  <cross_sections>${this.escapeXml(mgxsLibrary)}</cross_sections>`);
        }

        // Sources
        if (settings.sources && settings.sources.length > 0) {
            let validSources = 0;
            for (const source of settings.sources) {
                // TokamakSource is 0.15.4+ — drop on unsupported envs with a warning
                if (source.type === 'tokamak' && !compat.tokamakSource) {
                    warnings?.push('Tokamak source requires OpenMC >= 0.15.4; the tokamak source was not written to settings.xml');
                    continue;
                }
                const sourceXml = this.generateSourceElement(source);
                if (sourceXml) {
                    lines.push(sourceXml);
                    validSources++;
                }
            }
            // If no valid sources were generated, add a default source
            if (validSources === 0 && run.mode !== 'volume') {
                this.log('Warning: No valid sources found, adding default point source at origin');
                lines.push('  <source>');
                lines.push('    <space type="point">');
                lines.push('      <parameters>0 0 0</parameters>');
                lines.push('    </space>');
                lines.push('  </source>');
            }

            // Meshes referenced by mesh sources are emitted into settings.xml
            // (settings.py _create_source_subelement), NOT tallies.xml — the
            // tallies generator skips these ids (OpenMC mesh_memo pattern).
            for (const source of settings.sources) {
                if (source.type === 'mesh' && source.meshId !== undefined && !emittedMeshIds.has(source.meshId)) {
                    const mesh = state.meshes.find((m) => m.id === source.meshId);
                    if (mesh) {
                        lines.push(this.generateMeshElement(mesh));
                        emittedMeshIds.add(source.meshId);
                    } else {
                        this.log(`Warning: Mesh source references mesh ${source.meshId} which is not in state.meshes`);
                    }
                }
            }
        } else if (run.mode !== 'volume') {
            // No sources defined - add a default for non-volume modes
            this.log('Warning: No sources defined, adding default point source at origin');
            lines.push('  <source>');
            lines.push('    <space type="point">');
            lines.push('      <parameters>0 0 0</parameters>');
            lines.push('    </space>');
            lines.push('  </source>');
        }

        // Seed
        if (settings.seed) {
            lines.push(`  <seed>${settings.seed}</seed>`);
        }

        // IFP kinetics generations (settings.xml <ifp_n_generation>)
        if (settings.kinetics?.enabled && settings.kinetics.ifpNGenerations !== undefined) {
            lines.push(`  <ifp_n_generation>${settings.kinetics.ifpNGenerations}</ifp_n_generation>`);
        }

        // Source rejection fraction (must be > 0)
        if (settings.sourceRejectionFraction !== undefined && settings.sourceRejectionFraction > 0) {
            lines.push(`  <source_rejection_fraction>${settings.sourceRejectionFraction}</source_rejection_fraction>`);
        }

        // Temperature settings
        if (settings.temperature) {
            lines.push('  <temperature_default>');
            if (settings.temperature.default) {
                lines.push(`    <default>${settings.temperature.default}</default>`);
            }
            if (settings.temperature.method) {
                lines.push(`    <method>${settings.temperature.method}</method>`);
            }
            lines.push('  </temperature_default>');
        }

        // Cutoff
        if (settings.cutoff) {
            lines.push('  <cutoff>');
            if (settings.cutoff.weight) {
                lines.push(`    <weight>${settings.cutoff.weight}</weight>`);
            }
            if (settings.cutoff.weightAvg) {
                lines.push(`    <weight_avg>${settings.cutoff.weightAvg}</weight_avg>`);
            }
            lines.push('  </cutoff>');
        }

        // Photon transport
        if (settings.photonTransport) {
            lines.push(`  <photon_transport>true</photon_transport>`);
        }

        // Electron treatment (photon physics)
        if (settings.electronTreatment) {
            lines.push(`  <electron_treatment>${settings.electronTreatment}</electron_treatment>`);
        }

        // Atomic relaxation
        if (settings.atomicRelaxation !== undefined) {
            lines.push(`  <atomic_relaxation>${settings.atomicRelaxation}</atomic_relaxation>`);
        }

        // Output control (summary falls back to the legacy outputSummary field)
        const outputSummary = settings.output?.summary ?? settings.outputSummary;
        if (outputSummary !== undefined || settings.output?.tallies !== undefined || settings.output?.path) {
            lines.push('  <output>');
            if (outputSummary !== undefined) {
                lines.push(`    <summary>${outputSummary}</summary>`);
            }
            if (settings.output?.tallies !== undefined) {
                lines.push(`    <tallies>${settings.output.tallies}</tallies>`);
            }
            if (settings.output?.path) {
                lines.push(`    <path>${this.escapeXml(settings.output.path)}</path>`);
            }
            lines.push('  </output>');
        }

        // Statepoint batches
        const statepointBatches = Array.isArray(settings.statepointBatches) ? settings.statepointBatches : settings.statepointBatches?.at;
        if (statepointBatches && statepointBatches.length > 0) {
            lines.push('  <state_point>');
            lines.push(`    <batches>${statepointBatches.join(' ')}</batches>`);
            lines.push('  </state_point>');
        }

        // Sourcepoint options
        if (settings.sourcePoint) {
            const sp = settings.sourcePoint;
            lines.push('  <source_point>');
            if (sp.batches && sp.batches.length > 0) {
                lines.push(`    <batches>${sp.batches.join(' ')}</batches>`);
            }
            if (sp.separate !== undefined) {
                lines.push(`    <separate>${sp.separate}</separate>`);
            }
            if (sp.write !== undefined) {
                lines.push(`    <write>${sp.write}</write>`);
            }
            if (sp.overwrite !== undefined) {
                lines.push(`    <overwrite_latest>${sp.overwrite}</overwrite_latest>`);
            }
            if (sp.mcpl !== undefined) {
                lines.push(`    <mcpl>${sp.mcpl}</mcpl>`);
            }
            lines.push('  </source_point>');
        }

        // Surface source writing
        if (settings.surfaceSourceWrite) {
            const ssw = settings.surfaceSourceWrite;
            lines.push('  <surf_source_write>');
            if (ssw.surfaceIds && ssw.surfaceIds.length > 0) {
                lines.push(`    <surface_ids>${ssw.surfaceIds.join(' ')}</surface_ids>`);
            }
            if (ssw.mcpl !== undefined) {
                lines.push(`    <mcpl>${ssw.mcpl}</mcpl>`);
            }
            if (ssw.maxParticles !== undefined) {
                lines.push(`    <max_particles>${ssw.maxParticles}</max_particles>`);
            }
            if (ssw.maxSourceFiles !== undefined) {
                lines.push(`    <max_source_files>${ssw.maxSourceFiles}</max_source_files>`);
            }
            if (ssw.cell !== undefined) {
                lines.push(`    <cell>${ssw.cell}</cell>`);
            }
            if (ssw.cellfrom !== undefined) {
                lines.push(`    <cellfrom>${ssw.cellfrom}</cellfrom>`);
            }
            if (ssw.cellto !== undefined) {
                lines.push(`    <cellto>${ssw.cellto}</cellto>`);
            }
            lines.push('  </surf_source_write>');
        }

        // Surface source reading
        if (settings.surfaceSourceRead?.path) {
            lines.push('  <surf_source_read>');
            lines.push(`    <path>${this.escapeXml(settings.surfaceSourceRead.path)}</path>`);
            lines.push('  </surf_source_read>');
        }

        // Particle tracks ([batch, generation, particle] triples, flattened)
        if (settings.tracks && settings.tracks.length > 0) {
            lines.push(`  <track>${settings.tracks.map((t) => t.join(' ')).join(' ')}</track>`);
        }
        if (settings.maxTracks !== undefined) {
            lines.push(`  <max_tracks>${settings.maxTracks}</max_tracks>`);
        }

        // Collision track output
        if (settings.collisionTrack) {
            const ct = settings.collisionTrack;
            lines.push('  <collision_track>');
            if (ct.cellIds && ct.cellIds.length > 0) {
                lines.push(`    <cell_ids>${ct.cellIds.join(' ')}</cell_ids>`);
            }
            if (ct.reactions && ct.reactions.length > 0) {
                lines.push(`    <reactions>${ct.reactions.join(' ')}</reactions>`);
            }
            if (ct.universeIds && ct.universeIds.length > 0) {
                lines.push(`    <universe_ids>${ct.universeIds.join(' ')}</universe_ids>`);
            }
            if (ct.materialIds && ct.materialIds.length > 0) {
                lines.push(`    <material_ids>${ct.materialIds.join(' ')}</material_ids>`);
            }
            if (ct.nuclides && ct.nuclides.length > 0) {
                lines.push(`    <nuclides>${ct.nuclides.join(' ')}</nuclides>`);
            }
            if (ct.depositedEnergyThreshold !== undefined) {
                lines.push(`    <deposited_E_threshold>${ct.depositedEnergyThreshold}</deposited_E_threshold>`);
            }
            if (ct.maxCollisions !== undefined) {
                lines.push(`    <max_collisions>${ct.maxCollisions}</max_collisions>`);
            }
            if (ct.maxCollisionTrackFiles !== undefined) {
                lines.push(`    <max_collision_track_files>${ct.maxCollisionTrackFiles}</max_collision_track_files>`);
            }
            if (ct.mcpl !== undefined) {
                lines.push(`    <mcpl>${ct.mcpl}</mcpl>`);
            }
            lines.push('  </collision_track>');
        }

        // Shannon entropy mesh (mesh element written inline per settings.py export)
        if (settings.entropyMesh) {
            const em = settings.entropyMesh;
            const meshId = em.id ?? 10000;
            lines.push(`  <entropy_mesh>${meshId}</entropy_mesh>`);
            lines.push(`  <mesh id="${meshId}" type="regular">`);
            lines.push(`    <lower_left>${em.lowerLeft.join(' ')}</lower_left>`);
            lines.push(`    <upper_right>${em.upperRight.join(' ')}</upper_right>`);
            lines.push(`    <dimension>${em.shape.join(' ')}</dimension>`);
            lines.push('  </mesh>');
            emittedMeshIds.add(meshId);
        }

        // Random ray solver settings (openmc/settings.py _create_random_ray_subelement)
        if (settings.randomRay) {
            const rr = settings.randomRay;
            lines.push('  <random_ray>');
            if (rr.distanceInactive !== undefined) {
                lines.push(`    <distance_inactive>${rr.distanceInactive}</distance_inactive>`);
            }
            if (rr.distanceActive !== undefined) {
                lines.push(`    <distance_active>${rr.distanceActive}</distance_active>`);
            }
            if (rr.volumeEstimator) {
                lines.push(`    <volume_estimator>${rr.volumeEstimator}</volume_estimator>`);
            }
            if (rr.sourceShape) {
                lines.push(`    <source_shape>${rr.sourceShape}</source_shape>`);
            }
            if (rr.volumeNormalizedFluxTallies !== undefined) {
                lines.push(`    <volume_normalized_flux_tallies>${rr.volumeNormalizedFluxTallies}</volume_normalized_flux_tallies>`);
            }
            if (rr.sampleMethod) {
                // s2 is not accepted by every version — fall back to halton
                if (rr.sampleMethod === 's2' && !compat.s2SampleMethod) {
                    warnings?.push("Random ray sample_method 's2' is not supported by the configured OpenMC; emitted 'halton' instead");
                    lines.push(`    <sample_method>halton</sample_method>`);
                } else {
                    lines.push(`    <sample_method>${rr.sampleMethod}</sample_method>`);
                }
            }
            if (rr.diagonalStabilizationRho !== undefined) {
                lines.push(`    <diagonal_stabilization_rho>${rr.diagonalStabilizationRho}</diagonal_stabilization_rho>`);
            }
            if (rr.adjoint !== undefined) {
                lines.push(`    <adjoint>${rr.adjoint}</adjoint>`);
            }
            if (rr.raySource) {
                // Release 0.15.3 reads <source> directly under <random_ray>;
                // post-0.15.3 dev wraps it in <ray_source> (src/settings.cpp:284-289)
                const wrap = compat.raySourceFormat === 'wrapper';
                if (wrap) {
                    lines.push('    <ray_source>');
                }
                lines.push(`${wrap ? '      ' : '    '}<source type="independent" strength="1" particle="neutron">`);
                lines.push(`${wrap ? '        ' : '      '}<space type="box">`);
                lines.push(
                    `${wrap ? '          ' : '        '}<parameters>${rr.raySource.lowerLeft.join(' ')} ${rr.raySource.upperRight.join(' ')}</parameters>`
                );
                lines.push(`${wrap ? '        ' : '      '}</space>`);
                lines.push(`${wrap ? '      ' : '    '}</source>`);
                if (wrap) {
                    lines.push('    </ray_source>');
                }
            }
            if (rr.adjointSource) {
                if (compat.adjointSource) {
                    // settings.py:2036-2047 — adjoint_source holds a list of
                    // source elements; the UI models the single-box case
                    lines.push('    <adjoint_source>');
                    lines.push('      <source type="independent" strength="1" particle="neutron">');
                    lines.push('        <space type="box">');
                    lines.push(
                        `          <parameters>${rr.adjointSource.lowerLeft.join(' ')} ${rr.adjointSource.upperRight.join(' ')}</parameters>`
                    );
                    lines.push('        </space>');
                    lines.push('      </source>');
                    lines.push('    </adjoint_source>');
                } else {
                    warnings?.push(
                        'Random ray adjoint source requires a post-0.15.3 OpenMC; the configured adjoint source was not written to settings.xml'
                    );
                }
            }
            if (rr.sourceRegionMeshId !== undefined) {
                lines.push('    <source_region_meshes>');
                lines.push(`      <mesh id="${rr.sourceRegionMeshId}">`);
                for (const domainId of rr.sourceRegionDomainIds ?? []) {
                    lines.push(`        <domain id="${domainId}" type="${rr.sourceRegionDomainType ?? 'cell'}"/>`);
                }
                lines.push('      </mesh>');
                lines.push('    </source_region_meshes>');
            }
            lines.push('  </random_ray>');

            // Append the source region mesh element at settings root (per settings.py)
            if (rr.sourceRegionMeshId !== undefined) {
                const srMesh = state.meshes.find((m) => m.id === rr.sourceRegionMeshId && m.type === 'regular');
                if (srMesh) {
                    lines.push(this.generateMeshElement(srMesh));
                    emittedMeshIds.add(rr.sourceRegionMeshId);
                }
            }
        }

        // DAGMC geometry file
        if (settings.dagmcFile) {
            lines.push('');
            lines.push('  <!-- DAGMC Geometry -->');
            lines.push(`  <dagmc>true</dagmc>`);
        }

        // Depletion settings (for reference - actual depletion requires Python API)
        if (state.depletion?.enabled) {
            lines.push('');
            lines.push('  <!-- Depletion Settings (requires Python API to run) -->');
            lines.push('  <depletion>');
            if (state.depletion.chainFile) {
                lines.push(`    <chain_file>${state.depletion.chainFile}</chain_file>`);
            }
            if (state.depletion.timeSteps && state.depletion.timeSteps.length > 0) {
                const timeSteps = state.depletion.timeSteps.map((ts) => {
                    // If it's a string like "1 d", convert to seconds
                    if (typeof ts === 'string') {
                        const match = ts.match(/^([\d.]+)\s*([smhdwy])$/i);
                        if (match) {
                            const value = parseFloat(match[1]);
                            const unit = match[2].toLowerCase();
                            const multipliers: { [key: string]: number } = {
                                s: 1,
                                m: 60,
                                h: 3600,
                                d: 86400,
                                w: 604800,
                                y: 31536000
                            };
                            return Math.round(value * (multipliers[unit] || 1));
                        }
                    }
                    return Number(ts);
                });
                lines.push(`    <time_steps>${timeSteps.join(' ')}</time_steps>`);
            }
            // Calculate and write power
            let totalPower = state.depletion.power;

            // If powerDensity is specified, calculate total power from depletable materials
            if (totalPower === undefined && state.depletion.powerDensity !== undefined && state.materials) {
                let totalMassG = 0;
                for (const mat of state.materials) {
                    if (mat.isDepletable && mat.volume) {
                        // Mass = density (g/cm³) × volume (cm³)
                        totalMassG += mat.density * mat.volume;
                    }
                }
                if (totalMassG > 0) {
                    totalPower = state.depletion.powerDensity * totalMassG;
                }
            }

            if (totalPower !== undefined && totalPower > 0) {
                lines.push(`    <power>${totalPower.toFixed(6)}</power>`);
            }

            // Also store power density if specified (for reference)
            if (state.depletion.powerDensity !== undefined) {
                lines.push(`    <power_density>${state.depletion.powerDensity}</power_density>`);
            }

            // Advanced depletion options (consumed by the depletion runner, not OpenMC itself)
            if (state.depletion.operator) {
                lines.push(`    <operator>${state.depletion.operator}</operator>`);
            }
            if (state.depletion.solver) {
                lines.push(`    <solver>${resolveDepletionSolver(state.depletion.solver)}</solver>`);
            }
            if (state.depletion.normalizationMode) {
                lines.push(`    <normalization>${state.depletion.normalizationMode}</normalization>`);
            }
            if (state.depletion.diffBurnableMats) {
                lines.push(`    <diff_burnable_mats>true</diff_burnable_mats>`);
            }
            if (state.depletion.diffVolumeMethod) {
                lines.push(`    <diff_volume_method>${state.depletion.diffVolumeMethod}</diff_volume_method>`);
            }
            if (state.depletion.fluxFiles && state.depletion.fluxFiles.length > 0) {
                lines.push(`    <flux_files>${state.depletion.fluxFiles.join(',')}</flux_files>`);
            }
            if (state.depletion.microxsFiles && state.depletion.microxsFiles.length > 0) {
                lines.push(`    <microxs_files>${state.depletion.microxsFiles.join(',')}</microxs_files>`);
            }
            if (state.depletion.generateFromModel) {
                lines.push(`    <generate_microxs>true</generate_microxs>`);
            }
            if (state.depletion.transferRates && state.depletion.transferRates.length > 0) {
                lines.push(`    <transfer_rates>${this.escapeXml(JSON.stringify(state.depletion.transferRates))}</transfer_rates>`);
            }
            if (state.depletion.fissionQ && Object.keys(state.depletion.fissionQ).length > 0) {
                lines.push(`    <fission_q>${this.escapeXml(JSON.stringify(state.depletion.fissionQ))}</fission_q>`);
            }

            lines.push('  </depletion>');
        }

        // Variance Reduction settings
        if (state.varianceReduction) {
            const vr = state.varianceReduction;

            // Survival biasing
            if (vr.survivalBiasing) {
                lines.push('');
                lines.push('  <!-- Variance Reduction -->');
                lines.push('  <survival_biasing>true</survival_biasing>');
            }

            // Cutoff settings
            if (vr.cutoff && (vr.cutoff.weight !== undefined || vr.cutoff.weightAvg !== undefined)) {
                lines.push('  <cutoff>');
                if (vr.cutoff.weight !== undefined) {
                    lines.push(`    <weight>${vr.cutoff.weight}</weight>`);
                }
                if (vr.cutoff.weightAvg !== undefined) {
                    lines.push(`    <weight_avg>${vr.cutoff.weightAvg}</weight_avg>`);
                }
                lines.push('  </cutoff>');
            }

            // Weight window generator (real OpenMC format: openmc/weight_windows.py:713)
            if (vr.weightWindowGenerator) {
                const wwg = vr.weightWindowGenerator;
                const wwgMeshId = wwg.meshId ?? vr.weightWindows?.meshId ?? vr.ufs?.meshId ?? 1;
                const wwgEnergyBounds = wwg.energyBounds ?? vr.weightWindows?.energyBounds;
                const maxRealizations =
                    wwg.maxRealizations ?? wwg.iterations ?? (state.settings.run.mode === 'eigenvalue' ? state.settings.run.batches : 1);

                lines.push('  <weight_window_generators>');
                lines.push('    <weight_windows_generator>');
                lines.push(`      <mesh>${wwgMeshId}</mesh>`);
                if (wwgEnergyBounds && wwgEnergyBounds.length > 0) {
                    lines.push(`      <energy_bounds>${wwgEnergyBounds.join(' ')}</energy_bounds>`);
                }
                lines.push(`      <particle_type>${wwg.particleType ?? vr.weightWindows?.particleType ?? 'neutron'}</particle_type>`);
                lines.push(`      <max_realizations>${maxRealizations}</max_realizations>`);
                lines.push(`      <update_interval>${wwg.updateInterval ?? 1}</update_interval>`);
                lines.push(`      <on_the_fly>${wwg.onTheFly ?? true}</on_the_fly>`);
                lines.push(`      <method>${wwg.method ?? 'magic'}</method>`);
                if (wwg.method === 'fw_cadis' && wwg.targetTallyIds && wwg.targetTallyIds.length > 0) {
                    lines.push(`      <targets>${wwg.targetTallyIds.join(' ')}</targets>`);
                }
                lines.push('    </weight_windows_generator>');
                lines.push('  </weight_window_generators>');
            }

            // Weight windows
            if (vr.weightWindows) {
                const ww = vr.weightWindows;
                lines.push('  <weight_windows id="1">');

                if (ww.meshId !== undefined) {
                    lines.push(`    <mesh>${ww.meshId}</mesh>`);
                }

                // Particle type (required, default neutron)
                lines.push(`    <particle_type>${ww.particleType || 'neutron'}</particle_type>`);

                // Calculate number of mesh cells for bounds array
                let numCells = 1;
                const mesh = state.meshes.find((m: OpenMCMesh) => m.id === ww.meshId);
                if (mesh) {
                    if (mesh.type === 'regular') {
                        const regularMesh = mesh as OpenMCRegularMesh;
                        numCells = regularMesh.dimension[0] * regularMesh.dimension[1] * regularMesh.dimension[2];
                    } else if (mesh.type === 'cylindrical') {
                        const cylMesh = mesh as OpenMCCylindricalMesh;
                        numCells = (cylMesh.rGrid.length - 1) * (cylMesh.phiGrid.length - 1) * (cylMesh.zGrid.length - 1);
                    } else if (mesh.type === 'spherical') {
                        const sphMesh = mesh as OpenMCSphericalMesh;
                        numCells = (sphMesh.rGrid.length - 1) * (sphMesh.thetaGrid.length - 1) * (sphMesh.phiGrid.length - 1);
                    }
                }

                // Number of energy groups (N bounds = N-1 groups)
                const numEnergyGroups = ww.energyBounds && ww.energyBounds.length > 1 ? ww.energyBounds.length - 1 : 1;
                const totalBounds = numCells * numEnergyGroups;

                // Lower ww bounds - must have one value per mesh cell per energy group
                const lowerBoundValue = typeof ww.lowerBound === 'number' ? ww.lowerBound : 0.5;
                const lowerBounds = Array(totalBounds).fill(lowerBoundValue);
                lines.push(`    <lower_ww_bounds>${lowerBounds.join(' ')}</lower_ww_bounds>`);

                // Upper ww bounds - must have one value per mesh cell per energy group
                const upperBoundValue = typeof ww.upperBound === 'number' ? ww.upperBound : lowerBoundValue * 2;
                const upperBounds = Array(totalBounds).fill(upperBoundValue);
                lines.push(`    <upper_ww_bounds>${upperBounds.join(' ')}</upper_ww_bounds>`);

                // Survival ratio (default 3.0)
                lines.push(`    <survival_ratio>${ww.survivalWeight !== undefined ? ww.survivalWeight : 3.0}</survival_ratio>`);

                // Required parameters
                lines.push(`    <max_split>10</max_split>`);
                lines.push(`    <weight_cutoff>1e-38</weight_cutoff>`);

                // Energy bounds - REQUIRED by OpenMC
                // Must have at least 2 bounds to define 1 energy group
                if (ww.energyBounds && ww.energyBounds.length >= 2) {
                    lines.push(`    <energy_bounds>${ww.energyBounds.join(' ')}</energy_bounds>`);
                } else {
                    this.log('Warning: Weight windows require energy_bounds (minimum 2 values)');
                }

                lines.push('  </weight_windows>');
            }

            // Uniform Fission Site (UFS)
            if (vr.ufs?.enabled) {
                lines.push('');
                lines.push('  <!-- Uniform Fission Site -->');
                lines.push('  <ufs>');
                if (vr.ufs.meshId !== undefined) {
                    lines.push(`    <mesh>${vr.ufs.meshId}</mesh>`);
                }
                lines.push('  </ufs>');
            }

            // Emit the mesh elements referenced by weight windows / the WW
            // generator / UFS into settings.xml (openmc python appends them to
            // the settings root — without them the C++ mesh lookup crashes
            // with unordered_map::at during settings reading)
            const vrMeshIds = new Set<number>();
            if (vr.weightWindowGenerator) {
                vrMeshIds.add(vr.weightWindowGenerator.meshId ?? vr.weightWindows?.meshId ?? vr.ufs?.meshId ?? 1);
            }
            if (vr.weightWindows?.meshId !== undefined) {
                vrMeshIds.add(vr.weightWindows.meshId);
            }
            if (vr.ufs?.enabled && vr.ufs.meshId !== undefined) {
                vrMeshIds.add(vr.ufs.meshId);
            }
            for (const meshId of vrMeshIds) {
                if (emittedMeshIds.has(meshId)) {
                    continue;
                }
                const vrMesh = state.meshes.find((m) => m.id === meshId && m.type === 'regular');
                if (vrMesh) {
                    lines.push(this.generateMeshElement(vrMesh));
                    emittedMeshIds.add(meshId);
                }
            }
        }

        // Advanced scalar settings (element names verified against
        // openmc/settings.py _create_*_subelement methods)
        if (settings.eventBased !== undefined) {
            lines.push(`  <event_based>${settings.eventBased}</event_based>`);
        }
        if (settings.probabilityTables !== undefined) {
            lines.push(`  <ptables>${settings.probabilityTables}</ptables>`);
        }
        if (settings.maxLostParticles !== undefined) {
            lines.push(`  <max_lost_particles>${settings.maxLostParticles}</max_lost_particles>`);
        }
        if (settings.relLostParticleRate !== undefined) {
            lines.push(`  <rel_max_lost_particles>${settings.relLostParticleRate}</rel_max_lost_particles>`);
        }
        if (settings.createFissionNeutrons !== undefined) {
            lines.push(`  <create_fission_neutrons>${settings.createFissionNeutrons}</create_fission_neutrons>`);
        }
        if (settings.createDelayedNeutrons !== undefined) {
            lines.push(`  <create_delayed_neutrons>${settings.createDelayedNeutrons}</create_delayed_neutrons>`);
        }
        if (settings.delayedPhotonScaling !== undefined) {
            lines.push(`  <delayed_photon_scaling>${settings.delayedPhotonScaling}</delayed_photon_scaling>`);
        }
        if (settings.useDecayPhotons !== undefined) {
            lines.push(`  <use_decay_photons>${settings.useDecayPhotons}</use_decay_photons>`);
        }
        if (settings.logGridBins !== undefined) {
            lines.push(`  <log_grid_bins>${settings.logGridBins}</log_grid_bins>`);
        }
        if (settings.survivalBiasing !== undefined) {
            lines.push(`  <survival_biasing>${settings.survivalBiasing}</survival_biasing>`);
        }
        if (settings.generationsPerBatch !== undefined) {
            lines.push(`  <generations_per_batch>${settings.generationsPerBatch}</generations_per_batch>`);
        }
        if (settings.maxOrder !== undefined) {
            lines.push(`  <max_order>${settings.maxOrder}</max_order>`);
        }
        if (settings.writeInitialSource !== undefined) {
            lines.push(`  <write_initial_source>${settings.writeInitialSource}</write_initial_source>`);
        }
        if (settings.uniformSourceSampling !== undefined) {
            lines.push(`  <uniform_source_sampling>${settings.uniformSourceSampling}</uniform_source_sampling>`);
        }
        if (settings.tabularLegendre?.enable !== undefined) {
            lines.push('  <tabular_legendre>');
            lines.push(`    <enable>${settings.tabularLegendre.enable}</enable>`);
            if (settings.tabularLegendre.numPoints !== undefined) {
                lines.push(`    <num_points>${settings.tabularLegendre.numPoints}</num_points>`);
            }
            lines.push('  </tabular_legendre>');
        }

        // Run-level tally trigger activation (settings.py _create_trigger_subelement):
        // OpenMC requires <active>true</active> for per-tally triggers to be
        // evaluated, so the block is emitted whenever any tally has triggers
        // or run-level trigger fields are set.
        const anyTallyTriggers = state.tallies.some((tally) => (tally.triggers?.length ?? 0) > 0);
        const triggerSettings = settings.triggers;
        if (anyTallyTriggers || triggerSettings?.maxBatches !== undefined || triggerSettings?.batchInterval !== undefined) {
            lines.push('  <trigger>');
            lines.push('    <active>true</active>');
            if (triggerSettings?.maxBatches !== undefined) {
                lines.push(`    <max_batches>${triggerSettings.maxBatches}</max_batches>`);
            }
            if (triggerSettings?.batchInterval !== undefined) {
                lines.push(`    <batch_interval>${triggerSettings.batchInterval}</batch_interval>`);
            }
            lines.push('  </trigger>');
        }

        lines.push('</settings>');

        return lines.join('\n');
    }

    private generateSourceElement(source: any): string {
        const lines: string[] = [];
        const sourceType = source.type ?? 'independent';

        // File source: <source type="file" file="..." strength="..."/>
        if (sourceType === 'file') {
            if (!source.path) {
                this.log(`Warning: Skipping file source with no path`);
                return '';
            }
            const strengthAttr = source.strength !== undefined ? ` strength="${source.strength}"` : '';
            lines.push(`  <source type="file" file="${this.escapeXml(source.path)}"${strengthAttr}>`);
            const fileConstraints = this.generateSourceConstraintsElement(source.constraints);
            if (fileConstraints) {
                lines.push(fileConstraints);
            }
            lines.push('  </source>');
            return lines.join('\n');
        }

        // Compiled source: <source type="compiled" library="..." parameters="..."/>
        if (sourceType === 'compiled') {
            if (!source.library) {
                this.log(`Warning: Skipping compiled source with no library`);
                return '';
            }
            const strengthAttr = source.strength !== undefined ? ` strength="${source.strength}"` : '';
            const paramsAttr = source.parameters ? ` parameters="${this.escapeXml(source.parameters)}"` : '';
            lines.push(`  <source type="compiled" library="${this.escapeXml(source.library)}"${paramsAttr}${strengthAttr}>`);
            const compiledConstraints = this.generateSourceConstraintsElement(source.constraints);
            if (compiledConstraints) {
                lines.push(compiledConstraints);
            }
            lines.push('  </source>');
            return lines.join('\n');
        }

        // Mesh source: <source type="mesh" mesh="<id>"> with nested per-element
        // sub-source elements (openmc/source.py MeshSource.populate_xml_element).
        // The referenced mesh is emitted at settings root by the caller
        // (settings.py _create_source_subelement). Strength is the computed
        // sum of sub-source strengths.
        if (sourceType === 'mesh') {
            if (source.meshId === undefined) {
                this.log(`Warning: Skipping mesh source with no mesh selected`);
                return '';
            }
            const subSources: any[] = source.sources ?? [];
            if (subSources.length === 0) {
                this.log(`Warning: Skipping mesh source with no sub-sources`);
                return '';
            }
            const totalStrength = subSources.reduce((sum, sub) => sum + (sub.strength ?? 1.0), 0);
            lines.push(`  <source type="mesh" mesh="${source.meshId}" strength="${totalStrength}">`);
            for (const sub of subSources) {
                const subXml = this.generateSourceElement(sub);
                if (subXml) {
                    lines.push(
                        subXml
                            .split('\n')
                            .map((line) => `  ${line}`)
                            .join('\n')
                    );
                }
            }
            const meshConstraints = this.generateSourceConstraintsElement(source.constraints);
            if (meshConstraints) {
                lines.push(meshConstraints);
            }
            lines.push('  </source>');
            return lines.join('\n');
        }

        // Tokamak source: <source type="tokamak"> with geometry/profile/energy
        // sub-elements (openmc/source.py TokamakSource.populate_xml_element)
        if (sourceType === 'tokamak') {
            if (!source.profile || source.profile.length < 2) {
                this.log(`Warning: Skipping tokamak source with incomplete emission profile`);
                return '';
            }
            const strengthAttr = source.strength !== undefined ? ` strength="${source.strength}"` : '';
            lines.push(`  <source type="tokamak"${strengthAttr}>`);
            lines.push(`    <major_radius>${source.majorRadius}</major_radius>`);
            lines.push(`    <minor_radius>${source.minorRadius}</minor_radius>`);
            lines.push(`    <elongation>${source.elongation}</elongation>`);
            lines.push(`    <triangularity>${source.triangularity}</triangularity>`);
            lines.push(`    <shafranov_shift>${source.shafranovShift}</shafranov_shift>`);
            lines.push(`    <phi_start>${source.phiStart ?? 0}</phi_start>`);
            lines.push(`    <phi_extent>${source.phiExtent ?? 2 * Math.PI}</phi_extent>`);
            lines.push(`    <n_alpha>${source.nAlpha ?? 101}</n_alpha>`);
            if (source.verticalShift !== undefined && source.verticalShift !== 0) {
                lines.push(`    <vertical_shift>${source.verticalShift}</vertical_shift>`);
            }
            lines.push(`    <r_over_a>${source.profile.map((p: { r: number }) => p.r).join(' ')}</r_over_a>`);
            lines.push(`    <emission_density>${source.profile.map((p: { s: number }) => p.s).join(' ')}</emission_density>`);
            if (source.energy) {
                const energyLines = this.generateEnergyElement(source.energy);
                if (energyLines) {
                    lines.push(energyLines);
                }
            }
            // Optional time distribution (TokamakSource.time; delta is a
            // single-point discrete in OpenMC XML)
            const time = source.time;
            if (time?.type === 'delta' && time.params.time !== undefined) {
                lines.push(`    <time type="discrete">\n      <parameters>${time.params.time} 1</parameters>\n    </time>`);
            } else if (time?.type === 'uniform' && time.params.min !== undefined && time.params.max !== undefined) {
                lines.push(`    <time type="uniform">\n      <parameters>${time.params.min} ${time.params.max}</parameters>\n    </time>`);
            } else if (time?.type === 'discrete' && time.params.times && time.params.times.length > 0) {
                const probs: number[] = time.params.probabilities ?? time.params.times.map(() => 1 / time.params.times!.length);
                const interleaved: number[] = time.params.times.flatMap((v: number, i: number) => [v, probs[i]]);
                lines.push(`    <time type="discrete">\n      <parameters>${interleaved.join(' ')}</parameters>\n    </time>`);
            }
            const tokamakConstraints = this.generateSourceConstraintsElement(source.constraints);
            if (tokamakConstraints) {
                lines.push(tokamakConstraints);
            }
            lines.push('  </source>');
            return lines.join('\n');
        }

        // Independent source below
        // Skip sources without proper spatial definition
        if (!source.spatial || !source.spatial.type) {
            this.log(`Warning: Skipping source with no spatial definition`);
            return '';
        }

        // Source with required attributes (type, strength, particle)
        const strength = source.strength !== undefined ? source.strength : 1.0;
        const particle = source.particle || 'neutron';
        lines.push(`  <source type="independent" strength="${strength}" particle="${particle}">`);

        // Generate spatial distribution with parameters
        const spatialLines = this.generateSpatialElement(source.spatial);
        if (spatialLines) {
            lines.push(spatialLines);
        } else {
            // If we can't generate valid spatial, skip this source
            this.log(`Warning: Skipping source with unsupported spatial type: ${source.spatial.type}`);
            return '';
        }

        if (source.energy) {
            const energyLines = this.generateEnergyElement(source.energy);
            if (energyLines) {
                lines.push(energyLines);
            }
        }

        if (source.angle) {
            const angleLines = this.generateAngleElement(source.angle);
            if (angleLines) {
                lines.push(angleLines);
            }
        }

        const constraintsLines = this.generateSourceConstraintsElement(source.constraints);
        if (constraintsLines) {
            lines.push(constraintsLines);
        }

        lines.push('  </source>');

        return lines.join('\n');
    }

    /**
     * Generate the <constraints> sub-element of a <source> element.
     * Element names match openmc/source.py SourceBase.to_xml_element.
     */
    private generateSourceConstraintsElement(constraints: any): string {
        if (!constraints) {
            return '';
        }
        const lines: string[] = [];
        if (constraints.domainType && constraints.domainIds && constraints.domainIds.length > 0) {
            lines.push(`      <domain_type>${constraints.domainType}</domain_type>`);
            lines.push(`      <domain_ids>${constraints.domainIds.join(' ')}</domain_ids>`);
        }
        if (constraints.timeBounds) {
            lines.push(`      <time_bounds>${constraints.timeBounds.join(' ')}</time_bounds>`);
        }
        if (constraints.energyBounds) {
            lines.push(`      <energy_bounds>${constraints.energyBounds.join(' ')}</energy_bounds>`);
        }
        if (constraints.fissionable !== undefined) {
            lines.push(`      <fissionable>${constraints.fissionable}</fissionable>`);
        }
        if (constraints.rejectionStrategy) {
            lines.push(`      <rejection_strategy>${constraints.rejectionStrategy}</rejection_strategy>`);
        }
        if (lines.length === 0) {
            return '';
        }
        return ['    <constraints>', ...lines, '    </constraints>'].join('\n');
    }

    private generateSpatialElement(spatial: any): string {
        const type = spatial.type;

        switch (type) {
            case 'box':
                const lowerLeft = spatial.lowerLeft || [-10, -10, -10];
                const upperRight = spatial.upperRight || [10, 10, 10];
                return `    <space type="box">\n      <parameters>${lowerLeft.join(' ')} ${upperRight.join(' ')}</parameters>\n    </space>`;

            case 'point':
                const origin = spatial.origin || [0, 0, 0];
                return `    <space type="point">\n      <parameters>${origin.join(' ')}</parameters>\n    </space>`;

            case 'sphere':
                // OpenMC XML uses 'spherical' with independent distributions for r, theta, phi
                const center = spatial.center || [0, 0, 0];
                const radius = spatial.radius !== undefined ? spatial.radius : 1;
                return `    <space type="spherical" origin="${center.join(' ')}">\n      <r type="uniform" parameters="0 ${radius}"/>\n      <cos_theta type="uniform" parameters="-1 1"/>\n      <phi type="uniform" parameters="0 6.28318530718"/>\n    </space>`;

            case 'cylinder':
                // OpenMC XML uses 'cylindrical' with independent distributions for r, phi, z
                const cylCenter = spatial.center || [0, 0, 0];
                const cylRadius = spatial.radius !== undefined ? spatial.radius : 1;
                const height = spatial.height !== undefined ? spatial.height : 1;
                return `    <space type="cylindrical" origin="${cylCenter.join(' ')}">\n      <r type="uniform" parameters="0 ${cylRadius}"/>\n      <phi type="uniform" parameters="0 6.28318530718"/>\n      <z type="uniform" parameters="-${height / 2} ${height / 2}"/>\n    </space>`;

            default:
                this.log(`Warning: Unknown spatial type '${type}', using default box`);
                return '    <space type="box">\n      <parameters>-10 -10 -10 10 10 10</parameters>\n    </space>';
        }
    }

    private generateEnergyElement(energy: any): string {
        const type = energy.type;

        switch (type) {
            case 'discrete':
                const energies = energy.energies || [1e6];
                // For discrete energy, parameters are: energy1 prob1 energy2 prob2 ...
                // If only energies provided, assume equal probability (sum to 1)
                const params: string[] = [];
                const prob = 1.0 / energies.length;
                for (const e of energies) {
                    params.push(String(e));
                    params.push(String(prob));
                }
                return `    <energy type="discrete">\n      <parameters>${params.join(' ')}</parameters>\n    </energy>`;

            case 'uniform':
                const min = energy.min !== undefined ? energy.min : 1e-5;
                const max = energy.max !== undefined ? energy.max : 2e7;
                return `    <energy type="uniform">\n      <parameters>${min} ${max}</parameters>\n    </energy>`;

            case 'maxwell':
                const temp = energy.temperature || 0.025;
                return `    <energy type="maxwell">\n      <parameters>${temp}</parameters>\n    </energy>`;

            case 'watt':
                const a = energy.a || 0.988;
                const b = energy.b || 2.249;
                return `    <energy type="watt">\n      <parameters>${a} ${b}</parameters>\n    </energy>`;

            case 'normal': {
                return `    <energy type="normal">\n      <parameters>${energy.mean} ${energy.stdDev}</parameters>\n    </energy>`;
            }

            case 'muir': {
                // muir() is a function returning a Normal in this OpenMC
                // version: std_dev = sqrt(2 * e0 * kt / m_rat); XML is type
                // 'normal' (univariate.py:1243-1267)
                const stdDev = Math.sqrt((2 * energy.e0 * energy.kt) / energy.m_rat);
                return `    <energy type="normal">\n      <parameters>${energy.e0} ${stdDev}</parameters>\n    </energy>`;
            }

            case 'tabular':
                this.log(`Warning: Energy type '${type}' not fully implemented`);
                return '';

            default:
                return '';
        }
    }

    private generateAngleElement(angle: any): string {
        const type = angle.type;

        switch (type) {
            case 'isotropic':
                return '    <angle type="isotropic"/>';

            case 'monodirectional':
                return '    <angle type="monodirectional"/>';

            default:
                this.log(`Warning: Angle type '${type}' not fully implemented`);
                return '';
        }
    }

    // ============================================================================
    // Tallies XML
    // ============================================================================

    /**
     * Generate tallies.xml from state tallies and meshes.
     * @param state - Simulation state
     * @returns tallies.xml content
     */

    /**
     * IDs of meshes emitted into settings.xml by settings-level features:
     * mesh sources, the Shannon entropy mesh, the random ray source-region
     * mesh, and variance-reduction meshes (weight windows, WW generator,
     * UFS). tallies.xml must skip these (OpenMC mesh_memo pattern,
     * model.py:714/749) — duplicates trigger 'Mesh with ID=N appears in
     * multiple files'.
     * @param state - Simulation state.
     * @returns Set of mesh IDs that live in settings.xml.
     */
    private getSettingsMeshIds(state: OpenMCState): Set<number> {
        const ids = new Set<number>();
        for (const source of state.settings.sources ?? []) {
            if (source.type === 'mesh' && source.meshId !== undefined) {
                ids.add(source.meshId);
            }
        }
        if (state.settings.entropyMesh) {
            ids.add(state.settings.entropyMesh.id ?? 10000);
        }
        // The random ray and variance-reduction emitters only write regular
        // meshes that exist in state.meshes — mirror that here so tallies.xml
        // never skips a mesh settings.xml did not actually emit
        const emittedRegularMesh = (id: number | undefined): boolean =>
            id !== undefined && state.meshes.some((m) => m.id === id && m.type === 'regular');
        if (emittedRegularMesh(state.settings.randomRay?.sourceRegionMeshId)) {
            ids.add(state.settings.randomRay!.sourceRegionMeshId!);
        }
        const vr = state.varianceReduction;
        if (vr) {
            if (vr.weightWindowGenerator) {
                const wwgMeshId = vr.weightWindowGenerator.meshId ?? vr.weightWindows?.meshId ?? vr.ufs?.meshId ?? 1;
                if (emittedRegularMesh(wwgMeshId)) {
                    ids.add(wwgMeshId);
                }
            }
            if (emittedRegularMesh(vr.weightWindows?.meshId)) {
                ids.add(vr.weightWindows!.meshId!);
            }
            if (vr.ufs?.enabled && emittedRegularMesh(vr.ufs.meshId)) {
                ids.add(vr.ufs.meshId!);
            }
        }
        return ids;
    }

    private generateTalliesXML(state: OpenMCState, warnings?: string[]): string {
        const lines: string[] = ['<?xml version="1.0"?>', '<tallies>', ''];

        // Add meshes first. Meshes referenced by settings-level features live
        // in settings.xml instead (OpenMC mesh_memo pattern: settings is
        // written first and tallies.xml must not repeat those ids,
        // model.py:714/749 — duplicates trigger 'Mesh with ID=N appears in
        // multiple files').
        const settingsMeshIds = this.getSettingsMeshIds(state);
        for (const mesh of state.meshes) {
            if (!settingsMeshIds.has(mesh.id)) {
                lines.push(this.generateMeshElement(mesh));
            }
        }

        // Auto-append IFP kinetics tallies when enabled (skips scores already defined by the user).
        // IFP scores are continuous-energy only — random ray (multi-group) rejects them.
        const effectiveTallies = [...state.tallies];
        if (state.settings.kinetics?.enabled) {
            if (state.settings.energyMode === 'multigroup') {
                warnings?.push(
                    'IFP kinetics is not supported in random ray mode — the auto-generated IFP tallies were not written to tallies.xml (disable kinetics in the Simulation tab)'
                );
            } else {
                const maxTallyId = state.tallies.reduce((max, t) => Math.max(max, t.id), 0);
                effectiveTallies.push(...getAutoIfpTallies(state.tallies, state.settings.kinetics, maxTallyId + 1));
            }
        }

        // Collect all unique filters and assign them IDs
        const filterMap = new Map<string, { id: number } & OpenMCTally['filters'][number]>();
        let nextFilterId = 1;

        for (const tally of effectiveTallies) {
            for (const filter of tally.filters) {
                // Create a unique key for this filter
                const key = this.getFilterKey(filter);
                if (!filterMap.has(key)) {
                    // Keep the full filter (order/axis/energy values etc.) for element generation
                    filterMap.set(key, { ...filter, id: nextFilterId++ });
                }
            }
        }

        // Collect all unique derivatives and assign IDs (top-level
        // <derivative> elements referenced by tallies, per
        // tallies.py _create_derivative_subelements)
        const derivativeIds = new Map<NonNullable<OpenMCTally['derivative']>, number>();
        let nextDerivativeId = 1;
        for (const tally of effectiveTallies) {
            if (tally.derivative) {
                if (!derivativeIds.has(tally.derivative)) {
                    derivativeIds.set(tally.derivative, tally.derivative.id ?? nextDerivativeId++);
                }
            }
        }

        // Generate derivative elements at the top level
        for (const [derivative, id] of derivativeIds) {
            const nuclideAttr = derivative.variable === 'nuclide_density' && derivative.nuclide ? ` nuclide="${derivative.nuclide}"` : '';
            lines.push(`  <derivative id="${id}" variable="${derivative.variable}" material="${derivative.materialId}"${nuclideAttr}/>`);
            lines.push('');
        }

        // Generate filter elements at the top level
        for (const filter of filterMap.values()) {
            lines.push(this.generateFilterElement(filter));
        }

        // Add tallies with filter references
        for (const tally of effectiveTallies) {
            lines.push(this.generateTallyElement(tally, filterMap, derivativeIds));
        }

        lines.push('</tallies>');

        return lines.join('\n');
    }

    private getFilterKey(filter: any): string {
        // Create a unique key based on filter type, bins, meshId, and parameter fields
        const baseKey = `${filter.type}:${filter.bins.join(',')}`;
        const paramKey = [
            filter.meshId,
            filter.order,
            filter.axis,
            filter.min,
            filter.max,
            filter.cosine,
            filter.center ? `${filter.center.x},${filter.center.y},${filter.center.r}` : undefined,
            filter.energyValues?.join(','),
            filter.responseValues?.join(','),
            filter.interpolation
        ]
            .filter((v) => v !== undefined)
            .join(':');
        return paramKey ? `${baseKey}:${paramKey}` : baseKey;
    }

    private generateMeshElement(mesh: OpenMCMesh): string {
        const lines: string[] = [];

        if (mesh.type === 'regular') {
            const regularMesh = mesh as OpenMCRegularMesh;
            lines.push(`  <mesh id="${mesh.id}" type="regular">`);
            lines.push(`    <lower_left>${regularMesh.lowerLeft.join(' ')}</lower_left>`);
            lines.push(`    <upper_right>${regularMesh.upperRight.join(' ')}</upper_right>`);
            lines.push(`    <dimension>${regularMesh.dimension.join(' ')}</dimension>`);
            lines.push('  </mesh>');
        } else if (mesh.type === 'cylindrical') {
            const cylMesh = mesh as OpenMCCylindricalMesh;
            lines.push(`  <mesh id="${mesh.id}" type="cylindrical">`);
            if (cylMesh.origin) {
                lines.push(`    <origin>${cylMesh.origin.join(' ')}</origin>`);
            }
            if (cylMesh.axis) {
                lines.push(`    <axis>${cylMesh.axis.join(' ')}</axis>`);
            }
            lines.push(`    <r_grid>${cylMesh.rGrid.join(' ')}</r_grid>`);
            lines.push(`    <phi_grid>${cylMesh.phiGrid.join(' ')}</phi_grid>`);
            lines.push(`    <z_grid>${cylMesh.zGrid.join(' ')}</z_grid>`);
            lines.push('  </mesh>');
        } else if (mesh.type === 'spherical') {
            const sphMesh = mesh as OpenMCSphericalMesh;
            lines.push(`  <mesh id="${mesh.id}" type="spherical">`);
            if (sphMesh.origin) {
                lines.push(`    <origin>${sphMesh.origin.join(' ')}</origin>`);
            }
            lines.push(`    <r_grid>${sphMesh.rGrid.join(' ')}</r_grid>`);
            lines.push(`    <theta_grid>${sphMesh.thetaGrid.join(' ')}</theta_grid>`);
            lines.push(`    <phi_grid>${sphMesh.phiGrid.join(' ')}</phi_grid>`);
            lines.push('  </mesh>');
        }

        lines.push('');
        return lines.join('\n');
    }
    private generateTallyElement(
        tally: OpenMCTally,
        filterMap: Map<string, any>,
        derivativeIds?: Map<NonNullable<OpenMCTally['derivative']>, number>
    ): string {
        const lines: string[] = [];

        const nameAttr = tally.name ? ` name="${this.escapeXml(tally.name)}"` : '';
        const multiplyDensityAttr = tally.multiplyDensity === false ? ' multiply_density="false"' : '';
        lines.push(`  <tally id="${tally.id}"${nameAttr}${multiplyDensityAttr}>`);

        // Collect filter IDs for this tally
        const filterIds: number[] = [];
        for (const filter of tally.filters) {
            const key = this.getFilterKey(filter);
            const filterDef = filterMap.get(key);
            if (filterDef) {
                filterIds.push(filterDef.id);
            }
        }

        // Add filters reference if there are any filters
        if (filterIds.length > 0) {
            lines.push(`    <filters>${filterIds.join(' ')}</filters>`);
        }

        // Add nuclides (space-separated in a single element, per real OpenMC)
        if (tally.nuclides.length > 0) {
            lines.push(`    <nuclides>${tally.nuclides.join(' ')}</nuclides>`);
        }

        // Add scores - space-separated in a single element
        if (tally.scores.length > 0) {
            lines.push(`    <scores>${tally.scores.join(' ')}</scores>`);
        }

        // Estimator
        if (tally.estimator) {
            lines.push(`    <estimator>${tally.estimator}</estimator>`);
        }

        // Derivative reference (the <derivative> elements live at the
        // tallies root; the tally carries the ID as text, tallies.py:1477-1480)
        if (tally.derivative && derivativeIds) {
            const derivativeId = derivativeIds.get(tally.derivative);
            if (derivativeId !== undefined) {
                lines.push(`    <derivative>${derivativeId}</derivative>`);
            }
        }

        // Per-tally triggers (openmc/trigger.py Trigger.to_xml_element:
        // scores is a space-separated ATTRIBUTE, not a sub-element)
        for (const trigger of tally.triggers ?? []) {
            const scoresAttr = trigger.scores && trigger.scores.length > 0 ? ` scores="${trigger.scores.join(' ')}"` : '';
            const ignoreZerosAttr = trigger.ignoreZeros ? ' ignore_zeros="true"' : '';
            lines.push(`    <trigger type="${trigger.type}" threshold="${trigger.threshold}"${scoresAttr}${ignoreZerosAttr}/>`);
        }

        lines.push('  </tally>');
        lines.push('');

        return lines.join('\n');
    }

    private generateFilterElement(filter: any): string {
        const lines: string[] = [];

        switch (filter.type) {
            case 'mesh':
            case 'meshsurface':
                // Mesh-based filters reference the mesh ID in <bins>
                lines.push(`  <filter id="${filter.id}" type="${filter.type}">`);
                lines.push(`    <bins>${filter.meshId ?? filter.bins.join(' ')}</bins>`);
                break;

            case 'legendre':
            case 'spatiallegendre':
            case 'sphericalharmonics':
            case 'zernike':
            case 'zernikeradial': {
                // Expansion filters carry an order (and type-specific extras), no bins
                const cosineAttr = filter.type === 'sphericalharmonics' && filter.cosine ? ` cosine="${filter.cosine}"` : '';
                lines.push(`  <filter id="${filter.id}" type="${filter.type}"${cosineAttr}>`);
                lines.push(`    <order>${filter.order ?? 0}</order>`);
                if (filter.type === 'spatiallegendre') {
                    lines.push(`    <axis>${filter.axis ?? 'z'}</axis>`);
                    lines.push(`    <min>${filter.min ?? 0}</min>`);
                    lines.push(`    <max>${filter.max ?? 0}</max>`);
                }
                if (filter.type === 'zernike' || filter.type === 'zernikeradial') {
                    const center = filter.center ?? { x: 0, y: 0, r: 1 };
                    lines.push(`    <x>${center.x}</x>`);
                    lines.push(`    <y>${center.y}</y>`);
                    lines.push(`    <r>${center.r}</r>`);
                }
                break;
            }

            case 'energyfunction':
                // Energy-function filters carry an energy grid, response values, and interpolation
                lines.push(`  <filter id="${filter.id}" type="energyfunction">`);
                lines.push(`    <energy>${(filter.energyValues ?? []).join(' ')}</energy>`);
                lines.push(`    <y>${(filter.responseValues ?? []).join(' ')}</y>`);
                lines.push(`    <interpolation>${filter.interpolation ?? 'linear-linear'}</interpolation>`);
                break;

            case 'particle':
                // Particle filter bins are particle names in real OpenMC XML
                lines.push(`  <filter id="${filter.id}" type="particle">`);
                lines.push(`    <bins>${filter.bins.map((b: number) => (b === 2 ? 'photon' : 'neutron')).join(' ') || 'neutron'}</bins>`);
                break;

            default:
                lines.push(`  <filter id="${filter.id}" type="${filter.type}">`);
                lines.push(`    <bins>${filter.bins.join(' ')}</bins>`);
        }
        lines.push('  </filter>');
        lines.push('');

        return lines.join('\n');
    }

    // ============================================================================
    // Plots XML
    // ============================================================================

    /**
     * Generate plots.xml from state plot configurations.
     * @param state - Simulation state
     * @returns plots.xml content
     */

    private generatePlotsXML(state: OpenMCState): string {
        const lines: string[] = ['<?xml version="1.0"?>', '<plots>', ''];

        for (const plot of state.plots || []) {
            lines.push(this.generatePlotElement(plot));
        }

        lines.push('</plots>');

        return lines.join('\n');
    }

    private generatePlotElement(plot: any): string {
        const lines: string[] = [];
        const nameAttr = plot.name ? ` name="${this.escapeXml(plot.name)}"` : '';
        const colorBy = plot.colorBy === 'material' ? 'material' : 'cell';

        if (plot.type === 'slice') {
            // Real OpenMC slice: 2-value pixels and width (openmc/plots.py SlicePlot.to_xml_element)
            lines.push(`  <plot id="${plot.id}" type="slice" basis="${plot.basis}" color_by="${colorBy}"${nameAttr}>`);
            lines.push(`    <pixels>${(plot.pixels ?? [1000, 1000]).join(' ')}</pixels>`);
            lines.push(`    <origin>${plot.origin.join(' ')}</origin>`);
            lines.push(`    <width>${plot.width ?? 10} ${plot.height ?? 10}</width>`);
            if (plot.meshlines) {
                lines.push(`    <meshlines meshtype="tally"/>`);
            }
        } else if (plot.type === 'voxel') {
            // Real OpenMC voxel: center origin + 3-value width + voxel counts in pixels
            lines.push(`  <plot id="${plot.id}" type="voxel" color_by="${colorBy}"${nameAttr}>`);
            lines.push(`    <pixels>${(plot.voxels ?? [50, 50, 50]).join(' ')}</pixels>`);
            const lowerLeft = plot.lowerLeft;
            const upperRight = plot.upperRight;
            const origin =
                lowerLeft && upperRight ? lowerLeft.map((v: number, i: number) => (v + upperRight[i]) / 2) : (plot.origin ?? [0, 0, 0]);
            const width = lowerLeft && upperRight ? lowerLeft.map((v: number, i: number) => upperRight[i] - v) : [10, 10, 10];
            lines.push(`    <origin>${origin.join(' ')}</origin>`);
            lines.push(`    <width>${width.join(' ')}</width>`);
        } else {
            // Ray-trace plots (openmc/plots.py RayTracePlot/WireframeRayTracePlot/SolidRayTracePlot)
            const xmlType = plot.type === 'solid-raytrace' ? 'solid_raytrace' : 'wireframe_raytrace';
            lines.push(`  <plot id="${plot.id}" type="${xmlType}" color_by="${colorBy}"${nameAttr}>`);
            lines.push(`    <pixels>${(plot.pixels ?? [1000, 1000]).join(' ')}</pixels>`);
            lines.push(`    <camera_position>${(plot.cameraPosition ?? [1, 0, 0]).join(' ')}</camera_position>`);
            lines.push(`    <look_at>${(plot.lookAt ?? [0, 0, 0]).join(' ')}</look_at>`);
            lines.push(`    <horizontal_field_of_view>${plot.horizontalFieldOfView ?? 70}</horizontal_field_of_view>`);
            if (plot.orthographicWidth) {
                lines.push(`    <orthographic_width>${plot.orthographicWidth}</orthographic_width>`);
            }
            if (plot.type === 'solid-raytrace') {
                if (plot.lightPosition) {
                    lines.push(`    <light_position>${plot.lightPosition.join(' ')}</light_position>`);
                }
                if (plot.diffuseFraction !== undefined) {
                    lines.push(`    <diffuse_fraction>${plot.diffuseFraction}</diffuse_fraction>`);
                }
                lines.push(`    <opaque_ids>${(plot.opaqueIds ?? []).join(' ')}</opaque_ids>`);
            } else {
                lines.push(`    <wireframe_thickness>${plot.wireframeThickness ?? 1}</wireframe_thickness>`);
                lines.push(`    <wireframe_color>${(plot.wireframeColor ?? [0, 0, 0]).join(' ')}</wireframe_color>`);
                if (plot.wireframeIds && plot.wireframeIds.length > 0) {
                    lines.push(`    <wireframe_ids>${plot.wireframeIds.join(' ')}</wireframe_ids>`);
                }
            }
        }

        lines.push('  </plot>');
        lines.push('');

        return lines.join('\n');
    }

    // ============================================================================
    // Utilities
    // ============================================================================

    /**
     * Escape special XML characters in text content.
     * @param text - Raw text to escape
     * @returns Escaped XML-safe text
     */

    private escapeXml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }
}
