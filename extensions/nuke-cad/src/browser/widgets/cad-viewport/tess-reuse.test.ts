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
import { collectTransferables, faceReuseKey, parseTessellationText, planFaceReuse, type ParsedTessData } from './tess-reuse';

/** Minimal valid raw payload with one solid, one face, one edge, one curve. */
function rawPayload() {
    return {
        version: 1,
        tolerance: 0.01,
        boundingBox: { min: [0, 0, 0], max: [2, 2, 0] },
        solids: [
            {
                solidId: 1,
                bodyId: 'body-1',
                faces: [
                    {
                        faceId: 1,
                        nodes: [
                            [0, 0, 0],
                            [2, 0, 0],
                            [0, 2, 0]
                        ],
                        triangles: [[0, 1, 2]],
                        hash: 12345,
                        fingerprint: { surfaceType: 'plane', area: 2, center: [0.5, 0.5, 0], normal: [0, 0, 1] }
                    }
                ],
                edges: [
                    {
                        edgeId: 1,
                        points: [
                            [0, 0, 0],
                            [1, 0, 0]
                        ]
                    }
                ],
                properties: { volume: 1.5 }
            }
        ],
        curves: [
            {
                id: 'c1',
                name: 'curve',
                closed: false,
                points: [
                    [0, 0, 0],
                    [1, 1, 1]
                ]
            }
        ]
    };
}

