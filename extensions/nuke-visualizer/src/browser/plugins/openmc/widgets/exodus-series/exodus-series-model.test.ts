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

import { describe, expect, it } from 'vitest';
import {
    arrayRange,
    clampStepIndex,
    colorByOptions,
    ExodusSeriesModelError,
    ExodusSeriesPayload,
    formatStepLabel,
    hasColorByArray,
    nextStepIndex,
    parseExodusSeries,
    previousStepIndex,
    stepAt,
    stepCount,
    stepPositions,
    stepTime,
    stepValueRange,
    stepValueSamples
} from './exodus-series-model';

function makeSeries(): ExodusSeriesPayload {
    return {
        sourceFile: '/tmp/series.e',
        nSteps: 3,
        arrays: [
            { name: 'temperature', location: 'node', range: [300, 900] },
            { name: 'stress', location: 'cell', range: [1, 6] },
            { name: 'keff', location: 'global', range: [0.999, 1.001] }
        ],
        steps: [
            {
                index: 0,
                time: 0,
                mesh: {
                    nNodes: 2,
                    nElements: 1,
                    nodes: [
                        [0, 0, 0],
                        [1, 0, 0]
                    ],
                    blocks: [{ name: 'block_1', count: 1 }]
                },
                values: {
                    temperature: { min: 300, max: 300, mean: 300, count: 2, samples: [300, 300] },
                    stress: { min: 1, max: 2, mean: 1.5, count: 1, samples: [1.5] }
                }
            },
            {
                index: 1,
                time: 1,
                mesh: {
                    nNodes: 2,
                    nElements: 1,
                    nodes: [
                        [0, 0, 0],
                        [1, 0, 0]
                    ],
                    blocks: [{ name: 'block_1', count: 1 }]
                },
                values: {
                    temperature: { min: 400, max: 430, mean: 415, count: 2, samples: [400, 430] },
                    stress: { min: 3, max: 4, mean: 3.5, count: 1, samples: [3.5] }
                }
            },
            {
                index: 2,
                time: 2.5,
                mesh: {
                    nNodes: 2,
                    nElements: 1,
                    nodes: [
                        [0, 0, 0],
                        [1, 0, 0]
                    ],
                    blocks: [{ name: 'block_1', count: 1 }]
                },
                values: {
                    temperature: { min: 800, max: 900, mean: 850, count: 2, samples: [800, 900] },
                    stress: { min: 5, max: 6, mean: 5.5, count: 1, samples: [5.5] }
                }
            }
        ]
    };
}

describe('parseExodusSeries', () => {
    it('accepts a valid payload with extra fields', () => {
        const parsed = parseExodusSeries({ ...makeSeries(), future: true });
        expect(parsed.nSteps).toBe(3);
        expect(parsed.arrays).toHaveLength(3);
    });

    it('rejects step-count mismatch', () => {
        const series = makeSeries();
        expect(() => parseExodusSeries({ ...series, nSteps: 2 })).toThrow(ExodusSeriesModelError);
    });

    it('rejects mistyped fields', () => {
        expect(() => parseExodusSeries(undefined)).toThrow(ExodusSeriesModelError);
        expect(() => parseExodusSeries({ ...makeSeries(), arrays: {} })).toThrow(ExodusSeriesModelError);
        expect(() => parseExodusSeries({ ...makeSeries(), steps: 'nope' })).toThrow(ExodusSeriesModelError);
        expect(() => parseExodusSeries({ ...makeSeries(), nSteps: -1 })).toThrow(ExodusSeriesModelError);
    });

    it('rejects bad array locations and ranges', () => {
        const series = makeSeries();
        const badLocation = { ...series, arrays: [{ name: 'x', location: 'side', range: [0, 1] }] };
        expect(() => parseExodusSeries(badLocation)).toThrow(ExodusSeriesModelError);
        const badRange = { ...series, arrays: [{ name: 'x', location: 'node', range: [0, NaN] }] };
        expect(() => parseExodusSeries(badRange)).toThrow(ExodusSeriesModelError);
    });
});

describe('step/index math', () => {
    it('clamps indices into range', () => {
        expect(clampStepIndex(1, 3)).toBe(1);
        expect(clampStepIndex(-4, 3)).toBe(0);
        expect(clampStepIndex(99, 3)).toBe(2);
        expect(clampStepIndex(1.9, 3)).toBe(1);
        expect(clampStepIndex(NaN, 3)).toBe(0);
        expect(clampStepIndex(0, 0)).toBe(0);
    });

    it('reads steps and times through the clamp', () => {
        const series = makeSeries();
        expect(stepCount(series)).toBe(3);
        expect(stepAt(series, 9)?.index).toBe(2);
        expect(stepTime(series, 2)).toBe(2.5);
        expect(stepAt({ ...series, steps: [], nSteps: 0 }, 0)).toBeUndefined();
    });

    it('steps forward and back with clamp and wrap', () => {
        expect(nextStepIndex(1, 3)).toBe(2);
        expect(nextStepIndex(2, 3)).toBe(2);
        expect(nextStepIndex(2, 3, true)).toBe(0);
        expect(previousStepIndex(1, 3)).toBe(0);
        expect(previousStepIndex(0, 3)).toBe(0);
        expect(previousStepIndex(0, 3, true)).toBe(2);
        expect(nextStepIndex(0, 0)).toBe(0);
    });
});

describe('range computation', () => {
    it('reads global and per-step ranges', () => {
        const series = makeSeries();
        expect(arrayRange(series, 'temperature')).toEqual([300, 900]);
        expect(arrayRange(series, 'missing')).toBeUndefined();
        expect(stepValueRange(series, 1, 'stress')).toEqual([3, 4]);
        expect(stepValueRange(series, 9, 'stress')).toEqual([5, 6]);
        expect(stepValueRange(series, 0, 'missing')).toBeUndefined();
    });

    it('reads decimated samples', () => {
        const series = makeSeries();
        expect(stepValueSamples(series, 2, 'temperature')).toEqual([800, 900]);
        expect(stepValueSamples(series, 0, 'missing')).toEqual([]);
    });
});

describe('color-by options', () => {
    it('maps node/cell arrays and skips globals', () => {
        expect(colorByOptions(makeSeries())).toEqual(['Solid Color', 'Point: temperature', 'Cell: stress']);
    });

    it('validates color-by values against the series', () => {
        const series = makeSeries();
        expect(hasColorByArray(series, 'Solid Color')).toBe(true);
        expect(hasColorByArray(series, 'Point: temperature')).toBe(true);
        expect(hasColorByArray(series, 'Cell: temperature')).toBe(false);
        expect(hasColorByArray(series, 'Cell: stress')).toBe(true);
        expect(hasColorByArray(series, 'Point: keff')).toBe(false);
        expect(hasColorByArray(series, 'bogus')).toBe(false);
    });
});

describe('slider presentation', () => {
    it('formats step labels', () => {
        const series = makeSeries();
        expect(formatStepLabel(series, 0)).toBe('Step 1 of 3 · t=0');
        expect(formatStepLabel(series, 99)).toBe('Step 3 of 3 · t=2.5');
        expect(formatStepLabel({ ...series, steps: [], nSteps: 0 }, 0)).toBe('No steps');
    });

    it('flattens step positions for scene buffers', () => {
        const positions = stepPositions(makeSeries(), 1);
        expect(Array.from(positions)).toEqual([0, 0, 0, 1, 0, 0]);
        expect(stepPositions({ ...makeSeries(), steps: [], nSteps: 0 }, 0)).toHaveLength(0);
    });
});
