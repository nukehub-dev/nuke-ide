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

import { describe, expect, it } from 'vitest';
import { clampDecimals, formatDecimal, MAX_DECIMALS, MIN_DECIMALS } from './number-format';

describe('formatDecimal', () => {
    it('renders non-finite values as an em dash', () => {
        expect(formatDecimal(Number.NaN, 2)).toBe('—');
        expect(formatDecimal(Number.POSITIVE_INFINITY, 2)).toBe('—');
        expect(formatDecimal(Number.NEGATIVE_INFINITY, 0)).toBe('—');
    });

    it('keeps the trimmed look at two decimals', () => {
        expect(formatDecimal(5, 2)).toBe('5');
        expect(formatDecimal(2.5, 2)).toBe('2.5');
        expect(formatDecimal(2.555, 2)).toBe('2.56');
        expect(formatDecimal(100, 2)).toBe('100');
    });

    it('rounds at zero decimal places without eating trailing integer zeros', () => {
        expect(formatDecimal(2.5, 0)).toBe('3');
        expect(formatDecimal(2.4, 0)).toBe('2');
        expect(formatDecimal(100, 0)).toBe('100');
        expect(formatDecimal(0, 0)).toBe('0');
    });

    it('honors non-default decimal counts', () => {
        expect(formatDecimal(1 / 3, 3)).toBe('0.333');
        expect(formatDecimal(1 / 3, 1)).toBe('0.3');
        expect(formatDecimal(1.23456789, 6)).toBe('1.234568');
        expect(formatDecimal(1.1, 6)).toBe('1.1');
    });

    it('clamps decimals to 0–6 and truncates fractions', () => {
        expect(MIN_DECIMALS).toBe(0);
        expect(MAX_DECIMALS).toBe(6);
        expect(clampDecimals(-2)).toBe(0);
        expect(clampDecimals(9)).toBe(6);
        expect(clampDecimals(2.9)).toBe(2);
        expect(formatDecimal(1.23456789, 9)).toBe('1.234568');
        expect(formatDecimal(2.5, -1)).toBe('3');
        expect(formatDecimal(1.2345, 2.9)).toBe('1.23');
    });

    it('normalizes negative zero and rounds tiny negatives to zero', () => {
        expect(formatDecimal(-0, 2)).toBe('0');
        expect(formatDecimal(-0.001, 2)).toBe('0');
        expect(formatDecimal(-2.555, 2)).toBe('-2.56');
        expect(formatDecimal(-2.5, 0)).toBe('-3');
    });
});
