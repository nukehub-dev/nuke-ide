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
 * Circle radius estimation for the measure tool's radius mode.
 *
 * Pure 3D circle-fitting math shared by the viewport widget: radius picks
 * prefer the picked edge's fingerprint center (mean polyline distance to the
 * center), falling back to a least-squares (Kasa) circle fit over the edge
 * polyline in its best-fit plane. Non-circular edges are rejected with a
 * reason instead of producing a bogus number.
 *
 * @module nuke-cad/browser/widgets
 */

import { type MeasurePoint3D } from './measure-tool';

/** Minimum polyline points required for a circle fit. */
export const CIRCLE_FIT_MIN_POINTS = 3;

/**
 * Rejection threshold: mean absolute radial residual relative to the fitted
 * radius. Real circles/arcs tessellate to well under 1%; a 2% bound tolerates
 * coarse faceting while rejecting lines, splines, and ellipses.
 */
export const CIRCLE_FIT_MAX_RELATIVE_RESIDUAL = 0.02;

/** Successful circle fit: center and radius in model units plus quality data. */
export interface CircleFit {
    readonly center: MeasurePoint3D;
    readonly radius: number;
    /** Mean absolute radial residual divided by the radius. */
    readonly relativeResidual: number;
    readonly pointCount: number;
}

/** Edge inputs for a radius measurement, straight from an edge pick. */
export interface EdgeRadiusInput {
    /** Fingerprint curve type; only 'circle' edges qualify. */
    readonly curveType?: string;
    /** Fingerprint center for circular edges (radius fallback anchor). */
    readonly fingerprintCenter?: MeasurePoint3D;
    /** Edge polyline points in model units. */
    readonly points: readonly MeasurePoint3D[];
}

export type EdgeRadiusResult =
    | {
          readonly ok: true;
          readonly radius: number;
          readonly diameter: number;
          readonly center: MeasurePoint3D;
          readonly source: 'fingerprint' | 'fit';
      }
    | { readonly ok: false; readonly reason: string };

const FIT_EPSILON = 1e-12;

function subtract(a: MeasurePoint3D, b: MeasurePoint3D): MeasurePoint3D {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: MeasurePoint3D, b: MeasurePoint3D): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: MeasurePoint3D, b: MeasurePoint3D): MeasurePoint3D {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function length(a: MeasurePoint3D): number {
    return Math.sqrt(dot(a, a));
}

function normalize(a: MeasurePoint3D): MeasurePoint3D | undefined {
    const len = length(a);
    if (len < FIT_EPSILON) {
        return undefined;
    }
    return [a[0] / len, a[1] / len, a[2] / len];
}

/**
 * Smallest-eigenvalue eigenvector of a symmetric 3×3 matrix (row-major),
 * via cyclic Jacobi rotations. Used to find the best-fit plane normal.
 */
function smallestEigenvector3(matrix: readonly number[]): MeasurePoint3D | undefined {
    const original = [...matrix];
    let a = [...matrix];
    for (let sweep = 0; sweep < 24; sweep++) {
        let off = 0;
        for (const [p, q] of [
            [0, 1],
            [0, 2],
            [1, 2]
        ]) {
            const apq = a[p * 3 + q];
            off += apq * apq;
            if (Math.abs(apq) < 1e-15) {
                continue;
            }
            const app = a[p * 3 + p];
            const aqq = a[q * 3 + q];
            const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
            const c = Math.cos(phi);
            const s = Math.sin(phi);
            const next = [...a];
            for (let k = 0; k < 3; k++) {
                next[p * 3 + k] = c * a[p * 3 + k] - s * a[q * 3 + k];
                next[q * 3 + k] = s * a[p * 3 + k] + c * a[q * 3 + k];
            }
            for (let k = 0; k < 3; k++) {
                const colP = c * next[k * 3 + p] - s * next[k * 3 + q];
                const colQ = s * next[k * 3 + p] + c * next[k * 3 + q];
                next[k * 3 + p] = colP;
                next[k * 3 + q] = colQ;
            }
            a = next;
        }
        if (off < 1e-24) {
            break;
        }
    }
    // Eigenvector of the smallest diagonal entry: the null space of (A - λI),
    // taken as the largest cross product of its row pairs.
    let index = 0;
    for (let i = 1; i < 3; i++) {
        if (a[i * 3 + i] < a[index * 3 + index]) {
            index = i;
        }
    }
    const lambda = a[index * 3 + index];
    // Null space rows from the ORIGINAL matrix (the diagonalized form would
    // give the eigenvector in the rotated basis — useless).
    const rows: MeasurePoint3D[] = [
        [original[0] - lambda, original[1], original[2]],
        [original[3], original[4] - lambda, original[5]],
        [original[6], original[7], original[8] - lambda]
    ];
    let normal: MeasurePoint3D | undefined;
    let best = 0;
    for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
            const candidate = cross(rows[i], rows[j]);
            const norm = length(candidate);
            if (norm > best) {
                best = norm;
                normal = candidate;
            }
        }
    }
    return normal === undefined ? undefined : normalize(normal);
}

