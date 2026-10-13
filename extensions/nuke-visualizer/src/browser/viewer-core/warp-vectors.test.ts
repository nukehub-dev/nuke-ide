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
 * Tests for the viewer-core warp-by-vector math (no DOM, no three.js):
 * displacement, auto-scale (10% of the bbox diagonal), the degenerate
 * zero-vector guard, capped exaggeration, and vector-array eligibility.
 */

import { describe, expect, it } from 'vitest';
import {
    applyWarp,
    autoWarpScale,
    boundingBoxDiagonal,
    clampWarpExaggeration,
    DEFAULT_WARP_SCALE_MODE,
    hasWarpVectors,
    isWarpScaleMode,
    isWarpVectorCandidate,
    maxVectorMagnitude,
    resolveWarpScale,
    WARP_AUTO_FRACTION,
    WARP_EXAGGERATION_SPEC,
    WARP_SCALE_MODES
} from './warp-vectors';

describe('applyWarp', () => {
    it('displaces positions along the scaled vectors', () => {
        const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
        const vectors = new Float64Array([0.5, 0, 0, 0, 2, 0]);
        expect(Array.from(applyWarp(positions, vectors, 2))).toEqual([1, 0, 0, 1, 4, 0]);
    });

    it('leaves positions untouched at a zero scale', () => {
        const positions = new Float32Array([0, 0, 0, 1, 2, 3]);
        const vectors = new Float64Array([9, 9, 9, 9, 9, 9]);
        expect(Array.from(applyWarp(positions, vectors, 0))).toEqual([0, 0, 0, 1, 2, 3]);
    });

    it('never mutates the input positions', () => {
        const positions = new Float32Array([0, 0, 0]);
        const vectors = new Float64Array([1, 1, 1]);
        const out = applyWarp(positions, vectors, 3);
        expect(out).not.toBe(positions);
        expect(Array.from(positions)).toEqual([0, 0, 0]);
        expect(Array.from(out)).toEqual([3, 3, 3]);
    });

    it('copies positions unchanged on tuple-count mismatch', () => {
        const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
        const vectors = new Float64Array([1, 0, 0]);
        expect(Array.from(applyWarp(positions, vectors, 5))).toEqual([0, 0, 0, 1, 1, 1]);
    });

    it('copies positions unchanged for a non-finite scale', () => {
        const positions = new Float32Array([0, 0, 0]);
        const vectors = new Float64Array([1, 1, 1]);
        expect(Array.from(applyWarp(positions, vectors, Number.NaN))).toEqual([0, 0, 0]);
    });

    it('skips non-finite vector components without collapsing the point', () => {
        const positions = new Float32Array([1, 2, 3]);
        const vectors = new Float64Array([Number.NaN, 1, Number.POSITIVE_INFINITY]);
        expect(Array.from(applyWarp(positions, vectors, 2))).toEqual([1, 4, 3]);
    });
});

describe('maxVectorMagnitude', () => {
    it('returns the largest L2 norm', () => {
        expect(maxVectorMagnitude(new Float64Array([3, 4, 0, 1, 0, 0]))).toBe(5);
    });

    it('returns 0 for empty and all-zero vectors (degenerate guard input)', () => {
        expect(maxVectorMagnitude(new Float64Array(0))).toBe(0);
        expect(maxVectorMagnitude(new Float64Array([0, 0, 0, 0, 0, 0]))).toBe(0);
    });

    it('ignores non-finite components', () => {
        expect(maxVectorMagnitude(new Float64Array([Number.NaN, 0, 0, 1, 0, 0]))).toBe(1);
    });
});

describe('boundingBoxDiagonal', () => {
    it('measures the unit-cube diagonal', () => {
        const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
        expect(boundingBoxDiagonal(positions)).toBeCloseTo(Math.sqrt(3), 12);
    });

    it('returns 0 for empty and single-point positions', () => {
        expect(boundingBoxDiagonal(new Float32Array(0))).toBe(0);
        expect(boundingBoxDiagonal(new Float32Array([1, 2, 3]))).toBe(0);
    });
});

