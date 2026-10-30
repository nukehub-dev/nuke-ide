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
 * Pure 2D snap engine for the sketcher.
 *
 * No framework or DOM dependencies. Distances are in sketch-local model units;
 * the caller converts screen pixels to model units before invoking snap().
 *
 * @module nuke-cad/browser/sketch
 */

import type {
    SketchPrimitive,
    SketchPoint,
    SketchLine,
    SketchCircle,
    SketchArc,
    SketchEllipse,
    SketchBSpline
} from '../../common/sketch-solver';
import { sharedEllipsePolyline, sharedBSplinePolyline, nearestPolylinePoint } from '../../common/sketch-curves';

export type { SketchPrimitive, SketchPoint, SketchLine, SketchCircle, SketchArc, SketchEllipse, SketchBSpline };

/** A 2D point in sketch-local coordinates. */
export interface Point2 {
    x: number;
    y: number;
}

/** The kind of snap that was applied, ordered by priority. */
export type SnapKind = 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'on_curve' | 'grid';

/** Result of evaluating snap for a raw pointer position. */
export interface SnapResult {
    /** The snapped position. */
    point: Point2;
    /** The winning snap kind, or undefined when no snap applied. */
    kind: SnapKind | undefined;
    /** Id of the primitive that produced the snap, when applicable. */
    sourceId: string | undefined;
    /** For endpoint/midpoint/center snaps, the id of the point primitive when one exists. */
    pointId: string | undefined;
}

/** Snap configuration. */
export interface SnapConfig {
    /** Master snap enable switch. */
    enabled: boolean;
    /** Search radius in model units. */
    radius: number;
    /** Grid snap enable switch. */
    gridEnabled: boolean;
    /** Grid pitch in model units. */
    gridPitch: number;
}

/** Default snap configuration. */
export const DEFAULT_SNAP_CONFIG: SnapConfig = {
    enabled: true,
    radius: 0.25,
    gridEnabled: true,
    gridPitch: 1
};

/** Create a snap config by overriding defaults. */
export function createSnapConfig(overrides?: Partial<SnapConfig>): SnapConfig {
    return { ...DEFAULT_SNAP_CONFIG, ...overrides };
}

interface ClassifiedPrimitives {
    pointMap: Map<string, SketchPoint>;
    lines: SketchLine[];
    circles: SketchCircle[];
    arcs: SketchArc[];
    ellipses: SketchEllipse[];
    bsplines: SketchBSpline[];
    centerPointIds: Set<string>;
}

function classify(primitives: readonly SketchPrimitive[]): ClassifiedPrimitives {
    const pointMap = new Map<string, SketchPoint>();
    const lines: SketchLine[] = [];
    const circles: SketchCircle[] = [];
    const arcs: SketchArc[] = [];
    const ellipses: SketchEllipse[] = [];
    const bsplines: SketchBSpline[] = [];
    const centerPointIds = new Set<string>();

    for (const p of primitives) {
        if (p.type === 'point') {
            pointMap.set(p.id, p);
        } else if (p.type === 'line') {
            lines.push(p);
        } else if (p.type === 'circle') {
            circles.push(p);
            centerPointIds.add(p.centerId);
        } else if (p.type === 'arc') {
            arcs.push(p);
            centerPointIds.add(p.centerId);
        } else if (p.type === 'ellipse') {
            ellipses.push(p);
            centerPointIds.add(p.centerId);
        } else if (p.type === 'bspline') {
            bsplines.push(p);
        }
    }
    return { pointMap, lines, circles, arcs, ellipses, bsplines, centerPointIds };
}

