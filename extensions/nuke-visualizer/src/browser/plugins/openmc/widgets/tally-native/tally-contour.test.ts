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
    CONTOUR_MAX_ISO_VALUES,
    describeContourRequest,
    formatContourIsoValues,
    parseContourIsoValue,
    parseContourIsoValues
} from './tally-contour';

describe('parseContourIsoValue', () => {
    it('parses finite numbers', () => {
        expect(parseContourIsoValue('2.5')).toBe(2.5);
        expect(parseContourIsoValue('  1e12 ')).toBe(1e12);
    });

    it('rejects empty and non-finite input', () => {
        expect(parseContourIsoValue('')).toBeUndefined();
        expect(parseContourIsoValue('   ')).toBeUndefined();
        expect(parseContourIsoValue('abc')).toBeUndefined();
        expect(parseContourIsoValue('NaN')).toBeUndefined();
        expect(parseContourIsoValue('Infinity')).toBeUndefined();
    });
});

describe('parseContourIsoValues', () => {
    it('parses space/comma/semicolon-separated lists', () => {
        expect(parseContourIsoValues('1 2.5 4')).toEqual([1, 2.5, 4]);
        expect(parseContourIsoValues('1, 2.5, 4')).toEqual([1, 2.5, 4]);
        expect(parseContourIsoValues('1;2.5;4')).toEqual([1, 2.5, 4]);
    });

    it('returns undefined unless every entry parses finite', () => {
        expect(parseContourIsoValues('')).toBeUndefined();
        expect(parseContourIsoValues('1, abc')).toBeUndefined();
        expect(parseContourIsoValues('1, NaN')).toBeUndefined();
    });

    it('caps the call at the backend iso-value limit', () => {
        expect(CONTOUR_MAX_ISO_VALUES).toBe(8);
    });
});

describe('formatContourIsoValues', () => {
    it('round-trips through the parser', () => {
        const values = [1, 2.5, 1e12];
        expect(parseContourIsoValues(formatContourIsoValues(values))).toEqual(values);
    });
});

describe('describeContourRequest', () => {
    it('names the iso values, mode, and tally', () => {
        expect(describeContourRequest([20, 50], true, '4')).toBe('iso 20, 50 (smooth) · tally 4');
        expect(describeContourRequest([20], false, '')).toBe('iso 20 (pixelated)');
    });
});
