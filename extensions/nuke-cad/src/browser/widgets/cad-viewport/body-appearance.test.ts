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
import { GRAVEYARD_MATERIAL_COLOR, materialColor } from 'nuke-essentials/lib/theme/browser/material-colors';
import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument } from '../../../common/cad-document';
import {
    BODY_APPEARANCE_DEFAULT_COLOR,
    BODY_APPEARANCE_DEFAULT_OPACITY,
    normalizeAppearancePresets,
    resolveBodyAppearance,
    resolveBodyDisplayAppearance,
    resolveBodyMaterialColor
} from './body-appearance';

function docWithAppearance(appearance: { color?: string; opacity?: number } | undefined): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'appearance',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Body 1', ...(appearance !== undefined ? { appearance } : {}) }],
        sketches: [],
        features: [],
        curves: []
    };
}

function docWithMaterial(material: string | undefined, appearance?: { color?: string; opacity?: number }): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'material',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [
            {
                id: 'body-1',
                name: 'Body 1',
                ...(material !== undefined ? { material } : {}),
                ...(appearance !== undefined ? { appearance } : {})
            }
        ],
        sketches: [],
        features: [],
        curves: []
    };
}

describe('resolveBodyAppearance', () => {
    it('returns undefined without a document, body, or override', () => {
        expect(resolveBodyAppearance(undefined, 'body-1')).toBeUndefined();
        expect(resolveBodyAppearance(docWithAppearance(undefined), 'body-1')).toBeUndefined();
        expect(resolveBodyAppearance(docWithAppearance(undefined), 'body-missing')).toBeUndefined();
    });

    it('resolves a color-only override and leaves opacity to the shading mode', () => {
        expect(resolveBodyAppearance(docWithAppearance({ color: '#ff8800' }), 'body-1')).toEqual({ color: '#ff8800' });
    });

    it('resolves an opacity-only override and leaves color to the theme', () => {
        expect(resolveBodyAppearance(docWithAppearance({ opacity: 0.5 }), 'body-1')).toEqual({ opacity: 0.5 });
    });

    it('resolves both fields independently', () => {
        expect(resolveBodyAppearance(docWithAppearance({ color: '#00ff00', opacity: 0 }), 'body-1')).toEqual({
            color: '#00ff00',
            opacity: 0
        });
    });

    it('normalizes invalid fields away and drops an all-invalid override', () => {
        const badColor = { color: 'orange', opacity: 0.25 } as unknown as { color: string; opacity: number };
        expect(resolveBodyAppearance(docWithAppearance(badColor), 'body-1')).toEqual({ opacity: 0.25 });

        const badOpacity = { color: '#123abc', opacity: 2 } as unknown as { color: string; opacity: number };
        expect(resolveBodyAppearance(docWithAppearance(badOpacity), 'body-1')).toEqual({ color: '#123abc' });

        const allBad = { color: '#12345', opacity: Number.NaN } as unknown as { color: string; opacity: number };
        expect(resolveBodyAppearance(docWithAppearance(allBad), 'body-1')).toBeUndefined();
    });

    it('exposes the dialog defaults', () => {
        expect(BODY_APPEARANCE_DEFAULT_COLOR).toBe('#c4c7cc');
        expect(BODY_APPEARANCE_DEFAULT_OPACITY).toBe(1);
    });
});

describe('resolveBodyMaterialColor', () => {
    it('returns undefined when color-by-material is disabled', () => {
        expect(resolveBodyMaterialColor(docWithMaterial('fuel'), 'body-1', false)).toBeUndefined();
    });

    it('resolves the shared palette color when enabled', () => {
        expect(resolveBodyMaterialColor(docWithMaterial('fuel'), 'body-1', true)).toBe(materialColor('fuel'));
    });

    it('returns undefined without a document, body, or usable material', () => {
        expect(resolveBodyMaterialColor(undefined, 'body-1', true)).toBeUndefined();
        expect(resolveBodyMaterialColor(docWithMaterial(undefined), 'body-1', true)).toBeUndefined();
        expect(resolveBodyMaterialColor(docWithMaterial('fuel'), 'body-missing', true)).toBeUndefined();
        expect(resolveBodyMaterialColor(docWithMaterial('   '), 'body-1', true)).toBeUndefined();
    });

    it('special-cases the graveyard termination material', () => {
        expect(resolveBodyMaterialColor(docWithMaterial('Graveyard'), 'body-1', true)).toBe(GRAVEYARD_MATERIAL_COLOR);
    });

    it('normalizes case and surrounding whitespace through materialColor', () => {
        expect(resolveBodyMaterialColor(docWithMaterial('  FUEL '), 'body-1', true)).toBe(materialColor('fuel'));
        expect(resolveBodyMaterialColor(docWithMaterial('  FUEL '), 'body-1', true)).toBe(
            resolveBodyMaterialColor(docWithMaterial('fuel'), 'body-1', true)
        );
    });
});

