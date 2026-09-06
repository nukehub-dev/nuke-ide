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

/**
 * Tests for the short-list LUT pack.
 *
 * The expected values below are pinned to ParaView
 * `Remoting/Views/ColorMaps.json` (preset names, stop counts, endpoints,
 * NaN colors); they fail loudly if a re-port drifts from the source.
 */

import { describe, expect, it } from 'vitest';
import {
    SHORT_COLORMAP_NAMES,
    SHORT_COLORMAPS,
    colormapToCssGradient,
    colormapToLut,
    getColormap,
    isShortColormapName,
    normalizeStops,
    rgbToCss,
    sampleColormap
} from './colormaps';

describe('short colormap pack', () => {
    it('exposes exactly the six trame short-list maps', () => {
        expect([...SHORT_COLORMAP_NAMES]).toEqual(['Plasma', 'Viridis', 'Inferno', 'Jet', 'Hot', 'Cool']);
        expect(Object.keys(SHORT_COLORMAPS).sort()).toEqual(['Cool', 'Hot', 'Inferno', 'Jet', 'Plasma', 'Viridis']);
    });

    it('records the ParaView preset provenance', () => {
        expect(SHORT_COLORMAPS.Plasma.paraviewPreset).toBe('Plasma');
        expect(SHORT_COLORMAPS.Viridis.paraviewPreset).toBe('Viridis');
        expect(SHORT_COLORMAPS.Inferno.paraviewPreset).toBe('Inferno');
        expect(SHORT_COLORMAPS.Jet.paraviewPreset).toBe('Jet');
        // No same-named presets exist: Hot is the 2hot black-body gradient,
        // Cool is the 7-entry categorical palette.
        expect(SHORT_COLORMAPS.Hot.paraviewPreset).toBe('2hot');
        expect(SHORT_COLORMAPS.Cool.paraviewPreset).toBe('Cool');
    });

    it('carries the dense 256-stop matplotlib tables verbatim', () => {
        for (const name of ['Plasma', 'Viridis', 'Inferno'] as const) {
            expect(SHORT_COLORMAPS[name].stops).toHaveLength(256);
        }
        expect(SHORT_COLORMAPS.Jet.stops).toHaveLength(7);
        expect(SHORT_COLORMAPS.Hot.stops).toHaveLength(17);
        expect(SHORT_COLORMAPS.Cool.stops).toHaveLength(7);
    });

    it('keeps stops ordered with channels in range', () => {
        for (const name of SHORT_COLORMAP_NAMES) {
            const stops = SHORT_COLORMAPS[name].stops;
            for (let i = 1; i < stops.length; i++) {
                expect(stops[i].position).toBeGreaterThan(stops[i - 1].position);
            }
            for (const stop of stops) {
                for (const channel of [stop.red, stop.green, stop.blue]) {
                    expect(channel).toBeGreaterThanOrEqual(0);
                    expect(channel).toBeLessThanOrEqual(1);
                }
            }
        }
    });

    it('pins the map endpoints', () => {
        const close = (actual: readonly number[], expected: readonly number[]) => {
            for (let i = 0; i < expected.length; i++) {
                expect(actual[i]).toBeCloseTo(expected[i], 4);
            }
        };
        // Viridis: dark purple to yellow.
        close(sampleColormap(SHORT_COLORMAPS.Viridis, 0), [0.267004, 0.004874, 0.329415]);
        close(sampleColormap(SHORT_COLORMAPS.Viridis, 1), [0.993248, 0.906157, 0.143936]);
        // Plasma: dark purple-blue to yellow.
        close(sampleColormap(SHORT_COLORMAPS.Plasma, 0), [0.050383, 0.029803, 0.527975]);
        // Inferno: near-black to pale yellow.
        close(sampleColormap(SHORT_COLORMAPS.Inferno, 0), [0.001462, 0.000466, 0.013866]);
        close(sampleColormap(SHORT_COLORMAPS.Inferno, 1), [0.988362, 0.998364, 0.644924]);
        // Hot (2hot): black to white through red/yellow.
        close(sampleColormap(SHORT_COLORMAPS.Hot, 0), [0.0416667, 0, 0]);
        close(sampleColormap(SHORT_COLORMAPS.Hot, 1), [1, 1, 1]);
        // Jet on its legacy [-1, 1] axis: dark blue to dark red.
        close(sampleColormap(SHORT_COLORMAPS.Jet, 0), [0, 0, 0.5625]);
        close(sampleColormap(SHORT_COLORMAPS.Jet, 1), [0.5, 0, 0]);
        // Cool categorical palette endpoints.
        close(sampleColormap(SHORT_COLORMAPS.Cool, 0), [0.4588235294117647, 0.6941176470588235, 0.00392156862745098]);
        close(sampleColormap(SHORT_COLORMAPS.Cool, 1), [0.3725490196078431, 0.2, 0.5019607843137255]);
    });

    it('pins the NaN colors', () => {
        expect(SHORT_COLORMAPS.Plasma.nanColor).toEqual([0, 1, 0]);
        expect(SHORT_COLORMAPS.Viridis.nanColor).toEqual([1, 0, 0]);
        expect(SHORT_COLORMAPS.Inferno.nanColor).toEqual([0, 1, 0]);
        expect(SHORT_COLORMAPS.Jet.nanColor).toBeNull();
        expect(SHORT_COLORMAPS.Hot.nanColor).toBeNull();
        expect(SHORT_COLORMAPS.Cool.nanColor).toEqual([0.3725490196078431, 0.2, 0.5019607843137255]);
    });

    it('normalizes the legacy [-1, 1] axes to [0, 1]', () => {
        for (const name of ['Jet', 'Hot'] as const) {
            const stops = normalizeStops(SHORT_COLORMAPS[name]);
            expect(stops[0].position).toBeCloseTo(0, 10);
            expect(stops[stops.length - 1].position).toBeCloseTo(1, 10);
        }
        const plasma = normalizeStops(SHORT_COLORMAPS.Plasma);
        expect(plasma[0].position).toBe(0);
        expect(plasma[plasma.length - 1].position).toBe(1);
    });

    it('clamps out-of-range samples to the end stops', () => {
        const first = SHORT_COLORMAPS.Viridis.stops[0];
        expect(sampleColormap(SHORT_COLORMAPS.Viridis, -5)).toEqual([first.red, first.green, first.blue]);
        const lastStops = SHORT_COLORMAPS.Viridis.stops;
        const last = lastStops[lastStops.length - 1];
        expect(sampleColormap(SHORT_COLORMAPS.Viridis, 42)).toEqual([last.red, last.green, last.blue]);
    });

    it('expands to a fixed-size LUT with pinned ends', () => {
        const lut = colormapToLut(SHORT_COLORMAPS.Plasma);
        expect(lut).toHaveLength(256);
        expect(lut[0][0]).toBeCloseTo(0.050383, 6);
        expect(lut[255][0]).toBeGreaterThan(0.9);
        expect(colormapToLut(SHORT_COLORMAPS.Jet, 4)).toHaveLength(4);
    });

    it('formats CSS colors and legend gradients', () => {
        expect(rgbToCss([1, 0, 0.5])).toBe('rgb(255, 0, 128)');
        const gradient = colormapToCssGradient(SHORT_COLORMAPS.Viridis, 3);
        expect(gradient.startsWith('linear-gradient(to right, ')).toBe(true);
        expect(gradient).toContain('rgb(68, 1, 84)');
    });

    it('looks definitions up by name', () => {
        expect(getColormap('Plasma')).toBe(SHORT_COLORMAPS.Plasma);
        expect(getColormap('Cool to Warm')).toBeUndefined();
        expect(isShortColormapName('Jet')).toBe(true);
        expect(isShortColormapName('Hot (Diverging)')).toBe(false);
    });
});
