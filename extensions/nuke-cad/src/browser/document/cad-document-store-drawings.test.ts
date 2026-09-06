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
import { CadDocumentStore } from './cad-document-store';
import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument } from '../../common/cad-document';
import { type TopologyRef } from '../../common/topology-refs';

function edgeRef(featureId = 'pad-1'): TopologyRef {
    return {
        featureId,
        kind: 'edge',
        fingerprint: { curveType: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0] }
    };
}

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

function storeWithDoc(): CadDocumentStore {
    const store = new CadDocumentStore();
    const loaded = store.loadDocument(minimalDoc());
    expect(loaded.success).toBe(true);
    return store;
}

describe('drawing-sheet store mutations', () => {
    it('adds sheets with generated ids and bumps drawingVersion', () => {
        const store = storeWithDoc();
        const before = store.drawingVersion;
        const result = store.addSheet('A4');
        expect(result.success).toBe(true);
        expect(result.value).toMatch(/^sheet-/);
        expect(store.drawingVersion).toBe(before + 1);
        const sheet = store.document!.drawings![0];
        expect(sheet.size).toBe('A4');
        expect(sheet.orientation).toBe('landscape');
        expect(sheet.views).toEqual([]);
    });

    it('rejects unknown sheet sizes', () => {
        const store = storeWithDoc();
        const result = store.addSheet('A0' as 'A4');
        expect(result.success).toBe(false);
    });

    it('adds base and projected views with parent guards', () => {
        const store = storeWithDoc();
        const sheetId = store.addSheet('A3').value!;
        const baseId = store.addView(sheetId, { kind: 'base', orientation: 'front', scale: 1, position: [210, 150] }).value!;
        expect(store.document!.drawings![0].views).toHaveLength(1);
        const projected = store.addView(sheetId, {
            kind: 'projected',
            orientation: 'top',
            scale: 1,
            position: [210, 220],
            parentId: baseId
        });
        expect(projected.success).toBe(true);
        expect(store.addView(sheetId, { kind: 'projected', orientation: 'top', scale: 1, position: [210, 220] }).success).toBe(false);
        expect(store.addView(sheetId, { kind: 'base', orientation: 'front', scale: 1, position: [10, 10], parentId: baseId }).success).toBe(
            false
        );
        expect(store.addView('sheet-missing', { kind: 'base', orientation: 'front', scale: 1, position: [10, 10] }).success).toBe(false);
    });

    it('snaps, clamps, and alignment-locks moved views', () => {
        const store = storeWithDoc();
        const sheetId = store.addSheet('A4').value!;
        const baseId = store.addView(sheetId, { kind: 'base', orientation: 'front', scale: 1, position: [100, 100] }).value!;
        const topId = store.addView(sheetId, {
            kind: 'projected',
            orientation: 'top',
            scale: 1,
            position: [100, 160],
            parentId: baseId
        }).value!;
        // Free drag of a projected view keeps the parent x (alignment lock) with grid snap.
        expect(store.updateViewPosition(sheetId, topId, [123, 171]).success).toBe(true);
        expect(store.document!.drawings![0].views.find((v) => v.id === topId)!.position).toEqual([100, 170]);
        // Base views move freely with snap; out-of-sheet drags clamp inside A4.
        expect(store.updateViewPosition(sheetId, baseId, [12, 500]).success).toBe(true);
        expect(store.document!.drawings![0].views.find((v) => v.id === baseId)!.position).toEqual([10, 210]);
        expect(store.updateViewPosition(sheetId, baseId, [NaN, 10]).success).toBe(false);
    });

    it('adds dimensions with target-arity guards', () => {
        const store = storeWithDoc();
        const sheetId = store.addSheet('A4').value!;
        const viewId = store.addView(sheetId, { kind: 'base', orientation: 'front', scale: 1, position: [100, 100] }).value!;
        const ok = store.addDimension(sheetId, { kind: 'distance', targets: [edgeRef(), edgeRef()], viewId });
        expect(ok.success).toBe(true);
        expect(store.addDimension(sheetId, { kind: 'radius', targets: [edgeRef(), edgeRef()], viewId }).success).toBe(false);
        expect(store.addDimension(sheetId, { kind: 'radius', targets: [edgeRef()], viewId: 'view-missing' }).success).toBe(false);
    });

    it('keeps mutations immutable and preserves drawings across unrelated edits', () => {
        const store = storeWithDoc();
        const before = store.document!;
        const sheetId = store.addSheet('A4').value!;
        expect(store.document).not.toBe(before);
        expect(before.drawings).toBeUndefined();
        store.addView(sheetId, { kind: 'base', orientation: 'front', scale: 1, position: [100, 100] });
        // An unrelated mutation (parameter edit) must not drop the drawings block.
        expect(store.setParameter('p', 1).success).toBe(true);
        expect(store.document!.drawings).toHaveLength(1);
        expect(store.document!.drawings![0].views).toHaveLength(1);
    });

    it('validates drawings on load without migrating the schema', () => {
        const store = new CadDocumentStore();
        const doc = {
            ...minimalDoc(),
            drawings: [{ id: 'sheet-1', name: 'S', size: 'A5', orientation: 'landscape', views: [], dimensions: [] }]
        };
        const result = store.loadDocument(doc);
        expect(result.success).toBe(false);
        expect(store.document).toBeUndefined();
    });
});
