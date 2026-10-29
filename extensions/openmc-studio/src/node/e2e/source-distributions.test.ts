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
 * Real-run e2e for the source generator: a fixed-source model with a tabular
 * spectrum, an anisotropic mu-phi direction, and a tabular time distribution.
 * The generated Python builds the model, exports XML, and the OpenMC binary
 * runs it. Skips cleanly unless NUKE_TEST_PYTHON and OPENMC_CROSS_SECTIONS are
 * configured.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

vi.mock('@theia/filesystem/lib/browser', () => ({ FileDialogService: class {}, SaveFileDialogProps: {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));

import { OpenMCPythonExporter } from '../../browser/script-generator/python-exporter';
import { OpenMCState } from '../../common/openmc-state-schema';

const PYTHON = process.env.NUKE_TEST_PYTHON;
const CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
const OPENMC_EXE = PYTHON ? path.join(path.dirname(PYTHON), 'openmc') : undefined;
const CAN_RUN = !!(PYTHON && OPENMC_EXE && fs.existsSync(OPENMC_EXE) && CROSS_SECTIONS && fs.existsSync(CROSS_SECTIONS));
const RUN_TIMEOUT = 120_000;

/** Minimal fixed-source state with tabular energy/time and mu-phi direction. */
function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Source e2e', created: now, modified: now },
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
                nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'fixed source', particles: 200, batches: 2 },
            sources: [
                {
                    spatial: { type: 'box', lowerLeft: [-5, -5, -5], upperRight: [5, 5, 5] },
                    energy: {
                        type: 'tabular',
                        energies: [1e-5, 1e3, 14e6],
                        probabilities: [1e-12, 0.2, 0.8],
                        interpolation: 'log-log'
                    },
                    angle: {
                        type: 'mu-phi',
                        mu: { type: 'uniform', min: -1, max: 1 },
                        phi: { type: 'uniform', min: 0, max: 2 * Math.PI },
                        referenceUvW: [0, 0, 1],
                        referenceVwu: [1, 0, 0]
                    },
                    time: {
                        type: 'tabular',
                        energies: [0, 1e-6, 1e-3],
                        probabilities: [1, 1, 0],
                        interpolation: 'linear-linear'
                    },
                    particle: 'neutron',
                    strength: 1
                }
            ]
        },
        tallies: [
            {
                id: 1,
                scores: ['flux'],
                nuclides: ['total'],
                filters: []
            }
        ],
        meshes: [],
        plots: []
    } as OpenMCState;
}

describe.skipIf(!CAN_RUN)('source distributions real run', () => {
    it('runs a fixed-source model with tabular spectrum, mu-phi direction, and tabular time', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmc-source-e2e-'));
        const exporter = new OpenMCPythonExporter();
        const script = (exporter as unknown as { generateModelScript(s: OpenMCState, o: object): string }).generateModelScript(
            buildState(),
            { mode: 'single', includeComments: false, includeShebang: false }
        );
        fs.writeFileSync(path.join(dir, 'model.py'), script);

        const python = spawnSync(PYTHON!, ['model.py'], {
            cwd: dir,
            env: {
                ...process.env,
                OPENMC_CROSS_SECTIONS: CROSS_SECTIONS,
                PATH: `${path.dirname(PYTHON!)}${path.delimiter}${process.env.PATH ?? ''}`
            },
            timeout: RUN_TIMEOUT,
            encoding: 'utf-8'
        });
        expect(python.status, `generated model.py failed:\n${python.stdout}\n${python.stderr}`).toBe(0);

        const run = spawnSync(OPENMC_EXE!, [], {
            cwd: dir,
            env: { ...process.env, OPENMC_CROSS_SECTIONS: CROSS_SECTIONS },
            timeout: RUN_TIMEOUT,
            encoding: 'utf-8'
        });
        expect(run.status, `openmc failed on generated source:\n${run.stdout}\n${run.stderr}`).toBe(0);
        expect(fs.readdirSync(dir).some((name) => name.startsWith('statepoint') && name.endsWith('.h5'))).toBe(true);

        fs.rmSync(dir, { recursive: true, force: true });
    });
});
