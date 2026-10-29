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
 * Python Script Generator
 *
 * Generates OpenMC Python scripts from the simulation state managed by
 * {@link OpenMCStateManager}. Supports exporting as a single `model.py` file
 * or as separate files (`materials.py`, `geometry.py`, `settings.py`, etc.).
 *
 * The generated scripts use the OpenMC Python API and are ready to run
 * with `python model.py` or `openmc` after XML export.
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
import { OpenMCStudioBackendService, OpenMCCompat, DEFAULT_OPENMC_COMPAT } from '../../common/openmc-studio-protocol';
import {
    OpenMCState,
    OpenMCMaterial,
    OpenMCSurface,
    OpenMCCell,
    OpenMCTally,
    OpenMCMesh,
    OpenMCRegularMesh,
    OpenMCRectilinearMesh,
    OpenMCCylindricalMesh,
    OpenMCSphericalMesh,
    OpenMCUnstructuredMesh,
    OpenMCSource,
    OpenMCSourceConstraints,
    OpenMCEigenvalueSettings,
    OpenMCFixedSourceSettings,
    OpenMCPlotConfig,
    OpenMCLattice
} from '../../common/openmc-state-schema';
import { getAutoIfpTallies } from '../../common/kinetics-ifp';
import { generateCmfdCodeLines } from '../../common/cmfd';
import { generateAngleCode, generateSpatialCode, generateTimeCode, generateUnivariateCode } from './source-codegen';
import { getDepletionSolver, resolveDepletionSolver } from '../../common/depletion-solvers';
import { isElementName } from '../../common/material-utils';
import { getCellInstancePairs, getFilterSupportWarning, getMeshMaterialPairs, isFilterSupported } from '../../common/tally-filter-utils';
import { normalizeReactionBin } from '../../common/reaction-catalog';
import { generatePlotAppearancePythonLines } from '../../common/plot-appearance';
import {
    generateMaterialIsotropicPython,
    generateRuntimeSettingsPython,
    generateTemperatureCutoffPython
} from '../../common/settings-python-export';
import {
    resolveWeightWindowBounds,
    resolveWeightWindowGeneratorMesh,
    resolveWeightWindowsEnabled,
    sourceHasBias,
    stripSourceBias
} from '../../common/variance-reduction';

/** Options controlling how Python scripts are exported. */
export interface PythonExportOptions {
    /** Export as single file or separate files. */
    mode: 'single' | 'separate';
    /** Output directory for separate files mode. */
    outputDirectory?: string;
    /** Include comments in generated code. */
    includeComments?: boolean;
    /** Include shebang line (`#!/usr/bin/env python3`). */
    includeShebang?: boolean;
    /** Probed OpenMC capabilities (0.16-only settings are gated when known). */
    compat?: OpenMCCompat;
    /**
     * Whether the target OpenMC supports `openmc.MeshFilter.rotation`
     * (0.16.0+). Mirrors the probed XML capability; when false, rotation is
     * omitted with a comment instead of emitting code that cannot run.
     * Callers may omit this and derive it from `compat.meshFilterRotation`.
     */
    meshFilterRotationSupported?: boolean;
}

/** Result of a Python export operation. */
export interface PythonExportResult {
    /** Whether the export completed successfully. */
    success: boolean;
    /** List of file URIs that were written. */
    files: string[];
    /** Error message if `success` is `false`. */
    error?: string;
}

