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
 * Pure curve evaluators for sketch rendering, snapping, and codegen: the
 * analytic ellipse polyline and a De Boor B-spline sampler.
 *
 * No framework, DOM, or three.js dependencies — the rendering controller, the
 * snap engine, and the Python exporter share the sampled polylines produced
 * here.
 *
 * @module nuke-cad/common
 */

/** A 2D point in sketch-local coordinates (structurally identical to snap's Point2). */
export interface Point2 {
    x: number;
    y: number;
}

/** Semi-axis bundle for an ellipse stored as planegcs models it. */
export interface EllipseAxes {
    center: Point2;
    major: number;
    minor: number;
    /** Rotation of the major axis from +x, radians (atan2 of center→focus1). */
    phi: number;
}

/**
 * Derive the analytic semi-axes of a planegcs ellipse.
 *
 * planegcs stores `{ c_id, focus1_id, radmin }` (FreeCAD convention): the
 * focus sets the major-axis direction and the focal distance, so
 * `major = √(radmin² + |c−f1|²)` and `minor = radmin`.
 */
export function ellipseAxes(center: Point2, focus1: Point2, radmin: number): EllipseAxes {
    const dx = focus1.x - center.x;
    const dy = focus1.y - center.y;
    return {
        center,
        major: Math.sqrt(radmin * radmin + dx * dx + dy * dy),
        minor: radmin,
        phi: Math.atan2(dy, dx)
    };
}

/** Sample an ellipse into a closed polyline (first point repeated at the end). */
export function sampleEllipse(center: Point2, focus1: Point2, radmin: number, segments = 64): Point2[] {
    const { major, minor, phi } = ellipseAxes(center, focus1, radmin);
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const points: Point2[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        const x = major * Math.cos(t);
        const y = minor * Math.sin(t);
        points.push({ x: center.x + x * cosPhi - y * sinPhi, y: center.y + x * sinPhi + y * cosPhi });
    }
    return points;
}

/**
 * Clamped uniform knot vector for the given pole count and degree.
 *
 * The knot values span `[0, poleCount − degree]`; end knots carry multiplicity
 * `degree + 1` so the curve interpolates the first and last pole — those
 * poles double as wire endpoints for loop assembly.
 */
export function clampedUniformKnots(poleCount: number, degree: number): { knots: number[]; mult: number[] } {
    if (!Number.isInteger(poleCount) || poleCount < 2) {
        throw new Error(`poleCount must be an integer >= 2, got ${poleCount}`);
    }
    if (!Number.isInteger(degree) || degree < 1 || poleCount < degree + 1) {
        throw new Error(`degree must be an integer in [1, poleCount - 1], got ${degree} for ${poleCount} poles`);
    }
    const spans = poleCount - degree;
    const knots: number[] = [];
    const mult: number[] = [];
    for (let i = 0; i <= spans; i++) {
        knots.push(i);
        mult.push(i === 0 || i === spans ? degree + 1 : 1);
    }
    return { knots, mult };
}

/** Expand a (knots, multiplicities) pair into the flat non-decreasing knot vector. */
export function expandKnots(knots: readonly number[], mult: readonly number[]): number[] {
    if (knots.length !== mult.length) {
        throw new Error(`knots/mult length mismatch: ${knots.length} vs ${mult.length}`);
    }
    const expanded: number[] = [];
    for (let i = 0; i < knots.length; i++) {
        for (let j = 0; j < mult[i]; j++) {
            expanded.push(knots[i]);
        }
    }
    return expanded;
}

/**
 * Evaluate a B-spline curve at parameter `u` with the De Boor algorithm.
 *
 * `knots` is the flat non-decreasing knot vector of length
 * `poles.length + degree + 1`. All weights are assumed to be 1 (the only form
 * the sketcher authors). `u` is clamped into the valid range.
 */
