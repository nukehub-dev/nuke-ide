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
 * Tests for CMFD codegen (openmc.cmfd.CMFDMesh/CMFDRun emission) and the
 * CMFD validation rules in validateState.
 */

import { describe, it, expect } from 'vitest';

import { generateCmfdCodeLines } from '../../common/cmfd';
import { OpenMCStudioBackendServiceImpl } from '../../node/openmc-studio-backend-service';
import { OpenMCState, OpenMCCmfdSettings } from '../../common/openmc-state-schema';

/** Build a minimal state with the given CMFD settings. */
function buildState(cmfd?: OpenMCCmfdSettings): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'cmfd-test', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1 }],
            universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
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
            run: { mode: 'eigenvalue', particles: 1000, inactive: 20, batches: 100 },
            sources: [],
            cmfd
        },
        tallies: [],
        meshes: []
    };
}

const FULL_CMFD: OpenMCCmfdSettings = {
    enabled: true,
    mesh: {
        lowerLeft: [-10, -5, -1],
        upperRight: [10, 5, 1],
        dimension: [10, 5, 1],
        albedo: [0, 0, 0.5, 1, 1, 1]
    },
    feedback: true,
    tallyBegin: 5,
    solverBegin: 10,
    cmfdKtol: 1e-7,
    stol: 1e-6,
    norm: 0.95,
    gaussSeidelTolerance: [1e-12, 1e-6],
    downscatter: true,
    powerMonitor: true,
    windowType: 'rolling',
    windowSize: 7,
    runAdjoint: true,
    adjointType: 'math'
};

function cmfdLines(state: OpenMCState): string[] {
    return generateCmfdCodeLines(state, false);
}

describe('CMFD codegen (openmc.cmfd C-API surface)', () => {
    it('emits the full inline-mesh CMFDMesh and CMFDRun configuration', () => {
        const lines = cmfdLines(buildState(FULL_CMFD));

        expect(lines).toContain('import openmc.cmfd');
        expect(lines).toContain('cmfd_mesh = openmc.cmfd.CMFDMesh()');
        expect(lines).toContain('cmfd_mesh.lower_left = (-10, -5, -1)');
        expect(lines).toContain('cmfd_mesh.upper_right = (10, 5, 1)');
        expect(lines).toContain('cmfd_mesh.dimension = (10, 5, 1)');
        expect(lines).toContain('cmfd_mesh.albedo = (0, 0, 0.5, 1, 1, 1)');

        expect(lines).toContain('cmfd_run = openmc.cmfd.CMFDRun()');
        expect(lines).toContain('cmfd_run.mesh = cmfd_mesh');
        expect(lines).toContain('cmfd_run.feedback = True');
        expect(lines).toContain('cmfd_run.tally_begin = 5');
        expect(lines).toContain('cmfd_run.solver_begin = 10');
        expect(lines).toContain('cmfd_run.cmfd_ktol = 1e-7');
        expect(lines).toContain('cmfd_run.stol = 0.000001');
        expect(lines).toContain('cmfd_run.norm = 0.95');
        expect(lines).toContain('cmfd_run.gauss_seidel_tolerance = [1e-12, 0.000001]');
        expect(lines).toContain('cmfd_run.downscatter = True');
        expect(lines).toContain('cmfd_run.power_monitor = True');
        expect(lines).toContain("cmfd_run.window_type = 'rolling'");
        expect(lines).toContain('cmfd_run.window_size = 7');
        expect(lines).toContain('cmfd_run.run_adjoint = True');
        expect(lines).toContain("cmfd_run.adjoint_type = 'math'");
    });

    it('references the state mesh when meshRef is set', () => {
        const lines = cmfdLines(buildState({ enabled: true, meshRef: 3, mesh: { albedo: [1, 1, 1, 1, 1, 1] } }));
        expect(lines).toContain('cmfd_mesh.lower_left = mesh_3.lower_left');
        expect(lines).toContain('cmfd_mesh.upper_right = mesh_3.upper_right');
        expect(lines).toContain('cmfd_mesh.dimension = mesh_3.dimension');
    });

    it('defaults albedo to all 1 and feedback to False when unset', () => {
        const lines = cmfdLines(buildState({ enabled: true, mesh: { lowerLeft: [0, 0, 0], upperRight: [1, 1, 1], dimension: [2, 2, 2] } }));
        expect(lines).toContain('cmfd_mesh.albedo = (1, 1, 1, 1, 1, 1)');
        expect(lines).toContain('cmfd_run.feedback = False');
    });
});

describe('CMFD validation (validateState)', () => {
    const backend = new OpenMCStudioBackendServiceImpl();

    it('warns when CMFD is enabled outside eigenvalue mode', async () => {
        const state = buildState(FULL_CMFD);
        state.settings.run = { mode: 'fixed source', particles: 1000, batches: 10 };
        const result = await backend.validateState({ state });
        expect(result.issues.some((i) => i.message.includes('CMFD acceleration requires eigenvalue'))).toBe(true);
    });

    it('passes a valid CMFD configuration', async () => {
        const result = await backend.validateState({ state: buildState(FULL_CMFD) });
        expect(result.issues.filter((i) => i.message.toLowerCase().includes('cmfd'))).toEqual([]);
    });

    it('errors when CMFD is enabled with no mesh at all', async () => {
        const result = await backend.validateState({ state: buildState({ enabled: true }) });
        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('no mesh is defined'))).toBe(true);
    });

    it('errors on inverted inline mesh bounds', async () => {
        const state = buildState({
            enabled: true,
            mesh: { lowerLeft: [10, 0, 0], upperRight: [-10, 1, 1], dimension: [2, 2, 2] }
        });
        const result = await backend.validateState({ state });
        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('bounds are invalid'))).toBe(true);
    });

    it('errors on out-of-range albedo', async () => {
        const state = buildState({
            enabled: true,
            mesh: { lowerLeft: [0, 0, 0], upperRight: [1, 1, 1], dimension: [2, 2, 2], albedo: [0, 0, 0, 0, 0, 1.5] }
        });
        const result = await backend.validateState({ state });
        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('albedo'))).toBe(true);
    });

    it('errors when meshRef points at a missing mesh', async () => {
        const state = buildState({ enabled: true, meshRef: 99 });
        const result = await backend.validateState({ state });
        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('mesh 99 which does not exist'))).toBe(true);
    });

    it('errors when meshRef points at a non-regular mesh', async () => {
        const state = buildState({ enabled: true, meshRef: 5 });
        state.meshes = [{ type: 'cylindrical', id: 5, rGrid: [0, 1], phiGrid: [0, 6.28], zGrid: [0, 1] }];
        const result = await backend.validateState({ state });
        expect(result.issues.some((i) => i.severity === 'error' && i.message.includes('not a regular mesh'))).toBe(true);
    });
});
