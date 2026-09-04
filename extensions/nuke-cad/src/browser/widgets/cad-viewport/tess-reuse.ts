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
 * Tessellation parse + scene-reuse planning for the CAD viewport.
 *
 * Pure module (no three.js, no Theia): the parse runs in a Web Worker
 * (`tess-parse.worker.ts`, a thin shell over {@link parseTessellationText}),
 * the reuse-key/diff planning runs on the main thread. Keeping both pure makes
 * them vitest-coverable and keeps the worker bundle free of `@theia/*`.
 *
 * The parsed representation stores node/edge/curve coordinates in typed
 * arrays: structured-clone transfer of the parsed JSON object graph would
 * cost about as much main-thread time as parsing it (measured ~1.4 s vs
 * ~0.8 s for the 59 MB tokamak payload), while transferring ArrayBuffers is
 * zero-copy and lets the viewport wrap them in `BufferAttribute` directly.
 *
 * @module nuke-cad/browser/widgets
 */

import type { EdgeFingerprint, FaceFingerprint } from '../../../common/topology-refs';
import type { TessSolidProperties } from '../../state/nuke-cad-state-manager';

/** One face's tessellation as GPU-ready buffers plus identity metadata. */
export interface ParsedTessFace {
    /** Per-solid positional face index from the backend (re-derived per build). */
    readonly faceId: number;
    /** Positional solid index from the backend (solids can shuffle between builds). */
    readonly solidId: number;
    /** Owning body id, when the build produced one. */
    readonly bodyId?: string;
    /** Content-based geometric fingerprint, when the backend extracted one. */
    readonly fingerprint?: FaceFingerprint;
    readonly nodeCount: number;
    readonly triangleCount: number;
    /** XYZ triplets, `nodeCount * 3` entries. */
    readonly positions: Float32Array;
    /** Triangle corner indices, `triangleCount * 3` entries. */
    readonly indices: Uint32Array;
}

/** One edge's polyline as a GPU-ready buffer plus identity metadata. */
export interface ParsedTessEdge {
    readonly edgeId: number;
    readonly solidId: number;
    readonly bodyId?: string;
    readonly fingerprint?: EdgeFingerprint;
    readonly pointCount: number;
    /** XYZ triplets, `pointCount * 3` entries. */
    readonly positions: Float32Array;
}

/** One document curve's polyline as a GPU-ready buffer. */
export interface ParsedTessCurve {
    readonly id: string;
    readonly name: string;
    readonly closed: boolean;
    /** XYZ triplets. */
    readonly positions: Float32Array;
}

/** Per-solid inspection metadata (counts + mass properties, no geometry). */
export interface ParsedTessSolidMeta {
    readonly solidId: number;
    readonly bodyId?: string;
    readonly faceCount: number;
    readonly edgeCount: number;
    readonly triangleCount: number;
    readonly properties?: TessSolidProperties;
}

/** Transfer-friendly parsed tessellation payload. */
export interface ParsedTessData {
    readonly version: number;
    readonly tolerance: number;
    readonly boundingBox: { readonly min: number[]; readonly max: number[] };
    readonly solids: ParsedTessSolidMeta[];
    /** Flattened across solids; `solidId`/`faceId` carry the positional identity. */
    readonly faces: ParsedTessFace[];
    readonly edges: ParsedTessEdge[];
    readonly curves: ParsedTessCurve[];
}

/** Structural subset of the raw JSON face entry the parser consumes. */
interface RawTessFace {
    readonly faceId?: unknown;
    readonly nodes?: unknown;
    readonly triangles?: unknown;
    readonly bodyId?: unknown;
    readonly fingerprint?: unknown;
}

interface RawTessEdge {
    readonly edgeId?: unknown;
    readonly points?: unknown;
    readonly bodyId?: unknown;
    readonly fingerprint?: unknown;
}

interface RawTessSolid {
    readonly solidId?: unknown;
    readonly bodyId?: unknown;
    readonly faces?: unknown;
    readonly edges?: unknown;
    readonly properties?: unknown;
}

interface RawTessCurve {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly points?: unknown;
    readonly closed?: unknown;
}

function toPositions(points: unknown, what: string): { positions: Float32Array; count: number } {
    if (!Array.isArray(points)) {
        throw new Error(`Invalid tessellation: ${what} points are missing`);
    }
    const positions = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        if (!Array.isArray(point) || point.length < 3) {
            throw new Error(`Invalid tessellation: ${what} point ${i} is not an [x, y, z] triple`);
        }
        positions[i * 3] = Number(point[0]);
        positions[i * 3 + 1] = Number(point[1]);
        positions[i * 3 + 2] = Number(point[2]);
    }
    return { positions, count: points.length };
}

