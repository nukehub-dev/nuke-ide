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
import { getColormap } from './colormaps';
import { MAGNITUDE_COMPONENT, mapScalar, normalizeToRange, type ScalarMapping } from './scalar-mapping';
import {
    buildVolumeTransferLut,
    DEFAULT_OPACITY_STOPS,
    DEFAULT_VOLUME_TRANSFER,
    MAX_OPACITY_STOPS,
    normalizeOpacityStops,
    sampleOpacity,
    type OpacityStop
} from './volume-transfer';

function testMapping(overrides: Partial<ScalarMapping> = {}): ScalarMapping {
    const definition = getColormap('Cool to Warm');
    if (!definition) {
        throw new Error('Cool to Warm colormap missing');
    }
    return { definition, range: [0, 10] as const, logScale: false, invert: false, component: MAGNITUDE_COMPONENT, ...overrides };
}

describe('normalizeOpacityStops', () => {
    it('sorts by t and clamps both coordinates into [0, 1]', () => {
        const stops = normalizeOpacityStops([
            { t: 0.8, alpha: 2 },
            { t: -3, alpha: -1 },
            { t: 0.4, alpha: 0.5 }
        ]);
        expect(stops).toEqual([
            { t: 0, alpha: 0 },
            { t: 0.4, alpha: 0.5 },
            { t: 0.8, alpha: 1 }
        ]);
    });

    it('collapses duplicate positions to the later input stop', () => {
        const stops = normalizeOpacityStops([
            { t: 0.75, alpha: 0.2 },
            { t: 0.25, alpha: 0.6 },
            { t: 0.25, alpha: 0.1 }
        ]);
        expect(stops).toEqual([
            { t: 0.25, alpha: 0.1 },
            { t: 0.75, alpha: 0.2 }
        ]);
    });

    it('drops non-finite positions and coerces non-finite alphas to zero', () => {
        expect(
            normalizeOpacityStops([
                { t: Number.NaN, alpha: 1 },
                { t: 0.4, alpha: Number.NaN }
            ])
        ).toEqual([{ t: 0.4, alpha: 0 }]);
    });

    it('falls back to the default ramp when nothing survives', () => {
        expect(normalizeOpacityStops([])).toEqual(DEFAULT_OPACITY_STOPS);
        expect(normalizeOpacityStops([{ t: Number.POSITIVE_INFINITY, alpha: 1 }])).toEqual(DEFAULT_OPACITY_STOPS);
    });

    it('returns a fresh array so callers can edit the fallback', () => {
        const stops = normalizeOpacityStops([]);
        stops[0] = { t: 0, alpha: 1 };
        expect(DEFAULT_OPACITY_STOPS[0]).toEqual({ t: 0, alpha: 0 });
    });

    it('caps long ramps without dropping the endpoints', () => {
        const many: OpacityStop[] = [];
        for (let i = 0; i < 40; i++) {
            many.push({ t: i / 39, alpha: i / 39 });
        }
        const stops = normalizeOpacityStops(many);
        expect(stops.length).toBe(MAX_OPACITY_STOPS);
        expect(stops[0].t).toBe(0);
        expect(stops[stops.length - 1].t).toBe(1);
        for (let i = 1; i < stops.length; i++) {
            expect(stops[i].t).toBeGreaterThan(stops[i - 1].t);
        }
    });
});