/** Solve a 3×3 linear system by Gaussian elimination with partial pivoting. */
function solve3(matrix: number[], rhs: number[]): number[] | undefined {
    const n = 3;
    const a = [...matrix];
    const b = [...rhs];
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(a[row * n + col]) > Math.abs(a[pivot * n + col])) {
                pivot = row;
            }
        }
        if (Math.abs(a[pivot * n + col]) < FIT_EPSILON) {
            return undefined;
        }
        if (pivot !== col) {
            for (let k = col; k < n; k++) {
                const tmp = a[col * n + k];
                a[col * n + k] = a[pivot * n + k];
                a[pivot * n + k] = tmp;
            }
            const tmp = b[col];
            b[col] = b[pivot];
            b[pivot] = tmp;
        }
        for (let row = col + 1; row < n; row++) {
            const factor = a[row * n + col] / a[col * n + col];
            for (let k = col; k < n; k++) {
                a[row * n + k] -= factor * a[col * n + k];
            }
            b[row] -= factor * b[col];
        }
    }
    const x = [0, 0, 0];
    for (let row = n - 1; row >= 0; row--) {
        let sum = b[row];
        for (let k = row + 1; k < n; k++) {
            sum -= a[row * n + k] * x[k];
        }
        x[row] = sum / a[row * n + row];
    }
    return x;
}

/**
 * Least-squares (Kasa) circle fit over 3D points.
 *
 * The best-fit plane normal is the smallest-eigenvalue eigenvector of the
 * point covariance; points are projected into that plane and the circle
 * center solves the Kasa normal equations. Returns undefined for degenerate
 * input (fewer than three points, a singular fit, or a non-positive radius).
 */
export function fitCircleKasa(points: readonly MeasurePoint3D[]): CircleFit | undefined {
    if (points.length < CIRCLE_FIT_MIN_POINTS) {
        return undefined;
    }
    const n = points.length;
    const centroid: [number, number, number] = [0, 0, 0];
    for (const p of points) {
        centroid[0] += p[0] / n;
        centroid[1] += p[1] / n;
        centroid[2] += p[2] / n;
    }
    // Covariance of the points (row-major symmetric 3×3).
    let xx = 0;
    let xy = 0;
    let xz = 0;
    let yy = 0;
    let yz = 0;
    let zz = 0;
    for (const p of points) {
        const d = subtract(p, centroid);
        xx += d[0] * d[0];
        xy += d[0] * d[1];
        xz += d[0] * d[2];
        yy += d[1] * d[1];
        yz += d[1] * d[2];
        zz += d[2] * d[2];
    }
    const normal = smallestEigenvector3([xx, xy, xz, xy, yy, yz, xz, yz, zz]);
    if (normal === undefined) {
        return undefined;
    }
    // Arbitrary in-plane basis.
    const ref: MeasurePoint3D = Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const axisU = normalize(cross(normal, ref));
    if (axisU === undefined) {
        return undefined;
    }
    const axisV = cross(normal, axisU);

    let suu = 0;
    let suv = 0;
    let svv = 0;
    let su = 0;
    let sv = 0;
    let suw = 0;
    let svw = 0;
    let sw = 0;
    const projected: Array<{ u: number; v: number; w: number }> = [];
    for (const p of points) {
        const d = subtract(p, centroid);
        const u = dot(d, axisU);
        const v = dot(d, axisV);
        const w = u * u + v * v;
        projected.push({ u, v, w });
        suu += u * u;
        suv += u * v;
        svv += v * v;
        su += u;
        sv += v;
        suw += u * w;
        svw += v * w;
        sw += w;
    }
    // Kasa: [2uc 2vc (r² - uc² - vc²)] solve [u v 1]·x = u² + v².
    const solution = solve3([suu, suv, su, suv, svv, sv, su, sv, n], [suw, svw, sw]);
    if (solution === undefined) {
        return undefined;
    }
    const uc = solution[0] / 2;
    const vc = solution[1] / 2;
    const radiusSq = solution[2] + uc * uc + vc * vc;
    if (!(radiusSq > FIT_EPSILON)) {
        return undefined;
    }
    const radius = Math.sqrt(radiusSq);
    const center: MeasurePoint3D = [
        centroid[0] + axisU[0] * uc + axisV[0] * vc,
        centroid[1] + axisU[1] * uc + axisV[1] * vc,
        centroid[2] + axisU[2] * uc + axisV[2] * vc
    ];
    let residualSum = 0;
    for (const p of points) {
        residualSum += Math.abs(length(subtract(p, center)) - radius);
    }
    return { center, radius, relativeResidual: residualSum / n / radius, pointCount: n };
}

/**
 * Radius of a picked edge, in priority order:
 *
 * 1. fingerprint center present → mean polyline distance to that center;
 * 2. otherwise a Kasa circle fit over the polyline — rejected when the edge
 *    is not circular (non-circle curve type or fit residual above
 *    {@link CIRCLE_FIT_MAX_RELATIVE_RESIDUAL}).
 */
export function edgeRadius(input: EdgeRadiusInput): EdgeRadiusResult {
    if (input.curveType !== undefined && input.curveType !== 'circle') {
        return { ok: false, reason: 'Picked edge is not a circle or arc' };
    }
    if (input.points.length < CIRCLE_FIT_MIN_POINTS) {
        return { ok: false, reason: 'Picked edge has too few points to fit a circle' };
    }
    if (input.fingerprintCenter !== undefined) {
        let sum = 0;
        for (const p of input.points) {
            sum += length(subtract(p, input.fingerprintCenter));
        }
        const radius = sum / input.points.length;
        if (!(radius > 0) || !Number.isFinite(radius)) {
            return { ok: false, reason: 'Picked edge has a degenerate circle center' };
        }
        return { ok: true, radius, diameter: radius * 2, center: input.fingerprintCenter, source: 'fingerprint' };
    }
    const fit = fitCircleKasa(input.points);
    if (fit === undefined) {
        return { ok: false, reason: 'Picked edge is not circular (circle fit failed)' };
    }
    if (fit.relativeResidual > CIRCLE_FIT_MAX_RELATIVE_RESIDUAL) {
        return { ok: false, reason: 'Picked edge is not circular (circle fit residual too large)' };
    }
    return { ok: true, radius: fit.radius, diameter: fit.radius * 2, center: fit.center, source: 'fit' };
}