/**
 * Parse a tessellation JSON payload into the transfer-friendly representation.
 * Runs on the worker in production and on the main thread as the fallback;
 * both paths must produce the same shape.
 */
export function parseTessellationText(text: string): ParsedTessData {
    const raw = JSON.parse(text) as {
        readonly version?: unknown;
        readonly tolerance?: unknown;
        readonly boundingBox?: { readonly min?: unknown; readonly max?: unknown };
        readonly solids?: unknown;
        readonly curves?: unknown;
    };
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.solids)) {
        throw new Error('Invalid tessellation: missing solids');
    }
    const bbox = raw.boundingBox;
    if (typeof bbox !== 'object' || bbox === null || !Array.isArray(bbox.min) || !Array.isArray(bbox.max)) {
        throw new Error('Invalid tessellation: missing boundingBox');
    }

    const solids: ParsedTessSolidMeta[] = [];
    const faces: ParsedTessFace[] = [];
    const edges: ParsedTessEdge[] = [];
    raw.solids.forEach((solid: RawTessSolid, solidIndex: number) => {
        const solidId = typeof solid.solidId === 'number' ? solid.solidId : solidIndex + 1;
        const bodyId = typeof solid.bodyId === 'string' ? solid.bodyId : undefined;
        const solidFaces = Array.isArray(solid.faces) ? solid.faces : [];
        const solidEdges = Array.isArray(solid.edges) ? solid.edges : [];
        let triangleCount = 0;
        solidFaces.forEach((face: RawTessFace, faceIndex: number) => {
            const nodeData = toPositions(face.nodes, `face ${faceIndex + 1}`);
            if (!Array.isArray(face.triangles)) {
                throw new Error(`Invalid tessellation: face ${faceIndex + 1} triangles are missing`);
            }
            const indices = new Uint32Array(face.triangles.length * 3);
            for (let i = 0; i < face.triangles.length; i++) {
                const triangle = face.triangles[i];
                if (!Array.isArray(triangle) || triangle.length < 3) {
                    throw new Error(`Invalid tessellation: face ${faceIndex + 1} triangle ${i} is not a triple`);
                }
                indices[i * 3] = Number(triangle[0]);
                indices[i * 3 + 1] = Number(triangle[1]);
                indices[i * 3 + 2] = Number(triangle[2]);
            }
            triangleCount += face.triangles.length;
            faces.push({
                faceId: typeof face.faceId === 'number' ? face.faceId : faceIndex + 1,
                solidId,
                bodyId: typeof face.bodyId === 'string' ? face.bodyId : bodyId,
                fingerprint: face.fingerprint as FaceFingerprint | undefined,
                nodeCount: nodeData.count,
                triangleCount: face.triangles.length,
                positions: nodeData.positions,
                indices
            });
        });
        solidEdges.forEach((edge: RawTessEdge, edgeIndex: number) => {
            const pointData = toPositions(edge.points, `edge ${edgeIndex + 1}`);
            edges.push({
                edgeId: typeof edge.edgeId === 'number' ? edge.edgeId : edgeIndex + 1,
                solidId,
                bodyId: typeof edge.bodyId === 'string' ? edge.bodyId : bodyId,
                fingerprint: edge.fingerprint as EdgeFingerprint | undefined,
                pointCount: pointData.count,
                positions: pointData.positions
            });
        });
        solids.push({
            solidId,
            bodyId,
            faceCount: solidFaces.length,
            edgeCount: solidEdges.length,
            triangleCount,
            properties: solid.properties as TessSolidProperties | undefined
        });
    });

    const curves: ParsedTessCurve[] = [];
    if (raw.curves !== undefined) {
        if (!Array.isArray(raw.curves)) {
            throw new Error('Invalid tessellation: curves is not an array');
        }
        for (const curve of raw.curves as RawTessCurve[]) {
            const pointData = toPositions(curve.points, `curve ${String(curve.id)}`);
            curves.push({
                id: String(curve.id ?? ''),
                name: typeof curve.name === 'string' ? curve.name : String(curve.id ?? ''),
                closed: curve.closed === true,
                positions: pointData.positions
            });
        }
    }

    return {
        version: typeof raw.version === 'number' ? raw.version : 0,
        tolerance: typeof raw.tolerance === 'number' ? raw.tolerance : 0,
        boundingBox: { min: bbox.min as number[], max: bbox.max as number[] },
        solids,
        faces,
        edges,
        curves
    };
}

