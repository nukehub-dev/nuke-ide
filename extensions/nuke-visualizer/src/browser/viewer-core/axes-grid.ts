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
 * Pure axes-grid geometry for the native 3D viewer core (R3).
 *
 * {@link buildAxesGrid} turns a dataset bounds box into drawable line
 * segments plus world-space tick/title labels. Lines are xyz pairs
 * (`x1,y1,z1,x2,y2,z2,...`) and feed a `THREE.LineSegments` position
 * attribute directly; labels are 3D anchors that the host projects each
 * frame with {@link projectAxisLabels} and renders through the props-only
 * `AxesGridOverlay` HTML component. No three.js, DOM, or Theia imports.
 *
 * Grid convention (matching ParaView's axes grid):
 *
 * - the bounds-box edges are always drawn (coincident/zero-length edges of a
 *   collapsed axis are deduped/omitted);
 * - grid lines lie on the three LOW faces (`x = min`, `y = min`, `z = min`)
 *   and use the interior ticks of each axis (ticks already on a box edge
 *   are skipped to avoid duplicate segments);
 * - tick labels sit on the three low edges meeting at the `min` corner:
 *   X at `(x, minY, minZ)`, Y at `(minX, y, minZ)`, Z at `(minX, minY, z)`;
 * - axis titles sit mid-edge on the three HIGH edges meeting at the `max`
 *   corner, so titles never collide with the endpoint tick labels.
 *
 * Ticks are linear nice numbers (1/2/2.5/5/10 mantissas) chosen per axis
 * from the desired tick count. {@link AxisGridOptions.customLabels}
 * overrides label text index-for-index without moving tick positions.
 *
 * Robustness is part of the contract: missing/invalid options, non-finite
 * bounds, and zero-size axes never throw. Non-finite bounds return an empty
 * model; a zero-size axis keeps the collapsed box and one tick while
 * degenerate (zero-length) segments are omitted.
 */

/** One world-space vector as an xyz tuple (same convention as `clip-plane.ts`). */
export type AxisGridVector = readonly [number, number, number];

/** Axis identity for ticks, labels, and titles. */
export type AxisGridAxis = 'X' | 'Y' | 'Z';

/** The three axes in tick-label order. */
export const AXIS_GRID_AXES: readonly AxisGridAxis[] = ['X', 'Y', 'Z'];

/** Label text formatting family. `plain` trims trailing zeros. */
export type AxisGridNotation = 'plain' | 'scientific' | 'engineering';

/** Tick labels annotate values; title labels name the axis. */
export type AxisGridLabelKind = 'tick' | 'title';

/** Axis-aligned bounds box, structurally compatible with `AxisAlignedBounds` from `clip-plane.ts`. */
export interface AxisGridBounds {
    readonly min: AxisGridVector;
    readonly max: AxisGridVector;
}

/** One tick: its axis, model-space value, and formatted text. */
export interface AxisGridTick {
    readonly axis: AxisGridAxis;
    readonly value: number;
    readonly text: string;
}

/** One world-anchored label (tick value or axis title). */
export interface AxisGridLabel {
    readonly axis: AxisGridAxis;
    readonly text: string;
    readonly position: AxisGridVector;
    readonly kind: AxisGridLabelKind;
}

/**
 * Built axes grid.
 *
 * `lines` holds xyz pairs for line segments; `labels` is the draw order for
 * the HTML overlay; `ticks` exposes the raw tick values for rulers/tests.
 */
export interface AxisGridModel {
    readonly lines: Float32Array;
    readonly labels: readonly AxisGridLabel[];
    readonly ticks: readonly AxisGridTick[];
}

/** Inputs for {@link buildAxesGrid}; every field is optional and sanitized. */
export interface AxisGridOptions {
    /** Dataset bounds in world units; non-finite or malformed bounds yield an empty model. */
    readonly bounds?: AxisGridBounds;
    /** Desired tick count (2..20) shared by all axes, or per-axis overrides. */
    readonly ticks?: number | Partial<Record<AxisGridAxis, number>>;
    /** Axis titles; defaults to the axis letter, an empty string suppresses the title label. */
    readonly titles?: Partial<Record<AxisGridAxis, string>>;
    /** Tick text formatting; invalid values fall back to `plain`. */
    readonly notation?: AxisGridNotation;
    /** Decimal digits (0..12); invalid values fall back to 3. */
    readonly precision?: number;
    /**
     * Custom label text per axis, indexed against the generated ticks.
     * Strings are trimmed and empty/undefined entries fall back to the
     * formatted numeric value; finite numbers are formatted normally.
     */
    readonly customLabels?: Partial<Record<AxisGridAxis, readonly (string | number | null | undefined)[]>>;
}

/** Default number of nice ticks requested per axis. */
export const DEFAULT_AXES_GRID_TICKS = 5;

/** Smallest accepted tick count (two ticks always bound the axis). */
export const MIN_AXES_GRID_TICKS = 2;

/** Largest accepted tick count (keeps labels readable and loops bounded). */
export const MAX_AXES_GRID_TICKS = 20;

/** Default decimal digits for plain/scientific/engineering tick text. */
export const DEFAULT_AXES_GRID_PRECISION = 3;

/** Largest accepted decimal precision. */
export const MAX_AXES_GRID_PRECISION = 12;

/** Default minimum CSS-pixel separation between two kept projected labels. */
export const DEFAULT_AXIS_LABEL_MIN_DISTANCE = 18;

const AXIS_INDEX: Record<AxisGridAxis, number> = { X: 0, Y: 1, Z: 2 };

const DEFAULT_CAMERA_FOV = 45;
const DEFAULT_CAMERA_NEAR = 0.01;

/** A projected screen point from a caller-supplied projector (CSS pixels). */
export interface AxisGridScreenPoint {
    /** Container-relative x in CSS pixels. */
    readonly x: number;
    /** Container-relative y in CSS pixels. */
    readonly y: number;
    /** View-space distance in front of the camera; used to sort labels (default 0). */
    readonly depth?: number;
    /** False hides the label; omitted means visible. */
    readonly visible?: boolean;
}

/** Pure projection callback alternative to a camera object. */
export type AxisGridProjector = (position: AxisGridVector) => AxisGridScreenPoint | undefined;

/**
 * Minimal camera contract for {@link projectAxisLabels}.
 *
 * `viewMatrix` and `projectionMatrix` are optional column-major 16-element
 * matrices (the `THREE.Matrix4.elements` layout). When `viewMatrix` is
 * omitted the view is built from `position` + `quaternion` (xyzw, camera
 * local to world); a missing/invalid quaternion resolves to identity, i.e.
 * the camera looks down world -Z. When `projectionMatrix` is omitted a
 * perspective projection is built from `fov` (degrees), `aspect`, `near`,
 * and `far`. Points at or behind the camera plane are always hidden.
 */
export interface AxisGridCamera {
    /** Camera position in world units. */
    readonly position: AxisGridVector;
    /** World-to-camera matrix (column-major); takes precedence over `quaternion`. */
    readonly viewMatrix?: ArrayLike<number>;
    /** Camera orientation (xyzw quaternion); ignored when `viewMatrix` is given. */
    readonly quaternion?: readonly [number, number, number, number];
    /** Camera-to-clip matrix (column-major); omitted builds a perspective matrix. */
    readonly projectionMatrix?: ArrayLike<number>;
    /** Vertical field of view in degrees for the fallback perspective matrix (default 45). */
    readonly fov?: number;
    /** Aspect ratio for the fallback perspective matrix (default `width / height`). */
    readonly aspect?: number;
    /** Near plane for the fallback perspective matrix (default 0.01). */
    readonly near?: number;
    /** Far plane for the fallback perspective matrix (default infinity). */
    readonly far?: number;
}

/** Overlay viewport in CSS pixels. */
export interface AxisGridViewport {
    readonly width: number;
    readonly height: number;
}

/** Overlap-resolution options for {@link projectAxisLabels}. */
export interface AxisGridProjectionOptions {
    /** Minimum CSS-pixel separation; labels closer than this to a kept label are dropped (default 18). */
    readonly minDistance?: number;
}

/** One kept label after projection and overlap resolution. */
export interface ProjectedAxisLabel {
    readonly axis: AxisGridAxis;
    readonly text: string;
    readonly kind: AxisGridLabelKind;
    /** Original world-space anchor. */
    readonly position: AxisGridVector;
    /** Container-relative x in CSS pixels. */
    readonly x: number;
    /** Container-relative y in CSS pixels. */
    readonly y: number;
    /** View-space distance in front of the camera (larger is farther). */
    readonly depth: number;
}

/** Empty model returned for unusable bounds/options. */
export function emptyAxesGridModel(): AxisGridModel {
    return { lines: new Float32Array(0), labels: [], ticks: [] };
}

/** Normalize negative zero so `-0` never leaks into labels or geometry. */
function normalizeZero(value: number): number {
    return value === 0 ? 0 : value;
}

/** True for a finite xyz tuple. */
function isFiniteVector(value: unknown): value is AxisGridVector {
    return (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every((component: unknown) => typeof component === 'number' && Number.isFinite(component))
    );
}

/** True for a finite column-major 4x4 matrix (arrays and typed arrays). */
function isMatrix16(value: unknown): value is ArrayLike<number> {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
        return false;
    }
    const matrix = value as ArrayLike<number>;
    if (typeof matrix.length !== 'number' || matrix.length < 16) {
        return false;
    }
    for (let i = 0; i < 16; i++) {
        if (!Number.isFinite(matrix[i])) {
            return false;
        }
    }
    return true;
}

