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
import { NUKE_CAD_SCHEMA_VERSION, type FeatureDef, type FeatureParams, type FeatureType, type NukeCadDocument } from './cad-document';
import type { TopologyRef } from './topology-refs';
import {
    CAD_FEATURE_EDIT_LIMIT,
    prepareFeatureEdit,
    type EditableFeatureParam,
    type FeatureParamChange,
    type PreparedFeatureEdit
} from './cad-feature-edit';

const EDGE: TopologyRef = {
    featureId: 'pad1',
    kind: 'edge',
    fingerprint: {
        curveType: 'line',
        length: 10,
        start: [0, 0, 0],
        end: [10, 0, 0]
    }
};

function makeFeature(id: string, type: FeatureType, params: FeatureParams, name = id): FeatureDef {
    return { id, name, type, body: 'body-1', params, suppressed: false, dependsOn: [] };
}

function makeDocument(features: FeatureDef[]): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'Feature edit test',
        parameters: { width: 10 },
        datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Base' }],
        sketches: [],
        features,
        curves: []
    };
}

function change(featureId: string, param: EditableFeatureParam, value: number): FeatureParamChange {
    return { featureId, param, value };
}

function expectAccepted(document: NukeCadDocument, changes: readonly FeatureParamChange[]): PreparedFeatureEdit {
    const result = prepareFeatureEdit(document, changes);
    if (!result.ok) {
        throw new Error(`Expected the edit to succeed: ${result.message}`);
    }
    return result.result;
}

function expectRejected(document: NukeCadDocument, changes: readonly FeatureParamChange[], pattern: RegExp): void {
    const result = prepareFeatureEdit(document, changes);
    if (result.ok) {
        throw new Error('Expected the edit to be rejected');
    }
    expect(result.message).toMatch(pattern);
}

