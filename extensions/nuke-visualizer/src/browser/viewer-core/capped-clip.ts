// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Capped-clipping geometry for the native 3D viewer core: turn the
 * hollow cross-section left by a clip plane into a solid-looking cap.
 *
 * Plane convention matches {@link ./clip-plane.ts} / `THREE.Plane`:
 * `n . p + c >= 0` is kept, the cap lies on `n . p + c = 0`. The caller
 * passes the same `{ normal, constant }` it gives the renderer's
 * `material.clippingPlanes`, so the cap always lands exactly in the cut.
 *
 * Algorithm:
 *
 * 1. Signed-distance each triangle against the plane. A triangle produces
 *    one boundary segment when exactly two of its distinct plane-contact
 *    points exist (edges crossing the plane, plus vertices lying on it).
 *    Triangles fully on one side contribute nothing; triangles lying in the
 *    plane are ignored (their boundary is supplied by the adjacent
 *    triangles, and they would otherwise double the cap).
 * 2. Contact points are merged through a quantized spatial hash, so a point
 *    computed twice from two adjacent triangles lands on one vertex and
 *    duplicated segments collapse.
 * 3. Segments are chained into loops. A loop is accepted only when every
 *    vertex has exactly two distinct neighbours (a closed 2-manifold ring);
 *    open chains, pinched/touching rings, and disconnected stubs are dropped.
 * 4. Each loop is projected onto an orthonormal plane basis `(u, v)` with
 *    `u x v = n`, oriented counter-clockwise (negative-area loops reverse),
 *    stripped of collinear vertices, and ear-clipped.
 *
 * Winding: output triangles are counter-clockwise around `+normal`, i.e.
 * their face normal points out of the kept half-space into the removed half
 * (the standard "cap faces the viewer looking into the cut" orientation).
 * A `FrontSide` material therefore shows the cap from the removed side; use
 * `DoubleSide` only when the camera can also orbit behind the kept side.
 *
 * Limitations (documented, not bugs):
 *
 * - Holes are not detected. Every closed loop is treated as an outer
 *   boundary and filled solid. That is correct for disjoint solids (one cap
 *   disk per DAGMC volume) and fills annular cross-sections solid.
 * - Triangles coplanar with the plane are skipped; an open sheet lying
 *   exactly in the plane therefore produces no cap.
 * - Loops above {@link MAX_CAP_LOOP_VERTICES} boundary vertices are dropped
 *   instead of triangulated (ear clipping is O(n^2)); the global
 *   {@link MAX_CAP_TRIANGLES} budget truncates the remaining loops.
 * - Segment collection bails out (returns undefined) above
 *   {@link MAX_CAP_SEGMENTS} unique segments.
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports. The
 * input soup is never mutated.
 */

/** A triangle soup in world coordinates: positions are `xyz xyz ...`, triangles are point-index triples. */
export interface CapTriangleSoup {
    readonly positions: ArrayLike<number>; // xyz xyz ...
    readonly triangles: ArrayLike<number>; // point indices, 3 per triangle
}

/** Largest boundary loop accepted for ear clipping; larger loops are dropped (perf guard). */
export const MAX_CAP_LOOP_VERTICES = 2048;

/** Largest number of cap triangles emitted across all loops (perf guard). */
export const MAX_CAP_TRIANGLES = 100_000;

/** Largest number of unique boundary segments collected before the build gives up (perf guard). */
export const MAX_CAP_SEGMENTS = 200_000;

/** Default plane/merge tolerance as a fraction of the soup bounding-box diagonal. */
const RELATIVE_EPSILON = 1e-6;

/** Below this length the plane normal is treated as degenerate. */
const MIN_NORMAL_LENGTH = 1e-12;

/** Maximum collinear-removal passes over one loop. */
const MAX_COLLINEAR_PASSES = 8;

/** Soft cap on point-in-triangle tests inside one ear clip (pathological/pinched loops). */
const MAX_EAR_CLIP_TESTS = 20_000_000;

/** A plane-local orthonormal basis with `u x v = n`. */
interface PlaneBasis {
    readonly u: readonly [number, number, number];
    readonly v: readonly [number, number, number];
}

/** A ring of boundary vertices after orientation/cleanup, ready for ear clipping. */
interface PreparedLoop {
    readonly indices: number[];
    readonly xs: number[];
    readonly ys: number[];
}

