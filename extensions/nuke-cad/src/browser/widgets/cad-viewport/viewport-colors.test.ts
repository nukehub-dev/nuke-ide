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
import {
    DARK_THEME_EDGE_COLOR,
    LIGHT_THEME_BODY_COLOR,
    LIGHT_THEME_EDGE_COLOR,
    cadViewportColors,
    parseCssColor,
    relativeLuminance
} from './viewport-colors';

describe('parseCssColor', () => {
    it('parses 6-digit hex', () => {
        expect(parseCssColor('#1e1e1e')).toEqual([0x1e / 255, 0x1e / 255, 0x1e / 255]);
    });

    it('parses 3-digit hex', () => {
        expect(parseCssColor('#fff')).toEqual([1, 1, 1]);
    });

    it('parses 8-digit hex ignoring alpha', () => {
        expect(parseCssColor('#ff000080')).toEqual([1, 0, 0]);
    });

    it('parses rgb() and rgba()', () => {
        expect(parseCssColor('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
        expect(parseCssColor('rgba(0, 128, 255, 0.5)')).toEqual([0, 128 / 255, 1]);
    });

    it('returns undefined for unparseable input', () => {
        expect(parseCssColor('')).toBeUndefined();
        expect(parseCssColor('var(--x)')).toBeUndefined();
        expect(parseCssColor('#12345')).toBeUndefined();
    });
});

describe('relativeLuminance', () => {
    it('is 0 for black and 1 for white', () => {
        expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    });

    it('ranks the Theia dark editor background as dark', () => {
        expect(relativeLuminance('#1e1e1e')!).toBeLessThan(0.5);
    });
});

describe('cadViewportColors', () => {
    it('keeps foreground body and white edges on dark backgrounds', () => {
        expect(cadViewportColors('#1e1e1e', '#cccccc')).toEqual({ body: '#cccccc', edges: DARK_THEME_EDGE_COLOR });
    });

    it('switches to steel body and dark edges on light backgrounds', () => {
        expect(cadViewportColors('#ffffff', '#1f1f1f')).toEqual({ body: LIGHT_THEME_BODY_COLOR, edges: LIGHT_THEME_EDGE_COLOR });
    });

    it('accepts rgb() backgrounds', () => {
        expect(cadViewportColors('rgb(255, 255, 255)', '#1f1f1f').edges).toBe(LIGHT_THEME_EDGE_COLOR);
    });

    it('falls back to dark-theme behavior for unparseable backgrounds', () => {
        expect(cadViewportColors('not-a-color', '#cccccc')).toEqual({ body: '#cccccc', edges: DARK_THEME_EDGE_COLOR });
    });
});
