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

import { describe, it, expect } from 'vitest';
import { buildFuseFeature, bodyTipFeature, parseOverlapWarning, selectionSolidIds, toggleSolidSelection } from './outline-interactions';
import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument, type FeatureDef, validateNukeCadDocument } from '../../../common/cad-document';

function feature(id: string, type: FeatureDef['type'], body: string, dependsOn: string[] = [], suppressed = false): FeatureDef {
    const params: Record<string, unknown> = type === 'pad' || type === 'pocket' ? { length: 1 } : {};
    return { id, name: id, type, body, params: params as FeatureDef['params'], suppressed, dependsOn };
}

function makeDocument(features: FeatureDef[]): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [
            { id: 'body-1', name: 'Body 1' },
            { id: 'body-2', name: 'Body 2' }
        ],
        sketches: [],
        features,
        curves: []
    };
}

describe('toggleSolidSelection', () => {
    it('replaces the selection on a plain click', () => {
        expect(toggleSolidSelection({ solidId: 1, solidIds: [1, 2] }, 3, false)).toEqual({ solidId: 3 });
    });

    it('adds a solid additively with it as primary', () => {
        expect(toggleSolidSelection({ solidId: 1 }, 2, true)).toEqual({ solidId: 2, solidIds: [1, 2] });
    });

    it('removes the primary solid additively and promotes the next one', () => {
        expect(toggleSolidSelection({ solidId: 1, solidIds: [1, 2, 3] }, 1, true)).toEqual({ solidId: 2, solidIds: [2, 3] });
    });

    it('clears the selection when the last solid is toggled off', () => {
        expect(toggleSolidSelection({ solidId: 1 }, 1, true)).toEqual({});
    });

    it('lists the primary first', () => {
        expect(selectionSolidIds({ solidId: 2, solidIds: [1, 2, 3] })).toEqual([2, 1, 3]);
        expect(selectionSolidIds({})).toEqual([]);
    });
});

describe('parseOverlapWarning', () => {
    it('extracts the body pair from a builder overlap warning', () => {
        expect(parseOverlapWarning("bodies 'body-1' and 'body-12' overlap (volume 0.771333 mm³) but are not merged by a boolean")).toEqual({
            bodyA: 'body-1',
            bodyB: 'body-12'
        });
    });

    it('returns undefined for unrelated warnings', () => {
        expect(parseOverlapWarning('display tessellation exceeds the triangle budget')).toBeUndefined();
    });
});

describe('bodyTipFeature', () => {
    it('returns the last non-suppressed solid feature of the body', () => {
        const doc = makeDocument([
            feature('pad-1', 'pad', 'body-1'),
            feature('fillet-1', 'fillet', 'body-1'),
            feature('pad-2', 'pad', 'body-2')
        ]);
        expect(bodyTipFeature(doc, 'body-1')).toBe('fillet-1');
        expect(bodyTipFeature(doc, 'body-2')).toBe('pad-2');
    });

    it('skips suppressed features and unknown bodies', () => {
        const doc = makeDocument([feature('pad-1', 'pad', 'body-1', [], true)]);
        expect(bodyTipFeature(doc, 'body-1')).toBeUndefined();
        expect(bodyTipFeature(doc, 'body-9')).toBeUndefined();
    });
});

describe('buildFuseFeature', () => {
    it('builds a valid booleanFuse consuming the tool body', () => {
        const doc = makeDocument([feature('pad-1', 'pad', 'body-1'), feature('pad-2', 'pad', 'body-2')]);
        const fuse = buildFuseFeature(doc, 'body-1', 'body-2', 'fuse-x');
        expect(fuse).toBeDefined();
        expect(fuse?.type).toBe('booleanFuse');
        expect(fuse?.body).toBe('body-1');
        expect(fuse?.params).toEqual({ targetBody: 'body-1', toolBodies: ['body-2'], keepTools: false });
        expect(fuse?.dependsOn).toEqual(['pad-1', 'pad-2']);
        const validated = validateNukeCadDocument({ ...doc, features: [...doc.features, fuse!] });
        expect(validated.valid).toBe(true);
    });

    it('generates a collision-free name', () => {
        const doc = makeDocument([feature('pad-1', 'pad', 'body-1'), feature('fuse 2', 'pad', 'body-2')]);
        const fuse = buildFuseFeature(doc, 'body-1', 'body-2', 'fuse-x');
        expect(doc.features.some((f) => f.name === fuse?.name)).toBe(false);
    });

    it('returns undefined for unknown bodies or bodies without solid features', () => {
        const doc = makeDocument([feature('pad-1', 'pad', 'body-1')]);
        expect(buildFuseFeature(doc, 'body-1', 'body-9', 'fuse-x')).toBeUndefined();
        expect(buildFuseFeature(doc, 'body-1', 'body-2', 'fuse-x')).toBeUndefined();
    });
});
