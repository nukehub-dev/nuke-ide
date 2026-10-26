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
    NUKE_CAD_SCHEMA_VERSION,
    validateNukeCadDocument,
    migrateNukeCadDocument,
    type NukeCadDocument,
    type ValidationIssue,
    type DimensionKind,
    type FeatureDef,
    type W7xCoilStudy,
    type W7xCoilShapeStudy,
    validateW7xDesignStudy
} from './cad-document';
import { type Point3, type TopologyRef } from './topology-refs';

function makeDocument(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'L-bracket',
        parameters: { width: 10, height: 5 },
        datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Base', label: 'base' }],
        sketches: [
            {
                id: 'sketch1',
                name: 'Profile',
                datumId: 'xy',
                primitives: [
                    { id: 'p1', type: 'point', x: 0, y: 0 },
                    { id: 'p2', type: 'point', x: 10, y: 0 },
                    { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' }
                ],
                constraints: [{ id: 'c1', type: 'horizontal_l', l_id: 'l1' }],
                parameters: { localAngle: 0 }
            }
        ],
        features: [
            {
                id: 'pad1',
                name: 'Base',
                type: 'pad',
                body: 'body-1',
                sketchId: 'sketch1',
                params: { length: 2 },
                suppressed: false,
                dependsOn: []
            }
        ],
        curves: []
    };
}

describe('validateNukeCadDocument', () => {
    it('accepts a valid document', () => {
        const result = validateNukeCadDocument(makeDocument());
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('round-trips through JSON', () => {
        const doc = makeDocument();
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        const result = validateNukeCadDocument(round);
        expect(result.valid).toBe(true);
        expect(round.version).toBe(NUKE_CAD_SCHEMA_VERSION);
    });

    it('accepts each declared document unit and an absent (legacy unitless) field', () => {
        for (const units of [undefined, 'mm', 'cm', 'm'] as const) {
            const doc = makeDocument();
            if (units === undefined) {
                delete doc.units;
            } else {
                doc.units = units;
            }
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(true);
        }
    });

    it('rejects unknown document units without a version bump', () => {
        const doc = { ...makeDocument(), units: 'inch' } as unknown as NukeCadDocument;
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'units')).toBe(true);
        expect(makeDocument().version).toBe(NUKE_CAD_SCHEMA_VERSION);
    });

    it('reports duplicate ids across top-level collections', () => {
        const doc = makeDocument();
        doc.features[0].id = 'sketch1';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("duplicate id 'sketch1'"))).toBe(true);
    });

    it('reports duplicate primitive ids within a sketch', () => {
        const doc = makeDocument();
        doc.sketches[0].primitives.push({ id: 'p1', type: 'point', x: 1, y: 1 });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'sketches[0].primitives[3].id')).toBe(true);
    });

    it('reports duplicate constraint ids and collisions with primitive ids', () => {
        const doc = makeDocument();
        doc.sketches[0].constraints.push({ id: 'p1', type: 'vertical_l', l_id: 'l1' });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes('collides with a primitive id'))).toBe(true);
    });

    it('reports dangling sketch datum references', () => {
        const doc = makeDocument();
        doc.sketches[0].datumId = 'missing';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown datum 'missing'"))).toBe(true);
    });

    it('reports dangling feature sketch references', () => {
        const doc = makeDocument();
        doc.features[0].sketchId = 'missing';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown sketch 'missing'"))).toBe(true);
    });

    it('reports dangling feature dependency references', () => {
        const doc = makeDocument();
        doc.features[0].dependsOn = ['missing'];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown feature 'missing'"))).toBe(true);
    });

    it('reports parameter name collisions between document and sketch', () => {
        const doc = makeDocument();
        doc.sketches[0].parameters = { width: 1 };
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes('collides with a document parameter'))).toBe(true);
    });

    it('reports out-of-range feature parameters', () => {
        const doc = makeDocument();
        doc.features[0].params = { length: -1 };
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.length')).toBe(true);
    });

    it('reports non-finite parameter values', () => {
        const doc = makeDocument();
        doc.parameters.width = NaN;
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'parameters.width')).toBe(true);
    });

    it('accepts dimensions on a sketch', () => {
        const doc = makeDocument();
        doc.sketches[0].constraints.push({ id: 'dimConstraint', type: 'p2p_distance', p1_id: 'p1', p2_id: 'p2', distance: 5 });
        doc.sketches[0].dimensions = [
            { id: 'dim1', constraintId: 'dimConstraint', kind: 'distance', targetIds: ['p1', 'p2'], driving: true, value: 5 }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('reports dimension id collisions', () => {
        const doc = makeDocument();
        doc.sketches[0].constraints.push({ id: 'dimConstraint', type: 'p2p_distance', p1_id: 'p1', p2_id: 'p2', distance: 5 });
        doc.sketches[0].dimensions = [
            { id: 'p1', constraintId: 'dimConstraint', kind: 'distance', targetIds: ['p1', 'p2'], driving: true, value: 5 }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'sketches[0].dimensions[0].id')).toBe(true);
    });

    it('reports dimensions referencing unknown constraints', () => {
        const doc = makeDocument();
        doc.sketches[0].dimensions = [
            { id: 'dim1', constraintId: 'missing', kind: 'distance', targetIds: ['p1', 'p2'], driving: true, value: 5 }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'sketches[0].dimensions[0].constraintId')).toBe(true);
    });

    it('reports invalid dimension kinds and values', () => {
        const doc = makeDocument();
        doc.sketches[0].constraints.push({ id: 'dimConstraint', type: 'p2p_distance', p1_id: 'p1', p2_id: 'p2', distance: 5 });
        doc.sketches[0].dimensions = [
            {
                id: 'dim1',
                constraintId: 'dimConstraint',
                kind: 'unknown' as unknown as DimensionKind,
                targetIds: ['p1', 'p2'],
                driving: true,
                value: NaN
            }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'sketches[0].dimensions[0].kind')).toBe(true);
        expect(result.issues.some((i) => i.path === 'sketches[0].dimensions[0].value')).toBe(true);
    });

    it('reports unknown feature types', () => {
        const doc = makeDocument();
        (doc.features[0] as unknown as { type: string }).type = 'unknownFeature';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown feature type 'unknownFeature'"))).toBe(true);
    });

    it('reports missing required parameters per feature type', () => {
        const doc = makeDocument();
        doc.features = [
            { id: 'pad1', name: 'Pad', type: 'pad', body: 'body-1', params: {}, suppressed: false, dependsOn: [] },
            { id: 'rev1', name: 'Revolve', type: 'revolve', body: 'body-1', params: { axis: 'z' }, suppressed: false, dependsOn: [] },
            { id: 'fil1', name: 'Fillet', type: 'fillet', body: 'body-1', params: {}, suppressed: false, dependsOn: [] },
            { id: 'hole1', name: 'Hole', type: 'hole', body: 'body-1', params: {}, suppressed: false, dependsOn: [] }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.length')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[1].params.angle')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[2].params.edges')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[3].params.diameter')).toBe(true);
    });

    it('reports self-dependencies and duplicate dependencies', () => {
        const doc = makeDocument();
        doc.features = [
            { id: 'a', name: 'A', type: 'pad', body: 'body-1', params: { length: 1 }, suppressed: false, dependsOn: ['a'] },
            { id: 'b', name: 'B', type: 'pad', body: 'body-1', params: { length: 1 }, suppressed: false, dependsOn: ['a', 'a'] }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes('cannot depend on itself'))).toBe(true);
        expect(result.issues.some((i) => i.message.includes('duplicate dependency'))).toBe(true);
    });

    it('recursively validates TopologyRefs in feature params and datums', () => {
        const badRef = {
            featureId: '',
            kind: 'face',
            fingerprint: { surfaceType: 'plane', area: 1, center: [0, 0, 0] }
        };
        const doc = makeDocument();
        doc.datums.push({ id: 'faceDatum', kind: 'face', name: 'Face', reference: badRef as never });
        doc.features.push({
            id: 'fil1',
            name: 'Fillet',
            type: 'fillet',
            body: 'body-1',
            params: { edges: [badRef] },
            suppressed: false,
            dependsOn: []
        });
        doc.features.push({
            id: 'shell1',
            name: 'Shell',
            type: 'shell',
            body: 'body-1',
            params: { faces: [badRef], thickness: 1 },
            suppressed: false,
            dependsOn: []
        });
        doc.features.push({
            id: 'draft1',
            name: 'Draft',
            type: 'draft',
            body: 'body-1',
            params: { faces: [badRef], angle: 5, pullDirection: [0, 0, 1] },
            suppressed: false,
            dependsOn: []
        });
        doc.features[0].params = { length: 1, upToFace: badRef };

        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path.startsWith('datums[1].reference'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[1].params.edges'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[2].params.faces'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[3].params.faces'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[0].params.upToFace'))).toBe(true);
    });

    it('accepts a face datum with a valid TopologyRef', () => {
        const doc = makeDocument();
        doc.datums.push({
            id: 'faceDatum',
            kind: 'face',
            name: 'Top face',
            reference: {
                featureId: 'pad1',
                kind: 'face',
                fingerprint: { surfaceType: 'plane', area: 25, center: [0, 0, 0], normal: [0, 0, 1] }
            }
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('rejects a face datum missing its reference', () => {
        const doc = makeDocument();
        doc.datums.push({ id: 'faceDatum', kind: 'face', name: 'Top face' });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'datums[1].reference' && i.message.includes('requires a reference'))).toBe(true);
    });

    it('accepts sketch externalRefs and rejects malformed ones', () => {
        const doc = makeDocument();
        const goodRef: TopologyRef = {
            featureId: 'pad1',
            kind: 'edge',
            fingerprint: { curveType: 'line', length: 5, start: [0, 0, 0] as Point3, end: [5, 0, 0] as Point3 }
        };
        doc.sketches[0].externalRefs = [goodRef];
        expect(validateNukeCadDocument(doc).valid).toBe(true);

        doc.sketches[0].externalRefs = [
            {
                featureId: '',
                kind: 'edge',
                fingerprint: { curveType: 'line', length: 5, start: [0, 0, 0] as Point3, end: [5, 0, 0] as Point3 }
            }
        ];
        const bad = validateNukeCadDocument(doc);
        expect(bad.valid).toBe(false);
        expect(bad.issues.some((i) => i.path.startsWith('sketches[0].externalRefs[0]'))).toBe(true);
    });
});

