// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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

import { describe, expect, it } from 'vitest';

import { OpenMCPlotConfig, OpenMCState } from './openmc-state-schema';
import {
    fromOpenMcMaskComponents,
    getMissingMaskComponents,
    getPlotDomainOptions,
    getPlotMaskSummary,
    plotHexToRgb,
    plotRgbToHex,
    plotSupportsBackground,
    plotSupportsMask,
    plotSupportsOverlaps,
    toOpenMcMaskComponents,
    validatePlotAppearance
} from './plot-appearance';

function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Plot appearance test', created: now, modified: now },
        geometry: {
            surfaces: [],
            cells: [
                { id: 1, name: 'fuel', fillType: 'material', fillId: 1 },
                { id: 2, name: 'clad', fillType: 'material', fillId: 2 }
            ],
            universes: [{ id: 0, name: 'root', cellIds: [1, 2] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            { id: 10, name: 'Fuel', density: 10, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] },
            { id: 20, name: 'Water', density: 1, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] }
        ],
        settings: { run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

function buildSlice(overrides: Partial<OpenMCPlotConfig> = {}): OpenMCPlotConfig {
    return { id: 1, type: 'slice', basis: 'xy', origin: [0, 0, 0], colorBy: 'cell', ...overrides };
}

describe('plot appearance support matrix', () => {
    it('applies background and mask to slice/ray-traced plots only', () => {
        for (const type of ['slice', 'solid-raytrace', 'wireframe-raytrace'] as const) {
            expect(plotSupportsBackground(type)).toBe(true);
            expect(plotSupportsMask(type)).toBe(true);
        }
        expect(plotSupportsBackground('voxel')).toBe(false);
        expect(plotSupportsMask('voxel')).toBe(false);
    });

    it('limits overlap highlighting to slice plots', () => {
        expect(plotSupportsOverlaps('slice')).toBe(true);
        expect(plotSupportsOverlaps('voxel')).toBe(false);
        expect(plotSupportsOverlaps('solid-raytrace')).toBe(false);
        expect(plotSupportsOverlaps('wireframe-raytrace')).toBe(false);
    });
});

describe('plot domain options and mask summary', () => {
    it('lists cells or materials from the current model', () => {
        const state = buildState();
        expect(getPlotDomainOptions(state, 'cell').map((domain) => domain.id)).toEqual([1, 2]);
        expect(getPlotDomainOptions(state, 'material').map((domain) => domain.id)).toEqual([10, 20]);
    });

    it('converts between visible selections and OpenMC hidden mask components', () => {
        const state = buildState();
        const plot = buildSlice({ mask: { components: [1] } });
        expect(toOpenMcMaskComponents(plot, state)).toEqual([2]);

        const selection = fromOpenMcMaskComponents([2], state, 'cell');
        expect(selection).toEqual({ visible: [1], missing: [] });

        const stale = fromOpenMcMaskComponents([2, 99], state, 'cell');
        expect(stale).toEqual({ visible: [1], missing: [99] });
    });

    it('reports missing components and visible counts', () => {
        const state = buildState();
        const plot = buildSlice({ mask: { components: [1, 99] } });
        expect(getMissingMaskComponents(plot, state)).toEqual([99]);
        expect(getPlotMaskSummary(plot, state)).toEqual({ total: 2, visible: 1, missing: 1 });
    });
});

describe('plot color conversion', () => {
    it('round-trips RGB triples through hex', () => {
        expect(plotRgbToHex([255, 128, 0])).toBe('#FF8000');
        expect(plotHexToRgb('#ff8000')).toEqual([255, 128, 0]);
        expect(plotHexToRgb('#f80')).toEqual([255, 136, 0]);
        expect(plotHexToRgb('nope')).toBeUndefined();
    });
});

describe('validatePlotAppearance', () => {
    it('accepts a complete slice appearance configuration', () => {
        const state = buildState();
        const plot = buildSlice({
            background: [0, 0, 0],
            mask: { components: [1], background: [255, 255, 255] },
            showOverlaps: true,
            overlapColor: [255, 0, 0]
        });
        expect(validatePlotAppearance(plot, state)).toEqual([]);
    });

    it('warns when voxel plots carry display-only appearance fields', () => {
        const state = buildState();
        const plot: OpenMCPlotConfig = {
            id: 2,
            type: 'voxel',
            basis: 'xy',
            origin: [0, 0, 0],
            colorBy: 'cell',
            background: [0, 0, 0],
            mask: { components: [1] }
        };
        const issues = validatePlotAppearance(plot, state);
        expect(issues).toHaveLength(1);
        expect(issues[0].message).toContain('voxel');
        expect(issues[0].suggestion).toContain('slice');
    });

    it('warns about missing mask domains and empty selections', () => {
        const state = buildState();
        const missing = validatePlotAppearance(buildSlice({ mask: { components: [1, 42] } }), state);
        expect(missing.some((issue) => issue.message.includes('42'))).toBe(true);

        const empty = validatePlotAppearance(buildSlice({ mask: { components: [] } }), state);
        expect(empty.some((issue) => issue.message.includes('no cells selected'))).toBe(true);

        const all = validatePlotAppearance(buildSlice({ mask: { components: [1, 2] } }), state);
        expect(all.some((issue) => issue.message.includes('selects every domain'))).toBe(true);
    });

    it('warns when overlap highlighting is requested on a ray-traced plot', () => {
        const state = buildState();
        const plot = buildSlice({ type: 'solid-raytrace', showOverlaps: true, overlapColor: [255, 0, 0] });
        const issues = validatePlotAppearance(plot, state);
        expect(issues.some((issue) => issue.field === 'overlaps' && issue.message.includes('only detects overlaps for slice'))).toBe(true);
    });

    it('warns when an overlap color is set without enabling overlaps', () => {
        const state = buildState();
        const plot = buildSlice({ overlapColor: [255, 0, 0] });
        const issues = validatePlotAppearance(plot, state);
        expect(issues.some((issue) => issue.message.includes('without enabling overlap highlighting'))).toBe(true);
    });
});
