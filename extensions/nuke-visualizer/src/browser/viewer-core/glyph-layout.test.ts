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
 * Tests for the viewer-core direction-glyph layout math (no DOM, no
 * three.js): density decimation incl. the instance cap, polyline tangents
 * incl. degenerate segments, the +Y orientation quaternion incl. the
 * zero-vector skip, and end-to-end placement planning.
 */

import { describe, expect, it } from 'vitest';
import {
    autoGlyphSize,
    clampGlyphDensity,
    clampGlyphScale,
    decimateGlyphIndices,
    DEFAULT_GLYPH_DENSITY,
    DEFAULT_GLYPH_SCALE,
    GLYPH_DENSITY_SPEC,
    GLYPH_SCALE_SPEC,
    GLYPH_SIZE_DIVISOR,
    MAX_GLYPH_INSTANCES,
    planGlyphs,
    polylineTangents,
    quaternionFromUp
} from './glyph-layout';

/** Rotate a vector by a unit quaternion (x, y, z, w). */
function rotateByQuaternion(
    vector: readonly [number, number, number],
    quaternion: readonly [number, number, number, number]
): [number, number, number] {
    const [vx, vy, vz] = vector;
    const [qx, qy, qz, qw] = quaternion;
    // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + w * v)
    const cx = qy * vz - qz * vy + qw * vx;
    const cy = qz * vx - qx * vz + qw * vy;
    const cz = qx * vy - qy * vx + qw * vz;
    const dx = qy * cz - qz * cy;
    const dy = qz * cx - qx * cz;
    const dz = qx * cy - qy * cx;
    return [vx + 2 * dx, vy + 2 * dy, vz + 2 * dz];
}

describe('glyph density and scale clamps', () => {
    it('clamps density into the slider range', () => {
        expect(clampGlyphDensity(0.5)).toBe(0.5);
        expect(clampGlyphDensity(GLYPH_DENSITY_SPEC.min)).toBe(GLYPH_DENSITY_SPEC.min);
        expect(clampGlyphDensity(GLYPH_DENSITY_SPEC.max)).toBe(GLYPH_DENSITY_SPEC.max);
        expect(clampGlyphDensity(0)).toBe(GLYPH_DENSITY_SPEC.min);
        expect(clampGlyphDensity(99)).toBe(GLYPH_DENSITY_SPEC.max);
    });

    it('maps non-finite density to the default', () => {
        expect(clampGlyphDensity(Number.NaN)).toBe(DEFAULT_GLYPH_DENSITY);
        expect(clampGlyphDensity(Infinity)).toBe(DEFAULT_GLYPH_DENSITY);
    });

    it('clamps scale into the slider range', () => {
        expect(clampGlyphScale(2)).toBe(2);
        expect(clampGlyphScale(0)).toBe(GLYPH_SCALE_SPEC.min);
        expect(clampGlyphScale(99)).toBe(GLYPH_SCALE_SPEC.max);
    });

    it('maps non-finite scale to the default', () => {
        expect(clampGlyphScale(Number.NaN)).toBe(DEFAULT_GLYPH_SCALE);
        expect(clampGlyphScale(-Infinity)).toBe(DEFAULT_GLYPH_SCALE);
    });
});

describe('autoGlyphSize', () => {
    it('sizes cones off the model diagonal', () => {
        const positions = new Float32Array([0, 0, 0, GLYPH_SIZE_DIVISOR, 0, 0]);
        expect(autoGlyphSize(positions)).toBeCloseTo(1, 9);
    });

    it('returns 0 without model extent (the degenerate guard)', () => {
        expect(autoGlyphSize(new Float32Array(0))).toBe(0);
        expect(autoGlyphSize(new Float32Array([1, 2, 3, 1, 2, 3]))).toBe(0);
    });
});

describe('decimateGlyphIndices', () => {
    it('keeps every point at full density', () => {
        expect(decimateGlyphIndices(5, 1)).toEqual([0, 1, 2, 3, 4]);
    });

    it('strides evenly at fractional density', () => {
        expect(decimateGlyphIndices(10, 0.1)).toEqual([0]);
        expect(decimateGlyphIndices(20, 0.1)).toEqual([0, 10]);
        expect(decimateGlyphIndices(10, 0.5)).toEqual([0, 2, 4, 6, 8]);
    });

    it('caps live instances on huge clouds', () => {
        const indices = decimateGlyphIndices(MAX_GLYPH_INSTANCES * 3 + 1, 1);
        expect(indices.length).toBeLessThanOrEqual(MAX_GLYPH_INSTANCES);
        expect(indices[0]).toBe(0);
    });

    it('plans nothing for empty or invalid counts', () => {
        expect(decimateGlyphIndices(0, 1)).toEqual([]);
        expect(decimateGlyphIndices(-4, 1)).toEqual([]);
        expect(decimateGlyphIndices(Number.NaN, 1)).toEqual([]);
    });

    it('treats non-finite density as the default', () => {
        expect(decimateGlyphIndices(100, Number.NaN)).toEqual(decimateGlyphIndices(100, DEFAULT_GLYPH_DENSITY));
    });
});