describe('migrateNukeCadDocument', () => {
    it('passes through a document already at the current version', () => {
        const doc = makeDocument();
        const result = migrateNukeCadDocument(doc);
        expect(result.document).toBe(doc);
        expect(result.migratedFrom).toBeUndefined();
    });

    it('rejects a future schema version', () => {
        const doc = makeDocument();
        doc.version = 99;
        expect(() => migrateNukeCadDocument(doc)).toThrow(/Unsupported .nuke-cad schema version 99/);
    });

    it('rejects a non-object document', () => {
        expect(() => migrateNukeCadDocument(null)).toThrow('.nuke-cad document must be an object');
    });

    it('rejects a missing or invalid version', () => {
        expect(() => migrateNukeCadDocument({})).toThrow(/version must be an integer/);
    });

    it('migrates v1 additive features to per-feature bodies with labels', () => {
        const v1 = {
            version: 1,
            name: 'test',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            sketches: [],
            features: [
                {
                    id: 'fuel',
                    name: 'fuel',
                    type: 'pad',
                    sketchId: 's1',
                    params: { length: 1 },
                    suppressed: false,
                    dependsOn: [],
                    label: 'fuel'
                },
                {
                    id: 'clad',
                    name: 'clad',
                    type: 'pad',
                    sketchId: 's2',
                    params: { length: 1 },
                    suppressed: false,
                    dependsOn: [],
                    label: 'clad'
                }
            ]
        };
        const result = migrateNukeCadDocument(v1);
        expect(result.migratedFrom).toBe(1);
        expect(result.document.version).toBe(NUKE_CAD_SCHEMA_VERSION);
        expect(result.document.bodies).toHaveLength(2);
        expect(result.document.bodies.map((b) => b.id)).toEqual(['body-fuel', 'body-clad']);
        expect(result.document.bodies.map((b) => b.label)).toEqual(['fuel', 'clad']);
        expect(result.document.features[0].body).toBe('body-fuel');
        expect(result.document.features[1].body).toBe('body-clad');
        expect('label' in result.document.features[0]).toBe(false);
    });

    it('migrates v1 pockets to the nearest preceding additive body', () => {
        const v1 = {
            version: 1,
            name: 'test',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            sketches: [],
            features: [
                { id: 'base', name: 'base', type: 'pad', sketchId: 's1', params: { length: 1 }, suppressed: false, dependsOn: [] },
                { id: 'cut', name: 'cut', type: 'pocket', sketchId: 's2', params: { length: 1 }, suppressed: false, dependsOn: [] }
            ]
        };
        const result = migrateNukeCadDocument(v1);
        expect(result.document.features[1].body).toBe('body-base');
    });
});

describe('v2 schema validation', () => {
    it('rejects a feature-level label', () => {
        const doc = makeDocument();
        (doc.features[0] as unknown as { label: string }).label = 'base';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].label')).toBe(true);
    });

    it('rejects an unknown feature body reference', () => {
        const doc = makeDocument();
        doc.features[0].body = 'missing';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown body 'missing'"))).toBe(true);
    });

    it('rejects boolean features with missing target or tool bodies', () => {
        const doc = makeDocument();
        doc.bodies.push({ id: 'tool', name: 'tool' });
        doc.features = [
            {
                id: 'fuse',
                name: 'fuse',
                type: 'booleanFuse',
                body: 'body-1',
                params: { targetBody: 'missing', toolBodies: ['tool'] },
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'cut',
                name: 'cut',
                type: 'booleanCut',
                body: 'body-1',
                params: { targetBody: 'body-1', toolBodies: [] },
                suppressed: false,
                dependsOn: []
            }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.targetBody')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[1].params.toolBodies')).toBe(true);
    });
});

describe('dress-up feature validation', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'box',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body 1' }],
            sketches: [
                {
                    id: 'sketch1',
                    name: 'Base profile',
                    datumId: 'xy',
                    primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                    constraints: [],
                    parameters: {}
                }
            ],
            features: [
                {
                    id: 'pad1',
                    name: 'Base',
                    type: 'pad',
                    body: 'body-1',
                    sketchId: 'sketch1',
                    params: { length: 10 },
                    suppressed: false,
                    dependsOn: []
                }
            ],
            curves: []
        };
    }

    const goodEdgeRef: TopologyRef = {
        featureId: 'pad1',
        kind: 'edge',
        fingerprint: { curveType: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0] }
    };

    const goodFaceRef: TopologyRef = {
        featureId: 'pad1',
        kind: 'face',
        fingerprint: { surfaceType: 'plane', area: 100, center: [0, 0, 0], normal: [0, 0, 1] }
    };

    it('accepts a valid fillet feature', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'fillet1',
            name: 'Fillet',
            type: 'fillet',
            body: 'body-1',
            params: { edges: [goodEdgeRef], radius: 1 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('rejects fillet with missing radius or edges', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'fillet1',
            name: 'Fillet',
            type: 'fillet',
            body: 'body-1',
            params: { edges: [] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.edges')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[1].params.radius')).toBe(true);
    });

    it('accepts chamfer symmetric, two-distance, and distance-angle modes', () => {
        const modes: Array<{ params: Record<string, unknown>; label: string }> = [
            { params: { edges: [goodEdgeRef], distance: 1 }, label: 'symmetric' },
            { params: { edges: [goodEdgeRef], distances: [1, 2] }, label: 'two-distance' },
            { params: { edges: [goodEdgeRef], distance: 1, angle: 30 }, label: 'distance-angle' }
        ];
        for (const { params, label } of modes) {
            const doc = makeBaseDocument();
            doc.features.push({
                id: `chamfer-${label}`,
                name: 'Chamfer',
                type: 'chamfer',
                body: 'body-1',
                params,
                suppressed: false,
                dependsOn: ['pad1']
            });
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(true);
        }
    });

    it('rejects chamfer with mutually exclusive parameters', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'chamfer1',
            name: 'Chamfer',
            type: 'chamfer',
            body: 'body-1',
            params: { edges: [goodEdgeRef], distances: [1, 2], distance: 1 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.distances')).toBe(true);
    });

    it('accepts a valid draft feature', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'draft1',
            name: 'Draft',
            type: 'draft',
            body: 'body-1',
            params: { faces: [goodFaceRef], angle: 5, pullDirection: [0, 0, 1] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('rejects draft with zero pull direction', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'draft1',
            name: 'Draft',
            type: 'draft',
            body: 'body-1',
            params: { faces: [goodFaceRef], angle: 5, pullDirection: [0, 0, 0] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.pullDirection')).toBe(true);
    });

    it('accepts a valid shell feature with optional faces', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'shell1',
            name: 'Shell',
            type: 'shell',
            body: 'body-1',
            params: { faces: [], thickness: 1 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('rejects shell with non-positive thickness', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'shell1',
            name: 'Shell',
            type: 'shell',
            body: 'body-1',
            params: { faces: [goodFaceRef], thickness: -1 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.thickness')).toBe(true);
    });
});

describe('pattern, mirror, and hole validation', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'box',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body 1' }],
            sketches: [
                {
                    id: 'sketch1',
                    name: 'Base profile',
                    datumId: 'xy',
                    primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                    constraints: [],
                    parameters: {}
                }
            ],
            features: [
                {
                    id: 'pad1',
                    name: 'Base',
                    type: 'pad',
                    body: 'body-1',
                    sketchId: 'sketch1',
                    params: { length: 10 },
                    suppressed: false,
                    dependsOn: []
                }
            ],
            curves: []
        };
    }

    const goodFaceRef: TopologyRef = {
        featureId: 'pad1',
        kind: 'face',
        fingerprint: { surfaceType: 'plane', area: 100, center: [0, 0, 0], normal: [0, 0, 1] }
    };

    it('accepts a valid linear pattern', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'lin1',
            name: 'Linear Pattern',
            type: 'linearPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 3, spacing: 2, axis: 'x' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('rejects linear pattern with invalid count or spacing', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'lin1',
            name: 'Linear Pattern',
            type: 'linearPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 0, spacing: 0, axis: 'x' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.count')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[1].params.spacing')).toBe(true);
    });

    it('accepts a valid circular pattern with axis or axis datum', () => {
        const withAxis = makeBaseDocument();
        withAxis.features.push({
            id: 'circ1',
            name: 'Circular Pattern',
            type: 'circularPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 4, angle: 180, axis: 'z' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(withAxis).valid).toBe(true);

        const withDatum = makeBaseDocument();
        withDatum.datums.push({ id: 'offset-datum', kind: 'offset', name: 'Offset', offset: 2 });
        withDatum.features.push({
            id: 'circ2',
            name: 'Circular Pattern',
            type: 'circularPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 4, angle: 180, axisDatumId: 'offset-datum' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(withDatum).valid).toBe(true);
    });

    it('rejects circular pattern with both axis and axisDatumId', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'circ1',
            name: 'Circular Pattern',
            type: 'circularPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 4, angle: 180, axis: 'z', axisDatumId: 'missing' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.axis')).toBe(true);
    });

    it('accepts a valid mirror feature with a plane or plane datum', () => {
        const withPlane = makeBaseDocument();
        withPlane.features.push({
            id: 'mir1',
            name: 'Mirror',
            type: 'mirror',
            body: 'body-1',
            params: { source: 'pad1', plane: 'YZ' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(withPlane).valid).toBe(true);

        const withDatum = makeBaseDocument();
        withDatum.datums.push({ id: 'face-datum', kind: 'face', name: 'Face', reference: goodFaceRef });
        withDatum.features.push({
            id: 'mir2',
            name: 'Mirror',
            type: 'mirror',
            body: 'body-1',
            params: { source: 'pad1', planeDatumId: 'face-datum' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(withDatum).valid).toBe(true);
    });

    it('rejects mirror with both plane and planeDatumId', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'mir1',
            name: 'Mirror',
            type: 'mirror',
            body: 'body-1',
            params: { source: 'pad1', plane: 'XY', planeDatumId: 'missing' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.plane')).toBe(true);
    });

    it('accepts a valid hole feature', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'hole1',
            name: 'Hole',
            type: 'hole',
            body: 'body-1',
            params: { face: goodFaceRef, center: [1, 2], diameter: 0.5 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('accepts a counterbore and countersink hole', () => {
        const counterbore = makeBaseDocument();
        counterbore.features.push({
            id: 'hole1',
            name: 'Hole',
            type: 'hole',
            body: 'body-1',
            params: { face: goodFaceRef, center: [0, 0], diameter: 0.5, counterboreDiameter: 1, counterboreDepth: 0.25 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(counterbore).valid).toBe(true);

        const countersink = makeBaseDocument();
        countersink.features.push({
            id: 'hole1',
            name: 'Hole',
            type: 'hole',
            body: 'body-1',
            params: { face: goodFaceRef, center: [0, 0], diameter: 0.5, countersinkDiameter: 1, countersinkAngle: 82 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(countersink).valid).toBe(true);
    });

    it('rejects hole with missing face, center, or diameter', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'hole1',
            name: 'Hole',
            type: 'hole',
            body: 'body-1',
            params: {},
            suppressed: false,
            dependsOn: ['pad1']
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.face')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[1].params.center')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[1].params.diameter')).toBe(true);
    });
});

describe('curve validation', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'curves',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [],
            sketches: [],
            features: [],
            curves: []
        };
    }

    function samplePoints(): [number, number, number][] {
        const pts: [number, number, number][] = [];
        for (let i = 0; i < 8; i++) {
            pts.push([Math.cos(i), Math.sin(i), 0]);
        }
        return pts;
    }

    it('accepts a points-sourced curve', () => {
        const doc = makeBaseDocument();
        doc.curves.push({ id: 'c1', name: 'Helix', source: { kind: 'points' }, samples: samplePoints() });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('accepts a parametric-sourced curve', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
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
            samples: samplePoints()
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('accepts a fourier-sourced curve', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
            id: 'c1',
            name: 'Fourier circle',
            source: {
                kind: 'fourier',
                nfp: 1,
                order: 1,
                cosX: [0, 1],
                sinX: [0, 0],
                cosY: [0, 0],
                sinY: [0, 1],
                cosZ: [0, 0],
                sinZ: [0, 0],
                sampleCount: 64
            },
            samples: samplePoints()
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('accepts a fourier source with shorter sin arrays', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
            id: 'c1',
            name: 'Fourier with truncated sin terms',
            source: {
                kind: 'fourier',
                nfp: 1,
                order: 2,
                cosX: [0, 1, 0],
                sinX: [0],
                cosY: [0, 0, 0],
                sinY: [0, 1],
                cosZ: [0, 0, 0],
                sinZ: [],
                sampleCount: 64
            },
            samples: samplePoints()
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('rejects a fourier source with coefficient arrays longer than order + 1', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
            id: 'c1',
            name: 'Bad',
            source: {
                kind: 'fourier',
                nfp: 1,
                order: 1,
                cosX: [0, 1],
                sinX: [0, 0],
                cosY: [0, 0],
                sinY: [0, 1, 0],
                cosZ: [0, 0],
                sinZ: [0, 0],
                sampleCount: 64
            },
            samples: samplePoints()
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'curves[0].source.sinY')).toBe(true);
    });

    it('rejects a curve with duplicate id', () => {
        const doc = makeBaseDocument();
        doc.curves.push({ id: 'c1', name: 'A', source: { kind: 'points' }, samples: samplePoints() });
        doc.curves.push({ id: 'c1', name: 'B', source: { kind: 'points' }, samples: samplePoints() });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("duplicate id 'c1'"))).toBe(true);
    });

    it('rejects malformed parametric source fields', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
            id: 'c1',
            name: 'Bad',
            source: {
                kind: 'parametric',
                x: '',
                y: '0',
                z: '0',
                tStart: 1,
                tEnd: 1,
                sampleCount: 4
            },
            samples: samplePoints()
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'curves[0].source.x')).toBe(true);
        expect(result.issues.some((i) => i.path === 'curves[0].source.tEnd')).toBe(true);
        expect(result.issues.some((i) => i.path === 'curves[0].source.sampleCount')).toBe(true);
    });

    it('rejects malformed fourier source fields', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
            id: 'c1',
            name: 'Bad',
            source: {
                kind: 'fourier',
                nfp: 0,
                order: -1,
                cosX: [0],
                sinX: [0],
                cosY: [0],
                sinY: [0],
                cosZ: [0],
                sinZ: [0],
                sampleCount: 4
            },
            samples: samplePoints()
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'curves[0].source.nfp')).toBe(true);
        expect(result.issues.some((i) => i.path === 'curves[0].source.order')).toBe(true);
        expect(result.issues.some((i) => i.path === 'curves[0].source.sampleCount')).toBe(true);
    });

    it('rejects too few curve samples', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
            id: 'c1',
            name: 'Short',
            source: { kind: 'points' },
            samples: [
                [0, 0, 0],
                [1, 0, 0],
                [2, 0, 0]
            ]
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'curves[0].samples')).toBe(true);
    });

    it('rejects non-finite curve samples', () => {
        const doc = makeBaseDocument();
        doc.curves.push({
            id: 'c1',
            name: 'Bad',
            source: { kind: 'points' },
            samples: [
                [0, 0, 0],
                [1, 0, 0],
                [2, NaN, 0],
                [3, 0, 0]
            ]
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'curves[0].samples[2][1]')).toBe(true);
    });

    it('requires curves to be an array', () => {
        const doc = makeBaseDocument();
        (doc as unknown as { curves: string }).curves = 'not-an-array';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'curves')).toBe(true);
    });
});

