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

import { boundingBoxDiagonal } from './warp-vectors';

/**
 * Direction-glyph layout math for the native 3D viewer core: decimated
 * cone instancing oriented along per-point vectors (tracks polylines carry
 * no explicit direction array — the HDF5 `u` never reaches the converter —
 * so track directions are polyline tangents derived client-side; collision
 * sites and future vector fields resolve an explicit 3-component point
 * array), ParaView `Glyph` parity computed client-side with no backend work.
 *
 * Glyphs compose with the neighboring filters by construction: placements
 * are point indices + orientations only, so the widget looks positions up
 * in the *warped* scene positions (glyphs follow deformation) and drops
 * placements whose tuple the active threshold window hides (glyphs on
 * hidden points/cells are skipped, same tuple rule as the soup collapse).
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports. The
 * widget owns the `THREE.InstancedMesh` (unit cone, base at the origin,
 * apex along +Y — the axis {@link quaternionFromUp} rotates from).
 */

/** Density slider bounds: fraction of candidate points carrying a glyph. */
export const GLYPH_DENSITY_SPEC = { min: 0.01, max: 1, step: 0.01 } as const;

/** Default density: one glyph per ten points (decimated, never the full cloud). */
export const DEFAULT_GLYPH_DENSITY = 0.1;

/** Glyph size multiplier bounds (1 = one auto-sized cone). */
export const GLYPH_SCALE_SPEC = { min: 0.1, max: 5, step: 0.1 } as const;

/** Default size multiplier: the auto cone height. */
export const DEFAULT_GLYPH_SCALE = 1;

/** Hard cap on live cone instances (one InstancedMesh draw call regardless). */
export const MAX_GLYPH_INSTANCES = 10000;

/** Auto cone height = model bounding-box diagonal / this divisor. */
export const GLYPH_SIZE_DIVISOR = 40;

/** Clamp a density into the slider range; non-finite input maps to the default. */
export function clampGlyphDensity(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_GLYPH_DENSITY;
    }
    return Math.min(GLYPH_DENSITY_SPEC.max, Math.max(GLYPH_DENSITY_SPEC.min, value));
}

/** Clamp a size multiplier into the slider range; non-finite input maps to the default. */
export function clampGlyphScale(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_GLYPH_SCALE;
    }
    return Math.min(GLYPH_SCALE_SPEC.max, Math.max(GLYPH_SCALE_SPEC.min, value));
}

/**
 * Auto cone height for xyz-packed positions: the model diagonal over
 * {@link GLYPH_SIZE_DIVISOR}, so glyphs read at any model scale. Returns 0
 * when there is no model extent — the degenerate guard, so callers show
 * nothing instead of sizing off garbage.
 */
export function autoGlyphSize(positions: ArrayLike<number>): number {
    const diagonal = boundingBoxDiagonal(positions);
    if (!(diagonal > 0)) {
        return 0;
    }
    return diagonal / GLYPH_SIZE_DIVISOR;
}

/**
 * Evenly decimated point indices for `count` candidate points at `density`:
 * stride `round(1 / density)` widened past the stride so the instance cap
 * holds (density 1 on a huge cloud still caps). Never throws; empty input
 * plans nothing.
 */
export function decimateGlyphIndices(count: number, density: number): number[] {
    const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (safe === 0) {
        return [];
    }
    const clamped = clampGlyphDensity(density);
    let stride = Math.max(1, Math.round(1 / clamped));
    if (Math.ceil(safe / stride) > MAX_GLYPH_INSTANCES) {
        stride = Math.ceil(safe / MAX_GLYPH_INSTANCES);
    }
    const out: number[] = [];
    for (let i = 0; i < safe; i += stride) {
        out.push(i);
    }
    return out;
}

/**
 * Per-point tangents for xyz-packed positions joined by flat index pairs
 * `(a, b)` (the native polydata `segments` form: track polylines arrive as
 * consecutive pairs). Each pair's direction accumulates into both endpoints
 * — shared vertices average their incident segments, endpoints keep their
 * single segment — then every point normalizes. Zero-length segments
 * contribute nothing, out-of-range indices are ignored, and isolated points
 * stay zero (the degenerate skip input: no direction, no glyph).
 */
