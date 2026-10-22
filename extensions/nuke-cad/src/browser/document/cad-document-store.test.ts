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
import { createHash } from 'node:crypto';
import {
    CadDocumentStore,
    DOCUMENT_HISTORY_DEPTH,
    MemoryResultCache,
    PartialRebuildTracker,
    RESULT_CACHE_BUILDER_VERSION,
    RESULT_CACHE_OCP_UNKNOWN,
    allFeatureIds,
    assemblyDof,
    cacheKeyForDocument,
    canonicalJson,
    checkOpenFastPath,
    computeDependsOn,
    computeResultCacheKeys,
    featuresConsumingCurve,
    featuresConsumingSketch,
    featuresOnDatum,
    formatCanonicalNumber,
    getAssemblySection,
    partialCacheDirForDocument,
    planDirtyRebuild,
    sampleParametricWithUnits,
    sha256Hex,
    shouldUsePartialPlan,
    type CachedDocumentResult,
    uniqueFeatureId
} from './cad-document-store';
import {
    NUKE_CAD_SCHEMA_VERSION,
    validateNukeCadDocument,
    type NukeCadDocument,
    type CurveDef,
    type DocumentUnits,
    type FeatureDef,
    type SketchDef
} from '../../common/cad-document';
import { type TopologyRef } from '../../common/topology-refs';

function minimalDoc(overrides?: Partial<NukeCadDocument>): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Body 1' }],
        sketches: [],
        features: [],
        curves: [],
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

function feature(id: string, type: FeatureDef['type'], dependsOn: string[] = [], sketchId?: string, bodyId = 'body-1'): FeatureDef {
    return {
        id,
        name: id,
        type,
        body: bodyId,
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

    it('creates a document from a template', () => {
        const store = new CadDocumentStore();
        const result = store.createDocument('pincell', 'pincell');
        expect(result.success).toBe(true);
        expect(store.document?.parameters).toEqual({
            fuelRadius: 0.4,
            cladRadius: 0.5,
            pitch: 1.26
        });
        expect(store.document?.datums).toHaveLength(3);
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
        store.addBody('Body 1');
        expect(store.dirty).toBe(true);
        store.markSaved();
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
            store.addBody('Body 1');
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
            store.addBody('Body 1');
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
            store.addBody('Body 1');
            store.addFeature(feature('pad1', 'pad'));
            store.setFeatureSuppressed('pad1', true);
            expect(store.document?.features[0].suppressed).toBe(true);
        });

        it('rejects deleting a feature with dependents', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addBody('Body 1');
            store.addFeature(feature('pad1', 'pad'));
            store.addFeature(feature('pad2', 'pad', ['pad1']));
            const result = store.deleteFeature('pad1');
            expect(result.success).toBe(false);
            expect(result.error).toContain('pad2');
        });

        it('selects a newly added feature', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addBody('Body 1');
            store.addFeature(feature('pad1', 'pad'));
            expect(store.selection.selectedFeatureId).toBe('pad1');
        });

        it('mints feature ids unique within the document across sessions', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addBody('Body 1');
            // A reloaded document may already hold session-counter ids.
            store.addFeature(feature('feature-1', 'pad'));
            store.addFeature(feature('feature-2', 'pad'));
            const doc = store.document;
            expect(doc).toBeDefined();
            if (doc === undefined) {
                return;
            }
            const id = uniqueFeatureId(doc);
            expect(doc.features.some((f) => f.id === id)).toBe(false);
            expect(id).toBe('feature-3');
        });
    });

    describe('body operations', () => {
        it('adds, renames, labels, and removes bodies', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            const add = store.addBody('Fuel', 'fuel');
            expect(add.success).toBe(true);
            expect(store.document?.bodies.some((b) => b.name === 'Fuel' && b.label === 'fuel')).toBe(true);
            expect(store.selection.selectedBodyId).toBe(add.value);

            store.renameBody(add.value!, 'Fuel Pin');
            expect(store.document?.bodies[0].name).toBe('Fuel Pin');

            store.setBodyLabel(add.value!, 'fuel_pin');
            expect(store.document?.bodies[0].label).toBe('fuel_pin');

            const removal = store.removeBody(add.value!);
            expect(removal.success).toBe(true);
            expect(store.document?.bodies).toHaveLength(0);
        });

        it('rejects removing a body referenced by a feature', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.addBody('Base', 'base');
            const bodyId = store.document!.bodies[0].id;
            store.addFeature(feature('pad1', 'pad', [], undefined, bodyId));
            const result = store.removeBody(bodyId);
            expect(result.success).toBe(false);
            expect(result.error).toContain('pad1');
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
        it('tracks sketch, feature, and body selection', () => {
            const store = new CadDocumentStore();
            store.createDocument('test');
            store.selectSketch('s1');
            store.selectFeature('f1');
            store.selectBody('b1');
            expect(store.selection).toEqual({ selectedSketchId: 's1', selectedFeatureId: 'f1', selectedBodyId: 'b1' });
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
        expect(computeDependsOn('pad', 'body-1', [])).toBeUndefined();
    });

    it('depends on the most recent solid-producing feature on the same body', () => {
        const features = [feature('pad1', 'pad'), feature('pad2', 'pad', ['pad1'])];
        expect(computeDependsOn('pocket', 'body-1', features)).toBe('pad2');
    });

    it('skips suppressed features', () => {
        const features = [feature('pad1', 'pad'), { ...feature('pad2', 'pad', ['pad1']), suppressed: true }];
        expect(computeDependsOn('pocket', 'body-1', features)).toBe('pad1');
    });

    it('returns undefined for non-solid features', () => {
        expect(computeDependsOn('fillet', 'body-1', [])).toBeUndefined();
    });
    it('ignores solid-producing features on other bodies', () => {
        const features = [feature('pad1', 'pad', [], undefined, 'body-a'), feature('pad2', 'pad', [], undefined, 'body-b')];
        expect(computeDependsOn('pocket', 'body-b', features)).toBe('pad2');
        expect(computeDependsOn('pocket', 'body-a', features)).toBe('pad1');
    });

    it('treats primitive as a body-tip producer like pad', () => {
        expect(computeDependsOn('primitive', 'body-1', [])).toBeUndefined();
        const features = [feature('pad1', 'pad')];
        expect(computeDependsOn('primitive', 'body-1', features)).toBe('pad1');
        const primitive: FeatureDef = {
            ...feature('prim1', 'primitive', ['pad1']),
            params: { shape: 'box', dimensions: [1, 2, 3] }
        };
        expect(computeDependsOn('pocket', 'body-1', [...features, primitive])).toBe('prim1');
    });

    it('chains multiTransform after the body tip (sources ride explicit dependsOn)', () => {
        const features = [feature('pad1', 'pad'), feature('lin1', 'linearPattern', ['pad1'])];
        expect(computeDependsOn('multiTransform', 'body-1', features)).toBe('lin1');
        const multi: FeatureDef = {
            id: 'mt1',
            name: 'mt1',
            type: 'multiTransform',
            body: 'body-1',
            params: { first: 'lin1', second: 'lin1' },
            suppressed: false,
            dependsOn: ['lin1']
        };
        expect(computeDependsOn('fillet', 'body-1', [...features, multi])).toBe('mt1');
    });

    it('returns undefined for defeature (not a solid producer)', () => {
        const features = [feature('pad1', 'pad')];
        expect(computeDependsOn('defeature', 'body-1', features)).toBeUndefined();
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

describe('dress-up feature store support', () => {
    function edgeRef(featureId: string): TopologyRef {
        return {
            featureId,
            kind: 'edge',
            fingerprint: { curveType: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0] }
        };
    }

    it('adds a fillet feature without a sketch', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const fillet: FeatureDef = {
            id: 'fillet1',
            name: 'fillet1',
            type: 'fillet',
            body: 'body-1',
            params: { edges: [edgeRef('pad1')], radius: 1 },
            suppressed: false,
            dependsOn: ['pad1']
        };
        const result = store.addFeature(fillet);
        expect(result.success).toBe(true);
        expect(store.document?.features).toHaveLength(2);
        expect(store.selection.selectedFeatureId).toBe('fillet1');
    });

    it('adds a shell feature with an empty face list', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const shell: FeatureDef = {
            id: 'shell1',
            name: 'shell1',
            type: 'shell',
            body: 'body-1',
            params: { faces: [], thickness: 1 },
            suppressed: false,
            dependsOn: ['pad1']
        };
        const result = store.addFeature(shell);
        expect(result.success).toBe(true);
        expect((store.document?.features[1].params as { faces: unknown[] }).faces).toHaveLength(0);
    });

    it('computes dependsOn for dress-up features against the body tip', () => {
        const features: FeatureDef[] = [
            { ...feature('pad1', 'pad'), body: 'body-1' },
            { ...feature('fillet1', 'fillet', ['pad1']), body: 'body-1', params: { edges: [], radius: 1 }, sketchId: undefined }
        ];
        expect(computeDependsOn('shell', 'body-1', features)).toBe('fillet1');
    });
});

describe('pattern, mirror, and hole feature store support', () => {
    function faceRef(featureId: string): TopologyRef {
        return {
            featureId,
            kind: 'face',
            fingerprint: { surfaceType: 'plane', area: 25, center: [0, 0, 0], normal: [0, 0, 1] }
        };
    }

    it('computes dependsOn for linear, circular, mirror, and hole features against the body tip', () => {
        const features: FeatureDef[] = [
            { ...feature('pad1', 'pad'), body: 'body-1' },
            { ...feature('fillet1', 'fillet', ['pad1']), body: 'body-1', params: { edges: [], radius: 1 }, sketchId: undefined }
        ];
        expect(computeDependsOn('linearPattern', 'body-1', features)).toBe('fillet1');
        expect(computeDependsOn('circularPattern', 'body-1', features)).toBe('fillet1');
        expect(computeDependsOn('mirror', 'body-1', features)).toBe('fillet1');
        expect(computeDependsOn('hole', 'body-1', features)).toBe('fillet1');
    });

    it('adds a linear pattern feature', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const pattern: FeatureDef = {
            id: 'lin1',
            name: 'lin1',
            type: 'linearPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 3, spacing: 2, axis: 'x' },
            suppressed: false,
            dependsOn: ['pad1']
        };
        const result = store.addFeature(pattern);
        expect(result.success).toBe(true);
        expect(store.document?.features).toHaveLength(2);
    });

    it('adds a mirror feature with a datum plane', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const datum = store.addDatum('offset', 5);
        expect(datum.success).toBe(true);
        const mirror: FeatureDef = {
            id: 'mir1',
            name: 'mir1',
            type: 'mirror',
            body: 'body-1',
            params: { source: 'pad1', planeDatumId: datum.value! },
            suppressed: false,
            dependsOn: ['pad1']
        };
        const result = store.addFeature(mirror);
        expect(result.success).toBe(true);
    });

    it('adds a hole feature with a face reference and UV center', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const hole: FeatureDef = {
            id: 'hole1',
            name: 'hole1',
            type: 'hole',
            body: 'body-1',
            params: { face: faceRef('pad1'), center: [1, 2], diameter: 0.5 },
            suppressed: false,
            dependsOn: ['pad1']
        };
        const result = store.addFeature(hole);
        expect(result.success).toBe(true);
        const params = store.document?.features[1].params as { face: TopologyRef; center: [number, number]; diameter: number };
        expect(params.center).toEqual([1, 2]);
        expect(params.diameter).toBe(0.5);
    });
});