describe('sweep and pipe validation', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'sweep',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body 1' }],
            sketches: [
                {
                    id: 'sketch1',
                    name: 'Section',
                    datumId: 'xy',
                    primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                    constraints: [],
                    parameters: {}
                }
            ],
            features: [],
            curves: [
                {
                    id: 'curve1',
                    name: 'Path',
                    source: { kind: 'points' },
                    samples: [
                        [0, 0, 0],
                        [1, 0, 0],
                        [1, 1, 0],
                        [0, 1, 0]
                    ]
                }
            ]
        };
    }

    it('accepts a valid sweep and pipe', () => {
        const doc = makeBaseDocument();
        doc.features.push(
            {
                id: 'sw1',
                name: 'Sweep',
                type: 'sweep',
                body: 'body-1',
                sketchId: 'sketch1',
                params: { pathCurveId: 'curve1', orientation: 'frenet' },
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'p1',
                name: 'Pipe',
                type: 'pipe',
                body: 'body-1',
                params: { pathCurveId: 'curve1', radius: 2, orientation: 'fixedBinormal', binormal: [0, 0, 1] },
                suppressed: false,
                dependsOn: []
            }
        );
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('requires binormal iff orientation is fixedBinormal', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'sw1',
            name: 'Sweep',
            type: 'sweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { pathCurveId: 'curve1', orientation: 'fixedBinormal' },
            suppressed: false,
            dependsOn: []
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.binormal')).toBe(true);
    });

    it('rejects a zero or malformed binormal', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'sw1',
            name: 'Sweep',
            type: 'sweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { pathCurveId: 'curve1', orientation: 'fixedBinormal', binormal: [0, 0, 0] },
            suppressed: false,
            dependsOn: []
        });
        const zeroResult = validateNukeCadDocument(doc);
        expect(zeroResult.valid).toBe(false);
        expect(zeroResult.issues.some((i) => i.path === 'features[0].params.binormal')).toBe(true);

        (doc.features[0].params as Record<string, unknown>).binormal = [0, 'x', 1];
        const malformedResult = validateNukeCadDocument(doc);
        expect(malformedResult.valid).toBe(false);
        expect(malformedResult.issues.some((i) => i.path === 'features[0].params.binormal')).toBe(true);
    });

    it('rejects an unknown orientation', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'sw1',
            name: 'Sweep',
            type: 'sweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { pathCurveId: 'curve1', orientation: 'parallel' },
            suppressed: false,
            dependsOn: []
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.orientation')).toBe(true);
    });

    it('rejects a missing or unknown pathCurveId', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'sw1',
            name: 'Sweep',
            type: 'sweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { orientation: 'frenet' },
            suppressed: false,
            dependsOn: []
        });
        const missingResult = validateNukeCadDocument(doc);
        expect(missingResult.valid).toBe(false);
        expect(missingResult.issues.some((i) => i.path === 'features[0].params.pathCurveId')).toBe(true);

        (doc.features[0].params as Record<string, unknown>).pathCurveId = 'nope';
        const unknownResult = validateNukeCadDocument(doc);
        expect(unknownResult.valid).toBe(false);
        expect(unknownResult.issues.some((i) => i.path === 'features[0].params.pathCurveId')).toBe(true);
    });

    it('rejects a non-positive or non-numeric pipe radius', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'p1',
            name: 'Pipe',
            type: 'pipe',
            body: 'body-1',
            params: { pathCurveId: 'curve1', radius: -1, orientation: 'frenet' },
            suppressed: false,
            dependsOn: []
        });
        const negativeResult = validateNukeCadDocument(doc);
        expect(negativeResult.valid).toBe(false);
        expect(negativeResult.issues.some((i) => i.path === 'features[0].params.radius')).toBe(true);

        // Pipe radius is numeric-only, like pad length: a parameter-name string
        // is not resolved.
        (doc.features[0].params as Record<string, unknown>).radius = 'pipeRadius';
        const stringResult = validateNukeCadDocument(doc);
        expect(stringResult.valid).toBe(false);
        expect(stringResult.issues.some((i) => i.path === 'features[0].params.radius')).toBe(true);
    });
});

describe('coilSweep validation (additive v3)', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'coil-sweep',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body 1' }],
            sketches: [],
            features: [],
            curves: [
                {
                    id: 'coil-path',
                    name: 'Coil path',
                    source: { kind: 'points' },
                    samples: [
                        [0, 0, 0],
                        [1, 0, 0],
                        [1, 1, 0],
                        [0, 1, 0],
                        [0, 0, 0]
                    ]
                }
            ]
        };
    }

    function coilFeature(params: Record<string, unknown>): FeatureDef {
        return {
            id: 'coil1',
            name: 'Coil sweep',
            type: 'coilSweep',
            body: 'body-1',
            params,
            suppressed: false,
            dependsOn: []
        };
    }

    function documentWith(params: Record<string, unknown>): NukeCadDocument {
        const doc = makeBaseDocument();
        doc.features.push(coilFeature(params));
        return doc;
    }

    function issuePaths(params: Record<string, unknown>): string[] {
        return validateNukeCadDocument(documentWith(params)).issues.map((i) => i.path);
    }

    it('accepts a minimal coil sweep without a sketch', () => {
        const doc = documentWith({ pathCurveId: 'coil-path', width: 0.37, height: 0.37 });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
        expect(doc.version).toBe(NUKE_CAD_SCHEMA_VERSION);
        expect(migrateNukeCadDocument(doc).migratedFrom).toBeUndefined();
    });

    it('accepts tilt, twist, and station boundaries', () => {
        for (const [tiltDeg, twistDeg, stations] of [
            [-89, 0, 8],
            [0, 0, 60],
            [89, -720, 720],
            [8.6, 1080, 240]
        ]) {
            expect(issuePaths({ pathCurveId: 'coil-path', width: 0.37, height: 0.37, tiltDeg, twistDeg, stations })).toEqual([]);
        }
    });

    it('round-trips through JSON', () => {
        const doc = documentWith({ pathCurveId: 'coil-path', width: 0.37, height: 0.2, tiltDeg: 8.6, twistDeg: 90, stations: 120 });
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(validateNukeCadDocument(round).valid).toBe(true);
        expect(round.features[0].params).toEqual(doc.features[0].params);
    });

    it('requires a non-empty known path curve', () => {
        expect(issuePaths({ width: 0.37, height: 0.37 })).toContain('features[0].params.pathCurveId');
        expect(issuePaths({ pathCurveId: '', width: 0.37, height: 0.37 })).toContain('features[0].params.pathCurveId');
        expect(issuePaths({ pathCurveId: 7, width: 0.37, height: 0.37 })).toContain('features[0].params.pathCurveId');
        expect(issuePaths({ pathCurveId: 'nope', width: 0.37, height: 0.37 })).toContain('features[0].params.pathCurveId');
    });

    it('requires positive finite width and height', () => {
        for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.37', null]) {
            expect(issuePaths({ pathCurveId: 'coil-path', width: value, height: 0.37 }), String(value)).toContain(
                'features[0].params.width'
            );
            expect(issuePaths({ pathCurveId: 'coil-path', width: 0.37, height: value }), String(value)).toContain(
                'features[0].params.height'
            );
        }
    });

    it('rejects tilt outside [-89, 89] and non-finite tilt', () => {
        for (const value of [-90, 90, Number.NaN, Number.POSITIVE_INFINITY, '8.6']) {
            expect(issuePaths({ pathCurveId: 'coil-path', width: 0.37, height: 0.37, tiltDeg: value }), String(value)).toContain(
                'features[0].params.tiltDeg'
            );
        }
    });

    it('rejects non-finite twist and malformed stations', () => {
        for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, '90']) {
            expect(issuePaths({ pathCurveId: 'coil-path', width: 0.37, height: 0.37, twistDeg: value }), String(value)).toContain(
                'features[0].params.twistDeg'
            );
        }
        for (const value of [7, 721, 8.5, '60', null]) {
            expect(issuePaths({ pathCurveId: 'coil-path', width: 0.37, height: 0.37, stations: value }), String(value)).toContain(
                'features[0].params.stations'
            );
        }
    });
});

