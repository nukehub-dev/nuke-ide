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
import {
    LINE_PROBE_DEFAULT_NPOINTS,
    LINE_PROBE_MAX_NPOINTS,
    LINE_PROBE_MIN_NPOINTS,
    clampProbeNpoints,
    defaultProbeEndpoints,
    describeLineProbeSeries,
    formatProbePoint,
    lineProbeToCsv,
    parseProbeCoordinate,
    parseProbePoint
} from './tally-probe';

describe('parseProbePoint', () => {
    it('accepts comma- and space-separated triples', () => {
        expect(parseProbePoint('1, 2, 3')).toEqual([1, 2, 3]);
        expect(parseProbePoint('1 2 3')).toEqual([1, 2, 3]);
        expect(parseProbePoint(' -1.5,2e3, 0 ')).toEqual([-1.5, 2000, 0]);
    });

    it('rejects anything but three finite numbers', () => {
        expect(parseProbePoint('1, 2')).toBeUndefined();
        expect(parseProbePoint('1, 2, 3, 4')).toBeUndefined();
        expect(parseProbePoint('a, 2, 3')).toBeUndefined();
        expect(parseProbePoint('1, NaN, 3')).toBeUndefined();
        expect(parseProbePoint('1, Infinity, 3')).toBeUndefined();
        expect(parseProbePoint('')).toBeUndefined();
    });

    it('round-trips through formatProbePoint', () => {
        expect(parseProbePoint(formatProbePoint([1.25, -2, 3.5]))).toEqual([1.25, -2, 3.5]);
    });
});

describe('parseProbeCoordinate', () => {
    it('rejects empty and non-finite text', () => {
        expect(parseProbeCoordinate('')).toBeUndefined();
        expect(parseProbeCoordinate('  ')).toBeUndefined();
        expect(parseProbeCoordinate('abc')).toBeUndefined();
        expect(parseProbeCoordinate('1e3')).toBe(1000);
    });
});

describe('clampProbeNpoints', () => {
    it('clamps into the backend range', () => {
        expect(clampProbeNpoints(50)).toBe(50);
        expect(clampProbeNpoints(1)).toBe(LINE_PROBE_MIN_NPOINTS);
        expect(clampProbeNpoints(1e9)).toBe(LINE_PROBE_MAX_NPOINTS);
        expect(clampProbeNpoints(10.9)).toBe(10);
        expect(clampProbeNpoints(NaN)).toBe(LINE_PROBE_DEFAULT_NPOINTS);
    });
});

describe('defaultProbeEndpoints', () => {
    it('spans the X axis through the bounds center', () => {
        const { start, end } = defaultProbeEndpoints({ min: [0, 0, 0], max: [10, 20, 30] });
        expect(start).toEqual([0, 10, 15]);
        expect(end).toEqual([10, 10, 15]);
    });

    it('falls back to the unit diagonal without bounds', () => {
        expect(defaultProbeEndpoints(undefined)).toEqual({ start: [0, 0, 0], end: [1, 1, 1] });
    });
});

describe('lineProbeToCsv', () => {
    it('serializes the series at full precision with a header row', () => {
        const csv = lineProbeToCsv({
            series: [
                { distance: 0, position: [0, 0.5, 0.5], value: 1.25 },
                { distance: 2.5, position: [2.5, 0.5, 0.5], value: 0.0000123456789 }
            ]
        });
        expect(csv).toBe('distance_cm,x_cm,y_cm,z_cm,value\n0,0,0.5,0.5,1.25\n2.5,2.5,0.5,0.5,0.0000123456789\n');
    });

    it('emits only the header for an empty series', () => {
        expect(lineProbeToCsv({})).toBe('distance_cm,x_cm,y_cm,z_cm,value\n');
    });
});

describe('describeLineProbeSeries', () => {
    it('summarizes count, array, length, and range', () => {
        expect(
            describeLineProbeSeries({
                series: [{ distance: 0, position: [0, 0, 0], value: 1 }],
                arrayName: 'flux-mean',
                length: 12.5,
                dataRange: [1, 2]
            })
        ).toBe('1 points · flux-mean · 0–12.5 cm [1, 2]');
    });

    it('degrades gracefully without metadata', () => {
        expect(describeLineProbeSeries({})).toBe('0 points');
    });
});