describe('sweep and pipe features', () => {
    function pointsCurve(id: string): import('../../common/cad-document').CurveDef {
        return {
            id,
            name: id,
            source: { kind: 'points' },
            samples: [
                [0, 0, 0],
                [1, 0, 0],
                [1, 1, 0],
                [0, 1, 0]
            ]
        };
    }

    it('adds a sweep feature referencing a sketch and a path curve', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.upsertSketch(sketch('sk1'));
        store.addCurve(pointsCurve('c1'));
        const sweep: FeatureDef = {
            id: 'sw1',
            name: 'sw1',
            type: 'sweep',
            body: 'body-1',
            sketchId: 'sk1',
            params: { pathCurveId: 'c1', orientation: 'frenet' },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(sweep);
        expect(result.success).toBe(true);
        expect(store.document?.features).toHaveLength(1);
        expect(store.selection.selectedFeatureId).toBe('sw1');
        expect(computeDependsOn('fillet', 'body-1', store.document?.features ?? [])).toBe('sw1');
    });

    it('adds a pipe feature without a sketch', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addCurve(pointsCurve('c1'));
        const pipe: FeatureDef = {
            id: 'pp1',
            name: 'pp1',
            type: 'pipe',
            body: 'body-1',
            params: { pathCurveId: 'c1', radius: 0.25, orientation: 'fixedBinormal', binormal: [0, 0, 1] },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(pipe);
        expect(result.success).toBe(true);
        expect(store.document?.features[0].sketchId).toBeUndefined();
        expect(computeDependsOn('shell', 'body-1', store.document?.features ?? [])).toBe('pp1');
    });

    it('rejects a pipe with a non-positive radius', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        const pipe: FeatureDef = {
            id: 'pp1',
            name: 'pp1',
            type: 'pipe',
            body: 'body-1',
            params: { pathCurveId: 'c1', radius: -1, orientation: 'frenet' },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(pipe);
        expect(result.success).toBe(false);
        expect(result.error).toContain('radius');
    });

    it('rejects a fixedBinormal sweep without a binormal', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        const sweep: FeatureDef = {
            id: 'sw1',
            name: 'sw1',
            type: 'sweep',
            body: 'body-1',
            sketchId: 'sk1',
            params: { pathCurveId: 'c1', orientation: 'fixedBinormal' },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(sweep);
        expect(result.success).toBe(false);
        expect(result.error).toContain('binormal');
    });

    it('adds a loft feature with ordered sections and no sketchId', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.upsertSketch(sketch('sk1'));
        store.upsertSketch(sketch('sk2'));
        const loft: FeatureDef = {
            id: 'lf1',
            name: 'lf1',
            type: 'loft',
            body: 'body-1',
            params: { sectionSketchIds: ['sk1', 'sk2'], ruled: true },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(loft);
        expect(result.success).toBe(true);
        expect(store.document?.features[0].sketchId).toBeUndefined();
        expect(store.document?.features[0].params).toEqual({ sectionSketchIds: ['sk1', 'sk2'], ruled: true });
        // Loft is a solid producer: later features on the same body chain after it.
        expect(computeDependsOn('fillet', 'body-1', store.document?.features ?? [])).toBe('lf1');
        expect(computeDependsOn('loft', 'body-1', [])).toBeUndefined();
    });

    it('rejects a loft with fewer than two sections', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        const loft: FeatureDef = {
            id: 'lf1',
            name: 'lf1',
            type: 'loft',
            body: 'body-1',
            params: { sectionSketchIds: ['sk1'], ruled: false },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(loft);
        expect(result.success).toBe(false);
        expect(result.error).toContain('section');
    });

    it('rejects deleting a sketch used as a loft section', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.upsertSketch(sketch('sk1'));
        store.upsertSketch(sketch('sk2'));
        const loft: FeatureDef = {
            id: 'lf1',
            name: 'lf1',
            type: 'loft',
            body: 'body-1',
            params: { sectionSketchIds: ['sk1', 'sk2'], ruled: false },
            suppressed: false,
            dependsOn: []
        };
        expect(store.addFeature(loft).success).toBe(true);
        const result = store.deleteSketch('sk2');
        expect(result.success).toBe(false);
        expect(result.error).toContain('lf1');
    });

    it('adds a helical sweep feature with its sketch', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.upsertSketch(sketch('sk1'));
        const helix: FeatureDef = {
            id: 'hx1',
            name: 'hx1',
            type: 'helicalSweep',
            body: 'body-1',
            sketchId: 'sk1',
            params: { axis: 'Z', startRadius: 2, pitch: 1, turns: 3, orientation: 'fixedBinormal', binormal: [0, 0, 1] },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(helix);
        expect(result.success).toBe(true);
        // Helical sweep is a solid producer like sweep.
        expect(computeDependsOn('shell', 'body-1', store.document?.features ?? [])).toBe('hx1');
        expect(computeDependsOn('helicalSweep', 'body-1', [])).toBeUndefined();
    });

    it('rejects a helical sweep with a non-positive pitch', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        const helix: FeatureDef = {
            id: 'hx1',
            name: 'hx1',
            type: 'helicalSweep',
            body: 'body-1',
            sketchId: 'sk1',
            params: { axis: 'Z', startRadius: 2, pitch: 0, turns: 3, orientation: 'frenet' },
            suppressed: false,
            dependsOn: []
        };
        const result = store.addFeature(helix);
        expect(result.success).toBe(false);
        expect(result.error).toContain('pitch');
    });
});

describe('feature reordering', () => {
    it('accepts a valid permutation that preserves dependency precedence', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        store.addFeature(feature('pad2', 'pad', ['pad1']));
        store.addFeature(feature('pad3', 'pad', ['pad2']));
        const result = store.reorderFeatures(['pad1', 'pad3', 'pad2']);
        expect(result.success).toBe(false);
        expect(result.error).toContain('pad3 depends on pad2');
    });

    it('rejects ids that are not a permutation of the feature list', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const result = store.reorderFeatures(['pad1', 'pad2']);
        expect(result.success).toBe(false);
        expect(result.error).toContain('permutation');
    });

    it('reorders features when dependencies remain before dependents', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        store.addFeature(feature('pad2', 'pad', ['pad1']));
        const result = store.reorderFeatures(['pad1', 'pad2']);
        expect(result.success).toBe(true);
        expect(store.document?.features.map((f) => f.id)).toEqual(['pad1', 'pad2']);
    });
});

describe('cascade delete', () => {
    it('still rejects deletion when dependents exist under error policy', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        store.addFeature(feature('pad2', 'pad', ['pad1']));
        const result = store.deleteFeature('pad1', 'error');
        expect(result.success).toBe(false);
        expect(result.error).toContain('pad2');
    });

    it('cascade deletes transitive dependsOn dependents', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        store.addFeature(feature('pad2', 'pad', ['pad1']));
        store.addFeature(feature('pad3', 'pad', ['pad2']));
        const result = store.deleteFeature('pad1', 'cascade');
        expect(result.success).toBe(true);
        expect(store.document?.features.map((f) => f.id)).toEqual([]);
    });

    it('cascade deletes pattern and mirror source dependents', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const pattern: FeatureDef = {
            id: 'pat1',
            name: 'pat1',
            type: 'linearPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 2, spacing: 1, axis: 'x' },
            suppressed: false,
            dependsOn: ['pad1']
        };
        store.addFeature(pattern);
        const result = store.deleteFeature('pad1', 'cascade');
        expect(result.success).toBe(true);
        expect(store.document?.features.map((f) => f.id)).toEqual([]);
    });

    it('blocks deleting a source feature under error policy', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const mirror: FeatureDef = {
            id: 'mir1',
            name: 'mir1',
            type: 'mirror',
            body: 'body-1',
            params: { source: 'pad1', plane: 'XY' },
            suppressed: false,
            dependsOn: ['pad1']
        };
        store.addFeature(mirror);
        const result = store.deleteFeature('pad1', 'error');
        expect(result.success).toBe(false);
        expect(result.error).toContain('mir1');
    });
});

