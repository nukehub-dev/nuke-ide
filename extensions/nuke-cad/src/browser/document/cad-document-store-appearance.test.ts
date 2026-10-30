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
import { CadDocumentStore, RESULT_CACHE_BUILDER_VERSION, RESULT_CACHE_OCP_UNKNOWN, computeResultCacheKeys } from './cad-document-store';
import {
    NUKE_CAD_SCHEMA_VERSION,
    migrateNukeCadDocument,
    validateNukeCadDocument,
    type BodyAppearance,
    type NukeCadDocument
} from '../../common/cad-document';

function minimalDoc(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'appearance',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Body 1' }],
        sketches: [],
        features: [],
        curves: []
    };
}

function multiBodyDoc(): NukeCadDocument {
    return {
        ...minimalDoc(),
        bodies: [
            { id: 'body-1', name: 'Body 1' },
            { id: 'body-2', name: 'Body 2' },
            { id: 'body-3', name: 'Body 3' }
        ]
    };
}

function storeWithDoc(doc: NukeCadDocument = minimalDoc()): CadDocumentStore {
    const store = new CadDocumentStore();
    const loaded = store.loadDocument(doc);
    expect(loaded.success).toBe(true);
    return store;
}

describe('BodyDef.appearance schema validation', () => {
    it('accepts color, opacity, or both', () => {
        for (const appearance of [{ color: '#ff8800' }, { opacity: 0.5 }, { color: '#00FF00', opacity: 0 }]) {
            const doc = minimalDoc();
            doc.bodies[0].appearance = appearance;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, JSON.stringify(result.issues)).toBe(true);
        }
    });

    it('treats an absent override as display defaults (v3-additive, no migration)', () => {
        expect(validateNukeCadDocument(minimalDoc()).valid).toBe(true);
        expect(minimalDoc().bodies[0].appearance).toBeUndefined();
    });

    it('keeps an appearance override migration-free', () => {
        const doc = minimalDoc();
        doc.bodies[0].appearance = { color: '#ff8800', opacity: 0.5 };
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        const migrated = migrateNukeCadDocument(round);
        expect(migrated.migratedFrom).toBeUndefined();
        expect(migrated.document.bodies[0].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });
    });

    it('rejects an empty override object', () => {
        const doc = minimalDoc();
        doc.bodies[0].appearance = {};
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((issue) => issue.path === 'bodies[0].appearance')).toBe(true);
    });

    it('rejects malformed colors', () => {
        for (const color of ['#12345', '123456', '#gggggg', 'red', '']) {
            const doc = minimalDoc();
            doc.bodies[0].appearance = { color };
            const result = validateNukeCadDocument(doc);
            expect(result.valid, color).toBe(false);
            expect(result.issues.some((issue) => issue.path === 'bodies[0].appearance.color')).toBe(true);
        }
    });

    it('rejects non-string colors', () => {
        const doc = minimalDoc();
        (doc.bodies[0] as unknown as { appearance: { color: number } }).appearance = { color: 0xff8800 };
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((issue) => issue.path === 'bodies[0].appearance.color')).toBe(true);
    });

    it('rejects out-of-range and non-finite opacities', () => {
        for (const opacity of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const doc = minimalDoc();
            doc.bodies[0].appearance = { opacity };
            const result = validateNukeCadDocument(doc);
            expect(result.valid, String(opacity)).toBe(false);
            expect(result.issues.some((issue) => issue.path === 'bodies[0].appearance.opacity')).toBe(true);
        }
    });

    it('rejects a non-object override', () => {
        const doc = minimalDoc();
        (doc.bodies[0] as unknown as { appearance: string }).appearance = '#ff8800';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((issue) => issue.path === 'bodies[0].appearance')).toBe(true);
    });
});

describe('body appearance store mutations', () => {
    it('sets, replaces, and removes an override through the normal commit path', () => {
        const store = storeWithDoc();
        let changes = 0;
        store.onChange(() => {
            changes += 1;
        });
        const before = store.drawingVersion;

        expect(store.setBodyAppearance('body-1', { color: '#ff8800', opacity: 0.5 }).success).toBe(true);
        expect(store.document!.bodies[0].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });
        expect(store.dirty).toBe(true);
        expect(changes).toBe(1);
        expect(store.drawingVersion).toBe(before);

        expect(store.setBodyAppearance('body-1', { opacity: 0.25 }).success).toBe(true);
        expect(store.document!.bodies[0].appearance).toEqual({ opacity: 0.25 });
        expect(changes).toBe(2);

        expect(store.setBodyAppearance('body-1', undefined).success).toBe(true);
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(changes).toBe(3);
        expect(store.drawingVersion).toBe(before);
    });

    it('rejects an unknown body id as a structured error', () => {
        const store = storeWithDoc();
        const result = store.setBodyAppearance('body-missing', { color: '#ff8800' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('body-missing');
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.canUndo).toBe(false);
    });

    it('rejects invalid overrides without touching the document or history', () => {
        const store = storeWithDoc();
        const invalid: BodyAppearance[] = [
            {},
            { color: '#12345' },
            { color: 'red' },
            { opacity: -0.1 },
            { opacity: 1.1 },
            { opacity: Number.NaN }
        ];
        for (const appearance of invalid) {
            const result = store.setBodyAppearance('body-1', appearance);
            expect(result.success).toBe(false);
            expect(result.issues?.length ?? 0).toBeGreaterThan(0);
        }
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.dirty).toBe(false);
        expect(store.canUndo).toBe(false);
    });

    it('copies the override so later caller edits cannot corrupt the document', () => {
        const store = storeWithDoc();
        const appearance: BodyAppearance = { color: '#ff8800', opacity: 0.5 };
        expect(store.setBodyAppearance('body-1', appearance).success).toBe(true);
        appearance.color = '#000000';
        appearance.opacity = 0;
        expect(store.document!.bodies[0].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });
    });

    it('deep-clones overrides across undo snapshots', () => {
        const store = storeWithDoc();
        expect(store.setBodyAppearance('body-1', { color: '#ff8800', opacity: 0.5 }).success).toBe(true);
        const before = store.document!.bodies[0].appearance!;
        expect(store.setBodyAppearance('body-1', { color: '#00ff00' }).success).toBe(true);
        expect(store.undo().success).toBe(true);
        const after = store.document!.bodies[0].appearance!;
        expect(after).toEqual(before);
        expect(after).not.toBe(before);
    });

    it('covers apply and remove with undo/redo', () => {
        const store = storeWithDoc();
        expect(store.setBodyAppearance('body-1', { color: '#ff8800' }).success).toBe(true);
        expect(store.canUndo).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.redo().success).toBe(true);
        expect(store.document!.bodies[0].appearance).toEqual({ color: '#ff8800' });
        expect(store.setBodyAppearance('body-1', undefined).success).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document!.bodies[0].appearance).toEqual({ color: '#ff8800' });
    });

    it('persists the override through serialization', () => {
        const store = storeWithDoc();
        expect(store.setBodyAppearance('body-1', { color: '#ff8800', opacity: 0.5 }).success).toBe(true);
        const parsed = JSON.parse(store.toJson()!) as NukeCadDocument;
        expect(parsed.bodies[0].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });
        expect(validateNukeCadDocument(parsed).valid).toBe(true);
    });

    it('never changes result-cache keys (display-only, no stale build)', () => {
        const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };
        const withAppearance = minimalDoc();
        withAppearance.bodies[0].appearance = { color: '#ff8800', opacity: 0.5 };
        expect(computeResultCacheKeys(withAppearance, versions)).toEqual(computeResultCacheKeys(minimalDoc(), versions));
    });
});

