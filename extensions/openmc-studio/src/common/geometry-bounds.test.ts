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

import { describe, it, expect } from 'vitest';
import { calculateGeometryBounds, boxOverlapsBounds, pointInBounds } from './geometry-bounds';
import { OpenMCState } from './openmc-state-schema';

function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Bounds Test', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 10 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1], isRoot: true }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [{ id: 1, name: 'Water', density: 1.0, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] }],
        settings: { run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

describe('calculateGeometryBounds', () => {
    it('computes bounds from a sphere surface', () => {
        const state = buildState();
        const bounds = calculateGeometryBounds(state);
        expect(bounds).toEqual({ min: [-10, -10, -10], max: [10, 10, 10] });
    });

    it('prefers DAGMC bounds over CSG surfaces', () => {
        const state = buildState();
        state.settings.dagmcFile = 'model.h5m';
        state.settings.dagmcInfo = {
            filePath: '/model.h5m',
            fileName: 'model.h5m',
            volumeCount: 1,
            surfaceCount: 1,
            vertices: 100,
            materials: {},
            volumes: [],
            boundingBox: { min: [-100, -100, -100], max: [100, 100, 100] }
        };
        const bounds = calculateGeometryBounds(state);
        expect(bounds).toEqual({ min: [-100, -100, -100], max: [100, 100, 100] });
    });

    it('returns null when no geometry is defined', () => {
        const state = buildState();
        state.geometry.surfaces = [];
        state.settings.dagmcInfo = undefined;
        expect(calculateGeometryBounds(state)).toBeNull();
    });
});

describe('pointInBounds', () => {
    it('detects points inside and outside', () => {
        const bounds = { min: [-10, -10, -10] as [number, number, number], max: [10, 10, 10] as [number, number, number] };
        expect(pointInBounds([0, 0, 0], bounds)).toBe(true);
        expect(pointInBounds([10, 10, 10], bounds)).toBe(true);
        expect(pointInBounds([11, 0, 0], bounds)).toBe(false);
    });
});

describe('boxOverlapsBounds', () => {
    it('detects overlapping and disjoint boxes', () => {
        const bounds = { min: [-10, -10, -10] as [number, number, number], max: [10, 10, 10] as [number, number, number] };
        expect(boxOverlapsBounds({ lowerLeft: [0, 0, 0], upperRight: [5, 5, 5] }, bounds)).toBe(true);
        expect(boxOverlapsBounds({ lowerLeft: [20, 0, 0], upperRight: [30, 10, 10] }, bounds)).toBe(false);
    });
});