/** All backing buffers of a parsed payload, for zero-copy worker transfer. */
export function collectTransferables(data: ParsedTessData): Transferable[] {
    const buffers: Transferable[] = [];
    for (const face of data.faces) {
        buffers.push(face.positions.buffer as ArrayBuffer, face.indices.buffer as ArrayBuffer);
    }
    for (const edge of data.edges) {
        buffers.push(edge.positions.buffer as ArrayBuffer);
    }
    for (const curve of data.curves) {
        buffers.push(curve.positions.buffer as ArrayBuffer);
    }
    return buffers;
}

/** Rounding for the geometric fallback key: sub-micron wobble must not churn it. */
const SIGNATURE_DECIMALS = 1e6;

function round6(value: number): number {
    return Math.round(value * SIGNATURE_DECIMALS) / SIGNATURE_DECIMALS;
}

/**
 * Content-based reuse key for one face.
 *
 * Preferred key is the backend's geometric fingerprint (surface type, area,
 * centroid, axis data) — content-based and verified stable across identical
 * rebuilds. Most faces carry one, but extraction can fail (fragmented boolean
 * faces); those fall back to a signature of the tessellated geometry itself
 * (counts + rounded bounding box + coordinate sums + endpoints), which is
 * deterministic for an unchanged face because the backend mesher is
 * deterministic. Neither key includes the positional `solidId`/`faceId`, so
 * solids may shuffle between builds without churning reuse.
 */
export function faceReuseKey(face: Pick<ParsedTessFace, 'fingerprint' | 'nodeCount' | 'triangleCount' | 'positions'>): string {
    if (face.fingerprint !== undefined) {
        return `fp:${JSON.stringify(face.fingerprint)}`;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    const positions = face.positions;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        if (x < minX) {
            minX = x;
        }
        if (y < minY) {
            minY = y;
        }
        if (z < minZ) {
            minZ = z;
        }
        if (x > maxX) {
            maxX = x;
        }
        if (y > maxY) {
            maxY = y;
        }
        if (z > maxZ) {
            maxZ = z;
        }
        sumX += x;
        sumY += y;
        sumZ += z;
    }
    const last = positions.length - 3;
    return [
        'geo',
        face.nodeCount,
        face.triangleCount,
        round6(minX),
        round6(minY),
        round6(minZ),
        round6(maxX),
        round6(maxY),
        round6(maxZ),
        round6(sumX),
        round6(sumY),
        round6(sumZ),
        round6(positions[0]),
        round6(positions[1]),
        round6(positions[2]),
        round6(positions[last]),
        round6(positions[last + 1]),
        round6(positions[last + 2])
    ].join(':');
}

/** One matched pair: the pooled mesh for `key` serves the new `face`. */
export interface ReusedFaceEntry {
    readonly key: string;
    readonly face: ParsedTessFace;
}

/** Diff plan mapping a new tessellation onto the previous build's face meshes. */
export interface FaceReusePlan {
    /** Faces with no matching previous entry; their meshes must be built. */
    readonly added: readonly ParsedTessFace[];
    /** Faces whose geometry can be carried over; only userData needs re-derivation. */
    readonly reused: readonly ReusedFaceEntry[];
    /** Keys with leftover pooled meshes (geometry vanished); dispose them. */
    readonly removedKeys: readonly string[];
}

/**
 * Plan the incremental scene update from the previous tessellation to the next.
 * Keys may repeat (geometrically identical faces, e.g. pattern instances), so
 * matching consumes a multiset: each new face takes one pooled mesh with the
 * same key; leftovers are disposed.
 */
export function planFaceReuse(previous: ParsedTessData | undefined, next: ParsedTessData): FaceReusePlan {
    const pool = new Map<string, number>();
    if (previous !== undefined) {
        for (const face of previous.faces) {
            const key = faceReuseKey(face);
            pool.set(key, (pool.get(key) ?? 0) + 1);
        }
    }
    const reused: ReusedFaceEntry[] = [];
    const added: ParsedTessFace[] = [];
    for (const face of next.faces) {
        const key = faceReuseKey(face);
        const available = pool.get(key) ?? 0;
        if (available > 0) {
            pool.set(key, available - 1);
            reused.push({ key, face });
        } else {
            added.push(face);
        }
    }
    const removedKeys: string[] = [];
    for (const [key, count] of pool) {
        if (count > 0) {
            removedKeys.push(key);
        }
    }
    return { added, reused, removedKeys };
}
