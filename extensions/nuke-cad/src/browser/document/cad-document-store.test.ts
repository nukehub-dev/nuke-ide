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
import { CadDocumentStore, computeDependsOn } from './cad-document-store';
import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument, type FeatureDef, type SketchDef } from '../../common/cad-document';
import { type TopologyRef } from '../../common/topology-refs';

function minimalDoc(overrides?: Partial<NukeCadDocument>): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        sketches: [],
        features: [],
        ...overrides
    };
}

function sketch(id: string, params?: Record<string, number>): SketchDef {
    return {
        id,
        name: id,
        datumId: 'datum-xy',
        primitives: [],
        constraints: [],
        parameters: params,
        dimensions: []
    };
}

function feature(id: string, type: FeatureDef['type'], dependsOn: string[] = [], sketchId?: string): FeatureDef {
    return {
        id,
        name: id,
        type,
        params: type === 'pad' || type === 'pocket' ? { length: 1 } : { axis: 'z', angle: 90 },
        suppressed: false,
        dependsOn,
        sketchId
    };
}

function faceRef(featureId: string, center: [number, number, number] = [0, 0, 0]): TopologyRef {
    return {
        featureId,
        kind: 'face',
        fingerprint: {
            surfaceType: 'plane',
            area: 10,
            center,
            normal: [0, 0, 1]
        }
    };
}

describe('CadDocumentStore', () => {
    it('creates an empty document with three datum planes', () => {
        const store = new CadDocumentStore();
        const result = store.createDocument('bracket');
        expect(result.success).toBe(true);
        expect(store.document?.name).toBe('bracket');
        expect(store.document?.datums.map((d) => d.kind)).toEqual(['XY', 'YZ', 'XZ']);
        expect(store.document?.sketches).toHaveLength(0);
        expect(store.document?.features).toHaveLength(0);
        expect(store.dirty).toBe(false);
    });

    it('loads a valid document and surfaces validation issues', () => {
        const store = new CadDocumentStore();
        const doc = minimalDoc();
        expect(store.loadDocument(doc).success).toBe(true);
        expect(store.document?.name).toBe('test');

        const bad = { ...doc, version: 999 };
        const result = store.loadDocument(bad);
        expect(result.success).toBe(false);
        expect(result.error).toContain('version');
        expect(result.issues).toBeDefined();
    });

    it('rejects future schema versions during load', () => {
        const store = new CadDocumentStore();
        const result = store.loadDocument({ version: NUKE_CAD_SCHEMA_VERSION + 1, name: 'future' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unsupported');
    });

    it('marks dirty after mutations and clear on save', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        expect(store.dirty).toBe(false);
        store.addFeature(feature('pad1', 'pad'));
        expect(store.dirty).toBe(true);
        store.markSaved();
        expect(store.dirty).toBe(false);
        expect(store.uri).toBeUndefined();
    });

    it('tracks the backing URI', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.setUri('file:///tmp/test.nuke-cad');
        expect(store.uri).toBe('file:///tmp/test.nuke-cad');
    });

    it('serializes the active document to JSON', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const json = store.toJson();
        expect(json).toContain('"name": "test"');
        const parsed = JSON.parse(json!) as NukeCadDocument;
        expect(parsed.version).toBe(NUKE_CAD_SCHEMA_VERSION);
    });

    describe('sketch operations', () => {
        it('adds a sketch and merges local parameters into document parameters', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            const result = store.upsertSketch(sketch('s1', { width: 10 }));
            expect(result.success).toBe(true);
            expect(store.document?.parameters.width).toBe(10);
            expect(store.document?.sketches[0].parameters).toBeUndefined();
            expect(store.dirty).toBe(true);
        });

        it('updates an existing sketch', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.upsertSketch(sketch('s1', { width: 10 }));
            const updated = sketch('s1', { width: 20 });
            updated.primitives = [{ id: 'p1', type: 'point', x: 0, y: 0 }];
            store.upsertSketch(updated);
            expect(store.document?.parameters.width).toBe(20);
            expect(store.document?.sketches[0].primitives).toHaveLength(1);
        });

        it('rejects parameter name collision with different value', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.setParameter('width', 10);
            store.markSaved();
            const result = store.upsertSketch(sketch('s1', { width: 20 }));
            expect(result.success).toBe(false);
            expect(result.error).toContain('collides');
            expect(store.dirty).toBe(false);
        });

        it('accepts parameter name collision with same value', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.setParameter('width', 10);
            store.markSaved();
            const result = store.upsertSketch(sketch('s1', { width: 10 }));
            expect(result.success).toBe(true);
        });

        it('rejects deleting a sketch referenced by a feature', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.upsertSketch(sketch('s1'));
            store.addFeature(feature('pad1', 'pad', [], 's1'));
            store.markSaved();
            const result = store.deleteSketch('s1');
            expect(result.success).toBe(false);
            expect(result.error).toContain('pad1');
        });

        it('deletes a sketch and clears its selection', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.upsertSketch(sketch('s1'));
            store.selectSketch('s1');
            const result = store.deleteSketch('s1');
            expect(result.success).toBe(true);
            expect(store.document?.sketches).toHaveLength(0);
            expect(store.selection.selectedSketchId).toBeUndefined();
        });
    });

    describe('feature operations', () => {
        it('adds, updates, renames, and deletes features', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addFeature(feature('pad1', 'pad'));
            expect(store.document?.features).toHaveLength(1);

            store.updateFeatureParams('pad1', { length: 5 });
            expect((store.document?.features[0].params as { length: number }).length).toBe(5);

            store.renameFeature('pad1', 'base');
            expect(store.document?.features[0].name).toBe('base');

            store.deleteFeature('pad1');
            expect(store.document?.features).toHaveLength(0);
        });

        it('toggles feature suppression', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addFeature(feature('pad1', 'pad'));
            store.setFeatureSuppressed('pad1', true);
            expect(store.document?.features[0].suppressed).toBe(true);
        });

        it('rejects deleting a feature with dependents', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addFeature(feature('pad1', 'pad'));
            store.addFeature(feature('pad2', 'pad', ['pad1']));
            const result = store.deleteFeature('pad1');
            expect(result.success).toBe(false);
            expect(result.error).toContain('pad2');
        });

        it('selects a newly added feature', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addFeature(feature('pad1', 'pad'));
            expect(store.selection.selectedFeatureId).toBe('pad1');
        });
    });

    describe('document parameters', () => {
        it('sets and removes document parameters', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            expect(store.setParameter('width', 10).success).toBe(true);
            expect(store.document?.parameters.width).toBe(10);
            store.removeParameter('width');
            expect(store.document?.parameters.width).toBeUndefined();
        });

        it('rejects non-finite parameter values', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            expect(store.setParameter('width', NaN).success).toBe(false);
            expect(store.setParameter('width', Infinity).success).toBe(false);
        });

        it('validates parameter collisions with sketch-local parameters', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.upsertSketch(sketch('s1', { width: 10 }));
            store.markSaved();
            // Document now has width=10. Setting a different document value is fine,
            // but the resulting document must still validate (it does: sketch-local
            // params cannot collide with document params, and the stored sketch has
            // no local params after the merge).
            const result = store.setParameter('width', 20);
            expect(result.success).toBe(true);
            expect(store.document?.parameters.width).toBe(20);
        });
    });

    describe('selection', () => {
        it('tracks sketch and feature selection', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.selectSketch('s1');
            store.selectFeature('f1');
            expect(store.selection).toEqual({ selectedSketchId: 's1', selectedFeatureId: 'f1' });
            store.clearSelection();
            expect(store.selection).toEqual({});
        });
    });

    describe('feature results', () => {
        it('stores per-feature build results', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.setFeatureResults([
                { featureId: 'pad1', status: 'built' },
                { featureId: 'pad2', status: 'failed', error: 'no face' }
            ]);
            expect(store.featureResults.get('pad1')?.status).toBe('built');
            expect(store.featureResults.get('pad2')?.error).toBe('no face');
        });
    });

    describe('listeners', () => {
        it('notifies listeners on change', () => {
            const store = new CadDocumentStore();
            const calls: string[] = [];
            const unsubscribe = store.onChange(() => calls.push('change'));
            store.createDocument('test');
            store.setParameter('width', 10);
            unsubscribe();
            store.setParameter('height', 5);
            expect(calls).toHaveLength(2);
        });
    });
});

