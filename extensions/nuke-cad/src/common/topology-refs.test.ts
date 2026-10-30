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
    validateTopologyRef,
    validateFaceFingerprint,
    validateEdgeFingerprint,
    type FaceFingerprint,
    type EdgeFingerprint,
    type TopologyRef,
    type SurfaceType,
    type CurveType
} from './topology-refs';

function makeFace(extra?: Partial<FaceFingerprint>): FaceFingerprint {
    return {
        surfaceType: 'plane',
        area: 25,
        center: [0, 0, 0],
        normal: [0, 0, 1],
        ...extra
    };
}

function makeEdge(extra?: Partial<EdgeFingerprint>): EdgeFingerprint {
    return {
        curveType: 'line',
        length: 5,
        start: [0, 0, 0],
        end: [5, 0, 0],
        ...extra
    };
}

function makeRef(extra?: Partial<TopologyRef>): TopologyRef {
    return {
        featureId: 'pad1',
        kind: 'face',
        fingerprint: makeFace(),
        ...extra
    };
}

describe('topology-refs validation', () => {
    it('accepts a valid face reference', () => {
        const result = validateTopologyRef(makeRef());
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('accepts a valid edge reference', () => {
        const result = validateTopologyRef(makeRef({ kind: 'edge', fingerprint: makeEdge() }));
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('rejects missing featureId', () => {
        const result = validateTopologyRef(makeRef({ featureId: '' }));
        expect(result.valid).toBe(false);
        expect(result.issues.some((m) => m.includes('featureId'))).toBe(true);
    });

    it('rejects invalid kind', () => {
        const result = validateTopologyRef(makeRef({ kind: 'vertex' as 'face' }));
        expect(result.valid).toBe(false);
        expect(result.issues.some((m) => m.includes('kind must be'))).toBe(true);
    });

    it('rejects malformed face fingerprint points', () => {
        const result = validateFaceFingerprint(makeFace({ center: [0, 0] as unknown as [number, number, number] }));
        expect(result.valid).toBe(false);
        expect(result.issues.some((m) => m.includes('center'))).toBe(true);
    });

    it('rejects zero and negative face area', () => {
        expect(validateFaceFingerprint(makeFace({ area: 0 })).valid).toBe(false);
        expect(validateFaceFingerprint(makeFace({ area: -1 })).valid).toBe(false);
    });

    it('rejects invalid surfaceType values', () => {
        const result = validateFaceFingerprint(makeFace({ surfaceType: 'invalid' as SurfaceType }));
        expect(result.valid).toBe(false);
        expect(result.issues.some((m) => m.includes('surfaceType'))).toBe(true);
    });

    it('rejects zero-length and non-finite normals', () => {
        expect(validateFaceFingerprint(makeFace({ normal: [0, 0, 0] })).valid).toBe(false);
        expect(validateFaceFingerprint(makeFace({ normal: [NaN, 0, 1] })).valid).toBe(false);
        expect(validateFaceFingerprint(makeFace({ normal: [Infinity, 0, 1] })).valid).toBe(false);
    });

    it('rejects zero-length axis direction', () => {
        const result = validateTopologyRef(
            makeRef({
                fingerprint: makeFace({
                    surfaceType: 'cylinder',
                    axis: { origin: [0, 0, 0], direction: [0, 0, 0] }
                })
            })
        );
        expect(result.valid).toBe(false);
        expect(result.issues.some((m) => m.includes('axis.direction'))).toBe(true);
    });

    it('rejects malformed edge fingerprint endpoints', () => {
        const result = validateEdgeFingerprint(makeEdge({ start: 'origin' as unknown as [number, number, number] }));
        expect(result.valid).toBe(false);
        expect(result.issues.some((m) => m.includes('start'))).toBe(true);
    });

    it('rejects zero and negative edge length', () => {
        expect(validateEdgeFingerprint(makeEdge({ length: 0 })).valid).toBe(false);
        expect(validateEdgeFingerprint(makeEdge({ length: -2 })).valid).toBe(false);
    });

    it('rejects invalid curveType values', () => {
        const result = validateEdgeFingerprint(makeEdge({ curveType: 'spiral' as CurveType }));
        expect(result.valid).toBe(false);
        expect(result.issues.some((m) => m.includes('curveType'))).toBe(true);
    });

    it('rejects non-finite components in points', () => {
        expect(validateEdgeFingerprint(makeEdge({ start: [NaN, 0, 0] })).valid).toBe(false);
        expect(validateEdgeFingerprint(makeEdge({ end: [0, Infinity, 0] })).valid).toBe(false);
    });

    it('round-trips through JSON', () => {
        const ref = makeRef({
            fingerprint: makeFace({
                surfaceType: 'cylinder',
                area: 12.5,
                center: [1, 2, 3],
                axis: { origin: [0, 0, 0], direction: [0, 0, 1] },
                radius: 2
            })
        });
        const round = JSON.parse(JSON.stringify(ref)) as TopologyRef;
        const result = validateTopologyRef(round);
        expect(result.valid).toBe(true);
        expect((round.fingerprint as FaceFingerprint).axis?.origin).toEqual([0, 0, 0]);
    });
});