describe('sampleOpacity', () => {
    it('samples the default ramp endpoints and interior linearly', () => {
        expect(sampleOpacity(DEFAULT_OPACITY_STOPS, 0)).toBe(0);
        expect(sampleOpacity(DEFAULT_OPACITY_STOPS, 0.25)).toBe(0.25);
        expect(sampleOpacity(DEFAULT_OPACITY_STOPS, 0.5)).toBe(0.5);
        expect(sampleOpacity(DEFAULT_OPACITY_STOPS, 1)).toBe(1);
    });

    it('clamps outside the unit interval', () => {
        expect(sampleOpacity(DEFAULT_OPACITY_STOPS, -2)).toBe(0);
        expect(sampleOpacity(DEFAULT_OPACITY_STOPS, 9)).toBe(1);
    });

    it('interpolates a custom curve and normalizes unsorted input', () => {
        const stops: OpacityStop[] = [
            { t: 1, alpha: 0 },
            { t: 0, alpha: 0 },
            { t: 0.5, alpha: 1 }
        ];
        expect(sampleOpacity(stops, 0.25)).toBe(0.5);
        expect(sampleOpacity(stops, 0.5)).toBe(1);
        expect(sampleOpacity(stops, 0.75)).toBe(0.5);
    });

    it('holds the terminal stop outside a partial ramp', () => {
        const stops: OpacityStop[] = [
            { t: 0.25, alpha: 0.4 },
            { t: 0.75, alpha: 0.8 }
        ];
        expect(sampleOpacity(stops, 0)).toBe(0.4);
        expect(sampleOpacity(stops, 1)).toBe(0.8);
    });

    it('treats an empty list as the default ramp and non-finite t as invisible', () => {
        expect(sampleOpacity([], 0.5)).toBe(0.5);
        expect(sampleOpacity(DEFAULT_OPACITY_STOPS, Number.NaN)).toBe(0);
    });
});