describe('v2 to v3 migration', () => {
    it('adds an empty curves array to a v2 document', () => {
        const v2 = {
            version: 2,
            name: 'v2-doc',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body' }],
            sketches: [],
            features: []
        };
        const result = migrateNukeCadDocument(v2);
        expect(result.migratedFrom).toBe(2);
        expect(result.document.version).toBe(NUKE_CAD_SCHEMA_VERSION);
        expect(result.document.curves).toEqual([]);
    });

    it('preserves all v2 fields during migration', () => {
        const v2 = {
            version: 2,
            name: 'v2-doc',
            parameters: { width: 10 },
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body', label: 'base' }],
            sketches: [
                {
                    id: 'sketch1',
                    name: 'Profile',
                    datumId: 'xy',
                    primitives: [],
                    constraints: [],
                    parameters: {}
                }
            ],
            features: [
                {
                    id: 'pad1',
                    name: 'Pad',
                    type: 'pad',
                    body: 'body-1',
                    sketchId: 'sketch1',
                    params: { length: 2 },
                    suppressed: false,
                    dependsOn: []
                }
            ]
        };
        const result = migrateNukeCadDocument(v2);
        expect(result.document.name).toBe('v2-doc');
        expect(result.document.parameters).toEqual({ width: 10 });
        expect(result.document.bodies).toHaveLength(1);
        expect(result.document.sketches).toHaveLength(1);
        expect(result.document.features).toHaveLength(1);
    });
});

describe('loft and helicalSweep validation', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'loft-helix',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body 1' }],
            sketches: [
                {
                    id: 'sketch1',
                    name: 'Profile',
                    datumId: 'xy',
                    primitives: [
                        { id: 'p1', type: 'point', x: 0, y: 0 },
                        { id: 'p2', type: 'point', x: 10, y: 0 },
                        { id: 'p3', type: 'point', x: 10, y: 10 },
                        { id: 'p4', type: 'point', x: 0, y: 10 },
                        { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' },
                        { id: 'l2', type: 'line', p1_id: 'p2', p2_id: 'p3' },
                        { id: 'l3', type: 'line', p1_id: 'p3', p2_id: 'p4' },
                        { id: 'l4', type: 'line', p1_id: 'p4', p2_id: 'p1' }
                    ],
                    constraints: []
                },
                {
                    id: 'sketch2',
                    name: 'Profile 2',
                    datumId: 'xy',
                    primitives: [
                        { id: 'p1', type: 'point', x: 0, y: 0 },
                        { id: 'p2', type: 'point', x: 5, y: 0 },
                        { id: 'p3', type: 'point', x: 5, y: 5 },
                        { id: 'p4', type: 'point', x: 0, y: 5 },
                        { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' },
                        { id: 'l2', type: 'line', p1_id: 'p2', p2_id: 'p3' },
                        { id: 'l3', type: 'line', p1_id: 'p3', p2_id: 'p4' },
                        { id: 'l4', type: 'line', p1_id: 'p4', p2_id: 'p1' }
                    ],
                    constraints: []
                }
            ],
            features: [],
            curves: []
        };
    }

    it('accepts a valid loft and helicalSweep', () => {
        const doc = makeBaseDocument();
        doc.features.push(
            {
                id: 'loft1',
                name: 'Loft',
                type: 'loft',
                body: 'body-1',
                params: { sectionSketchIds: ['sketch1', 'sketch2'], ruled: false },
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'h1',
                name: 'Helix',
                type: 'helicalSweep',
                body: 'body-1',
                sketchId: 'sketch1',
                params: { axis: 'Z', startRadius: 20, pitch: 5, turns: 3, orientation: 'fixedBinormal', binormal: [0, 0, 1] },
                suppressed: false,
                dependsOn: []
            }
        );
        const result = validateNukeCadDocument(doc);
        expect(result.issues).toEqual([]);
        expect(result.valid).toBe(true);
    });

    it('rejects a loft with fewer than 2 sections, duplicates, or dangling ids', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'loft1',
            name: 'Loft',
            type: 'loft',
            body: 'body-1',
            params: { sectionSketchIds: ['sketch1'], ruled: false },
            suppressed: false,
            dependsOn: []
        });
        let result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.sectionSketchIds')).toBe(true);

        (doc.features[0].params as Record<string, unknown>).sectionSketchIds = ['sketch1', 'sketch1'];
        result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.sectionSketchIds[1]')).toBe(true);

        (doc.features[0].params as Record<string, unknown>).sectionSketchIds = ['sketch1', 'nope'];
        result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.sectionSketchIds[1]')).toBe(true);
    });

    it('rejects a non-boolean loft ruled flag', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'loft1',
            name: 'Loft',
            type: 'loft',
            body: 'body-1',
            params: { sectionSketchIds: ['sketch1', 'sketch2'], ruled: 'yes' as unknown as boolean },
            suppressed: false,
            dependsOn: []
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.ruled')).toBe(true);
    });

    it('rejects non-positive helicalSweep radii, pitch, and turns', () => {
        for (const [key, value] of [
            ['startRadius', 0],
            ['pitch', -5],
            ['turns', 0]
        ] as const) {
            const doc = makeBaseDocument();
            doc.features.push({
                id: 'h1',
                name: 'Helix',
                type: 'helicalSweep',
                body: 'body-1',
                sketchId: 'sketch1',
                params: { axis: 'Z', startRadius: 20, pitch: 5, turns: 3, [key]: value },
                suppressed: false,
                dependsOn: []
            });
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === `features[0].params.${key}`)).toBe(true);
        }
    });

    it('rejects a bad helicalSweep axis, orientation, or binormal', () => {
        const base = (): NukeCadDocument => makeBaseDocument();
        const params = { axis: 'Z', startRadius: 20, pitch: 5, turns: 3 };

        const badAxis = base();
        badAxis.features.push({
            id: 'h1',
            name: 'Helix',
            type: 'helicalSweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { ...params, axis: 'z' as unknown as 'Z' },
            suppressed: false,
            dependsOn: []
        });
        let result = validateNukeCadDocument(badAxis);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.axis')).toBe(true);

        const badOrientation = base();
        badOrientation.features.push({
            id: 'h1',
            name: 'Helix',
            type: 'helicalSweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { ...params, orientation: 'parallel' as unknown as 'frenet' },
            suppressed: false,
            dependsOn: []
        });
        result = validateNukeCadDocument(badOrientation);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.orientation')).toBe(true);

        const badBinormal = base();
        badBinormal.features.push({
            id: 'h1',
            name: 'Helix',
            type: 'helicalSweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { ...params, orientation: 'fixedBinormal', binormal: [0, 0, 0] },
            suppressed: false,
            dependsOn: []
        });
        result = validateNukeCadDocument(badBinormal);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.binormal')).toBe(true);
    });

    it('accepts an omitted fixedBinormal binormal (axis default) and leftHanded flag', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'h1',
            name: 'Helix',
            type: 'helicalSweep',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { axis: 'Z', startRadius: 20, pitch: 5, turns: 3, orientation: 'fixedBinormal', leftHanded: true },
            suppressed: false,
            dependsOn: []
        });
        const result = validateNukeCadDocument(doc);
        expect(result.issues).toEqual([]);
        expect(result.valid).toBe(true);
    });
});