/** Clamp a requested tick count to the supported range; non-finite input uses the default. */
export function sanitizeAxisGridTickCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_AXES_GRID_TICKS;
    }
    return Math.max(MIN_AXES_GRID_TICKS, Math.min(MAX_AXES_GRID_TICKS, Math.round(value)));
}

/** Clamp decimal precision to 0..12; non-finite input uses the default. */
function sanitizePrecision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_AXES_GRID_PRECISION;
    }
    return Math.max(0, Math.min(MAX_AXES_GRID_PRECISION, Math.floor(value)));
}

/** Notation guard that falls back to plain text. */
function sanitizeNotation(value: unknown): AxisGridNotation {
    return value === 'scientific' || value === 'engineering' ? value : 'plain';
}

/** Normalize bounds to ascending finite endpoints; undefined when unusable. */
function sanitizeBounds(value: unknown): AxisGridBounds | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = value as { min?: unknown; max?: unknown };
    const minSource = candidate.min;
    const maxSource = candidate.max;
    if (!isFiniteVector(minSource) || !isFiniteVector(maxSource)) {
        return undefined;
    }
    const min: [number, number, number] = [0, 0, 0];
    const max: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const a = minSource[i];
        const b = maxSource[i];
        min[i] = normalizeZero(Math.min(a, b));
        max[i] = normalizeZero(Math.max(a, b));
    }
    return { min, max };
}