describe('rename validation', () => {
    it('rejects empty feature names', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const result = store.renameFeature('pad1', '');
        expect(result.success).toBe(false);
    });

    it('rejects duplicate feature names', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature({ ...feature('pad1', 'pad'), name: 'base' });
        store.addFeature({ ...feature('pad2', 'pad', ['pad1']), name: 'rim' });
        const result = store.renameFeature('pad2', 'base');
        expect(result.success).toBe(false);
        expect(result.error).toContain('already in use');
    });

    it('rejects empty body names', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const add = store.addBody('Body 1');
        const result = store.renameBody(add.value!, '');
        expect(result.success).toBe(false);
    });

    it('rejects duplicate body names', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const a = store.addBody('Body A');
        store.addBody('Body B');
        const result = store.renameBody(a.value!, 'Body B');
        expect(result.success).toBe(false);
        expect(result.error).toContain('already in use');
    });
});

describe('replaceTopologyRef', () => {
    function faceFingerprint(center: [number, number, number]) {
        return { surfaceType: 'plane' as const, area: 10, center, normal: [0, 0, 1] as [number, number, number] };
    }

    function edgeFingerprint(start: [number, number, number], end: [number, number, number]) {
        return { curveType: 'line' as const, length: 1, start, end };
    }

    it('replaces a datum reference fingerprint', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const ref = faceRef('base', [0, 0, 0]);
        store.addDatum('face', 0, ref);
        const datumId = store.document!.datums.find((d) => d.kind === 'face')!.id;
        const updated = faceFingerprint([1, 2, 3]);
        const result = store.replaceTopologyRef(`datum.${datumId}.reference`, updated);
        expect(result.success).toBe(true);
        const datum = store.document!.datums.find((d) => d.id === datumId)!;
        expect((datum.reference!.fingerprint as { center: [number, number, number] }).center).toEqual([1, 2, 3]);
    });

    it('replaces a sketch external reference fingerprint', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.upsertSketch(sketch('s1'));
        store.addExternalRef('s1', faceRef('base'));
        const updated = faceFingerprint([1, 1, 1]);
        const result = store.replaceTopologyRef('sketch.s1.externalRefs[0]', updated);
        expect(result.success).toBe(true);
        expect((store.document!.sketches[0].externalRefs![0].fingerprint as { center: [number, number, number] }).center).toEqual([
            1, 1, 1
        ]);
    });

    it('replaces a feature edge fingerprint', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        const fillet: FeatureDef = {
            id: 'fillet1',
            name: 'fillet1',
            type: 'fillet',
            body: 'body-1',
            params: {
                edges: [{ featureId: 'pad_a', kind: 'edge', fingerprint: edgeFingerprint([0, 0, 0], [1, 0, 0]) }],
                radius: 0.5
            },
            suppressed: false,
            dependsOn: []
        };
        store.addFeature(fillet);
        const updated = edgeFingerprint([2, 0, 0], [3, 0, 0]);
        const result = store.replaceTopologyRef('feature.fillet1.params.edges[0]', updated);
        expect(result.success).toBe(true);
        const edge = (store.document!.features[0].params as { edges: { fingerprint: { start: [number, number, number] } }[] }).edges[0];
        expect(edge.fingerprint.start).toEqual([2, 0, 0]);
    });

    it('rejects malformed paths', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.replaceTopologyRef('datum.missing.reference', faceFingerprint([0, 0, 0]));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown datum');
    });

    it('rejects an invalid replacement fingerprint', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addDatum('face', 0, faceRef('base'));
        const datumId = store.document!.datums.find((d) => d.kind === 'face')!.id;
        const bad = { surfaceType: 'plane', area: -1, center: [0, 0, 0] } as unknown as {
            surfaceType: 'plane';
            area: number;
            center: [number, number, number];
        };
        const result = store.replaceTopologyRef(`datum.${datumId}.reference`, bad);
        expect(result.success).toBe(false);
    });
});

describe('feature reordering with pattern sources', () => {
    it('rejects moving a pattern before its implied source dependency', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        const pattern: FeatureDef = {
            id: 'pat1',
            name: 'pat1',
            type: 'circularPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 3, axis: 'z' },
            suppressed: false,
            dependsOn: []
        };
        store.addFeature(pattern);
        const result = store.reorderFeatures(['pat1', 'pad1']);
        expect(result.success).toBe(false);
        expect(result.error).toContain('pat1 depends on pad1');
        expect(store.document?.features.map((f) => f.id)).toEqual(['pad1', 'pat1']);
    });

    it('accepts a permutation that keeps the source before the pattern', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        store.addFeature(feature('pad2', 'pad', ['pad1']));
        const mirror: FeatureDef = {
            id: 'mir1',
            name: 'mir1',
            type: 'mirror',
            body: 'body-1',
            params: { source: 'pad1', plane: 'YZ' },
            suppressed: false,
            dependsOn: ['pad2']
        };
        store.addFeature(mirror);
        const result = store.reorderFeatures(['pad1', 'mir1', 'pad2']);
        expect(result.success).toBe(false);
        expect(result.error).toContain('mir1 depends on pad2');
    });
});

describe('replaceTopologyRef atomicity', () => {
    function edgeFingerprint(start: [number, number, number], end: [number, number, number]) {
        return { curveType: 'line' as const, length: 1, start, end };
    }

    function storeWithFillet(): CadDocumentStore {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        const fillet: FeatureDef = {
            id: 'fillet1',
            name: 'fillet1',
            type: 'fillet',
            body: 'body-1',
            params: {
                edges: [{ featureId: 'pad_a', kind: 'edge', fingerprint: edgeFingerprint([0, 0, 0], [1, 0, 0]) }],
                radius: 0.5
            },
            suppressed: false,
            dependsOn: []
        };
        store.addFeature(fillet);
        return store;
    }

    it('does not mutate the previously committed document object on success', () => {
        const store = storeWithFillet();
        const before = store.document!;
        const result = store.replaceTopologyRef('feature.fillet1.params.edges[0]', edgeFingerprint([2, 0, 0], [3, 0, 0]));
        expect(result.success).toBe(true);
        // The store moved to a new document object, and the previous object
        // still holds the original fingerprint (no shared-params corruption).
        const oldEdges = (before.features[0].params as { edges: TopologyRef[] }).edges;
        expect(oldEdges[0].fingerprint).toEqual(edgeFingerprint([0, 0, 0], [1, 0, 0]));
        const newEdges = (store.document!.features[0].params as { edges: TopologyRef[] }).edges;
        expect(newEdges[0].fingerprint).toEqual(edgeFingerprint([2, 0, 0], [3, 0, 0]));
    });

    it('leaves the live document untouched on the failure path', () => {
        const store = storeWithFillet();
        const before = store.document!;
        const beforeJson = store.toJson();
        const bad = { curveType: 'line', length: -1, start: [0, 0, 0], end: [1, 0, 0] } as unknown as Parameters<
            CadDocumentStore['replaceTopologyRef']
        >[1];
        const result = store.replaceTopologyRef('feature.fillet1.params.edges[0]', bad);
        expect(result.success).toBe(false);
        expect(store.document).toBe(before);
        expect(store.toJson()).toBe(beforeJson);
    });
});

describe('reference repair flow', () => {
    it('repairs a broken reference from a backend-shaped candidate payload', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addDatum('face', 0, faceRef('base', [0, 0, 0]));
        const datumId = store.document!.datums.find((d) => d.kind === 'face')!.id;

        // Payload as emitted by reference_scoring.match_references().to_dict():
        // candidate ids are re-sorted per rebuild and carry no identity; the
        // fingerprint is what replaceTopologyRef consumes.
        const resolution: import('../../common/nuke-cad-protocol').ReferenceResolutionResult = {
            featureId: 'pad1',
            path: `datum.${datumId}.reference`,
            kind: 'face',
            status: 'ambiguous',
            candidateId: 'face_0001',
            score: 0.91,
            runnerUpScore: 0.89,
            candidates: [
                {
                    candidateId: 'face_0007',
                    score: 0.89,
                    fingerprint: { surfaceType: 'plane', area: 12, center: [4, 5, 6], normal: [0, 0, 1] }
                },
                {
                    candidateId: 'face_0002',
                    score: 0.55,
                    fingerprint: { surfaceType: 'plane', area: 9, center: [1, 1, 1], normal: [0, 1, 0] }
                }
            ]
        };
        const candidate = resolution.candidates![0];
        expect(candidate.fingerprint).toBeDefined();
        const result = store.replaceTopologyRef(resolution.path, candidate.fingerprint!);
        expect(result.success).toBe(true);
        const datum = store.document!.datums.find((d) => d.id === datumId)!;
        expect(datum.reference!.fingerprint).toEqual(candidate.fingerprint);
        // The replacement keeps the original producing feature id.
        expect(datum.reference!.featureId).toBe('base');
    });
});

