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
import { buildEdgeLine } from './edge-picker';
import {
    expandTangentEdgeChain,
    findTangentChain,
    TANGENT_CHAIN_MAX_EDGES,
    TANGENT_CHAIN_TOLERANCE_DEG,
    type TangentialEdge
} from './tangent-edge-chain';
import type { EdgeFingerprint } from '../../../common/topology-refs';
import * as THREE from 'three';

type Point3 = [number, number, number];

function polyline(edgeId: number, points: readonly Point3[]): TangentialEdge {
    const positions = new Float32Array(points.length * 3);
    points.forEach((point, index) => positions.set(point, index * 3));
    return { edgeId, positions, pointCount: points.length };
}

function edge(edgeId: number, start: Point3, end: Point3): TangentialEdge {
    return polyline(edgeId, [start, end]);
}

/** Circle approximated by `segments` short edges (closed loop). */
function circleLoop(segments: number, radius = 10): TangentialEdge[] {
    const point = (index: number): Point3 => {
        const angle = (index / segments) * Math.PI * 2;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
    };
    return Array.from({ length: segments }, (_, index) => edge(index, point(index), point(index + 1)));
}

const fingerprint = (length: number): EdgeFingerprint => ({
    curveType: 'line',
    length,
    start: [0, 0, 0],
    end: [length, 0, 0]
});

describe('findTangentChain', () => {
    it('walks a smooth three-edge run seed-first, then forward, then backward', () => {
        const points: Point3[] = [[0, 0, 0]];
        let x = 0;
        let y = 0;
        for (let index = 0; index < 3; index++) {
            const angle = (index * 10 * Math.PI) / 180;
            x += Math.cos(angle);
            y += Math.sin(angle);
            points.push([x, y, 0]);
        }
        const edges = [polyline(10, points.slice(0, 2)), polyline(11, points.slice(1, 3)), polyline(12, points.slice(2, 4))];
        expect(findTangentChain(edges, 11)).toEqual([11, 12, 10]);
    });

    it('does not chain an edge that bends past the tolerance', () => {
        const bend = (80 * Math.PI) / 180;
        const edges = [edge(1, [0, 0, 0], [1, 0, 0]), edge(2, [1, 0, 0], [1 + Math.cos(bend), Math.sin(bend), 0])];
        expect(findTangentChain(edges, 1)).toEqual([1]);
        expect(findTangentChain(edges, 1, { toleranceDeg: 90 })).toEqual([1, 2]);
    });

    it('defaults to a 15° tolerance and a 256-edge cap', () => {
        expect(TANGENT_CHAIN_TOLERANCE_DEG).toBe(15);
        expect(TANGENT_CHAIN_MAX_EDGES).toBe(256);
        const bend = (20 * Math.PI) / 180;
        const edges = [edge(1, [0, 0, 0], [1, 0, 0]), edge(2, [1, 0, 0], [1 + Math.cos(bend), Math.sin(bend), 0])];
        expect(findTangentChain(edges, 1)).toEqual([1]);
    });

    it('closes a loop without repeating the seed', () => {
        const edges = circleLoop(36);
        const chain = findTangentChain(edges, 0);
        expect(chain).toHaveLength(36);
        expect(chain[0]).toBe(0);
        expect(new Set(chain).size).toBe(36);
        expect(chain).not.toContain(36);
    });

    it('prefers the most collinear continuation at a shared vertex', () => {
        const slight = (5 * Math.PI) / 180;
        const edges = [
            edge(1, [0, 0, 0], [1, 0, 0]),
            edge(2, [1, 0, 0], [2, 0, 0]),
            edge(3, [1, 0, 0], [1 + Math.cos(slight), Math.sin(slight), 0])
        ];
        expect(findTangentChain(edges, 1)).toEqual([1, 2]);
    });

    it('ignores duplicate edge ids already used by the walk', () => {
        const edges = [edge(1, [0, 0, 0], [1, 0, 0]), edge(2, [1, 0, 0], [2, 0, 0]), edge(2, [1, 0, 0], [3, 0, 0])];
        expect(findTangentChain(edges, 1)).toEqual([1, 2]);
    });

    it('caps the chain at maxEdges, seed included', () => {
        const edges = Array.from({ length: 20 }, (_, index) => edge(index, [index, 0, 0], [index + 1, 0, 0]));
        expect(findTangentChain(edges, 0, { maxEdges: 5 })).toEqual([0, 1, 2, 3, 4]);
        expect(findTangentChain(edges, 10, { maxEdges: 3 })).toEqual([10, 11, 12]);
        expect(findTangentChain(edges, 0, { maxEdges: 1 })).toEqual([0]);
    });

    it('skips degenerate and incomplete edges', () => {
        const degenerate = polyline(5, [
            [0, 0, 0],
            [0, 0, 0]
        ]);
        const singlePoint = { edgeId: 6, positions: new Float32Array([0, 0, 0]), pointCount: 1 };
        const edges = [edge(1, [0, 0, 0], [1, 0, 0]), edge(2, [1, 0, 0], [2, 0, 0])];
        expect(findTangentChain([...edges, degenerate, singlePoint], 1)).toEqual([1, 2]);
        // A zero-length seed is still returned alone, never chained.
        expect(findTangentChain([...edges, degenerate], 5)).toEqual([5]);
    });

    it('returns an empty list for an unknown seed id', () => {
        expect(findTangentChain([edge(1, [0, 0, 0], [1, 0, 0])], 99)).toEqual([]);
        expect(findTangentChain([], 1)).toEqual([]);
    });
});

