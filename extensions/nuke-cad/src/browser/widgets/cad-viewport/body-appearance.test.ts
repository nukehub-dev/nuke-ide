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
import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument } from '../../../common/cad-document';
import { BODY_APPEARANCE_DEFAULT_COLOR, BODY_APPEARANCE_DEFAULT_OPACITY, resolveBodyAppearance } from './body-appearance';

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