describe('parseTessellationText', () => {
    it('converts nodes/triangles/polylines into typed arrays with metadata', () => {
        const parsed = parseTessellationText(JSON.stringify(rawPayload()));
        expect(parsed.version).toBe(1);
        expect(parsed.tolerance).toBe(0.01);
        expect(parsed.boundingBox.min).toEqual([0, 0, 0]);
        expect(parsed.solids).toEqual([
            { solidId: 1, bodyId: 'body-1', faceCount: 1, edgeCount: 1, triangleCount: 1, properties: { volume: 1.5 } }
        ]);
        expect(parsed.faces.length).toBe(1);
        const face = parsed.faces[0];
        expect(face.solidId).toBe(1);
        expect(face.faceId).toBe(1);
        expect(face.bodyId).toBe('body-1');
        expect(face.nodeCount).toBe(3);
        expect(face.triangleCount).toBe(1);
        expect(face.positions).toBeInstanceOf(Float32Array);
        expect(Array.from(face.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
        expect(Array.from(face.indices)).toEqual([0, 1, 2]);
        expect(face.fingerprint?.surfaceType).toBe('plane');
        expect(parsed.edges[0].pointCount).toBe(2);
        expect(parsed.curves[0].positions.length).toBe(6);
    });

    it('falls back to positional indices when ids are absent', () => {
        const raw = rawPayload();
        delete (raw.solids[0] as Record<string, unknown>).solidId;
        delete (raw.solids[0].faces[0] as Record<string, unknown>).faceId;
        const parsed = parseTessellationText(JSON.stringify(raw));
        expect(parsed.solids[0].solidId).toBe(1);
        expect(parsed.faces[0].faceId).toBe(1);
    });

    it('omits curves when the payload has none', () => {
        const raw = rawPayload();
        delete (raw as Record<string, unknown>).curves;
        const parsed = parseTessellationText(JSON.stringify(raw));
        expect(parsed.curves).toEqual([]);
    });

    it('rejects structurally invalid payloads', () => {
        expect(() => parseTessellationText('{}')).toThrow(/missing solids/);
        expect(() => parseTessellationText('{"solids": []}')).toThrow(/missing boundingBox/);
        const badFace = rawPayload();
        (badFace.solids[0].faces[0] as Record<string, unknown>).nodes = 'nope';
        expect(() => parseTessellationText(JSON.stringify(badFace))).toThrow(/points/);
    });

    it('exposes every ArrayBuffer for zero-copy transfer', () => {
        const parsed = parseTessellationText(JSON.stringify(rawPayload()));
        const buffers = collectTransferables(parsed);
        expect(buffers.length).toBe(4);
        expect(buffers.every((buffer) => buffer instanceof ArrayBuffer)).toBe(true);
    });
});

function makeFace(overrides: Record<string, unknown> = {}, nodes?: number[][]): Record<string, unknown> {
    const baseNodes = nodes ?? [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0]
    ];
    return {
        faceId: 1,
        nodes: baseNodes,
        triangles: [[0, 1, 2]],
        ...overrides
    };
}

function makeParsed(faces: Array<Record<string, unknown>>, solidIds: number[] = []): ParsedTessData {
    const raw = {
        version: 1,
        tolerance: 0.01,
        boundingBox: { min: [0, 0, 0], max: [1, 1, 0] },
        solids: faces.map((face, index) => ({
            solidId: solidIds[index] ?? index + 1,
            faces: [face],
            edges: []
        })),
        curves: []
    };
    return parseTessellationText(JSON.stringify(raw));
}

describe('faceReuseKey', () => {
    it('prefers the content fingerprint and ignores positional identity', () => {
        const fingerprint = { surfaceType: 'plane', area: 2, center: [0.5, 0.5, 0], normal: [0, 0, 1] };
        const a = makeParsed([makeFace({ fingerprint })], [1]);
        const b = makeParsed([makeFace({ fingerprint, faceId: 9 })], [7]);
        expect(faceReuseKey(a.faces[0])).toBe(faceReuseKey(b.faces[0]));
        expect(faceReuseKey(a.faces[0])).toMatch(/^fp:/);
    });

    it('falls back to a geometry signature when the fingerprint is absent', () => {
        const a = makeParsed([makeFace()], [1]);
        expect(faceReuseKey(a.faces[0])).toMatch(/^geo:/);
        // Same geometry keyed again (the deterministic-tessellation contract).
        const b = makeParsed([makeFace({ faceId: 4 })], [3]);
        expect(faceReuseKey(a.faces[0])).toBe(faceReuseKey(b.faces[0]));
    });

    it('changes the key when the geometry changes', () => {
        const a = makeParsed([makeFace()]);
        const moved = makeParsed([
            makeFace({}, [
                [0, 0, 0],
                [2, 0, 0],
                [0, 1, 0]
            ])
        ]);
        expect(faceReuseKey(a.faces[0])).not.toBe(faceReuseKey(moved.faces[0]));
    });
});

describe('planFaceReuse', () => {
    it('plans everything as added without a previous build', () => {
        const next = makeParsed([makeFace(), makeFace({ faceId: 2 })]);
        const plan = planFaceReuse(undefined, next);
        expect(plan.added.length).toBe(2);
        expect(plan.reused.length).toBe(0);
        expect(plan.removedKeys.length).toBe(0);
    });

    it('reuses every face of an identical rebuild regardless of solid indices', () => {
        const previous = makeParsed([makeFace(), makeFace({ faceId: 2 })], [1, 2]);
        // Same geometry, shuffled positional identities (solids re-ordered).
        const next = makeParsed([makeFace({ faceId: 5 }), makeFace({ faceId: 3 })], [2, 1]);
        const plan = planFaceReuse(previous, next);
        expect(plan.reused.length).toBe(2);
        expect(plan.added.length).toBe(0);
        expect(plan.removedKeys.length).toBe(0);
    });

    it('plans added + removed when a face changes', () => {
        const previous = makeParsed([makeFace(), makeFace({ faceId: 2 })]);
        const next = makeParsed([
            makeFace(),
            makeFace({ faceId: 2 }, [
                [0, 0, 0],
                [5, 0, 0],
                [0, 1, 0]
            ])
        ]);
        const plan = planFaceReuse(previous, next);
        expect(plan.reused.length).toBe(1);
        expect(plan.added.length).toBe(1);
        expect(plan.removedKeys.length).toBe(1);
    });

    it('consumes duplicate keys as a multiset (pattern instances)', () => {
        const previous = makeParsed([makeFace(), makeFace({ faceId: 2 })]);
        const next = makeParsed([makeFace(), makeFace({ faceId: 2 }), makeFace({ faceId: 3 })]);
        const plan = planFaceReuse(previous, next);
        expect(plan.reused.length).toBe(2);
        expect(plan.added.length).toBe(1);
        const shrinking = planFaceReuse(next, previous);
        expect(shrinking.reused.length).toBe(2);
        expect(shrinking.removedKeys.length).toBe(1);
    });

    it('carries the new face metadata on reused entries for userData re-derivation', () => {
        const fingerprint = { surfaceType: 'plane', area: 1, center: [0, 0, 0] };
        const previous = makeParsed([makeFace({ fingerprint })], [1]);
        const next = makeParsed([makeFace({ fingerprint, faceId: 9 })], [4]);
        const plan = planFaceReuse(previous, next);
        expect(plan.reused.length).toBe(1);
        expect(plan.reused[0].face.solidId).toBe(4);
        expect(plan.reused[0].face.faceId).toBe(9);
        expect(plan.reused[0].key).toBe(faceReuseKey(next.faces[0]));
    });
});
