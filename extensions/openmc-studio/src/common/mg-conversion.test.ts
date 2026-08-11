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

/** Tests for the CE ↔ multi-group conversion state logic. */

import { describe, it, expect } from 'vitest';

import { computeMgConversion, computeMgRevert, computeNuclideWiseMgConversion } from './mg-conversion';
import { OpenMCMaterial, OpenMCState } from './openmc-state-schema';

function makeMaterial(id: number, name: string): OpenMCMaterial {
    return {
        id,
        name,
        density: 10.0,
        densityUnit: 'g/cm3',
        nuclides: [{ name: 'U235', fraction: 1.0, fractionType: 'ao' }],
        thermalScattering: []
    };
}

function makeState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Conv Test', created: now, modified: now },
        geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
        materials: [makeMaterial(1, 'fuel'), makeMaterial(2, 'clad'), makeMaterial(3, 'moderator')],
        settings: { run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 }, sources: [] },
        tallies: [],
        meshes: [],
        plots: []
    } as OpenMCState;
}

describe('computeMgConversion', () => {
    it('converts mapped materials to macroscopic and stashes the backup', () => {
        const state = makeState();
        const updates = computeMgConversion(
            state,
            [
                { materialName: 'fuel', xsDataName: 'fuel' },
                { materialName: 'clad', xsDataName: 'clad' }
            ],
            '/work/mgxs.h5'
        );

        expect(updates.convertedNames).toEqual(['fuel', 'clad']);
        const fuel = updates.materials.find((m) => m.name === 'fuel')!;
        expect(fuel.macroscopic).toEqual({ name: 'fuel' });
        expect(fuel.densityUnit).toBe('macro');
        expect(fuel.density).toBe(1.0);
        // Nuclide decomposition is kept (the revert backup needs it too)
        expect(fuel.nuclides).toHaveLength(1);

        expect(updates.settings).toEqual({ energyMode: 'multigroup', mgxsLibrary: '/work/mgxs.h5', nuclideWiseMgxs: false });
        expect(updates.mgBackup.energyMode).toBeUndefined();
        expect(updates.mgBackup.materials).toHaveLength(3);
        expect(updates.mgBackup.materials[0].macroscopic).toBeUndefined();
    });

    it('leaves unmapped materials untouched (mixed models)', () => {
        const state = makeState();
        const updates = computeMgConversion(state, [{ materialName: 'fuel', xsDataName: 'fuel' }], '/work/mgxs.h5');

        expect(updates.convertedNames).toEqual(['fuel']);
        const moderator = updates.materials.find((m) => m.name === 'moderator')!;
        expect(moderator.macroscopic).toBeUndefined();
        expect(moderator.densityUnit).toBe('g/cm3');
        expect(moderator.density).toBe(10.0);
    });

    it('uses the xsDataName for the macroscopic reference, not the material name', () => {
        const state = makeState();
        const updates = computeMgConversion(state, [{ materialName: 'fuel', xsDataName: 'fuel_300K' }], '/work/mgxs.h5');
        expect(updates.materials[0].macroscopic).toEqual({ name: 'fuel_300K' });
    });
});

describe('computeMgRevert', () => {
    it('restores the backed-up materials and energy mode', () => {
        const state = makeState();
        const conversion = computeMgConversion(state, [{ materialName: 'fuel', xsDataName: 'fuel' }], '/work/mgxs.h5');
        state.materials = conversion.materials;
        state.settings.energyMode = 'multigroup';
        state.metadata.mgBackup = conversion.mgBackup;

        const revert = computeMgRevert(state);

        expect(revert).toBeDefined();
        expect(revert!.energyMode).toBeUndefined();
        const fuel = revert!.materials.find((m) => m.name === 'fuel')!;
        expect(fuel.macroscopic).toBeUndefined();
        expect(fuel.densityUnit).toBe('g/cm3');
        expect(fuel.density).toBe(10.0);
    });

    it('returns undefined when no backup exists', () => {
        expect(computeMgRevert(makeState())).toBeUndefined();
    });

    it('strips macroscopic when applied through a shallow-merge update', () => {
        const state = makeState();
        const conversion = computeMgConversion(state, [{ materialName: 'fuel', xsDataName: 'fuel' }], '/work/mgxs.h5');
        state.materials = conversion.materials;
        state.settings.energyMode = 'multigroup';
        state.metadata.mgBackup = conversion.mgBackup;

        const revert = computeMgRevert(state)!;
        // The state manager applies material updates with a shallow merge
        // ({ ...oldValue, ...updates }), which keeps keys absent from the
        // update — the revert must strip `macroscopic` explicitly.
        const applied = revert.materials.map((upd) => ({ ...state.materials.find((m) => m.id === upd.id)!, ...upd }));
        const fuel = applied.find((m) => m.name === 'fuel')!;
        expect(fuel.macroscopic).toBeUndefined();
        // And it must stay gone after the state manager's JSON round-trip
        expect(JSON.parse(JSON.stringify(fuel)).macroscopic).toBeUndefined();
    });
});

describe('computeNuclideWiseMgConversion', () => {
    it('keeps materials nuclide-decomposed and sets the nuclide-wise flag', () => {
        const state = makeState();
        const updates = computeNuclideWiseMgConversion(state, [{ nuclideName: 'U235', xsDataName: 'U235' }], '/work/mgxs.h5');

        const fuel = updates.materials.find((m) => m.name === 'fuel')!;
        expect(fuel.macroscopic).toBeUndefined();
        expect(fuel.densityUnit).toBe('g/cm3');
        expect(fuel.density).toBe(10.0);

        expect(updates.settings).toEqual({ energyMode: 'multigroup', mgxsLibrary: '/work/mgxs.h5', nuclideWiseMgxs: true });
        expect(updates.coveredNuclides).toEqual(['U235']);
        expect(updates.missingNuclides).toEqual([]);
        expect(updates.mgBackup.energyMode).toBeUndefined();
        expect(updates.mgBackup.materials).toHaveLength(3);
    });

    it('expands element symbols to natural isotopes for coverage', () => {
        const state = makeState();
        state.materials = [
            {
                id: 1,
                name: 'steel',
                density: 7.8,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'Fe', fraction: 1.0, fractionType: 'ao' }],
                thermalScattering: []
            }
        ];
        const updates = computeNuclideWiseMgConversion(
            state,
            [
                { nuclideName: 'Fe54', xsDataName: 'Fe54' },
                { nuclideName: 'Fe56', xsDataName: 'Fe56' },
                { nuclideName: 'Fe57', xsDataName: 'Fe57' }
            ],
            '/work/mgxs.h5'
        );

        // Fe expands to Fe54/Fe56/Fe57/Fe58; the library lacks Fe58
        expect(updates.coveredNuclides).toEqual(['Fe54', 'Fe56', 'Fe57']);
        expect(updates.missingNuclides).toEqual(['Fe58']);
    });

    it('reports nuclides missing from the library', () => {
        const state = makeState();
        const updates = computeNuclideWiseMgConversion(state, [], '/work/mgxs.h5');
        expect(updates.coveredNuclides).toEqual([]);
        expect(updates.missingNuclides).toEqual(['U235']);
    });
});
