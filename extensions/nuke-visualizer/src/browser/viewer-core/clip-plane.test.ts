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
 * Tests for the arbitrary-normal clip-plane state (no DOM, no three.js):
 * normalization, three.js plane derivation, inversion, and bounding-box
 * fitting for origin sliders.
 */

import { describe, expect, it } from 'vitest';
import {
    boundingBoxCenter,
    boundingBoxCorners,
    boundingBoxFromPositions,
    boundingBoxSize,
    clipOriginAtFraction,
    clipPlaneDistance,
    clipProjectionExtent,
    createClipPlaneState,
    DEFAULT_CLIP_PLANE_STATE,
    describeClipPlane,
    fitClipOriginToBounds,
    invertClipPlane,
    isClipPlaneState,
    normalizeClipNormal,
    sanitizePoint,
    setClipNormal,
    setClipOrigin,
    toThreePlaneParams,
    updateClipPlane,
    vectorLength
} from './clip-plane';

describe('normalizeClipNormal', () => {
    it('normalizes non-unit vectors', () => {
        expect(normalizeClipNormal([2, 0, 0])).toEqual([1, 0, 0]);
        const diagonal = normalizeClipNormal([1, 1, 1]);
        expect(diagonal[0]).toBeCloseTo(1 / Math.sqrt(3));
        expect(vectorLength(diagonal)).toBeCloseTo(1);
    });

    it('falls back to +X for zero or non-finite input', () => {
        expect(normalizeClipNormal([0, 0, 0])).toEqual([1, 0, 0]);
        expect(normalizeClipNormal([NaN, 0, 0])).toEqual([1, 0, 0]);
        expect(normalizeClipNormal([1, Infinity, 0])).toEqual([1, 0, 0]);
    });
});

describe('createClipPlaneState / guards / updates', () => {
    it('defaults to +X through the origin', () => {
        expect(DEFAULT_CLIP_PLANE_STATE).toEqual({ normal: [1, 0, 0], origin: [0, 0, 0], invert: false });
        expect(createClipPlaneState()).toEqual(DEFAULT_CLIP_PLANE_STATE);
    });

    it('sanitizes patched normals and origins', () => {
        const state = createClipPlaneState({ normal: [0, 3, 4], origin: [1, 2, 3], invert: true });
        expect(state.normal).toEqual([0, 0.6, 0.8]);
        expect(state.origin).toEqual([1, 2, 3]);
        expect(state.invert).toBe(true);
    });

    it('validates unknown payloads', () => {
        expect(isClipPlaneState(createClipPlaneState())).toBe(true);
        expect(isClipPlaneState({ normal: [1, 0, 0], origin: [0, 0, 0], invert: false })).toBe(true);
        expect(isClipPlaneState(undefined)).toBe(false);
        expect(isClipPlaneState({ normal: [1, 0], origin: [0, 0, 0], invert: false })).toBe(false);
        expect(isClipPlaneState({ normal: [1, 0, NaN], origin: [0, 0, 0], invert: false })).toBe(false);
        expect(isClipPlaneState({ normal: [1, 0, 0], origin: [0, 0, 0], invert: 'no' })).toBe(false);
    });

    it('updates single fields immutably', () => {
        const state = createClipPlaneState();
        expect(setClipNormal(state, [0, 0, 5])).toEqual({ normal: [0, 0, 1], origin: [0, 0, 0], invert: false });
        expect(setClipOrigin(state, [1, 2, 3]).origin).toEqual([1, 2, 3]);
        expect(updateClipPlane(state, { invert: true }).invert).toBe(true);
        expect(state.invert).toBe(false);
    });

    it('sanitizes non-finite origin components', () => {
        expect(sanitizePoint([1, NaN, 3])).toEqual([1, 0, 3]);
    });
});

describe('toThreePlaneParams', () => {
    it('derives constant = -(n . o) with a unit normal', () => {
        const params = toThreePlaneParams(createClipPlaneState({ normal: [0, 0, 2], origin: [0, 0, 5] }));
        expect(params.normal).toEqual([0, 0, 1]);
        expect(params.constant).toBeCloseTo(-5);
    });

    it('negates the plane when inverted', () => {
        const plain = toThreePlaneParams(createClipPlaneState({ normal: [1, 0, 0], origin: [2, 0, 0] }));
        const inverted = toThreePlaneParams(createClipPlaneState({ normal: [1, 0, 0], origin: [2, 0, 0], invert: true }));
        expect(plain).toEqual({ normal: [1, 0, 0], constant: -2 });
        expect(inverted).toEqual({ normal: [-1, 0, 0], constant: 2 });
        expect(invertClipPlane(createClipPlaneState()).invert).toBe(true);
    });

    it('matches the three.js clipping convention (negative = clipped)', () => {
        const state = createClipPlaneState({ normal: [0, 0, 1], origin: [0, 0, 1] });
        expect(clipPlaneDistance(state, [0, 0, 2])).toBeCloseTo(1);
        expect(clipPlaneDistance(state, [0, 0, 0])).toBeCloseTo(-1);
        expect(clipPlaneDistance(state, [0, 0, 1])).toBeCloseTo(0);
    });
});

describe('bounding-box fitting', () => {
    const bounds = { min: [-2, 0, 0] as [number, number, number], max: [2, 4, 6] as [number, number, number] };

    it('computes boxes from packed positions', () => {
        expect(boundingBoxFromPositions(new Float32Array([]))).toBeUndefined();
        expect(boundingBoxFromPositions(new Float32Array([-2, 0, 0, 2, 4, 6]))).toEqual(bounds);
        expect(boundingBoxCenter(bounds)).toEqual([0, 2, 3]);
        expect(boundingBoxSize(bounds)).toEqual([4, 4, 6]);
        expect(boundingBoxCorners(bounds)).toHaveLength(8);
    });

    it('projects the box onto the normal for slider ranges', () => {
        expect(clipProjectionExtent(bounds, [1, 0, 0])).toEqual({ min: -2, max: 2 });
        expect(clipProjectionExtent(bounds, [0, 0, 1])).toEqual({ min: 0, max: 6 });
    });

    it('sweeps the origin across the dataset with a fraction', () => {
        expect(clipOriginAtFraction([1, 0, 0], bounds, 0)).toEqual([-2, 0, 0]);
        expect(clipOriginAtFraction([1, 0, 0], bounds, 1)).toEqual([2, 0, 0]);
        expect(clipOriginAtFraction([1, 0, 0], bounds, 0.5)).toEqual([0, 0, 0]);
        expect(clipOriginAtFraction([0, 0, 1], bounds, 0.5)).toEqual([0, 0, 3]);
        expect(clipOriginAtFraction([1, 0, 0], bounds, 99)).toEqual([2, 0, 0]);
    });

    it('fits the origin to the box center', () => {
        const fitted = fitClipOriginToBounds(createClipPlaneState({ normal: [0, 1, 0] }), bounds);
        expect(fitted.origin).toEqual([0, 2, 3]);
        expect(fitted.normal).toEqual([0, 1, 0]);
    });

    it('describes the state for status lines', () => {
        expect(describeClipPlane(createClipPlaneState())).toBe('n=(1.00, 0.00, 0.00) o=(0.00, 0.00, 0.00)');
        expect(describeClipPlane(createClipPlaneState({ invert: true }))).toContain('inverted');
    });
});