describe('polylineTangents', () => {
    it('orients chain points along the polyline', () => {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
        const tangents = polylineTangents(positions, new Uint32Array([0, 1, 1, 2]));
        expect(Array.from(tangents)).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    });

    it('averages incident segments at shared vertices', () => {
        // L-shape: (0,0) -> (1,0) -> (1,1); the corner blends both directions.
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
        const tangents = polylineTangents(positions, new Uint32Array([0, 1, 1, 2]));
        expect(tangents[0]).toBeCloseTo(1, 6);
        expect(tangents[1]).toBeCloseTo(0, 6);
        const inv = 1 / Math.SQRT2;
        expect(tangents[3]).toBeCloseTo(inv, 6);
        expect(tangents[4]).toBeCloseTo(inv, 6);
        expect(tangents[6]).toBeCloseTo(0, 6);
        expect(tangents[7]).toBeCloseTo(1, 6);
    });

    it('skips zero-length segments and leaves isolated points at zero', () => {
        const positions = new Float32Array([0, 0, 0, 0, 0, 0, 5, 5, 5]);
        const tangents = polylineTangents(positions, new Uint32Array([0, 1]));
        expect(Array.from(tangents.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
        expect(Array.from(tangents.slice(6, 9))).toEqual([0, 0, 0]);
    });

    it('ignores out-of-range indices', () => {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
        const tangents = polylineTangents(positions, new Uint32Array([0, 7, -1, 1]));
        expect(Array.from(tangents)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it('returns unit vectors for finite input', () => {
        const positions = new Float32Array([0, 0, 0, 3, 4, 0]);
        const tangents = polylineTangents(positions, new Uint32Array([0, 1]));
        expect(tangents[0]).toBeCloseTo(0.6, 6);
        expect(tangents[1]).toBeCloseTo(0.8, 6);
        expect(tangents[2]).toBeCloseTo(0, 6);
    });
});

describe('quaternionFromUp', () => {
    it('is the identity for +Y', () => {
        expect(quaternionFromUp(0, 2, 0)).toEqual([0, 0, 0, 1]);
    });

    it('rotates the cone apex onto arbitrary directions', () => {
        const targets: [number, number, number][] = [
            [1, 0, 0],
            [0, 0, 1],
            [1, 1, 1],
            [-2, 0.5, 3]
        ];
        for (const target of targets) {
            const quaternion = quaternionFromUp(target[0], target[1], target[2]);
            expect(quaternion).toBeDefined();
            const rotated = rotateByQuaternion([0, 1, 0], quaternion!);
            const length = Math.sqrt(target[0] * target[0] + target[1] * target[1] + target[2] * target[2]);
            expect(rotated[0]).toBeCloseTo(target[0] / length, 6);
            expect(rotated[1]).toBeCloseTo(target[1] / length, 6);
            expect(rotated[2]).toBeCloseTo(target[2] / length, 6);
            // Unit quaternion.
            const [x, y, z, w] = quaternion!;
            expect(Math.sqrt(x * x + y * y + z * z + w * w)).toBeCloseTo(1, 9);
        }
    });

    it('half-turns the apex onto -Y', () => {
        const quaternion = quaternionFromUp(0, -5, 0)!;
        expect(quaternion).toBeDefined();
        expect(rotateByQuaternion([0, 1, 0], quaternion)).toEqual([0, -1, 0]);
    });

    it('skips zero and non-finite vectors (the degenerate guard)', () => {
        expect(quaternionFromUp(0, 0, 0)).toBeUndefined();
        expect(quaternionFromUp(Number.NaN, 0, 0)).toBeUndefined();
        expect(quaternionFromUp(0, Infinity, 0)).toBeUndefined();
    });
});

describe('planGlyphs', () => {
    it('places decimated cones with orientations', () => {
        const vectors = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
        const placements = planGlyphs(4, vectors, 0.5);
        expect(placements.map((placement) => placement.index)).toEqual([0, 2]);
        for (const placement of placements) {
            expect(rotateByQuaternion([0, 1, 0], placement.quaternion)[0]).toBeCloseTo(1, 6);
        }
    });

    it('skips degenerate zero vectors', () => {
        const vectors = new Float32Array([1, 0, 0, 0, 0, 0, 0, 1, 0]);
        const placements = planGlyphs(3, vectors, 1);
        expect(placements.map((placement) => placement.index)).toEqual([0, 2]);
    });

    it('plans nothing on tuple-count mismatch (never a throw)', () => {
        expect(planGlyphs(3, new Float32Array([1, 0, 0]), 1)).toEqual([]);
        expect(planGlyphs(0, new Float32Array(0), 1)).toEqual([]);
    });
});
