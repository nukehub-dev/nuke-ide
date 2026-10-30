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
 * Tests for the pure bivariate (mean + relative error) mapping: relative
 * error guards, the linear quality weight, mask-color blending, per-channel
 * alpha, and hex parsing. No DOM, no three.js.
 */

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_BIVARIATE_OPTIONS,
    bivariateRgba,
    bivariateWeight,
    isUncertaintyChannel,
    normalizeMaxRelativeError,
    parseHexColor,
    relativeError
} from './bivariate-mapping';
import type { BivariateOptions } from './bivariate-mapping';

const MASK = [128 / 255, 64 / 255, 191 / 255] as const;
const MEAN_COLOR = [0.2, 0.6, 1] as const;

function options(overrides: Partial<BivariateOptions> = {}): BivariateOptions {
    return { ...DEFAULT_BIVARIATE_OPTIONS, lowQualityColor: '#8040BF', ...overrides };
}

describe('relativeError', () => {
    it('divides the standard deviation by the absolute mean', () => {
        expect(relativeError(10, 2)).toBeCloseTo(0.2);
        expect(relativeError(-10, 2)).toBeCloseTo(0.2);
        expect(relativeError(4, 0)).toBe(0);
    });

    it('treats an exact-zero bin as zero error (void bin convention)', () => {
        expect(relativeError(0, 0)).toBe(0);
        expect(relativeError(-0, 0)).toBe(0);
    });

    it('reports infinite relative error for a zero mean with spread', () => {
        expect(relativeError(0, 2)).toBe(Number.POSITIVE_INFINITY);
    });

    it('returns NaN for non-finite inputs and negative spreads', () => {
        expect(relativeError(Number.NaN, 1)).toBeNaN();
        expect(relativeError(1, Number.NaN)).toBeNaN();
        expect(relativeError(Number.POSITIVE_INFINITY, 1)).toBeNaN();
        expect(relativeError(1, Number.NEGATIVE_INFINITY)).toBeNaN();
        expect(relativeError(1, -0.5)).toBeNaN();
    });
});

