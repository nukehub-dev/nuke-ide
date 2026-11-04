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
import {
    NUKE_CAD_SCHEMA_VERSION,
    validateNukeCadDocument,
    type FeatureDef,
    type FeatureParams,
    type FeatureType,
    type NukeCadDocument
} from './cad-document';
import type { TopologyRef } from './topology-refs';
import {
    CAD_TOPOLOGY_EDIT_LIMIT,
    CAD_TOPOLOGY_PATTERN_COUNT_LIMIT,
    prepareTopologyEdit,
    type FeatureTopologyAction,
    type PreparedTopologyEdit
} from './cad-topology-edit';

const FACE: TopologyRef = {
    featureId: 'pad1',
    kind: 'face',
    fingerprint: {
        surfaceType: 'plane',
        area: 25,
        center: [0, 0, 0],
        normal: [0, 0, 1]
    }
};

function makeFeature(id: string, type: FeatureType, params: FeatureParams, name = id): FeatureDef {
    return { id, name, type, body: 'body-1', params, suppressed: false, dependsOn: [] };
}

function makeDocument(features: FeatureDef[]): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'Topology edit test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Base' }],
        sketches: [],
        features,
        curves: []
    };
}

/** Document with the body-tip pad that hole face references point at. */
function portDocument(features: FeatureDef[]): NukeCadDocument {
    return makeDocument([makeFeature('pad1', 'pad', { length: 5 }, 'Base pad'), ...features]);
}

function hole(id: string, params: Partial<Record<string, unknown>> = {}, name = 'Hole'): FeatureDef {
    return makeFeature(id, 'hole', { face: FACE, center: [0, 0], diameter: 2, ...params }, name);
}

function linearPattern(id: string, count: number, name = 'Linear pattern'): FeatureDef {
    return makeFeature(id, 'linearPattern', { source: 'pad1', count, spacing: 4, axis: 'x' }, name);
}

function circularPattern(id: string, count: number, angle?: number, name = 'Circular pattern'): FeatureDef {
    const params: Record<string, unknown> = { source: 'pad1', count, axis: 'z' };
    if (angle !== undefined) {
        params.angle = angle;
    }
    return makeFeature(id, 'circularPattern', params, name);
}

function through(featureId: string): FeatureTopologyAction {
    return { featureId, action: 'holeDepthMode', mode: 'through' };
}

function blind(featureId: string, depth: number): FeatureTopologyAction {
    return { featureId, action: 'holeDepthMode', mode: 'blind', depth };
}

function patternCount(featureId: string, count: number): FeatureTopologyAction {
    return { featureId, action: 'patternCount', count };
}

function expectAccepted(document: NukeCadDocument, actions: readonly FeatureTopologyAction[]): PreparedTopologyEdit {
    const result = prepareTopologyEdit(document, actions);
    if (!result.ok) {
        throw new Error(`Expected the topology edit to succeed: ${result.message}`);
    }
    return result.result;
}