describe('extended feature validation', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'extended',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'body-1', name: 'Body 1' }],
            sketches: [
                {
                    id: 'sketch1',
                    name: 'Profile',
                    datumId: 'xy',
                    primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                    constraints: []
                }
            ],
            features: [
                {
                    id: 'pad1',
                    name: 'Base',
                    type: 'pad',
                    body: 'body-1',
                    sketchId: 'sketch1',
                    params: { length: 10 },
                    suppressed: false,
                    dependsOn: []
                }
            ],
            curves: []
        };
    }

    const goodFaceRef: TopologyRef = {
        featureId: 'pad1',
        kind: 'face',
        fingerprint: { surfaceType: 'plane', area: 100, center: [0, 0, 0], normal: [0, 0, 1] }
    };

    function padParams(doc: NukeCadDocument, params: Record<string, unknown>): ValidationIssue[] {
        doc.features.push({
            id: 'pad2',
            name: 'Second',
            type: 'pad',
            body: 'body-1',
            sketchId: 'sketch1',
            params: params as unknown as Record<string, number>,
            suppressed: false,
            dependsOn: ['pad1']
        });
        return validateNukeCadDocument(doc).issues;
    }

    it('accepts blind pads with and without explicit end, and twoSided blind pads', () => {
        for (const params of [{ length: 5 }, { length: 5, end: 'blind' }, { length: 5, twoSided: true }, { length: 5, symmetric: true }]) {
            const issues = padParams(makeBaseDocument(), params);
            expect(issues).toEqual([]);
        }
    });

    it('accepts non-blind ends without length and requires upToFace for the face end', () => {
        for (const end of ['upToFirst', 'upToLast', 'throughAll']) {
            expect(padParams(makeBaseDocument(), { end })).toEqual([]);
        }
        const faceEnd = makeBaseDocument();
        faceEnd.features.push({
            id: 'pad2',
            name: 'Second',
            type: 'pad',
            body: 'body-1',
            sketchId: 'sketch1',
            params: { end: 'upToFace', upToFace: goodFaceRef } as unknown as Record<string, number>,
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(faceEnd).valid).toBe(true);
    });

    it('rejects bad extrude ends, stray length, symmetric clashes, and missing face refs', () => {
        expect(padParams(makeBaseDocument(), { length: 5, end: 'sideways' }).some((i) => i.path === 'features[1].params.end')).toBe(true);
        expect(padParams(makeBaseDocument(), { end: 'throughAll', length: 5 }).some((i) => i.path === 'features[1].params.length')).toBe(
            true
        );
        expect(padParams(makeBaseDocument(), { end: 'upToFirst' }).some((i) => i.path === 'features[1].params.length')).toBe(false);
        const symmetric = padParams(makeBaseDocument(), { end: 'upToLast', symmetric: true });
        expect(symmetric.some((i) => i.path === 'features[1].params.symmetric')).toBe(true);
        const missingFace = padParams(makeBaseDocument(), { end: 'upToFace' });
        expect(missingFace.some((i) => i.path === 'features[1].params.upToFace')).toBe(true);
        const badTwoSided = padParams(makeBaseDocument(), { length: 5, twoSided: 'yes' });
        expect(badTwoSided.some((i) => i.path === 'features[1].params.twoSided')).toBe(true);
    });

    it('accepts threePoint, midplane, and line2Point datums', () => {
        const doc = makeBaseDocument();
        doc.datums.push(
            {
                id: 'd3',
                kind: 'threePoint',
                name: 'Three',
                points: [
                    [0, 0, 0],
                    [1, 0, 0],
                    [0, 1, 0]
                ]
            },
            { id: 'dm', kind: 'midplane', name: 'Mid', faces: [goodFaceRef, goodFaceRef] },
            {
                id: 'dl',
                kind: 'line2Point',
                name: 'Axis',
                points: [
                    [0, 0, 0],
                    [0, 0, 5]
                ]
            }
        );
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('rejects collinear threePoint, short midplane, and coincident line2Point datums', () => {
        const collinear = makeBaseDocument();
        collinear.datums.push({
            id: 'd3',
            kind: 'threePoint',
            name: 'Three',
            points: [
                [0, 0, 0],
                [1, 0, 0],
                [2, 0, 0]
            ]
        });
        let result = validateNukeCadDocument(collinear);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'datums[1].points')).toBe(true);

        const shortPoints = makeBaseDocument();
        shortPoints.datums.push({
            id: 'd3',
            kind: 'threePoint',
            name: 'Three',
            points: [
                [0, 0, 0],
                [1, 0, 0]
            ]
        });
        result = validateNukeCadDocument(shortPoints);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'datums[1].points')).toBe(true);

        const shortFaces = makeBaseDocument();
        shortFaces.datums.push({ id: 'dm', kind: 'midplane', name: 'Mid', faces: [goodFaceRef] });
        result = validateNukeCadDocument(shortFaces);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'datums[1].faces')).toBe(true);

        const coincident = makeBaseDocument();
        coincident.datums.push({
            id: 'dl',
            kind: 'line2Point',
            name: 'Axis',
            points: [
                [1, 1, 1],
                [1, 1, 1]
            ]
        });
        result = validateNukeCadDocument(coincident);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'datums[1].points')).toBe(true);
    });

    it('rejects sketches placed on a line datum but allows plane datums', () => {
        const doc = makeBaseDocument();
        doc.datums.push({
            id: 'dl',
            kind: 'line2Point',
            name: 'Axis',
            points: [
                [0, 0, 0],
                [0, 0, 5]
            ]
        });
        doc.sketches[0].datumId = 'dl';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'sketches[0].datumId')).toBe(true);

        const planeOk = makeBaseDocument();
        planeOk.datums.push({
            id: 'd3',
            kind: 'threePoint',
            name: 'Three',
            points: [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0]
            ]
        });
        planeOk.sketches[0].datumId = 'd3';
        expect(validateNukeCadDocument(planeOk).valid).toBe(true);
    });

    it('accepts counterdrill, taper, drill-point, and thread hole params', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'hole1',
            name: 'Hole',
            type: 'hole',
            body: 'body-1',
            params: {
                face: goodFaceRef,
                center: [0, 0],
                diameter: 0.5,
                depth: 2,
                counterdrillDiameter: 1,
                counterdrillDepth: 0.25,
                taperAngle: 5,
                drillPointAngle: 118,
                thread: 'cosmetic'
            },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('rejects counterdrill clashes and out-of-range hole params', () => {
        const clash = makeBaseDocument();
        clash.features.push({
            id: 'hole1',
            name: 'Hole',
            type: 'hole',
            body: 'body-1',
            params: {
                face: goodFaceRef,
                center: [0, 0],
                diameter: 0.5,
                counterboreDiameter: 1,
                counterboreDepth: 0.25,
                counterdrillDiameter: 1.2,
                counterdrillDepth: 0.3
            },
            suppressed: false,
            dependsOn: ['pad1']
        });
        let result = validateNukeCadDocument(clash);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.counterdrillDiameter')).toBe(true);

        for (const [key, value] of [
            ['taperAngle', 0],
            ['taperAngle', 45.5],
            ['drillPointAngle', 0],
            ['drillPointAngle', 180],
            ['thread', 'modeled']
        ] as const) {
            const doc = makeBaseDocument();
            doc.features.push({
                id: 'hole1',
                name: 'Hole',
                type: 'hole',
                body: 'body-1',
                params: { face: goodFaceRef, center: [0, 0], diameter: 0.5, [key]: value },
                suppressed: false,
                dependsOn: ['pad1']
            });
            result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === `features[1].params.${key}`)).toBe(true);
        }
    });

    it('accepts every primitive shape with its dimension arity', () => {
        const cases: [string, number[]][] = [
            ['box', [2, 3, 4]],
            ['cylinder', [1, 5]],
            ['sphere', [2]],
            ['cone', [1, 5]],
            ['torus', [5, 1]]
        ];
        for (const [shape, dimensions] of cases) {
            const doc = makeBaseDocument();
            doc.features.push({
                id: 'prim1',
                name: 'Primitive',
                type: 'primitive',
                body: 'body-1',
                params: { shape, dimensions },
                suppressed: false,
                dependsOn: ['pad1']
            });
            expect(validateNukeCadDocument(doc).valid).toBe(true);
        }
    });

    it('rejects bad primitive shapes, arities, dimensions, and datum refs', () => {
        const badShape = makeBaseDocument();
        badShape.features.push({
            id: 'prim1',
            name: 'Primitive',
            type: 'primitive',
            body: 'body-1',
            params: { shape: 'pyramid', dimensions: [1, 2, 3] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        let result = validateNukeCadDocument(badShape);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.shape')).toBe(true);

        const badArity = makeBaseDocument();
        badArity.features.push({
            id: 'prim1',
            name: 'Primitive',
            type: 'primitive',
            body: 'body-1',
            params: { shape: 'box', dimensions: [1, 2] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        result = validateNukeCadDocument(badArity);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.dimensions')).toBe(true);

        const badDim = makeBaseDocument();
        badDim.features.push({
            id: 'prim1',
            name: 'Primitive',
            type: 'primitive',
            body: 'body-1',
            params: { shape: 'sphere', dimensions: [-1] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        result = validateNukeCadDocument(badDim);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.dimensions[0]')).toBe(true);

        const badDatum = makeBaseDocument();
        badDatum.features.push({
            id: 'prim1',
            name: 'Primitive',
            type: 'primitive',
            body: 'body-1',
            params: { shape: 'sphere', dimensions: [1], datumId: 'missing' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        result = validateNukeCadDocument(badDatum);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.datumId')).toBe(true);
    });

    it('accepts pattern scale of 1 and rejects non-positive scales', () => {
        const scaled = makeBaseDocument();
        scaled.features.push({
            id: 'lin1',
            name: 'Scaled',
            type: 'linearPattern',
            body: 'body-1',
            params: { source: 'pad1', count: 3, spacing: 2, axis: 'x', scale: 1.5 },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(scaled).valid).toBe(true);

        for (const scale of [0, -2]) {
            const doc = makeBaseDocument();
            doc.features.push({
                id: 'lin1',
                name: 'Scaled',
                type: 'linearPattern',
                body: 'body-1',
                params: { source: 'pad1', count: 3, spacing: 2, axis: 'x', scale },
                suppressed: false,
                dependsOn: ['pad1']
            });
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === 'features[1].params.scale')).toBe(true);
        }
    });

    it('accepts a valid multiTransform and rejects missing or dangling sources', () => {
        const doc = makeBaseDocument();
        doc.features.push(
            {
                id: 'lin1',
                name: 'First',
                type: 'linearPattern',
                body: 'body-1',
                params: { source: 'pad1', count: 2, spacing: 3, axis: 'x' },
                suppressed: false,
                dependsOn: ['pad1']
            },
            {
                id: 'mir1',
                name: 'Second',
                type: 'mirror',
                body: 'body-1',
                params: { source: 'pad1', plane: 'XY' },
                suppressed: false,
                dependsOn: ['pad1']
            },
            {
                id: 'mt1',
                name: 'Combined',
                type: 'multiTransform',
                body: 'body-1',
                params: { first: 'lin1', second: 'mir1' },
                suppressed: false,
                dependsOn: ['lin1', 'mir1']
            }
        );
        expect(validateNukeCadDocument(doc).valid).toBe(true);

        const missing = makeBaseDocument();
        missing.features.push({
            id: 'mt1',
            name: 'Combined',
            type: 'multiTransform',
            body: 'body-1',
            params: { first: 'lin1' },
            suppressed: false,
            dependsOn: []
        });
        let result = validateNukeCadDocument(missing);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.second')).toBe(true);

        const dangling = makeBaseDocument();
        dangling.features.push({
            id: 'mt1',
            name: 'Combined',
            type: 'multiTransform',
            body: 'body-1',
            params: { first: 'lin1', second: 'ghost' },
            suppressed: false,
            dependsOn: []
        });
        result = validateNukeCadDocument(dangling);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.second')).toBe(true);
    });

    it('accepts defeature with faces and a draft neutral plane, rejecting empties', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'def1',
            name: 'Clean',
            type: 'defeature',
            body: 'body-1',
            params: { faces: [goodFaceRef] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(doc).valid).toBe(true);

        const empty = makeBaseDocument();
        empty.features.push({
            id: 'def1',
            name: 'Clean',
            type: 'defeature',
            body: 'body-1',
            params: { faces: [] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        let result = validateNukeCadDocument(empty);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.faces')).toBe(true);

        const draft = makeBaseDocument();
        draft.features.push({
            id: 'draft1',
            name: 'Draft',
            type: 'draft',
            body: 'body-1',
            params: { faces: [goodFaceRef], angle: 5, pullDirection: [0, 0, 1], neutralPlane: goodFaceRef },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(draft).valid).toBe(true);

        const badNeutral = makeBaseDocument();
        badNeutral.features.push({
            id: 'draft1',
            name: 'Draft',
            type: 'draft',
            body: 'body-1',
            params: { faces: [goodFaceRef], angle: 5, pullDirection: [0, 0, 1], neutralPlane: 'nope' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        result = validateNukeCadDocument(badNeutral);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.neutralPlane')).toBe(true);
    });

    it('accepts translate with a non-zero vector, rejecting bad ones', () => {
        const doc = makeBaseDocument();
        doc.features.push({
            id: 'mov1',
            name: 'Move down',
            type: 'translate',
            body: 'body-1',
            params: { vector: [0, 0, -5] },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(doc).valid).toBe(true);

        for (const vector of [undefined, [0, 0], [0, 0, 0], [1, Number.NaN, 0], 'down']) {
            const bad = makeBaseDocument();
            bad.features.push({
                id: 'mov1',
                name: 'Move down',
                type: 'translate',
                body: 'body-1',
                params: { vector },
                suppressed: false,
                dependsOn: ['pad1']
            });
            const result = validateNukeCadDocument(bad);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === 'features[1].params.vector')).toBe(true);
        }
    });

    it('still accepts legacy documents (no schema bump)', () => {
        const doc = makeBaseDocument();
        expect(validateNukeCadDocument(doc).valid).toBe(true);
        expect(NUKE_CAD_SCHEMA_VERSION).toBe(3);
    });
});

describe('wave A2 additive params (revolve ends, upToBody, subtractive, linear datum axis, modeled threads)', () => {
    function makeBaseDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'wave-a2',
            parameters: {},
            datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
            bodies: [
                { id: 'body-1', name: 'Body 1' },
                { id: 'body-2', name: 'Body 2' }
            ],
            sketches: [
                {
                    id: 'sketch1',
                    name: 'Profile',
                    datumId: 'xy',
                    primitives: [{ id: 'p1', type: 'point', x: 0, y: 0 }],
                    constraints: []
                }
            ],
            features: [
                {
                    id: 'pad1',
                    name: 'Base',
                    type: 'pad',
                    body: 'body-1',
                    sketchId: 'sketch1',
                    params: { length: 10 },
                    suppressed: false,
                    dependsOn: []
                }
            ],
            curves: []
        };
    }

    const goodFaceRef: TopologyRef = {
        featureId: 'pad1',
        kind: 'face',
        fingerprint: { surfaceType: 'plane', area: 100, center: [0, 0, 0], normal: [0, 0, 1] }
    };

    function pushFeature(doc: NukeCadDocument, type: NukeCadDocument['features'][number]['type'], params: Record<string, unknown>): void {
        doc.features.push({
            id: 'feat2',
            name: 'Second',
            type,
            body: 'body-1',
            sketchId: 'sketch1',
            params: params as unknown as Record<string, number>,
            suppressed: false,
            dependsOn: ['pad1']
        });
    }

    it('accepts blind (default) and throughAll revolve ends, rejecting anything else', () => {
        for (const params of [
            { axis: 'z', angle: 180 },
            { axis: 'z', angle: 180, end: 'blind' },
            { axis: 'z', angle: 180, end: 'throughAll' }
        ]) {
            const doc = makeBaseDocument();
            pushFeature(doc, 'revolve', params);
            expect(validateNukeCadDocument(doc).issues).toEqual([]);
        }
        const bad = makeBaseDocument();
        pushFeature(bad, 'groove', { axis: 'z', angle: 180, end: 'upToLast' });
        const result = validateNukeCadDocument(bad);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.end')).toBe(true);
    });

    it('accepts a non-empty upToBody on pad/pocket, rejecting empties and upToFace clashes', () => {
        const ok = makeBaseDocument();
        pushFeature(ok, 'pad', { end: 'upToLast', upToBody: 'body-2' });
        expect(validateNukeCadDocument(ok).valid).toBe(true);

        for (const upToBody of ['', 42]) {
            const doc = makeBaseDocument();
            pushFeature(doc, 'pocket', { end: 'upToFirst', upToBody });
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === 'features[1].params.upToBody')).toBe(true);
        }

        const clash = makeBaseDocument();
        pushFeature(clash, 'pad', { end: 'upToFace', upToFace: goodFaceRef, upToBody: 'body-2' });
        const clashResult = validateNukeCadDocument(clash);
        expect(clashResult.valid).toBe(false);
        expect(clashResult.issues.some((i) => i.path === 'features[1].params.upToBody')).toBe(true);
    });

    it('rejects an upToBody naming an unknown body', () => {
        const doc = makeBaseDocument();
        pushFeature(doc, 'pad', { end: 'upToLast', upToBody: 'ghost-body' });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.upToBody')).toBe(true);
    });

    it('accepts subtractive flags on primitive and helicalSweep, rejecting non-booleans', () => {
        const prim = makeBaseDocument();
        pushFeature(prim, 'primitive', { shape: 'box', dimensions: [1, 2, 3], subtractive: true });
        expect(validateNukeCadDocument(prim).valid).toBe(true);

        const helix = makeBaseDocument();
        pushFeature(helix, 'helicalSweep', {
            axis: 'Z',
            startRadius: 2,
            pitch: 1,
            turns: 3,
            orientation: 'frenet',
            subtractive: true
        });
        expect(validateNukeCadDocument(helix).valid).toBe(true);

        const bad = makeBaseDocument();
        pushFeature(bad, 'primitive', { shape: 'box', dimensions: [1, 2, 3], subtractive: 'yes' });
        const result = validateNukeCadDocument(bad);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.subtractive')).toBe(true);
    });

    it('accepts a linear pattern on axisDatumId alone, mirroring the circular messages', () => {
        const doc = makeBaseDocument();
        doc.datums.push({
            id: 'dl',
            kind: 'line2Point',
            name: 'Axis',
            points: [
                [0, 0, 0],
                [0, 0, 5]
            ]
        });
        pushFeature(doc, 'linearPattern', { source: 'pad1', count: 3, spacing: 2, axisDatumId: 'dl' });
        expect(validateNukeCadDocument(doc).valid).toBe(true);

        const missing = makeBaseDocument();
        pushFeature(missing, 'linearPattern', { source: 'pad1', count: 3, spacing: 2 });
        const missingResult = validateNukeCadDocument(missing);
        expect(missingResult.valid).toBe(false);
        expect(missingResult.issues.some((i) => i.path === 'features[1].params.axis')).toBe(true);

        const clash = makeBaseDocument();
        pushFeature(clash, 'linearPattern', { source: 'pad1', count: 3, spacing: 2, axis: 'x', axisDatumId: 'dl' });
        const clashResult = validateNukeCadDocument(clash);
        expect(clashResult.valid).toBe(false);
        expect(clashResult.issues.some((i) => i.path === 'features[1].params.axis')).toBe(true);
    });

    it('rejects a linear pattern naming an unknown axis datum', () => {
        const doc = makeBaseDocument();
        pushFeature(doc, 'linearPattern', { source: 'pad1', count: 3, spacing: 2, axisDatumId: 'ghost' });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.axisDatumId')).toBe(true);
    });

    it('accepts rectangular and hexagonal lattices, rejecting bad extents/gating/caps', () => {
        const rect = makeBaseDocument();
        pushFeature(rect, 'lattice', { source: 'pad1', latticeType: 'rectangular', rows: 2, cols: 3, pitch: 10 });
        expect(validateNukeCadDocument(rect).valid).toBe(true);

        const hex = makeBaseDocument();
        pushFeature(hex, 'lattice', { source: 'pad1', latticeType: 'hexagonal', rings: 1, pitch: 10, orientation: 'flatTop' });
        expect(validateNukeCadDocument(hex).valid).toBe(true);

        const badCases: [Record<string, unknown>, string][] = [
            // rows/cols XOR rings
            [{ source: 'pad1', latticeType: 'rectangular', rows: 2, cols: 2, rings: 1 }, 'features[1].params.rings'],
            [{ source: 'pad1', latticeType: 'rectangular', rows: 2, pitch: 1 }, 'features[1].params.rows'],
            [{ source: 'pad1', latticeType: 'rectangular', pitch: 1 }, 'features[1].params.rows'],
            [{ source: 'pad1', latticeType: 'rectangular', rows: 0, cols: 2, pitch: 1 }, 'features[1].params.rows'],
            // gating
            [{ source: 'pad1', latticeType: 'hexagonal', rows: 2, cols: 2, pitch: 1, pitchY: 2 }, 'features[1].params.pitchY'],
            [
                { source: 'pad1', latticeType: 'rectangular', rows: 2, cols: 2, pitch: 1, orientation: 'flatTop' },
                'features[1].params.orientation'
            ],
            // numerics + cap
            [{ source: 'pad1', latticeType: 'rectangular', rows: 2, cols: 2, pitch: 0 }, 'features[1].params.pitch'],
            [{ source: 'pad1', latticeType: 'rectangular', rows: 51, cols: 51, pitch: 1 }, 'features[1].params.rows'],
            // dangling refs
            [{ source: 'ghost', latticeType: 'rectangular', rows: 1, cols: 1, pitch: 1 }, 'features[1].params.source'],
            [{ source: 'pad1', latticeType: 'rectangular', rows: 1, cols: 1, pitch: 1, datumId: 'ghost' }, 'features[1].params.datumId']
        ];
        for (const [params, path] of badCases) {
            const doc = makeBaseDocument();
            pushFeature(doc, 'lattice', params);
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === path)).toBe(true);
        }
    });

    it('rejects a lattice on a line datum, like sketches', () => {
        const doc = makeBaseDocument();
        doc.datums.push({
            id: 'dl',
            kind: 'line2Point',
            name: 'Axis',
            points: [
                [0, 0, 0],
                [0, 0, 5]
            ]
        });
        pushFeature(doc, 'lattice', { source: 'pad1', latticeType: 'rectangular', rows: 1, cols: 1, pitch: 1, datumId: 'dl' });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.datumId')).toBe(true);
    });

    it('keeps lattice additive at schema v3 (no migration)', () => {
        expect(NUKE_CAD_SCHEMA_VERSION).toBe(3);
        const doc = makeBaseDocument();
        pushFeature(doc, 'lattice', { source: 'pad1', latticeType: 'rectangular', rows: 1, cols: 1, pitch: 1 });
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(validateNukeCadDocument(round).valid).toBe(true);
        expect(migrateNukeCadDocument(round).migratedFrom).toBeUndefined();
    });

    it('accepts modeled threads on blind simple holes, rejecting through and expanded holes', () => {
        const ok = makeBaseDocument();
        ok.features.push({
            id: 'hole1',
            name: 'Threaded',
            type: 'hole',
            body: 'body-1',
            params: { face: goodFaceRef, center: [0, 0], diameter: 0.5, depth: 3, thread: 'modeled' },
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(validateNukeCadDocument(ok).valid).toBe(true);

        const cases: Record<string, unknown>[] = [
            { face: goodFaceRef, center: [0, 0], diameter: 0.5, thread: 'modeled' },
            {
                face: goodFaceRef,
                center: [0, 0],
                diameter: 0.5,
                depth: 3,
                counterboreDiameter: 1,
                counterboreDepth: 0.5,
                thread: 'modeled'
            },
            { face: goodFaceRef, center: [0, 0], diameter: 0.5, depth: 3, taperAngle: 5, thread: 'modeled' }
        ];
        for (const params of cases) {
            const doc = makeBaseDocument();
            doc.features.push({
                id: 'hole1',
                name: 'Threaded',
                type: 'hole',
                body: 'body-1',
                params: params as unknown as Record<string, number>,
                suppressed: false,
                dependsOn: ['pad1']
            });
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === 'features[1].params.thread')).toBe(true);
        }
    });
});

describe('import feature validation (additive v3)', () => {
    const SOURCE_HASH = 'a'.repeat(64);

    function importParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            sourcePath: './w7x.parts/source.step',
            sourceHash: SOURCE_HASH,
            sourceSize: 1024,
            selection: { mode: 'all' },
            ...overrides
        };
    }

    function importDocument(overrides: Record<string, unknown> = {}): NukeCadDocument {
        const doc = makeDocument();
        doc.features.push({
            id: 'imp1',
            name: 'Imported Coil',
            type: 'import',
            body: 'body-1',
            params: importParams(overrides) as unknown as NukeCadDocument['features'][number]['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        return doc;
    }

    it('accepts a hand-written v3 import feature and round-trips it through JSON', () => {
        expect(NUKE_CAD_SCHEMA_VERSION).toBe(3);
        const doc = importDocument();
        expect(validateNukeCadDocument(doc).valid).toBe(true);

        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        const result = validateNukeCadDocument(round);
        expect(result.valid).toBe(true);
        expect(round.features[1].params).toEqual(doc.features[1].params);
        expect(round.features[1].type).toBe('import');
        expect(migrateNukeCadDocument(round).migratedFrom).toBeUndefined();
    });

    it('accepts the full optional surface (selection, placement, format, unit, cap)', () => {
        const doc = importDocument({
            sourcePath: '/absolute/coils.step',
            sourceFormat: 'step',
            sourceUnit: 'm',
            maxSolids: 50,
            selection: {
                mode: 'solids',
                solids: [{ index: 1, signature: { faceCount: 24, volume: 3.5 } }, { index: 3 }]
            },
            placement: { translate: [1, 2, 3], rotateDegrees: [0, 45, 90] }
        });
        expect(validateNukeCadDocument(doc).issues).toEqual([]);
    });

    it('rejects malformed import params with a precise path', () => {
        const cases: Array<[string, Record<string, unknown>, string]> = [
            ['empty sourcePath', { sourcePath: '' }, 'features[1].params.sourcePath'],
            ['non-string sourcePath', { sourcePath: 3 }, 'features[1].params.sourcePath'],
            ['uppercase hash', { sourceHash: 'A'.repeat(64) }, 'features[1].params.sourceHash'],
            ['short hash', { sourceHash: 'abc' }, 'features[1].params.sourceHash'],
            ['zero size', { sourceSize: 0 }, 'features[1].params.sourceSize'],
            ['fractional size', { sourceSize: 1.5 }, 'features[1].params.sourceSize'],
            ['unknown format', { sourceFormat: 'stl' }, 'features[1].params.sourceFormat'],
            ['unknown unit', { sourceUnit: 'in' }, 'features[1].params.sourceUnit'],
            ['unknown selection mode', { selection: { mode: 'some' } }, 'features[1].params.selection.mode'],
            ['empty solids', { selection: { mode: 'solids', solids: [] } }, 'features[1].params.selection.solids'],
            ['zero index', { selection: { mode: 'solids', solids: [{ index: 0 }] } }, 'features[1].params.selection.solids[0].index'],
            [
                'duplicate index',
                { selection: { mode: 'solids', solids: [{ index: 2 }, { index: 2 }] } },
                'features[1].params.selection.solids[1].index'
            ],
            [
                'zero face count',
                { selection: { mode: 'solids', solids: [{ index: 1, signature: { faceCount: 0, volume: 1 } }] } },
                'features[1].params.selection.solids[0].signature.faceCount'
            ],
            [
                'non-finite volume',
                { selection: { mode: 'solids', solids: [{ index: 1, signature: { faceCount: 4, volume: Infinity } }] } },
                'features[1].params.selection.solids[0].signature.volume'
            ],
            ['short translate', { placement: { translate: [1, 2] } }, 'features[1].params.placement.translate'],
            ['non-finite rotation', { placement: { rotateDegrees: [0, 0, Number.NaN] } }, 'features[1].params.placement.rotateDegrees'],
            ['zero maxSolids', { maxSolids: 0 }, 'features[1].params.maxSolids'],
            ['fractional maxSolids', { maxSolids: 2.5 }, 'features[1].params.maxSolids']
        ];
        for (const [label, overrides, path] of cases) {
            const result = validateNukeCadDocument(importDocument(overrides));
            expect(result.valid, label).toBe(false);
            expect(
                result.issues.map((issue) => issue.path),
                label
            ).toContain(path);
        }
    });

    it('requires a selection block', () => {
        const doc = importDocument();
        const params = doc.features[1].params as Record<string, unknown>;
        delete params.selection;
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[1].params.selection')).toBe(true);
    });
});

describe('assembly section (additive v3)', () => {
    function makeAssemblyDocument(): NukeCadDocument {
        const doc = makeDocument();
        doc.assembly = {
            instances: [
                { id: 'base', part: 'body:body-1', placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] } },
                { id: 'arm', part: './arm.nuke-cad', placement: { position: [5, 0, 0], orientation: [0, 0, 0, 1] } }
            ],
            connectors: [
                { id: 'c-base', instanceId: 'base', origin: [1, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] },
                { id: 'c-arm', instanceId: 'arm', origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }
            ],
            mates: [{ id: 'm1', type: 'fixed', instanceA: 'base', connectorA: 'c-base', instanceB: 'arm', connectorB: 'c-arm' }],
            groundedInstanceId: 'base'
        };
        return doc;
    }

    it('absent assembly stays a valid single-part document', () => {
        const doc = makeDocument();
        expect(doc.assembly).toBeUndefined();
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('round-trips a grounded assembly through JSON at schema v3', () => {
        const doc = makeAssemblyDocument();
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(round.version).toBe(NUKE_CAD_SCHEMA_VERSION);
        const result = validateNukeCadDocument(round);
        expect(result.valid).toBe(true);
        expect(round.assembly?.groundedInstanceId).toBe('base');
    });

    it('treats an empty groundedInstanceId as single-part', () => {
        const doc = makeAssemblyDocument();
        doc.assembly!.groundedInstanceId = '';
        expect(validateNukeCadDocument(doc).valid).toBe(true);
    });

    it('delegates structural issues with assembly-prefixed paths', () => {
        const doc = makeAssemblyDocument();
        doc.assembly!.groundedInstanceId = 'missing';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'assembly.groundedInstanceId')).toBe(true);
    });

    it('rejects a second mate on the same part pair', () => {
        const doc = makeAssemblyDocument();
        doc.assembly!.mates.push({
            id: 'm2',
            type: 'revolute',
            instanceA: 'arm',
            connectorA: 'c-arm',
            instanceB: 'base',
            connectorB: 'c-base'
        });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'assembly.mates[1]')).toBe(true);
    });
});

describe('overlap check gate (additive v3)', () => {
    it('defaults to enabled and accepts explicit booleans', () => {
        const doc = makeDocument();
        expect(doc.overlapCheck).toBeUndefined();
        expect(validateNukeCadDocument(doc).valid).toBe(true);
        expect(validateNukeCadDocument({ ...doc, overlapCheck: true }).valid).toBe(true);
        expect(validateNukeCadDocument({ ...doc, overlapCheck: false }).valid).toBe(true);
        // Additive: no version bump and no migration step.
        expect(migrateNukeCadDocument({ ...doc, overlapCheck: false }).migratedFrom).toBeUndefined();
    });

    it('round-trips through JSON with the document', () => {
        const doc = { ...makeDocument(), overlapCheck: false };
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(round.overlapCheck).toBe(false);
        expect(validateNukeCadDocument(round).valid).toBe(true);
    });

    it('rejects non-boolean values at the top-level field path', () => {
        for (const value of ['false', 0, 1, null, {}]) {
            const doc = { ...makeDocument(), overlapCheck: value } as unknown as NukeCadDocument;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, String(value)).toBe(false);
            expect(result.issues.map((i) => i.path)).toContain('overlapCheck');
        }
    });
});

describe('W7-X coil design study (additive v3)', () => {
    function makeDesignStudy(moduleCount: 4 | 5 | 6 = 4): W7xCoilStudy {
        return {
            kind: 'w7x-coil-study',
            report: {
                moduleCount,
                valid: moduleCount === 5,
                pitchDeg: 360 / moduleCount,
                moduleSpanDeg: 65.3402,
                uncoveredSectorDeg: moduleCount === 4 ? 24.6598 : 0,
                moduleOverlapDeg: moduleCount === 6 ? 5.3402 : 0,
                ...(moduleCount === 5 ? { minCoilClearanceM: 0.102807 } : {}),
                coilCoilOverlaps:
                    moduleCount === 6
                        ? [
                              { a: 'coil_0', b: 'coil_7', volumeM3: 0.072756 },
                              { a: 'coil_0', b: 'coil_8', volumeM3: 0.01984 }
                          ]
                        : [],
                coilShellOverlaps:
                    moduleCount === 4
                        ? [
                              { coil: 'coil_0', shell: 'plasma', volumeM3: 0.072624 },
                              { coil: 'coil_0', shell: 'vessel', volumeM3: 0.022858 }
                          ]
                        : [],
                summary: `${moduleCount}-module W7-X coil-count study`
            }
        };
    }

    function studyDocument(moduleCount: 4 | 5 | 6 = 4): NukeCadDocument {
        const doc = makeDocument();
        doc.designStudy = makeDesignStudy(moduleCount);
        return doc;
    }

    function reportOf(doc: NukeCadDocument): Record<string, unknown> {
        return doc.designStudy!.report as unknown as Record<string, unknown>;
    }

    it('accepts 4-, 5-, and 6-module studies without a version bump or migration', () => {
        for (const moduleCount of [4, 5, 6] as const) {
            const doc = makeDocument();
            doc.designStudy = makeDesignStudy(moduleCount);
            expect(doc.version).toBe(NUKE_CAD_SCHEMA_VERSION);
            expect(validateNukeCadDocument(doc).valid, String(moduleCount)).toBe(true);
            expect(migrateNukeCadDocument(doc).migratedFrom).toBeUndefined();
        }
    });

    it('accepts an absent designStudy as a normal document', () => {
        expect(makeDocument().designStudy).toBeUndefined();
        expect(validateNukeCadDocument(makeDocument()).valid).toBe(true);
    });

    it('round-trips the nested report through JSON', () => {
        const doc = studyDocument();
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(validateNukeCadDocument(round).valid).toBe(true);
        expect(round.designStudy).toEqual(doc.designStudy);
        expect((round.designStudy as W7xCoilStudy).report.coilShellOverlaps[1]).toEqual({
            coil: 'coil_0',
            shell: 'vessel',
            volumeM3: 0.022858
        });
    });

    it('rejects an unknown kind and non-object blocks', () => {
        for (const value of [null, 'w7x-coil-study', [], {}]) {
            const doc = makeDocument();
            doc.designStudy = value as unknown as W7xCoilStudy;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, String(value)).toBe(false);
            expect(result.issues.some((i) => i.path === 'designStudy' || i.path.startsWith('designStudy.'))).toBe(true);
        }
        const wrongKind = studyDocument();
        (wrongKind.designStudy as unknown as Record<string, unknown>).kind = 'w7x-study';
        expect(validateNukeCadDocument(wrongKind).issues.map((i) => i.path)).toContain('designStudy.kind');
    });

    it('rejects module counts outside 4/5/6', () => {
        for (const moduleCount of [3, 7, 4.5, '4', null]) {
            const doc = studyDocument();
            reportOf(doc).moduleCount = moduleCount;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, String(moduleCount)).toBe(false);
            expect(result.issues.map((i) => i.path)).toContain('designStudy.report.moduleCount');
        }
    });

    it('rejects non-finite report numbers and a non-boolean validity flag', () => {
        for (const field of ['pitchDeg', 'moduleSpanDeg', 'uncoveredSectorDeg', 'moduleOverlapDeg'] as const) {
            const doc = studyDocument();
            reportOf(doc)[field] = Number.POSITIVE_INFINITY;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, field).toBe(false);
            expect(result.issues.map((i) => i.path)).toContain(`designStudy.report.${field}`);
        }
        const clearance = studyDocument();
        reportOf(clearance).minCoilClearanceM = Number.NaN;
        expect(validateNukeCadDocument(clearance).issues.map((i) => i.path)).toContain('designStudy.report.minCoilClearanceM');
        // Optional clearance may be absent.
        const noClearance = studyDocument();
        delete reportOf(noClearance).minCoilClearanceM;
        expect(validateNukeCadDocument(noClearance).valid).toBe(true);
        const valid = studyDocument();
        reportOf(valid).valid = 'yes';
        expect(validateNukeCadDocument(valid).issues.map((i) => i.path)).toContain('designStudy.report.valid');
    });

    it('rejects malformed overlap arrays and entries', () => {
        const notArray = studyDocument();
        reportOf(notArray).coilCoilOverlaps = {};
        expect(validateNukeCadDocument(notArray).issues.map((i) => i.path)).toContain('designStudy.report.coilCoilOverlaps');

        const missingB = studyDocument(6);
        const coilEntries = reportOf(missingB).coilCoilOverlaps as Record<string, unknown>[];
        delete coilEntries[0].b;
        expect(validateNukeCadDocument(missingB).issues.map((i) => i.path)).toContain('designStudy.report.coilCoilOverlaps[0].b');

        const badVolume = studyDocument();
        const shellEntries = reportOf(badVolume).coilShellOverlaps as Record<string, unknown>[];
        shellEntries[0].volumeM3 = 'big';
        expect(validateNukeCadDocument(badVolume).issues.map((i) => i.path)).toContain('designStudy.report.coilShellOverlaps[0].volumeM3');

        const notObject = studyDocument();
        (reportOf(notObject).coilShellOverlaps as unknown[])[1] = 7;
        expect(validateNukeCadDocument(notObject).issues.map((i) => i.path)).toContain('designStudy.report.coilShellOverlaps[1]');
    });

    it('requires a non-empty summary string', () => {
        for (const summary of ['', '   ', 42]) {
            const doc = studyDocument();
            reportOf(doc).summary = summary;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, String(summary)).toBe(false);
            expect(result.issues.map((i) => i.path)).toContain('designStudy.report.summary');
        }
    });
});