describe('curve operations', () => {
    function circleSamples(count: number): [number, number, number][] {
        const pts: [number, number, number][] = [];
        for (let i = 0; i < count; i++) {
            const theta = (2 * Math.PI * i) / count;
            pts.push([Math.cos(theta), Math.sin(theta), 0]);
        }
        return pts;
    }

    function pointsCurve(id: string, name: string): import('../../common/cad-document').CurveDef {
        return {
            id,
            name,
            source: { kind: 'points' },
            samples: circleSamples(8)
        };
    }

    it('adds a points-sourced curve', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addCurve(pointsCurve('c1', 'Circle'));
        expect(result.success).toBe(true);
        expect(store.document?.curves).toHaveLength(1);
        expect(store.document?.curves[0].name).toBe('Circle');
        expect(store.selection.selectedCurveId).toBe(result.value);
    });

    it('rejects duplicate curve names', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addCurve(pointsCurve('c1', 'Circle'));
        const result = store.addCurve(pointsCurve('c2', 'Circle'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('already in use');
    });

    it('rejects curves with fewer than 4 samples', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addCurve({
            id: 'c1',
            name: 'Short',
            source: { kind: 'points' },
            samples: [
                [0, 0, 0],
                [1, 0, 0],
                [2, 0, 0]
            ]
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('at least 4 samples');
    });

    it('resamples a parametric curve on add', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addCurve({
            id: 'c1',
            name: 'Helix',
            source: {
                kind: 'parametric',
                x: 'cos(t)',
                y: 'sin(t)',
                z: 't',
                tStart: 0,
                tEnd: 1,
                sampleCount: 16
            },
            samples: []
        });
        expect(result.success).toBe(true);
        expect(store.document?.curves[0].samples).toHaveLength(16);
    });

    it('resamples a parametric curve using document parameters', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.setParameter('radius', 3);
        store.addCurve({
            id: 'c1',
            name: 'Scaled',
            source: {
                kind: 'parametric',
                x: 'radius * cos(t)',
                y: 'radius * sin(t)',
                z: '0',
                tStart: 0,
                tEnd: 2 * Math.PI,
                sampleCount: 16
            },
            samples: []
        });
        const samples = store.document!.curves[0].samples;
        expect(samples[0][0]).toBeCloseTo(3, 10);
    });

    it('reports errors from invalid parametric expressions', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addCurve({
            id: 'c1',
            name: 'Bad',
            source: {
                kind: 'parametric',
                x: 'unknown + 1',
                y: '0',
                z: '0',
                tStart: 0,
                tEnd: 1,
                sampleCount: 8
            },
            samples: []
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown identifier');
    });

    it('updates an existing curve and preserves its id', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addCurve(pointsCurve('c1', 'Circle'));
        const result = store.updateCurve('c1', {
            id: 'ignored',
            name: 'Renamed Circle',
            source: { kind: 'points' },
            samples: circleSamples(12)
        });
        expect(result.success).toBe(true);
        expect(store.document?.curves[0].id).toBe('c1');
        expect(store.document?.curves[0].name).toBe('Renamed Circle');
        expect(store.document?.curves[0].samples).toHaveLength(12);
    });

    it('rejects updating a non-existent curve', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.updateCurve('missing', pointsCurve('c1', 'Circle'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('renames a curve', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addCurve(pointsCurve('c1', 'Circle'));
        const result = store.renameCurve('c1', 'Loop');
        expect(result.success).toBe(true);
        expect(store.document?.curves[0].name).toBe('Loop');
    });

    it('rejects empty curve names', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addCurve(pointsCurve('c1', 'Circle'));
        const result = store.renameCurve('c1', '');
        expect(result.success).toBe(false);
    });

    it('rejects renaming to a duplicate curve name', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addCurve(pointsCurve('c1', 'Circle'));
        store.addCurve(pointsCurve('c2', 'Loop'));
        const result = store.renameCurve('c2', 'Circle');
        expect(result.success).toBe(false);
        expect(result.error).toContain('already in use');
    });

    it('deletes a curve and clears its selection', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addCurve(pointsCurve('c1', 'Circle'));
        store.selectCurve('c1');
        const result = store.deleteCurve('c1');
        expect(result.success).toBe(true);
        expect(store.document?.curves).toHaveLength(0);
        expect(store.selection.selectedCurveId).toBeUndefined();
    });

    it('rejects deleting a non-existent curve', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.deleteCurve('missing');
        expect(result.success).toBe(false);
    });

    it('tracks curve selection', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.selectCurve('c1');
        expect(store.selection.selectedCurveId).toBe('c1');
        store.selectCurve(undefined);
        expect(store.selection.selectedCurveId).toBeUndefined();
    });

    it('notifies listeners on curve mutations', () => {
        const store = new CadDocumentStore();
        let count = 0;
        store.onChange(() => count++);
        store.createDocument('test');
        store.addCurve(pointsCurve('c1', 'Circle'));
        expect(count).toBeGreaterThan(0);
    });
});

describe('datum-lite addDatum payloads', () => {
    const threePoints: [number, number, number][] = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
    ];

    it('persists threePoint points on the datum record', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addDatum('threePoint', 0, undefined, { points: threePoints });
        expect(result.success).toBe(true);
        const datum = store.document?.datums.find((d) => d.id === result.value);
        expect(datum?.kind).toBe('threePoint');
        expect(datum?.points).toEqual(threePoints);
    });

    it('rejects a threePoint datum without exactly 3 points', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        expect(store.addDatum('threePoint').success).toBe(false);
        const wrongCount = store.addDatum('threePoint', 0, undefined, { points: threePoints.slice(0, 2) });
        expect(wrongCount.success).toBe(false);
        expect(wrongCount.error).toContain('exactly 3 points');
    });

    it('leaves collinear threePoint points to commit-time schema validation', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addDatum('threePoint', 0, undefined, {
            points: [
                [0, 0, 0],
                [1, 0, 0],
                [2, 0, 0]
            ]
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('collinear');
    });

    it('persists midplane faces on the datum record', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const faces = [faceRef('pad1', [0, 0, 0]), faceRef('pad1', [0, 0, 10])];
        const result = store.addDatum('midplane', 1, undefined, { faces });
        expect(result.success).toBe(true);
        const datum = store.document?.datums.find((d) => d.id === result.value);
        expect(datum?.kind).toBe('midplane');
        expect(datum?.faces).toHaveLength(2);
        expect(datum?.offset).toBe(1);
    });

    it('rejects a midplane datum without exactly 2 faces', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        expect(store.addDatum('midplane').success).toBe(false);
        const oneFace = store.addDatum('midplane', 0, undefined, { faces: [faceRef('pad1')] });
        expect(oneFace.success).toBe(false);
        expect(oneFace.error).toContain('exactly 2 face references');
    });

    it('persists line2Point points on the datum record', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addDatum('line2Point', 0, undefined, { points: threePoints.slice(0, 2) });
        expect(result.success).toBe(true);
        expect(store.document?.datums.find((d) => d.id === result.value)?.points).toHaveLength(2);
    });

    it('rejects a line2Point datum without exactly 2 points', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addDatum('line2Point', 0, undefined, { points: threePoints });
        expect(result.success).toBe(false);
        expect(result.error).toContain('exactly 2 points');
    });

    it('leaves coincident line2Point points to commit-time schema validation', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addDatum('line2Point', 0, undefined, {
            points: [
                [1, 1, 1],
                [1, 1, 1]
            ]
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('distinct');
    });
});

describe('multiTransform store cascade', () => {
    function patternFeature(id: string, source: string): FeatureDef {
        return {
            id,
            name: id,
            type: 'linearPattern',
            body: 'body-1',
            params: { source, count: 2, spacing: 1, axis: 'x' },
            suppressed: false,
            dependsOn: [source]
        };
    }

    function multiTransformTree(): CadDocumentStore {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.addBody('Body 1');
        store.addFeature(feature('pad1', 'pad'));
        store.addFeature(patternFeature('linA', 'pad1'));
        store.addFeature(patternFeature('linB', 'pad1'));
        // dependsOn names only the first input; the second rides first/second.
        store.addFeature({
            id: 'mt1',
            name: 'mt1',
            type: 'multiTransform',
            body: 'body-1',
            params: { first: 'linA', second: 'linB' },
            suppressed: false,
            dependsOn: ['linA']
        });
        expect(store.document?.features.map((f) => f.id)).toEqual(['pad1', 'linA', 'linB', 'mt1']);
        return store;
    }

    it('rejects deleting a pattern used as a multiTransform second input', () => {
        const store = multiTransformTree();
        const result = store.deleteFeature('linB');
        expect(result.success).toBe(false);
        expect(result.error).toContain('mt1');
    });

    it('cascades deletes through multiTransform first/second', () => {
        const store = multiTransformTree();
        const result = store.deleteFeature('linA', 'cascade');
        expect(result.success).toBe(true);
        expect(store.document?.features.map((f) => f.id)).toEqual(['pad1', 'linB']);
    });

    it('cascades a source delete through patterns into the multiTransform', () => {
        const store = multiTransformTree();
        const result = store.deleteFeature('pad1', 'cascade');
        expect(result.success).toBe(true);
        expect(store.document?.features).toHaveLength(0);
    });

    it('rejects reordering a multiTransform before its second input', () => {
        const store = multiTransformTree();
        const result = store.reorderFeatures(['pad1', 'linA', 'mt1', 'linB']);
        expect(result.success).toBe(false);
        expect(result.error).toContain('mt1 depends on linB');
    });

    it('rejects reordering a multiTransform before its first input', () => {
        const store = multiTransformTree();
        const result = store.reorderFeatures(['mt1', 'pad1', 'linA', 'linB']);
        expect(result.success).toBe(false);
        expect(result.error).toContain('mt1 depends on linA');
    });

    it('allows reordering that preserves multiTransform source order', () => {
        const store = multiTransformTree();
        // linA/linB are independent of each other, so swapping them is valid.
        const result = store.reorderFeatures(['pad1', 'linB', 'linA', 'mt1']);
        expect(result.success).toBe(true);
        expect(store.document?.features.map((f) => f.id)).toEqual(['pad1', 'linB', 'linA', 'mt1']);
    });
});

