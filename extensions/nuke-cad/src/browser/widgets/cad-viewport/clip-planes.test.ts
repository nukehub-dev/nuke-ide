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
import { computeClipPlanes } from './clip-planes';

// The reported tokamak document: bbox diagonal ≈ 6380, framed at
// `diag * √3` so the camera sits ≈ 11050 from the target with a 3190 radius.
const TOKAMAK_DISTANCE = 11050;
const TOKAMAK_RADIUS = 3190;
const DEPTH_RATIO_BOUND = 1e5;

describe('computeClipPlanes', () => {
    it('keeps the reported tokamak model inside the frustum', () => {
        const { near, far } = computeClipPlanes(TOKAMAK_DISTANCE, TOKAMAK_RADIUS);
        // The far side of the model sits at distance + radius; it must be
        // visible without scrolling in.
        expect(far).toBeGreaterThan(TOKAMAK_DISTANCE + TOKAMAK_RADIUS);
        // The camera is outside the model, so the near plane must not cut it.
        expect(near).toBeLessThan(TOKAMAK_DISTANCE - TOKAMAK_RADIUS);
    });

    it('bounds the far/near ratio at fit distance', () => {
        const { near, far } = computeClipPlanes(TOKAMAK_DISTANCE, TOKAMAK_RADIUS);
        expect(far / near).toBeLessThanOrEqual(DEPTH_RATIO_BOUND);
        // Fit distance keeps the old 1e6 legacy ratio well below the bound;
        // a ~290 ratio is what stops the concentric-shell z-fighting.
        expect(far / near).toBeLessThan(400);
    });

    it('scales with the scene instead of a fixed far plane', () => {
        const small = computeClipPlanes(17.3, 5);
        const large = computeClipPlanes(TOKAMAK_DISTANCE, TOKAMAK_RADIUS);
        expect(large.far).toBeGreaterThan(small.far * 100);
        expect(large.far).toBeGreaterThan(10000); // the old hard-coded far plane
    });

    it('keeps a usable depth range through the whole dolly range', () => {
        for (const distance of [TOKAMAK_RADIUS * 0.001, 1, 100, TOKAMAK_DISTANCE, TOKAMAK_DISTANCE * 1e3]) {
            const { near, far } = computeClipPlanes(distance, TOKAMAK_RADIUS);
            expect(near).toBeGreaterThan(0);
            expect(far).toBeGreaterThan(near * 10);
            expect(far / near).toBeLessThanOrEqual(DEPTH_RATIO_BOUND);
        }
    });

    it('clamps zero, negative, and non-finite inputs', () => {
        const cases: Array<[number, number]> = [
            [0, 0],
            [-5, -5],
            [-1, 100],
            [100, -1],
            [Number.NaN, 10],
            [10, Number.NaN],
            [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
        ];
        for (const [distance, radius] of cases) {
            const { near, far } = computeClipPlanes(distance, radius);
            expect(Number.isFinite(near)).toBe(true);
            expect(Number.isFinite(far)).toBe(true);
            expect(near).toBeGreaterThan(0);
            expect(far).toBeGreaterThan(near * 10);
        }
    });
});