@injectable()
export class OpenMCPythonExporter {
    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FileService)
    protected readonly fileService: FileService;

    /**
     * Export the current simulation state to Python script(s).
     *
     * Prompts the user for a save location, then generates and writes the
     * script(s) according to the provided options.
     *
     * @param options - Partial export options merged with defaults.
     * @returns A promise resolving to the {@link PythonExportResult}.
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
            if (!defaultOptions.compat) {
                defaultOptions.compat = await this.backendService.getOpenMCCompat().catch(() => DEFAULT_OPENMC_COMPAT);
            }
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
     * Export the simulation as a single `model.py` file.
     *
     * @param state - The current {@link OpenMCState} to export.
     * @param options - Fully resolved export options.
     * @returns A promise resolving to the {@link PythonExportResult}.
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
     * Export the simulation as separate files (`materials.py`, `geometry.py`,
     * `settings.py`, `tallies.py`, `plots.py`, and `model.py`).
     *
     * @param state - The current {@link OpenMCState} to export.
     * @param options - Fully resolved export options.
     * @returns A promise resolving to the {@link PythonExportResult}.
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
     *
     * Falls back to {@link FileService.createFile} if writing fails.
     *
     * @param uri - The target file URI.
     * @param content - The text content to write.
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
     * Generate a complete single-file `model.py` script.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options controlling comments and shebang.
     * @returns The generated Python code as a single string.
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
        if (this.needsScriptRelativeMeshPath(state)) {
            lines.push('import os');
        }
        if (state.depletion?.enabled) {
            lines.push('import openmc.deplete');
            if (state.depletion.reactivityControl && state.depletion.reactivityControl.enabled !== false) {
                lines.push('import openmc.lib');
            }
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

        // Tallies & Meshes (needed before settings for VR; also when kinetics
        // auto-generates IFP tallies — matches the XML generator's gate)
        if (state.tallies.length > 0 || state.meshes.length > 0 || state.settings.kinetics?.enabled) {
            lines.push(...this.generateTallyMeshCode(state, options));
            lines.push('');
        }

        // Settings
        lines.push(...this.generateSettingsCode(state, options));
        lines.push('');

        // CMFD acceleration (C-API; no settings.xml representation in this OpenMC version)
        if (state.settings.cmfd?.enabled) {
            lines.push(...this.generateCmfdCode(state, options));
            lines.push('');
        }

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
        // Kinetics auto-generates IFP tallies even with no user tallies
        const talliesArg = state.tallies.length > 0 || state.settings.kinetics?.enabled ? ', tallies=tallies' : '';
        const plotsArg = state.plots && state.plots.length > 0 ? ', plots=plots' : '';

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
     * Generate a standalone `materials.py` script.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns The generated Python code.
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
     * Generate a standalone `geometry.py` script.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns The generated Python code.
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
     * Generate a standalone `settings.py` script.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns The generated Python code.
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

        // CMFD acceleration (C-API; no settings.xml representation in this OpenMC version)
        if (state.settings.cmfd?.enabled) {
            lines.push('');
            lines.push(...this.generateCmfdCode(state, options));
        }

        return lines.join('\n');
    }

    /**
     * Generate a standalone `tallies.py` script.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns The generated Python code.
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
        if (this.needsScriptRelativeMeshPath(state)) {
            lines.push('import os');
        }
        lines.push('');

        lines.push(...this.generateTallyMeshCode(state, options));

        return lines.join('\n');
    }

    /**
     * Whether any unstructured mesh uses a project-relative filename that the
     * generated script must resolve against its own directory.
     *
     * @param state - Current simulation state.
     * @returns True when `import os` and `_script_dir` are required.
     */
    private needsScriptRelativeMeshPath(state: OpenMCState): boolean {
        return (state.meshes ?? []).some(
            (mesh) => mesh.type === 'unstructured' && !!mesh.filename && !this.isAbsoluteFilename(mesh.filename)
        );
    }

    /**
     * Test whether a path is absolute (POSIX, Windows drive, or UNC).
     *
     * @param filename - Path to inspect.
     * @returns True for absolute paths.
     */
    private isAbsoluteFilename(filename: string): boolean {
        return filename.startsWith('/') || filename.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(filename);
    }

    /**
     * Build a Python expression for an unstructured mesh filename. Relative
     * paths resolve against the exported script's directory so project-relative
     * paths keep working when the script is run from elsewhere.
     *
     * @param filename - Mesh filename from state.
     * @returns Python expression yielding the path.
     */
    private formatPythonMeshFilename(filename: string): string {
        const quoted = `"${this.escapePythonString(filename)}"`;
        return this.isAbsoluteFilename(filename) || !filename ? quoted : `os.path.join(_script_dir, ${quoted})`;
    }

    /**
     * Generate a standalone `plots.py` script.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns The generated Python code.
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
     * Generate a main `model.py` that imports all separate module files.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns The generated Python code.
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

    /**
     * Generate the Python code block for all materials.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns An array of code lines.
     */
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
        lines.push(`materials = openmc.Materials([${state.materials.map((m) => this.sanitizeVariableName(m.name)).join(', ')}])`);

        return lines;
    }

    /**
     * Generate the Python code for a single material.
     *
     * @param material - The {@link OpenMCMaterial} to convert.
     * @returns An array of code lines.
     */
    private generateMaterialCode(material: OpenMCMaterial): string[] {
        const lines: string[] = [];
        const varName = this.sanitizeVariableName(material.name);

        if (material.ncrystalCfg) {
            // NCrystal material: from_ncrystal rebuilds the flattened composition,
            // density and temperature from the cfg and attaches the cfg so the
            // exported XML takes thermal scattering from NCrystal. S(a,b) and
            // explicit nuclides are intentionally not emitted (incompatible).
            lines.push(
                `${varName} = openmc.Material.from_ncrystal("${this.escapePythonString(material.ncrystalCfg)}", name="${this.escapePythonString(material.name)}", material_id=${material.id})`
            );
            if (material.isDepletable) {
                lines.push(`${varName}.depletable = True`);
            }
            if (material.volume !== undefined) {
                lines.push(`${varName}.volume = ${material.volume}`);
            }
            lines.push('');
            return lines;
        }

        lines.push(`${varName} = openmc.Material(name="${this.escapePythonString(material.name)}", material_id=${material.id})`);

        if (material.macroscopic) {
            // Macroscopic (multigroup) material: no nuclide decomposition (openmc/material.py:896 add_macroscopic)
            lines.push(`${varName}.add_macroscopic("${this.escapePythonString(material.macroscopic.name)}")`);
            if (material.densityUnit !== 'sum') {
                lines.push(`${varName}.set_density("${material.densityUnit}", ${material.density})`);
            }
            if (material.isDepletable) {
                lines.push(`${varName}.depletable = True`);
            }
            if (material.volume !== undefined) {
                lines.push(`${varName}.volume = ${material.volume}`);
            }
            if (material.temperature !== undefined) {
                lines.push(`${varName}.temperature = ${material.temperature}`);
            }
            lines.push('');
            return lines;
        }

        // Add nuclides and elements
        for (const nuclide of material.nuclides) {
            const percentType = nuclide.fractionType === 'wo' ? 'wo' : 'ao';
            if (isElementName(nuclide.name)) {
                lines.push(`${varName}.add_element("${nuclide.name}", ${nuclide.fraction}, percent_type="${percentType}")`);
            } else {
                lines.push(`${varName}.add_nuclide("${nuclide.name}", ${nuclide.fraction}, percent_type="${percentType}")`);
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
        const isotropic = generateMaterialIsotropicPython(material, varName);
        if (isotropic.length > 0) {
            lines.push(...isotropic);
        }

        lines.push('');
        return lines;
    }

    /**
     * Generate the Python code block for geometry (surfaces, cells, and root object).
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns An array of code lines.
     */
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

        // Generate universes before cells: cells and lattices reference them.
        const hasRootUniverse = state.geometry.universes.some((universe) => universe.id === 0);
        if (state.geometry.universes.length > 0) {
            if (options.includeComments) {
                lines.push('# Universes');
            }
            for (const universe of state.geometry.universes) {
                const nameArg = universe.name ? `, name="${this.escapePythonString(universe.name)}"` : '';
                lines.push(`universe_${universe.id} = openmc.Universe(universe_id=${universe.id}${nameArg})`);
            }
        }
        if (!hasRootUniverse) {
            if (options.includeComments) {
                lines.push('# Root universe (OpenMC XML defaults cells without a universe attribute to 0)');
            }
            lines.push('universe_0 = openmc.Universe(universe_id=0, name="root universe")');
        }
        lines.push('');

        // Generate lattices (they reference universes and are referenced by cells).
        if (state.geometry.lattices.length > 0) {
            if (options.includeComments) {
                lines.push('# Lattices');
            }
            for (const lattice of state.geometry.lattices) {
                lines.push(...this.generateLatticeCode(lattice));
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

        // Add every cell to its owning universe. Cells not listed in any
        // universe belong to universe 0, matching the XML default.
        if (state.geometry.cells.length > 0) {
            const cellToUniverse = new Map<number, number>();
            for (const universe of state.geometry.universes) {
                for (const cellId of universe.cellIds) {
                    if (!cellToUniverse.has(cellId)) {
                        cellToUniverse.set(cellId, universe.id);
                    }
                }
            }
            if (options.includeComments) {
                lines.push('# Universe membership');
            }
            for (const cell of state.geometry.cells) {
                const universeId = cellToUniverse.get(cell.id) ?? 0;
                lines.push(`universe_${universeId}.add_cell(cell_${cell.id})`);
            }
            lines.push('');
        }

        // Periodic surface pairs are assigned after both surfaces exist.
        const periodicPairs = this.collectPeriodicPairs(state);
        if (periodicPairs.length > 0) {
            if (options.includeComments) {
                lines.push('# Periodic boundary pairs');
            }
            for (const [first, second] of periodicPairs) {
                lines.push(`surface_${first}.periodic_surface = surface_${second}`);
            }
            lines.push('');
        }

        // Create the geometry object from the root universe, never from a flat
        // cell list: that would drop universes and lattices.
        if (state.settings.dagmcFile && state.geometry.cells.length === 0) {
            if (options.includeComments) {
                lines.push('# DAGMC geometry - uses CAD-based mesh geometry');
            }
            const dagmcAutoArgs: string[] = [];
            if (state.settings.dagmcInfo?.autoGeomIds) {
                dagmcAutoArgs.push('auto_geom_ids=True');
            }
            if (state.settings.dagmcInfo?.autoMatIds) {
                dagmcAutoArgs.push('auto_mat_ids=True');
            }
            const dagmcArgsStr = dagmcAutoArgs.length > 0 ? `, ${dagmcAutoArgs.join(', ')}` : '';
            lines.push(`dagmc_univ = openmc.DAGMCUniverse(filename="geometry.h5m"${dagmcArgsStr})`);
            lines.push('geometry = openmc.Geometry(dagmc_univ)');
        } else {
            lines.push('geometry = openmc.Geometry(universe_0)');
        }

        return lines;
    }

    /**
     * Build `openmc.RectLattice` / `openmc.HexLattice` Python code.
     * @param lattice - The {@link OpenMCLattice} to convert.
     * @returns An array of code lines.
     */
    private generateLatticeCode(lattice: OpenMCLattice): string[] {
        const lines: string[] = [];
        const nameArg = lattice.name ? `, name="${this.escapePythonString(lattice.name)}"` : '';

        if (lattice.type === 'rect') {
            lines.push(`lattice_${lattice.id} = openmc.RectLattice(lattice_id=${lattice.id}${nameArg})`);
            lines.push(`lattice_${lattice.id}.lower_left = ${this.pythonTuple(lattice.lowerLeft)}`);
            lines.push(`lattice_${lattice.id}.pitch = ${this.pythonTuple(lattice.pitch)}`);
            const slices = lattice.dimensions.length === 3 ? lattice.universes : lattice.universes[0];
            lines.push(`lattice_${lattice.id}.universes = ${this.pythonUniverseArray(slices)}`);
        } else {
            lines.push(`lattice_${lattice.id} = openmc.HexLattice(lattice_id=${lattice.id}${nameArg})`);
            lines.push(`lattice_${lattice.id}.center = ${this.pythonTuple(lattice.center)}`);
            lines.push(`lattice_${lattice.id}.pitch = ${this.pythonTuple(lattice.pitch)}`);
            if (lattice.orientation === 'x') {
                lines.push(`lattice_${lattice.id}.orientation = "x"`);
            }
            const nAxial = lattice.nAxial ?? 1;
            const slices = nAxial > 1 ? lattice.universes : lattice.universes[0];
            lines.push(`lattice_${lattice.id}.universes = ${this.pythonUniverseArray(slices)}`);
        }

        if (lattice.outer !== undefined) {
            lines.push(`lattice_${lattice.id}.outer = universe_${lattice.outer}`);
        }
        lines.push('');
        return lines;
    }

    /** Render a numeric array as a Python tuple (1-element tuples need a comma). */
    private pythonTuple(values: number[]): string {
        if (values.length === 1) {
            return `(${values[0]},)`;
        }
        return `(${values.join(', ')})`;
    }

    /** Render nested universe-ID arrays as Python `universe_<id>` lists. */
    private pythonUniverseArray(universes: number[][][] | number[][]): string {
        const render = (value: unknown): string => {
            if (typeof value === 'number') {
                return `universe_${value}`;
            }
            if (Array.isArray(value)) {
                return `[${value.map(render).join(', ')}]`;
            }
            return 'universe_0';
        };
        return render(universes);
    }

    /**
     * Collect reciprocal periodic pairs once (the lower ID owns the statement).
     * @param state - The current {@link OpenMCState}.
     * @returns Pairs of surface IDs.
     */
    private collectPeriodicPairs(state: OpenMCState): [number, number][] {
        const surfaces = new Map(state.geometry.surfaces.map((surface) => [surface.id, surface]));
        const pairs: [number, number][] = [];
        const seen = new Set<string>();
        for (const surface of state.geometry.surfaces) {
            if (surface.boundary !== 'periodic' || surface.periodicSurfaceId === undefined) {
                continue;
            }
            const partner = surfaces.get(surface.periodicSurfaceId);
            if (!partner || partner.boundary !== 'periodic' || partner.periodicSurfaceId !== surface.id) {
                continue;
            }
            const key = [surface.id, partner.id].sort((a, b) => a - b).join(':');
            if (!seen.has(key)) {
                seen.add(key);
                pairs.push([surface.id, partner.id]);
            }
        }
        return pairs;
    }

    /**
     * Generate the Python code for a single surface.
     *
     * @param surface - The {@link OpenMCSurface} to convert.
     * @returns An array of code lines.
     */
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
            case 'x-cone':
                constructor = `openmc.XCone(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, z0=${coeffs.z0}, r2=${coeffs.r2}`;
                break;
            case 'y-cone':
                constructor = `openmc.YCone(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, z0=${coeffs.z0}, r2=${coeffs.r2}`;
                break;
            case 'z-cone':
                constructor = `openmc.ZCone(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, z0=${coeffs.z0}, r2=${coeffs.r2}`;
                break;
            case 'x-torus':
                constructor = `openmc.XTorus(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, z0=${coeffs.z0}, a=${coeffs.a}, b=${coeffs.b}, c=${coeffs.c}`;
                break;
            case 'y-torus':
                constructor = `openmc.YTorus(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, z0=${coeffs.z0}, a=${coeffs.a}, b=${coeffs.b}, c=${coeffs.c}`;
                break;
            case 'z-torus':
                constructor = `openmc.ZTorus(surface_id=${surface.id}, x0=${coeffs.x0}, y0=${coeffs.y0}, z0=${coeffs.z0}, a=${coeffs.a}, b=${coeffs.b}, c=${coeffs.c}`;
                break;
            case 'cylinder': {
                // Generic cylinder: map to the axis-aligned variant (same
                // reduction as the XML generator's mapSurfaceTypeToOpenMC);
                // openmc.Cylinder does not exist in the Python API
                const x0 = coeffs.x0 ?? 0;
                const y0 = coeffs.y0 ?? 0;
                const z0 = coeffs.z0 ?? 0;
                const vx = coeffs.vx ?? 0;
                const vy = coeffs.vy ?? 0;
                const vz = coeffs.vz ?? 1;
                const absVx = Math.abs(vx);
                const absVy = Math.abs(vy);
                const absVz = Math.abs(vz);
                if (absVx >= absVy && absVx >= absVz) {
                    constructor = `openmc.XCylinder(surface_id=${surface.id}, y0=${y0}, z0=${z0}, r=${coeffs.r}`;
                } else if (absVy >= absVx && absVy >= absVz) {
                    constructor = `openmc.YCylinder(surface_id=${surface.id}, x0=${x0}, z0=${z0}, r=${coeffs.r}`;
                } else {
                    constructor = `openmc.ZCylinder(surface_id=${surface.id}, x0=${x0}, y0=${y0}, r=${coeffs.r}`;
                }
                break;
            }
            case 'quadric':
                constructor = `openmc.Quadric(surface_id=${surface.id}, a=${coeffs.a}, b=${coeffs.b}, c=${coeffs.c}, d=${coeffs.d}, e=${coeffs.e}, f=${coeffs.f}, g=${coeffs.g}, h=${coeffs.h}, j=${coeffs.j}, k=${coeffs.k}`;
                break;
            default:
                constructor = `# Surface type ${surface.type} not implemented`;
                lines.push(`surface_${surface.id} = ${constructor}`);
                return lines;
        }

        // Add boundary condition
        if (surface.boundary && surface.boundary !== 'transmission') {
            constructor += `, boundary_type="${surface.boundary}"`;
            const albedoCapable = surface.boundary === 'reflective' || surface.boundary === 'periodic' || surface.boundary === 'white';
            if (albedoCapable && surface.albedo !== undefined && surface.albedo !== 1) {
                constructor += `, albedo=${surface.albedo}`;
            }
        }

        constructor += ')';
        lines.push(`surface_${surface.id} = ${constructor}`);

        return lines;
    }

    /**
     * Generate the Python code for a single cell.
     *
     * @param cell - The {@link OpenMCCell} to convert.
     * @param state - The current {@link OpenMCState} for material lookups.
     * @returns An array of code lines.
     */
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
            const material = state.materials.find((m) => m.id === cell.fillId);
            if (material) {
                fill = `fill=${this.sanitizeVariableName(material.name)}`;
            }
        } else if (cell.fillType === 'universe' && cell.fillId !== undefined) {
            if (state.geometry.universes.some((universe) => universe.id === cell.fillId)) {
                fill = `fill=universe_${cell.fillId}`;
            }
        } else if (cell.fillType === 'lattice' && cell.fillId !== undefined) {
            if (state.geometry.lattices.some((lattice) => lattice.id === cell.fillId)) {
                fill = `fill=lattice_${cell.fillId}`;
            }
        } else if (cell.fillType === 'void') {
            fill = 'fill=None';
        }

        const regionArg = region ? `, region=${region}` : '';
        const fillArg = fill ? `, ${fill}` : '';
        const nameArg = cell.name ? `, name="${this.escapePythonString(cell.name)}"` : '';

        lines.push(`cell_${cell.id} = openmc.Cell(cell_id=${cell.id}${nameArg}${regionArg}${fillArg})`);

        if (cell.rotation) {
            lines.push(`cell_${cell.id}.rotation = ${this.pythonTuple(cell.rotation)}`);
        }
        if (cell.translation) {
            lines.push(`cell_${cell.id}.translation = ${this.pythonTuple(cell.translation)}`);
        }
        if (cell.density !== undefined) {
            lines.push(`cell_${cell.id}.density = ${cell.density}`);
        }

        if (cell.temperature) {
            lines.push(`cell_${cell.id}.temperature = ${cell.temperature}`);
        }

        return lines;
    }

    /**
     * Generate the Python code block for simulation settings.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns An array of code lines.
     */
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
            if (fixedRun.inactive !== undefined) {
                lines.push(`settings.inactive = ${fixedRun.inactive}`);
            }
        }

        // Energy mode and MGXS library (multi-group / random ray)
        if (settings.energyMode) {
            lines.push(`settings.energy_mode = '${settings.energyMode === 'multigroup' ? 'multi-group' : settings.energyMode}'`);
        }
        if (settings.mgxsLibrary && settings.energyMode === 'multigroup') {
            lines.push(`openmc.config['mg_cross_sections'] = '${settings.mgxsLibrary}'`);
        }

        // Random ray solver settings
        if (settings.randomRay) {
            const rr = settings.randomRay;
            const rrEntries: string[] = [];
            if (rr.distanceInactive !== undefined) {
                rrEntries.push(`'distance_inactive': ${rr.distanceInactive}`);
            }
            if (rr.distanceActive !== undefined) {
                rrEntries.push(`'distance_active': ${rr.distanceActive}`);
            }
            if (rr.volumeEstimator) {
                rrEntries.push(`'volume_estimator': '${rr.volumeEstimator}'`);
            }
            if (rr.sourceShape) {
                rrEntries.push(`'source_shape': '${rr.sourceShape}'`);
            }
            if (rr.volumeNormalizedFluxTallies !== undefined) {
                rrEntries.push(`'volume_normalized_flux_tallies': ${rr.volumeNormalizedFluxTallies ? 'True' : 'False'}`);
            }
            if (rr.sampleMethod) {
                rrEntries.push(`'sample_method': '${rr.sampleMethod}'`);
            }
            if (rr.diagonalStabilizationRho !== undefined) {
                rrEntries.push(`'diagonal_stabilization_rho': ${rr.diagonalStabilizationRho}`);
            }
            if (rr.adjoint !== undefined) {
                rrEntries.push(`'adjoint': ${rr.adjoint ? 'True' : 'False'}`);
            }
            if (rr.raySource) {
                lines.push(
                    `ray_source_space = openmc.stats.Box([${rr.raySource.lowerLeft.join(', ')}], [${rr.raySource.upperRight.join(', ')}])`
                );
                lines.push('ray_source = openmc.IndependentSource(space=ray_source_space)');
                rrEntries.push(`'ray_source': ray_source`);
            }
            lines.push(`settings.random_ray = {${rrEntries.join(', ')}}`);
        }

        // Sources
        const sourceBiasSupported = options.compat?.sourceBias !== false;
        const sources = sourceBiasSupported ? settings.sources : settings.sources.map(stripSourceBias);
        if (!sourceBiasSupported && settings.sources.some(sourceHasBias)) {
            lines.push('# Source bias requires OpenMC >= 0.16.0 and was omitted from this export.');
        }
        for (let i = 0; i < sources.length; i++) {
            lines.push(...this.generateSourceCode(sources[i], i));
        }

        if (sources.length > 0) {
            const sourceVars = sources.map((_, i) => `source_${i}`).join(', ');
            lines.push(`settings.source = [${sourceVars}]`);
        }

        // Seed
        if (settings.seed) {
            lines.push(`settings.seed = ${settings.seed}`);
        }

        // IFP kinetics generations
        if (settings.kinetics?.enabled && settings.kinetics.ifpNGenerations !== undefined) {
            lines.push(`settings.ifp_n_generation = ${settings.kinetics.ifpNGenerations}`);
        }

        // Tally trigger activation: required for per-tally triggers to be
        // evaluated (settings.py _create_trigger_subelement)
        const anyTallyTriggers = state.tallies.some((tally) => (tally.triggers?.length ?? 0) > 0);
        if (anyTallyTriggers || settings.triggers?.maxBatches !== undefined || settings.triggers?.batchInterval !== undefined) {
            lines.push('settings.trigger_active = True');
            if (settings.triggers?.maxBatches !== undefined) {
                lines.push(`settings.trigger_max_batches = ${settings.triggers.maxBatches}`);
            }
            if (settings.triggers?.batchInterval !== undefined) {
                lines.push(`settings.trigger_batch_interval = ${settings.triggers.batchInterval}`);
            }
        }

        // Threads are a runtime launch control (`openmc -s N`), not a
        // Settings attribute — the runner applies settings.threads instead.

        // Advanced scalar settings (attribute names match settings.py)
        const boolSetting = (value: boolean): string => (value ? 'True' : 'False');
        if (settings.eventBased !== undefined) {
            lines.push(`settings.event_based = ${boolSetting(settings.eventBased)}`);
        }
        if (settings.probabilityTables !== undefined) {
            lines.push(`settings.ptables = ${boolSetting(settings.probabilityTables)}`);
        }
        if (settings.maxLostParticles !== undefined) {
            lines.push(`settings.max_lost_particles = ${settings.maxLostParticles}`);
        }
        if (settings.relLostParticleRate !== undefined) {
            lines.push(`settings.rel_max_lost_particles = ${settings.relLostParticleRate}`);
        }
        if (settings.createFissionNeutrons !== undefined) {
            lines.push(`settings.create_fission_neutrons = ${boolSetting(settings.createFissionNeutrons)}`);
        }
        if (settings.createDelayedNeutrons !== undefined) {
            lines.push(`settings.create_delayed_neutrons = ${boolSetting(settings.createDelayedNeutrons)}`);
        }
        if (settings.delayedPhotonScaling !== undefined) {
            lines.push(`settings.delayed_photon_scaling = ${boolSetting(settings.delayedPhotonScaling)}`);
        }
        if (settings.useDecayPhotons !== undefined) {
            lines.push(`settings.use_decay_photons = ${boolSetting(settings.useDecayPhotons)}`);
        }
        if (settings.logGridBins !== undefined) {
            lines.push(`settings.log_grid_bins = ${settings.logGridBins}`);
        }
        if (settings.survivalBiasing !== undefined) {
            lines.push(`settings.survival_biasing = ${boolSetting(settings.survivalBiasing)}`);
        }
        if (settings.generationsPerBatch !== undefined) {
            lines.push(`settings.generations_per_batch = ${settings.generationsPerBatch}`);
        }
        if (settings.maxOrder !== undefined) {
            lines.push(`settings.max_order = ${settings.maxOrder}`);
        }
        if (settings.writeInitialSource !== undefined) {
            lines.push(`settings.write_initial_source = ${boolSetting(settings.writeInitialSource)}`);
        }
        if (settings.uniformSourceSampling !== undefined) {
            lines.push(`settings.uniform_source_sampling = ${boolSetting(settings.uniformSourceSampling)}`);
        }
        lines.push(...generateRuntimeSettingsPython(settings, options.compat));
        if (settings.tabularLegendre) {
            const entries: string[] = [];
            if (settings.tabularLegendre.enable !== undefined) {
                entries.push(`'enable': ${boolSetting(settings.tabularLegendre.enable)}`);
            }
            if (settings.tabularLegendre.numPoints !== undefined) {
                entries.push(`'num_points': ${settings.tabularLegendre.numPoints}`);
            }
            if (entries.length > 0) {
                lines.push(`settings.tabular_legendre = {${entries.join(', ')}}`);
            }
        }

        // Photon transport
        if (settings.photonTransport) {
            lines.push('settings.photon_transport = True');
        }

        // Electron treatment & atomic relaxation (photon physics)
        if (settings.electronTreatment) {
            lines.push(`settings.electron_treatment = '${settings.electronTreatment}'`);
        }
        if (settings.atomicRelaxation !== undefined) {
            lines.push(`settings.atomic_relaxation = ${settings.atomicRelaxation ? 'True' : 'False'}`);
        }

        // Output control (summary falls back to the legacy outputSummary field)
        const outputEntries: string[] = [];
        const outputSummary = settings.output?.summary ?? settings.outputSummary;
        if (outputSummary !== undefined) {
            outputEntries.push(`'summary': ${outputSummary ? 'True' : 'False'}`);
        }
        if (settings.output?.tallies !== undefined) {
            outputEntries.push(`'tallies': ${settings.output.tallies ? 'True' : 'False'}`);
        }
        if (settings.output?.path) {
            outputEntries.push(`'path': '${settings.output.path}'`);
        }
        if (outputEntries.length > 0) {
            lines.push(`settings.output = {${outputEntries.join(', ')}}`);
        }

        // Statepoint batches
        const statepointBatches = Array.isArray(settings.statepointBatches) ? settings.statepointBatches : settings.statepointBatches?.at;
        if (statepointBatches && statepointBatches.length > 0) {
            lines.push(`settings.statepoint = {'batches': [${statepointBatches.join(', ')}]}`);
        }

        // Sourcepoint options
        if (settings.sourcePoint) {
            const spEntries: string[] = [];
            if (settings.sourcePoint.batches && settings.sourcePoint.batches.length > 0) {
                spEntries.push(`'batches': [${settings.sourcePoint.batches.join(', ')}]`);
            }
            if (settings.sourcePoint.separate !== undefined) {
                spEntries.push(`'separate': ${settings.sourcePoint.separate ? 'True' : 'False'}`);
            }
            if (settings.sourcePoint.write !== undefined) {
                spEntries.push(`'write': ${settings.sourcePoint.write ? 'True' : 'False'}`);
            }
            if (settings.sourcePoint.overwrite !== undefined) {
                spEntries.push(`'overwrite': ${settings.sourcePoint.overwrite ? 'True' : 'False'}`);
            }
            if (settings.sourcePoint.mcpl !== undefined) {
                spEntries.push(`'mcpl': ${settings.sourcePoint.mcpl ? 'True' : 'False'}`);
            }
            if (spEntries.length > 0) {
                lines.push(`settings.sourcepoint = {${spEntries.join(', ')}}`);
            }
        }

        // Surface source writing
        if (settings.surfaceSourceWrite) {
            const ssw = settings.surfaceSourceWrite;
            const sswEntries: string[] = [];
            if (ssw.surfaceIds && ssw.surfaceIds.length > 0) {
                sswEntries.push(`'surface_ids': [${ssw.surfaceIds.join(', ')}]`);
            }
            if (ssw.mcpl !== undefined) {
                sswEntries.push(`'mcpl': ${ssw.mcpl ? 'True' : 'False'}`);
            }
            if (ssw.maxParticles !== undefined) {
                sswEntries.push(`'max_particles': ${ssw.maxParticles}`);
            }
            if (ssw.maxSourceFiles !== undefined) {
                sswEntries.push(`'max_source_files': ${ssw.maxSourceFiles}`);
            }
            if (ssw.cell !== undefined) {
                sswEntries.push(`'cell': ${ssw.cell}`);
            }
            if (ssw.cellfrom !== undefined) {
                sswEntries.push(`'cellfrom': ${ssw.cellfrom}`);
            }
            if (ssw.cellto !== undefined) {
                sswEntries.push(`'cellto': ${ssw.cellto}`);
            }
            if (sswEntries.length > 0) {
                lines.push(`settings.surf_source_write = {${sswEntries.join(', ')}}`);
            }
        }

        // Surface source reading
        if (settings.surfaceSourceRead?.path) {
            lines.push(`settings.surf_source_read = {'path': '${settings.surfaceSourceRead.path}'}`);
        }

        // Particle tracks
        if (settings.tracks && settings.tracks.length > 0) {
            const triples = settings.tracks.map((t) => `(${t[0]}, ${t[1]}, ${t[2]})`).join(', ');
            lines.push(`settings.track = [${triples}]`);
        }
        if (settings.maxTracks !== undefined) {
            lines.push(`settings.max_tracks = ${settings.maxTracks}`);
        }

        // Collision track output
        if (settings.collisionTrack) {
            const ct = settings.collisionTrack;
            const ctEntries: string[] = [];
            if (ct.maxCollisions !== undefined) {
                ctEntries.push(`'max_collisions': ${ct.maxCollisions}`);
            }
            if (ct.reactions && ct.reactions.length > 0) {
                const reactions = ct.reactions.map((r) => (typeof r === 'number' ? String(r) : `'${r}'`)).join(', ');
                ctEntries.push(`'reactions': [${reactions}]`);
            }
            if (ct.materialIds && ct.materialIds.length > 0) {
                ctEntries.push(`'material_ids': [${ct.materialIds.join(', ')}]`);
            }
            if (ct.nuclides && ct.nuclides.length > 0) {
                ctEntries.push(`'nuclides': [${ct.nuclides.map((n) => `'${n}'`).join(', ')}]`);
            }
            if (ct.cellIds && ct.cellIds.length > 0) {
                ctEntries.push(`'cell_ids': [${ct.cellIds.join(', ')}]`);
            }
            if (ct.universeIds && ct.universeIds.length > 0) {
                ctEntries.push(`'universe_ids': [${ct.universeIds.join(', ')}]`);
            }
            if (ct.depositedEnergyThreshold !== undefined) {
                ctEntries.push(`'deposited_E_threshold': ${ct.depositedEnergyThreshold}`);
            }
            if (ct.maxCollisionTrackFiles !== undefined) {
                ctEntries.push(`'max_collision_track_files': ${ct.maxCollisionTrackFiles}`);
            }
            if (ct.mcpl !== undefined) {
                ctEntries.push(`'mcpl': ${ct.mcpl ? 'True' : 'False'}`);
            }
            if (ctEntries.length > 0) {
                lines.push(`settings.collision_track = {${ctEntries.join(', ')}}`);
            }
        }

        // Shannon entropy mesh
        if (settings.entropyMesh) {
            const em = settings.entropyMesh;
            lines.push('entropy_mesh = openmc.RegularMesh()');
            lines.push(`entropy_mesh.lower_left = [${em.lowerLeft.join(', ')}]`);
            lines.push(`entropy_mesh.upper_right = [${em.upperRight.join(', ')}]`);
            lines.push(`entropy_mesh.dimension = [${em.shape.join(', ')}]`);
            lines.push('settings.entropy_mesh = entropy_mesh');
        }

        // Temperature and cutoff settings (pure helper shared with tests).
        // The variance-reduction tab's weight cutoff maps to the same
        // settings.cutoff block; settings.cutoff wins when both are set.
        const cutoff = state.varianceReduction?.cutoff
            ? { ...state.varianceReduction.cutoff, ...(settings.cutoff ?? {}) }
            : settings.cutoff;
        lines.push(...generateTemperatureCutoffPython({ ...settings, cutoff }));

        // Variance reduction settings
        if (state.varianceReduction) {
            const vr = state.varianceReduction;
            const weightWindowSets = vr.weightWindows ?? [];

            if (vr.survivalBiasing) {
                lines.push('settings.survival_biasing = True');
            }

            if (vr.weightWindowGenerator) {
                const wwg = vr.weightWindowGenerator;
                const meshId = resolveWeightWindowGeneratorMesh(vr);
                if (meshId !== undefined) {
                    const wwgArgs = [`mesh=mesh_${meshId}`];
                    const wwgEnergyBounds = wwg.energyBounds ?? weightWindowSets[0]?.energyBounds;
                    if (wwgEnergyBounds && wwgEnergyBounds.length > 0) {
                        wwgArgs.push(`energy_bounds=[${wwgEnergyBounds.join(', ')}]`);
                    }
                    wwgArgs.push(`particle_type="${wwg.particleType ?? weightWindowSets[0]?.particleType ?? 'neutron'}"`);
                    wwgArgs.push(`method="${wwg.method ?? 'magic'}"`);
                    const maxRealizations =
                        wwg.maxRealizations ??
                        wwg.iterations ??
                        (state.settings.run.mode === 'eigenvalue' ? state.settings.run.batches : 1);
                    wwgArgs.push(`max_realizations=${maxRealizations}`);
                    if (wwg.updateInterval !== undefined) {
                        wwgArgs.push(`update_interval=${wwg.updateInterval}`);
                    }
                    if (wwg.onTheFly !== undefined) {
                        wwgArgs.push(`on_the_fly=${wwg.onTheFly ? 'True' : 'False'}`);
                    }
                    if (wwg.method === 'fw_cadis' && wwg.targetTallyIds && wwg.targetTallyIds.length > 0) {
                        wwgArgs.push(`targets=[${wwg.targetTallyIds.join(', ')}]`);
                    }
                    lines.push(`wwg = openmc.WeightWindowGenerator(${wwgArgs.join(', ')})`);
                    lines.push('settings.weight_window_generators = [wwg]');
                } else {
                    lines.push('# Weight window generator enabled but no mesh specified');
                }
            }

            // Each set becomes one openmc.WeightWindows object.
            if (weightWindowSets.length > 0) {
                const setVars: string[] = [];
                for (let index = 0; index < weightWindowSets.length; index++) {
                    const set = weightWindowSets[index];
                    const varName = `ww_${index + 1}`;
                    const { lower, upper } = resolveWeightWindowBounds(set, state.meshes);
                    const args = [
                        `mesh=mesh_${set.meshId}`,
                        `lower_ww_bounds=[${lower.join(', ')}]`,
                        `upper_ww_bounds=[${upper.join(', ')}]`,
                        `particle_type="${set.particleType ?? 'neutron'}"`,
                        `survival_ratio=${set.survivalWeight !== undefined ? set.survivalWeight : 3.0}`,
                        `max_split=${set.maxSplit !== undefined ? set.maxSplit : 10}`,
                        `weight_cutoff=${set.weightCutoff !== undefined ? set.weightCutoff : 1e-38}`,
                        `id=${set.id ?? index + 1}`
                    ];
                    if (set.energyBounds && set.energyBounds.length >= 2) {
                        args.splice(3, 0, `energy_bounds=[${set.energyBounds.join(', ')}]`);
                    }
                    lines.push(`${varName} = openmc.WeightWindows(${args.join(', ')})`);
                    setVars.push(varName);
                }
                lines.push(`settings.weight_windows = [${setVars.join(', ')}]`);
            }

            const hasWeightWindows = weightWindowSets.length > 0 || !!vr.weightWindowsFile || !!vr.weightWindowGenerator;
            if (hasWeightWindows && vr.weightWindowsOn !== undefined) {
                lines.push(`settings.weight_windows_on = ${vr.weightWindowsOn ? 'True' : 'False'}`);
            } else if (hasWeightWindows && resolveWeightWindowsEnabled(vr)) {
                lines.push('settings.weight_windows_on = True');
            }
            if (vr.weightWindowsFile) {
                lines.push(`settings.weight_windows_file = ${JSON.stringify(vr.weightWindowsFile)}`);
            }
            if (vr.weightWindowCheckpoints) {
                const entries: string[] = [];
                if (vr.weightWindowCheckpoints.collision !== undefined) {
                    entries.push(`'collision': ${vr.weightWindowCheckpoints.collision ? 'True' : 'False'}`);
                }
                if (vr.weightWindowCheckpoints.surface !== undefined) {
                    entries.push(`'surface': ${vr.weightWindowCheckpoints.surface ? 'True' : 'False'}`);
                }
                if (entries.length > 0) {
                    lines.push(`settings.weight_window_checkpoints = {${entries.join(', ')}}`);
                }
            }
        }

        // Uniform Fission Site (UFS)
        if (state.varianceReduction?.ufs?.enabled) {
            const ufsMeshId = state.varianceReduction.ufs.meshId;
            if (ufsMeshId !== undefined) {
                lines.push(`settings.ufs_mesh = mesh_${ufsMeshId}`);
            } else {
                lines.push('# Uniform fission site enabled but no mesh specified');
            }
        }

        return lines;
    }

    /**
     * Generate the Python code block for depletion settings.
     *
     * @param state - The current {@link OpenMCState}.
     * @returns An array of code lines, empty if depletion is disabled.
     */
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
        if (depletion.continueFromResults) {
            lines.push('# Previous depletion results for restart/continuation');
            lines.push(`prev_results = openmc.deplete.Results(${JSON.stringify(depletion.continueFromResults)})`);
        }
        if (depletion.operator === 'independent') {
            if (depletion.generateFromModel) {
                lines.push('# Independent operator: compute fluxes and MicroXS from the model (transport solve)');
                lines.push('depletable_mats = [m for m in materials if m.depletable]');
                lines.push('fluxes, micros = openmc.deplete.get_microxs_and_flux(model, depletable_mats, chain_file=chain)');
            } else {
                lines.push('# Independent operator: load pre-computed fluxes and MicroXS');
                lines.push('depletable_mats = [m for m in materials if m.depletable]');
                lines.push(`flux_files = [${(depletion.fluxFiles ?? []).map((f) => `"${f}"`).join(', ')}]`);
                lines.push(`microxs_files = [${(depletion.microxsFiles ?? []).map((f) => `"${f}"`).join(', ')}]`);
                lines.push('import numpy as np');
                lines.push(
                    'fluxes = [np.load(f) if f.endswith(".npy") else np.loadtxt(f, delimiter="," if f.endswith(".csv") else None) for f in flux_files]'
                );
                lines.push('micros = [openmc.deplete.MicroXS.from_csv(f) for f in microxs_files]');
            }
            const indepArgs = [
                'depletable_mats',
                'fluxes',
                'micros',
                'chain',
                `normalization_mode="${depletion.normalizationMode ?? 'fission-q'}"`
            ];
            if (depletion.fissionQ && Object.keys(depletion.fissionQ).length > 0) {
                indepArgs.push(`fission_q=${JSON.stringify(depletion.fissionQ)}`);
            }
            if (depletion.continueFromResults) {
                indepArgs.push('prev_results=prev_results');
            }
            lines.push(`op = openmc.deplete.IndependentOperator(${indepArgs.join(', ')})`);
        } else {
            const coupledArgs = ['model', 'chain'];
            if (depletion.diffBurnableMats) {
                coupledArgs.push('diff_burnable_mats=True');
                if (depletion.diffVolumeMethod) {
                    coupledArgs.push(`diff_volume_method="${depletion.diffVolumeMethod}"`);
                }
            }
            coupledArgs.push(`normalization_mode="${depletion.normalizationMode ?? 'fission-q'}"`);
            if (depletion.fissionQ && Object.keys(depletion.fissionQ).length > 0) {
                coupledArgs.push(`fission_q=${JSON.stringify(depletion.fissionQ)}`);
            }
            if (depletion.continueFromResults) {
                coupledArgs.push('prev_results=prev_results');
            }
            lines.push(`op = openmc.deplete.CoupledOperator(${coupledArgs.join(', ')})`);
        }

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
                lines.push(
                    `# Calculated total power from power density (${depletion.powerDensity} W/g) and depletable mass (${totalMassG.toFixed(2)} g)`
                );
            }
        }
        lines.push(`power = ${powerVal || 1.0}  # Power in Watts`);

        // Timesteps in seconds
        const timesteps = depletion.timeSteps.map((ts) => {
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
                    return value * (multipliers[unit] || 1);
                }
            }
            return Number(ts);
        });
        lines.push(`timesteps = [${timesteps.join(', ')}]  # Timesteps in seconds`);
        if ((depletion.decayOnlySteps?.length ?? 0) > 0) {
            lines.push(`decay_only_steps = [${depletion.decayOnlySteps!.join(', ')}]`);
            lines.push('power = [0.0 if i in decay_only_steps else power for i in range(len(timesteps))]');
        }

        // Setup Integrator — canonical OpenMC integrator class (legacy solver
        // names resolve via the shared alias map)
        const solver = getDepletionSolver(resolveDepletionSolver(depletion.solver)).className;
        const integratorArgs = ['op', 'timesteps', 'power'];
        if ((depletion.substeps ?? 1) > 1) {
            integratorArgs.push(`substeps=${depletion.substeps}`);
        }
        if (depletion.continueTimesteps) {
            integratorArgs.push('continue_timesteps=True');
        }
        lines.push(`integrator = openmc.deplete.${solver}(${integratorArgs.join(', ')})`);

        // External transfer rates (Integrator.add_transfer_rate)
        for (const tr of depletion.transferRates ?? []) {
            const destArg = tr.destinationMaterial !== undefined ? `, destination_material=${tr.destinationMaterial}` : '';
            lines.push(
                `integrator.add_transfer_rate(${tr.material}, ["${tr.element}"], ${tr.rate}, transfer_rate_units="${tr.units ?? '1/s'}"${destArg})`
            );
        }

        // External source rates (Integrator.add_external_source_rate)
        for (const rate of depletion.externalSourceRates ?? []) {
            const composition = Object.fromEntries(
                rate.composition.filter((entry) => entry.name.trim().length > 0).map((entry) => [entry.name, entry.weightPercent])
            );
            const timestepsArg = rate.timesteps && rate.timesteps.length > 0 ? `, timesteps=[${rate.timesteps.join(', ')}]` : '';
            lines.push(
                `integrator.add_external_source_rate(${rate.material}, ${JSON.stringify(composition)}, ${rate.rate}, rate_units="${
                    rate.units ?? 'g/s'
                }"${timestepsArg})`
            );
        }

        // Reactivity control (keff search). The modifier must use openmc.lib,
        // because OpenMC calls it inside a temporary C-API session.
        const control = depletion.reactivityControl;
        if (control && control.enabled !== false) {
            const axisIndex = control.axis === 'x' ? 0 : control.axis === 'y' ? 1 : 2;
            lines.push('# Reactivity control: adjust a model parameter to hold a target keff');
            lines.push('def _openmc_studio_reactivity(value):');
            if (control.parameter === 'cell-translation') {
                lines.push(`    cell = openmc.lib.cells[${control.cellId ?? 1}]`);
                lines.push('    translation = list(cell.translation)');
                lines.push(`    translation[${axisIndex}] = value`);
                lines.push('    cell.translation = translation');
            } else {
                lines.push(`    lib_mat = openmc.lib.materials[${control.materialId ?? 1}]`);
                lines.push('    nuclides = list(lib_mat.nuclides)');
                lines.push(`    index = nuclides.index(${JSON.stringify(control.nuclide ?? 'U235')})`);
                lines.push('    densities = lib_mat.densities');
                lines.push('    densities[index] = value');
                lines.push('    lib_mat.set_densities(nuclides, densities)');
            }
            lines.push('integrator.add_keff_search_control(');
            lines.push('    _openmc_studio_reactivity,');
            lines.push(`    x0=${control.x0},`);
            lines.push(`    x1=${control.x1},`);
            lines.push(`    bracket=[${control.bracket[0]}, ${control.bracket[1]}],`);
            if (control.targetKeff !== undefined) {
                lines.push(`    target=${control.targetKeff},`);
            }
            if (control.kTol !== undefined) {
                lines.push(`    k_tol=${control.kTol},`);
            }
            if (control.sigmaFinal !== undefined) {
                lines.push(`    sigma_final=${control.sigmaFinal},`);
            }
            if (control.maxIterations !== undefined) {
                lines.push(`    maxiter=${control.maxIterations},`);
            }
            lines.push(')');
            if (control.onFailure === 'warn') {
                lines.push('# OpenMC aborts on a non-converged search; wrap the controller installed by');
                lines.push('# the public add_keff_search_control call to warn and continue instead.');
                lines.push('_openmc_studio_search_run = integrator._keff_search_control.run');
                lines.push('def _openmc_studio_tolerant_search(value):');
                lines.push('    try:');
                lines.push('        return _openmc_studio_search_run(value)');
                lines.push('    except ValueError as exc:');
                lines.push('        print(f"Warning: reactivity search did not converge: {exc}")');
                lines.push('        return None');
                lines.push('integrator._keff_search_control.run = _openmc_studio_tolerant_search');
            }
        }

        // Run integration (commented out by default to allow XML export first)
        lines.push('# integrator.integrate()');

        return lines;
    }

    /**
     * Generate the Python code for a single source definition.
     *
     * @param source - The {@link OpenMCSource} to convert.
     * @param index - The zero-based source index for variable naming.
     * @param varName - Optional variable name override (used for mesh sub-sources).
     * @returns An array of code lines.
     */
    private generateSourceCode(source: OpenMCSource, index: number, varName?: string): string[] {
        const name = varName ?? `source_${index}`;
        const lines: string[] = [];

        if (source.type === 'file') {
            lines.push(`${name} = openmc.FileSource(path="${source.path}")`);
        } else if (source.type === 'compiled') {
            const paramsArg = source.parameters ? `, parameters="${source.parameters}"` : '';
            lines.push(`${name} = openmc.CompiledSource(library="${source.library}"${paramsArg})`);
        } else if (source.type === 'mesh') {
            // Mesh source (openmc/source.py:484): one sub-source per mesh
            // element; sub-source spatial distributions are ignored at runtime.
            // Strength is the computed sum of sub-source strengths.
            const subNames: string[] = [];
            (source.sources ?? []).forEach((sub, j) => {
                const subName = `${name}_elem_${j}`;
                lines.push(...this.generateSourceCode(sub, index, subName));
                subNames.push(subName);
            });
            const meshArg = source.meshId !== undefined ? `mesh_${source.meshId}` : 'None';
            lines.push(`${name} = openmc.MeshSource(${meshArg}, sources=[${subNames.join(', ')}])`);
            if (source.constraints) {
                lines.push(...this.generateSourceConstraintsCode(source.constraints, index, name));
            }
            return lines;
        } else if (source.type === 'tokamak') {
            // Tokamak source (openmc/source.py:901): Miller flux-surface
            // geometry + emission profile S(r/a) + single energy distribution
            const energyCode = generateUnivariateCode(source.energy, `${name}_energy`);
            lines.push(...energyCode.lines);
            const args: string[] = [
                `major_radius=${source.majorRadius}`,
                `minor_radius=${source.minorRadius}`,
                `elongation=${source.elongation}`,
                `triangularity=${source.triangularity}`,
                `shafranov_shift=${source.shafranovShift}`,
                `r_over_a=[${source.profile.map((p) => p.r).join(', ')}]`,
                `emission_density=[${source.profile.map((p) => p.s).join(', ')}]`,
                `energy=${energyCode.expression}`
            ];
            if (source.phiStart !== undefined) {
                args.push(`phi_start=${source.phiStart}`);
            }
            if (source.phiExtent !== undefined) {
                args.push(`phi_extent=${source.phiExtent}`);
            }
            if (source.nAlpha !== undefined) {
                args.push(`n_alpha=${source.nAlpha}`);
            }
            if (source.verticalShift !== undefined) {
                args.push(`vertical_shift=${source.verticalShift}`);
            }
            if (source.time) {
                const timeCode = generateTimeCode(source.time, `${name}_time`);
                lines.push(...timeCode.lines);
                args.push(`time=${timeCode.expression}`);
            }
            if (source.strength !== undefined && source.strength !== 1) {
                args.push(`strength=${source.strength}`);
            }
            lines.push(`${name} = openmc.TokamakSource(${args.join(', ')})`);
            if (source.constraints) {
                lines.push(...this.generateSourceConstraintsCode(source.constraints, index, name));
            }
            return lines;
        } else {
            lines.push(`${name} = openmc.IndependentSource()`);

            // Spatial distribution
            const spaceCode = generateSpatialCode(source.spatial, `${name}_space`);
            lines.push(...spaceCode.lines);
            lines.push(`${name}.space = ${spaceCode.expression}`);

            // Angular distribution
            if (source.angle) {
                const angleCode = generateAngleCode(source.angle, `${name}_angle`);
                lines.push(...angleCode.lines);
                lines.push(`${name}.angle = ${angleCode.expression}`);
            }

            // Energy distribution
            const energyCode = generateUnivariateCode(source.energy, `${name}_energy`);
            lines.push(...energyCode.lines);
            lines.push(`${name}.energy = ${energyCode.expression}`);

            // Time distribution (seconds)
            if (source.time) {
                const timeCode = generateTimeCode(source.time, `${name}_time`);
                lines.push(...timeCode.lines);
                lines.push(`${name}.time = ${timeCode.expression}`);
            }

            // Particle type
            if (source.particle) {
                lines.push(`${name}.particle = "${source.particle}"`);
            }
        }

        // Strength
        if (source.strength !== undefined && source.strength !== 1) {
            lines.push(`${name}.strength = ${source.strength}`);
        }

        // Constraints
        if (source.constraints) {
            lines.push(...this.generateSourceConstraintsCode(source.constraints, index, name));
        }

        return lines;
    }

    /**
     * Generate the constraints assignment for a source.
     *
     * @param constraints - The {@link OpenMCSourceConstraints} to convert.
     * @param index - The source index used for the variable name.
     * @param varName - Optional variable name override (used for mesh sub-sources).
     * @returns An array of code lines.
     */
    private generateSourceConstraintsCode(constraints: OpenMCSourceConstraints, index: number, varName?: string): string[] {
        const name = varName ?? `source_${index}`;
        const entries: string[] = [];
        if (constraints.domainType && constraints.domainIds && constraints.domainIds.length > 0) {
            const domainClass =
                constraints.domainType === 'cell' ? 'Cell' : constraints.domainType === 'material' ? 'Material' : 'Universe';
            entries.push(`'domains': [${constraints.domainIds.map((id) => `openmc.${domainClass}(${id})`).join(', ')}]`);
        }
        if (constraints.energyBounds) {
            entries.push(`'energy_bounds': (${constraints.energyBounds[0]}, ${constraints.energyBounds[1]})`);
        }
        if (constraints.timeBounds) {
            entries.push(`'time_bounds': (${constraints.timeBounds[0]}, ${constraints.timeBounds[1]})`);
        }
        if (constraints.fissionable !== undefined) {
            entries.push(`'fissionable': ${constraints.fissionable ? 'True' : 'False'}`);
        }
        if (constraints.rejectionStrategy) {
            entries.push(`'rejection_strategy': '${constraints.rejectionStrategy}'`);
        }
        if (entries.length === 0) {
            return [];
        }
        return [`${name}.constraints = {${entries.join(', ')}}`];
    }

    /**
     * Generate the Python code block for tallies and meshes.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns An array of code lines.
     */
    private generateTallyMeshCode(state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];

        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Tallies');
            lines.push('#==============================================================================');
        }

        // Meshes
        if (state.meshes.length > 0) {
            if (this.needsScriptRelativeMeshPath(state)) {
                lines.push('_script_dir = os.path.dirname(os.path.abspath(__file__))');
            }
            if (options.includeComments) {
                lines.push('# Meshes');
            }
            for (const mesh of state.meshes) {
                lines.push(...this.generateMeshCode(mesh));
            }
            lines.push('');
        }

        // Tallies (auto-append IFP kinetics tallies when enabled, like the XML layer)
        const effectiveTallies = [...state.tallies];
        if (state.settings.kinetics?.enabled) {
            const maxTallyId = state.tallies.reduce((max, t) => Math.max(max, t.id), 0);
            effectiveTallies.push(...getAutoIfpTallies(state.tallies, state.settings.kinetics, maxTallyId + 1));
        }
        if (effectiveTallies.length > 0) {
            if (options.includeComments) {
                lines.push('# Tallies');
            }
            for (const tally of effectiveTallies) {
                lines.push(...this.generateTallyCode(tally, state, options));
            }
            lines.push('');
        }

        const tallyVars = effectiveTallies.map((t) => `tally_${t.id}`).join(', ');

        if (effectiveTallies.length > 0) {
            lines.push(`tallies = openmc.Tallies([${tallyVars}])`);
        }

        return lines;
    }

    /**
     * Generate the Python code for a single mesh.
     *
     * @param mesh - The {@link OpenMCMesh} to convert.
     * @returns An array of code lines.
     */
    private generateMeshCode(mesh: OpenMCMesh): string[] {
        const lines: string[] = [];

        if (mesh.type === 'regular') {
            const regularMesh = mesh as OpenMCRegularMesh;
            lines.push(`mesh_${mesh.id} = openmc.RegularMesh(mesh_id=${mesh.id})`);
            lines.push(`mesh_${mesh.id}.lower_left = [${regularMesh.lowerLeft.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.upper_right = [${regularMesh.upperRight.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.dimension = [${regularMesh.dimension.join(', ')}]`);
        } else if (mesh.type === 'rectilinear') {
            const rectMesh = mesh as OpenMCRectilinearMesh;
            lines.push(`mesh_${mesh.id} = openmc.RectilinearMesh(mesh_id=${mesh.id})`);
            lines.push(`mesh_${mesh.id}.x_grid = [${rectMesh.xGrid.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.y_grid = [${rectMesh.yGrid.join(', ')}]`);
            lines.push(`mesh_${mesh.id}.z_grid = [${rectMesh.zGrid.join(', ')}]`);
        } else if (mesh.type === 'unstructured') {
            const unstructured = mesh as OpenMCUnstructuredMesh;
            const lengthMultiplier =
                unstructured.lengthMultiplier !== undefined && unstructured.lengthMultiplier !== 1
                    ? `, length_multiplier=${unstructured.lengthMultiplier}`
                    : '';
            const options = unstructured.options ? `, options="${this.escapePythonString(unstructured.options)}"` : '';
            lines.push(
                `mesh_${mesh.id} = openmc.UnstructuredMesh(${this.formatPythonMeshFilename(
                    unstructured.filename
                )}, library="${unstructured.library}"${lengthMultiplier}${options}, mesh_id=${mesh.id})`
            );
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

    /**
     * Generate the Python code for a single tally.
     *
     * @param tally - The {@link OpenMCTally} to convert.
     * @param state - The current {@link OpenMCState} for mesh lookups.
     * @param options - Export options (gates 0.16-only mesh rotation).
     * @returns An array of code lines.
     */
    private generateTallyCode(tally: OpenMCTally, state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];

        lines.push(`tally_${tally.id} = openmc.Tally(name="${this.escapePythonString(tally.name || '')}", tally_id=${tally.id})`);

        // Optional output options (`multiply_density` defaults to True and
        // `higher_moments` defaults to False, so only non-defaults are written).
        if (tally.multiplyDensity === false) {
            lines.push(`tally_${tally.id}.multiply_density = False`);
        }
        if (tally.higherMoments) {
            lines.push(`tally_${tally.id}.higher_moments = True`);
        }

        // Scores
        if (tally.scores.length > 0) {
            lines.push(`tally_${tally.id}.scores = [${tally.scores.map((s) => `"${s}"`).join(', ')}]`);
        }

        // Nuclides
        if (tally.nuclides.length > 0) {
            lines.push(`tally_${tally.id}.nuclides = [${tally.nuclides.map((n) => `"${n}"`).join(', ')}]`);
        }

        // Filters
        if (tally.filters.length > 0) {
            const filterVars: string[] = [];
            for (let i = 0; i < tally.filters.length; i++) {
                const filter = tally.filters[i];
                const filterVar = `filter_${tally.id}_${i}`;
                filterVars.push(filterVar);

                if (!isFilterSupported(filter.type, options.compat)) {
                    const warning =
                        getFilterSupportWarning(filter.type) ?? `Filter '${filter.type}' is not supported by this OpenMC version`;
                    lines.push(`# ${warning} (filter index ${i} on tally ${tally.id})`);
                    filterVars.pop();
                    continue;
                }

                switch (filter.type) {
                    case 'energy':
                        lines.push(`${filterVar} = openmc.EnergyFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'energyout':
                        lines.push(`${filterVar} = openmc.EnergyoutFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'mesh':
                    case 'meshborn':
                    case 'meshsurface': {
                        if (filter.meshId) {
                            const filterClass =
                                filter.type === 'mesh' ? 'MeshFilter' : filter.type === 'meshborn' ? 'MeshBornFilter' : 'MeshSurfaceFilter';
                            lines.push(`${filterVar} = openmc.${filterClass}(mesh_${filter.meshId})`);
                            if (filter.meshTranslation) {
                                lines.push(`${filterVar}.translation = [${filter.meshTranslation.join(', ')}]`);
                            }
                            if (filter.meshRotation) {
                                if (options.meshFilterRotationSupported ?? options.compat?.meshFilterRotation ?? false) {
                                    lines.push(`${filterVar}.rotation = [${filter.meshRotation.join(', ')}]`);
                                } else {
                                    lines.push(
                                        `# Mesh filter rotation ${filter.meshRotation.join(
                                            ' '
                                        )} requires OpenMC 0.16 or newer and was omitted from this script`
                                    );
                                }
                            }
                        }
                        break;
                    }
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
                        lines.push(
                            `${filterVar} = openmc.ParticleFilter([${filter.bins.map((b) => (b === 1 ? '"neutron"' : '"photon"')).join(', ')}])`
                        );
                        break;
                    case 'cellborn':
                        lines.push(`${filterVar} = openmc.CellBornFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'cellfrom':
                        lines.push(`${filterVar} = openmc.CellFromFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'distribcell':
                        lines.push(`${filterVar} = openmc.DistribcellFilter(${filter.bins[0] ?? 0})`);
                        break;
                    case 'delayedgroup':
                        lines.push(`${filterVar} = openmc.DelayedGroupFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'time':
                        lines.push(`${filterVar} = openmc.TimeFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'legendre':
                        lines.push(`${filterVar} = openmc.LegendreFilter(order=${filter.order ?? 5})`);
                        break;
                    case 'spatiallegendre':
                        lines.push(
                            `${filterVar} = openmc.SpatialLegendreFilter(order=${filter.order ?? 5}, axis='${filter.axis ?? 'z'}', minimum=${filter.min ?? 0}, maximum=${filter.max ?? 0})`
                        );
                        break;
                    case 'sphericalharmonics':
                        lines.push(`${filterVar} = openmc.SphericalHarmonicsFilter(order=${filter.order ?? 3})`);
                        if (filter.cosine && filter.cosine !== 'particle') {
                            lines.push(`${filterVar}.cosine = '${filter.cosine}'`);
                        }
                        break;
                    case 'zernike':
                        lines.push(
                            `${filterVar} = openmc.ZernikeFilter(order=${filter.order ?? 5}, x=${filter.center?.x ?? 0}, y=${filter.center?.y ?? 0}, r=${filter.center?.r ?? 1})`
                        );
                        break;
                    case 'zernikeradial':
                        lines.push(
                            `${filterVar} = openmc.ZernikeRadialFilter(order=${filter.order ?? 5}, x=${filter.center?.x ?? 0}, y=${filter.center?.y ?? 0}, r=${filter.center?.r ?? 1})`
                        );
                        break;
                    case 'energyfunction':
                        lines.push(
                            `${filterVar} = openmc.EnergyFunctionFilter(energy=[${(filter.energyValues ?? []).join(', ')}], y=[${(filter.responseValues ?? []).join(', ')}], interpolation='${filter.interpolation ?? 'linear-linear'}')`
                        );
                        break;
                    case 'materialfrom':
                        lines.push(`${filterVar} = openmc.MaterialFromFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'cellinstance': {
                        const pairs = getCellInstancePairs(filter);
                        if (filter.bins.length % 2 !== 0) {
                            lines.push(
                                `# Cell-instance bins had an odd length (${filter.bins.length}); only complete cell/instance pairs are exported`
                            );
                        }
                        const pairText = pairs.map((pair) => `(${pair.first}, ${pair.second})`).join(', ');
                        lines.push(`${filterVar} = openmc.CellInstanceFilter([${pairText}])`);
                        break;
                    }
                    case 'parentnuclide':
                        lines.push(
                            `${filterVar} = openmc.ParentNuclideFilter([${(filter.nuclideBins ?? [])
                                .map((name) => `"${this.escapePythonString(name)}"`)
                                .join(', ')}])`
                        );
                        break;
                    case 'meshmaterial': {
                        if (filter.meshId) {
                            const pairs = getMeshMaterialPairs(filter);
                            if (filter.bins.length % 2 !== 0) {
                                lines.push(
                                    `# Mesh-material bins had an odd length (${filter.bins.length}); only complete element/material pairs are exported`
                                );
                            }
                            const pairText = pairs.map((pair) => `(${pair.first}, ${pair.second})`).join(', ');
                            lines.push(`${filterVar} = openmc.MeshMaterialFilter(mesh_${filter.meshId}, [${pairText}])`);
                            if (filter.meshTranslation) {
                                lines.push(`${filterVar}.translation = [${filter.meshTranslation.join(', ')}]`);
                            }
                        }
                        break;
                    }
                    case 'collision':
                        lines.push(`${filterVar} = openmc.CollisionFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'reaction':
                        lines.push(
                            `${filterVar} = openmc.ReactionFilter([${(filter.reactionBins ?? [])
                                .map((bin) => `"${this.escapePythonString(normalizeReactionBin(bin) ?? bin)}"`)
                                .join(', ')}])`
                        );
                        break;
                    case 'particleproduction': {
                        const particles = filter.particleTypes ?? [];
                        const energies = filter.productionEnergyBins ?? [];
                        const energyArg = energies.length > 0 ? `, energies=[${energies.join(', ')}]` : '';
                        lines.push(
                            `${filterVar} = openmc.ParticleProductionFilter([${particles
                                .map((particle) => `"${this.escapePythonString(particle)}"`)
                                .join(', ')}]${energyArg})`
                        );
                        break;
                    }
                    case 'musurface':
                        lines.push(`${filterVar} = openmc.MuSurfaceFilter([${filter.bins.join(', ')}])`);
                        break;
                    case 'weight':
                        lines.push(`${filterVar} = openmc.WeightFilter([${filter.bins.join(', ')}])`);
                        break;
                    default:
                        lines.push(`# Unsupported filter type '${filter.type}' skipped (filter index ${i} on tally ${tally.id})`);
                        filterVars.pop();
                }
            }
            lines.push(`tally_${tally.id}.filters = [${filterVars.join(', ')}]`);
        }

        // Estimator
        if (tally.estimator) {
            lines.push(`tally_${tally.id}.estimator = "${tally.estimator}"`);
        }

        // Per-tally triggers (openmc/trigger.py: Trigger(trigger_type, threshold);
        // scores assigned as a list attribute). Requires run-level activation:
        // settings.trigger_active = True (emitted below with the trigger settings).
        if (tally.triggers && tally.triggers.length > 0) {
            const triggerVars: string[] = [];
            tally.triggers.forEach((trigger, i) => {
                const varName = `trigger_${tally.id}_${i}`;
                const ignoreArg = trigger.ignoreZeros ? ', ignore_zeros=True' : '';
                lines.push(`${varName} = openmc.Trigger('${trigger.type}', ${trigger.threshold}${ignoreArg})`);
                if (trigger.scores && trigger.scores.length > 0) {
                    lines.push(`${varName}.scores = [${trigger.scores.map((s) => `"${s}"`).join(', ')}]`);
                }
                triggerVars.push(varName);
            });
            lines.push(`tally_${tally.id}.triggers = [${triggerVars.join(', ')}]`);
        }

        // Derivative (openmc/tally_derivative.py: TallyDerivative ctor kwargs
        // are variable/material/nuclide; assigned to tally.derivative)
        if (tally.derivative) {
            const deriv = tally.derivative;
            const derivVar = `derivative_${deriv.id ?? tally.id}`;
            const nuclideArg = deriv.variable === 'nuclide_density' && deriv.nuclide ? `, nuclide='${deriv.nuclide}'` : '';
            lines.push(`${derivVar} = openmc.TallyDerivative(variable='${deriv.variable}', material=${deriv.materialId}${nuclideArg})`);
            lines.push(`tally_${tally.id}.derivative = ${derivVar}`);
        }

        lines.push('');
        return lines;
    }

    /**
     * Generate the Python code block for CMFD acceleration (openmc.cmfd).
     * CMFD is a C-API feature in this OpenMC version: configuration happens
     * via CMFDMesh/CMFDRun property assignments, not settings.xml.
     * Thin wrapper over {@link generateCmfdCodeLines} (kept in `common/` so it
     * stays testable without the Theia browser stack).
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns An array of code lines.
     */
    private generateCmfdCode(state: OpenMCState, options: PythonExportOptions): string[] {
        return generateCmfdCodeLines(state, !!options.includeComments);
    }

    /**
     * Generate the Python code block for plot definitions.
     *
     * @param state - The current {@link OpenMCState}.
     * @param options - Export options.
     * @returns An array of code lines.
     */
    private generatePlotsCode(state: OpenMCState, options: PythonExportOptions): string[] {
        const lines: string[] = [];

        if (options.includeComments) {
            lines.push('#==============================================================================');
            lines.push('# Plots');
            lines.push('#==============================================================================');
        }

        for (const plot of state.plots || []) {
            lines.push(...this.generatePlotCode(plot, state));
        }

        if (state.plots && state.plots.length > 0) {
            const plotVars = state.plots.map((p) => `plot_${p.id}`).join(', ');
            lines.push(`plots = openmc.Plots([${plotVars}])`);
        }

        return lines;
    }

    /**
     * Generate the construction code for a single plot configuration.
     *
     * @param plot - The {@link OpenMCPlotConfig} to convert.
     * @param state - Current state, used to invert the mask selection.
     * @returns An array of code lines.
     */
    private generatePlotCode(plot: OpenMCPlotConfig, state: OpenMCState): string[] {
        const lines: string[] = [];
        const colorBy = plot.colorBy === 'material' ? 'material' : 'cell';

        if (plot.type === 'slice') {
            lines.push(`plot_${plot.id} = openmc.SlicePlot(plot_id=${plot.id}, name="${plot.name ?? ''}")`);
            lines.push(`plot_${plot.id}.basis = "${plot.basis}"`);
            lines.push(`plot_${plot.id}.origin = (${plot.origin.join(', ')})`);
            lines.push(`plot_${plot.id}.width = (${plot.width ?? 10}, ${plot.height ?? 10})`);
            lines.push(`plot_${plot.id}.pixels = (${(plot.pixels ?? [1000, 1000]).join(', ')})`);
            lines.push(`plot_${plot.id}.color_by = "${colorBy}"`);
        } else if (plot.type === 'voxel') {
            lines.push(`plot_${plot.id} = openmc.VoxelPlot(plot_id=${plot.id}, name="${plot.name ?? ''}")`);
            const lowerLeft = plot.lowerLeft ?? [-10, -10, -10];
            const upperRight = plot.upperRight ?? [10, 10, 10];
            const origin = lowerLeft.map((v, i) => (v + upperRight[i]) / 2);
            const width = lowerLeft.map((v, i) => upperRight[i] - v);
            lines.push(`plot_${plot.id}.origin = (${origin.join(', ')})`);
            lines.push(`plot_${plot.id}.width = (${width.join(', ')})`);
            lines.push(`plot_${plot.id}.pixels = (${(plot.voxels ?? [50, 50, 50]).join(', ')})`);
            lines.push(`plot_${plot.id}.color_by = "${colorBy}"`);
        } else if (plot.type === 'solid-raytrace') {
            lines.push(`plot_${plot.id} = openmc.SolidRayTracePlot(plot_id=${plot.id}, name="${plot.name ?? ''}")`);
            lines.push(...this.generateRayTraceCode(plot));
            if (plot.lightPosition) {
                lines.push(`plot_${plot.id}.light_position = (${plot.lightPosition.join(', ')})`);
            }
            if (plot.diffuseFraction !== undefined) {
                lines.push(`plot_${plot.id}.diffuse_fraction = ${plot.diffuseFraction}`);
            }
            if (plot.opaqueIds && plot.opaqueIds.length > 0) {
                lines.push(`plot_${plot.id}.opaque_domains = [${plot.opaqueIds.join(', ')}]`);
            }
        } else {
            lines.push(`plot_${plot.id} = openmc.WireframeRayTracePlot(plot_id=${plot.id}, name="${plot.name ?? ''}")`);
            lines.push(...this.generateRayTraceCode(plot));
            lines.push(`plot_${plot.id}.wireframe_thickness = ${plot.wireframeThickness ?? 1}`);
            if (plot.wireframeColor) {
                lines.push(`plot_${plot.id}.wireframe_color = (${plot.wireframeColor.join(', ')})`);
            }
            if (plot.wireframeIds && plot.wireframeIds.length > 0) {
                const domainClass = colorBy === 'material' ? 'openmc.Material' : 'openmc.Cell';
                lines.push(`plot_${plot.id}.wireframe_domains = [${plot.wireframeIds.map((id) => `${domainClass}(${id})`).join(', ')}]`);
            }
        }

        // Display colors apply to slice and ray-traced plots; voxel output
        // stores raw IDs and ignores them. Overlap highlighting is slice-only.
        lines.push(...generatePlotAppearancePythonLines(plot, state));

        lines.push('');
        return lines;
    }

    /**
     * Generate the shared camera controls for ray-trace plots.
     *
     * @param plot - The ray-trace {@link OpenMCPlotConfig}.
     * @returns An array of code lines.
     */
    private generateRayTraceCode(plot: OpenMCPlotConfig): string[] {
        const lines: string[] = [];
        lines.push(`plot_${plot.id}.camera_position = (${(plot.cameraPosition ?? [1, 0, 0]).join(', ')})`);
        lines.push(`plot_${plot.id}.look_at = (${(plot.lookAt ?? [0, 0, 0]).join(', ')})`);
        if (plot.up) {
            lines.push(`plot_${plot.id}.up = (${plot.up.join(', ')})`);
        }
        lines.push(`plot_${plot.id}.horizontal_field_of_view = ${plot.horizontalFieldOfView ?? 70}`);
        if (plot.orthographicWidth) {
            lines.push(`plot_${plot.id}.orthographic_width = ${plot.orthographicWidth}`);
        }
        lines.push(`plot_${plot.id}.pixels = (${(plot.pixels ?? [1000, 1000]).join(', ')})`);
        lines.push(`plot_${plot.id}.color_by = "${plot.colorBy === 'material' ? 'material' : 'cell'}"`);
        return lines;
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Sanitize a name so it becomes a valid Python identifier.
     *
     * Replaces invalid characters with underscores, prefixes leading digits,
     * and appends `_` to Python reserved words.
     *
     * @param name - The raw name to sanitize.
     * @returns A valid Python identifier.
     */
    private sanitizeVariableName(name: string): string {
        // Remove invalid characters and ensure valid Python identifier
        let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '_');
        // Ensure doesn't start with number
        if (/^\d/.test(sanitized)) {
            sanitized = 'mat_' + sanitized;
        }
        // Avoid reserved words
        const reserved = [
            'and',
            'as',
            'assert',
            'break',
            'class',
            'continue',
            'def',
            'del',
            'elif',
            'else',
            'except',
            'False',
            'finally',
            'for',
            'from',
            'global',
            'if',
            'import',
            'in',
            'is',
            'lambda',
            'None',
            'nonlocal',
            'not',
            'or',
            'pass',
            'raise',
            'return',
            'True',
            'try',
            'while',
            'with',
            'yield'
        ];
        if (reserved.includes(sanitized)) {
            sanitized = sanitized + '_';
        }
        return sanitized;
    }

    /**
     * Escape special characters in a string for safe embedding in Python double-quoted strings.
     *
     * @param text - The raw text to escape.
     * @returns The escaped string.
     */
    private escapePythonString(text: string): string {
        // Escape quotes and backslashes
        return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    }

    /**
     * Convert an OpenMC region string to a Python expression.
     *
     * Replaces surface IDs with `surface_` variable references and converts
     * whitespace separators to `&` (intersection) operators.
     *
     * @param region - The raw region string (e.g. `"1 -2 3"`).
     * @returns The Python expression string.
     */
    private convertRegionStringToPython(region: string): string {
        // Convert OpenMC region string to Python expression
        // Replace surface IDs with surface_ variables
        // Example: "1 -2 3" -> "+surface_1 & -surface_2 & +surface_3"

        return region
            .replace(/([+-]?)(\d+)/g, (match, sign, id) => {
                const surfaceSign = sign === '-' ? '-' : '+';
                return `${surfaceSign}surface_${id}`;
            })
            .replace(/\s+/g, ' & ')
            .replace(/\|/g, ' | ')
            .replace(/~/g, ' ~');
    }

    /**
     * Convert a region AST node to a Python expression.
     *
     * Recursively traverses operator and surface nodes to build the equivalent
     * OpenMC Python region expression.
     *
     * @param node - The region AST node.
     * @returns The Python expression string.
     */
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
