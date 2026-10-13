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
import { CadDocumentStore, collectParameterUsages, evaluateParameterInput, validateParameterName } from './cad-document-store';
import { NUKE_CAD_SCHEMA_VERSION, type FeatureDef, type NukeCadDocument, type SketchDef } from '../../common/cad-document';

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

function sketch(id: string, overrides?: Partial<SketchDef>): SketchDef {
    return {
        id,
        name: id,
        datumId: 'datum-xy',
        primitives: [],
        constraints: [],
        ...overrides
    };
}

function feature(id: string, dependsOn: string[] = [], sketchId?: string): FeatureDef {
    return {
        id,
        name: id,
        type: 'pad',
        body: 'body-1',
        params: { length: 1 },
        suppressed: false,
        dependsOn,
        ...(sketchId !== undefined ? { sketchId } : {})
    };
}

function storeWithDoc(doc: NukeCadDocument): CadDocumentStore {
    const store = new CadDocumentStore();
    const loaded = store.loadDocument(JSON.parse(JSON.stringify(doc)));
    expect(loaded.success).toBe(true);
    store.markSaved();
    return store;
}

describe('validateParameterName', () => {
    it('rejects empty and whitespace names', () => {
        expect(validateParameterName('')).toBeDefined();
        expect(validateParameterName('   ')).toBeDefined();
    });

    it('accepts ordinary names', () => {
        expect(validateParameterName('width')).toBeUndefined();
        expect(validateParameterName('major_radius')).toBeUndefined();
    });
});

describe('addParameter / setParameter / removeParameter', () => {
    it('adds a new parameter through the commit path (dirty + undo)', () => {
        const store = storeWithDoc(minimalDoc());
        const result = store.addParameter('width', 10);
        expect(result.success).toBe(true);
        expect(store.document?.parameters.width).toBe(10);
        expect(store.dirty).toBe(true);
        expect(store.canUndo).toBe(true);
        expect(store.undo().success).toBe(true);
        expect(store.document?.parameters.width).toBeUndefined();
    });

    it('rejects adding a duplicate name', () => {
        const store = storeWithDoc(minimalDoc({ parameters: { width: 10 } }));
        const result = store.addParameter('width', 20);
        expect(result.success).toBe(false);
        expect(result.error).toContain('already exists');
        expect(store.document?.parameters.width).toBe(10);
        expect(store.dirty).toBe(false);
    });

    it('rejects empty names and non-finite values on add and set', () => {
        const store = storeWithDoc(minimalDoc());
        expect(store.addParameter('', 1).success).toBe(false);
        expect(store.addParameter('ok', NaN).success).toBe(false);
        expect(store.setParameter('', 1).success).toBe(false);
        expect(store.setParameter('ok', Infinity).success).toBe(false);
        expect(store.dirty).toBe(false);
    });

    it('setParameter still replaces an existing value', () => {
        const store = storeWithDoc(minimalDoc({ parameters: { width: 10 } }));
        expect(store.setParameter('width', 20).success).toBe(true);
        expect(store.document?.parameters.width).toBe(20);
    });

    it('rejects removing an unknown parameter', () => {
        const store = storeWithDoc(minimalDoc());
        const result = store.removeParameter('nope');
        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown parameter');
    });

    it('removes an unreferenced parameter', () => {
        const store = storeWithDoc(minimalDoc({ parameters: { width: 10 } }));
        expect(store.removeParameter('width').success).toBe(true);
        expect(store.document?.parameters.width).toBeUndefined();
        expect(store.dirty).toBe(true);
    });

    it('blocks removing a parameter bound to a sketch dimension, naming the referrer', () => {
        const doc = minimalDoc({ parameters: { width: 10 } });
        doc.sketches = [
            sketch('sk1', {
                primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                constraints: [{ id: 'c1' }],
                dimensions: [
                    { id: 'd1', constraintId: 'c1', kind: 'distance', targetIds: ['p1'], driving: true, parameter: 'width', value: 10 }
                ]
            })
        ];
        const store = storeWithDoc(doc);
        const result = store.removeParameter('width');
        expect(result.success).toBe(false);
        expect(result.error).toContain('sk1');
        expect(result.error).toContain("dimension 'd1'");
        expect(store.document?.parameters.width).toBe(10);
        expect(store.dirty).toBe(false);
    });

    it('allows removal again after the dimension is unbound', () => {
        const doc = minimalDoc({ parameters: { width: 10 } });
        doc.sketches = [
            sketch('sk1', {
                primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                constraints: [{ id: 'c1' }],
                dimensions: [
                    { id: 'd1', constraintId: 'c1', kind: 'distance', targetIds: ['p1'], driving: true, parameter: 'width', value: 10 }
                ]
            })
        ];
        const store = storeWithDoc(doc);
        const unbound = sketch('sk1', {
            primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
            constraints: [{ id: 'c1' }],
            dimensions: [{ id: 'd1', constraintId: 'c1', kind: 'distance', targetIds: ['p1'], driving: true, value: 10 }]
        });
        expect(store.upsertSketch(unbound).success).toBe(true);
        expect(store.removeParameter('width').success).toBe(true);
    });

    it('blocks removing a parameter referenced by a curve expression', () => {
        const store = storeWithDoc(minimalDoc({ parameters: { r: 5 } }));
        const added = store.addCurve({
            id: 'curve-1',
            name: 'loop',
            source: { kind: 'parametric', x: 'r*cos(t)', y: 'r*sin(t)', z: 't', tStart: 0, tEnd: Math.PI * 2, sampleCount: 16 },
            samples: []
        });
        expect(added.success).toBe(true);
        const result = store.removeParameter('r');
        expect(result.success).toBe(false);
        expect(result.error).toContain('loop');
        expect(result.error).toContain('x(t)');
    });
});