/** Per-axis tick count from a number or a per-axis record. */
function tickCountFor(ticks: unknown, axis: AxisGridAxis): number {
    if (typeof ticks === 'number') {
        return sanitizeAxisGridTickCount(ticks);
    }
    if (ticks && typeof ticks === 'object') {
        return sanitizeAxisGridTickCount((ticks as Record<string, unknown>)[axis]);
    }
    return DEFAULT_AXES_GRID_TICKS;
}

/** Trim a plain formatted number (`2.500` -> `2.5`, `3.000` -> `3`, `-0` -> `0`). */
function trimPlainText(text: string): string {
    if (!text.includes('.')) {
        return text === '-0' ? '0' : text;
    }
    const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
    return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/** Engineering notation with a multiple-of-three exponent. */
function formatEngineering(value: number, digits: number): string {
    if (value === 0) {
        return '0';
    }
    let exponent = Math.floor(Math.log10(Math.abs(value)));
    let engineeringExponent = Math.floor(exponent / 3) * 3;
    let mantissa = value / 10 ** engineeringExponent;
    // Rounding can push the mantissa to 1000; renormalize before printing.
    if (Math.abs(Number(mantissa.toFixed(digits))) >= 1000) {
        engineeringExponent += 3;
        mantissa = value / 10 ** engineeringExponent;
    }
    return `${mantissa.toFixed(digits)}e${engineeringExponent >= 0 ? '+' : ''}${engineeringExponent}`;
}

/**
 * Format one tick value.
 *
 * `plain` uses fixed precision then trims trailing zeros; `scientific` uses
 * JS exponential notation; `engineering` uses a multiple-of-three exponent.
 * Zero always prints `0`, and non-finite values print an em dash.
 */
export function formatAxisTick(
    value: number,
    notation: AxisGridNotation = 'plain',
    precision: number = DEFAULT_AXES_GRID_PRECISION
): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const digits = sanitizePrecision(precision);
    const normalized = normalizeZero(value);
    if (normalized === 0) {
        return '0';
    }
    if (notation === 'scientific') {
        return normalized.toExponential(digits);
    }
    if (notation === 'engineering') {
        return formatEngineering(normalized, digits);
    }
    return trimPlainText(normalized.toFixed(digits));
}

