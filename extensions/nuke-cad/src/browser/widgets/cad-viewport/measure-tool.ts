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

/** Visual state pushed from the React chrome down to the imperative overlay. */
export interface MeasureViewState {
    /** True while the tool captures clicks (selection/picking is suppressed). */
    readonly active: boolean;
    /** Which surface new clicks come from; only this kind's visuals render. */
    readonly mode: MeasureKind;
    readonly segments: readonly MeasureSegment[];
    /** First picked point waiting for its partner, if any. */
    readonly pending?: MeasurePoint3D;
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
