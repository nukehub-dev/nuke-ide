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
 * Tests for the colormap library.
 *
 * The expected values below are pinned to the preset sources (ParaView
 * `Remoting/Views/ColorMaps.json`, matplotlib/cmocean canonical tables);
 * they fail loudly if a regeneration drifts from the sources. Regenerate
 * with `scripts/generate-colormaps.js`.
 */

import { describe, expect, it } from 'vitest';
import {
    COLORMAP_NAMES,
    COLORMAPS,
    colormapToCssGradient,
    colormapToLut,
    getColormap,
    isColormapName,
    normalizeStops,
    rgbToCss,
    sampleColormap
} from './colormaps';

describe('colormap library', () => {
    it('exposes the full old-list library in picker order', () => {
        expect([...COLORMAP_NAMES]).toEqual([
            'Viridis',
            'Plasma',
            'Inferno',
            'Magma',
            'Cividis',
            'Cool to Warm',
            'Cool to Warm (Extended)',
            'Warm to Cool',
            'Black-Body Radiation',
            'X Ray',
            'Blue to Red Rainbow',
            'Red to Blue Rainbow',
            'Rainbow Desaturated',
            'Rainbow Uniform',
            'Jet',
            'Hot',
            'Cool',
            'Spectral',
            'RdYlBu',
            'RdYlGn',
            'PuOr',
            'PRGn',
            'BrBG',
            'PiYG',
            'RdBu',
            'Seismic',
            'Balance',
            'Twilight',
            'Haze',
            'Earth',
            'Ocean',
            'Blue Orange (div)',
            'Black, Blue and White',
            'Black, Orange and White'
        ]);
        expect(Object.keys(COLORMAPS).sort()).toEqual([...COLORMAP_NAMES].sort());
    });

    it('records the preset provenance', () => {
        expect(COLORMAPS.Plasma.paraviewPreset).toBe('Plasma');
        // Aliases: the old trame-era names map to differently named presets.
        expect(COLORMAPS.Hot.paraviewPreset).toBe('2hot');
        expect(COLORMAPS.Earth.paraviewPreset).toBe('gist_earth');
        expect(COLORMAPS['Blue Orange (div)'].paraviewPreset).toBe('Blue Orange (divergent)');
        // Derived by mirroring Blue to Red Rainbow.
        expect(COLORMAPS['Red to Blue Rainbow'].paraviewPreset).toBe('Blue to Red Rainbow');
        // matplotlib/cmocean canonical definitions (no ParaView preset).
        for (const name of ['Spectral', 'RdYlBu', 'RdYlGn', 'RdBu', 'Seismic', 'Twilight', 'Ocean', 'Balance'] as const) {
            expect(COLORMAPS[name].paraviewPreset).toBeNull();
            expect(COLORMAPS[name].stops).toHaveLength(256);
        }
    });

    it('carries the dense 256-stop tables verbatim', () => {
        for (const name of ['Plasma', 'Viridis', 'Inferno', 'Magma', 'Cividis'] as const) {
            expect(COLORMAPS[name].stops).toHaveLength(256);
        }
        expect(COLORMAPS.Jet.stops).toHaveLength(7);
        expect(COLORMAPS.Hot.stops).toHaveLength(17);
        expect(COLORMAPS.Cool.stops).toHaveLength(7);
    });

    it('keeps every map ordered with channels in range', () => {
        for (const name of COLORMAP_NAMES) {
            const stops = COLORMAPS[name].stops;
            expect(stops.length).toBeGreaterThanOrEqual(2);
            for (let i = 1; i < stops.length; i++) {
                // Non-decreasing: presets with hard transitions (e.g. Cool to
                // Warm (Extended) at its midpoint) repeat a position with a
                // new color; the sampler treats zero-span segments as steps.
                expect(stops[i].position).toBeGreaterThanOrEqual(stops[i - 1].position);
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
        close(sampleColormap(COLORMAPS.Viridis, 0), [0.267004, 0.004874, 0.329415]);
        close(sampleColormap(COLORMAPS.Viridis, 1), [0.993248, 0.906157, 0.143936]);
        // Cool to Warm (ParaView's diverging default): blue to red through white.
        close(sampleColormap(COLORMAPS['Cool to Warm'], 0), [0.231373, 0.298039, 0.752941]);
        close(sampleColormap(COLORMAPS['Cool to Warm'], 1), [0.705882, 0.015686, 0.14902]);
        // Red to Blue Rainbow is the exact mirror of Blue to Red Rainbow.
        close(sampleColormap(COLORMAPS['Red to Blue Rainbow'], 0), sampleColormap(COLORMAPS['Blue to Red Rainbow'], 1));
        close(sampleColormap(COLORMAPS['Red to Blue Rainbow'], 1), sampleColormap(COLORMAPS['Blue to Red Rainbow'], 0));
        // Jet on its legacy [-1, 1] axis: dark blue to dark red.
        close(sampleColormap(COLORMAPS.Jet, 0), [0, 0, 0.5625]);
        close(sampleColormap(COLORMAPS.Jet, 1), [0.5, 0, 0]);
        // matplotlib RdBu: dark red to dark blue (matplotlib orientation).
        close(sampleColormap(COLORMAPS.RdBu, 0), [0.403922, 0, 0.121569]);
        close(sampleColormap(COLORMAPS.RdBu, 1), [0.019608, 0.188235, 0.380392]);
    });

    it('pins the NaN colors', () => {
        expect(COLORMAPS.Plasma.nanColor).toEqual([0, 1, 0]);
        expect(COLORMAPS.Viridis.nanColor).toEqual([1, 0, 0]);
        expect(COLORMAPS.Jet.nanColor).toBeNull();
        expect(COLORMAPS['Cool to Warm'].nanColor).toEqual([1, 1, 0]);
    });

    it('normalizes non-[0, 1] axes to [0, 1]', () => {
        for (const name of ['Jet', 'Hot', 'Cividis', 'PuOr', 'Haze', 'Earth', 'Blue Orange (div)'] as const) {
            const stops = normalizeStops(COLORMAPS[name]);
            expect(stops[0].position).toBeCloseTo(0, 6);
            expect(stops[stops.length - 1].position).toBeCloseTo(1, 6);
        }
        const plasma = normalizeStops(COLORMAPS.Plasma);
        expect(plasma[0].position).toBe(0);
        expect(plasma[plasma.length - 1].position).toBe(1);
    });

    it('clamps out-of-range samples to the end stops', () => {
        const first = COLORMAPS.Viridis.stops[0];
        expect(sampleColormap(COLORMAPS.Viridis, -5)).toEqual([first.red, first.green, first.blue]);
        const lastStops = COLORMAPS.Viridis.stops;
        const last = lastStops[lastStops.length - 1];
        expect(sampleColormap(COLORMAPS.Viridis, 42)).toEqual([last.red, last.green, last.blue]);
    });

    it('expands to a fixed-size LUT with pinned ends', () => {
        const lut = colormapToLut(COLORMAPS.Plasma);
        expect(lut).toHaveLength(256);
        expect(lut[0][0]).toBeCloseTo(0.050383, 6);
        expect(lut[255][0]).toBeGreaterThan(0.9);
        expect(colormapToLut(COLORMAPS.Jet, 4)).toHaveLength(4);
    });

    it('formats CSS colors and legend gradients', () => {
        expect(rgbToCss([1, 0, 0.5])).toBe('rgb(255, 0, 128)');
        const gradient = colormapToCssGradient(COLORMAPS.Viridis, 3);
        expect(gradient.startsWith('linear-gradient(to right, ')).toBe(true);
        expect(gradient).toContain('rgb(68, 1, 84)');
    });

    it('looks definitions up by name', () => {
        expect(getColormap('Plasma')).toBe(COLORMAPS.Plasma);
        expect(getColormap('Cool to Warm')).toBe(COLORMAPS['Cool to Warm']);
        expect(getColormap('Not a Map')).toBeUndefined();
        expect(isColormapName('Jet')).toBe(true);
        expect(isColormapName('Hot (Diverging)')).toBe(false);
    });
});
