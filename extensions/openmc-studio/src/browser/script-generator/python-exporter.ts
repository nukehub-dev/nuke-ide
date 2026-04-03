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
 * Python Script Generator
 * 
 * Generates OpenMC Python scripts from the simulation state.
 * Supports exporting as single model.py or separate files.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileDialogService, SaveFileDialogProps } from '@theia/filesystem/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';

import { BinaryBuffer } from '@theia/core/lib/common/buffer';

import { OpenMCStateManager } from '../openmc-state-manager';
import {
    OpenMCState,
    OpenMCMaterial,
    OpenMCSurface,
    OpenMCCell,
    OpenMCTally,
    OpenMCMesh,
    OpenMCRegularMesh,
    OpenMCCylindricalMesh,
    OpenMCSphericalMesh,
    OpenMCSource,
    OpenMCEigenvalueSettings,
    OpenMCFixedSourceSettings
} from '../../common/openmc-state-schema';

export interface PythonExportOptions {
    /** Export as single file or separate files */
    mode: 'single' | 'separate';
    /** Output directory for separate files mode */
    outputDirectory?: string;
    /** Include comments in generated code */
    includeComments?: boolean;
    /** Include shebang line (#!/usr/bin/env python3) */
    includeShebang?: boolean;
}

export interface PythonExportResult {
    success: boolean;
    files: string[];
    error?: string;
}

