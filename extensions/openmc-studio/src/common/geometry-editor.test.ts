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

/** Tests for the pure CSG editor model helpers. */

import { describe, expect, it } from 'vitest';

import {
    buildFillTargetGroups,
    clearLatticeUniverses,
    emptyLatticeUniverses,
    fillAllLatticeUniverses,
    fillLatticeRing,
    fillLatticeRow,
    fillTargetError,
    filterFillTargetGroups,
    findFillTarget,
    geometryIssueAnchor,
    geometryIssueTab,
    latticePositionCount,
    latticeReferencedUniverses,
    latticeSummary,
    parseAlbedoInput,
    parseDensityOverride,
    parseOptionalVectorInput,
    periodicPartnerCandidates,
    setLatticePosition,
    summarizeGeometryIssues
} from './geometry-editor';
import { OpenMCLattice, OpenMCSurface, OpenMCState } from './openmc-state-schema';

/** Build a rect lattice with a known 2×2×1 universe grid. */
function rectLattice(): OpenMCLattice {
    return {
        id: 10,
        type: 'rect',
        name: 'Assembly',
        dimensions: [2, 2],
        pitch: [1.26, 1.26],
        lowerLeft: [0, 0],
        universes: [
            [
                [1, 2],
                [2, 1]
            ]
        ],
        outer: 3
    };
}

/** Build a hex lattice with two rings. */
function hexLattice(): OpenMCLattice {
    return {
        id: 11,
        type: 'hex',
        name: 'Hex assembly',
        rings: 2,
        center: [0, 0],
        pitch: [1.5],
        orientation: 'y',
        universes: [[[1, 1, 1, 1, 1, 1], [2]]]
    };
}

/** Minimal state with a couple of materials and universes. */
function populatedState(): OpenMCState {
    const state = {
        metadata: { version: '1.1.0', name: 'Test', created: '', modified: '' },
        geometry: {
            surfaces: [],
            cells: [],
            universes: [],
            lattices: [],
            rootUniverseId: 0
        },
        settings: {
            run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 },
            sources: []
        },
        tallies: [],
        meshes: []
    } as unknown as OpenMCState;
    state.materials = [
        {
            id: 1,
            name: 'Fuel',
            density: 10,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'U235', fraction: 1, fractionType: 'ao' }],
            thermalScattering: []
        },
        {
            id: 2,
            name: 'Water',
            density: 1,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'H1', fraction: 1, fractionType: 'ao' }],
            thermalScattering: []
        }
    ];
    state.geometry.universes = [
        { id: 0, name: 'root', cellIds: [] },
        { id: 3, name: 'Pin', cellIds: [] },
        { id: 4, name: 'Guide tube', cellIds: [1] }
    ];
    state.geometry.lattices = [rectLattice(), hexLattice()];
    return state;
}
describe('geometry validation grouping', () => {
    it('maps issue paths to their owning tab and anchor', () => {
        expect(geometryIssueTab({ severity: 'error', category: 'geometry', message: 'x', path: 'geometry.lattices.4' })).toBe('lattices');
        expect(geometryIssueTab({ severity: 'error', category: 'geometry', message: 'x', path: 'geometry.surfaces.2' })).toBe('surfaces');
        expect(geometryIssueAnchor({ severity: 'error', category: 'geometry', message: 'x', path: 'geometry.cells.7' })).toBe(
            'csg-focus-cells-7'
        );
    });

    it('falls back to message keywords for pathless issues', () => {
        expect(geometryIssueTab({ severity: 'error', category: 'geometry', message: 'Root universe 0 has no cells' })).toBe('universes');
        expect(
            geometryIssueTab({ severity: 'error', category: 'geometry', message: 'Surface #2: periodic boundary has no partner surface' })
        ).toBe('surfaces');
        expect(geometryIssueTab({ severity: 'error', category: 'geometry', message: 'Lattice #4 shares an ID' })).toBe('lattices');
        expect(geometryIssueAnchor({ severity: 'error', category: 'geometry', message: 'Surface #2 has no partner' })).toBe(
            'csg-focus-surfaces-2'
        );
    });

    it('groups issues in tab order and counts severities', () => {
        const summary = summarizeGeometryIssues([
            { severity: 'error', category: 'geometry', message: 'Lattice #1' },
            { severity: 'warning', category: 'geometry', message: 'Cell #2' },
            { severity: 'error', category: 'geometry', message: 'Cell #3' }
        ]);
        expect(summary.errors).toBe(2);
        expect(summary.warnings).toBe(1);
        expect(summary.groups.map((group) => group.tab)).toEqual(['cells', 'lattices']);
        expect(summary.groups[0].issues).toHaveLength(2);
    });
});