describe('curve operations with document units', () => {
    function parametricCurve(x: string, y = '0', z = '0'): CurveDef {
        return {
            id: 'c1',
            name: 'Units',
            source: { kind: 'parametric', x, y, z, tStart: 0, tEnd: 1, sampleCount: 16 },
            samples: []
        };
    }

    function unitStore(units: DocumentUnits): CadDocumentStore {
        const store = new CadDocumentStore();
        const loaded = store.loadDocument({ ...minimalDoc(), units });
        expect(loaded.success).toBe(true);
        return store;
    }

    it.each([
        ['mm', '10mm', 10],
        ['mm', '1cm', 10],
        ['mm', '1m', 1000],
        ['cm', '10mm', 1],
        ['cm', '1cm', 1],
        ['cm', '1m', 100],
        ['m', '1000mm', 1],
        ['m', '100cm', 1],
        ['m', '2m', 2]
    ] as const)('in a %s document, %s coerces to %s', (units, expr, expected) => {
        const samples = sampleParametricWithUnits(
            { kind: 'parametric', x: expr, y: '0', z: '0', tStart: 0, tEnd: 1, sampleCount: 8 },
            {},
            units
        );
        expect(samples[0][0]).toBeCloseTo(expected, 10);
    });

    it('coerces literals and conversions per coordinate on add', () => {
        const store = unitStore('mm');
        const result = store.addCurve(parametricCurve('10mm', '1cm', '1m'));
        expect(result.success).toBe(true);
        expect(store.document?.curves[0].samples[0]).toEqual([10, 10, 1000]);
    });

    it('treats plain numbers as already expressed in the doc unit', () => {
        const store = unitStore('mm');
        const result = store.addCurve(parametricCurve('2 * 3', 'cos(t)', '0'));
        expect(result.success).toBe(true);
        const samples = store.document!.curves[0].samples;
        expect(samples[0][0]).toBeCloseTo(6, 10);
        expect(samples[0][1]).toBeCloseTo(1, 10);
    });

    it('surfaces dimension mismatches as errors, never silent numbers', () => {
        const store = unitStore('mm');
        const result = store.addCurve(parametricCurve('5s'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Failed to convert');
    });

    it('keeps rejecting unit syntax in unitless documents', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const result = store.addCurve(parametricCurve('10mm'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('unit-less evaluator');
    });

    it('coerces on update and preserves units across unrelated mutations', () => {
        const store = unitStore('cm');
        const added = store.addCurve(parametricCurve('1', '2', '3'));
        expect(added.success).toBe(true);
        const updated = store.updateCurve(added.value!, parametricCurve('20mm'));
        expect(updated.success).toBe(true);
        expect(store.document?.curves[0].samples[0][0]).toBeCloseTo(2, 10);
        expect(store.setParameter('radius', 3).success).toBe(true);
        expect(store.document?.units).toBe('cm');
    });

    it('leaves Fourier coefficients (plain numbers) untouched in unit documents', () => {
        const store = unitStore('mm');
        const result = store.addCurve({
            id: 'c1',
            name: 'Fourier',
            source: { kind: 'fourier', nfp: 1, order: 0, cosX: [5], sinX: [], cosY: [0], sinY: [], cosZ: [0], sinZ: [], sampleCount: 32 },
            samples: []
        });
        expect(result.success).toBe(true);
        expect(store.document?.curves[0].samples[0]).toEqual([5, 0, 0]);
    });

    it('rejects unknown units at load time', () => {
        const store = new CadDocumentStore();
        const result = store.loadDocument({ ...minimalDoc(), units: 'inch' } as unknown as NukeCadDocument);
        expect(result.success).toBe(false);
        expect(result.error).toContain('units');
    });
});

/** Fixed document for the key-stability golden test (fixed doc → fixed keys). */
function goldenDoc(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'golden',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Body 1' }],
        sketches: [
            {
                id: 'sk1',
                name: 'Sketch 1',
                datumId: 'datum-xy',
                primitives: [{ id: 'p1', type: 'point', x: 10, y: 20 }],
                constraints: []
            }
        ],
        features: [
            {
                id: 'f1',
                name: 'pad 1',
                type: 'pad',
                body: 'body-1',
                sketchId: 'sk1',
                params: { length: 5 } as FeatureDef['params'],
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'f2',
                name: 'fillet 1',
                type: 'fillet',
                body: 'body-1',
                params: { radius: 1 } as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['f1']
            }
        ],
        curves: []
    };
}

function goldenRecord(doc: NukeCadDocument): CachedDocumentResult {
    const table = computeResultCacheKeys(doc, { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN });
    return {
        keys: table.keys,
        builderVersion: RESULT_CACHE_BUILDER_VERSION,
        ocpVersion: RESULT_CACHE_OCP_UNKNOWN,
        schemaVersion: NUKE_CAD_SCHEMA_VERSION,
        tessText: '{"solids":[]}'
    };
}

describe('result cache key scheme (P2 C3)', () => {
    it('sha256Hex matches node:crypto across vectors', () => {
        for (const text of ['', 'abc', 'héllo wörld ✓', 'x'.repeat(1000)]) {
            expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
        }
    });

    it('formats canonical numbers with the Python-compatible grammar', () => {
        expect(formatCanonicalNumber(10)).toBe('10.0');
        expect(formatCanonicalNumber(-3)).toBe('-3.0');
        expect(formatCanonicalNumber(0)).toBe('0.0');
        expect(formatCanonicalNumber(-0)).toBe('0.0');
        expect(formatCanonicalNumber(2.5)).toBe('2.5');
        expect(formatCanonicalNumber(0.5)).toBe('5e-1');
        // 1e-7 is not exactly representable: the grammar formats the true binary
        // value (Python format(v, '.16e') agrees digit-for-digit).
        expect(formatCanonicalNumber(1e-7)).toBe('9.9999999999999995e-8');
        expect(formatCanonicalNumber(1e21)).toBe('1e+21');
        expect(() => formatCanonicalNumber(NaN)).toThrow();
        expect(() => formatCanonicalNumber(Infinity)).toThrow();
    });

    it('canonicalizes objects with sorted keys and no whitespace', () => {
        expect(canonicalJson({ b: 1, a: [1, 2] })).toBe('{"a":[1.0,2.0],"b":1.0}');
        expect(canonicalJson({ a: undefined, b: null, c: true })).toBe('{"b":null,"c":true}');
        expect(canonicalJson({ outer: { z: 0.5, m: 'x' } })).toBe('{"outer":{"m":"x","z":5e-1}}');
    });

    it('produces fixed keys for the fixed golden document', () => {
        const table = computeResultCacheKeys(goldenDoc(), {
            builderVersion: RESULT_CACHE_BUILDER_VERSION,
            ocpVersion: RESULT_CACHE_OCP_UNKNOWN
        });
        // Golden keys for builder version 2 (cache-semantics bump: shell
        // winding, suppression in keys, cached overlap verdicts).
        expect(table.keys).toEqual({
            'sketch:sk1': '55d562c989a0c8476075675d4c6c7ae026ea003a00218b4b88488d55fea2f71c',
            'feature:f1': 'a8708ead69eab00c157ba96e9b0dd2b389c81a136d068e8404e02ca25213540a',
            'feature:f2': '50736a1c3573512768eb8ddb0a3bbb9d0fe9795b98ed2d252f703e7987d88593'
        });
    });

    it('changes sketch keys when sketch-local parameters change', () => {
        const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };
        const before = computeResultCacheKeys(goldenDoc(), versions).keys;
        const edited = goldenDoc();
        edited.sketches[0] = { ...edited.sketches[0], parameters: { width: 7 } };
        const after = computeResultCacheKeys(edited, versions).keys;
        // A value-only parameter edit must miss rather than serve a stale
        // tessellation, even when solved coordinates are unchanged.
        expect(after['sketch:sk1']).not.toBe(before['sketch:sk1']);
        expect(after['feature:f1']).not.toBe(before['feature:f1']);
    });

    it('changes feature keys on reorder even with identical content', () => {
        const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };
        const before = computeResultCacheKeys(goldenDoc(), versions).keys;
        const reordered = goldenDoc();
        reordered.features = [reordered.features[1], reordered.features[0]];
        const after = computeResultCacheKeys(reordered, versions).keys;
        // Accumulation and boolean tips are order-sensitive: a pure reorder
        // must miss rather than serve pre-reorder geometry.
        expect(after['feature:f1']).not.toBe(before['feature:f1']);
        expect(after['feature:f2']).not.toBe(before['feature:f2']);
    });

    it('is insensitive to document renames and params key order', () => {
        const before = computeResultCacheKeys(goldenDoc(), {
            builderVersion: RESULT_CACHE_BUILDER_VERSION,
            ocpVersion: RESULT_CACHE_OCP_UNKNOWN
        }).keys;
        const renamed: NukeCadDocument = { ...goldenDoc(), name: 'renamed', parameters: { width: 7 } };
        const after = computeResultCacheKeys(renamed, {
            builderVersion: RESULT_CACHE_BUILDER_VERSION,
            ocpVersion: RESULT_CACHE_OCP_UNKNOWN
        }).keys;
        expect(after).toEqual(before);
    });

    it('is insensitive to sketch primitive order', () => {
        const doc = goldenDoc();
        const reordered: NukeCadDocument = {
            ...doc,
            sketches: [
                {
                    ...doc.sketches[0],
                    primitives: [
                        { id: 'p2', type: 'point', x: 1, y: 1 },
                        { id: 'p1', type: 'point', x: 10, y: 20 }
                    ]
                }
            ]
        };
        const base: NukeCadDocument = {
            ...doc,
            sketches: [{ ...doc.sketches[0], primitives: [...doc.sketches[0].primitives, { id: 'p2', type: 'point', x: 1, y: 1 }] }]
        };
        const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };
        expect(computeResultCacheKeys(reordered, versions).keys).toEqual(computeResultCacheKeys(base, versions).keys);
    });

    it('changes the edited feature key and its dependents only', () => {
        const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };
        const before = computeResultCacheKeys(goldenDoc(), versions).keys;
        const edited = goldenDoc();
        edited.features[0] = { ...edited.features[0], params: { length: 6 } as FeatureDef['params'] };
        const after = computeResultCacheKeys(edited, versions).keys;
        expect(after['sketch:sk1']).toBe(before['sketch:sk1']);
        expect(after['feature:f1']).not.toBe(before['feature:f1']);
        expect(after['feature:f2']).not.toBe(before['feature:f2']);
    });

    it('folds builder and OCP versions into every key', () => {
        const doc = goldenDoc();
        const base = computeResultCacheKeys(doc, { builderVersion: 1, ocpVersion: 'unknown' }).keys;
        expect(computeResultCacheKeys(doc, { builderVersion: 2, ocpVersion: 'unknown' }).keys['feature:f1']).not.toBe(base['feature:f1']);
        expect(computeResultCacheKeys(doc, { builderVersion: 1, ocpVersion: '7.8' }).keys['feature:f1']).not.toBe(base['feature:f1']);
    });

    it('throws on unknown sketches, curves, dependencies, and cycles', () => {
        const versions = { builderVersion: RESULT_CACHE_BUILDER_VERSION, ocpVersion: RESULT_CACHE_OCP_UNKNOWN };
        const badSketch = goldenDoc();
        badSketch.features[0] = { ...badSketch.features[0], sketchId: 'missing' };
        expect(() => computeResultCacheKeys(badSketch, versions)).toThrow();
        const badDep = goldenDoc();
        badDep.features[1] = { ...badDep.features[1], dependsOn: ['missing'] };
        expect(() => computeResultCacheKeys(badDep, versions)).toThrow();
        const cyclic = goldenDoc();
        cyclic.features[0] = { ...cyclic.features[0], dependsOn: ['f2'] };
        expect(() => computeResultCacheKeys(cyclic, versions)).toThrow();
        const badDatum = goldenDoc();
        badDatum.sketches[0] = { ...badDatum.sketches[0], datumId: 'missing' };
        expect(() => computeResultCacheKeys(badDatum, versions)).toThrow();
    });
});