export function polylineTangents(positions: ArrayLike<number>, segments: ArrayLike<number>): Float32Array {
    const count = Math.floor(positions.length / 3);
    const out = new Float32Array(count * 3);
    const pairCount = Math.floor(segments.length / 2);
    for (let s = 0; s < pairCount; s++) {
        const a = segments[s * 2];
        const b = segments[s * 2 + 1];
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= count || b >= count) {
            continue;
        }
        const dx = positions[b * 3] - positions[a * 3];
        const dy = positions[b * 3 + 1] - positions[a * 3 + 1];
        const dz = positions[b * 3 + 2] - positions[a * 3 + 2];
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
            continue;
        }
        if (dx === 0 && dy === 0 && dz === 0) {
            continue;
        }
        out[a * 3] += dx;
        out[a * 3 + 1] += dy;
        out[a * 3 + 2] += dz;
        out[b * 3] += dx;
        out[b * 3 + 1] += dy;
        out[b * 3 + 2] += dz;
    }
    for (let i = 0; i < count; i++) {
        const x = out[i * 3];
        const y = out[i * 3 + 1];
        const z = out[i * 3 + 2];
        const length = Math.sqrt(x * x + y * y + z * z);
        if (!(length > 0)) {
            out[i * 3] = 0;
            out[i * 3 + 1] = 0;
            out[i * 3 + 2] = 0;
            continue;
        }
        out[i * 3] = x / length;
        out[i * 3 + 1] = y / length;
        out[i * 3 + 2] = z / length;
    }
    return out;
}

/** Unit quaternion (x, y, z, w) rotating the cone apex (+Y) onto a direction. */
export type GlyphQuaternion = readonly [number, number, number, number];

/**
 * Rotation taking +Y (the unit-cone apex axis) onto `(x, y, z)`. Returns
 * undefined for zero/non-finite vectors — the degenerate skip, so callers
 * place no glyph instead of orienting garbage. Antipodal input (−Y) takes
 * the half-turn about X (any perpendicular axis orients identically).
 */
export function quaternionFromUp(x: number, y: number, z: number): GlyphQuaternion | undefined {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        return undefined;
    }
    const length = Math.sqrt(x * x + y * y + z * z);
    if (!(length > 0)) {
        return undefined;
    }
    const dx = x / length;
    const dy = y / length;
    const dz = z / length;
    if (dy > 1 - 1e-9) {
        return [0, 0, 0, 1];
    }
    if (dy < -1 + 1e-9) {
        return [1, 0, 0, 0];
    }
    // Axis = Y × d = (dz, 0, −dx) (already unit: |Y × d| = sin(angle), and
    // the half-angle form below re-normalizes through sin/cos).
    const axisLength = Math.sqrt(dz * dz + dx * dx);
    const ax = dz / axisLength;
    const az = -dx / axisLength;
    const angle = Math.acos(Math.min(1, Math.max(-1, dy)));
    const s = Math.sin(angle / 2);
    return [ax * s, 0, az * s, Math.cos(angle / 2)];
}

/** One cone placement: the candidate point index plus its apex orientation. */
export interface GlyphPlacement {
    readonly index: number;
    readonly quaternion: GlyphQuaternion;
}

/**
 * Plan cone placements over `count` points with xyz-packed per-point
 * `vectors`: decimate by `density` (capped), then skip degenerate
 * (zero/non-finite) vectors. Tuple-count mismatch plans nothing (never a
 * throw — the widget shows no glyphs instead of misaligning vectors).
 */
export function planGlyphs(count: number, vectors: ArrayLike<number>, density: number): GlyphPlacement[] {
    const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (safe === 0 || Math.floor(vectors.length / 3) !== safe) {
        return [];
    }
    const out: GlyphPlacement[] = [];
    for (const index of decimateGlyphIndices(safe, density)) {
        const quaternion = quaternionFromUp(vectors[index * 3], vectors[index * 3 + 1], vectors[index * 3 + 2]);
        if (quaternion) {
            out.push({ index, quaternion });
        }
    }
    return out;
}

// F5b streamlines seam: StreamTracer parity needs a true vector volume plus
// an integrator; no producer emits one today. When one lands, seed it from
// the same per-point vectors glyphs consume (polyline tangents or an
// explicit 3-component point array, see GlyphVectorField) — this module
// ships no integrator.
/** Per-point vector field backing glyphs today and streamline seeds later. */
export interface GlyphVectorField {
    /** xyz-packed direction vectors, one tuple per candidate point. */
    readonly values: ArrayLike<number>;
    /** Candidate point count (must equal `values.length / 3`). */
    readonly count: number;
}