/** Round a computed tick to 12 significant digits (kills `0.30000000000000004`). */
function roundTick(value: number): number {
    return normalizeZero(Number(value.toPrecision(12)));
}

/** Nice step size (1/2/2.5/5/10 mantissa) for a range and target tick count. */
function niceStep(range: number, targetCount: number): number {
    const raw = range / Math.max(1, targetCount - 1);
    if (!Number.isFinite(raw) || raw <= 0) {
        return Number.NaN;
    }
    const exponent = Math.floor(Math.log10(raw));
    const magnitude = 10 ** exponent;
    const fraction = raw / magnitude;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * magnitude;
}

/**
 * Linear nice-number ticks inside `[min, max]` (endpoints included only when
 * they land on a nice step). Zero-size input returns the single value;
 * non-finite input returns an empty array. `maxTicks` is clamped to 2..20.
 */
export function niceAxisTicks(min: number, max: number, maxTicks: number = DEFAULT_AXES_GRID_TICKS): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return [];
    }
    const lo = normalizeZero(Math.min(min, max));
    const hi = normalizeZero(Math.max(min, max));
    if (lo === hi) {
        return [lo];
    }
    const step = niceStep(hi - lo, sanitizeAxisGridTickCount(maxTicks));
    if (!Number.isFinite(step) || step <= 0) {
        return [];
    }
    const firstIndex = Math.ceil(lo / step - 1e-9);
    const lastIndex = Math.floor(hi / step + 1e-9);
    const values: number[] = [];
    for (let index = firstIndex; index <= lastIndex && values.length < 1000; index++) {
        const value = roundTick(index * step);
        if (value < lo - step * 1e-9 || value > hi + step * 1e-9) {
            continue;
        }
        values.push(value);
    }
    return values;
}

/** Canonical segment key: endpoint order is normalized so reversed duplicates match. */
function segmentKey(segments: number[], offset: number): string {
    let ax = segments[offset];
    let ay = segments[offset + 1];
    let az = segments[offset + 2];
    let bx = segments[offset + 3];
    let by = segments[offset + 4];
    let bz = segments[offset + 5];
    if (bx < ax || (bx === ax && (by < ay || (by === ay && bz < az)))) {
        const tx = ax;
        const ty = ay;
        const tz = az;
        ax = bx;
        ay = by;
        az = bz;
        bx = tx;
        by = ty;
        bz = tz;
    }
    return `${ax},${ay},${az}|${bx},${by},${bz}`;
}

/** Drop coincident segments (collapsed boxes duplicate edges at both ends of the zero-size axis). */
function dedupeSegments(segments: number[]): number[] {
    const seen = new Set<string>();
    const out: number[] = [];
    for (let offset = 0; offset + 5 < segments.length; offset += 6) {
        const key = segmentKey(segments, offset);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        for (let i = 0; i < 6; i++) {
            out.push(segments[offset + i]);
        }
    }
    return out;
}

/** Push one xyz segment, dropping exact zero-length lines (collapsed axes). */
function pushSegment(out: number[], a: AxisGridVector, b: AxisGridVector): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    if (dx === 0 && dy === 0 && dz === 0) {
        return;
    }
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** Append the 12 bounds-box edges (corner indices use bits x=1, y=2, z=4). */
function addBoxEdges(out: number[], min: AxisGridVector, max: AxisGridVector): void {
    const corner = (bits: number): AxisGridVector => [
        (bits & 1) === 0 ? min[0] : max[0],
        (bits & 2) === 0 ? min[1] : max[1],
        (bits & 4) === 0 ? min[2] : max[2]
    ];
    for (let bits = 0; bits < 8; bits++) {
        for (const bit of [1, 2, 4]) {
            if ((bits & bit) === 0) {
                pushSegment(out, corner(bits), corner(bits | bit));
            }
        }
    }
}

/** Tick label anchor on the low edges meeting at the min corner. */
function tickLabelPosition(axis: AxisGridAxis, value: number, min: AxisGridVector): AxisGridVector {
    switch (axis) {
        case 'X':
            return [value, min[1], min[2]];
        case 'Y':
            return [min[0], value, min[2]];
        default:
            return [min[0], min[1], value];
    }
}