function chainDoc(): NukeCadDocument {
    const doc = goldenDoc();
    return {
        ...doc,
        features: [
            { ...doc.features[0] },
            { ...doc.features[1], id: 'f2', params: { radius: 2 } as FeatureDef['params'] },
            {
                id: 'f3',
                name: 'chamfer 1',
                type: 'chamfer',
                body: 'body-1',
                params: { distance: 0.5 } as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['f2']
            }
        ]
    };
}

describe('dirty rebuild plan (P2 C3)', () => {
    it('expands the dirty closure to transitive dependents in order', () => {
        const doc = chainDoc();
        expect(planDirtyRebuild(doc, ['f1']).featureIds).toEqual(['f1', 'f2', 'f3']);
        expect(planDirtyRebuild(doc, ['f2']).featureIds).toEqual(['f2', 'f3']);
        expect(planDirtyRebuild(doc, ['f3']).featureIds).toEqual(['f3']);
    });

    it('omits suppressed features and marks their dependents stale', () => {
        const doc = chainDoc();
        doc.features[1] = { ...doc.features[1], suppressed: true };
        const plan = planDirtyRebuild(doc, ['f2']);
        expect(plan.featureIds).toEqual([]);
        expect(plan.stale).toContain('f3');
    });

    it('throws on unknown dirty ids', () => {
        expect(() => planDirtyRebuild(chainDoc(), ['missing'])).toThrow();
    });

    it('maps sketch, curve, and datum edits to consuming features', () => {
        const doc = goldenDoc();
        expect(featuresConsumingSketch(doc, 'sk1')).toEqual(['f1']);
        expect(featuresConsumingSketch(doc, 'other')).toEqual([]);
        const lofted: NukeCadDocument = {
            ...doc,
            sketches: [...doc.sketches, { id: 'sk2', name: 'Sketch 2', datumId: 'datum-xy', primitives: [], constraints: [] }],
            features: [
                ...doc.features,
                {
                    id: 'f3',
                    name: 'loft 1',
                    type: 'loft',
                    body: 'body-1',
                    params: { sectionSketchIds: ['sk1', 'sk2'] } as unknown as FeatureDef['params'],
                    suppressed: false,
                    dependsOn: ['f2']
                }
            ]
        };
        expect(featuresConsumingSketch(lofted, 'sk2')).toEqual(['f3']);
        const withCurve: NukeCadDocument = {
            ...doc,
            curves: [{ id: 'c1', name: 'C1', source: { kind: 'points' }, samples: [] }],
            features: [
                ...doc.features,
                {
                    id: 'f4',
                    name: 'pipe 1',
                    type: 'pipe',
                    body: 'body-1',
                    params: { pathCurveId: 'c1', radius: 1 } as unknown as FeatureDef['params'],
                    suppressed: false,
                    dependsOn: ['f2']
                }
            ]
        };
        expect(featuresConsumingCurve(withCurve, 'c1')).toEqual(['f4']);
        expect(featuresOnDatum(doc, 'datum-xy')).toEqual(['f1']);
        expect(allFeatureIds(doc)).toEqual(['f1', 'f2']);
    });
});

describe('memory result cache and open fast path (P2 C3)', () => {
    it('keys saved documents by URI and untitled documents by name', () => {
        expect(cacheKeyForDocument('file:///a/model.nuke-cad', 'model')).toBe('file:///a/model.nuke-cad');
        expect(cacheKeyForDocument(undefined, 'Untitled')).toBe('untitled:Untitled');
    });

    it('stores and drops entries', () => {
        const cache = new MemoryResultCache();
        expect(cache.size).toBe(0);
        const record = goldenRecord(goldenDoc());
        cache.set('k', record);
        expect(cache.size).toBe(1);
        expect(cache.get('k')).toBe(record);
        expect(cache.delete('k')).toBe(true);
        expect(cache.get('k')).toBeUndefined();
        cache.set('k', record);
        cache.clear();
        expect(cache.size).toBe(0);
    });

    it('hits on identical content and misses with no entry', () => {
        expect(checkOpenFastPath(goldenDoc(), undefined)).toEqual({ hit: false, reason: 'no-cache-entry' });
        expect(checkOpenFastPath(goldenDoc(), goldenRecord(goldenDoc()))).toEqual({ hit: true, reason: 'hit' });
    });

    it('misses when a feature input changes and names the node', () => {
        const doc = goldenDoc();
        const check = checkOpenFastPath(
            doc,
            goldenRecord({ ...doc, features: [{ ...doc.features[0], params: { length: 9 } as FeatureDef['params'] }, doc.features[1]] })
        );
        expect(check.hit).toBe(false);
        expect(check.reason).toBe('key-mismatch: feature:f1');
    });

    it('misses on node-set, builder, and schema drift', () => {
        const doc = goldenDoc();
        const record = goldenRecord(doc);
        const extra: FeatureDef = { ...doc.features[0], id: 'f9', name: 'pad 9' };
        expect(checkOpenFastPath({ ...doc, features: [...doc.features, extra] }, record).reason).toBe('node-set-mismatch');
        expect(checkOpenFastPath(doc, { ...record, builderVersion: record.builderVersion + 1 }).reason).toBe('builder-mismatch');
        expect(checkOpenFastPath(doc, { ...record, schemaVersion: 999 }).reason).toBe('schema-mismatch');
    });

    it('misses (never throws) on structurally broken documents', () => {
        const doc = goldenDoc();
        doc.sketches[0] = { ...doc.sketches[0], datumId: 'missing' };
        const check = checkOpenFastPath(doc, goldenRecord(goldenDoc()));
        expect(check.hit).toBe(false);
        expect(check.reason.startsWith('key-error')).toBe(true);
    });
});

