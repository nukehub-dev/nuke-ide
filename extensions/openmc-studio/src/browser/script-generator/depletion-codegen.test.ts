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
 * Python exporter coverage for the advanced depletion surface: substeps,
 * reactivity control (openmc.lib modifier), external source rates, and
 * continuation.
 */

import { describe, expect, it, vi } from 'vitest';

// The exporter's import chain reaches Theia browser services that touch lumino
// DOM globals; mock the browser-only modules before importing the exporter.
vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCPythonExporter } from './python-exporter';
import { OpenMCDepletion, OpenMCState } from '../../common/openmc-state-schema';

function buildState(depletion: Partial<OpenMCDepletion> = {}): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'depletion-codegen', created: now, modified: now },
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
                name: 'Fuel',
                density: 10.0,
                densityUnit: 'g/cm3',
                nuclides: [
                    { name: 'U235', fraction: 1, fractionType: 'ao' },
                    { name: 'U238', fraction: 3, fractionType: 'ao' }
                ],
                thermalScattering: [],
                isDepletable: true,
                volume: 100
            }
        ],
        settings: {
            run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 },
            sources: []
        },
        tallies: [],
        meshes: [],
        depletion: {
            enabled: true,
            chainFile: '/chains/chain.xml',
            timeSteps: [86400, 86400],
            power: 1e6,
            solver: 'cecm',
            ...depletion
        }
    } as OpenMCState;
}

function generate(state: OpenMCState): string {
    const exporter = new OpenMCPythonExporter();
    return (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(state, {
        mode: 'single',
        includeComments: true
    });
}

describe('Python depletion exporter', () => {
    it('emits substeps, external rates, control-rod search, and continuation', () => {
        const script = generate(
            buildState({
                substeps: 2,
                externalSourceRates: [
                    {
                        material: 1,
                        composition: [
                            { name: 'U235', weightPercent: 90 },
                            { name: 'U238', weightPercent: 10 }
                        ],
                        rate: -1e-6,
                        units: 'g/s',
                        timesteps: [0, 1]
                    }
                ],
                reactivityControl: {
                    enabled: true,
                    parameter: 'cell-translation',
                    cellId: 7,
                    axis: 'z',
                    x0: 0,
                    x1: 10,
                    bracket: [-20, 20],
                    targetKeff: 1.0,
                    kTol: 1e-4,
                    sigmaFinal: 3e-4,
                    maxIterations: 40,
                    onFailure: 'warn'
                },
                continueFromResults: '/runs/old/depletion_results.h5',
                continueTimesteps: true
            })
        );

        expect(script).toContain('import openmc.lib');
        expect(script).toContain('prev_results = openmc.deplete.Results("/runs/old/depletion_results.h5")');
        expect(script).toContain('prev_results=prev_results');
        expect(script).toContain('integrator = openmc.deplete.CECMIntegrator(op, timesteps, power, substeps=2, continue_timesteps=True)');
        expect(script).toContain(
            'integrator.add_external_source_rate(1, {"U235":90,"U238":10}, -0.000001, rate_units="g/s", timesteps=[0, 1])'
        );
        expect(script).toContain('def _openmc_studio_reactivity(value):');
        expect(script).toContain('cell = openmc.lib.cells[7]');
        expect(script).toContain('translation[2] = value');
        expect(script).toContain('integrator.add_keff_search_control(');
        expect(script).toContain('bracket=[-20, 20]');
        expect(script).toContain('maxiter=40');
        expect(script).toContain('target=1');
        expect(script).toContain('integrator._keff_search_control.run = _openmc_studio_tolerant_search');
    });

    it('emits a nuclide-density modifier through openmc.lib', () => {
        const script = generate(
            buildState({
                reactivityControl: {
                    enabled: true,
                    parameter: 'nuclide-density',
                    materialId: 1,
                    nuclide: 'U235',
                    x0: 0.0005,
                    x1: 0.001,
                    bracket: [0.0001, 0.002]
                }
            })
        );
        expect(script).toContain('lib_mat = openmc.lib.materials[1]');
        expect(script).toContain('index = nuclides.index("U235")');
        expect(script).toContain('lib_mat.set_densities(nuclides, densities)');
    });

    it('emits a zero-power vector for decay-only steps', () => {
        const script = generate(buildState({ decayOnlySteps: [1] }));
        expect(script).toContain('decay_only_steps = [1]');
        expect(script).toContain('power = [0.0 if i in decay_only_steps else power for i in range(len(timesteps))]');
    });

    it('keeps the default integrator call shape when no advanced controls are set', () => {
        const script = generate(buildState());
        expect(script).not.toContain('substeps=');
        expect(script).not.toContain('continue_timesteps=');
        expect(script).not.toContain('add_external_source_rate');
        expect(script).not.toContain('add_keff_search_control');
        expect(script).not.toContain('import openmc.lib');
    });
});