function expectRejected(document: NukeCadDocument, actions: readonly FeatureTopologyAction[], pattern: RegExp): void {
    const result = prepareTopologyEdit(document, actions);
    if (result.ok) {
        throw new Error('Expected the topology edit to be rejected');
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

function featureParams(document: NukeCadDocument, id: string): Record<string, unknown> {
    const feature = document.features.find((candidate) => candidate.id === id);
    if (feature === undefined) {
        throw new Error(`Feature '${id}' missing from document`);
    }
    return feature.params as Record<string, unknown>;
}

describe('prepareTopologyEdit hole depth mode', () => {
    it('turns a blind hole into a through hole and removes the depth key', () => {
        const document = portDocument([hole('hole1', { depth: 3, thread: 'cosmetic', drillPointAngle: 118 }, 'Blind hole')]);
        const result = expectAccepted(document, [through('hole1')]);
        const params = featureParams(result.afterDocument, 'hole1');

        expect('depth' in params).toBe(false);
        expect(params).toEqual({ face: FACE, center: [0, 0], diameter: 2, thread: 'cosmetic', drillPointAngle: 118 });
        expect(result.changes).toEqual([
            {
                path: 'features.hole1.params.depth',
                label: 'Feature Blind hole depth',
                kind: 'remove',
                before: 3,
                after: undefined
            }
        ]);
        expect(result.edits).toEqual([
            {
                featureId: 'hole1',
                featureType: 'hole',
                action: 'holeDepthMode',
                before: { face: FACE, center: [0, 0], diameter: 2, depth: 3, thread: 'cosmetic', drillPointAngle: 118 },
                after: { face: FACE, center: [0, 0], diameter: 2, thread: 'cosmetic', drillPointAngle: 118 }
            }
        ]);
    });

    it('turns a through hole into a blind hole and adds the depth key', () => {
        const document = portDocument([hole('hole1', {}, 'Through hole')]);
        const result = expectAccepted(document, [blind('hole1', 6)]);

        expect(featureParams(result.afterDocument, 'hole1')).toEqual({ face: FACE, center: [0, 0], diameter: 2, depth: 6 });
        expect(result.changes).toEqual([
            {
                path: 'features.hole1.params.depth',
                label: 'Feature Through hole depth',
                kind: 'add',
                before: undefined,
                after: 6
            }
        ]);
        expect(result.edits[0].before).toEqual({ face: FACE, center: [0, 0], diameter: 2 });
        expect(result.edits[0].after).toEqual({ face: FACE, center: [0, 0], diameter: 2, depth: 6 });
    });

    it('updates an existing blind depth exactly', () => {
        const document = portDocument([hole('hole1', { depth: 3 }, 'Blind hole')]);
        const result = expectAccepted(document, [blind('hole1', 5)]);

        expect(featureParams(result.afterDocument, 'hole1')).toEqual({ face: FACE, center: [0, 0], diameter: 2, depth: 5 });
        expect(result.changes).toEqual([
            {
                path: 'features.hole1.params.depth',
                label: 'Feature Blind hole depth',
                kind: 'update',
                before: 3,
                after: 5
            }
        ]);
        expect(result.edits[0].before).toEqual({ face: FACE, center: [0, 0], diameter: 2, depth: 3 });
        expect(result.edits[0].after).toEqual({ face: FACE, center: [0, 0], diameter: 2, depth: 5 });
    });

    it('rejects a modeled-thread hole becoming through', () => {
        const document = portDocument([hole('hole1', { depth: 4, thread: 'modeled' })]);
        expectRejected(document, [through('hole1')], /modeled thread.*blind hole/);
    });

    it('rejects hole depth mode on a non-hole feature', () => {
        const document = portDocument([]);
        expectRejected(document, [through('pad1')], /hole depth mode only applies to holes/);
    });

    it('rejects already-through and same-depth edits', () => {
        const throughDocument = portDocument([hole('hole1')]);
        expectRejected(throughDocument, [through('hole1')], /already a through hole/);

        const blindDocument = portDocument([hole('hole1', { depth: 3 })]);
        expectRejected(blindDocument, [blind('hole1', 3)], /already 3/);
    });

    it('rejects blind depths that are not positive finite numbers', () => {
        const document = portDocument([hole('hole1')]);
        const invalidDepths: unknown[] = [0, -2, Number.NaN, Number.POSITIVE_INFINITY, '5'];
        for (const depth of invalidDepths) {
            expectRejected(
                document,
                [{ featureId: 'hole1', action: 'holeDepthMode', mode: 'blind', depth: depth as number }],
                /positive finite number/
            );
        }
    });
});

describe('prepareTopologyEdit pattern count', () => {
    it('updates a linear pattern count', () => {
        const document = portDocument([linearPattern('pattern1', 3, 'Bolt pattern')]);
        const result = expectAccepted(document, [patternCount('pattern1', 4)]);

        expect(featureParams(result.afterDocument, 'pattern1')).toEqual({ source: 'pad1', count: 4, spacing: 4, axis: 'x' });
        expect(result.changes).toEqual([
            {
                path: 'features.pattern1.params.count',
                label: 'Feature Bolt pattern count',
                kind: 'update',
                before: 3,
                after: 4
            }
        ]);
        expect(result.edits).toEqual([
            {
                featureId: 'pattern1',
                featureType: 'linearPattern',
                action: 'patternCount',
                before: { source: 'pad1', count: 3, spacing: 4, axis: 'x' },
                after: { source: 'pad1', count: 4, spacing: 4, axis: 'x' }
            }
        ]);
    });

    it('updates a circular pattern count for full and default sweeps', () => {
        const full = portDocument([circularPattern('pattern1', 4, 360)]);
        expect(featureParams(expectAccepted(full, [patternCount('pattern1', 6)]).afterDocument, 'pattern1').count).toBe(6);

        const defaultSweep = portDocument([circularPattern('pattern1', 4)]);
        expect(featureParams(expectAccepted(defaultSweep, [patternCount('pattern1', 5)]).afterDocument, 'pattern1').count).toBe(5);
    });

    it('rejects a partial circular sweep count below 2', () => {
        const document = portDocument([circularPattern('pattern1', 3, 180)]);
        expectRejected(document, [patternCount('pattern1', 1)], /count of at least 2/);
    });

    it('rejects zero, fractional, non-finite, and no-op counts', () => {
        const document = portDocument([linearPattern('pattern1', 3)]);
        const invalidCounts: unknown[] = [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '4'];
        for (const count of invalidCounts) {
            expectRejected(document, [{ featureId: 'pattern1', action: 'patternCount', count: count as number }], /safe integer/);
        }
        expectRejected(document, [patternCount('pattern1', 3)], /already 3/);
        expectRejected(document, [patternCount('pattern1', CAD_TOPOLOGY_PATTERN_COUNT_LIMIT + 1)], /at most 1000/);
    });

    it.each([
        { type: 'mirror' as const, params: { source: 'pad1', plane: 'XY' } },
        { type: 'lattice' as const, params: { source: 'pad1', latticeType: 'rectangular', rows: 2, cols: 2, pitch: 1 } },
        { type: 'multiTransform' as const, params: { first: 'pattern1', second: 'pattern1' } },
        { type: 'pad' as const, params: { length: 2 } }
    ])('rejects pattern count on a $type feature', ({ type, params }) => {
        const document = portDocument([makeFeature('feature1', type, params)]);
        expectRejected(document, [patternCount('feature1', 2)], /pattern count only applies to linear or circular patterns/);
    });
});

describe('prepareTopologyEdit validation and atomicity', () => {
    it('rejects empty, non-object, empty-id, unknown-action, duplicate, and unknown requests', () => {
        const document = portDocument([hole('hole1', { depth: 3 }), linearPattern('pattern1', 3)]);

        expectRejected(document, [], /No topology edit actions/);
        expectRejected(document, [null as unknown as FeatureTopologyAction], /must be an object/);
        expectRejected(document, [{ featureId: '', action: 'patternCount', count: 2 }], /non-empty feature id/);
        expectRejected(
            document,
            [{ featureId: 'hole1', action: 'resize', value: 1 } as unknown as FeatureTopologyAction],
            /unknown topology action/
        );
        expectRejected(document, [through('hole1'), patternCount('hole1', 4)], /Duplicate topology edit/);
        expectRejected(document, [through('missing')], /Unknown feature 'missing'/);
    });

    it('accepts exactly the action limit and rejects one more', () => {
        const holes = Array.from({ length: CAD_TOPOLOGY_EDIT_LIMIT }, (_, index) => hole(`hole${index}`, { depth: 3 }));
        const accepted = expectAccepted(
            portDocument(holes),
            holes.map((feature) => through(feature.id))
        );
        expect(accepted.edits).toHaveLength(CAD_TOPOLOGY_EDIT_LIMIT);
        expect(accepted.changes).toHaveLength(CAD_TOPOLOGY_EDIT_LIMIT);

        const overLimit = Array.from({ length: CAD_TOPOLOGY_EDIT_LIMIT + 1 }, (_, index) => hole(`hole${index}`, { depth: 3 }));
        expectRejected(
            portDocument(overLimit),
            overLimit.map((feature) => through(feature.id)),
            /at most 8 are allowed/
        );
    });

    it('rejects a later invalid action without producing a partial edit', () => {
        const document = portDocument([hole('hole1', { depth: 3 }), linearPattern('pattern1', 3)]);
        const result = prepareTopologyEdit(document, [through('hole1'), patternCount('pattern1', 0)]);
        expect(result.ok).toBe(false);
        expect(featureParams(document, 'hole1')).toEqual({ face: FACE, center: [0, 0], diameter: 2, depth: 3 });
    });

    it('does not mutate the input document and returns detached snapshots', () => {
        const document = deepFreeze(portDocument([hole('hole1', { depth: 3 }, 'Blind hole'), linearPattern('pattern1', 3)]));
        const snapshot = JSON.parse(JSON.stringify(document)) as NukeCadDocument;

        const result = expectAccepted(document, [through('hole1'), patternCount('pattern1', 4)]);

        expect(document).toEqual(snapshot);
        expect(result.afterDocument).not.toBe(document);
        expect(result.afterDocument.features).not.toBe(document.features);
        expect(result.afterDocument.features[1]).not.toBe(document.features[1]);
        expect(result.afterDocument.features[1].params).not.toBe(document.features[1].params);
        expect(result.edits[0].before).not.toBe(document.features[1].params);
        expect(result.edits[0].after).toEqual(result.afterDocument.features[1].params);
    });

    it('produces a document clone that validates against the schema', () => {
        const document = portDocument([hole('hole1', { depth: 3 }), linearPattern('pattern1', 3), circularPattern('pattern2', 4, 180)]);
        const result = expectAccepted(document, [through('hole1'), patternCount('pattern1', 4), patternCount('pattern2', 6)]);

        const validation = validateNukeCadDocument(result.afterDocument);
        expect(validation.issues).toEqual([]);
        expect(validation.valid).toBe(true);
        expect(featureParams(result.afterDocument, 'hole1').depth).toBeUndefined();
        expect(featureParams(result.afterDocument, 'pattern1').count).toBe(4);
        expect(featureParams(result.afterDocument, 'pattern2').count).toBe(6);
    });

    it('applies multiple actions in request order with exact changes', () => {
        const document = portDocument([hole('hole1', { depth: 3 }, 'Blind hole'), linearPattern('pattern1', 3, 'Bolt pattern')]);
        const result = expectAccepted(document, [patternCount('pattern1', 4), through('hole1')]);

        expect(result.edits.map((edit) => edit.featureId)).toEqual(['pattern1', 'hole1']);
        expect(result.edits.map((edit) => edit.action)).toEqual(['patternCount', 'holeDepthMode']);
        expect(result.changes).toEqual([
            {
                path: 'features.pattern1.params.count',
                label: 'Feature Bolt pattern count',
                kind: 'update',
                before: 3,
                after: 4
            },
            {
                path: 'features.hole1.params.depth',
                label: 'Feature Blind hole depth',
                kind: 'remove',
                before: 3,
                after: undefined
            }
        ]);
    });
});