describe('collectParameterUsages', () => {
    it('returns one row per document parameter', () => {
        const usages = collectParameterUsages(minimalDoc({ parameters: { b: 2, a: 1 } }));
        expect(usages.map((u) => u.name)).toEqual(['b', 'a']);
        expect(usages.every((u) => u.usedBy.length === 0)).toBe(true);
    });

    it('resolves dimension bindings to sketch referrers', () => {
        const doc = minimalDoc({ parameters: { width: 10 } });
        doc.sketches = [
            sketch('sk1', {
                primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                constraints: [{ id: 'c1' }],
                dimensions: [
                    { id: 'd1', constraintId: 'c1', kind: 'distance', targetIds: ['p1'], driving: true, parameter: 'width', value: 10 }
                ]
            })
        ];
        const usages = collectParameterUsages(doc);
        expect(usages).toHaveLength(1);
        expect(usages[0].usedBy).toEqual([{ kind: 'sketch', id: 'sk1', label: 'sk1', detail: "dimension 'd1'" }]);
    });

    it('resolves string constraint values to sketch referrers', () => {
        const doc = minimalDoc({ parameters: { width: 10 } });
        doc.sketches = [
            sketch('sk1', {
                primitives: [
                    { id: 'p1', type: 'point', x: 0, y: 0 },
                    { id: 'p2', type: 'point', x: 10, y: 0 }
                ],
                constraints: [{ id: 'dist-1', type: 'p2p_distance', p1_id: 'p1', p2_id: 'p2', distance: 'width', driving: true }]
            })
        ];
        const usages = collectParameterUsages(doc);
        expect(usages[0].usedBy).toEqual([{ kind: 'sketch', id: 'sk1', label: 'sk1', detail: "constraint 'dist-1'" }]);
    });

    it('resolves curve expression identifiers, ignoring t/pi/e', () => {
        const doc = minimalDoc({ parameters: { r: 5, turns: 3 } });
        doc.curves = [
            {
                id: 'curve-1',
                name: 'loop',
                source: { kind: 'parametric', x: 'r*cos(t) + pi', y: 'r*sin(t)', z: 'turns*e', tStart: 0, tEnd: 1, sampleCount: 8 },
                samples: []
            }
        ];
        const usages = collectParameterUsages(doc);
        const byName = new Map(usages.map((u) => [u.name, u.usedBy]));
        expect(byName.get('r')).toEqual([
            { kind: 'curve', id: 'curve-1', label: 'loop', detail: 'x(t)' },
            { kind: 'curve', id: 'curve-1', label: 'loop', detail: 'y(t)' }
        ]);
        expect(byName.get('turns')).toEqual([{ kind: 'curve', id: 'curve-1', label: 'loop', detail: 'z(t)' }]);
    });

    it('attributes consuming features via the sketch and transitive dependents via the graph', () => {
        const doc = minimalDoc({ parameters: { width: 10 } });
        doc.sketches = [
            sketch('sk1', {
                primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                constraints: [{ id: 'c1' }],
                dimensions: [
                    { id: 'd1', constraintId: 'c1', kind: 'distance', targetIds: ['p1'], driving: true, parameter: 'width', value: 10 }
                ]
            })
        ];
        doc.features = [feature('pad1', [], 'sk1'), feature('pad2', ['pad1'])];
        const usages = collectParameterUsages(doc);
        expect(usages).toHaveLength(1);
        expect(usages[0].usedBy).toEqual([
            { kind: 'sketch', id: 'sk1', label: 'sk1', detail: "dimension 'd1'" },
            { kind: 'feature', id: 'pad1', label: 'pad1', detail: "via sketch 'sk1'" },
            { kind: 'feature', id: 'pad2', label: 'pad2', detail: 'dependent' }
        ]);
    });

    it('falls back to direct consumers when the feature graph is inconsistent', () => {
        const doc = minimalDoc({ parameters: { width: 10 } });
        doc.sketches = [
            sketch('sk1', {
                primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                constraints: [{ id: 'c1' }],
                dimensions: [
                    { id: 'd1', constraintId: 'c1', kind: 'distance', targetIds: ['p1'], driving: true, parameter: 'width', value: 10 }
                ]
            })
        ];
        // Dangling dependsOn: FeatureGraph construction throws; usage must stay direct-only.
        doc.features = [feature('pad1', ['missing-feature'], 'sk1')];
        const usages = collectParameterUsages(doc);
        expect(usages[0].usedBy).toEqual([
            { kind: 'sketch', id: 'sk1', label: 'sk1', detail: "dimension 'd1'" },
            { kind: 'feature', id: 'pad1', label: 'pad1', detail: "via sketch 'sk1'" }
        ]);
    });

    it('ignores unparseable curve expressions', () => {
        const doc = minimalDoc({ parameters: { r: 5 } });
        doc.curves = [
            {
                id: 'curve-1',
                name: 'broken',
                source: { kind: 'parametric', x: 'r + (', y: '0', z: '0', tStart: 0, tEnd: 1, sampleCount: 8 },
                samples: []
            }
        ];
        expect(collectParameterUsages(doc)[0].usedBy).toEqual([]);
    });
});