/** Title anchor mid-edge on the high edges meeting at the max corner. */
function titleLabelPosition(axis: AxisGridAxis, min: AxisGridVector, max: AxisGridVector): AxisGridVector {
    switch (axis) {
        case 'X':
            return [(min[0] + max[0]) / 2, max[1], max[2]];
        case 'Y':
            return [max[0], (min[1] + max[1]) / 2, max[2]];
        default:
            return [max[0], max[1], (min[2] + max[2]) / 2];
    }
}

/**
 * Append the grid lines for one axis on the two low faces that contain it.
 * Edge-coincident ticks are skipped (the box edge is already drawn).
 */
function addAxisGridLines(out: number[], axis: AxisGridAxis, ticks: readonly number[], min: AxisGridVector, max: AxisGridVector): void {
    const index = AXIS_INDEX[axis];
    const size = max[index] - min[index];
    if (!(size > 0)) {
        return;
    }
    const epsilon = size * 1e-9;
    for (const tick of ticks) {
        if (!Number.isFinite(tick) || tick <= min[index] + epsilon || tick >= max[index] - epsilon) {
            continue;
        }
        if (axis === 'X') {
            pushSegment(out, [tick, min[1], min[2]], [tick, max[1], min[2]]);
            pushSegment(out, [tick, min[1], min[2]], [tick, min[1], max[2]]);
        } else if (axis === 'Y') {
            pushSegment(out, [min[0], tick, min[2]], [max[0], tick, min[2]]);
            pushSegment(out, [min[0], tick, min[2]], [min[0], tick, max[2]]);
        } else {
            pushSegment(out, [min[0], min[1], tick], [max[0], min[1], tick]);
            pushSegment(out, [min[0], min[1], tick], [min[0], max[1], tick]);
        }
    }
}

/** Custom label array for one axis, when well-formed. */
function customLabelArray(customLabels: unknown, axis: AxisGridAxis): readonly unknown[] | undefined {
    if (!customLabels || typeof customLabels !== 'object') {
        return undefined;
    }
    const value = (customLabels as Record<string, unknown>)[axis];
    return Array.isArray(value) ? value : undefined;
}

/** Custom text for one tick index, falling back to the formatted tick value. */
function customLabelText(
    entries: readonly unknown[] | undefined,
    index: number,
    value: number,
    notation: AxisGridNotation,
    precision: number
): string {
    const entry = entries && index < entries.length ? entries[index] : undefined;
    if (typeof entry === 'string') {
        const text = entry.trim();
        if (text.length > 0) {
            return text;
        }
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
        return formatAxisTick(entry, notation, precision);
    }
    return formatAxisTick(value, notation, precision);
}

/** Axis title text; an explicit empty string suppresses the title label. */
function axisTitle(titles: unknown, axis: AxisGridAxis): string {
    if (titles && typeof titles === 'object') {
        const value = (titles as Record<string, unknown>)[axis];
        if (typeof value === 'string') {
            return value.trim();
        }
    }
    return axis;
}

/**
 * Build the axes-grid model for a bounds box.
 *
 * Returns an empty model (no lines, labels, or ticks) when `bounds` is
 * missing/malformed/non-finite. Never throws for invalid options: tick
 * counts, precision, notation, titles, and custom labels all sanitize to
 * defaults. A zero-size axis produces one tick/label and omits its
 * zero-length segments instead of degenerate geometry.
 */
export function buildAxesGrid(options?: AxisGridOptions): AxisGridModel {
    const source = options && typeof options === 'object' ? options : {};
    const bounds = sanitizeBounds(source.bounds);
    if (!bounds) {
        return emptyAxesGridModel();
    }
    const { min, max } = bounds;
    const notation = sanitizeNotation(source.notation);
    const precision = sanitizePrecision(source.precision);

    const lines: number[] = [];
    addBoxEdges(lines, min, max);

    const labels: AxisGridLabel[] = [];
    const ticks: AxisGridTick[] = [];
    const ticksByAxis: Record<AxisGridAxis, number[]> = { X: [], Y: [], Z: [] };

    for (const axis of AXIS_GRID_AXES) {
        const index = AXIS_INDEX[axis];
        const values = niceAxisTicks(min[index], max[index], tickCountFor(source.ticks, axis));
        ticksByAxis[axis] = values;
        const custom = customLabelArray(source.customLabels, axis);
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const text = customLabelText(custom, i, value, notation, precision);
            ticks.push({ axis, value, text });
            labels.push({ axis, text, position: tickLabelPosition(axis, value, min), kind: 'tick' });
        }
    }

    for (const axis of AXIS_GRID_AXES) {
        addAxisGridLines(lines, axis, ticksByAxis[axis], min, max);
    }

    for (const axis of AXIS_GRID_AXES) {
        const title = axisTitle(source.titles, axis);
        if (title.length > 0) {
            labels.push({ axis, text: title, position: titleLabelPosition(axis, min, max), kind: 'title' });
        }
    }

    return { lines: Float32Array.from(dedupeSegments(lines)), labels, ticks };
}