describe('autoWarpScale', () => {
    it('magnifies the largest displacement to 10% of the diagonal', () => {
        // Diagonal 10, largest displacement 0.5 -> scale 2 (0.5 * 2 = 1 = 10% of 10).
        const positions = new Float32Array([0, 0, 0, 10, 0, 0]);
        const vectors = new Float64Array([0.5, 0, 0, 0.25, 0, 0]);
        expect(autoWarpScale(positions, vectors)).toBeCloseTo(2, 12);
        expect(WARP_AUTO_FRACTION).toBe(0.1);
    });

    it('returns 0 for all-zero vectors (degenerate zero-vector guard)', () => {
        const positions = new Float32Array([0, 0, 0, 10, 0, 0]);
        expect(autoWarpScale(positions, new Float64Array(6))).toBe(0);
    });

    it('returns 0 with no model extent', () => {
        expect(autoWarpScale(new Float32Array(0), new Float64Array([1, 0, 0]))).toBe(0);
        expect(autoWarpScale(new Float32Array([1, 1, 1]), new Float64Array([1, 0, 0]))).toBe(0);
    });
});

describe('resolveWarpScale', () => {
    it('resolves true scale to exactly 1', () => {
        expect(resolveWarpScale('true', 42, 7, 100)).toBe(1);
    });

    it('resolves auto to the precomputed 10%-of-size scale', () => {
        expect(resolveWarpScale('auto', 42, 7, 100)).toBe(7);
        expect(resolveWarpScale('auto', 42, Number.NaN, 100)).toBe(0);
        expect(resolveWarpScale('auto', 42, -3, 100)).toBe(0);
    });

    it('clamps the capped exaggeration to [0, cap]', () => {
        expect(resolveWarpScale('capped', 12, 7, 100)).toBe(12);
        expect(resolveWarpScale('capped', 250, 7, 100)).toBe(100);
        expect(resolveWarpScale('capped', -5, 7, 100)).toBe(0);
        expect(resolveWarpScale('capped', Number.NaN, 7, 100)).toBe(0);
    });
});

describe('clampWarpExaggeration', () => {
    it('passes through in-range values', () => {
        expect(clampWarpExaggeration(12.5, 100)).toBe(12.5);
    });

    it('clamps to the cap and floors negatives and non-finite input at 0', () => {
        expect(clampWarpExaggeration(250, 100)).toBe(100);
        expect(clampWarpExaggeration(-1, 100)).toBe(0);
        expect(clampWarpExaggeration(Number.NaN, 100)).toBe(0);
        expect(clampWarpExaggeration(5, Number.NaN)).toBe(0);
    });

    it('caps at the slider maximum by default', () => {
        expect(WARP_EXAGGERATION_SPEC.min).toBe(0);
        expect(WARP_EXAGGERATION_SPEC.max).toBeGreaterThan(0);
        expect(clampWarpExaggeration(1000, WARP_EXAGGERATION_SPEC.max)).toBe(WARP_EXAGGERATION_SPEC.max);
    });
});

describe('warp scale modes', () => {
    it('offers true/auto/capped exactly once each with auto as the default', () => {
        expect(WARP_SCALE_MODES.map((entry) => entry.id)).toEqual(['true', 'auto', 'capped']);
        expect(DEFAULT_WARP_SCALE_MODE).toBe('auto');
    });

    it('guards mode values', () => {
        expect(isWarpScaleMode('true')).toBe(true);
        expect(isWarpScaleMode('auto')).toBe(true);
        expect(isWarpScaleMode('capped')).toBe(true);
        expect(isWarpScaleMode('log')).toBe(false);
        expect(isWarpScaleMode(undefined)).toBe(false);
    });
});

describe('warp vector eligibility', () => {
    it('accepts 3-component point arrays only', () => {
        expect(isWarpVectorCandidate({ name: 'DISP', association: 'point', components: 3 })).toBe(true);
        expect(isWarpVectorCandidate({ name: 'DISP', association: 'cell', components: 3 })).toBe(false);
        expect(isWarpVectorCandidate({ name: 'temp', association: 'point', components: 1 })).toBe(false);
    });

    it('detects any eligible array in a dataset listing', () => {
        expect(hasWarpVectors([{ name: 'temp', association: 'point', components: 1 }])).toBe(false);
        expect(hasWarpVectors([])).toBe(false);
        expect(
            hasWarpVectors([
                { name: 'temp', association: 'point', components: 1 },
                { name: 'DISP', association: 'point', components: 3 }
            ])
        ).toBe(true);
    });
});