function dist2(a: Point2, b: Point2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function sub(a: Point2, b: Point2): Point2 {
    return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Point2, b: Point2): number {
    return a.x * b.x + a.y * b.y;
}

function len(a: Point2): number {
    return Math.hypot(a.x, a.y);
}

function normalize(a: Point2): Point2 {
    const length = len(a);
    if (length === 0) {
        return { x: 0, y: 0 };
    }
    return { x: a.x / length, y: a.y / length };
}

function projectPointOntoSegment(point: Point2, a: Point2, b: Point2): Point2 {
    const ab = sub(b, a);
    const t = dot(sub(point, a), ab) / dot(ab, ab);
    const clamped = Math.max(0, Math.min(1, t));
    return { x: a.x + ab.x * clamped, y: a.y + ab.y * clamped };
}

function nearestPointOnCircle(point: Point2, center: Point2, radius: number): Point2 {
    const direction = normalize(sub(point, center));
    return { x: center.x + direction.x * radius, y: center.y + direction.y * radius };
}

function normalizeAngle(angle: number): number {
    let a = angle % (2 * Math.PI);
    if (a < 0) {
        a += 2 * Math.PI;
    }
    return a;
}

function isAngleOnArc(angle: number, startAngle: number, endAngle: number): boolean {
    const a = normalizeAngle(angle);
    const s = normalizeAngle(startAngle);
    const e = normalizeAngle(endAngle);
    if (s <= e) {
        return a >= s - 1e-12 && a <= e + 1e-12;
    }
    // Arc crosses the 0/2π boundary.
    return a >= s - 1e-12 || a <= e + 1e-12;
}

function snapEndpoint(raw: Point2, classified: ClassifiedPrimitives, radius: number): SnapResult | undefined {
    const { pointMap, lines, arcs, bsplines, centerPointIds } = classified;
    let best: { point: Point2; id: string; distance: number } | undefined;

    // Endpoint snaps include line/arc endpoints, bspline end poles, and
    // standalone points that are not circle/arc/ellipse centers.
    const endpointIds = new Set<string>();
    for (const line of lines) {
        endpointIds.add(line.p1Id);
        endpointIds.add(line.p2Id);
    }
    for (const arc of arcs) {
        endpointIds.add(arc.startId);
        endpointIds.add(arc.endId);
    }
    for (const bspline of bsplines) {
        endpointIds.add(bspline.poleIds[0]);
        endpointIds.add(bspline.poleIds[bspline.poleIds.length - 1]);
    }
    for (const [id, point] of pointMap) {
        if (endpointIds.has(id) || !centerPointIds.has(id)) {
            const distance = Math.sqrt(dist2(raw, point));
            if (distance <= radius && (best === undefined || distance < best.distance)) {
                best = { point, id, distance };
            }
        }
    }

    if (best === undefined) {
        return undefined;
    }
    return { point: { x: best.point.x, y: best.point.y }, kind: 'endpoint', sourceId: best.id, pointId: best.id };
}

function snapMidpoint(raw: Point2, classified: ClassifiedPrimitives, radius: number): SnapResult | undefined {
    let best: { point: Point2; id: string; distance: number } | undefined;

    for (const line of classified.lines) {
        const p1 = classified.pointMap.get(line.p1Id);
        const p2 = classified.pointMap.get(line.p2Id);
        if (p1 === undefined || p2 === undefined) {
            continue;
        }
        const midpoint: Point2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
        const distance = Math.sqrt(dist2(raw, midpoint));
        if (distance <= radius && (best === undefined || distance < best.distance)) {
            best = { point: midpoint, id: line.id, distance };
        }
    }

    if (best === undefined) {
        return undefined;
    }
    return { point: { x: best.point.x, y: best.point.y }, kind: 'midpoint', sourceId: best.id, pointId: undefined };
}

function snapCenter(raw: Point2, classified: ClassifiedPrimitives, radius: number): SnapResult | undefined {
    let best: { point: Point2; primitiveId: string; centerId: string; distance: number } | undefined;

    const candidates = [...classified.circles, ...classified.arcs, ...classified.ellipses];
    for (const primitive of candidates) {
        const center = classified.pointMap.get(primitive.centerId);
        if (center === undefined) {
            continue;
        }
        const distance = Math.sqrt(dist2(raw, center));
        if (distance <= radius && (best === undefined || distance < best.distance)) {
            best = { point: center, primitiveId: primitive.id, centerId: primitive.centerId, distance };
        }
    }

    if (best === undefined) {
        return undefined;
    }
    return { point: { x: best.point.x, y: best.point.y }, kind: 'center', sourceId: best.primitiveId, pointId: best.centerId };
}

function snapQuadrant(raw: Point2, classified: ClassifiedPrimitives, radius: number): SnapResult | undefined {
    const angles = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
    let best: { point: Point2; id: string; distance: number } | undefined;

    const candidates: Array<SketchCircle | SketchArc> = [...classified.circles, ...classified.arcs];
    for (const primitive of candidates) {
        const center = classified.pointMap.get(primitive.centerId);
        if (center === undefined) {
            continue;
        }
        for (const angle of angles) {
            const quadrant: Point2 = {
                x: center.x + primitive.radius * Math.cos(angle),
                y: center.y + primitive.radius * Math.sin(angle)
            };
            const distance = Math.sqrt(dist2(raw, quadrant));
            if (distance <= radius && (best === undefined || distance < best.distance)) {
                best = { point: quadrant, id: primitive.id, distance };
            }
        }
    }

    if (best === undefined) {
        return undefined;
    }
    return { point: { x: best.point.x, y: best.point.y }, kind: 'quadrant', sourceId: best.id, pointId: undefined };
}

function snapOnCurve(raw: Point2, classified: ClassifiedPrimitives, radius: number): SnapResult | undefined {
    let best: { point: Point2; id: string; distance: number } | undefined;

    for (const line of classified.lines) {
        const p1 = classified.pointMap.get(line.p1Id);
        const p2 = classified.pointMap.get(line.p2Id);
        if (p1 === undefined || p2 === undefined) {
            continue;
        }
        const projected = projectPointOntoSegment(raw, p1, p2);
        // Skip endpoint hits; those are handled by endpoint snap at higher priority.
        const isEndpoint = dist2(projected, p1) < 1e-12 || dist2(projected, p2) < 1e-12;
        if (isEndpoint) {
            continue;
        }
        const distance = Math.sqrt(dist2(raw, projected));
        if (distance <= radius && (best === undefined || distance < best.distance)) {
            best = { point: projected, id: line.id, distance };
        }
    }

    for (const circle of classified.circles) {
        const center = classified.pointMap.get(circle.centerId);
        if (center === undefined) {
            continue;
        }
        const nearest = nearestPointOnCircle(raw, center, circle.radius);
        const distance = Math.sqrt(dist2(raw, nearest));
        if (distance <= radius && (best === undefined || distance < best.distance)) {
            best = { point: nearest, id: circle.id, distance };
        }
    }

    for (const arc of classified.arcs) {
        const center = classified.pointMap.get(arc.centerId);
        if (center === undefined) {
            continue;
        }
        const nearest = nearestPointOnCircle(raw, center, arc.radius);
        const angle = Math.atan2(nearest.y - center.y, nearest.x - center.x);
        if (!isAngleOnArc(angle, arc.startAngle, arc.endAngle)) {
            continue;
        }
        const distance = Math.sqrt(dist2(raw, nearest));
        if (distance <= radius && (best === undefined || distance < best.distance)) {
            best = { point: nearest, id: arc.id, distance };
        }
    }

    for (const ellipse of classified.ellipses) {
        const center = classified.pointMap.get(ellipse.centerId);
        const focus1 = classified.pointMap.get(ellipse.focus1Id);
        if (center === undefined || focus1 === undefined) {
            continue;
        }
        const nearest = nearestPolylinePoint(raw, sharedEllipsePolyline(center, focus1, ellipse.radmin));
        if (nearest === undefined || nearest.distance > radius || (best !== undefined && nearest.distance >= best.distance)) {
            continue;
        }
        best = { point: nearest.point, id: ellipse.id, distance: nearest.distance };
    }

    for (const bspline of classified.bsplines) {
        const poles: Point2[] = [];
        let valid = true;
        for (const poleId of bspline.poleIds) {
            const pole = classified.pointMap.get(poleId);
            if (pole === undefined) {
                valid = false;
                break;
            }
            poles.push(pole);
        }
        if (!valid || poles.length < bspline.degree + 1) {
            continue;
        }
        const nearest = nearestPolylinePoint(raw, sharedBSplinePolyline(poles, bspline.knots, bspline.mult, bspline.degree));
        if (nearest === undefined || nearest.distance > radius) {
            continue;
        }
        // End poles have their own endpoint snap at higher priority.
        const startPole = poles[0];
        const endPole = poles[poles.length - 1];
        if (dist2(nearest.point, startPole) < 1e-12 || dist2(nearest.point, endPole) < 1e-12) {
            continue;
        }
        if (best !== undefined && nearest.distance >= best.distance) {
            continue;
        }
        best = { point: nearest.point, id: bspline.id, distance: nearest.distance };
    }

    if (best === undefined) {
        return undefined;
    }
    return { point: { x: best.point.x, y: best.point.y }, kind: 'on_curve', sourceId: best.id, pointId: undefined };
}

function snapGrid(point: Point2, pitch: number): Point2 {
    return {
        x: Math.round(point.x / pitch) * pitch,
        y: Math.round(point.y / pitch) * pitch
    };
}

/**
 * Evaluate snap for a raw pointer position.
 *
 * Priority order: endpoint > midpoint > center > quadrant > on-curve > grid.
 */
export function snap(raw: Point2, primitives: readonly SketchPrimitive[], config: SnapConfig = DEFAULT_SNAP_CONFIG): SnapResult {
    if (!config.enabled) {
        return { point: raw, kind: undefined, sourceId: undefined, pointId: undefined };
    }

    const classified = classify(primitives);
    const radius = config.radius;

    const endpoint = snapEndpoint(raw, classified, radius);
    if (endpoint !== undefined) {
        return endpoint;
    }

    const midpoint = snapMidpoint(raw, classified, radius);
    if (midpoint !== undefined) {
        return midpoint;
    }

    const center = snapCenter(raw, classified, radius);
    if (center !== undefined) {
        return center;
    }

    const quadrant = snapQuadrant(raw, classified, radius);
    if (quadrant !== undefined) {
        return quadrant;
    }

    const onCurve = snapOnCurve(raw, classified, radius);
    if (onCurve !== undefined) {
        return onCurve;
    }

    if (config.gridEnabled && config.gridPitch > 0) {
        return { point: snapGrid(raw, config.gridPitch), kind: 'grid', sourceId: undefined, pointId: undefined };
    }

    return { point: raw, kind: undefined, sourceId: undefined, pointId: undefined };
}
