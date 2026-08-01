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
 * Tests for the NCrystal cfg-string composition helpers (pure, no DI).
 */

import { describe, expect, it } from 'vitest';
import { NC_CFG_FIELDS, composeCfgString } from './ncrystal-cfg';

describe('composeCfgString', () => {
    it('returns the base name alone when all fields are empty', () => {
        expect(composeCfgString('Al_sg225.ncmat', {})).toBe('Al_sg225.ncmat');
        expect(composeCfgString('Al_sg225.ncmat', { temp: '', dcutoff: '  ' })).toBe('Al_sg225.ncmat');
    });

    it('appends non-empty fields in the defined field order', () => {
        expect(composeCfgString('Al_sg225.ncmat', { temp: '300K', dcutoff: '0.5Aa', mosaicity: '2deg' })).toBe(
            'Al_sg225.ncmat;temp=300K;dcutoff=0.5Aa;mosaicity=2deg'
        );
    });

    it('trims whitespace and skips empty values', () => {
        expect(composeCfgString('/data/my.ncmat', { temp: ' 600K ', dcutoffup: '', vdoslux: '3' })).toBe(
            '/data/my.ncmat;temp=600K;vdoslux=3'
        );
    });

    it('ignores keys that are not builder fields', () => {
        expect(composeCfgString('Al_sg225.ncmat', { temp: '300K', bogus: 'x' })).toBe('Al_sg225.ncmat;temp=300K');
    });
});

describe('NC_CFG_FIELDS', () => {
    it('covers the documented builder fields in order', () => {
        expect(NC_CFG_FIELDS.map((f) => f.key)).toEqual(['temp', 'dcutoff', 'dcutoffup', 'mosaicity', 'vdoslux']);
    });
});