describe('evaluateParameterInput', () => {
    it('evaluates plain numbers and expressions over the other parameters', () => {
        expect(evaluateParameterInput('10', {})).toEqual({ ok: true, value: 10 });
        expect(evaluateParameterInput('width * 2 + 1', { width: 10 })).toEqual({ ok: true, value: 21 });
        expect(evaluateParameterInput('  sin(pi / 2) ', {})).toEqual({ ok: true, value: 1 });
    });

    it('rejects empty input with an inline reason', () => {
        const result = evaluateParameterInput('   ', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Enter a number or expression');
        }
    });

    it('surfaces parse errors without committing', () => {
        const result = evaluateParameterInput('1 +', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error.length).toBeGreaterThan(0);
        }
    });

    it('surfaces unknown identifiers and evaluation errors', () => {
        const unknown = evaluateParameterInput('depth * 2', { width: 1 });
        expect(unknown.ok).toBe(false);
        if (!unknown.ok) {
            expect(unknown.error).toContain("'depth'");
        }
        const zero = evaluateParameterInput('1 / 0', {});
        expect(zero.ok).toBe(false);
        if (!zero.ok) {
            expect(zero.error).toContain('Division by zero');
        }
    });

    it('rejects unit syntax on unit-less documents', () => {
        const result = evaluateParameterInput('10mm', {});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('no');
        }
    });

    it('coerces unit expressions to the declared document unit', () => {
        expect(evaluateParameterInput('10mm', {}, 'mm')).toEqual({ ok: true, value: 10 });
        expect(evaluateParameterInput('1cm', {}, 'mm')).toEqual({ ok: true, value: 10 });
        // Other parameters read in the declared unit, FreeCAD-style.
        expect(evaluateParameterInput('width + 5mm', { width: 10 }, 'mm')).toEqual({ ok: true, value: 15 });
        expect(evaluateParameterInput('width * 2', { width: 10 }, 'mm')).toEqual({ ok: true, value: 20 });
    });
});
