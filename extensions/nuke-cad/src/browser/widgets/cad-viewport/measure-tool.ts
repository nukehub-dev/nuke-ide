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
 * Measure-tool state for the CAD viewport.
 *
 * Pure point/distance/projection math shared by the viewport widget's
 * imperative overlay and its measurements popover. Distances are always in
 * model units (labels never assume millimeters); projection takes a
 * column-major view-projection matrix (THREE.Matrix4.elements layout) so the
 * math stays testable without three.js or Theia imports.
 *
 * @module nuke-cad/browser/widgets
 */

/** Which capture surface a measurement belongs to. */
export type MeasureKind = 'model3d' | 'sketch';

/** Which tool the measure popover selects; sketch mode is always distance. */
export type MeasureToolMode = 'distance' | 'angle' | 'radius';

/** A world-space point (x, y, z) in model units. */
export type MeasurePoint3D = readonly [number, number, number];

/** One committed two-point measurement. Sketch points live on the sketch plane. */
export interface MeasureSegment {
    readonly id: string;
    readonly kind: MeasureKind;
    readonly a: MeasurePoint3D;
    readonly b: MeasurePoint3D;
    /** Euclidean distance between a and b in model units. */
    readonly distance: number;
    readonly midpoint: MeasurePoint3D;
}

/** One committed three-point angle measurement; `b` is the vertex. */
export interface MeasureAngle {
    readonly id: string;
    readonly kind: MeasureKind;
    /** First leg endpoint. */
    readonly a: MeasurePoint3D;
    /** Vertex the angle is measured at. */
    readonly b: MeasurePoint3D;
    /** Second leg endpoint. */
    readonly c: MeasurePoint3D;
    /** Angle BAC…C at the vertex in degrees (0..180). */
    readonly angle: number;
}

/** One committed edge-radius measurement (model3d only). */
export interface MeasureRadius {
    readonly id: string;
    readonly kind: 'model3d';
    /** Circle center (fingerprint or fitted) the radius belongs to. */
    readonly center: MeasurePoint3D;
    readonly radius: number;
    readonly diameter: number;
}

/** Any committed measurement shown in the popover and the overlay. */
export type Measurement = MeasureSegment | MeasureAngle | MeasureRadius;

/** Type guard: two-point distance measurement. */
export function isMeasureSegment(measurement: Measurement): measurement is MeasureSegment {
    return 'distance' in measurement;
}

/** Type guard: three-point angle measurement. */
export function isMeasureAngle(measurement: Measurement): measurement is MeasureAngle {
    return 'angle' in measurement;
}

/** Type guard: edge-radius measurement. */
export function isMeasureRadius(measurement: Measurement): measurement is MeasureRadius {
    return 'radius' in measurement;
}

/** Visual state pushed from the React chrome down to the imperative overlay. */
export interface MeasureViewState {
    /** True while the tool captures clicks (selection/picking is suppressed). */
    readonly active: boolean;
    /** Which surface new clicks come from; only this kind's visuals render. */
    readonly mode: MeasureKind;
    /** Which tool captures clicks; sketch mode always behaves as 'distance'. */
    readonly tool: MeasureToolMode;
    readonly measurements: readonly Measurement[];
    /** First picked point waiting for its partner, if any. */
    readonly pending?: MeasurePoint3D;
    /** Angle mode: vertex pick waiting for the third point. */
    readonly pendingVertex?: MeasurePoint3D;
}

