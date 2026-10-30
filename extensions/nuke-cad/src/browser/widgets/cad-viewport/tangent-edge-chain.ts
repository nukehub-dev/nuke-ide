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

/**
 * Tangent-edge chain expansion for dress-up edge picking.
 *
 * A picked edge can stand for a whole tangent-continuous run (a fillet or
 * chamfer across every edge of a rounded rim). The pure walker below treats
 * tessellated edge polylines as a graph: two edges are adjacent when their
 * first/last points coincide, and the walk continues through a shared vertex
 * only when the directions *away* from that vertex are nearly opposite (the
 * tangents are continuous within {@link TANGENT_CHAIN_TOLERANCE_DEG}).
 *
 * The viewport adapter {@link expandTangentEdgeChain} feeds the walker from
 * the live edge lines of one solid and maps the result back to pick hits, so
 * a chain never crosses solids.
 *
 * @module nuke-cad/browser/widgets
 */

import * as THREE from 'three';
import { type EdgeFingerprint } from '../../../common/topology-refs';
import { type EdgePickHit } from './edge-picker';

/** Default tangent-continuity tolerance: 15° of direction change per vertex. */
export const TANGENT_CHAIN_TOLERANCE_DEG = 15;

/** Default chain cap, seed included; protects pathological tessellations. */
export const TANGENT_CHAIN_MAX_EDGES = 256;

/** Squared model-space distance under which two endpoints are the same vertex. */
const ENDPOINT_EPSILON_SQ = 1e-8;

/** Direction vectors shorter than this are degenerate (zero-length edge). */
const DIRECTION_EPSILON = 1e-12;

/** One tessellated edge participating in the chain walk. */
export interface TangentialEdge {
    readonly edgeId: number;
    /** XYZ triplets, `pointCount * 3` entries. */
    readonly positions: Float32Array;
    readonly pointCount: number;
}

/** Tuning knobs; both default to the documented dress-up policy. */
export interface TangentChainOptions {
    readonly toleranceDeg?: number;
    readonly maxEdges?: number;
}

interface Point {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

interface EdgeEntry {
    readonly edge: TangentialEdge;
    /** Usable point count (declared count clamped to the buffer length). */
    readonly count: number;
}

interface ChainStep {
    readonly entry: EdgeEntry;
    /** Endpoint index (0 or count-1) shared with the current edge. */
    readonly endpointIndex: number;
}

function usablePointCount(edge: TangentialEdge): number {
    const declared = Number.isFinite(edge.pointCount) ? Math.floor(edge.pointCount) : 0;
    return Math.min(Math.max(declared, 0), Math.floor(edge.positions.length / 3));
}

function pointAt(edge: TangentialEdge, index: number): Point | undefined {
    const offset = index * 3;
    if (index < 0 || offset + 2 >= edge.positions.length) {
        return undefined;
    }
    const x = edge.positions[offset];
    const y = edge.positions[offset + 1];
    const z = edge.positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return undefined;
    }
    return { x, y, z };
}

function sameVertex(a: Point, b: Point): boolean {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz < ENDPOINT_EPSILON_SQ;
}

/** Unit direction from one endpoint toward the other, or undefined when degenerate. */
function directionAway(edge: TangentialEdge, count: number, endpointIndex: number): Point | undefined {
    const here = pointAt(edge, endpointIndex);
    const other = pointAt(edge, endpointIndex === 0 ? count - 1 : 0);
    if (here === undefined || other === undefined) {
        return undefined;
    }
    const dx = other.x - here.x;
    const dy = other.y - here.y;
    const dz = other.z - here.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < DIRECTION_EPSILON) {
        return undefined;
    }
    return { x: dx / length, y: dy / length, z: dz / length };
}

function validEntries(edges: readonly TangentialEdge[]): EdgeEntry[] {
    const seen = new Set<number>();
    const entries: EdgeEntry[] = [];
    for (const edge of edges) {
        if (seen.has(edge.edgeId)) {
            continue;
        }
        const count = usablePointCount(edge);
        if (count < 2) {
            continue;
        }
        if (pointAt(edge, 0) === undefined || pointAt(edge, count - 1) === undefined) {
            continue;
        }
        seen.add(edge.edgeId);
        entries.push({ edge, count });
    }
    return entries;
}

/**
 * Next unused edge at `vertex`, travelled away from the current edge.
 *
 * The candidate endpoint direction is compared against the current edge's
 * direction *away from the shared vertex*: tangent continuity makes the two
 * nearly opposite (`dot < -cos(tolerance)`). The most collinear candidate
 * wins; equal dots resolve by ascending edge id.
 */
function findNext(
    entries: readonly EdgeEntry[],
    used: ReadonlySet<number>,
    vertex: Point,
    currentAway: Point,
    cosTolerance: number
): ChainStep | undefined {
    let best: ChainStep | undefined;
    let bestDot = -Infinity;
    for (const entry of entries) {
        if (used.has(entry.edge.edgeId)) {
            continue;
        }
        for (const endpointIndex of [0, entry.count - 1]) {
            const endpoint = pointAt(entry.edge, endpointIndex);
            if (endpoint === undefined || !sameVertex(endpoint, vertex)) {
                continue;
            }
            const away = directionAway(entry.edge, entry.count, endpointIndex);
            if (away === undefined) {
                continue;
            }
            const dot = currentAway.x * away.x + currentAway.y * away.y + currentAway.z * away.z;
            if (dot >= -cosTolerance) {
                continue;
            }
            const better =
                best === undefined ||
                dot < bestDot - 1e-12 ||
                (Math.abs(dot - bestDot) <= 1e-12 && entry.edge.edgeId < best.entry.edge.edgeId);
            if (better) {
                best = { entry, endpointIndex };
                bestDot = dot;
            }
        }
    }
    return best;
}

