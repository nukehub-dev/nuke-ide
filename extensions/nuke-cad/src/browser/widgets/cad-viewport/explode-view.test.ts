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

import { describe, expect, it } from 'vitest';
import { clampExplodeFactor, explodeBoxCenterDiagonal, explodeOffset, planExplodeOffsets } from './explode-view';

describe('explode-view', () => {
    it('clamps the slider factor into 0..1', () => {
        expect(clampExplodeFactor(-0.5)).toBe(0);
        expect(clampExplodeFactor(0)).toBe(0);
        expect(clampExplodeFactor(0.25)).toBe(0.25);
        expect(clampExplodeFactor(1)).toBe(1);
        expect(clampExplodeFactor(3)).toBe(1);
        expect(clampExplodeFactor(NaN)).toBe(0);
    });

    it('offsets along the direction from the global center to the solid centroid', () => {
        // Center at origin, solid centroid on +X: the offset must be +X only.
        const offset = explodeOffset([10, 0, 0], [0, 0, 0], 100, 0.5);
        expect(offset[0]).toBeCloseTo(50, 12);
        expect(offset[1]).toBeCloseTo(0, 12);
        expect(offset[2]).toBeCloseTo(0, 12);
    });

    it('normalizes the direction so only the magnitude scales with factor', () => {
        // Centroid distance from center (60, 0, 0) is irrelevant: a factor of 1
        // moves the solid exactly one diagonal.
        const offset = explodeOffset([160, 0, 0], [100, 0, 0], 40, 1);
        expect(offset[0]).toBeCloseTo(40, 12);
        // Halving the factor halves the offset.
        const half = explodeOffset([160, 0, 0], [100, 0, 0], 40, 0.5);
        expect(half[0]).toBeCloseTo(20, 12);
    });

    it('scales diagonally placed centroids component-wise after normalization', () => {
        const offset = explodeOffset([1, 1, 0], [0, 0, 0], 10, 1);
        const expected = 10 / Math.sqrt(2);
        expect(offset[0]).toBeCloseTo(expected, 12);
        expect(offset[1]).toBeCloseTo(expected, 12);
        expect(offset[2]).toBe(0);
    });

    it('returns the zero vector for a centroid at the global center', () => {
        expect(explodeOffset([2, 3, 4], [2, 3, 4], 100, 1)).toEqual([0, 0, 0]);
    });

    it('returns the zero vector for a non-positive factor or diagonal', () => {
        expect(explodeOffset([10, 0, 0], [0, 0, 0], 100, 0)).toEqual([0, 0, 0]);
        expect(explodeOffset([10, 0, 0], [0, 0, 0], 100, -1)).toEqual([0, 0, 0]);
        expect(explodeOffset([10, 0, 0], [0, 0, 0], 0, 1)).toEqual([0, 0, 0]);
    });

    it('derives the center and diagonal of a bounding box', () => {
        const { center, diagonal } = explodeBoxCenterDiagonal({ min: [-1, 0, 2], max: [3, 4, 10] });
        expect(center).toEqual([1, 2, 6]);
        expect(diagonal).toBeCloseTo(Math.sqrt(4 ** 2 + 4 ** 2 + 8 ** 2), 12);
    });

    it('plans per-solid offsets for a synthetic multi-solid layout', () => {
        // Two solids on opposite sides of a 10×10×10 box centered at origin.
        const solids = [
            { solidId: 0, centroid: [5, 0, 0] as const },
            { solidId: 1, centroid: [-5, 0, 0] as const },
            { solidId: 2, centroid: [0, 0, 0] as const }
        ];
        const box = { min: [-5, -5, -5], max: [5, 5, 5] };
        const diagonal = Math.sqrt(300);
        const offsets = planExplodeOffsets(solids, box, 0.5);
        expect(offsets.get(0)?.[0]).toBeCloseTo(diagonal * 0.5, 12);
        expect(offsets.get(0)?.[1]).toBe(0);
        expect(offsets.get(1)?.[0]).toBeCloseTo(-diagonal * 0.5, 12);
        // The solid sitting at the explode origin does not move.
        expect(offsets.get(2)).toEqual([0, 0, 0]);
        expect(offsets.size).toBe(3);
    });

    it('plans all-zero offsets at factor 0 without needing a valid box', () => {
        const solids = [{ solidId: 7, centroid: [5, 5, 5] as const }];
        const offsets = planExplodeOffsets(solids, { min: [NaN, NaN, NaN], max: [NaN, NaN, NaN] }, 0);
        expect(offsets.get(7)).toEqual([0, 0, 0]);
    });
});