export function measureDistance(a: MeasurePoint3D, b: MeasurePoint3D): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function measureMidpoint(a: MeasurePoint3D, b: MeasurePoint3D): MeasurePoint3D {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

export function createMeasureSegment(id: string, kind: MeasureKind, a: MeasurePoint3D, b: MeasurePoint3D): MeasureSegment {
    return { id, kind, a, b, distance: measureDistance(a, b), midpoint: measureMidpoint(a, b) };
}

let measureCounter = 0;

export function nextMeasureId(): string {
    measureCounter += 1;
    return `measure-${measureCounter}`;
}

/**
 * Angle at vertex `b` between legs BA and BC, in degrees (0..180).
 *
 * Returns NaN for a degenerate (zero-length) leg so callers never commit a
 * bogus angle.
 */
export function measureAngle(a: MeasurePoint3D, b: MeasurePoint3D, c: MeasurePoint3D): number {
    const ux = a[0] - b[0];
    const uy = a[1] - b[1];
    const uz = a[2] - b[2];
    const vx = c[0] - b[0];
    const vy = c[1] - b[1];
    const vz = c[2] - b[2];
    const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz);
    const vLen = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (uLen < 1e-12 || vLen < 1e-12) {
        return NaN;
    }
    const cosine = Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / (uLen * vLen)));
    return (Math.acos(cosine) * 180) / Math.PI;
}

export function createMeasureAngle(id: string, kind: MeasureKind, a: MeasurePoint3D, b: MeasurePoint3D, c: MeasurePoint3D): MeasureAngle {
    return { id, kind, a, b, c, angle: measureAngle(a, b, c) };
}

export function createMeasureRadius(id: string, center: MeasurePoint3D, radius: number): MeasureRadius {
    return { id, kind: 'model3d', center, radius, diameter: radius * 2 };
}

/**
 * Format an angle in degrees for labels and popover rows: trimmed like the
 * distance formatter, with a degree suffix (`90°`, `45.5°`).
 */
export function formatMeasureAngle(degrees: number): string {
    if (!Number.isFinite(degrees)) {
        return '—';
    }
    return `${degrees.toFixed(1).replace(/\.?0+$/, '')}°`;
}

/** Compact radius/diameter label: `R 5 · ⌀ 10`. */
export function formatMeasureRadius(radius: number): string {
    if (!Number.isFinite(radius)) {
        return '—';
    }
    return `R ${formatMeasureDistance(radius)} · ⌀ ${formatMeasureDistance(radius * 2)}`;
}

/** Short popover-row value for any committed measurement. */
export function formatMeasurementValue(measurement: Measurement): string {
    if (isMeasureSegment(measurement)) {
        return formatMeasureDistance(measurement.distance);
    }
    if (isMeasureAngle(measurement)) {
        return formatMeasureAngle(measurement.angle);
    }
    return formatMeasureRadius(measurement.radius);
}

/**
 * Format a distance for labels and popover rows.
 *
 * Model units only — no millimeter suffix — trimmed like the sketcher's
 * dimension labels so `5.00` reads as `5` and `2.5` stays `2.5`.
 */
export function formatMeasureDistance(value: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return value.toFixed(2).replace(/\.?0+$/, '');
}

/** A world point projected into container-relative screen pixels. */
export interface MeasureScreenPoint {
    readonly x: number;
    readonly y: number;
    /** False when the point lies behind the camera (w <= 0) and must hide. */
    readonly visible: boolean;
}

/**
 * Project a world point to screen pixels using a column-major view-projection
 * matrix (the layout of THREE.Matrix4.elements). Container-relative, matching
 * how the gizmo and view-label overlays position themselves.
 */
export function projectMeasurePoint(
    point: MeasurePoint3D,
    viewProjection: ArrayLike<number>,
    width: number,
    height: number
): MeasureScreenPoint {
    const x = point[0];
    const y = point[1];
    const z = point[2];
    const clipX = viewProjection[0] * x + viewProjection[4] * y + viewProjection[8] * z + viewProjection[12];
    const clipY = viewProjection[1] * x + viewProjection[5] * y + viewProjection[9] * z + viewProjection[13];
    const clipW = viewProjection[3] * x + viewProjection[7] * y + viewProjection[11] * z + viewProjection[15];
    if (clipW <= 0 || !Number.isFinite(clipW)) {
        return { x: 0, y: 0, visible: false };
    }
    const invW = 1 / clipW;
    const ndcX = clipX * invW;
    const ndcY = clipY * invW;
    return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height, visible: true };
}

/** Popover note: measurements are session state, never stored in the document. */
export const MEASURE_CLEAR_NOTE = 'Measurements are cleared after rebuild';