/**
 * Build the cap for the half-space `n . p + c >= 0`, clipped at
 * `n . p + c = 0`.
 *
 * @param soup triangle soup to cut (usually a mesh's positions + triangle indices)
 * @param normal plane normal; not required to be unit length
 * @param constant plane constant in the same convention as `THREE.Plane`
 * @param epsilon optional absolute distance tolerance for "on the plane" and
 *   for merging duplicate contact points; defaults to `1e-6` times the
 *   soup bounding-box diagonal. Non-finite or non-positive values fall back
 *   to the default.
 * @returns flat xyz positions, 9 floats per cap triangle, wound CCW around
 *   `+normal`; `undefined` when there is nothing to cap (no closed loop).
 */
export function buildClipCap(
    soup: CapTriangleSoup,
    normal: readonly [number, number, number],
    constant: number,
    epsilon?: number
): Float32Array | undefined {
    const positions = soup.positions;
    const triangles = soup.triangles;
    const pointCount = Math.floor(positions.length / 3);
    const triangleCount = Math.floor(triangles.length / 3);
    if (pointCount < 3 || triangleCount === 0) {
        return undefined;
    }

    const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
    if (!Number.isFinite(normalLength) || normalLength <= MIN_NORMAL_LENGTH || !Number.isFinite(constant)) {
        return undefined;
    }
    const nx = normal[0] / normalLength;
    const ny = normal[1] / normalLength;
    const nz = normal[2] / normalLength;
    const planeConstant = constant / normalLength;

    const tolerance = resolveTolerance(positions, pointCount, epsilon);
    const store = new CapPointIndex(tolerance);
    const neighbors: Array<number[] | undefined> = [];
    let segmentCount = 0;
    let first = -1;
    let second = -1;

    const addCandidate = (index: number): void => {
        if (first < 0) {
            first = index;
        } else if (index !== first && second < 0) {
            second = index;
        }
    };

    for (let t = 0; t < triangleCount; t++) {
        const base = t * 3;
        const i0 = triangles[base];
        const i1 = triangles[base + 1];
        const i2 = triangles[base + 2];
        if (!isPointIndex(i0, pointCount) || !isPointIndex(i1, pointCount) || !isPointIndex(i2, pointCount)) {
            continue;
        }
        const p0 = i0 * 3;
        const p1 = i1 * 3;
        const p2 = i2 * 3;
        const x0 = positions[p0];
        const y0 = positions[p0 + 1];
        const z0 = positions[p0 + 2];
        const x1 = positions[p1];
        const y1 = positions[p1 + 1];
        const z1 = positions[p1 + 2];
        const x2 = positions[p2];
        const y2 = positions[p2 + 1];
        const z2 = positions[p2 + 2];
        const d0 = nx * x0 + ny * y0 + nz * z0 + planeConstant;
        const d1 = nx * x1 + ny * y1 + nz * z1 + planeConstant;
        const d2 = nx * x2 + ny * y2 + nz * z2 + planeConstant;
        if (!Number.isFinite(d0) || !Number.isFinite(d1) || !Number.isFinite(d2)) {
            continue;
        }
        const s0 = d0 > tolerance ? 1 : d0 < -tolerance ? -1 : 0;
        const s1 = d1 > tolerance ? 1 : d1 < -tolerance ? -1 : 0;
        const s2 = d2 > tolerance ? 1 : d2 < -tolerance ? -1 : 0;
        // Fully on one side, or coplanar: no cut segment.
        if (s0 === s1 && s1 === s2) {
            continue;
        }

        first = -1;
        second = -1;
        if (s0 === 0) {
            addCandidate(store.insert(x0, y0, z0));
        }
        if (s1 === 0) {
            addCandidate(store.insert(x1, y1, z1));
        }
        if (s2 === 0) {
            addCandidate(store.insert(x2, y2, z2));
        }
        if (s0 * s1 < 0) {
            const k = d0 / (d0 - d1);
            addCandidate(store.insert(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, z0 + (z1 - z0) * k));
        }
        if (s1 * s2 < 0) {
            const k = d1 / (d1 - d2);
            addCandidate(store.insert(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, z1 + (z2 - z1) * k));
        }
        if (s2 * s0 < 0) {
            const k = d2 / (d2 - d0);
            addCandidate(store.insert(x2 + (x0 - x2) * k, y2 + (y0 - y2) * k, z2 + (z0 - z2) * k));
        }
        if (first < 0 || second < 0) {
            continue;
        }
        if (addSegment(neighbors, first, second)) {
            segmentCount++;
            if (segmentCount > MAX_CAP_SEGMENTS) {
                return undefined;
            }
        }
    }

    if (segmentCount === 0) {
        return undefined;
    }

    const basis = planeBasis(nx, ny, nz);
    const visited = new Uint8Array(neighbors.length);
    const output: number[] = [];
    let capTriangles = 0;
    for (let start = 0; start < neighbors.length; start++) {
        const adjacent = neighbors[start];
        if (!adjacent || adjacent.length !== 2 || visited[start] === 1) {
            continue;
        }
        const loop = walkLoop(start, neighbors, visited);
        if (!loop) {
            continue;
        }
        capTriangles += appendLoopTriangles(loop, store.coordinates, basis, tolerance, output, MAX_CAP_TRIANGLES - capTriangles);
        if (capTriangles >= MAX_CAP_TRIANGLES) {
            break;
        }
    }

    return output.length > 0 ? Float32Array.from(output) : undefined;
}

