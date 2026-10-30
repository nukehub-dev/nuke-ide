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

import { OpenMCPlotConfig, OpenMCState } from '../../common/openmc-state-schema';
import { generatePlotAppearancePythonLines } from '../../common/plot-appearance';

function buildState(): OpenMCState {
    const now = new Date().toISOString();
    return {
        metadata: { version: '1.1.0', name: 'Plot codegen', created: now, modified: now },
        geometry: {
            surfaces: [],
            cells: [
                { id: 1, fillType: 'material', fillId: 1 },
                { id: 2, fillType: 'material', fillId: 2 }
            ],
            universes: [{ id: 0, name: 'root', cellIds: [1, 2] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            { id: 1, name: 'Fuel', density: 10, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] },
            { id: 2, name: 'Water', density: 1, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] }
        ],
        settings: { run: { mode: 'eigenvalue', particles: 100, inactive: 5, batches: 10 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

function plot(overrides: Partial<OpenMCPlotConfig>): OpenMCPlotConfig {
    return { id: 1, type: 'slice', basis: 'xy', origin: [0, 0, 0], colorBy: 'material', ...overrides };
}

describe('Python plot appearance codegen', () => {
    it('emits background, the hidden mask complement, and overlap fields for slice plots', () => {
        const lines = generatePlotAppearancePythonLines(
            plot({
                background: [12, 34, 56],
                mask: { components: [1], background: [200, 210, 220] },
                showOverlaps: true,
                overlapColor: [255, 0, 0]
            }),
            buildState()
        );

        expect(lines).toEqual([
            'plot_1.background = (12, 34, 56)',
            'plot_1.mask_components = [2]',
            'plot_1.mask_background = (200, 210, 220)',
            'plot_1.show_overlaps = True',
            'plot_1.overlap_color = (255, 0, 0)'
        ]);
    });

    it('emits background and the hidden mask for ray-traced plots but not overlap controls', () => {
        const lines = generatePlotAppearancePythonLines(
            plot({
                type: 'solid-raytrace',
                colorBy: 'cell',
                background: [1, 2, 3],
                mask: { components: [1] },
                showOverlaps: true,
                overlapColor: [255, 0, 0]
            }),
            buildState()
        );

        expect(lines).toEqual(['plot_1.background = (1, 2, 3)', 'plot_1.mask_components = [2]']);
    });

    it('omits appearance fields from voxel plot code', () => {
        const lines = generatePlotAppearancePythonLines(
            plot({
                type: 'voxel',
                colorBy: 'cell',
                background: [1, 2, 3],
                mask: { components: [1] },
                showOverlaps: true,
                overlapColor: [255, 0, 0]
            }),
            buildState()
        );

        expect(lines).toEqual([]);
    });

    it('omits a mask that would select every domain', () => {
        const lines = generatePlotAppearancePythonLines(plot({ mask: { components: [1, 2] } }), buildState());
        expect(lines).toEqual([]);
    });

    it('omits a mask whose selected domains no longer exist', () => {
        const lines = generatePlotAppearancePythonLines(plot({ mask: { components: [99] } }), buildState());
        expect(lines).toEqual([]);
    });
});