/** Rotate `v` by unit quaternion `q` (plain math, no three.js). */
function rotateVectorByQuaternion(v: AxisGridVector, q: readonly [number, number, number, number]): [number, number, number] {
    const [x, y, z] = v;
    const [qx, qy, qz, qw] = q;
    const cx = qy * z - qz * y + qw * x;
    const cy = qz * x - qx * z + qw * y;
    const cz = qx * y - qy * x + qw * z;
    return [x + 2 * (qy * cz - qz * cy), y + 2 * (qz * cx - qx * cz), z + 2 * (qx * cy - qy * cx)];
}

/** Unit quaternion or identity when malformed/degenerate. */
function normalizeQuaternionOrIdentity(value: unknown): [number, number, number, number] {
    if (
        Array.isArray(value) &&
        value.length >= 4 &&
        value.every((component: unknown) => typeof component === 'number' && Number.isFinite(component))
    ) {
        const q = value as [number, number, number, number];
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        if (length > 1e-12) {
            return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
        }
    }
    return [0, 0, 0, 1];
}

/** Conjugate (inverse rotation for a unit quaternion). */
function conjugateQuaternion(q: readonly [number, number, number, number]): [number, number, number, number] {
    return [-q[0], -q[1], -q[2], q[3]];
}

/** Camera-space point from world space; undefined when the camera is unusable. */
function toViewSpace(
    point: AxisGridVector,
    viewMatrix: ArrayLike<number> | undefined,
    position: AxisGridVector | undefined,
    inverseRotation: readonly [number, number, number, number] | undefined
): [number, number, number] | undefined {
    if (viewMatrix) {
        return [
            viewMatrix[0] * point[0] + viewMatrix[4] * point[1] + viewMatrix[8] * point[2] + viewMatrix[12],
            viewMatrix[1] * point[0] + viewMatrix[5] * point[1] + viewMatrix[9] * point[2] + viewMatrix[13],
            viewMatrix[2] * point[0] + viewMatrix[6] * point[1] + viewMatrix[10] * point[2] + viewMatrix[14]
        ];
    }
    if (!position || !inverseRotation) {
        return undefined;
    }
    return rotateVectorByQuaternion([point[0] - position[0], point[1] - position[1], point[2] - position[2]], inverseRotation);
}