/** Whether `value` is a usable point index into a soup with `pointCount` points. */
function isPointIndex(value: number, pointCount: number): boolean {
    return Number.isInteger(value) && value >= 0 && value < pointCount;
}

/**
 * Resolve the working tolerance: an explicit positive finite `epsilon` wins,
 * otherwise `1e-6` of the soup bounding-box diagonal (1e-6 for degenerate
 * soups). The tolerance doubles as the contact-point merge quantum, so the
 * quantized index magnitudes stay around `1 / 1e-6`.
 */
function resolveTolerance(positions: ArrayLike<number>, pointCount: number, epsilon?: number): number {
    if (epsilon !== undefined && Number.isFinite(epsilon) && epsilon > 0) {
        return epsilon;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < pointCount; i++) {
        const offset = i * 3;
        const x = positions[offset];
        const y = positions[offset + 1];
        const z = positions[offset + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
        }
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
    }
    if (minX === Infinity) {
        return RELATIVE_EPSILON;
    }
    const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    return RELATIVE_EPSILON * (diagonal > 0 && Number.isFinite(diagonal) ? diagonal : 1);
}

/**
 * Quantized point store: contact points closer than the quantum merge onto
 * the first inserted representative. Insertion probes the 3x3x3 cell
 * neighbourhood so two near-identical points that straddle a cell boundary
 * still merge; the distance check keeps hash collisions from merging
 * unrelated points.
 */
class CapPointIndex {
    private readonly buckets = new Map<number, number[]>();
    private readonly quantum: number;
    readonly coordinates: number[] = [];

    constructor(quantum: number) {
        this.quantum = quantum;
    }

    get size(): number {
        return this.coordinates.length / 3;
    }

    insert(x: number, y: number, z: number): number {
        const quantum = this.quantum;
        const ix = Math.round(x / quantum);
        const iy = Math.round(y / quantum);
        const iz = Math.round(z / quantum);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const bucket = this.buckets.get(cellHash(ix + dx, iy + dy, iz + dz));
                    if (!bucket) {
                        continue;
                    }
                    for (let k = 0; k < bucket.length; k++) {
                        const index = bucket[k];
                        const offset = index * 3;
                        if (
                            Math.abs(this.coordinates[offset] - x) <= quantum &&
                            Math.abs(this.coordinates[offset + 1] - y) <= quantum &&
                            Math.abs(this.coordinates[offset + 2] - z) <= quantum
                        ) {
                            return index;
                        }
                    }
                }
            }
        }
        const index = this.size;
        this.coordinates.push(x, y, z);
        const key = cellHash(ix, iy, iz);
        const bucket = this.buckets.get(key);
        if (bucket) {
            bucket.push(index);
        } else {
            this.buckets.set(key, [index]);
        }
        return index;
    }
}

/** 32-bit spatial hash of an integer cell coordinate (collisions are handled by the distance check). */
function cellHash(ix: number, iy: number, iz: number): number {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;
}

/** Undirected segment insertion; returns false when the segment already exists. */
function addSegment(neighbors: Array<number[] | undefined>, a: number, b: number): boolean {
    let listA = neighbors[a];
    let listB = neighbors[b];
    if (listA && listA.indexOf(b) >= 0) {
        return false;
    }
    if (!listA) {
        listA = [];
        neighbors[a] = listA;
    }
    if (!listB) {
        listB = [];
        neighbors[b] = listB;
    }
    listA.push(b);
    listB.push(a);
    return true;
}