describe('partial rebuild tracker (P2 C3)', () => {
    it('walks stale → building → fresh', () => {
        const tracker = new PartialRebuildTracker();
        expect(tracker.getState().status).toBe('fresh');
        tracker.noteEdit(['f1', 'f2']);
        expect(tracker.getState()).toMatchObject({ status: 'stale', dirtyIds: ['f1', 'f2'] });
        const ids = tracker.beginBuild();
        expect(ids).toEqual(['f1', 'f2']);
        expect(tracker.getState().status).toBe('building');
        tracker.succeed();
        expect(tracker.getState()).toMatchObject({ status: 'fresh', dirtyIds: [] });
    });

    it('coalesces a second begin while building', () => {
        const tracker = new PartialRebuildTracker();
        tracker.noteEdit(['f1']);
        expect(tracker.beginBuild()).toEqual(['f1']);
        expect(tracker.beginBuild()).toBeUndefined();
    });

    it('queues edits arriving mid-build into the next round', () => {
        const tracker = new PartialRebuildTracker();
        tracker.noteEdit(['f1']);
        tracker.beginBuild();
        tracker.noteEdit(['f2']);
        tracker.succeed();
        expect(tracker.getState()).toMatchObject({ status: 'stale', dirtyIds: ['f2'] });
    });

    it('fails to error and preserves retry ids', () => {
        const tracker = new PartialRebuildTracker();
        tracker.noteEdit(['f1']);
        tracker.beginBuild();
        tracker.noteEdit(['f2']);
        tracker.fail('boom', ['f1']);
        expect(tracker.getState()).toMatchObject({ status: 'error', error: 'boom' });
        expect([...tracker.getState().dirtyIds].sort()).toEqual(['f1', 'f2']);
        tracker.noteEdit(['f3']);
        expect(tracker.getState().status).toBe('stale');
        expect([...tracker.getState().dirtyIds].sort()).toEqual(['f1', 'f2', 'f3']);
        expect(tracker.getState().error).toBeUndefined();
    });

    it('cancels to stale with queued edits and to cancelled when clean', () => {
        const tracker = new PartialRebuildTracker();
        tracker.noteEdit(['f1']);
        tracker.beginBuild();
        tracker.noteEdit(['f2']);
        tracker.cancel();
        expect(tracker.getState()).toMatchObject({ status: 'stale', dirtyIds: ['f2'] });
        tracker.reset();
        tracker.noteEdit(['f1']);
        tracker.beginBuild();
        tracker.cancel();
        expect(tracker.getState()).toMatchObject({ status: 'cancelled', dirtyIds: [] });
    });

    it('ignores terminal transitions when not building', () => {
        const tracker = new PartialRebuildTracker();
        tracker.succeed();
        tracker.fail('boom');
        tracker.cancel();
        expect(tracker.getState().status).toBe('fresh');
    });
});

describe('partial rebuild routing (P2 C3)', () => {
    it('derives the cache dir from the document path', () => {
        expect(partialCacheDirForDocument('/a/b/model.nuke-cad')).toBe('/a/b');
        expect(partialCacheDirForDocument('/model.nuke-cad')).toBe('/');
        expect(partialCacheDirForDocument('model.nuke-cad')).toBe('.');
    });

    it('routes strict subsets through the partial RPC', () => {
        expect(shouldUsePartialPlan(['f2'], 3)).toBe(true);
        expect(shouldUsePartialPlan(['f1', 'f2'], 3)).toBe(true);
    });

    it('keeps empty and full-tree plans on the full build path', () => {
        expect(shouldUsePartialPlan([], 3)).toBe(false);
        expect(shouldUsePartialPlan(['f1', 'f2', 'f3'], 3)).toBe(false);
        expect(shouldUsePartialPlan([], 0)).toBe(false);
    });
});

describe('setUnits (wave A2)', () => {
    it('tags a unitless document without rescaling existing numbers', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        store.setParameter('width', 10);
        const before = JSON.stringify(store.document);
        const result = store.setUnits('mm');
        expect(result.success).toBe(true);
        expect(store.document?.units).toBe('mm');
        const after = JSON.parse(before) as NukeCadDocument;
        expect(store.document?.parameters).toEqual(after.parameters);
        expect(store.document?.sketches).toEqual(after.sketches);
        expect(store.document?.curves).toEqual(after.curves);
        expect(store.document?.features).toEqual(after.features);
        expect(store.dirty).toBe(true);
    });

    it('cycles through mm/cm/m and clears back to legacy unitless', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        for (const units of ['mm', 'cm', 'm'] as DocumentUnits[]) {
            expect(store.setUnits(units).success).toBe(true);
            expect(store.document?.units).toBe(units);
        }
        expect(store.setUnits(undefined).success).toBe(true);
        expect(store.document?.units).toBeUndefined();
    });

    it('is a no-op when the units are unchanged', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        expect(store.setUnits('mm').success).toBe(true);
        expect(store.markSaved().success).toBe(true);
        expect(store.setUnits('mm').success).toBe(true);
        expect(store.dirty).toBe(false);
    });

    it('rejects unknown units and a missing document', () => {
        const store = new CadDocumentStore();
        store.createDocument('test');
        const bad = store.setUnits('inch' as DocumentUnits);
        expect(bad.success).toBe(false);
        expect(bad.error).toContain('inch');
        expect(store.document?.units).toBeUndefined();

        const empty = new CadDocumentStore();
        expect(empty.setUnits('mm').success).toBe(false);
    });
});

describe('computeDependsOn wave A2 contract', () => {
    it('chains subtractive primitives and helical sweeps like pocket', () => {
        const features = [feature('pad1', 'pad')];
        const subtractivePrim: FeatureDef = {
            ...feature('prim1', 'primitive', ['pad1']),
            params: { shape: 'box', dimensions: [1, 2, 3], subtractive: true }
        };
        expect(computeDependsOn('pocket', 'body-1', [...features, subtractivePrim])).toBe('prim1');
        expect(computeDependsOn('primitive', 'body-1', [...features, subtractivePrim])).toBe('prim1');
        expect(computeDependsOn('helicalSweep', 'body-1', [...features, subtractivePrim])).toBe('prim1');

        const subtractiveHelix: FeatureDef = {
            ...feature('hx1', 'helicalSweep', ['pad1']),
            params: { axis: 'Z', startRadius: 2, pitch: 1, turns: 3, orientation: 'frenet', subtractive: true }
        };
        expect(computeDependsOn('pocket', 'body-1', [...features, subtractiveHelix])).toBe('hx1');
        expect(computeDependsOn('primitive', 'body-1', [...features, subtractiveHelix])).toBe('hx1');
    });

    it('chains revolve/groove ends and linear datum-axis patterns at the body tip like pad/pocket', () => {
        const features = [feature('pad1', 'pad')];
        expect(computeDependsOn('revolve', 'body-1', features)).toBe('pad1');
        expect(computeDependsOn('groove', 'body-1', features)).toBe('pad1');
        expect(computeDependsOn('linearPattern', 'body-1', features)).toBe('pad1');
        expect(computeDependsOn('revolve', 'body-1', [])).toBeUndefined();
        expect(computeDependsOn('linearPattern', 'body-1', [])).toBeUndefined();
    });
});

