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
 * Tests for the viewer-core shading-mode state (no DOM, no three.js):
 * mode guard, opacity clamping, and per-mode material flag mapping.
 */

import { describe, expect, it } from 'vitest';
import {
    clampShadingBaseOpacity,
    DEFAULT_VIEWER_SHADING_MODE,
    FEATURE_EDGE_ANGLE_DEGREES,
    isViewerShadingMode,
    nextViewerShadingMode,
    resolveViewerShadingFlags,
    VIEWER_SHADING_MODES,
    XRAY_OPACITY_SCALE
} from './shading-mode';

describe('isViewerShadingMode', () => {
    it('accepts the six known modes', () => {
        expect(isViewerShadingMode('shaded')).toBe(true);
        expect(isViewerShadingMode('edges')).toBe(true);
        expect(isViewerShadingMode('feature-edges')).toBe(true);
        expect(isViewerShadingMode('wireframe')).toBe(true);
        expect(isViewerShadingMode('points')).toBe(true);
        expect(isViewerShadingMode('xray')).toBe(true);
    });

    it('rejects unknown values', () => {
        expect(isViewerShadingMode('Surface')).toBe(false);
        expect(isViewerShadingMode('feature')).toBe(false);
        expect(isViewerShadingMode('')).toBe(false);
        expect(isViewerShadingMode(undefined)).toBe(false);
        expect(isViewerShadingMode(42)).toBe(false);
    });

    it('lists every mode in the select metadata with the default first', () => {
        expect(VIEWER_SHADING_MODES.map((entry) => entry.id)).toEqual(['shaded', 'edges', 'feature-edges', 'wireframe', 'points', 'xray']);
        expect(VIEWER_SHADING_MODES.map((entry) => entry.label)).toEqual([
            'Shaded',
            'Shaded + Edges',
            'Feature Edges',
            'Wireframe',
            'Points',
            'X-Ray'
        ]);
        expect(DEFAULT_VIEWER_SHADING_MODE).toBe('shaded');
    });

    it('documents the feature-edge angle threshold in degrees', () => {
        expect(FEATURE_EDGE_ANGLE_DEGREES).toBe(30);
    });
});

describe('clampShadingBaseOpacity', () => {
    it('passes through in-range values', () => {
        expect(clampShadingBaseOpacity(1)).toBe(1);
        expect(clampShadingBaseOpacity(0.5)).toBe(0.5);
        expect(clampShadingBaseOpacity(0)).toBe(0);
    });

    it('clamps out-of-range values and treats non-finite as opaque', () => {
        expect(clampShadingBaseOpacity(1.5)).toBe(1);
        expect(clampShadingBaseOpacity(-0.2)).toBe(0);
        expect(clampShadingBaseOpacity(Number.NaN)).toBe(1);
        expect(clampShadingBaseOpacity(Number.POSITIVE_INFINITY)).toBe(1);
    });
});

describe('resolveViewerShadingFlags', () => {
    it('maps shaded to opaque solid flags', () => {
        expect(resolveViewerShadingFlags('shaded', 1)).toEqual({
            wireframe: false,
            pointsOnly: false,
            transparent: false,
            opacity: 1,
            depthWrite: true
        });
    });

    it('maps edges to the same flags as shaded (the overlay keys off the mode)', () => {
        expect(resolveViewerShadingFlags('edges', 1)).toEqual({
            wireframe: false,
            pointsOnly: false,
            transparent: false,
            opacity: 1,
            depthWrite: true
        });
        expect(resolveViewerShadingFlags('edges', 0.4).transparent).toBe(true);
    });

    it('maps feature-edges to the same opaque shaded flags (the overlay keys off the mode)', () => {
        expect(resolveViewerShadingFlags('feature-edges', 1)).toEqual(resolveViewerShadingFlags('shaded', 1));
        expect(resolveViewerShadingFlags('feature-edges', 0.4)).toEqual({
            wireframe: false,
            pointsOnly: false,
            transparent: true,
            opacity: 0.4,
            depthWrite: true
        });
    });

    it('maps wireframe to the wireframe flag only', () => {
        const flags = resolveViewerShadingFlags('wireframe', 1);
        expect(flags.wireframe).toBe(true);
        expect(flags.pointsOnly).toBe(false);
        expect(flags.opacity).toBe(1);
        expect(flags.depthWrite).toBe(true);
    });

    it('maps points to the points-only flag', () => {
        const flags = resolveViewerShadingFlags('points', 1);
        expect(flags.pointsOnly).toBe(true);
        expect(flags.wireframe).toBe(false);
        expect(flags.opacity).toBe(1);
    });

    it('maps xray to a scaled ghost opacity with no depth write', () => {
        const flags = resolveViewerShadingFlags('xray', 1);
        expect(flags).toEqual({
            wireframe: false,
            pointsOnly: false,
            transparent: true,
            opacity: XRAY_OPACITY_SCALE,
            depthWrite: false
        });
        expect(resolveViewerShadingFlags('xray', 0.5).opacity).toBeCloseTo(0.5 * XRAY_OPACITY_SCALE, 10);
    });

    it('keeps a translucent base opacity outside xray mode', () => {
        const flags = resolveViewerShadingFlags('shaded', 0.4);
        expect(flags.transparent).toBe(true);
        expect(flags.opacity).toBe(0.4);
        expect(flags.depthWrite).toBe(true);
    });
});

describe('nextViewerShadingMode', () => {
    it('cycles through the select order and wraps around', () => {
        expect(nextViewerShadingMode('shaded')).toBe('edges');
        expect(nextViewerShadingMode('edges')).toBe('feature-edges');
        expect(nextViewerShadingMode('feature-edges')).toBe('wireframe');
        expect(nextViewerShadingMode('wireframe')).toBe('points');
        expect(nextViewerShadingMode('points')).toBe('xray');
        expect(nextViewerShadingMode('xray')).toBe('shaded');
    });
});
