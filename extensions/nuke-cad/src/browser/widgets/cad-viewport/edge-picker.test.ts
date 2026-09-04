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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { buildEdgeLine, buildEdgeTopologyRef, pointerToNdc, raycastEdge, EdgeHighlighter } from './edge-picker';

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
    return {
        x,
        y,
        width,
        height,
        top: y,
        left: x,
        right: x + width,
        bottom: y + height,
        toJSON: () => ({})
    } as DOMRect;
}

describe('edge-picker', () => {
    describe('pointerToNdc', () => {
        it('maps the top-left corner to (-1, 1)', () => {
            const rect = makeRect(0, 0, 200, 100);
            expect(pointerToNdc(0, 0, rect)).toEqual({ x: -1, y: 1 });
        });

        it('maps the center to (0, 0)', () => {
            const rect = makeRect(0, 0, 200, 100);
            expect(pointerToNdc(100, 50, rect)).toEqual({ x: 0, y: 0 });
        });
    });

    describe('buildEdgeTopologyRef', () => {
        it('returns undefined when the hit has no fingerprint', () => {
            const line = new THREE.Line();
            const hit = { solidId: 1, edgeId: 2, line };
            expect(buildEdgeTopologyRef('feature-1', hit as import('./edge-picker').EdgePickHit)).toBeUndefined();
        });

        it('builds a TopologyRef from an edge hit', () => {
            const line = new THREE.Line();
            const hit = {
                solidId: 1,
                edgeId: 2,
                line,
                fingerprint: {
                    curveType: 'line' as const,
                    length: 5,
                    start: [0, 0, 0] as [number, number, number],
                    end: [5, 0, 0] as [number, number, number]
                }
            };
            const ref = buildEdgeTopologyRef('feature-1', hit);
            expect(ref).toEqual({
                featureId: 'feature-1',
                kind: 'edge',
                fingerprint: hit.fingerprint
            });
        });

        it('resolves the body tip feature when bodyId is present', () => {
            const line = new THREE.Line();
            const hit = {
                solidId: 1,
                edgeId: 2,
                bodyId: 'body-a',
                line,
                fingerprint: {
                    curveType: 'line' as const,
                    length: 5,
                    start: [0, 0, 0] as [number, number, number],
                    end: [5, 0, 0] as [number, number, number]
                }
            };
            const ref = buildEdgeTopologyRef('fallback', hit, (bodyId) => (bodyId === 'body-a' ? 'body-tip' : undefined));
            expect(ref).toEqual({
                featureId: 'body-tip',
                kind: 'edge',
                fingerprint: hit.fingerprint
            });
        });

        it('falls back to the supplied feature id when body tip resolution fails', () => {
            const line = new THREE.Line();
            const hit = {
                solidId: 1,
                edgeId: 2,
                bodyId: 'body-a',
                line,
                fingerprint: {
                    curveType: 'line' as const,
                    length: 5,
                    start: [0, 0, 0] as [number, number, number],
                    end: [5, 0, 0] as [number, number, number]
                }
            };
            const ref = buildEdgeTopologyRef('fallback', hit, () => undefined);
            expect(ref).toEqual({
                featureId: 'fallback',
                kind: 'edge',
                fingerprint: hit.fingerprint
            });
        });
    });

    describe('buildEdgeLine', () => {
        it('builds a THREE.Line with userData from tessellated edge points', () => {
            const line = buildEdgeLine(
                3,
                {
                    edgeId: 7,
                    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
                    pointCount: 3,
                    bodyId: 'body-1',
                    fingerprint: {
                        curveType: 'line',
                        length: 2,
                        start: [0, 0, 0],
                        end: [2, 0, 0]
                    }
                },
                new THREE.LineBasicMaterial()
            );
            expect(line.userData.solidId).toBe(3);
            expect(line.userData.edgeId).toBe(7);
            expect(line.userData.bodyId).toBe('body-1');
            expect(line.userData.fingerprint).toBeDefined();
            expect(line.geometry.attributes.position.count).toBe(3);
        });
    });

    describe('raycastEdge', () => {
        let camera: THREE.PerspectiveCamera;
        let raycaster: THREE.Raycaster;

        beforeEach(() => {
            camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
            camera.position.set(0, 0, 5);
            camera.lookAt(0, 0, 0);
            camera.updateMatrixWorld();
            raycaster = new THREE.Raycaster();
        });

        it('returns undefined when no lines are provided', () => {
            const hit = raycastEdge([], raycaster, { x: 0, y: 0 }, camera);
            expect(hit).toBeUndefined();
        });

        it('returns the closest edge line intersected by the ray', () => {
            const line = buildEdgeLine(
                1,
                { edgeId: 1, positions: new Float32Array([-1, 0, 0, 1, 0, 0]), pointCount: 2 },
                new THREE.LineBasicMaterial()
            );
            const hit = raycastEdge([line], raycaster, { x: 0, y: 0 }, camera, 0.5);
            expect(hit).toBeDefined();
            expect(hit?.solidId).toBe(1);
            expect(hit?.edgeId).toBe(1);
        });

        it('returns undefined when the pointer is far from the line', () => {
            const line = buildEdgeLine(
                1,
                { edgeId: 1, positions: new Float32Array([-1, 1, 0, 1, 1, 0]), pointCount: 2 },
                new THREE.LineBasicMaterial()
            );
            const hit = raycastEdge([line], raycaster, { x: 0, y: 0 }, camera, 0.05);
            expect(hit).toBeUndefined();
        });
    });

    describe('EdgeHighlighter', () => {
        let group: THREE.Group;
        let highlighter: EdgeHighlighter;

        beforeEach(() => {
            group = new THREE.Group();
            highlighter = new EdgeHighlighter(new THREE.Color(0x00aaff));
            highlighter.attach(group);
        });

        afterEach(() => {
            highlighter.dispose();
        });

        it('starts invisible and becomes visible after highlighting', () => {
            expect(highlighter.isActive).toBe(false);
            const line = buildEdgeLine(
                1,
                { edgeId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0]), pointCount: 2 },
                new THREE.LineBasicMaterial()
            );
            highlighter.highlight(line);
            expect(highlighter.isActive).toBe(true);
            const highlightLine = group.getObjectByName('cad-edge-highlight');
            expect(highlightLine?.visible).toBe(true);
        });

        it('clears the highlight', () => {
            const line = buildEdgeLine(
                1,
                { edgeId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0]), pointCount: 2 },
                new THREE.LineBasicMaterial()
            );
            highlighter.highlight(line);
            highlighter.clear();
            expect(highlighter.isActive).toBe(false);
            const highlightLine = group.getObjectByName('cad-edge-highlight');
            expect(highlightLine?.visible).toBe(false);
        });
    });
});