/** Build a projector from the minimal camera contract; undefined when malformed. */
function createCameraProjector(camera: AxisGridCamera, width: number, height: number): AxisGridProjector | undefined {
    if (!camera || typeof camera !== 'object') {
        return undefined;
    }
    const viewMatrix = isMatrix16(camera.viewMatrix) ? camera.viewMatrix : undefined;
    const position = isFiniteVector(camera.position) ? camera.position : undefined;
    if (!viewMatrix && !position) {
        return undefined;
    }
    const projectionMatrix = isMatrix16(camera.projectionMatrix) ? camera.projectionMatrix : undefined;
    const inverseRotation = viewMatrix ? undefined : conjugateQuaternion(normalizeQuaternionOrIdentity(camera.quaternion));
    const fov =
        typeof camera.fov === 'number' && Number.isFinite(camera.fov) && camera.fov > 0 && camera.fov < 180
            ? camera.fov
            : DEFAULT_CAMERA_FOV;
    const aspect =
        typeof camera.aspect === 'number' && Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : width / height;
    const near = typeof camera.near === 'number' && Number.isFinite(camera.near) && camera.near > 0 ? camera.near : DEFAULT_CAMERA_NEAR;
    const far = typeof camera.far === 'number' && Number.isFinite(camera.far) && camera.far > near ? camera.far : Number.POSITIVE_INFINITY;
    const focal = 1 / Math.tan((fov * Math.PI) / 360);

    return (point: AxisGridVector): AxisGridScreenPoint | undefined => {
        const view = toViewSpace(point, viewMatrix, position, inverseRotation);
        if (!view) {
            return undefined;
        }
        const [viewX, viewY, viewZ] = view;
        // Camera space looks down -Z: anything at/behind the camera plane is hidden.
        if (!(viewZ < 0) || !Number.isFinite(viewZ)) {
            return undefined;
        }
        const depth = -viewZ;
        if (projectionMatrix) {
            const clipX = projectionMatrix[0] * viewX + projectionMatrix[4] * viewY + projectionMatrix[8] * viewZ + projectionMatrix[12];
            const clipY = projectionMatrix[1] * viewX + projectionMatrix[5] * viewY + projectionMatrix[9] * viewZ + projectionMatrix[13];
            const clipZ = projectionMatrix[2] * viewX + projectionMatrix[6] * viewY + projectionMatrix[10] * viewZ + projectionMatrix[14];
            const clipW = projectionMatrix[3] * viewX + projectionMatrix[7] * viewY + projectionMatrix[11] * viewZ + projectionMatrix[15];
            if (!(clipW > 0) || !Number.isFinite(clipW)) {
                return undefined;
            }
            const ndcX = clipX / clipW;
            const ndcY = clipY / clipW;
            const ndcZ = clipZ / clipW;
            if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY) || !Number.isFinite(ndcZ) || ndcZ < -1 || ndcZ > 1) {
                return undefined;
            }
            return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height, depth, visible: true };
        }
        if (depth < near || depth > far) {
            return undefined;
        }
        const ndcX = (focal / aspect) * (viewX / depth);
        const ndcY = focal * (viewY / depth);
        if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) {
            return undefined;
        }
        return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height, depth, visible: true };
    };
}

/**
 * Project a model's world-space labels into container-relative CSS pixels.
 *
 * `camera` is either the minimal {@link AxisGridCamera} contract or a
 * {@link AxisGridProjector} callback. Labels at/behind the camera, outside
 * the near/far range, or with non-finite coordinates are dropped. Remaining
 * labels are sorted nearest-first by view depth, then greedily de-overlapped:
 * a label within `minDistance` CSS pixels of an already-kept label is skipped,
 * so the closest annotation wins. Malformed models/cameras/viewports return
 * an empty array instead of throwing.
 */
export function projectAxisLabels(
    model: Pick<AxisGridModel, 'labels'>,
    camera: AxisGridCamera | AxisGridProjector,
    viewport: AxisGridViewport,
    options: AxisGridProjectionOptions = {}
): ProjectedAxisLabel[] {
    if (!model || !Array.isArray(model.labels) || model.labels.length === 0 || !viewport) {
        return [];
    }
    const width = viewport.width;
    const height = viewport.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return [];
    }
    const projector = typeof camera === 'function' ? camera : createCameraProjector(camera, width, height);
    if (!projector) {
        return [];
    }
    const requestedDistance = options && typeof options.minDistance === 'number' ? options.minDistance : Number.NaN;
    const minDistance = Number.isFinite(requestedDistance) && requestedDistance >= 0 ? requestedDistance : DEFAULT_AXIS_LABEL_MIN_DISTANCE;

    const candidates: ProjectedAxisLabel[] = [];
    for (const label of model.labels) {
        if (!label || !isFiniteVector(label.position) || typeof label.text !== 'string') {
            continue;
        }
        const axis: AxisGridAxis = label.axis === 'X' || label.axis === 'Y' || label.axis === 'Z' ? label.axis : 'X';
        const kind: AxisGridLabelKind = label.kind === 'title' ? 'title' : 'tick';
        const projected = projector(label.position);
        if (!projected || projected.visible === false) {
            continue;
        }
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
            continue;
        }
        candidates.push({
            axis,
            text: label.text,
            kind,
            position: label.position,
            x: projected.x,
            y: projected.y,
            depth: typeof projected.depth === 'number' && Number.isFinite(projected.depth) ? projected.depth : 0
        });
    }

    candidates.sort((a, b) => a.depth - b.depth);
    const kept: ProjectedAxisLabel[] = [];
    const minDistanceSquared = minDistance * minDistance;
    for (const candidate of candidates) {
        let blocked = false;
        for (const placed of kept) {
            const dx = placed.x - candidate.x;
            const dy = placed.y - candidate.y;
            if (dx * dx + dy * dy < minDistanceSquared) {
                blocked = true;
                break;
            }
        }
        if (!blocked) {
            kept.push(candidate);
        }
    }
    return kept;
}