describe('lattice brush operations', () => {
    it('assigns a single rectangular position without mutating the source', () => {
        const lattice = rectLattice();
        const next = setLatticePosition(lattice.universes, { kind: 'rect', z: 0, y: 0, x: 1 }, 9);
        expect(next[0][0][1]).toBe(9);
        expect(lattice.universes[0][0][1]).toBe(2);
    });

    it('assigns a single hexagonal position and fills a ring', () => {
        const lattice = hexLattice();
        const assigned = setLatticePosition(lattice.universes, { kind: 'hex', z: 0, ring: 0, theta: 3 }, 8);
        expect(assigned[0][0][3]).toBe(8);
        const ring = fillLatticeRing(lattice.universes, 0, 0, 7);
        expect(ring[0][0]).toEqual(new Array(6).fill(7));
        expect(ring[0][1]).toEqual([2]);
    });

    it('fills a row and all positions', () => {
        const lattice = rectLattice();
        const row = fillLatticeRow(lattice.universes, 0, 1, 6);
        expect(row[0][1]).toEqual([6, 6]);
        const all = fillAllLatticeUniverses(lattice.universes, 4);
        expect(all.flat(2).every((id) => id === 4)).toBe(true);
        expect(
            clearLatticeUniverses(lattice.universes)
                .flat(2)
                .every((id) => id === 0)
        ).toBe(true);
    });

    it('summarizes dimensions, pitch, positions, and referenced universes', () => {
        const lattice = rectLattice();
        expect(latticePositionCount(lattice)).toBe(4);
        expect(latticeReferencedUniverses(lattice)).toEqual([1, 2, 3]);
        expect(latticeSummary(lattice)).toBe('2×2×1 · pitch 1.26 × 1.26 · 4 positions, 3 universes');
    });

    it('reports referenced universes with no cells', () => {
        const state = populatedState();
        expect(emptyLatticeUniverses(state.geometry.lattices[0], state.geometry.universes)).toEqual([3]);
    });
});

describe('fill target picker', () => {
    it('groups materials, universes, and lattices with type badges', () => {
        const groups = buildFillTargetGroups(populatedState());
        expect(groups.map((group) => group.kind)).toEqual(['material', 'universe', 'lattice']);
        expect(groups[0].targets[0].badge).toBe('Material');
        expect(groups[1].targets.map((target) => target.id)).toEqual([3, 4]);
        expect(groups[2].targets[1].badge).toBe('Hex lattice');
    });

    it('filters across groups and finds a selection', () => {
        const groups = buildFillTargetGroups(populatedState());
        const filtered = filterFillTargetGroups(groups, 'guide');
        expect(filtered).toHaveLength(1);
        expect(filtered[0].targets[0].label).toBe('#4 Guide tube');
        const target = findFillTarget(groups, 'lattice', 10);
        expect(target?.label).toBe('#10 Assembly');
        expect(findFillTarget(groups, 'universe', 0)).toBeUndefined();
    });
});

describe('periodic partner candidates', () => {
    it('lists only other periodic planes and never the surface itself', () => {
        const surfaces: OpenMCSurface[] = [
            { id: 1, type: 'x-plane', coefficients: { x0: -1 }, boundary: 'periodic' },
            { id: 2, type: 'x-plane', coefficients: { x0: 1 }, boundary: 'periodic' },
            { id: 3, type: 'y-plane', coefficients: { y0: 1 }, boundary: 'reflective' },
            { id: 4, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 1 }, boundary: 'periodic' }
        ];
        expect(periodicPartnerCandidates(surfaces, 1).map((surface) => surface.id)).toEqual([2]);
        expect(periodicPartnerCandidates(surfaces).map((surface) => surface.id)).toEqual([1, 2]);
    });
});

describe('inline form parsing', () => {
    it('parses optional rotation and translation vectors', () => {
        expect(parseOptionalVectorInput(['', '', ''], 'Rotation')).toEqual({});
        expect(parseOptionalVectorInput(['0', '90', '0'], 'Rotation')).toEqual({ value: [0, 90, 0] });
        expect(parseOptionalVectorInput(['0', '', '0'], 'Rotation').error).toContain('all three values');
        expect(parseOptionalVectorInput(['0', 'abc', '0'], 'Rotation').error).toContain('must be numbers');
    });

    it('parses density overrides and rejects non-positive values', () => {
        expect(parseDensityOverride('')).toEqual({});
        expect(parseDensityOverride('2.5')).toEqual({ value: 2.5 });
        expect(parseDensityOverride('0').error).toContain('greater than zero');
        expect(parseDensityOverride('-1').error).toContain('greater than zero');
    });

    it('flags missing fill targets for non-void fills', () => {
        expect(fillTargetError('void', undefined)).toBeUndefined();
        expect(fillTargetError('material', 0)).toContain('Select a material');
        expect(fillTargetError('universe', 3)).toBeUndefined();
    });

    it('parses albedo with a warning above 1', () => {
        expect(parseAlbedoInput('')).toEqual({});
        expect(parseAlbedoInput('1')).toEqual({ value: 1 });
        expect(parseAlbedoInput('0.5')).toEqual({ value: 0.5 });
        expect(parseAlbedoInput('0').error).toContain('greater than zero');
        expect(parseAlbedoInput('1.5').warning).toContain('unphysical');
    });
});
