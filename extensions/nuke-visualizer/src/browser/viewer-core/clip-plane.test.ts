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
 * Tests for the per-axis clip-plane state (no DOM, no three.js):
 * defaults, guards, updates, three.js plane derivation for box-section
 * views, and bounding-box helpers for position sliders.
 */

import { describe, expect, it } from 'vitest';
import {
    anyClipEnabled,
    axisClipNormal,
    AxisAlignedBounds,
    boundingBoxCenter,
    boundingBoxCorners,
    boundingBoxFromPositions,
    boundingBoxSize,
    clampClipFraction,
    CLIP_AXES,
    createClipPlanesState,
    DEFAULT_CLIP_PLANES_STATE,
    describeClipPlanes,
    isAxisClipState,
    isClipPlanesState,
    setAllClipEnabled,
    toThreePlaneParamsArray,
    updateAxisClip
} from './clip-plane';

const BOUNDS: AxisAlignedBounds = { min: [-2, 0, 0], max: [2, 4, 6] };

describe('createClipPlanesState / guards / updates', () => {
    it('defaults every axis to the middle, disabled', () => {
        expect(DEFAULT_CLIP_PLANES_STATE).toEqual({
            X: { enabled: false, fraction: 0.5, invert: false },
            Y: { enabled: false, fraction: 0.5, invert: false },
            Z: { enabled: false, fraction: 0.5, invert: false }
        });
        expect(createClipPlanesState()).toEqual(DEFAULT_CLIP_PLANES_STATE);
        expect(CLIP_AXES).toEqual(['X', 'Y', 'Z']);
    });

    it('patches single axes and clamps fractions', () => {
        const state = createClipPlanesState({ X: { enabled: true, fraction: 0.25, invert: true } });
        expect(state.X).toEqual({ enabled: true, fraction: 0.25, invert: true });
        expect(state.Y).toEqual(DEFAULT_CLIP_PLANES_STATE.Y);
        expect(createClipPlanesState({ Z: { fraction: 99 } }).Z.fraction).toBe(1);
        expect(createClipPlanesState({ Z: { fraction: Number.NaN } }).Z.fraction).toBe(0.5);
    });

    it('validates unknown payloads', () => {
        expect(isClipPlanesState(createClipPlanesState())).toBe(true);
        expect(
            isClipPlanesState({
                X: { enabled: true, fraction: 0, invert: false },
                Y: { enabled: false, fraction: 1, invert: true },
                Z: { enabled: false, fraction: 0.5, invert: false }
            })
        ).toBe(true);
        expect(isClipPlanesState(undefined)).toBe(false);
        expect(isClipPlanesState({ X: { enabled: true, fraction: 0, invert: false } })).toBe(false);
        expect(
            isClipPlanesState({
                X: { enabled: true, fraction: Number.NaN, invert: false },
                Y: { enabled: false, fraction: 0.5, invert: false },
                Z: { enabled: false, fraction: 0.5, invert: false }
            })
        ).toBe(false);
        expect(isAxisClipState({ enabled: false, fraction: 0.5, invert: false })).toBe(true);
        expect(isAxisClipState({ enabled: 'yes', fraction: 0.5, invert: false })).toBe(false);
    });

    it('updates single axes immutably', () => {
        const state = createClipPlanesState();
        const moved = updateAxisClip(state, 'Y', { fraction: 0.75 });
        expect(moved.Y.fraction).toBe(0.75);
        expect(state.Y.fraction).toBe(0.5);
        expect(updateAxisClip(state, 'Z', { enabled: true, invert: true }).Z).toEqual({
            enabled: true,
            fraction: 0.5,
            invert: true
        });
    });

    it('toggles every axis while keeping positions', () => {
        const state = createClipPlanesState({ X: { enabled: true, fraction: 0.25 } });
        expect(anyClipEnabled(state)).toBe(true);
        expect(anyClipEnabled(createClipPlanesState())).toBe(false);
        const all = setAllClipEnabled(state, true);
        expect(anyClipEnabled(all)).toBe(true);
        expect(all.X.fraction).toBe(0.25);
        const none = setAllClipEnabled(all, false);
        expect(anyClipEnabled(none)).toBe(false);
        expect(none.X.fraction).toBe(0.25);
    });

    it('clamps fractions', () => {
        expect(clampClipFraction(0.25)).toBe(0.25);
        expect(clampClipFraction(-1)).toBe(0);
        expect(clampClipFraction(99)).toBe(1);
        expect(clampClipFraction(Number.NaN)).toBe(0.5);
    });
});