describe('resolveBodyDisplayAppearance', () => {
    it('keeps the theme base with coloring off and no appearance', () => {
        expect(resolveBodyDisplayAppearance(docWithMaterial('fuel'), 'body-1', false)).toBeUndefined();
    });

    it('uses the material color when enabled and no appearance exists', () => {
        expect(resolveBodyDisplayAppearance(docWithMaterial('fuel'), 'body-1', true)).toEqual({ color: materialColor('fuel') });
    });

    it('returns undefined when coloring is off, the body is untagged, and no appearance exists', () => {
        expect(resolveBodyDisplayAppearance(docWithMaterial(undefined), 'body-1', true)).toBeUndefined();
        expect(resolveBodyDisplayAppearance(docWithMaterial(undefined), 'body-1', false)).toBeUndefined();
    });

    it('lets an explicit appearance color win over the material color', () => {
        expect(resolveBodyDisplayAppearance(docWithMaterial('fuel', { color: '#ff8800' }), 'body-1', true)).toEqual({
            color: '#ff8800'
        });
    });

    it('keeps appearance opacity independent from the material color', () => {
        expect(resolveBodyDisplayAppearance(docWithMaterial('fuel', { opacity: 0.4 }), 'body-1', true)).toEqual({
            color: materialColor('fuel'),
            opacity: 0.4
        });
    });

    it('resolves color and opacity together with explicit color precedence', () => {
        expect(resolveBodyDisplayAppearance(docWithMaterial('fuel', { color: '#00ff00', opacity: 0 }), 'body-1', true)).toEqual({
            color: '#00ff00',
            opacity: 0
        });
    });

    it('keeps an opacity-only appearance when coloring is off', () => {
        expect(resolveBodyDisplayAppearance(docWithMaterial('fuel', { opacity: 0.25 }), 'body-1', false)).toEqual({
            opacity: 0.25
        });
    });
});

describe('normalizeAppearancePresets', () => {
    it('returns an empty list for a missing or non-array preference value', () => {
        expect(normalizeAppearancePresets(undefined)).toEqual([]);
        expect(normalizeAppearancePresets(null)).toEqual([]);
        expect(normalizeAppearancePresets('Highlight')).toEqual([]);
        expect(normalizeAppearancePresets({ name: 'Highlight' })).toEqual([]);
    });

    it('trims names and drops empty/non-string/duplicate names (first wins)', () => {
        expect(
            normalizeAppearancePresets([
                { name: '  Highlight  ', color: '#FF8800', opacity: 0.5 },
                { name: 'highlight', color: '#00ff00', opacity: 0.25 },
                { name: 'Highlight', color: '#0000ff', opacity: 1 },
                { name: '   ', color: '#00ff00', opacity: 1 },
                { name: 42, color: '#00ff00', opacity: 1 }
            ])
        ).toEqual([
            { name: 'Highlight', color: '#ff8800', opacity: 0.5 },
            { name: 'highlight', color: '#00ff00', opacity: 0.25 }
        ]);
    });

    it('clamps opacity into 0–1 and lower-cases hex colors', () => {
        expect(
            normalizeAppearancePresets([
                { name: 'Bright', color: '#ABCDEF', opacity: 4 },
                { name: 'Ghost', color: '#aBcDeF', opacity: -0.5 }
            ])
        ).toEqual([
            { name: 'Bright', color: '#abcdef', opacity: 1 },
            { name: 'Ghost', color: '#abcdef', opacity: 0 }
        ]);
    });

    it('drops malformed entries', () => {
        expect(
            normalizeAppearancePresets([
                null,
                'Highlight',
                [],
                { name: 'Missing color', opacity: 0.5 },
                { name: 'Bad color', color: '#12345', opacity: 0.5 },
                { name: 'Alpha color', color: '#ff8800aa', opacity: 0.5 },
                { name: 'Missing opacity', color: '#ff8800' },
                { name: 'NaN opacity', color: '#ff8800', opacity: Number.NaN },
                { name: 'Infinite opacity', color: '#ff8800', opacity: Number.POSITIVE_INFINITY },
                { name: 'String opacity', color: '#ff8800', opacity: '0.5' }
            ])
        ).toEqual([]);
    });
});