/** Walk from one endpoint of `startEntry`, adding each found edge to `used`. */
function walkFrom(
    entries: readonly EdgeEntry[],
    startEntry: EdgeEntry,
    startEndpointIndex: number,
    used: Set<number>,
    cosTolerance: number,
    maxEdges: number
): number[] {
    const chain: number[] = [];
    let current = startEntry;
    let endpointIndex = startEndpointIndex;
    while (used.size < maxEdges) {
        const vertex = pointAt(current.edge, endpointIndex);
        const currentAway = directionAway(current.edge, current.count, endpointIndex);
        if (vertex === undefined || currentAway === undefined) {
            break;
        }
        const next = findNext(entries, used, vertex, currentAway, cosTolerance);
        if (next === undefined) {
            break;
        }
        used.add(next.entry.edge.edgeId);
        chain.push(next.entry.edge.edgeId);
        current = next.entry;
        // Continue through the far endpoint of the newly added edge.
        endpointIndex = next.endpointIndex === 0 ? next.entry.count - 1 : 0;
    }
    return chain;
}

function normalizeTolerance(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
        return TANGENT_CHAIN_TOLERANCE_DEG;
    }
    return Math.min(Math.max(value, 0), 180);
}

function normalizeMaxEdges(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
        return TANGENT_CHAIN_MAX_EDGES;
    }
    return Math.max(1, Math.floor(value));
}

/**
 * Expand one seed edge into its tangent-connected run.
 *
 * Endpoints are the first and last polyline points; two endpoints match when
 * their squared distance is below 1e-8. The seed is always first, followed by
 * the forward chain (from its last point) and then the backward chain (from
 * its first point), each in traversal order. A closed loop stops when the
 * seed would repeat; degenerate or incomplete edges are ignored. Returns an
 * empty list when the seed id is absent from `edges`.
 */
export function findTangentChain(edges: readonly TangentialEdge[], seedEdgeId: number, options: TangentChainOptions = {}): number[] {
    const entries = validEntries(edges);
    const seed = entries.find((entry) => entry.edge.edgeId === seedEdgeId);
    if (seed === undefined) {
        return [];
    }
    const maxEdges = normalizeMaxEdges(options.maxEdges);
    const cosTolerance = Math.cos((normalizeTolerance(options.toleranceDeg) * Math.PI) / 180);
    const used = new Set<number>([seedEdgeId]);
    const result = [seedEdgeId];
    result.push(...walkFrom(entries, seed, seed.count - 1, used, cosTolerance, maxEdges));
    result.push(...walkFrom(entries, seed, 0, used, cosTolerance, maxEdges));
    return result;
}

interface EdgeLineData {
    readonly solidId?: unknown;
    readonly edgeId?: unknown;
    readonly bodyId?: unknown;
    readonly fingerprint?: unknown;
}

/**
 * Expand a viewport edge hit to every tangent-connected edge of the same
 * solid.
 *
 * Only lines carrying the hit's `solidId` participate, so a chain can never
 * cross solids (or assembly instances rendered from the same body). The hit
 * itself is returned unchanged when nothing else chains to it or when its
 * line is no longer in `lines` (a stale hit after a rebuild).
 */
export function expandTangentEdgeChain(hit: EdgePickHit, lines: readonly THREE.Line[]): EdgePickHit[] {
    const byId = new Map<number, THREE.Line>();
    const tangential: TangentialEdge[] = [];
    for (const line of lines) {
        const data = line.userData as EdgeLineData;
        if (data.solidId !== hit.solidId || typeof data.edgeId !== 'number' || byId.has(data.edgeId)) {
            continue;
        }
        const attribute = line.geometry.getAttribute('position');
        if (attribute === undefined || attribute.count < 2) {
            continue;
        }
        const positions = new Float32Array(attribute.count * 3);
        for (let i = 0; i < attribute.count; i++) {
            positions[i * 3] = attribute.getX(i);
            positions[i * 3 + 1] = attribute.getY(i);
            positions[i * 3 + 2] = attribute.getZ(i);
        }
        tangential.push({ edgeId: data.edgeId, positions, pointCount: attribute.count });
        byId.set(data.edgeId, line);
    }
    if (!byId.has(hit.edgeId)) {
        return [hit];
    }
    const chain = findTangentChain(tangential, hit.edgeId);
    if (chain.length <= 1) {
        return [hit];
    }
    const hits: EdgePickHit[] = [];
    for (const edgeId of chain) {
        const line = byId.get(edgeId);
        if (line === undefined) {
            continue;
        }
        const data = line.userData as EdgeLineData;
        hits.push({
            solidId: hit.solidId,
            edgeId,
            bodyId: typeof data.bodyId === 'string' ? data.bodyId : undefined,
            line,
            fingerprint: data.fingerprint as EdgeFingerprint | undefined
        });
    }
    return hits.length > 0 ? hits : [hit];
}