describe('W7-X native coil shape study (additive v3)', () => {
    function makeShapeStudy(): W7xCoilShapeStudy {
        return {
            kind: 'w7x-coil-shape-study',
            report: {
                moduleCount: 5,
                coilCount: 50,
                bodyCount: 10,
                sectionWidthM: 0.37,
                sectionHeightM: 0.37,
                sectionTiltDeg: 8.6,
                twistDeg: 0,
                stations: 60,
                referenceVolumeM3: 27.608505577,
                summary: '10 native sweep bodies x 5 modules; approximate reference B-reps; simulation export disabled.'
            }
        };
    }

    function shapeStudyDocument(): NukeCadDocument {
        const doc = makeDocument();
        doc.designStudy = makeShapeStudy();
        return doc;
    }

    function reportOf(doc: NukeCadDocument): Record<string, unknown> {
        return doc.designStudy!.report as unknown as Record<string, unknown>;
    }

    it('accepts the marker without a version bump or migration', () => {
        const doc = shapeStudyDocument();
        expect(doc.version).toBe(NUKE_CAD_SCHEMA_VERSION);
        expect(validateNukeCadDocument(doc).valid).toBe(true);
        expect(migrateNukeCadDocument(doc).migratedFrom).toBeUndefined();
    });

    it('accepts either design-study kind on the same document type', () => {
        const countStudy: W7xCoilStudy = {
            kind: 'w7x-coil-study',
            report: {
                moduleCount: 5,
                valid: true,
                pitchDeg: 72,
                moduleSpanDeg: 65.3402,
                uncoveredSectorDeg: 0,
                moduleOverlapDeg: 0,
                minCoilClearanceM: 0.102807,
                coilCoilOverlaps: [],
                coilShellOverlaps: [],
                summary: '5-module W7-X coil-count study'
            }
        };
        const countDoc = makeDocument();
        countDoc.designStudy = countStudy;
        expect(validateNukeCadDocument(countDoc).valid).toBe(true);
        expect(validateW7xDesignStudy(countStudy).valid).toBe(true);
        expect(validateW7xDesignStudy(makeShapeStudy()).valid).toBe(true);
    });

    it('round-trips through JSON', () => {
        const doc = shapeStudyDocument();
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(validateNukeCadDocument(round).valid).toBe(true);
        expect(round.designStudy).toEqual(doc.designStudy);
    });

    it('requires the locked 5 modules / 50 coils / 10 bodies counts', () => {
        const cases: [string, unknown, string][] = [
            ['moduleCount', 4, 'designStudy.report.moduleCount'],
            ['coilCount', 45, 'designStudy.report.coilCount'],
            ['bodyCount', 9, 'designStudy.report.bodyCount']
        ];
        for (const [field, value, path] of cases) {
            const doc = shapeStudyDocument();
            reportOf(doc)[field] = value;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, field).toBe(false);
            expect(result.issues.map((i) => i.path)).toContain(path);
        }
    });

    it('requires positive finite section dimensions and reference volume', () => {
        for (const field of ['sectionWidthM', 'sectionHeightM', 'referenceVolumeM3'] as const) {
            for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.37']) {
                const doc = shapeStudyDocument();
                reportOf(doc)[field] = value;
                const result = validateNukeCadDocument(doc);
                expect(result.valid, `${field}=${String(value)}`).toBe(false);
                expect(result.issues.map((i) => i.path)).toContain(`designStudy.report.${field}`);
            }
        }
    });

    it('requires finite tilt/twist and integer stations in [8, 720]', () => {
        for (const field of ['sectionTiltDeg', 'twistDeg'] as const) {
            const doc = shapeStudyDocument();
            reportOf(doc)[field] = Number.NaN;
            expect(validateNukeCadDocument(doc).issues.map((i) => i.path)).toContain(`designStudy.report.${field}`);
        }
        for (const stations of [7, 721, 8.5, '60', null]) {
            const doc = shapeStudyDocument();
            reportOf(doc).stations = stations;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, String(stations)).toBe(false);
            expect(result.issues.map((i) => i.path)).toContain('designStudy.report.stations');
        }
    });

    it('requires a non-empty summary and rejects an unknown kind', () => {
        for (const summary of ['', '   ', 42]) {
            const doc = shapeStudyDocument();
            reportOf(doc).summary = summary;
            const result = validateNukeCadDocument(doc);
            expect(result.valid, String(summary)).toBe(false);
            expect(result.issues.map((i) => i.path)).toContain('designStudy.report.summary');
        }
        const wrongKind = shapeStudyDocument();
        (wrongKind.designStudy as unknown as Record<string, unknown>).kind = 'w7x-shape-study';
        expect(validateNukeCadDocument(wrongKind).issues.map((i) => i.path)).toContain('designStudy.kind');
        expect(validateW7xDesignStudy({ kind: 'w7x-shape-study', report: {} }).valid).toBe(false);
    });

    it('rejects malformed shape-study blocks without weakening the count-study check', () => {
        for (const value of [null, 'w7x-coil-shape-study', [], {}]) {
            const doc = makeDocument();
            doc.designStudy = value as unknown as W7xCoilShapeStudy;
            expect(validateNukeCadDocument(doc).valid, String(value)).toBe(false);
        }
        const countDoc = makeDocument();
        countDoc.designStudy = { kind: 'w7x-coil-study', report: { moduleCount: 7 } } as unknown as W7xCoilStudy;
        expect(validateNukeCadDocument(countDoc).issues.map((i) => i.path)).toContain('designStudy.report.moduleCount');
    });
});