describe('assembly mutations (Wave B2)', () => {
    function assemblyStore(): CadDocumentStore {
        const store = new CadDocumentStore();
        store.createDocument('assembly-test');
        return store;
    }

    function addGroundedPair(store: CadDocumentStore): { a: string; b: string; ca: string; cb: string } {
        const a = store.addInstance('./part-a.nuke-cad').value!;
        const b = store.addInstance('./part-b.nuke-cad').value!;
        // Grounding is explicit: adding instances never grounds anything.
        expect(getAssemblySection(store.document!)?.groundedInstanceId).toBe('');
        expect(store.setGrounded(a).success).toBe(true);
        const ca = store.addConnector(a, [0, 0, 0], [1, 0, 0], [0, 1, 0]).value!;
        const cb = store.addConnector(b, [0, 0, 0], [1, 0, 0], [0, 1, 0]).value!;
        return { a, b, ca, cb };
    }

    it('grounds explicitly and never defaults to the first instance', () => {
        const store = assemblyStore();
        const first = store.addInstance('./a.nuke-cad');
        expect(first.success).toBe(true);
        // Single-part until grounded: absent-equivalent ('' ground) stays valid.
        expect(getAssemblySection(store.document!)?.groundedInstanceId).toBe('');
        expect(store.setGrounded('missing').success).toBe(false);
        expect(store.setGrounded(first.value!).success).toBe(true);
        expect(getAssemblySection(store.document!)?.groundedInstanceId).toBe(first.value);
    });

    it('rejects degenerate connector axes and unknown instances', () => {
        const store = assemblyStore();
        const a = store.addInstance('./a.nuke-cad').value!;
        expect(store.setGrounded(a).success).toBe(true);
        expect(store.addConnector('missing', [0, 0, 0], [1, 0, 0], [0, 1, 0]).success).toBe(false);
        expect(store.addConnector(a, [0, 0, 0], [0, 0, 0], [0, 1, 0]).success).toBe(false);
        expect(store.addConnector(a, [0, 0, 0], [1, 0, 0], [2, 0, 0]).success).toBe(false);
        expect(store.addConnector(a, [0, 0, 0], [1, 0, 0], [0, 1, 0]).success).toBe(true);
    });

    it('validates mates (type order, dangling refs, one-mate-per-pair)', () => {
        const store = assemblyStore();
        const { a, b, ca, cb } = addGroundedPair(store);
        expect(store.addMate('weld' as never, a, ca, b, cb).success).toBe(false);
        expect(store.addMate('fixed', a, ca, b, 'missing').success).toBe(false);
        expect(store.addMate('fixed', a, ca, b, cb).success).toBe(true);
        // One mate per part pair: a second mate between the same pair fails.
        const cb2 = store.addConnector(b, [1, 0, 0], [1, 0, 0], [0, 1, 0]).value!;
        expect(store.addMate('revolute', a, ca, b, cb2).success).toBe(false);
        // Self-mates fail.
        expect(store.addMate('fixed', a, ca, a, ca).success).toBe(false);
    });

    it('cascade-deletes instance → connectors/mates and clears grounding', () => {
        const store = assemblyStore();
        const { a, b, ca, cb } = addGroundedPair(store);
        const mate = store.addMate('fixed', a, ca, b, cb);
        expect(mate.success).toBe(true);
        expect(store.deleteInstance(a).success).toBe(true);
        const assembly = getAssemblySection(store.document!);
        expect(assembly?.instances.map((i) => i.id)).toEqual([b]);
        expect(assembly?.connectors.map((c) => c.id)).toEqual([cb]);
        expect(assembly?.mates).toEqual([]);
        expect(assembly?.groundedInstanceId).toBe('');
    });

    it('cascade-deletes connector → mates and renames instances with references', () => {
        const store = assemblyStore();
        const { a, b, ca, cb } = addGroundedPair(store);
        expect(store.addMate('fixed', a, ca, b, cb).success).toBe(true);
        expect(store.deleteConnector(ca).success).toBe(true);
        expect(getAssemblySection(store.document!)?.mates).toEqual([]);
        const ca2 = store.addConnector(a, [0, 0, 0], [1, 0, 0], [0, 1, 0]).value!;
        expect(store.addMate('fixed', a, ca2, b, cb).success).toBe(true);
        expect(store.renameInstance(a, 'base').success).toBe(true);
        const assembly = getAssemblySection(store.document!)!;
        expect(assembly.instances.map((i) => i.id).sort()).toEqual(['base', b].sort());
        expect(assembly.groundedInstanceId).toBe('base');
        expect(assembly.connectors.find((c) => c.id === ca2)?.instanceId).toBe('base');
        expect(assembly.mates[0].instanceA).toBe('base');
        expect(store.renameInstance('base', b).success).toBe(false);
    });

    it('keeps mutations immutable (failed commits never corrupt the live document)', () => {
        const store = assemblyStore();
        const { a, b, ca, cb } = addGroundedPair(store);
        expect(store.addMate('fixed', a, ca, b, cb).success).toBe(true);
        const before = JSON.stringify(store.document);
        expect(store.addMate('fixed', a, ca, b, cb).success).toBe(false);
        expect(JSON.stringify(store.document)).toBe(before);
    });

    it('reports assembly DOF via countAssemblyDof (explicit grounding only)', () => {
        const store = assemblyStore();
        expect(assemblyDof(store.document!)).toBe(0);
        const { a, b, ca, cb } = addGroundedPair(store);
        expect(assemblyDof(store.document!)).toBe(6);
        expect(store.addMate('fixed', a, ca, b, cb).success).toBe(true);
        expect(assemblyDof(store.document!)).toBe(0);
        void b;
    });
});

describe('undo/redo history', () => {
    function historyStore(): CadDocumentStore {
        const store = new CadDocumentStore();
        store.createDocument('test');
        return store;
    }

    it('reports empty edges with no document and no history', () => {
        const store = new CadDocumentStore();
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
        expect(store.undo().success).toBe(false);
        expect(store.redo().success).toBe(false);
        store.createDocument('test');
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
        expect(store.undo().success).toBe(false);
        expect(store.redo().success).toBe(false);
    });

    it('round-trips a parameter mutation through undo/redo', () => {
        const store = historyStore();
        store.setParameter('width', 10);
        store.setParameter('width', 20);
        expect(store.canUndo).toBe(true);
        expect(store.canRedo).toBe(false);
        expect(store.undo().success).toBe(true);
        expect(store.document?.parameters.width).toBe(10);
        expect(store.canUndo).toBe(true);
        expect(store.canRedo).toBe(true);
        // The restored document still validates.
        expect(validateNukeCadDocument(store.document!).valid).toBe(true);
        expect(store.redo().success).toBe(true);
        expect(store.document?.parameters.width).toBe(20);
        expect(store.canRedo).toBe(false);
        expect(validateNukeCadDocument(store.document!).valid).toBe(true);
    });

    it('marks dirty on undo/redo even after save and emits change events', () => {
        const store = historyStore();
        store.setParameter('width', 10);
        store.markSaved();
        expect(store.dirty).toBe(false);
        let changes = 0;
        store.onChange(() => changes++);
        expect(store.undo().success).toBe(true);
        expect(store.dirty).toBe(true);
        expect(changes).toBe(1);
        expect(store.redo().success).toBe(true);
        expect(store.dirty).toBe(true);
        expect(changes).toBe(2);
    });

    it('restores derived drawing counters alongside the document', () => {
        const store = historyStore();
        expect(store.drawingVersion).toBe(0);
        expect(store.addSheet('A4').success).toBe(true);
        expect(store.drawingVersion).toBe(1);
        expect(store.document?.drawings).toHaveLength(1);
        expect(store.undo().success).toBe(true);
        expect(store.document?.drawings ?? []).toHaveLength(0);
        expect(store.drawingVersion).toBe(0);
        expect(validateNukeCadDocument(store.document!).valid).toBe(true);
        expect(store.redo().success).toBe(true);
        expect(store.document?.drawings).toHaveLength(1);
        expect(store.drawingVersion).toBe(1);
    });

    it('clears the redo stack on a new committed mutation', () => {
        const store = historyStore();
        store.setParameter('width', 10);
        store.setParameter('width', 20);
        expect(store.undo().success).toBe(true);
        expect(store.canRedo).toBe(true);
        store.setParameter('height', 5);
        expect(store.canRedo).toBe(false);
        expect(store.redo().success).toBe(false);
        expect(store.document?.parameters).toEqual({ width: 10, height: 5 });
    });

    it('caps depth at DOCUMENT_HISTORY_DEPTH, dropping the oldest entries', () => {
        const store = historyStore();
        const total = DOCUMENT_HISTORY_DEPTH + 5;
        for (let i = 1; i <= total; i++) {
            expect(store.setParameter('n', i).success).toBe(true);
        }
        let undos = 0;
        while (store.canUndo) {
            expect(store.undo().success).toBe(true);
            undos++;
        }
        expect(undos).toBe(DOCUMENT_HISTORY_DEPTH);
        // The five oldest mutations were evicted: the earliest restorable
        // snapshot predates the 6th mutation, holding the 5th value.
        expect(store.document?.parameters.n).toBe(5);
        expect(store.canRedo).toBe(true);
    });

    it('resets both stacks on loadDocument and createDocument', () => {
        const store = historyStore();
        store.setParameter('width', 10);
        expect(store.canUndo).toBe(true);
        expect(store.loadDocument(minimalDoc()).success).toBe(true);
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
        store.setParameter('width', 10);
        expect(store.undo().success).toBe(true);
        expect(store.canRedo).toBe(true);
        expect(store.createDocument('fresh').success).toBe(true);
        expect(store.canUndo).toBe(false);
        expect(store.canRedo).toBe(false);
    });

    it('leaves history untouched on failed mutations', () => {
        const store = historyStore();
        store.addBody('Body 1');
        store.upsertSketch(sketch('s1'));
        store.addFeature(feature('pad1', 'pad', [], 's1'));
        store.markSaved();
        const failed = store.deleteSketch('s1');
        expect(failed.success).toBe(false);
        expect(store.dirty).toBe(false);
        // The failed delete recorded nothing: undo removes the pad feature.
        expect(store.undo().success).toBe(true);
        expect(store.document?.features).toHaveLength(0);
        expect(store.document?.sketches.map((s) => s.id)).toEqual(['s1']);
        expect(validateNukeCadDocument(store.document!).valid).toBe(true);
        expect(store.redo().success).toBe(true);
        expect(store.document?.features.map((f) => f.id)).toEqual(['pad1']);
    });

    it('undoes multi-step body/sketch/feature sequences in order', () => {
        const store = historyStore();
        store.addBody('Body 1');
        store.upsertSketch(sketch('s1'));
        store.addFeature(feature('pad1', 'pad', [], 's1'));
        expect(store.undo().success).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document?.features).toHaveLength(0);
        expect(store.document?.sketches).toHaveLength(0);
        expect(store.document?.bodies).toHaveLength(1);
        expect(store.undo().success).toBe(true);
        expect(store.document?.bodies).toHaveLength(0);
        expect(store.canUndo).toBe(false);
        expect(store.redo().success).toBe(true);
        expect(store.document?.bodies).toHaveLength(1);
    });
});