describe('computeDependsOn', () => {
    it('returns undefined for the first additive feature', () => {
        expect(computeDependsOn('pad', [])).toBeUndefined();
    });

    it('depends on the most recent solid-producing feature', () => {
        const features = [feature('pad1', 'pad'), feature('pad2', 'pad', ['pad1'])];
        expect(computeDependsOn('pocket', features)).toBe('pad2');
    });

    it('skips suppressed features', () => {
        const features = [feature('pad1', 'pad'), { ...feature('pad2', 'pad', ['pad1']), suppressed: true }];
        expect(computeDependsOn('pocket', features)).toBe('pad1');
    });

    it('returns undefined for non-solid features', () => {
        expect(computeDependsOn('fillet', [])).toBeUndefined();
    });
});

describe('face datum and external references', () => {
    it('adds a face datum with a topology reference', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const ref = faceRef('base', [1, 2, 3]);
        const result = store.addDatum('face', 0, ref);
        expect(result.success).toBe(true);
        const datum = store.document?.datums.find((d) => d.kind === 'face');
        expect(datum).toBeDefined();
        expect(datum?.reference).toEqual(ref);
    });

    it('reuses an existing face datum with the same fingerprint', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const ref = faceRef('base');
        const first = store.addDatum('face', 0, ref);
        const second = store.addDatum('face', 0, ref);
        expect(first.value).toBe(second.value);
        expect(store.document?.datums.filter((d) => d.kind === 'face')).toHaveLength(1);
    });

    it('rejects a face datum without a reference', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addDatum('face');
        expect(result.success).toBe(false);
        expect(result.error).toContain('reference');
    });

    it('adds and removes external references on a sketch', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.upsertSketch(sketch('s1'));
        const ref = faceRef('base');
        const add = store.addExternalRef('s1', ref);
        expect(add.success).toBe(true);
        expect(store.document?.sketches[0].externalRefs).toHaveLength(1);

        const remove = store.removeExternalRef('s1', 0);
        expect(remove.success).toBe(true);
        expect(store.document?.sketches[0].externalRefs).toBeUndefined();
    });

    it('rejects removing an external reference with an invalid index', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.upsertSketch(sketch('s1'));
        const result = store.removeExternalRef('s1', 0);
        expect(result.success).toBe(false);
    });

    it('stores projected primitives per sketch', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.setProjectedPrimitives({ s1: [{ id: 'p1', type: 'point', x: 1, y: 2 }] });
        expect(store.getProjectedPrimitives().get('s1')).toHaveLength(1);
        expect(store.getProjectedPrimitives().get('s1')?.[0]).toEqual({ id: 'p1', type: 'point', x: 1, y: 2 });
    });

    it('stores reference resolution results', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.setReferenceResults([
            { featureId: 'f1', path: 'sketch.s1.externalRefs[0]', kind: 'face', status: 'matched' },
            { featureId: 'f1', path: 'datum.d1.reference', kind: 'face', status: 'ambiguous' }
        ]);
        expect(store.getReferenceResults()).toHaveLength(2);
        expect(store.getReferenceResults()[0].status).toBe('matched');
    });
});
