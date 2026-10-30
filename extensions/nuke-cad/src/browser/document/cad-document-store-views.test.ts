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
import {
    CadDocumentStore,
    MAX_NAMED_VIEWS,
    RESULT_CACHE_BUILDER_VERSION,
    RESULT_CACHE_OCP_UNKNOWN,
    computeResultCacheKeys
} from './cad-document-store';
import {
    NUKE_CAD_SCHEMA_VERSION,
    migrateNukeCadDocument,
    validateNukeCadDocument,
    type CurvePoint,
    type NukeCadDocument,
    type SavedNamedView
} from '../../common/cad-document';

function minimalDoc(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Body 1' }],
        sketches: [],
        features: [],
        curves: []
    };
}

function savedView(overrides: Partial<SavedNamedView> = {}): SavedNamedView {
    return {
        id: 'named-view-1',
        name: 'Overview',
        position: [10, 10, 10],
        target: [0, 0, 0],
        up: [0, 0, 1],
        createdAt: '2026-10-23T00:00:00.000Z',
        ...overrides
    };
}

function camera(position: CurvePoint = [10, 10, 10]): {
    name: string;
    position: CurvePoint;
    target: CurvePoint;
    up: CurvePoint;
} {
    return { name: 'Overview', position, target: [0, 0, 0], up: [0, 0, 1] };
}

function storeWithDoc(doc: NukeCadDocument = minimalDoc()): CadDocumentStore {
    const store = new CadDocumentStore();
    const loaded = store.loadDocument(doc);
    expect(loaded.success).toBe(true);
    return store;
}

