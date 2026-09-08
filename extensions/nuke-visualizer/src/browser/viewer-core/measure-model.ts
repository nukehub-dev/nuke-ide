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
 * Distance-measure state for the native 3D viewers.
 *
 * Two-click point-pair measurement rendered as viewport annotations only:
 * the host widget raycasts surface points, draws a line plus endpoint
 * spheres in the scene, and projects an imperative HTML label per frame.
 * Measurements are viewport state (never document state) and are cleared on
 * rebuild — the same contract as nuke-cad's measure tool.
 *
 * Vocabulary choice: the point/distance/projection helpers below are copied
 * from `nuke-cad/src/browser/viewer-core/measure-tool.ts` (not imported —
 * cross-extension `src/` imports are banned by `extensions/AGENTS.md`) and
 * trimmed to the distance-only subset. Angle/radius are explicitly OUT
 * (CAD-only for now), so the angle/radius/commit-list machinery was left
 * behind. Formatting (`formatMeasureDistance`: model units, no suffix,
 * trimmed) and the column-major view-projection signature of
 * `projectMeasurePoint` match the CAD originals so the two viewers agree.
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 * Widgets drive `widgets/viewer-measure.tsx` imperatively:
 *
 * ```ts
 * this.measure = addMeasurePoint(this.measure, [hit.x, hit.y, hit.z]);
 * ```
 */

/** A world-space point (x, y, z) in model units. */
export type MeasurePoint3D = readonly [number, number, number];

/** One committed two-point distance measurement in model units. */
export interface MeasureSegment {
    readonly a: MeasurePoint3D;
    readonly b: MeasurePoint3D;
    /** Euclidean distance between a and b in model units. */
    readonly distance: number;
    readonly midpoint: MeasurePoint3D;
}

/**
 * Viewport-only measure session for one viewer: at most one pending point
 * and one committed segment. No ids, no history — a third click starts the
 * next pair (the committed segment is replaced).
 */
export interface MeasureState {
    /** True while the tool captures clicks (orbit gestures still work). */
    readonly active: boolean;
    /** First picked point waiting for its partner, if any. */
    readonly pending: MeasurePoint3D | undefined;
    /** Committed point pair, if any. */
    readonly segment: MeasureSegment | undefined;
}

/** Empty (inactive, nothing picked) measure session. */
export const EMPTY_MEASURE_STATE: MeasureState = { active: false, pending: undefined, segment: undefined };

/** Flip the capture tool; turning it off drops the pending point but keeps a committed segment on screen. */
export function setMeasureActive(state: MeasureState, active: boolean): MeasureState {
    return { active, pending: active ? state.pending : undefined, segment: state.segment };
}

/**
 * Record a raycast surface point: without a pending point it becomes
 * pending; with one the pair commits (replacing any previous segment).
 * No-op while the tool is inactive.
 */
export function addMeasurePoint(state: MeasureState, point: MeasurePoint3D): MeasureState {
    if (!state.active) {
        return state;
    }
    if (!state.pending) {
        return { ...state, pending: point, segment: undefined };
    }
    return { ...state, pending: undefined, segment: createMeasureSegment(state.pending, point) };
}

/** Drop the pending point and the committed segment, keeping the tool flag. */
export function clearMeasurePoints(state: MeasureState): MeasureState {
    return { ...state, pending: undefined, segment: undefined };
}

/** Full reset back to {@link EMPTY_MEASURE_STATE} (dataset rebuild). */
export function resetMeasureState(): MeasureState {
    return { ...EMPTY_MEASURE_STATE };
}

/**
 * Escape handling, newest-first: a pending point cancels, else a committed
 * segment clears, else an active tool deactivates. Returns the unchanged
 * state when there is nothing to cancel (so callers can skip re-rendering).
 */
export function cancelMeasureStep(state: MeasureState): MeasureState {
    if (state.pending) {
        return { ...state, pending: undefined };
    }
    if (state.segment) {
        return { ...state, segment: undefined };
    }
    if (state.active) {
        return { ...state, active: false };
    }
    return state;
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

export function createMeasureSegment(a: MeasurePoint3D, b: MeasurePoint3D): MeasureSegment {
    return { a, b, distance: measureDistance(a, b), midpoint: measureMidpoint(a, b) };
}

/**
 * Format a distance for labels.
 *
 * Model units only — no millimeter suffix — trimmed so `5.00` reads as `5`
 * and `2.5` stays `2.5`.
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
 * how the gizmo overlay positions itself.
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
