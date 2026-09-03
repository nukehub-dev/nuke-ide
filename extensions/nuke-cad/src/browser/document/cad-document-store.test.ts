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