describe('buildVolumeTransferLut', () => {
    it('builds the 256-entry texture with color parity and the identity alpha ramp', () => {
        const mapping = testMapping();
        const lut = buildVolumeTransferLut(mapping, [0, 10], DEFAULT_VOLUME_TRANSFER);
        expect(lut.length).toBe(256 * 4);
        expect(lut[0 * 4 + 3]).toBe(0);
        expect(lut[1 * 4 + 3]).toBe(1);
        expect(lut[2 * 4 + 3]).toBe(2);
        expect(lut[255 * 4 + 3]).toBe(255);
        const mid = 128 * 4;
        const midRgb = mapScalar(10 * (128 / 255), mapping)!;
        expect([lut[mid], lut[mid + 1], lut[mid + 2]]).toEqual([
            Math.round(midRgb[0] * 255),
            Math.round(midRgb[1] * 255),
            Math.round(midRgb[2] * 255)
        ]);
    });

    it('uses custom opacity stops for alpha while leaving RGB alone', () => {
        const mapping = testMapping();
        const options = {
            ...DEFAULT_VOLUME_TRANSFER,
            opacityStops: [
                { t: 0, alpha: 0 },
                { t: 0.5, alpha: 1 },
                { t: 1, alpha: 0.25 }
            ]
        };
        const lut = buildVolumeTransferLut(mapping, [0, 10], options, 3);
        expect(lut.length).toBe(3 * 4);
        expect(lut[0 * 4 + 3]).toBe(0);
        expect(lut[1 * 4 + 3]).toBe(255);
        expect(lut[2 * 4 + 3]).toBe(64);
        const topRgb = mapScalar(10, mapping)!;
        expect([lut[2 * 4], lut[2 * 4 + 1], lut[2 * 4 + 2]]).toEqual([
            Math.round(topRgb[0] * 255),
            Math.round(topRgb[1] * 255),
            Math.round(topRgb[2] * 255)
        ]);
    });

    it('applies a custom stop at t = 0 to non-zero cells', () => {
        const mapping = testMapping({ range: [1, 11] });
        const lut = buildVolumeTransferLut(
            mapping,
            [1, 11],
            {
                ...DEFAULT_VOLUME_TRANSFER,
                opacityStops: [
                    { t: 0, alpha: 0.5 },
                    { t: 1, alpha: 1 }
                ]
            },
            2
        );
        expect(lut[0 * 4 + 3]).toBe(128);
        expect(lut[1 * 4 + 3]).toBe(255);
    });

    it('keeps exact-zero cells transparent even when a custom ramp has a floor', () => {
        const lut = buildVolumeTransferLut(
            testMapping(),
            [0, 10],
            {
                ...DEFAULT_VOLUME_TRANSFER,
                opacityStops: [
                    { t: 0, alpha: 1 },
                    { t: 1, alpha: 1 }
                ]
            },
            2
        );
        expect(lut[0 * 4 + 3]).toBe(0);
        expect(lut[1 * 4 + 3]).toBe(255);
    });

    it('scales the whole ramp by the optional widget opacity', () => {
        const lut = buildVolumeTransferLut(testMapping(), [0, 10], DEFAULT_VOLUME_TRANSFER, 3, 0.5);
        expect([lut[0 * 4 + 3], lut[1 * 4 + 3], lut[2 * 4 + 3]]).toEqual([0, 64, 128]);
    });

    it('honors log scaling for alpha but not for the invert direction', () => {
        const mapping = testMapping({ range: [1, 100], logScale: true });
        const lut = buildVolumeTransferLut(mapping, [1, 100], DEFAULT_VOLUME_TRANSFER, 3);
        expect(lut[0 * 4 + 3]).toBe(0);
        const expectedMid = Math.round(normalizeToRange(Math.log(50.5), [Math.log(1), Math.log(100)]) * 255);
        expect(lut[1 * 4 + 3]).toBe(expectedMid);
        expect(lut[1 * 4 + 3]).toBeGreaterThan(128);
        expect(lut[2 * 4 + 3]).toBe(255);

        const inverted = buildVolumeTransferLut(
            testMapping({ range: [1, 100], logScale: true, invert: true }),
            [1, 100],
            DEFAULT_VOLUME_TRANSFER,
            3
        );
        // Alpha follows data magnitude; invert only flips the color ramp.
        expect(inverted[1 * 4 + 3]).toBe(expectedMid);
        expect([inverted[0 * 4], inverted[0 * 4 + 1], inverted[0 * 4 + 2]]).not.toEqual([lut[0 * 4], lut[0 * 4 + 1], lut[0 * 4 + 2]]);
    });

    it('keeps non-positive log values and non-finite ranges fully transparent', () => {
        const logMapping = testMapping({ range: [1, 100], logScale: true });
        const signed = buildVolumeTransferLut(logMapping, [-10, 10], DEFAULT_VOLUME_TRANSFER, 3);
        expect([signed[0 * 4 + 3], signed[1 * 4 + 3]]).toEqual([0, 0]);
        expect(signed[2 * 4 + 3]).toBe(128);

        const nanRange = buildVolumeTransferLut(testMapping(), [Number.NaN, Number.NaN], DEFAULT_VOLUME_TRANSFER, 3);
        expect([...nanRange.filter((_, index) => index % 4 === 3)]).toEqual([0, 0, 0]);

        const nanMappingRange = buildVolumeTransferLut(
            testMapping({ range: [Number.NaN, Number.NaN] }),
            [0, 10],
            DEFAULT_VOLUME_TRANSFER,
            3
        );
        expect([...nanMappingRange.filter((_, index) => index % 4 === 3)]).toEqual([0, 0, 0]);

        // A custom floor cannot revive values the log mapping cannot place.
        const floor = {
            ...DEFAULT_VOLUME_TRANSFER,
            opacityStops: [
                { t: 0, alpha: 1 },
                { t: 1, alpha: 1 }
            ]
        };
        const invalidLog = buildVolumeTransferLut(testMapping({ range: [0, 10], logScale: true }), [1, 10], floor, 2);
        expect([invalidLog[0 * 4 + 3], invalidLog[1 * 4 + 3]]).toEqual([0, 0]);
    });

    it('defaults to MIP with shading off and the identity ramp', () => {
        expect(DEFAULT_VOLUME_TRANSFER.blendMode).toBe('mip');
        expect(DEFAULT_VOLUME_TRANSFER.shade).toBe(false);
        expect(DEFAULT_VOLUME_TRANSFER.opacityStops).toBe(DEFAULT_OPACITY_STOPS);
    });
});