/**
 * Walk a closed ring from `start`. Returns undefined for open chains or
 * pinched vertices (degree != 2); vertices touched by a rejected ring stay
 * marked, which is fine because graph components are disjoint.
 */
function walkLoop(start: number, neighbors: ReadonlyArray<number[] | undefined>, visited: Uint8Array): number[] | undefined {
    const loop: number[] = [];
    let previous = -1;
    let current = start;
    for (;;) {
        if (visited[current] === 1) {
            return undefined;
        }
        const adjacent = neighbors[current];
        if (!adjacent || adjacent.length !== 2) {
            return undefined;
        }
        visited[current] = 1;
        loop.push(current);
        const next = adjacent[0] !== previous ? adjacent[0] : adjacent[1];
        previous = current;
        current = next;
        if (current === start) {
            break;
        }
        if (loop.length > neighbors.length) {
            return undefined;
        }
    }
    return loop.length >= 3 ? loop : undefined;
}

/** Orthonormal plane basis with `u x v = n`, from the world axis least aligned with the normal. */
function planeBasis(nx: number, ny: number, nz: number): PlaneBasis {
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    let hx = 0;
    let hy = 0;
    let hz = 0;
    if (ax <= ay && ax <= az) {
        hx = 1;
    } else if (ay <= az) {
        hy = 1;
    } else {
        hz = 1;
    }
    let ux = hy * nz - hz * ny;
    let uy = hz * nx - hx * nz;
    let uz = hx * ny - hy * nx;
    const length = Math.hypot(ux, uy, uz);
    ux /= length;
    uy /= length;
    uz /= length;
    const vx = ny * uz - nz * uy;
    const vy = nz * ux - nx * uz;
    const vz = nx * uy - ny * ux;
    return { u: [ux, uy, uz], v: [vx, vy, vz] };
}

/**
 * Project one 3D loop onto the plane, orient it CCW around `+normal`,
 * clean it, and append its ear-clipped triangles to `output`.
 *
 * @returns number of triangles appended (0 when the loop is degenerate or drops out)
 */
function appendLoopTriangles(
    loop: readonly number[],
    coordinates: readonly number[],
    basis: PlaneBasis,
    tolerance: number,
    output: number[],
    budget: number
): number {
    const size = loop.length;
    if (size < 3 || budget <= 0) {
        return 0;
    }
    const xs = new Array<number>(size);
    const ys = new Array<number>(size);
    for (let i = 0; i < size; i++) {
        const offset = loop[i] * 3;
        const x = coordinates[offset];
        const y = coordinates[offset + 1];
        const z = coordinates[offset + 2];
        xs[i] = x * basis.u[0] + y * basis.u[1] + z * basis.u[2];
        ys[i] = x * basis.v[0] + y * basis.v[1] + z * basis.v[2];
    }
    const area = signedArea(xs, ys);
    if (!Number.isFinite(area) || Math.abs(area) <= tolerance * tolerance) {
        return 0;
    }
    const indices = loop.slice();
    if (area < 0) {
        indices.reverse();
        xs.reverse();
        ys.reverse();
    }
    const prepared = removeCollinear(indices, xs, ys, tolerance);
    if (!prepared || prepared.indices.length < 3 || prepared.indices.length > MAX_CAP_LOOP_VERTICES) {
        return 0;
    }
    const earIndices = earClip(prepared.xs, prepared.ys);
    if (!earIndices) {
        return 0;
    }
    const triangleCount = Math.min(earIndices.length / 3, budget);
    for (let t = 0; t < triangleCount; t++) {
        for (let corner = 0; corner < 3; corner++) {
            const offset = prepared.indices[earIndices[t * 3 + corner]] * 3;
            output.push(coordinates[offset], coordinates[offset + 1], coordinates[offset + 2]);
        }
    }
    return triangleCount;
}

/** Twice-signed area of a 2D polygon (positive = counter-clockwise). */
function signedArea(xs: readonly number[], ys: readonly number[]): number {
    const size = xs.length;
    let twice = 0;
    for (let i = 0; i < size; i++) {
        const next = (i + 1) % size;
        twice += xs[i] * ys[next] - xs[next] * ys[i];
    }
    return twice / 2;
}