describe('multi-body appearance store mutations', () => {
    it('sets every body in one commit and one undo step', () => {
        const store = storeWithDoc(multiBodyDoc());
        let changes = 0;
        store.onChange(() => {
            changes += 1;
        });
        expect(store.setBodiesAppearance(['body-1', 'body-3'], { color: '#ff8800', opacity: 0.5 }).success).toBe(true);
        expect(changes).toBe(1);
        expect(store.document!.bodies[0].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });
        expect(store.document!.bodies[1].appearance).toBeUndefined();
        expect(store.document!.bodies[2].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });

        expect(store.undo().success).toBe(true);
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.document!.bodies[2].appearance).toBeUndefined();
        expect(store.canUndo).toBe(false);

        expect(store.redo().success).toBe(true);
        expect(store.document!.bodies[0].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });
        expect(store.document!.bodies[2].appearance).toEqual({ color: '#ff8800', opacity: 0.5 });
    });

    it('dedupes body ids before committing', () => {
        const store = storeWithDoc(multiBodyDoc());
        let changes = 0;
        store.onChange(() => {
            changes += 1;
        });
        expect(store.setBodiesAppearance(['body-1', 'body-1', 'body-1'], { opacity: 0.25 }).success).toBe(true);
        expect(changes).toBe(1);
        expect(store.document!.bodies[0].appearance).toEqual({ opacity: 0.25 });
        expect(store.document!.bodies[1].appearance).toBeUndefined();
        expect(store.document!.bodies[2].appearance).toBeUndefined();
    });

    it('removes overrides from every selected body in one commit', () => {
        const store = storeWithDoc(multiBodyDoc());
        expect(store.setBodiesAppearance(['body-1', 'body-2'], { color: '#ff8800' }).success).toBe(true);
        expect(store.setBodiesAppearance(['body-1', 'body-2'], undefined).success).toBe(true);
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.document!.bodies[1].appearance).toBeUndefined();
        expect(store.undo().success).toBe(true);
        expect(store.document!.bodies[0].appearance).toEqual({ color: '#ff8800' });
        expect(store.document!.bodies[1].appearance).toEqual({ color: '#ff8800' });
    });

    it('rejects unknown ids without touching any body or history', () => {
        const store = storeWithDoc(multiBodyDoc());
        const result = store.setBodiesAppearance(['body-1', 'body-missing'], { color: '#ff8800' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('body-missing');
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.dirty).toBe(false);
        expect(store.canUndo).toBe(false);
    });

    it('rejects an empty body list', () => {
        const store = storeWithDoc(multiBodyDoc());
        const result = store.setBodiesAppearance([], { color: '#ff8800' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('at least one body');
        expect(store.canUndo).toBe(false);
    });

    it('rejects invalid overrides without touching any body or history', () => {
        const store = storeWithDoc(multiBodyDoc());
        for (const appearance of [{}, { color: '#12345' }, { opacity: -0.1 }, { opacity: Number.NaN }]) {
            const result = store.setBodiesAppearance(['body-1', 'body-2'], appearance);
            expect(result.success).toBe(false);
            expect(result.issues?.length ?? 0).toBeGreaterThan(0);
        }
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.document!.bodies[1].appearance).toBeUndefined();
        expect(store.dirty).toBe(false);
        expect(store.canUndo).toBe(false);
    });

    it('keeps the single-body wrapper behavior unchanged', () => {
        const store = storeWithDoc(multiBodyDoc());
        expect(store.setBodyAppearance('body-2', { color: '#00ff00' }).success).toBe(true);
        expect(store.document!.bodies[1].appearance).toEqual({ color: '#00ff00' });
        expect(store.document!.bodies[0].appearance).toBeUndefined();
        expect(store.document!.bodies[2].appearance).toBeUndefined();
    });
});