describe('normalizeMaxRelativeError', () => {
    it('keeps positive finite thresholds and falls back otherwise', () => {
        expect(normalizeMaxRelativeError(0.25)).toBe(0.25);
        expect(normalizeMaxRelativeError(0)).toBe(DEFAULT_BIVARIATE_OPTIONS.maxRelativeError);
        expect(normalizeMaxRelativeError(-1)).toBe(DEFAULT_BIVARIATE_OPTIONS.maxRelativeError);
        expect(normalizeMaxRelativeError(Number.NaN)).toBe(DEFAULT_BIVARIATE_OPTIONS.maxRelativeError);
        expect(normalizeMaxRelativeError(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BIVARIATE_OPTIONS.maxRelativeError);
    });
});

describe('bivariateWeight', () => {
    it('is 1 at zero error, 0 at the threshold, and linear between', () => {
        const opts = options({ maxRelativeError: 0.1 });
        expect(bivariateWeight(0, opts)).toBe(1);
        expect(bivariateWeight(0.05, opts)).toBeCloseTo(0.5);
        expect(bivariateWeight(0.1, opts)).toBe(0);
        expect(bivariateWeight(0.5, opts)).toBe(0);
    });

    it('clamps negative errors to perfect and non-finite errors to masked', () => {
        const opts = options();
        expect(bivariateWeight(-0.2, opts)).toBe(1);
        expect(bivariateWeight(Number.NaN, opts)).toBe(0);
        expect(bivariateWeight(Number.POSITIVE_INFINITY, opts)).toBe(0);
    });

    it('falls back to the default threshold when the option is invalid', () => {
        expect(bivariateWeight(0.05, options({ maxRelativeError: 0 }))).toBeCloseTo(0.5);
        expect(bivariateWeight(0.05, options({ maxRelativeError: Number.NaN }))).toBeCloseTo(0.5);
    });
});

describe('isUncertaintyChannel', () => {
    it('accepts the three channels and rejects everything else', () => {
        expect(isUncertaintyChannel('opacity')).toBe(true);
        expect(isUncertaintyChannel('desaturate')).toBe(true);
        expect(isUncertaintyChannel('noise')).toBe(true);
        expect(isUncertaintyChannel('mean')).toBe(false);
        expect(isUncertaintyChannel(undefined)).toBe(false);
        expect(isUncertaintyChannel(1)).toBe(false);
    });
});

describe('parseHexColor', () => {
    it('parses 6- and 3-digit hex with an optional hash', () => {
        expect(parseHexColor('#8040BF')).toEqual([128 / 255, 64 / 255, 191 / 255]);
        expect(parseHexColor('8040bf')).toEqual([128 / 255, 64 / 255, 191 / 255]);
        expect(parseHexColor('#fff')).toEqual([1, 1, 1]);
        expect(parseHexColor('  #000  ')).toEqual([0, 0, 0]);
    });

    it('rejects everything that is not plain rgb hex', () => {
        expect(parseHexColor('red')).toBeUndefined();
        expect(parseHexColor('rgb(1,2,3)')).toBeUndefined();
        expect(parseHexColor('#12345')).toBeUndefined();
        expect(parseHexColor('#80ff')).toBeUndefined();
        expect(parseHexColor('')).toBeUndefined();
    });
});

describe('bivariateRgba', () => {
    it('returns the mask color at weight 0 and the mean color at weight 1', () => {
        for (const channel of ['opacity', 'desaturate', 'noise'] as const) {
            const mask = parseHexColor('#8040BF');
            const masked = bivariateRgba(MEAN_COLOR, 0, options({ channel }));
            expect(masked[0]).toBeCloseTo(mask![0]);
            expect(masked[1]).toBeCloseTo(mask![1]);
            expect(masked[2]).toBeCloseTo(mask![2]);
            const [r, g, b] = bivariateRgba(MEAN_COLOR, 1, options({ channel }));
            expect([r, g, b]).toEqual([...MEAN_COLOR]);
        }
    });

    it('blends linearly at the midpoint', () => {
        const [r, g, b] = bivariateRgba(MEAN_COLOR, 0.5, options({ channel: 'desaturate' }));
        expect(r).toBeCloseTo((MASK[0] + MEAN_COLOR[0]) / 2);
        expect(g).toBeCloseTo((MASK[1] + MEAN_COLOR[1]) / 2);
        expect(b).toBeCloseTo((MASK[2] + MEAN_COLOR[2]) / 2);
    });

    it('uses weight as alpha only for the opacity channel', () => {
        expect(bivariateRgba(MEAN_COLOR, 0, options({ channel: 'opacity' }))[3]).toBe(0);
        expect(bivariateRgba(MEAN_COLOR, 0.25, options({ channel: 'opacity' }))[3]).toBe(0.25);
        expect(bivariateRgba(MEAN_COLOR, 1, options({ channel: 'opacity' }))[3]).toBe(1);
        expect(bivariateRgba(MEAN_COLOR, 0.25, options({ channel: 'desaturate' }))[3]).toBe(1);
        expect(bivariateRgba(MEAN_COLOR, 0.25, options({ channel: 'noise' }))[3]).toBe(1);
    });

    it('masks non-finite weights and clamps out-of-range weights/colors', () => {
        expect(bivariateRgba(MEAN_COLOR, Number.NaN, options())[3]).toBe(0);
        expect(bivariateRgba(MEAN_COLOR, -2, options())[3]).toBe(0);
        const high = bivariateRgba(MEAN_COLOR, 4, options({ channel: 'desaturate' }));
        expect(high.slice(0, 3)).toEqual([...MEAN_COLOR]);
        const noisy = bivariateRgba([Number.NaN, 2, -1], 1, options({ channel: 'desaturate' }));
        expect(noisy.slice(0, 3)).toEqual([0, 1, 0]);
    });

    it('falls back to the default neutral gray for an invalid mask color', () => {
        const [r, g, b] = bivariateRgba(MEAN_COLOR, 0, options({ lowQualityColor: 'not-a-color' }));
        expect([r, g, b]).toEqual([128 / 255, 128 / 255, 128 / 255]);
    });

    it('ships usable defaults', () => {
        expect(DEFAULT_BIVARIATE_OPTIONS.channel).toBe('opacity');
        expect(DEFAULT_BIVARIATE_OPTIONS.maxRelativeError).toBeGreaterThan(0);
        expect(parseHexColor(DEFAULT_BIVARIATE_OPTIONS.lowQualityColor)).toBeDefined();
    });
});