/** Distance from `(bx, by)` to the line through `a` and `c` (0 when the line degenerates). */
function lineDistance(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
    const dx = cx - ax;
    const dy = cy - ay;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
        return Math.hypot(bx - ax, by - ay);
    }
    return Math.abs((bx - ax) * dy - (by - ay) * dx) / length;
}

/**
 * Drop vertices that sit on the line through their neighbours (including
 * the collinear points a plane-through-a-vertex cut leaves behind). Runs a
 * bounded number of passes so chains of collinear vertices collapse fully.
 */
function removeCollinear(
    indices: readonly number[],
    xs: readonly number[],
    ys: readonly number[],
    tolerance: number
): PreparedLoop | undefined {
    let currentIndices = indices.slice();
    let currentXs = xs.slice();
    let currentYs = ys.slice();
    let size = currentIndices.length;
    for (let pass = 0; pass < MAX_COLLINEAR_PASSES && size > 3; pass++) {
        const keptIndices: number[] = [];
        const keptXs: number[] = [];
        const keptYs: number[] = [];
        for (let i = 0; i < size; i++) {
            const previous = (i + size - 1) % size;
            const next = (i + 1) % size;
            const distance = lineDistance(
                currentXs[previous],
                currentYs[previous],
                currentXs[i],
                currentYs[i],
                currentXs[next],
                currentYs[next]
            );
            if (distance <= tolerance) {
                continue;
            }
            keptIndices.push(currentIndices[i]);
            keptXs.push(currentXs[i]);
            keptYs.push(currentYs[i]);
        }
        if (keptIndices.length === size) {
            break;
        }
        if (keptIndices.length < 3) {
            return undefined;
        }
        currentIndices = keptIndices;
        currentXs = keptXs;
        currentYs = keptYs;
        size = keptIndices.length;
    }
    return { indices: currentIndices, xs: currentXs, ys: currentYs };
}

/**
 * Ear-clip a simple CCW polygon (no duplicate/collinear vertices required —
 * the caller strips collinear ones). Returns point triples (indices into the
 * input arrays) or undefined for a self-intersecting/degenerate ring.
 */
function earClip(xs: readonly number[], ys: readonly number[]): number[] | undefined {
    const size = xs.length;
    if (size < 3) {
        return undefined;
    }
    if (size === 3) {
        return [0, 1, 2];
    }
    const previous = new Int32Array(size);
    const next = new Int32Array(size);
    for (let i = 0; i < size; i++) {
        previous[i] = (i + size - 1) % size;
        next[i] = (i + 1) % size;
    }
    const earIndices: number[] = [];
    const budget = { tests: 0 };
    let remaining = size;
    let ear = 0;
    while (remaining > 3) {
        let found = -1;
        let candidate = ear;
        for (let scanned = 0; scanned < remaining; scanned++) {
            if (isEar(candidate, previous, next, xs, ys, budget)) {
                found = candidate;
                break;
            }
            if (budget.tests > MAX_EAR_CLIP_TESTS) {
                return undefined;
            }
            candidate = next[candidate];
        }
        if (found < 0) {
            return undefined;
        }
        const a = previous[found];
        const c = next[found];
        earIndices.push(a, found, c);
        next[a] = c;
        previous[c] = a;
        remaining--;
        ear = a;
    }
    earIndices.push(previous[ear], ear, next[ear]);
    return earIndices;
}

/** Whether vertex `i` is a valid ear of the active polygon (convex and empty). */
function isEar(
    i: number,
    previous: Int32Array,
    next: Int32Array,
    xs: readonly number[],
    ys: readonly number[],
    budget: { tests: number }
): boolean {
    const a = previous[i];
    const c = next[i];
    const ax = xs[a];
    const ay = ys[a];
    const bx = xs[i];
    const by = ys[i];
    const cx = xs[c];
    const cy = ys[c];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross <= 0) {
        return false;
    }
    let probe = next[c];
    while (probe !== a) {
        budget.tests++;
        if (pointInTriangle(xs[probe], ys[probe], ax, ay, bx, by, cx, cy)) {
            return false;
        }
        probe = next[probe];
    }
    return true;
}

/** Inclusive point-in-triangle test (boundary counts as inside, keeping ear clipping conservative). */
function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNegative && hasPositive);
}
