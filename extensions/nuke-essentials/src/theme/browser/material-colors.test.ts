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
 * Tests for the deterministic material palette: normalization, stable
 * hashing, graveyard handling, and palette membership.
 */

import { describe, expect, it } from 'vitest';
import { categoryColor, GRAVEYARD_MATERIAL_COLOR, MATERIAL_PALETTE, materialColor, materialColorMap } from './material-colors';

const HEX_COLOR = /^#[0-9a-f]{6}$/;

describe('materialColor', () => {
    it('is deterministic across calls and viewer rebuilds', () => {
        expect(materialColor('fuel')).toBe(materialColor('fuel'));
        expect(materialColor('clad')).toBe(materialColor('clad'));
        expect(materialColor('fuel')).not.toBe(materialColor('clad'));
    });

    it('normalizes case and surrounding whitespace', () => {
        expect(materialColor('  Fuel ')).toBe(materialColor('fuel'));
        expect(materialColor('CLAD')).toBe(materialColor('clad'));
        expect(materialColor('\tGraveyard\n')).toBe(materialColor('graveyard'));
    });

    it('returns undefined for missing and blank names', () => {
        expect(materialColor(undefined)).toBeUndefined();
        expect(materialColor('')).toBeUndefined();
        expect(materialColor('   ')).toBeUndefined();
    });

    it('uses the muted grey for the graveyard material only', () => {
        expect(materialColor('graveyard')).toBe(GRAVEYARD_MATERIAL_COLOR);
        expect(materialColor('Graveyard')).toBe(GRAVEYARD_MATERIAL_COLOR);
        expect(materialColor('fuel')).not.toBe(GRAVEYARD_MATERIAL_COLOR);
    });

    it('always returns an accessible Tableau-10 palette entry', () => {
        expect(MATERIAL_PALETTE).toHaveLength(10);
        for (const color of MATERIAL_PALETTE) {
            expect(color).toMatch(HEX_COLOR);
            expect(materialColor(color.slice(1))).toMatch(HEX_COLOR);
        }
        for (const name of ['fuel', 'clad', 'moderator', 'reflector', 'shield', 'void', 'mat_0', 'mat_1', 'water']) {
            expect(MATERIAL_PALETTE).toContain(materialColor(name));
        }
    });

    it('spreads common material names across the palette', () => {
        const names = ['fuel', 'clad', 'moderator', 'reflector', 'shield', 'water', 'void', 'mat_0', 'mat_1'];
        expect(new Set(names.map((name) => materialColor(name))).size).toBeGreaterThan(4);
    });
});

describe('categoryColor', () => {
    it('is deterministic and normalizes case and whitespace', () => {
        expect(categoryColor('group:CRITICAL')).toBe(categoryColor('group:critical'));
        expect(categoryColor('  volume:3 ')).toBe(categoryColor('volume:3'));
        expect(categoryColor('volume:3')).not.toBe(categoryColor('volume:4'));
    });

    it('returns undefined for missing and blank keys', () => {
        expect(categoryColor(undefined)).toBeUndefined();
        expect(categoryColor('')).toBeUndefined();
        expect(categoryColor('   ')).toBeUndefined();
    });

    it('always returns a palette entry and keeps graveyard unmuted', () => {
        for (const key of ['volume:1', 'group:core', 'group:blanket', 'fuel']) {
            expect(MATERIAL_PALETTE).toContain(categoryColor(key));
        }
        expect(categoryColor('graveyard')).not.toBe(GRAVEYARD_MATERIAL_COLOR);
    });
});

describe('materialColorMap', () => {
    it('keys colors by normalized material name', () => {
        const colors = materialColorMap(['Fuel', '  clad ', 'FUEL', '']);
        expect(colors.get('fuel')).toBe(materialColor('fuel'));
        expect(colors.get('clad')).toBe(materialColor('clad'));
        expect(colors.has('')).toBe(false);
        expect(colors.size).toBe(2);
    });

    it('accepts any iterable of names', () => {
        const colors = materialColorMap(new Set(['fuel', 'graveyard']));
        expect(colors.get('graveyard')).toBe(GRAVEYARD_MATERIAL_COLOR);
        expect(colors.get('fuel')).toBe(materialColor('fuel'));
    });
});
