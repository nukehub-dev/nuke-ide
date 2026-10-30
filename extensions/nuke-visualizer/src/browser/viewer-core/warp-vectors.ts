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
 * Warp-by-vector math for the native 3D viewer core (FEM magnified
 * deformation): displace point positions along a 3-component vector array
 * (nodal DISP today, velocity tomorrow), ParaView `Warp By Vector` parity
 * computed client-side with no backend work.
 *
 * Scale modes use the `true|auto|capped-N` vocabulary:
 *
 * - `true` — real displacement (scale factor 1).
 * - `auto` — the exaggeration that makes the largest displacement span 10%
 *   of the model bounding-box diagonal (the FreeCAD FEM postprocessing
 *   convention), so small strains become visible without manual tuning.
 * - `capped` — the user exaggeration from the Viewer Settings slider,
 *   clamped to the slider maximum (the cap N).
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 * Widgets rewrite their position buffers from {@link applyWarp} and
 * recompute mesh normals; disabling warp (or losing the vector array)
 * rewrites the same buffers from the untouched base positions, so no
 * warped copy is ever stored.
 */

/** Warp scale modes: true displacement, auto 10%-of-size, or the capped user exaggeration. */
export type WarpScaleMode = 'true' | 'auto' | 'capped';

/** Select entry: display metadata for one warp scale mode. */
export interface WarpScaleModeInfo {
    readonly id: WarpScaleMode;
    readonly label: string;
}

export const WARP_SCALE_MODES: readonly WarpScaleModeInfo[] = [
    { id: 'true', label: 'True scale (x1)' },
    { id: 'auto', label: 'Auto (10% of size)' },
    { id: 'capped', label: 'Capped exaggeration' }
];

/** Default warp scale mode: auto magnification. */
export const DEFAULT_WARP_SCALE_MODE: WarpScaleMode = 'auto';

/** Fraction of the bounding-box diagonal the largest auto-warped displacement spans. */
export const WARP_AUTO_FRACTION = 0.1;

/** Exaggeration slider bounds (the slider maximum is the `capped-N` cap). */
export const WARP_EXAGGERATION_SPEC = { min: 0, max: 100, step: 0.1 } as const;

/** Runtime guard for warp scale-mode values (settings select + props API). */
export function isWarpScaleMode(value: unknown): value is WarpScaleMode {
    return value === 'true' || value === 'auto' || value === 'capped';
}

/** Minimal shape of a dataset array considered for warp eligibility (structural, never the widget type). */
export interface WarpVectorCandidate {
    readonly name: string;
    readonly association: 'point' | 'cell';
    readonly components: number;
}

/**
 * Whether an array can drive warp: 3-component POINT data only. Cell arrays
 * cannot displace vertices 1:1 (that would need cell-to-point interpolation),
 * so they never qualify even with three components.
 */
export function isWarpVectorCandidate(candidate: WarpVectorCandidate): boolean {
    return candidate.association === 'point' && candidate.components === 3;
}

/** Whether any array in the list can drive warp. */
export function hasWarpVectors(candidates: readonly WarpVectorCandidate[]): boolean {
    return candidates.some(isWarpVectorCandidate);
}

/** Largest L2 norm over the xyz-packed vectors; 0 when empty (the degenerate zero-vector guard input). */
export function maxVectorMagnitude(vectors: ArrayLike<number>): number {
    const count = Math.floor(vectors.length / 3);
    let max = 0;
    for (let i = 0; i < count; i++) {
        const x = vectors[i * 3];
        const y = vectors[i * 3 + 1];
        const z = vectors[i * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            continue;
        }
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        if (magnitude > max) {
            max = magnitude;
        }
    }
    return max;
}

/** Diagonal length of the bounding box around xyz-packed positions; 0 when empty or degenerate. */
export function boundingBoxDiagonal(positions: ArrayLike<number>): number {
    const count = Math.floor(positions.length / 3);
    if (count === 0) {
        return 0;
    }
    let minX = positions[0];
    let minY = positions[1];
    let minZ = positions[2];
    let maxX = minX;
    let maxY = minY;
    let maxZ = minZ;
    for (let i = 1; i < count; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
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
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
        return 0;
    }
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Auto exaggeration for xyz-packed positions displaced by xyz-packed vectors:
 * the scale that makes the largest displacement span {@link WARP_AUTO_FRACTION}
 * of the model diagonal. Returns 0 when there is nothing to magnify
 * (all-zero vectors) or no model extent — the degenerate guard, so callers
 * apply a no-op instead of dividing by zero.
 */
export function autoWarpScale(positions: ArrayLike<number>, vectors: ArrayLike<number>): number {
    const max = maxVectorMagnitude(vectors);
    if (!(max > 0)) {
        return 0;
    }
    const diagonal = boundingBoxDiagonal(positions);
    if (!(diagonal > 0)) {
        return 0;
    }
    return (WARP_AUTO_FRACTION * diagonal) / max;
}

/** Clamp a user exaggeration into [0, cap]; non-finite input maps to 0. */
export function clampWarpExaggeration(value: number, cap: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const ceiling = Number.isFinite(cap) && cap >= 0 ? cap : 0;
    return Math.min(ceiling, Math.max(0, value));
}

/**
 * Resolve the effective warp scale for a mode: `true` is real displacement
 * (1), `auto` is the precomputed 10%-of-size scale (sanitized, never
 * negative), `capped` is the user exaggeration clamped to the cap N.
 */
export function resolveWarpScale(mode: WarpScaleMode, exaggeration: number, autoScale: number, cap: number): number {
    switch (mode) {
        case 'true':
            return 1;
        case 'auto':
            return Number.isFinite(autoScale) && autoScale >= 0 ? autoScale : 0;
        case 'capped':
            return clampWarpExaggeration(exaggeration, cap);
    }
}

/**
 * Displace xyz-packed positions along xyz-packed vectors scaled by `scale`
 * (`out[i] = positions[i] + vectors[i] * scale`), returning a fresh array —
 * the caller's base positions are never mutated. Tuple-count mismatch or a
 * non-finite scale degrades to an unchanged copy (never a throw), and
 * non-finite vector components contribute no displacement so one bad tuple
 * cannot collapse the mesh.
 */
export function applyWarp(positions: ArrayLike<number>, vectors: ArrayLike<number>, scale: number): Float32Array {
    const count = Math.floor(positions.length / 3);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) {
        out[i] = positions[i];
    }
    if (!Number.isFinite(scale) || Math.floor(vectors.length / 3) !== count) {
        return out;
    }
    for (let i = 0; i < count; i++) {
        const vx = vectors[i * 3];
        const vy = vectors[i * 3 + 1];
        const vz = vectors[i * 3 + 2];
        if (Number.isFinite(vx)) {
            out[i * 3] += vx * scale;
        }
        if (Number.isFinite(vy)) {
            out[i * 3 + 1] += vy * scale;
        }
        if (Number.isFinite(vz)) {
            out[i * 3 + 2] += vz * scale;
        }
    }
    return out;
}