function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
        for (const child of Object.values(value as Record<string, unknown>)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function pads(count: number): FeatureDef[] {
    return Array.from({ length: count }, (_, index) => makeFeature(`pad${index}`, 'pad', { length: index + 1 }, `Pad ${index}`));
}

describe('prepareFeatureEdit', () => {
    it('edits pad length when end is absent', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 }, 'Base')]);
        const result = expectAccepted(doc, [change('pad1', 'length', 5)]);

        expect(result.afterDocument.features[0].params).toEqual({ length: 5 });
        expect(result.edits).toEqual([{ featureId: 'pad1', featureType: 'pad', param: 'length', before: 2, after: 5 }]);
    });

    it('edits pocket length for default and blind ends', () => {
        const doc = makeDocument([
            makeFeature('default-pocket', 'pocket', { length: 3 }),
            makeFeature('blind-pocket', 'pocket', { length: 2, end: 'blind' })
        ]);
        const result = expectAccepted(doc, [change('default-pocket', 'length', 4), change('blind-pocket', 'length', 6)]);

        expect(result.afterDocument.features[0].params).toEqual({ length: 4 });
        expect(result.afterDocument.features[1].params).toEqual({ length: 6, end: 'blind' });
        expect(result.edits.map((edit) => edit.before)).toEqual([3, 2]);
        expect(result.edits.map((edit) => edit.after)).toEqual([4, 6]);
    });

    it.each(['upToFirst', 'upToLast', 'upToFace', 'throughAll'] as const)('rejects pocket length when end is %s', (end) => {
        const doc = makeDocument([makeFeature('pocket1', 'pocket', { length: 2, end })]);
        expectRejected(doc, [change('pocket1', 'length', 4)], /only change for blind/);
    });

    it('rejects pad length when the end condition is not blind', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2, end: 'throughAll' })]);
        expectRejected(doc, [change('pad1', 'length', 4)], /only change for blind/);
    });

    it('edits revolve and groove angles, including the 360 degree maximum', () => {
        const doc = makeDocument([
            makeFeature('revolve1', 'revolve', { axis: 'z', angle: 90 }),
            makeFeature('groove1', 'groove', { axis: 'x', angle: 180 })
        ]);
        const result = expectAccepted(doc, [change('revolve1', 'angle', 360), change('groove1', 'angle', 270)]);

        expect(result.afterDocument.features[0].params).toEqual({ axis: 'z', angle: 360 });
        expect(result.afterDocument.features[1].params).toEqual({ axis: 'x', angle: 270 });
        expect(result.edits.map((edit) => edit.featureType)).toEqual(['revolve', 'groove']);
        expect(result.edits.map((edit) => edit.param)).toEqual(['angle', 'angle']);
    });

    it('rejects an angle above 360 degrees', () => {
        const doc = makeDocument([makeFeature('revolve1', 'revolve', { axis: 'z', angle: 90 })]);
        expectRejected(doc, [change('revolve1', 'angle', 360.1)], /at most 360/);
    });

    it('edits a fillet radius when edges are present', () => {
        const doc = makeDocument([makeFeature('fillet1', 'fillet', { edges: [EDGE], radius: 0.5 }, 'Edge fillet')]);
        const result = expectAccepted(doc, [change('fillet1', 'radius', 2)]);

        expect(result.afterDocument.features[0].params).toEqual({ edges: [EDGE], radius: 2 });
        expect(result.edits).toEqual([{ featureId: 'fillet1', featureType: 'fillet', param: 'radius', before: 0.5, after: 2 }]);
    });

    it('rejects a fillet radius without a non-empty edges array', () => {
        const emptyEdges = makeDocument([makeFeature('fillet1', 'fillet', { edges: [], radius: 1 })]);
        expectRejected(emptyEdges, [change('fillet1', 'radius', 2)], /non-empty edges/);

        const missingEdges = makeDocument([makeFeature('fillet1', 'fillet', { radius: 1 })]);
        expectRejected(missingEdges, [change('fillet1', 'radius', 2)], /non-empty edges/);
    });

    it('edits shell thickness', () => {
        const doc = makeDocument([makeFeature('shell1', 'shell', { faces: [], thickness: 1 }, 'Hollow')]);
        const result = expectAccepted(doc, [change('shell1', 'thickness', 2.5)]);

        expect(result.afterDocument.features[0].params).toEqual({ faces: [], thickness: 2.5 });
        expect(result.edits).toEqual([{ featureId: 'shell1', featureType: 'shell', param: 'thickness', before: 1, after: 2.5 }]);
    });

    it('rejects an empty change list', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 })]);
        expectRejected(doc, [], /No feature parameter changes/);
    });

    it('accepts exactly the edit limit and rejects one more', () => {
        const limitDoc = makeDocument(pads(CAD_FEATURE_EDIT_LIMIT));
        const accepted = expectAccepted(
            limitDoc,
            limitDoc.features.map((feature, index) => change(feature.id, 'length', index + 2))
        );
        expect(accepted.edits).toHaveLength(CAD_FEATURE_EDIT_LIMIT);
        expect(accepted.changes).toHaveLength(CAD_FEATURE_EDIT_LIMIT);

        const overLimitDoc = makeDocument(pads(CAD_FEATURE_EDIT_LIMIT + 1));
        expectRejected(
            overLimitDoc,
            overLimitDoc.features.map((feature, index) => change(feature.id, 'length', index + 2)),
            /at most 16/
        );
    });

    it('rejects duplicate feature/parameter pairs', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 })]);
        expectRejected(doc, [change('pad1', 'length', 3), change('pad1', 'length', 4)], /Duplicate change/);
    });

    it('rejects an unknown feature id', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 })]);
        expectRejected(doc, [change('missing', 'length', 3)], /Unknown feature 'missing'/);
    });

    it('rejects a feature type outside the allowlist', () => {
        const doc = makeDocument([makeFeature('mirror1', 'mirror', { source: 'pad1', plane: 'XY' })]);
        expectRejected(doc, [change('mirror1', 'angle', 45)], /has no editable parameters/);
    });

    it('rejects a parameter that does not belong to the feature type', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 })]);
        expectRejected(doc, [change('pad1', 'angle', 45)], /edits length, not 'angle'/);
    });

    it('rejects non-number and non-finite values', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 })]);
        const invalidValues: unknown[] = ['3', true, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
        for (const value of invalidValues) {
            expectRejected(doc, [{ featureId: 'pad1', param: 'length', value: value as number }], /must be a finite number/);
        }
    });

    it('rejects non-positive values for every editable parameter', () => {
        const cases: Array<{ type: FeatureType; params: FeatureParams; param: EditableFeatureParam; value: number }> = [
            { type: 'pad', params: { length: 2 }, param: 'length', value: 0 },
            { type: 'revolve', params: { axis: 'z', angle: 90 }, param: 'angle', value: -45 },
            { type: 'fillet', params: { edges: [EDGE], radius: 1 }, param: 'radius', value: 0 },
            { type: 'shell', params: { faces: [], thickness: 1 }, param: 'thickness', value: -2 },
            { type: 'chamfer', params: { edges: [EDGE], distance: 1 }, param: 'distance', value: 0 },
            { type: 'hole', params: { face: EDGE, center: [0, 0], diameter: 2, depth: 3 }, param: 'diameter', value: -1 },
            { type: 'hole', params: { face: EDGE, center: [0, 0], diameter: 2, depth: 3 }, param: 'depth', value: 0 }
        ];
        for (const testCase of cases) {
            const doc = makeDocument([makeFeature('feature1', testCase.type, testCase.params)]);
            expectRejected(doc, [change('feature1', testCase.param, testCase.value)], /greater than 0/);
        }
    });

    it('edits chamfer symmetric distance, draft angle, pattern spacing, and circular sweep', () => {
        const chamfer = makeDocument([makeFeature('chamfer1', 'chamfer', { edges: [EDGE], distance: 1 })]);
        expect(expectAccepted(chamfer, [change('chamfer1', 'distance', 2)]).edits[0]).toMatchObject({ before: 1, after: 2 });

        const draft = makeDocument([makeFeature('draft1', 'draft', { faces: [], angle: 5, pullDirection: [0, 0, 1] })]);
        expect(expectAccepted(draft, [change('draft1', 'angle', -5)]).edits[0]).toMatchObject({ before: 5, after: -5 });

        const linear = makeDocument([makeFeature('pattern1', 'linearPattern', { source: 'pad1', count: 3, spacing: 4, axis: 'x' })]);
        expect(expectAccepted(linear, [change('pattern1', 'spacing', -4)]).edits[0]).toMatchObject({ before: 4, after: -4 });

        const circular = makeDocument([makeFeature('pattern2', 'circularPattern', { source: 'pad1', count: 3, axis: 'z' })]);
        expect(expectAccepted(circular, [change('pattern2', 'angle', 180)]).edits[0]).toMatchObject({ before: 360, after: 180 });
    });

    it('edits blind-hole diameter and depth but rejects through-hole depth', () => {
        const blind = makeDocument([makeFeature('hole1', 'hole', { face: EDGE, center: [0, 0], diameter: 2, depth: 3 })]);
        const accepted = expectAccepted(blind, [change('hole1', 'diameter', 2.5), change('hole1', 'depth', 4)]);
        expect(accepted.edits).toHaveLength(2);

        const through = makeDocument([makeFeature('hole2', 'hole', { face: EDGE, center: [0, 0], diameter: 2 })]);
        expectRejected(through, [change('hole2', 'depth', 4)], /blind hole/);
    });

    it('rejects two-distance chamfer and a partial circular sweep with count 1', () => {
        const twoDistance = makeDocument([makeFeature('chamfer2', 'chamfer', { edges: [EDGE], distances: [1, 2] })]);
        expectRejected(twoDistance, [change('chamfer2', 'distance', 1.5)], /two-distance/);

        const single = makeDocument([makeFeature('pattern3', 'circularPattern', { source: 'pad1', count: 1, axis: 'z' })]);
        expectRejected(single, [change('pattern3', 'angle', 180)], /count of at least 2/);
    });

    it('rejects a no-op edit', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 })]);
        expectRejected(doc, [change('pad1', 'length', 2)], /already 2/);
    });

    it('rejects a feature without a finite current value', () => {
        const missingLength = makeDocument([makeFeature('pad1', 'pad', {})]);
        expectRejected(missingLength, [change('pad1', 'length', 2)], /no finite length/);

        const missingRadius = makeDocument([makeFeature('fillet1', 'fillet', { edges: [EDGE] })]);
        expectRejected(missingRadius, [change('fillet1', 'radius', 2)], /no finite radius/);
    });

    it('ignores unknown extra keys on a change', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 })]);
        const extraChange = { featureId: 'pad1', param: 'length', value: 3, note: 'ignored' } as unknown as FeatureParamChange;

        const result = expectAccepted(doc, [extraChange]);
        expect(result.afterDocument.features[0].params).toEqual({ length: 3 });
    });

    it('does not mutate the input document and returns a deep clone', () => {
        const doc = deepFreeze(makeDocument([makeFeature('pad1', 'pad', { length: 2 }, 'Base')]));
        const snapshot = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;

        const result = expectAccepted(doc, [change('pad1', 'length', 5)]);

        expect(doc).toEqual(snapshot);
        expect(result.afterDocument).not.toBe(doc);
        expect(result.afterDocument.features).not.toBe(doc.features);
        expect(result.afterDocument.features[0]).not.toBe(doc.features[0]);
        expect(result.afterDocument.name).toBe(doc.name);
        expect(result.afterDocument.bodies).toEqual(doc.bodies);
        expect(result.afterDocument.parameters).toEqual(doc.parameters);
    });

    it('reports capability changes with path, label, kind, before, and after', () => {
        const doc = makeDocument([makeFeature('pad1', 'pad', { length: 2 }, 'Base pad')]);
        const result = expectAccepted(doc, [change('pad1', 'length', 5)]);

        expect(result.changes).toEqual([
            {
                path: 'features.pad1.params.length',
                label: 'Feature Base pad length',
                kind: 'update',
                before: 2,
                after: 5
            }
        ]);
    });

    it('applies multiple edits in request order', () => {
        const doc = makeDocument([
            makeFeature('pad1', 'pad', { length: 2 }, 'Base pad'),
            makeFeature('revolve1', 'revolve', { axis: 'z', angle: 90 }, 'Revolve'),
            makeFeature('fillet1', 'fillet', { edges: [EDGE], radius: 0.5 }, 'Fillet')
        ]);
        const result = expectAccepted(doc, [
            change('revolve1', 'angle', 180),
            change('pad1', 'length', 7),
            change('fillet1', 'radius', 1.5)
        ]);

        expect(result.edits.map((edit) => edit.featureId)).toEqual(['revolve1', 'pad1', 'fillet1']);
        expect(result.changes.map((nukeChange) => nukeChange.path)).toEqual([
            'features.revolve1.params.angle',
            'features.pad1.params.length',
            'features.fillet1.params.radius'
        ]);
        expect(result.changes.map((nukeChange) => nukeChange.before)).toEqual([90, 2, 0.5]);
        expect(result.changes.map((nukeChange) => nukeChange.after)).toEqual([180, 7, 1.5]);
        expect(result.afterDocument.features.map((feature) => feature.params)).toEqual([
            { length: 7 },
            { axis: 'z', angle: 180 },
            { edges: [EDGE], radius: 1.5 }
        ]);
    });
});