describe('saved named-view schema', () => {
    it('treats an absent block as none (valid, v3, no migration)', () => {
        expect(validateNukeCadDocument(minimalDoc()).valid).toBe(true);
        const migrated = migrateNukeCadDocument(minimalDoc());
        expect(migrated.migratedFrom).toBeUndefined();
        expect(migrated.document.views).toBeUndefined();
    });

    it('migrates v2 to v3 without a views block', () => {
        const v2 = { ...minimalDoc(), version: 2 } as unknown as Record<string, unknown>;
        delete v2.curves;
        const migrated = migrateNukeCadDocument(v2);
        expect(migrated.document.version).toBe(NUKE_CAD_SCHEMA_VERSION);
        expect(migrated.migratedFrom).toBe(2);
        expect(migrated.document.views).toBeUndefined();
    });

    it('accepts a fully specified view', () => {
        const doc = minimalDoc();
        doc.views = [savedView()];
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('rejects empty names and non-finite vectors', () => {
        const bad: SavedNamedView[] = [
            { ...savedView(), name: '   ' },
            { ...savedView(), position: [0, 0] as unknown as CurvePoint },
            { ...savedView(), target: [0, 0, Infinity] },
            { ...savedView(), up: [0, Number.NaN, 1] }
        ];
        for (const entry of bad) {
            const doc = minimalDoc();
            doc.views = [entry];
            expect(validateNukeCadDocument(doc).valid).toBe(false);
        }
    });

    it('rejects empty ids, invalid timestamps, and duplicate ids/names', () => {
        const cases: SavedNamedView[][] = [
            [savedView({ id: '' })],
            [savedView({ createdAt: 'yesterday' })],
            [savedView({ createdAt: '' })],
            [savedView(), savedView()],
            [savedView(), savedView({ id: 'named-view-2', name: ' overview ' })]
        ];
        for (const views of cases) {
            const doc = minimalDoc();
            doc.views = views;
            expect(validateNukeCadDocument(doc).valid).toBe(false);
        }
    });
});

describe('saved named-view store mutations', () => {
    it('saves the current camera pose through the normal commit path', () => {
        const store = storeWithDoc();
        let changes = 0;
        store.onChange(() => {
            changes += 1;
        });
        const before = store.drawingVersion;
        const result = store.addNamedView({ ...camera([1, 2, 3]), name: '  Overview  ' });
        expect(result.success).toBe(true);
        expect(result.value).toMatch(/^named-view-/);
        const views = store.document!.views!;
        expect(views).toHaveLength(1);
        expect(views[0].name).toBe('Overview');
        expect(views[0].position).toEqual([1, 2, 3]);
        expect(views[0].target).toEqual([0, 0, 0]);
        expect(views[0].up).toEqual([0, 0, 1]);
        expect(Number.isNaN(Date.parse(views[0].createdAt))).toBe(false);
        expect(store.dirty).toBe(true);
        expect(changes).toBe(1);
        // Named views are display-only: saving one never bumps the drawing
        // version (the store/rebuild analogue the measurements test asserts).
        expect(store.drawingVersion).toBe(before);
    });

    it('copies vectors so later caller edits cannot corrupt the stored pose', () => {
        const store = storeWithDoc();
        const position: [number, number, number] = [1, 2, 3];
        const target: [number, number, number] = [4, 5, 6];
        const up: [number, number, number] = [0, 0, 1];
        expect(store.addNamedView({ name: 'Overview', position, target, up }).success).toBe(true);
        position[0] = 999;
        target[1] = 999;
        up[2] = 999;
        expect(store.document!.views![0].position).toEqual([1, 2, 3]);
        expect(store.document!.views![0].target).toEqual([4, 5, 6]);
        expect(store.document!.views![0].up).toEqual([0, 0, 1]);
    });

    it('rejects empty names, bad vectors, and duplicate names before commit', () => {
        const store = storeWithDoc();
        expect(store.addNamedView({ ...camera(), name: '   ' }).success).toBe(false);
        expect(store.addNamedView({ ...camera(), name: 5 as unknown as string }).success).toBe(false);
        expect(store.addNamedView({ ...camera(), position: [0, 0, Infinity] }).success).toBe(false);
        expect(store.addNamedView({ ...camera(), target: [0, 0] as unknown as CurvePoint }).success).toBe(false);
        expect(store.addNamedView({ ...camera(), up: [Number.NaN, 0, 1] }).success).toBe(false);
        expect(store.document!.views).toBeUndefined();
        expect(store.canUndo).toBe(false);

        expect(store.addNamedView(camera()).success).toBe(true);
        const duplicate = store.addNamedView({ ...camera(), name: '  overview ' });
        expect(duplicate.success).toBe(false);
        expect(duplicate.error).toContain('already exists');
        expect(store.document!.views).toHaveLength(1);
    });

    it('caps the block at MAX_NAMED_VIEWS', () => {
        const store = storeWithDoc();
        for (let i = 0; i < MAX_NAMED_VIEWS; i++) {
            expect(store.addNamedView({ ...camera(), name: `View ${i + 1}` }).success).toBe(true);
        }
        const overflow = store.addNamedView({ ...camera(), name: 'One too many' });
        expect(overflow.success).toBe(false);
        expect(overflow.error).toContain(String(MAX_NAMED_VIEWS));
        expect(store.document!.views).toHaveLength(MAX_NAMED_VIEWS);
    });

    it('removes by id and rejects unknown ids', () => {
        const store = storeWithDoc();
        const first = store.addNamedView(camera()).value!;
        store.addNamedView({ ...camera(), name: 'Second' });
        const before = store.drawingVersion;
        expect(store.removeNamedView('named-view-missing').success).toBe(false);
        expect(store.removeNamedView(first).success).toBe(true);
        expect(store.document!.views!.map((view) => view.name)).toEqual(['Second']);
        expect(store.drawingVersion).toBe(before);
    });

    it('covers save and delete with undo/redo', () => {
        const store = storeWithDoc();
        const id = store.addNamedView(camera()).value!;
        expect(store.canUndo).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document!.views).toBeUndefined();
        expect(store.canRedo).toBe(true);
        expect(store.redo().success).toBe(true);
        expect(store.document!.views).toHaveLength(1);
        expect(store.removeNamedView(id).success).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document!.views!.map((view) => view.id)).toEqual([id]);
    });

    it('deep-clones views so undo snapshots never share pose arrays', () => {
        const store = storeWithDoc();
        store.addNamedView(camera());
        const before = store.document!.views![0];
        store.addNamedView({ ...camera(), name: 'Second' });
        expect(store.undo().success).toBe(true);
        const after = store.document!.views![0];
        expect(after).toEqual(before);
        expect(after).not.toBe(before);
        expect(after.position).not.toBe(before.position);
        expect(after.target).not.toBe(before.target);
        expect(after.up).not.toBe(before.up);
    });

    it('persists the block through serialization', () => {
        const store = storeWithDoc();
        store.addNamedView(camera());
        const parsed = JSON.parse(store.toJson()!) as NukeCadDocument;
        expect(parsed.views).toHaveLength(1);
        expect(parsed.views![0].name).toBe('Overview');
        expect(validateNukeCadDocument(parsed).valid).toBe(true);
    });
});

describe('saved named views never reach backend inputs', () => {
    const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };

    it('leaves result-cache content keys unchanged', () => {
        const withViews = minimalDoc();
        withViews.views = [savedView()];
        expect(computeResultCacheKeys(withViews, versions)).toEqual(computeResultCacheKeys(minimalDoc(), versions));
    });
});
