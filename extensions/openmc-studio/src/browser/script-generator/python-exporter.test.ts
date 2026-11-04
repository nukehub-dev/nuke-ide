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
 * Python exporter snapshots for mesh authoring: rectilinear/unstructured mesh
 * definitions and MeshFilter translation/rotation must match the XML
 * semantics, with 0.16-only rotation gated by the caller's capability flag.
 */

import { describe, it, expect, vi } from 'vitest';
import { URI } from '@theia/core/lib/common/uri';

// Mock the browser-only modules in the exporter's import chain before import.
vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCPythonExporter } from './python-exporter';
import { DEFAULT_OPENMC_COMPAT } from '../../common/openmc-studio-protocol';
import { OpenMCState } from '../../common/openmc-state-schema';
import { NEUTRON_PARTICLE } from '../../common/particle-types';

/**
 * Build a minimal state with both new mesh types and a transformed mesh filter.
 *
 * @returns Test state.
 */
function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Mesh export', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Water',
                density: 1.0,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2.0, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'fixed source', particles: 100, batches: 5 },
            sources: [
                {
                    spatial: { type: 'point', origin: [0, 0, 0] },
                    energy: { type: 'uniform', min: 1e5, max: 2e7 },
                    particle: NEUTRON_PARTICLE,
                    strength: 1
                }
            ]
        },
        tallies: [
            {
                id: 1,
                name: 'Mesh flux',
                scores: ['flux'],
                nuclides: ['total'],
                filters: [
                    {
                        type: 'mesh',
                        bins: [4],
                        meshId: 4,
                        meshTranslation: [1, 2, 3],
                        meshRotation: [10, 20, 30]
                    }
                ]
            }
        ],
        meshes: [
            { type: 'rectilinear', id: 4, name: 'Axial grid', xGrid: [-1, 0, 1], yGrid: [-2, 0, 2], zGrid: [-5, 0, 5] },
            {
                type: 'unstructured',
                id: 5,
                name: 'Core mesh',
                filename: 'meshes/core.h5m',
                library: 'moab',
                lengthMultiplier: 2.5,
                options: 'MAX_DEPTH=20;PLANE_SET=2;'
            }
        ],
        plots: []
    };
}

/**
 * Render the single-file model script with the given rotation capability.
 *
 * @param rotationSupported - Whether 0.16 mesh rotation may be emitted.
 * @returns Generated Python source.
 */
function render(rotationSupported: boolean): string {
    const exporter = new OpenMCPythonExporter();
    return (exporter as unknown as { generateModelScript(state: OpenMCState, options: object): string }).generateModelScript(buildState(), {
        mode: 'single',
        includeComments: true,
        meshFilterRotationSupported: rotationSupported
    });
}

describe('python exporter mesh authoring', () => {
    it('emits rectilinear, unstructured, and transformed mesh-filter code', () => {
        const script = render(true);

        expect(script).toContain('mesh_4 = openmc.RectilinearMesh(mesh_id=4)');
        expect(script).toContain('mesh_4.x_grid = [-1, 0, 1]');
        expect(script).toContain('mesh_4.y_grid = [-2, 0, 2]');
        expect(script).toContain('mesh_4.z_grid = [-5, 0, 5]');
        expect(script).toContain('import os');
        expect(script).toContain('_script_dir = os.path.dirname(os.path.abspath(__file__))');
        expect(script).toContain(
            'mesh_5 = openmc.UnstructuredMesh(os.path.join(_script_dir, "meshes/core.h5m"), library="moab", length_multiplier=2.5, options="MAX_DEPTH=20;PLANE_SET=2;", mesh_id=5)'
        );
        expect(script).toContain('filter_1_0 = openmc.MeshFilter(mesh_4)');
        expect(script).toContain('filter_1_0.translation = [1, 2, 3]');
        expect(script).toContain('filter_1_0.rotation = [10, 20, 30]');
        expect(script).toContain('tally_1.filters = [filter_1_0]');
    });

    it('omits mesh rotation with an explanatory comment when unsupported', () => {
        const script = render(false);

        expect(script).toContain('filter_1_0.translation = [1, 2, 3]');
        expect(script).not.toContain('filter_1_0.rotation =');
        expect(script).toContain('requires OpenMC 0.16 or newer and was omitted from this script');
    });

    it('keeps absolute unstructured filenames as literals without the script-dir helper', () => {
        const state = buildState();
        const absoluteState = {
            ...state,
            meshes: state.meshes.map((mesh) => (mesh.type === 'unstructured' ? { ...mesh, filename: '/data/meshes/core.h5m' } : mesh))
        };
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(state: OpenMCState, options: object): string }).generateModelScript(
            absoluteState,
            {
                mode: 'single',
                includeComments: true,
                meshFilterRotationSupported: true
            }
        );

        expect(script).toContain('openmc.UnstructuredMesh("/data/meshes/core.h5m", library="moab"');
        expect(script).not.toContain('import os');
        expect(script).not.toContain('_script_dir');
    });
});