describe('toThreePlaneParamsArray', () => {
    it('emits no planes when every axis is disabled', () => {
        expect(toThreePlaneParamsArray(createClipPlanesState(), BOUNDS)).toEqual([]);
    });

    it('places one plane per enabled axis at its fraction', () => {
        const params = toThreePlaneParamsArray(createClipPlanesState({ X: { enabled: true, fraction: 0.5 } }), BOUNDS);
        expect(params).toEqual([{ normal: [1, 0, 0], constant: 0 }]);
        const quarter = toThreePlaneParamsArray(createClipPlanesState({ Z: { enabled: true, fraction: 0 } }), BOUNDS);
        expect(quarter).toEqual([{ normal: [0, 0, 1], constant: 0 }]);
        const full = toThreePlaneParamsArray(createClipPlanesState({ Y: { enabled: true, fraction: 1 } }), BOUNDS);
        expect(full).toEqual([{ normal: [0, 1, 0], constant: -4 }]);
    });

    it('negates the plane when inverted (keeps the opposite half-space)', () => {
        const params = toThreePlaneParamsArray(createClipPlanesState({ X: { enabled: true, fraction: 0.5, invert: true } }), BOUNDS);
        expect(params).toEqual([{ normal: [-1, 0, 0], constant: 0 }]);
    });

    it('applies enabled planes together for box-section views', () => {
        const params = toThreePlaneParamsArray(
            createClipPlanesState({ X: { enabled: true, fraction: 0.5 }, Z: { enabled: true, fraction: 0.5 } }),
            BOUNDS
        );
        expect(params).toEqual([
            { normal: [1, 0, 0], constant: 0 },
            { normal: [0, 0, 1], constant: -3 }
        ]);
    });

    it('matches the three.js clipping convention (negative = clipped)', () => {
        // X plane at fraction 0.5 of [-2, 2] sits at x = 0: points below are clipped.
        const [params] = toThreePlaneParamsArray(createClipPlanesState({ X: { enabled: true, fraction: 0.5 } }), BOUNDS);
        const distance = (point: [number, number, number]): number =>
            params.normal[0] * point[0] + params.normal[1] * point[1] + params.normal[2] * point[2] + params.constant;
        expect(distance([1, 0, 0])).toBeCloseTo(1);
        expect(distance([-1, 0, 0])).toBeCloseTo(-1);
        expect(distance([0, 9, 9])).toBeCloseTo(0);
    });
});

describe('axisClipNormal', () => {
    it('returns unit axis normals', () => {
        expect(axisClipNormal('X')).toEqual([1, 0, 0]);
        expect(axisClipNormal('Y')).toEqual([0, 1, 0]);
        expect(axisClipNormal('Z')).toEqual([0, 0, 1]);
    });
});

describe('bounding-box helpers', () => {
    it('computes boxes from packed positions', () => {
        expect(boundingBoxFromPositions(new Float32Array([]))).toBeUndefined();
        expect(boundingBoxFromPositions(new Float32Array([-2, 0, 0, 2, 4, 6]))).toEqual(BOUNDS);
        expect(boundingBoxCenter(BOUNDS)).toEqual([0, 2, 3]);
        expect(boundingBoxSize(BOUNDS)).toEqual([4, 4, 6]);
        expect(boundingBoxCorners(BOUNDS)).toHaveLength(8);
    });
});

describe('describeClipPlanes', () => {
    it('reports off when every axis is disabled', () => {
        expect(describeClipPlanes(createClipPlanesState())).toBe('off');
    });

    it('lists enabled axes with percents', () => {
        expect(describeClipPlanes(createClipPlanesState({ X: { enabled: true, fraction: 0.5 } }))).toBe('X: 50%');
        expect(
            describeClipPlanes(
                createClipPlanesState({ X: { enabled: true, fraction: 0.25, invert: true }, Z: { enabled: true, fraction: 1 } })
            )
        ).toBe('X: 25% inverted + Z: 100%');
    });
});