describe('expandTangentEdgeChain', () => {
    const material = new THREE.LineBasicMaterial();

    it('maps chained edge ids back to hits with body and fingerprint data', () => {
        const lines = [
            buildEdgeLine(
                1,
                {
                    ...polyline(1, [
                        [0, 0, 0],
                        [1, 0, 0]
                    ]),
                    bodyId: 'body-a',
                    fingerprint: fingerprint(1)
                },
                material
            ),
            buildEdgeLine(
                1,
                {
                    ...polyline(2, [
                        [1, 0, 0],
                        [2, 0, 0]
                    ]),
                    bodyId: 'body-a',
                    fingerprint: fingerprint(1)
                },
                material
            ),
            buildEdgeLine(
                1,
                {
                    ...polyline(3, [
                        [2, 0, 0],
                        [2, 1, 0]
                    ]),
                    bodyId: 'body-a',
                    fingerprint: fingerprint(1)
                },
                material
            )
        ];
        const hit = {
            solidId: 1,
            edgeId: 1,
            bodyId: 'body-a',
            line: lines[0],
            fingerprint: fingerprint(1)
        };
        const hits = expandTangentEdgeChain(hit, lines);
        expect(hits.map((entry) => entry.edgeId)).toEqual([1, 2]);
        expect(hits.every((entry) => entry.solidId === 1)).toBe(true);
        expect(hits[1].bodyId).toBe('body-a');
        expect(hits[1].fingerprint).toEqual(fingerprint(1));
        expect(hits[1].line).toBe(lines[1]);
    });

    it('never crosses solids even when the geometry is contiguous', () => {
        const lines = [
            buildEdgeLine(
                1,
                {
                    ...polyline(1, [
                        [0, 0, 0],
                        [1, 0, 0]
                    ])
                },
                material
            ),
            buildEdgeLine(
                1,
                {
                    ...polyline(2, [
                        [1, 0, 0],
                        [2, 0, 0]
                    ])
                },
                material
            ),
            buildEdgeLine(
                2,
                {
                    ...polyline(3, [
                        [2, 0, 0],
                        [3, 0, 0]
                    ])
                },
                material
            )
        ];
        const hit = { solidId: 1, edgeId: 1, line: lines[0] };
        expect(expandTangentEdgeChain(hit, lines).map((entry) => entry.edgeId)).toEqual([1, 2]);
    });

    it('returns the hit unchanged when its line is gone or nothing chains', () => {
        const lines = [
            buildEdgeLine(
                1,
                {
                    ...polyline(2, [
                        [1, 0, 0],
                        [2, 0, 0]
                    ])
                },
                material
            )
        ];
        const stale = { solidId: 1, edgeId: 1, line: new THREE.Line() };
        expect(expandTangentEdgeChain(stale, lines)).toEqual([stale]);
        const lone = { solidId: 1, edgeId: 2, line: lines[0] };
        expect(expandTangentEdgeChain(lone, lines)).toEqual([lone]);
    });
});