@injectable()
export class OpenMCPythonExporter {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;
    
    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;
    
    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileService)
    protected readonly fileService: FileService;

    /**
     * Export current state to Python script(s).
     */
    async exportToPython(options?: Partial<PythonExportOptions>): Promise<PythonExportResult> {
        const state = this.stateManager.getState();
        const defaultOptions: PythonExportOptions = {
            mode: 'single',
            includeComments: true,
            includeShebang: true,
            ...options
        };

        try {
            if (defaultOptions.mode === 'single') {
                return await this.exportSingleFile(state, defaultOptions);
            } else {
                return await this.exportSeparateFiles(state, defaultOptions);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Export failed: ${msg}`);
            return { success: false, files: [], error: msg };
        }
    }

    /**
     * Export as a single model.py file.
     */
    private async exportSingleFile(state: OpenMCState, options: PythonExportOptions): Promise<PythonExportResult> {
        const props: SaveFileDialogProps = {
            title: 'Export OpenMC Python Script',
            inputValue: 'model.py',
            filters: {
                'Python Files': ['py'],
                'All Files': ['*']
            }
        };

        const uri = await this.fileDialogService.showSaveDialog(props);
        if (!uri) {
            return { success: false, files: [] };
        }

        const pythonCode = this.generateModelScript(state, options);
        
        // Use the backend to write the file
        await this.writeFile(uri, pythonCode);
        
        this.messageService.info(`Exported Python script: ${uri.path.name}`);
        return { success: true, files: [uri.toString()] };
    }

    /**
     * Export as separate files (materials.py, geometry.py, settings.py, tallies.py, plots.py).
     */
    private async exportSeparateFiles(state: OpenMCState, options: PythonExportOptions): Promise<PythonExportResult> {
        const props: SaveFileDialogProps = {
            title: 'Select Directory for Python Scripts',
            inputValue: 'openmc_model',
            filters: {
                'All Files': ['*']
            }
        };

        const uri = await this.fileDialogService.showSaveDialog(props);
        if (!uri) {
            return { success: false, files: [] };
        }

        const files: string[] = [];
        const baseUri = uri.parent;
        
        if (!baseUri) {
            return { success: false, files: [], error: 'Invalid directory' };
        }

        // Generate and write each file
        const fileGenerators = [
            { name: 'materials.py', generator: () => this.generateMaterialsScript(state, options) },
            { name: 'geometry.py', generator: () => this.generateGeometryScript(state, options) },
            { name: 'settings.py', generator: () => this.generateSettingsScript(state, options) },
            { name: 'tallies.py', generator: () => this.generateTallyMeshScript(state, options) }
        ];

        // Add plots.py if plots exist
        if (state.plots && state.plots.length > 0) {
            fileGenerators.push({ name: 'plots.py', generator: () => this.generatePlotsScript(state, options) });
        }

        // Generate model.py that imports all modules
        fileGenerators.push({ name: 'model.py', generator: () => this.generateMainModelScript(state, options) });

        for (const { name, generator } of fileGenerators) {
            const content = generator();
            const fileUri = baseUri.resolve(name);
            await this.writeFile(fileUri, content);
            files.push(fileUri.toString());
        }

        this.messageService.info(`Exported ${files.length} Python scripts`);
        return { success: true, files };
    }

    /**
     * Write content to a file using the file service.
     */
    private async writeFile(uri: URI, content: string): Promise<void> {
        const encoder = new TextEncoder();
        const data = BinaryBuffer.wrap(encoder.encode(content));
        
        try {
            await this.fileService.writeFile(uri, data);
        } catch (e) {
            // If file doesn't exist, writeFile might fail in some implementations
            // but in Theia it should create it. Just in case:
            await this.fileService.createFile(uri, data);
        }
    }

    // ============================================================================
    // Script Generators
    // ============================================================================

    /**
     * Generate complete model.py script.
     */
    private generateModelScript(state: OpenMCState, options: PythonExportOptions): string {
        const lines: string[] = [];
        
        if (options.includeShebang) {
            lines.push('#!/usr/bin/env python3');
            lines.push('');
        }
        
        if (options.includeComments) {
            lines.push(`# OpenMC Model Script`);
            lines.push(`# Generated by OpenMC Studio`);
            lines.push(`# Project: ${state.metadata.name}`);
            lines.push(`# Date: ${new Date().toISOString()}`);
            lines.push('');
        }
        
        lines.push('import openmc');
        if (state.depletion?.enabled) {
            lines.push('import openmc.deplete');
        }
        lines.push('');
        
        // Materials
        if (state.materials.length > 0) {
            lines.push(...this.generateMaterialsCode(state, options));
            lines.push('');
        }
        
        // Geometry
        lines.push(...this.generateGeometryCode(state, options));
        lines.push('');
        
        // Tallies & Meshes (needed before settings for VR)
        if (state.tallies.length > 0 || state.meshes.length > 0) {
            lines.push(...this.generateTallyMeshCode(state, options));
            lines.push('');
        }
        
        // Settings
        lines.push(...this.generateSettingsCode(state, options));
        lines.push('');
        
        // Plots
        if (state.plots && state.plots.length > 0) {
            lines.push(...this.generatePlotsCode(state, options));
            lines.push('');
        }
        
        // Model object
        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Model');
            lines.push('#==============================================================================');
        }
        
        const materialsArg = state.materials.length > 0 ? 'materials=materials' : '';
        const talliesArg = state.tallies.length > 0 ? ', tallies=tallies' : '';
        const plotsArg = (state.plots && state.plots.length > 0) ? ', plots=plots' : '';
        
        lines.push(`model = openmc.Model(geometry=geometry, ${materialsArg}${talliesArg}${plotsArg}, settings=settings)`);
        lines.push('');

        // Depletion section
        if (state.depletion?.enabled) {
            lines.push(...this.generateDepletionCode(state));
            lines.push('');
        }
        
        // Export section
        if (options.includeComments) {
            lines.push('# Export to XML files');
        }
        
        lines.push('model.export_to_xml()');
        
        lines.push('');
        if (state.depletion?.enabled) {
            lines.push('print("OpenMC depletion model exported successfully!")');
            lines.push('print("Run with: python model.py")');
        } else {
            lines.push('print("OpenMC model exported successfully!")');
            lines.push('print("Run with: openmc")');
        }
        
        return lines.join('\n');
    }

    /**
     * Generate materials.py script.
     */
    private generateMaterialsScript(state: OpenMCState, options: PythonExportOptions): string {
        const lines: string[] = [];
        
        if (options.includeShebang) {
            lines.push('#!/usr/bin/env python3');
            lines.push('');
        }
        
        if (options.includeComments) {
            lines.push('# Materials definition for OpenMC');
            lines.push(`# Project: ${state.metadata.name}`);
            lines.push('');
        }
        
        lines.push('import openmc');
        lines.push('');
        
        lines.push(...this.generateMaterialsCode(state, options));
        
        return lines.join('\n');
    }

    /**
     * Generate geometry.py script.
     */
    private generateGeometryScript(state: OpenMCState, options: PythonExportOptions): string {
        const lines: string[] = [];
        
        if (options.includeShebang) {
            lines.push('#!/usr/bin/env python3');
            lines.push('');
        }
        
        if (options.includeComments) {
            lines.push('# Geometry definition for OpenMC');
            lines.push(`# Project: ${state.metadata.name}`);
            lines.push('');
        }
        
        lines.push('import openmc');
        lines.push('');
        
        lines.push(...this.generateGeometryCode(state, options));
        
        return lines.join('\n');
    }

    /**
     * Generate settings.py script.
     */
    private generateSettingsScript(state: OpenMCState, options: PythonExportOptions): string {
        const lines: string[] = [];
        
        if (options.includeShebang) {
            lines.push('#!/usr/bin/env python3');
            lines.push('');
        }
        
        if (options.includeComments) {
            lines.push('# Settings definition for OpenMC');
            lines.push(`# Project: ${state.metadata.name}`);
            lines.push('');
        }
        
        lines.push('import openmc');
        lines.push('');
        
        lines.push(...this.generateSettingsCode(state, options));
        
        return lines.join('\n');
    }

    /**
     * Generate tallies.py script.
     */
    private generateTallyMeshScript(state: OpenMCState, options: PythonExportOptions): string {
        const lines: string[] = [];
        
        if (options.includeShebang) {
            lines.push('#!/usr/bin/env python3');
            lines.push('');
        }
        
        if (options.includeComments) {
            lines.push('# Tallies definition for OpenMC');
            lines.push(`# Project: ${state.metadata.name}`);
            lines.push('');
        }
        
        lines.push('import openmc');
        lines.push('');
        
        lines.push(...this.generateTallyMeshCode(state, options));
        
        return lines.join('\n');
    }

    /**
     * Generate plots.py script.
     */
    private generatePlotsScript(state: OpenMCState, options: PythonExportOptions): string {
        const lines: string[] = [];
        
        if (options.includeShebang) {
            lines.push('#!/usr/bin/env python3');
            lines.push('');
        }
        
        if (options.includeComments) {
            lines.push('# Plots definition for OpenMC');
            lines.push(`# Project: ${state.metadata.name}`);
            lines.push('');
        }
        
        lines.push('import openmc');
        lines.push('');
        
        lines.push(...this.generatePlotsCode(state, options));
        
        return lines.join('\n');
    }

    /**
     * Generate main model.py that imports all modules.
     */
    private generateMainModelScript(state: OpenMCState, options: PythonExportOptions): string {
        const lines: string[] = [];
        
        if (options.includeShebang) {
            lines.push('#!/usr/bin/env python3');
            lines.push('');
        }
        
        if (options.includeComments) {
            lines.push('# Main OpenMC Model Script');
            lines.push(`# Project: ${state.metadata.name}`);
            lines.push('# This script imports and exports all model components');
            lines.push('');
        }
        
        lines.push('import materials');
        lines.push('import geometry');
        lines.push('import settings');
        
        if (state.tallies.length > 0) {
            lines.push('import tallies');
        }
        
        if (state.plots && state.plots.length > 0) {
            lines.push('import plots');
        }
        
        lines.push('');
        
        if (options.includeComments) {
            lines.push('# Export all to XML');
        }
        
        lines.push('materials.materials.export_to_xml()');
        lines.push('geometry.geometry.export_to_xml()');
        lines.push('settings.settings.export_to_xml()');
        
        if (state.tallies.length > 0) {
            lines.push('tallies.tallies.export_to_xml()');
        }
        
        if (state.plots && state.plots.length > 0) {
            lines.push('plots.plots.export_to_xml()');
        }
        
        lines.push('');
        lines.push('print("OpenMC model exported successfully!")');
        
        return lines.join('\n');
    }

    // ============================================================================
    // Code Generators
    // ============================================================================

    private generateMaterialsCode(state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];
        
        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Materials');
            lines.push('#==============================================================================');
        }
        
        for (const material of state.materials) {
            lines.push(...this.generateMaterialCode(material));
        }
        
        lines.push('');
        lines.push(`materials = openmc.Materials([${state.materials.map(m => this.sanitizeVariableName(m.name)).join(', ')}])`);
        
        return lines;
    }

    private generateMaterialCode(material: OpenMCMaterial): string[] {
        const lines: string[] = [];
        const varName = this.sanitizeVariableName(material.name);
        
        lines.push(`${varName} = openmc.Material(name="${this.escapePythonString(material.name)}", material_id=${material.id})`);
        
        // Add nuclides and elements
        for (const nuclide of material.nuclides) {
            const percentType = nuclide.fractionType === 'wo' ? 'wo' : 'ao';
            // Simple heuristic to distinguish between nuclide (e.g., U235) and element (e.g., U)
            // Nuclides usually have numbers at the end
            if (/\d+$/.test(nuclide.name)) {
                lines.push(`${varName}.add_nuclide("${nuclide.name}", ${nuclide.fraction}, percent_type="${percentType}")`);
            } else {
                lines.push(`${varName}.add_element("${nuclide.name}", ${nuclide.fraction}, percent_type="${percentType}")`);
            }
        }
        
        // Set density
        if (material.densityUnit !== 'sum') {
            lines.push(`${varName}.set_density("${material.densityUnit}", ${material.density})`);
        }
        
        // Add S(alpha, beta) if present
        for (const sab of material.thermalScattering) {
            lines.push(`${varName}.add_s_alpha_beta("${sab.name}")`);
        }
        
        // Set depletable and volume if specified
        if (material.isDepletable) {
            lines.push(`${varName}.depletable = True`);
        }
        if (material.volume) {
            lines.push(`${varName}.volume = ${material.volume}`);
        }
        if (material.temperature) {
            lines.push(`${varName}.temperature = ${material.temperature}`);
        }
        
        lines.push('');
        return lines;
    }

    private generateGeometryCode(state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];
        
        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Geometry');
            lines.push('#==============================================================================');
        }
        
        // Generate surfaces
        if (state.geometry.surfaces.length > 0) {
            if (options.includeComments) {
                lines.push('# Surfaces');
            }
            for (const surface of state.geometry.surfaces) {
                lines.push(...this.generateSurfaceCode(surface));
            }
            lines.push('');
        }
        
        // Generate cells
        if (state.geometry.cells.length > 0) {
            if (options.includeComments) {
                lines.push('# Cells');
            }
            for (const cell of state.geometry.cells) {
                lines.push(...this.generateCellCode(cell, state));
            }
            lines.push('');
        }
        
        // Create geometry object
        if (state.geometry.cells.length > 0) {
            const cellVars = state.geometry.cells.map(c => `cell_${c.id}`).join(', ');
            lines.push(`geometry = openmc.Geometry([${cellVars}])`);
        } else if (state.settings.dagmcFile) {
            if (options.includeComments) {
                lines.push('# DAGMC geometry - uses CAD-based mesh geometry');
            }
            lines.push('dagmc_univ = openmc.DAGMCUniverse(filename="geometry.h5m")');
            lines.push('geometry = openmc.Geometry(dagmc_univ)');
        } else {
            // Ensure we have at least a root universe, even if empty
            lines.push('root_univ = openmc.Universe(universe_id=0, name="root universe")');
            lines.push('geometry = openmc.Geometry(root_univ)');
        }
        
        return lines;
    }

    private generateSurfaceCode(surface: OpenMCSurface): string[] {
        const lines: string[] = [];
        const coeffs = surface.coefficients as any;
        
        let constructor = '';
        switch (surface.type) {
            case 'sphere':
                constructor = `openmc.Sphere(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, z0=${coeffs.z0}, r=${coeffs.r}`;
                break;
            case 'x-cylinder':
                constructor = `openmc.XCylinder(surface_id=${surface.id}, y0=${coeffs.y0}, z0=${coeffs.z0}, r=${coeffs.r}`;
                break;
            case 'y-cylinder':
                constructor = `openmc.YCylinder(surface_id=${surface.id}, x0=${coeffs.x0}, z0=${coeffs.z0}, r=${coeffs.r}`;
                break;
            case 'z-cylinder':
                constructor = `openmc.ZCylinder(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, r=${coeffs.r}`;
                break;
            case 'x-plane':
                constructor = `openmc.XPlane(surface_id=${surface.id}, x0=${coeffs.x0}`;
                break;
            case 'y-plane':
                constructor = `openmc.YPlane(surface_id=${surface.id}, y0=${coeffs.y0}`;
                break;
            case 'z-plane':
                constructor = `openmc.ZPlane(surface_id=${surface.id}, z0=${coeffs.z0}`;
                break;
            case 'plane':
                constructor = `openmc.Plane(surface_id=${surface.id}, a=${coeffs.a}, b=${coeffs.b}, c=${coeffs.c}, d=${coeffs.d}`;
                break;
            default:
                constructor = `# Surface type ${surface.type} not implemented`;
                lines.push(`surface_${surface.id} = ${constructor}`);
                return lines;
        }
        
        // Add boundary condition
        if (surface.boundary && surface.boundary !== 'transmission') {
            constructor += `, boundary_type="${surface.boundary}"`;
        }
        
        constructor += ')';
        lines.push(`surface_${surface.id} = ${constructor}`);
        
        return lines;
    }

    private generateCellCode(cell: OpenMCCell, state: OpenMCState): string[] {
        const lines: string[] = [];
        
        let region = '';
        if (cell.regionString) {
            // Parse region string and convert to Python
            region = this.convertRegionStringToPython(cell.regionString);
        } else if (cell.region) {
            region = this.convertRegionNodeToPython(cell.region);
        }
        
        let fill = '';
        if (cell.fillType === 'material' && cell.fillId !== undefined) {
            const material = state.materials.find(m => m.id === cell.fillId);
            if (material) {
                fill = `fill=${this.sanitizeVariableName(material.name)}`;
            }
        } else if (cell.fillType === 'void') {
            fill = 'fill=None';
        }
        
        const regionArg = region ? `, region=${region}` : '';
        const fillArg = fill ? `, ${fill}` : '';
        const nameArg = cell.name ? `, name="${this.escapePythonString(cell.name)}"` : '';
        
        lines.push(`cell_${cell.id} = openmc.Cell(cell_id=${cell.id}${nameArg}${regionArg}${fillArg})`);
        
        if (cell.temperature) {
            lines.push(`cell_${cell.id}.temperature = ${cell.temperature}`);
        }
        
        return lines;
    }

    private generateSettingsCode(state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];
        const settings = state.settings;
        
        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Settings');
            lines.push('#==============================================================================');
        }
        
        lines.push('settings = openmc.Settings()');
        lines.push(`settings.run_mode = "${settings.run.mode}"`);
        
        // Run mode specific settings
        if (settings.run.mode === 'eigenvalue') {
            const eigenRun = settings.run as OpenMCEigenvalueSettings;
            lines.push(`settings.batches = ${eigenRun.batches}`);
            lines.push(`settings.inactive = ${eigenRun.inactive}`);
            lines.push(`settings.particles = ${eigenRun.particles}`);
        } else if (settings.run.mode === 'fixed source') {
            const fixedRun = settings.run as OpenMCFixedSourceSettings;
            lines.push(`settings.batches = ${fixedRun.batches}`);
            lines.push(`settings.particles = ${fixedRun.particles}`);
        }
        
        // Sources
        for (let i = 0; i < settings.sources.length; i++) {
            lines.push(...this.generateSourceCode(settings.sources[i], i));
        }
        
        if (settings.sources.length > 0) {
            const sourceVars = settings.sources.map((_, i) => `source_${i}`).join(', ');
            lines.push(`settings.source = [${sourceVars}]`);
        }
        
        // Seed
        if (settings.seed) {
            lines.push(`settings.seed = ${settings.seed}`);
        }
        
        // Threads
        if (settings.threads) {
            lines.push(`settings.threads = ${settings.threads}`);
        }
        
        // Photon transport
        if (settings.photonTransport) {
            lines.push('settings.photon_transport = True');
        }
        
        // Temperature
        if (settings.temperature) {
            if (settings.temperature.default) {
                lines.push(`settings.temperature['default'] = ${settings.temperature.default}`);
            }
            if (settings.temperature.method) {
                lines.push(`settings.temperature['method'] = "${settings.temperature.method}"`);
            }
            if (settings.temperature.multipole) {
                lines.push('settings.temperature["multipole"] = True');
            }
        }
        
        // Cutoff
        if (settings.cutoff) {
            if (settings.cutoff.weight !== undefined) {
                lines.push(`settings.cutoff['weight'] = ${settings.cutoff.weight}`);
            }
            if (settings.cutoff.weightAvg !== undefined) {
                lines.push(`settings.cutoff['weight_avg'] = ${settings.cutoff.weightAvg}`);
            }
        }
        
        // Variance reduction settings
        if (state.varianceReduction) {
            const vr = state.varianceReduction;
            
            if (vr.survivalBiasing) {
                lines.push('settings.survival_biasing = True');
            }
            
            if (vr.weightWindowGenerator) {
                const meshId = vr.weightWindows?.meshId || (vr.ufs?.enabled ? vr.ufs.meshId : undefined);
                if (meshId !== undefined) {
                    lines.push('wwg = openmc.WeightWindowGenerator(');
                    lines.push(`    mesh=mesh_${meshId},`);
                    if (vr.weightWindowGenerator.iterations) {
                        lines.push(`    max_realizations=${vr.weightWindowGenerator.iterations},`);
                    }
                    if (vr.weightWindowGenerator.particleType) {
                        lines.push(`    particle_type="${vr.weightWindowGenerator.particleType}"`);
                    }
                    lines.push(')');
                    lines.push('settings.weight_window_generators = [wwg]');
                } else {
                    lines.push('# Weight window generator enabled but no mesh specified (checked weightWindows and ufs)');
                }
            }
        }
        
        // Uniform Fission Site (UFS)
        if (state.varianceReduction?.ufs?.enabled) {
            const ufsMeshId = state.varianceReduction.ufs.meshId || state.varianceReduction.weightWindows?.meshId;
            if (ufsMeshId !== undefined) {
                lines.push(`settings.ufs_mesh = mesh_${ufsMeshId}`);
            }
        }
        
        return lines;
    }

    private generateDepletionCode(state: OpenMCState): string[] {
        if (!state.depletion || !state.depletion.enabled) return [];
        const depletion = state.depletion;

        const lines: string[] = [];
        if (depletion.chainFile) {
            lines.push(`chain = "${depletion.chainFile}"`);
        } else {
            lines.push('# Warning: No depletion chain specified. Using default CASL chain.');
            lines.push('chain = "/opt/openmc/share/openmc/chain_casl_s75.xml"');
        }

        // Setup operator
        lines.push('op = openmc.deplete.CoupledOperator(model, chain)');
        
        // Power/PowerDensity handling
        let powerVal = depletion.power;
        if (powerVal === undefined && depletion.powerDensity !== undefined) {
            // Replicate XML generation logic: power = density * mass
            let totalMassG = 0;
            for (const mat of state.materials) {
                if (mat.isDepletable && mat.volume) {
                    totalMassG += mat.density * mat.volume;
                }
            }
            if (totalMassG > 0) {
                powerVal = depletion.powerDensity * totalMassG;
                lines.push(`# Calculated total power from power density (${depletion.powerDensity} W/g) and depletable mass (${totalMassG.toFixed(2)} g)`);
            }
        }
        lines.push(`power = ${powerVal || 1.0}  # Power in Watts`);

        // Timesteps in seconds
        const timesteps = depletion.timeSteps.map(ts => {
            if (typeof ts === 'string') {
                const match = ts.match(/^([\d.]+)\s*([smhdwy])$/i);
                if (match) {
                    const value = parseFloat(match[1]);
                    const unit = match[2].toLowerCase();
                    const multipliers: { [key: string]: number } = {
                        's': 1, 'm': 60, 'h': 3600, 'd': 86400, 'w': 604800, 'y': 31536000
                    };
                    return value * (multipliers[unit] || 1);
                }
            }
            return Number(ts);
        });
        lines.push(`timesteps = [${timesteps.join(', ')}]  # Timesteps in seconds`);

        // Setup Integrator
        const solverMap: Record<string, string> = {
            'cecm': 'CECMIntegrator',
            'epc': 'EPCRK4Integrator',
            'predictor': 'PredictorIntegrator',
            'cecmr': 'CECMIntegrator',
            'epcr': 'EPCRK4Integrator',
            'si-cesc': 'SICESCIntegrator',
            'leqi': 'LEQIIntegrator'
        };
        const solver = solverMap[depletion.solver || 'predictor'] || 'PredictorIntegrator';
        lines.push(`integrator = openmc.deplete.${solver}(op, timesteps, power)`);
        
        // Run integration (commented out by default to allow XML export first)
        lines.push('# integrator.integrate()');
        
        return lines;
    }

    private generateSourceCode(source: OpenMCSource, index: number): string[] {
        const lines: string[] = [];
        
        lines.push(`source_${index} = openmc.IndependentSource()`);
        
        // Spatial distribution
        const spatial = source.spatial;
        switch (spatial.type) {
            case 'point':
                const point = spatial as any;
                lines.push(`source_${index}.space = openmc.stats.Point([${point.origin.join(', ')}])`);
                break;
            case 'box':
                const box = spatial as any;
                lines.push(`source_${index}.space = openmc.stats.Box([${box.lowerLeft.join(', ')}], [${box.upperRight.join(', ')}])`);
                break;
            case 'sphere':
                const sphere = spatial as any;
                lines.push(`source_${index}.space = openmc.stats.Sphere([${sphere.center.join(', ')}], ${sphere.radius})`);
                break;
            case 'cylinder':
                const cyl = spatial as any;
                lines.push(`source_${index}.space = openmc.stats.CylindricalIndependent(`);
                lines.push(`    r=openmc.stats.Uniform(0, ${cyl.radius}),`);
                lines.push(`    phi=openmc.stats.Uniform(0, 2*3.14159),`);
                lines.push(`    z=openmc.stats.Uniform(-${cyl.height/2}, ${cyl.height/2}),`);
                lines.push(`    origin=[${cyl.center.join(', ')}]`);
                lines.push(')');
                break;
        }
        
        // Energy distribution
        const energy = source.energy;
        if (energy) {
            switch (energy.type) {
                case 'discrete':
                    const discrete = energy as any;
                    const energies = discrete.energies || [1e6];
                    const probs = discrete.probabilities || energies.map(() => 1.0 / energies.length);
                    lines.push(`source_${index}.energy = openmc.stats.Discrete([${energies.join(', ')}], [${probs.join(', ')}])`);
                    break;
                case 'uniform':
                    const uniform = energy as any;
                    lines.push(`source_${index}.energy = openmc.stats.Uniform(${uniform.min}, ${uniform.max})`);
                    break;
                case 'maxwell':
                    const maxwell = energy as any;
                    lines.push(`source_${index}.energy = openmc.stats.Maxwell(${maxwell.temperature})`);
                    break;
                case 'watt':
                    const watt = energy as any;
                    lines.push(`source_${index}.energy = openmc.stats.WattFission(${watt.a}, ${watt.b})`);
                    break;
            }
        }
        
        // Particle type
        if (source.particle) {
            lines.push(`source_${index}.particle = "${source.particle}"`);
        }
        
        // Strength
        if (source.strength !== undefined && source.strength !== 1) {
            lines.push(`source_${index}.strength = ${source.strength}`);
        }
        
        return lines;
    }

    private generateTallyMeshCode(state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];
        
        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Tallies');
            lines.push('#==============================================================================');
        }
        
        // Meshes
        if (state.meshes.length > 0) {
            if (options.includeComments) {
                lines.push('# Meshes');
            }
            for (const mesh of state.meshes) {
                lines.push(...this.generateMeshCode(mesh));
            }
            lines.push('');
        }
        
        // Tallies
        if (state.tallies.length > 0) {
            if (options.includeComments) {
                lines.push('# Tallies');
            }
            for (const tally of state.tallies) {
                lines.push(...this.generateTallyCode(tally, state));
            }
            lines.push('');
        }
        
        const tallyVars = state.tallies.map(t => `tally_${t.id}`).join(', ');
        
        if (state.meshes.length > 0 && state.tallies.length > 0) {
            lines.push(`tallies = openmc.Tallies([${tallyVars}])`);
        } else if (state.tallies.length > 0) {
            lines.push(`tallies = openmc.Tallies([${tallyVars}])`);
        }
        
        return lines;
    }

    private generateMeshCode(mesh: OpenMCMesh): string[] {
        const lines: string[] = [];
        
        if (mesh.type === 'regular') {
            const regularMesh = mesh as OpenMCRegularMesh;
            lines.push(`mesh_${mesh.id} = openmc.RegularMesh(mesh_id=${mesh.id})`);
            lines.push(`mesh_${mesh.id}.lower_left = [${regularMesh.lowerLeft.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.upper_right = [${regularMesh.upperRight.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.dimension = [${regularMesh.dimension.join(', ')}]`);
        } else if (mesh.type === 'cylindrical') {
            const cylMesh = mesh as OpenMCCylindricalMesh;
            lines.push(`mesh_${mesh.id} = openmc.CylindricalMesh(mesh_id=${mesh.id})`);
            if (cylMesh.origin) {
                lines.push(`mesh_${mesh.id}.origin = [${cylMesh.origin.join(', ')}]`);
            }
            lines.push(`mesh_${mesh.id}.r_grid = [${cylMesh.rGrid.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.phi_grid = [${cylMesh.phiGrid.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.z_grid = [${cylMesh.zGrid.join(', ')}]`);
        } else if (mesh.type === 'spherical') {
            const sphMesh = mesh as OpenMCSphericalMesh;
            lines.push(`mesh_${mesh.id} = openmc.SphericalMesh(mesh_id=${mesh.id})`);
            if (sphMesh.origin) {
                lines.push(`mesh_${mesh.id}.origin = [${sphMesh.origin.join(', ')}]`);
            }
            lines.push(`mesh_${mesh.id}.r_grid = [${sphMesh.rGrid.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.theta_grid = [${sphMesh.thetaGrid.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.phi_grid = [${sphMesh.phiGrid.join(', ')}]`);
        }
        
        lines.push('');
        return lines;
    }

    private generateTallyCode(tally: OpenMCTally, state: OpenMCState): string[] {
        const lines: string[] = [];
        
        lines.push(`tally_${tally.id} = openmc.Tally(name="${this.escapePythonString(tally.name || '')}", tally_id=${tally.id})`);
        
        // Scores
        if (tally.scores.length > 0) {
            lines.push(`tally_${tally.id}.scores = [${tally.scores.map(s => `"${s}"`).join(', ')}]`);
        }
        
        // Nuclides
        if (tally.nuclides.length > 0) {
            lines.push(`tally_${tally.id}.nuclides = [${tally.nuclides.map(n => `"${n}"`).join(', ')}]`);
        }
        
        // Filters
        if (tally.filters.length > 0) {
            const filterVars: string[] = [];
            for (let i = 0; i < tally.filters.length; i++) {
                const filter = tally.filters[i];
                const filterVar = `filter_${tally.id}_${i}`;
                filterVars.push(filterVar);
                
                switch (filter.type) {
                    case 'energy':
                        lines.push(`${filterVar} = openmc.EnergyFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'energyout':
                        lines.push(`${filterVar} = openmc.EnergyoutFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'mesh':
                        if (filter.meshId) {
                            lines.push(`${filterVar} = openmc.MeshFilter(mesh_${filter.meshId})`);
                        }
                        break;
                    case 'cell':
                        lines.push(`${filterVar} = openmc.CellFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'material':
                        lines.push(`${filterVar} = openmc.MaterialFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'surface':
                        lines.push(`${filterVar} = openmc.SurfaceFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'universe':
                        lines.push(`${filterVar} = openmc.UniverseFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'mu':
                        lines.push(`${filterVar} = openmc.MuFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'polar':
                        lines.push(`${filterVar} = openmc.PolarFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'azimuthal':
                        lines.push(`${filterVar} = openmc.AzimuthalFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'particle':
                        lines.push(`${filterVar} = openmc.ParticleFilter([${filter.bins.map(b => b === 1 ? '"neutron"' : '"photon"').join(', ')}])`);
                        break;
                    default:
                        lines.push(`${filterVar} = openmc.Filter()  # ${filter.type} filter`);
                }
            }
            lines.push(`tally_${tally.id}.filters = [${filterVars.join(', ')}]`);
        }
        
        // Estimator
        if (tally.estimator) {
            lines.push(`tally_${tally.id}.estimator = "${tally.estimator}"`);
        }
        
        lines.push('');
        return lines;
    }

    private generatePlotsCode(state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];
        
        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Plots');
            lines.push('#==============================================================================');
        }
        
        for (const plot of state.plots || []) {
            lines.push(`plot_${plot.id} = openmc.Plot()`);
            lines.push(`plot_${plot.id}.id = ${plot.id}`);
            lines.push(`plot_${plot.id}.type = "${plot.type}"`);
            lines.push(`plot_${plot.id}.basis = "${plot.basis}"`);
            lines.push(`plot_${plot.id}.origin = [${plot.origin.join(', ')}]`);
            
            if (plot.type === 'slice') {
                if (plot.width) lines.push(`plot_${plot.id}.width = ${plot.width}`);
                if (plot.height) lines.push(`plot_${plot.id}.height = ${plot.height}`);
                if (plot.pixels) lines.push(`plot_${plot.id}.pixels = [${plot.pixels.join(', ')}]`);
            }
            
            lines.push(`plot_${plot.id}.color_by = "${plot.colorBy}"`);
            
            if (plot.meshlines) {
                lines.push(`plot_${plot.id}.meshlines = True`);
            }
            
            lines.push('');
        }
        
        if (state.plots && state.plots.length > 0) {
            const plotVars = state.plots.map(p => `plot_${p.id}`).join(', ');
            lines.push(`plots = openmc.Plots([${plotVars}])`);
        }
        
        return lines;
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    private sanitizeVariableName(name: string): string {
        // Remove invalid characters and ensure valid Python identifier
        let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
        // Ensure doesn't start with number
        if (/^\d/.test(sanitized)) {
            sanitized = 'mat_' + sanitized;
        }
        // Avoid reserved words
        const reserved = ['and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 
            'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 
            'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while', 'with', 'yield'];
        if (reserved.includes(sanitized)) {
            sanitized = sanitized + '_';
        }
        return sanitized;
    }

    private escapePythonString(text: string): string {
        // Escape quotes and backslashes
        return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    }

    private convertRegionStringToPython(region: string): string {
        // Convert OpenMC region string to Python expression
        // Replace surface IDs with surface_ variables
        // Example: "1 -2 3" -> "+surface_1 & -surface_2 & +surface_3"
        
        return region.replace(/([+-]?)(\d+)/g, (match, sign, id) => {
            const surfaceSign = sign === '-' ? '-' : '+';
            return `${surfaceSign}surface_${id}`;
        }).replace(/\s+/g, ' & ').replace(/\|/g, ' | ').replace(/~/g, ' ~');
    }

    private convertRegionNodeToPython(node: any): string {
        if (!node) return '';
        
        if (node.type === 'surface') {
            const sign = node.surfaceId > 0 ? '+' : '-';
            return `${sign}surface_${Math.abs(node.surfaceId)}`;
        }
        
        if (node.type === 'operator') {
            const children = node.children?.map((c: any) => this.convertRegionNodeToPython(c)).filter(Boolean) || [];
            
            if (node.operator === 'intersection') {
                return children.join(' & ');
            } else if (node.operator === 'union') {
                return children.join(' | ');
            } else if (node.operator === 'complement') {
                return `~(${children[0] || ''})`;
            }
        }
        
        return '';
    }
}
