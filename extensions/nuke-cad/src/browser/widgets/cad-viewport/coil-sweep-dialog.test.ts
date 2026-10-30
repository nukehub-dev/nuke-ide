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
import type { CurveDef } from '../../../common/cad-document';
import { coilSweepDraftFromParams, defaultCoilSweepDraft, validateCoilSweepDraft, type CoilSweepDraft } from './coil-sweep-dialog';

const curves: readonly CurveDef[] = [
    { id: 'curve-coil-01', name: 'coil_01 centerline', source: { kind: 'points' }, samples: [] },
    { id: 'curve-coil-02', name: 'coil_02 centerline', source: { kind: 'points' }, samples: [] }
];

const draft = (overrides: Partial<CoilSweepDraft> = {}): CoilSweepDraft => ({
    pathCurveId: 'curve-coil-01',
    width: '0.37',
    height: '0.37',
    tiltDeg: '8.6',
    twistDeg: '0',
    stations: '60',
    ...overrides
});

describe('validateCoilSweepDraft', () => {
    it('accepts the defaults and produces schema params', () => {
        const result = validateCoilSweepDraft(draft(), curves);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.params).toEqual({
                pathCurveId: 'curve-coil-01',
                width: 0.37,
                height: 0.37,
                tiltDeg: 8.6,
                twistDeg: 0,
                stations: 60
            });
        }
        expect(validateCoilSweepDraft(defaultCoilSweepDraft(), curves).ok).toBe(false);
    });

    it('requires an existing path curve', () => {
        expect(validateCoilSweepDraft(draft({ pathCurveId: '' }), curves)).toEqual({ ok: false, error: 'Select a path curve.' });
        expect(validateCoilSweepDraft(draft({ pathCurveId: 'missing' }), curves)).toEqual({
            ok: false,
            error: "Path curve 'missing' does not exist in this document."
        });
    });

    it('rejects non-positive or non-finite section dimensions', () => {
        for (const width of ['0', '-1', 'nan', '', 'Infinity']) {
            const result = validateCoilSweepDraft(draft({ width }), curves);
            expect(result.ok, `width '${width}'`).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe('Width must be a positive number.');
            }
        }
        for (const height of ['0', '-0.5', 'oops', '']) {
            const result = validateCoilSweepDraft(draft({ height }), curves);
            expect(result.ok, `height '${height}'`).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe('Height must be a positive number.');
            }
        }
    });

    it('enforces the tilt range and finite twist', () => {
        expect(validateCoilSweepDraft(draft({ tiltDeg: '-89' }), curves).ok).toBe(true);
        expect(validateCoilSweepDraft(draft({ tiltDeg: '89' }), curves).ok).toBe(true);
        for (const tiltDeg of ['-89.1', '89.1', '', 'nan']) {
            const result = validateCoilSweepDraft(draft({ tiltDeg }), curves);
            expect(result.ok, `tilt '${tiltDeg}'`).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe('Tilt must be between -89 and 89 degrees.');
            }
        }
        for (const twistDeg of ['', 'nan', 'Infinity']) {
            const result = validateCoilSweepDraft(draft({ twistDeg }), curves);
            expect(result.ok, `twist '${twistDeg}'`).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe('Twist must be a finite number of degrees.');
            }
        }
        expect(validateCoilSweepDraft(draft({ twistDeg: '-540' }), curves).ok).toBe(true);
    });

    it('requires an integer station count in [8, 720]', () => {
        for (const stations of ['8', '720', '121']) {
            expect(validateCoilSweepDraft(draft({ stations }), curves).ok, `stations '${stations}'`).toBe(true);
        }
        for (const stations of ['7', '721', '8.5', '', 'sixty']) {
            const result = validateCoilSweepDraft(draft({ stations }), curves);
            expect(result.ok, `stations '${stations}'`).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe('Stations must be a whole number between 8 and 720.');
            }
        }
    });
});

describe('coilSweepDraftFromParams', () => {
    it('prefills every field from an existing coil-sweep feature', () => {
        expect(
            coilSweepDraftFromParams({
                pathCurveId: 'curve-coil-03',
                width: 0.4,
                height: 0.2,
                tiltDeg: -12,
                twistDeg: 720,
                stations: 120
            })
        ).toEqual({
            pathCurveId: 'curve-coil-03',
            width: '0.4',
            height: '0.2',
            tiltDeg: '-12',
            twistDeg: '720',
            stations: '120'
        });
    });

    it('falls back to the dialog defaults when optional params are absent', () => {
        expect(coilSweepDraftFromParams({ pathCurveId: 'curve-coil-04' })).toEqual({
            pathCurveId: 'curve-coil-04',
            width: '1',
            height: '1',
            tiltDeg: '0',
            twistDeg: '0',
            stations: '60'
        });
    });
});