/**
 * Build an exporter with fake injected services so path-based exports can be
 * exercised without Theia boot or a real save dialog.
 *
 * @returns The exporter plus the recorded writes and mocks.
 */
function createExportHarness(): {
    exporter: OpenMCPythonExporter;
    writtenPaths: string[];
    showSaveDialog: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
} {
    const exporter = new OpenMCPythonExporter();
    const writtenPaths: string[] = [];
    const showSaveDialog = vi.fn(async (_props: unknown): Promise<URI | undefined> => undefined);
    const info = vi.fn();
    const error = vi.fn();
    const internals = exporter as unknown as {
        stateManager: { getState(): OpenMCState };
        backendService: { getOpenMCCompat(): Promise<typeof DEFAULT_OPENMC_COMPAT> };
        fileDialogService: { showSaveDialog: typeof showSaveDialog };
        fileService: {
            writeFile(uri: URI, data: unknown): Promise<void>;
            createFile(uri: URI, data: unknown): Promise<void>;
        };
        messageService: { info: typeof info; error: typeof error };
    };
    internals.stateManager = { getState: () => buildState() };
    internals.backendService = { getOpenMCCompat: async () => DEFAULT_OPENMC_COMPAT };
    internals.fileDialogService = { showSaveDialog };
    internals.fileService = {
        writeFile: async (uri: URI): Promise<void> => {
            writtenPaths.push(uri.path.toString());
        },
        createFile: async (uri: URI): Promise<void> => {
            writtenPaths.push(uri.path.toString());
        }
    };
    internals.messageService = { info, error };
    return { exporter, writtenPaths, showSaveDialog, info, error };
}

describe('python exporter path mode', () => {
    it('writes an absolute target path without opening the save dialog', async () => {
        const harness = createExportHarness();

        const result = await harness.exporter.exportToPython({
            mode: 'single',
            targetPath: '/workspace/export/model.py',
            includeComments: false,
            includeShebang: false,
            compat: DEFAULT_OPENMC_COMPAT
        });

        expect(result).toEqual({ success: true, files: ['/workspace/export/model.py'] });
        expect(harness.showSaveDialog).not.toHaveBeenCalled();
        expect(harness.writtenPaths).toEqual(['/workspace/export/model.py']);
        expect(harness.info).toHaveBeenCalledWith('Exported Python script: model.py');
    });

    it('rejects a non-.py target path before writing', async () => {
        const harness = createExportHarness();

        const result = await harness.exporter.exportToPython({
            mode: 'single',
            targetPath: '/workspace/export/model.txt',
            compat: DEFAULT_OPENMC_COMPAT
        });

        expect(result).toEqual({
            success: false,
            files: [],
            error: 'The Python export target must use the .py file extension.'
        });
        expect(harness.showSaveDialog).not.toHaveBeenCalled();
        expect(harness.writtenPaths).toEqual([]);
    });

    it('rejects a relative target path', async () => {
        const harness = createExportHarness();

        const result = await harness.exporter.exportToPython({
            mode: 'single',
            targetPath: 'model.py',
            compat: DEFAULT_OPENMC_COMPAT
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/absolute/);
        expect(harness.writtenPaths).toEqual([]);
    });

    it('rejects targetPath in separate-files mode', async () => {
        const harness = createExportHarness();

        const result = await harness.exporter.exportToPython({
            mode: 'separate',
            targetPath: '/workspace/scripts',
            compat: DEFAULT_OPENMC_COMPAT
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/targetPath/);
        expect(harness.showSaveDialog).not.toHaveBeenCalled();
        expect(harness.writtenPaths).toEqual([]);
    });

    it('keeps the save-dialog flow when no target path is provided', async () => {
        const harness = createExportHarness();
        harness.showSaveDialog.mockResolvedValue(new URI('/workspace/model.py'));

        const result = await harness.exporter.exportToPython({ mode: 'single', compat: DEFAULT_OPENMC_COMPAT });

        expect(result).toEqual({ success: true, files: ['file:///workspace/model.py'] });
        expect(harness.showSaveDialog).toHaveBeenCalledTimes(1);
        expect(harness.writtenPaths).toEqual(['/workspace/model.py']);
    });

    it('writes separate files into an explicit output directory', async () => {
        const harness = createExportHarness();

        const result = await harness.exporter.exportToPython({
            mode: 'separate',
            outputDirectory: '/workspace/scripts',
            compat: DEFAULT_OPENMC_COMPAT
        });

        expect(result.success).toBe(true);
        expect(result.files).toHaveLength(5);
        expect(harness.showSaveDialog).not.toHaveBeenCalled();
        expect(harness.writtenPaths).toEqual([
            '/workspace/scripts/materials.py',
            '/workspace/scripts/geometry.py',
            '/workspace/scripts/settings.py',
            '/workspace/scripts/tallies.py',
            '/workspace/scripts/model.py'
        ]);
    });
});
