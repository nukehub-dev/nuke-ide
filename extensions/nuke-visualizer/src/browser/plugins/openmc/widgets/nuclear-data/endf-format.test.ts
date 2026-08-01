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
 * Tests for the ENDF formatting helpers (pure, no DI).
 */

import { describe, expect, it } from 'vitest';
import { formatEnergyEeV, formatHalfLife, formatYield } from './endf-format';

describe('formatHalfLife', () => {
    it('picks the right unit by magnitude', () => {
        expect(formatHalfLife(2.221e16)).toBe('7.04e+8 y');
        expect(formatHalfLife(365.25 * 24 * 3600 * 2)).toBe('2.00 y');
        expect(formatHalfLife(4.5 * 24 * 3600)).toBe('4.50 d');
        expect(formatHalfLife(5400)).toBe('1.50 h');
        expect(formatHalfLife(300)).toBe('5.00 min');
        expect(formatHalfLife(12.3)).toBe('12.3 s');
    });
});

describe('formatEnergyEeV', () => {
    it('scales to eV/keV/MeV', () => {
        expect(formatEnergyEeV(0.0253)).toBe('0.0253 eV');
        expect(formatEnergyEeV(5.0e5)).toBe('500 keV');
        expect(formatEnergyEeV(1.4e7)).toBe('14.0 MeV');
    });
});

describe('formatYield', () => {
    it('formats big and small yields', () => {
        expect(formatYield(0.062155)).toBe('0.06216');
        expect(formatYield(1.3122e-19)).toBe('1.31e-19');
        expect(formatYield(0)).toBe('0');
    });
});