export function deBoor(u: number, poles: readonly Point2[], knots: readonly number[], degree: number): Point2 {
    const n = poles.length - 1;
    const p = degree;
    if (knots.length !== n + p + 2) {
        throw new Error(`knot vector length ${knots.length} does not match ${n + 1} poles of degree ${p}`);
    }
    if (n < p) {
        throw new Error(`need at least ${p + 1} poles for degree ${p}, got ${n + 1}`);
    }

    const uMin = knots[p];
    const uMax = knots[n + 1];
    const clamped = Math.min(Math.max(u, uMin), uMax);

    // Find the span index k with U[k] <= clamped < U[k+1].
    let k = p;
    if (clamped >= uMax) {
        k = n;
    } else {
        for (let i = p; i <= n; i++) {
            if (clamped >= knots[i] && clamped < knots[i + 1]) {
                k = i;
                break;
            }
        }
    }

    // d[j] holds the de Boor intermediates for this evaluation only.
    const d: Point2[] = [];
    for (let j = 0; j <= p; j++) {
        d.push({ x: poles[k - p + j].x, y: poles[k - p + j].y });
    }
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const i = k - p + j;
            const denominator = knots[i + p - r + 1] - knots[i];
            const alpha = denominator === 0 ? 0 : (clamped - knots[i]) / denominator;
            const a = d[j - 1];
            const b = d[j];
            d[j] = { x: (1 - alpha) * a.x + alpha * b.x, y: (1 - alpha) * a.y + alpha * b.y };
        }
    }
    return d[p];
}

/** Sample a (non-periodic, unit-weight) B-spline into an open polyline. */
export function sampleBSplineCurve(
    poles: readonly Point2[],
    knots: readonly number[],
    mult: readonly number[],
    degree: number,
    segments = 64
): Point2[] {
    if (poles.length < degree + 1) {
        throw new Error(`need at least ${degree + 1} poles for degree ${degree}, got ${poles.length}`);
    }
    const expanded = expandKnots(knots, mult);
    const uMin = expanded[degree];
    const uMax = expanded[expanded.length - degree - 1];
    const points: Point2[] = [];
    for (let i = 0; i <= segments; i++) {
        const u = uMin + ((uMax - uMin) * i) / segments;
        points.push(deBoor(u, poles, expanded, degree));
    }
    return points;
}

/** Distance from `raw` to the nearest polyline vertex, plus that vertex. */
export function nearestPolylinePoint(raw: Point2, polyline: readonly Point2[]): { point: Point2; distance: number } | undefined {
    let best: { point: Point2; distance: number } | undefined;
    for (const point of polyline) {
        const distance = Math.hypot(raw.x - point.x, raw.y - point.y);
        if (best === undefined || distance < best.distance) {
            best = { point, distance };
        }
    }
    return best;
}

const polylineCache = new Map<string, Point2[]>();
const POLYLINE_CACHE_LIMIT = 256;

function cachePolyline(key: string, compute: () => Point2[]): Point2[] {
    const cached = polylineCache.get(key);
    if (cached !== undefined) {
        // Refresh recency so hot entries survive eviction.
        polylineCache.delete(key);
        polylineCache.set(key, cached);
        return cached;
    }
    const computed = compute();
    polylineCache.set(key, computed);
    while (polylineCache.size > POLYLINE_CACHE_LIMIT) {
        const oldest = polylineCache.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        polylineCache.delete(oldest);
    }
    return computed;
}

function ellipseCacheKey(center: Point2, focus1: Point2, radmin: number): string {
    return `ellipse:${center.x},${center.y}:${focus1.x},${focus1.y}:${radmin}`;
}

function bsplineCacheKey(poles: readonly Point2[], knots: readonly number[], mult: readonly number[], degree: number): string {
    const fmt = (v: readonly number[]): string => v.map((x) => String(x)).join(',');
    return `bspline:${fmt(poles.map((p) => p.x))};${fmt(poles.map((p) => p.y))}:${fmt(knots)}:${fmt(mult)}:${degree}`;
}

/** Cached ellipse polyline shared by rendering and snapping. */
export function sharedEllipsePolyline(center: Point2, focus1: Point2, radmin: number, segments = 64): Point2[] {
    return cachePolyline(ellipseCacheKey(center, focus1, radmin), () => sampleEllipse(center, focus1, radmin, segments));
}

/** Cached B-spline polyline shared by rendering and snapping. */
export function sharedBSplinePolyline(
    poles: readonly Point2[],
    knots: readonly number[],
    mult: readonly number[],
    degree: number,
    segments = 64
): Point2[] {
    return cachePolyline(bsplineCacheKey(poles, knots, mult, degree), () => sampleBSplineCurve(poles, knots, mult, degree, segments));
}
