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
 * Tests for the pure axes-grid builder and label projector: nice-number
 * ticks, box edges, low-face grid lines, custom labels/titles, zero-size and
 * non-finite bounds, malformed options, and camera projection with overlap
 * resolution.
 */

import { describe, expect, it } from 'vitest';
import {
    buildAxesGrid,
    DEFAULT_AXES_GRID_TICKS,
    formatAxisTick,
    niceAxisTicks,
    projectAxisLabels,
    type AxisGridAxis,
    type AxisGridBounds,
    type AxisGridCamera,
    type AxisGridLabel,
    type AxisGridLabelKind,
    type AxisGridModel,
    type AxisGridProjector,
    type AxisGridVector
} from './axes-grid';

const BOX: AxisGridBounds = { min: [0, 0, 0], max: [10, 5, 1] };

/** Identity column-major 4x4 matrix (THREE.Matrix4 layout). */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface Segment {
    readonly a: AxisGridVector;
    readonly b: AxisGridVector;
}

/** Split the packed xyz pair buffer into segments. */
function segments(model: AxisGridModel): Segment[] {
    const result: Segment[] = [];
    for (let i = 0; i + 5 < model.lines.length; i += 6) {
        result.push({
            a: [model.lines[i], model.lines[i + 1], model.lines[i + 2]],
            b: [model.lines[i + 3], model.lines[i + 4], model.lines[i + 5]]
        });
    }
    return result;
}

function segmentLength(segment: Segment): number {
    const dx = segment.b[0] - segment.a[0];
    const dy = segment.b[1] - segment.a[1];
    const dz = segment.b[2] - segment.a[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function makeLabel(axis: AxisGridAxis, text: string, position: AxisGridVector, kind: AxisGridLabelKind = 'tick'): AxisGridLabel {
    return { axis, text, position, kind };
}

describe('niceAxisTicks', () => {
    it('rounds to 1/2/2.5/5/10 steps for the requested count', () => {
        expect(niceAxisTicks(0, 10, 5)).toEqual([0, 2.5, 5, 7.5, 10]);
        expect(niceAxisTicks(0, 10, 6)).toEqual([0, 2, 4, 6, 8, 10]);
        expect(niceAxisTicks(-10, 10, 5)).toEqual([-10, -5, 0, 5, 10]);
        expect(niceAxisTicks(0, 1, 6)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    });

    it('keeps only ticks inside the range when the bounds do not align to a step', () => {
        expect(niceAxisTicks(-5, 5, 6)).toEqual([-4, -2, 0, 2, 4]);
    });

    it('returns a single tick for a zero-size axis', () => {
        expect(niceAxisTicks(5, 5, 5)).toEqual([5]);
        expect(niceAxisTicks(-3.5, -3.5)).toEqual([-3.5]);
    });

    it('rejects non-finite input and clamps malformed counts', () => {
        expect(niceAxisTicks(Number.NaN, 1)).toEqual([]);
        expect(niceAxisTicks(0, Number.POSITIVE_INFINITY)).toEqual([]);
        expect(niceAxisTicks(0, 1, Number.NaN)).toEqual([0, 0.25, 0.5, 0.75, 1]);
        expect(niceAxisTicks(0, 1, 1)).toEqual([0, 1]);
        expect(niceAxisTicks(0, 1, 999).length).toBe(11);
    });
});

describe('formatAxisTick', () => {
    it('formats plain values with fixed precision and trims trailing zeros', () => {
        expect(formatAxisTick(2.5, 'plain', 1)).toBe('2.5');
        expect(formatAxisTick(2.25, 'plain', 1)).toBe('2.3');
        expect(formatAxisTick(3, 'plain', 3)).toBe('3');
        expect(formatAxisTick(1.23456, 'plain', 2)).toBe('1.23');
        expect(formatAxisTick(-0, 'plain', 2)).toBe('0');
    });

    it('formats scientific and engineering notation', () => {
        expect(formatAxisTick(10, 'scientific', 1)).toBe('1.0e+1');
        expect(formatAxisTick(1500, 'engineering', 1)).toBe('1.5e+3');
        expect(formatAxisTick(0.0015, 'engineering', 1)).toBe('1.5e-3');
        expect(formatAxisTick(0, 'scientific', 3)).toBe('0');
        expect(formatAxisTick(0, 'engineering', 3)).toBe('0');
    });

    it('renders non-finite values as an em dash', () => {
        expect(formatAxisTick(Number.NaN)).toBe('—');
        expect(formatAxisTick(Number.POSITIVE_INFINITY)).toBe('—');
    });
});

describe('buildAxesGrid', () => {
    it('draws the 12 box edges before the low-face grid lines', () => {
        const model = buildAxesGrid({ bounds: BOX, ticks: 6 });
        const all = segments(model);
        expect(all).toHaveLength(36);
        expect(model.lines).toBeInstanceOf(Float32Array);
        expect(model.lines.length).toBe(36 * 6);

        const edgeLengths = all
            .slice(0, 12)
            .map(segmentLength)
            .sort((a, b) => a - b);
        expect(edgeLengths).toEqual([1, 1, 1, 1, 5, 5, 5, 5, 10, 10, 10, 10]);

        const gridLines = all.slice(12);
        expect(gridLines).toHaveLength(24);
        for (const line of gridLines) {
            const changedAxes = [0, 1, 2].filter((index) => line.a[index] !== line.b[index]);
            expect(changedAxes).toHaveLength(1);
            const onLowFace = line.a.some((value, index) => value === BOX.min[index]);
            expect(onLowFace).toBe(true);
            for (let index = 0; index < 3; index++) {
                expect(line.a[index]).toBeGreaterThanOrEqual(BOX.min[index]);
                expect(line.a[index]).toBeLessThanOrEqual(BOX.max[index]);
                expect(line.b[index]).toBeGreaterThanOrEqual(BOX.min[index]);
                expect(line.b[index]).toBeLessThanOrEqual(BOX.max[index]);
            }
        }
    });

    it('anchors edges, grid lines, and tick labels to the actual bounds (not the origin)', () => {
        const bounds: AxisGridBounds = { min: [-5, -2, 10], max: [5, 3, 11] };
        const model = buildAxesGrid({ bounds, ticks: 5 });
        const gridLines = segments(model).slice(12);
        expect(gridLines.length).toBeGreaterThan(0);
        for (const line of gridLines) {
            const onLowFace = line.a.some((value, index) => value === bounds.min[index]);
            expect(onLowFace).toBe(true);
        }
        const firstXTick = model.labels.find((label) => label.axis === 'X' && label.kind === 'tick');
        expect(firstXTick?.position).toEqual([-5, -2, 10]);
        const firstYTick = model.labels.find((label) => label.axis === 'Y' && label.kind === 'tick');
        expect(firstYTick?.position).toEqual([-5, -2, 10]);
        const firstZTick = model.labels.find((label) => label.axis === 'Z' && label.kind === 'tick');
        expect(firstZTick?.position).toEqual([-5, -2, 10]);
    });

    it('emits nice tick positions and texts per axis', () => {
        const model = buildAxesGrid({ bounds: BOX, ticks: 6 });
        const ticksOf = (axis: AxisGridAxis) => model.ticks.filter((tick) => tick.axis === axis);
        expect(ticksOf('X').map((tick) => tick.value)).toEqual([0, 2, 4, 6, 8, 10]);
        expect(ticksOf('Y').map((tick) => tick.value)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(ticksOf('Z').map((tick) => tick.value)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
        expect(ticksOf('X').map((tick) => tick.text)).toEqual(['0', '2', '4', '6', '8', '10']);
        expect(ticksOf('Z').map((tick) => tick.text)).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1']);

        const tickLabels = model.labels.filter((label) => label.kind === 'tick');
        expect(tickLabels).toHaveLength(model.ticks.length);
        for (const tick of model.ticks) {
            const label = tickLabels.find((candidate) => candidate.axis === tick.axis && candidate.text === tick.text);
            expect(label).toBeDefined();
        }
        expect(tickLabels.find((label) => label.axis === 'X' && label.text === '4')?.position).toEqual([4, 0, 0]);
        expect(tickLabels.find((label) => label.axis === 'Y' && label.text === '2')?.position).toEqual([0, 2, 0]);
        expect(tickLabels.find((label) => label.axis === 'Z' && label.text === '0.6')?.position).toEqual([0, 0, 0.6]);
    });

    it('places titles mid-edge on the far corner, separate from endpoint ticks', () => {
        const model = buildAxesGrid({ bounds: BOX, ticks: 6 });
        const titles = model.labels.filter((label) => label.kind === 'title');
        expect(titles.map((label) => [label.axis, label.text, label.position])).toEqual([
            ['X', 'X', [5, 5, 1]],
            ['Y', 'Y', [10, 2.5, 1]],
            ['Z', 'Z', [10, 5, 0.5]]
        ]);
    });

    it('applies custom titles and suppresses empty ones', () => {
        const model = buildAxesGrid({ bounds: BOX, titles: { X: ' Length ', Y: '', Z: 'Depth' } });
        const titles = model.labels.filter((label) => label.kind === 'title');
        expect(titles.map((label) => [label.axis, label.text])).toEqual([
            ['X', 'Length'],
            ['Z', 'Depth']
        ]);
    });

    it('maps custom labels index-for-index without moving tick positions', () => {
        const model = buildAxesGrid({
            bounds: BOX,
            ticks: { X: 3 },
            customLabels: { X: ['first', '   ', 12.5, 'ignored'] }
        });
        const xTicks = model.labels.filter((label) => label.axis === 'X' && label.kind === 'tick');
        expect(xTicks.map((label) => label.text)).toEqual(['first', '5', '12.5']);
        expect(xTicks.map((label) => label.position)).toEqual([
            [0, 0, 0],
            [5, 0, 0],
            [10, 0, 0]
        ]);
    });

    it('formats tick text with the requested notation and precision', () => {
        const model = buildAxesGrid({ bounds: { min: [0, 0, 0], max: [1, 1, 1] }, ticks: 3, notation: 'scientific', precision: 1 });
        expect(model.ticks.map((tick) => tick.text)).toEqual(['0', '5.0e-1', '1.0e+0', '0', '5.0e-1', '1.0e+0', '0', '5.0e-1', '1.0e+0']);
    });

    it('handles zero-size axes without degenerate segments', () => {
        const model = buildAxesGrid({ bounds: { min: [0, 0, 3], max: [2, 2, 3] }, ticks: 4 });
        const all = segments(model);
        expect(all.length).toBeGreaterThan(0);
        for (const line of all) {
            expect(segmentLength(line)).toBeGreaterThan(0);
        }
        expect(model.ticks.filter((tick) => tick.axis === 'Z')).toEqual([{ axis: 'Z', value: 3, text: '3' }]);
        expect(all).toHaveLength(6);
    });

    it('keeps labels for a fully collapsed (point) box but emits no lines', () => {
        const model = buildAxesGrid({ bounds: { min: [1, 2, 3], max: [1, 2, 3] } });
        expect(model.lines.length).toBe(0);
        expect(model.ticks).toHaveLength(3);
        expect(model.labels).toHaveLength(6);
        for (const label of model.labels) {
            expect(label.position).toEqual([1, 2, 3]);
        }
    });

    it('returns an empty model for missing or non-finite bounds', () => {
        const malformed: unknown[] = [
            undefined,
            null,
            { min: [Number.NaN, 0, 0], max: [1, 1, 1] },
            { min: [0, 0], max: [1, 1, 1] },
            { min: [0, 0, 0], max: [Number.POSITIVE_INFINITY, 1, 1] },
            { min: 'nope', max: [1, 1, 1] }
        ];
        for (const bounds of malformed) {
            const model = buildAxesGrid({ bounds: bounds as AxisGridBounds });
            expect(model.lines.length).toBe(0);
            expect(model.labels).toEqual([]);
            expect(model.ticks).toEqual([]);
        }
        expect(buildAxesGrid().lines.length).toBe(0);
    });

    it('sanitizes malformed options instead of throwing', () => {
        const model = buildAxesGrid({
            bounds: BOX,
            ticks: { X: -4, Y: 999, Z: Number.NaN } as unknown as number,
            notation: 'bogus' as never,
            precision: 99,
            titles: { X: 7 } as unknown as Record<AxisGridAxis, string>,
            customLabels: { X: 'nope' } as unknown as Record<AxisGridAxis, readonly string[]>
        });
        expect(model.lines.length).toBeGreaterThan(0);
        for (const value of model.lines) {
            expect(Number.isFinite(value)).toBe(true);
        }
        for (const label of model.labels) {
            expect(label.position.every((value) => Number.isFinite(value))).toBe(true);
        }
        expect(model.labels.find((label) => label.kind === 'title' && label.axis === 'X')?.text).toBe('X');
        expect(model.ticks.filter((tick) => tick.axis === 'X').length).toBe(2);
    });
});

describe('projectAxisLabels', () => {
    it('projects explicit view/projection matrices into CSS pixels', () => {
        const model = {
            labels: [
                makeLabel('X', 'center', [0, 0, -0.5]),
                makeLabel('Y', 'offset', [0.5, 0.5, -0.5]),
                makeLabel('Z', 'behind', [0, 0, 0.5]),
                makeLabel('Z', 'edge', [0.5, -0.5, -0.5])
            ]
        };
        const camera: AxisGridCamera = { position: [0, 0, 0], viewMatrix: IDENTITY, projectionMatrix: IDENTITY };
        const projected = projectAxisLabels(model, camera, { width: 800, height: 600 }, { minDistance: 0 });
        expect(projected.map(({ text, x, y, depth }) => ({ text, x, y, depth }))).toEqual([
            { text: 'center', x: 400, y: 300, depth: 0.5 },
            { text: 'offset', x: 600, y: 150, depth: 0.5 },
            { text: 'edge', x: 600, y: 450, depth: 0.5 }
        ]);
    });

    it('builds a fallback perspective camera from position/quaternion/fov', () => {
        const model = {
            labels: [
                makeLabel('X', 'center', [0, 0, 0]),
                makeLabel('Y', 'right', [10, 0, 0]),
                makeLabel('Z', 'up', [0, 10, 0]),
                makeLabel('Z', 'behind', [0, 0, 11])
            ]
        };
        const camera: AxisGridCamera = { position: [0, 0, 10], quaternion: [0, 0, 0, 1], fov: 90, aspect: 1 };
        const projected = projectAxisLabels(model, camera, { width: 100, height: 100 }, { minDistance: 0 });
        expect(projected.map((label) => label.text)).toEqual(['center', 'right', 'up']);
        expect(projected.map((label) => label.depth)).toEqual([10, 10, 10]);
        expect(projected[0].x).toBeCloseTo(50, 9);
        expect(projected[0].y).toBeCloseTo(50, 9);
        expect(projected[1].x).toBeCloseTo(100, 9);
        expect(projected[1].y).toBeCloseTo(50, 9);
        expect(projected[2].x).toBeCloseTo(50, 9);
        expect(projected[2].y).toBeCloseTo(0, 9);
    });

    it('applies camera quaternion rotation and hides points behind the camera', () => {
        const model = {
            labels: [makeLabel('X', 'front', [0, 10, 0]), makeLabel('Y', 'behind', [0, -10, 0]), makeLabel('Z', 'side', [10, 0, 0])]
        };
        const camera: AxisGridCamera = {
            position: [0, 0, 0],
            quaternion: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
            fov: 90,
            aspect: 1
        };
        const projected = projectAxisLabels(model, camera, { width: 100, height: 100 }, { minDistance: 0 });
        expect(projected.map((label) => label.text)).toEqual(['front']);
        expect(projected[0].x).toBeCloseTo(50, 9);
        expect(projected[0].y).toBeCloseTo(50, 9);
    });

    it('sorts nearest-first and drops labels closer than the minimum distance', () => {
        const model = {
            labels: [makeLabel('X', 'near', [1, 0, 0]), makeLabel('Y', 'far', [5, 0, 0]), makeLabel('Z', 'apart', [9, 0, 0])]
        };
        const projector: AxisGridProjector = (position) => ({
            x: position[0] === 9 ? 300 : 100,
            y: 100,
            depth: position[0]
        });
        expect(projectAxisLabels(model, projector, { width: 400, height: 400 }).map((label) => label.text)).toEqual(['near', 'apart']);
        expect(projectAxisLabels(model, projector, { width: 400, height: 400 }, { minDistance: 0 }).map((label) => label.text)).toEqual([
            'near',
            'far',
            'apart'
        ]);
    });

    it('uses view depth for overlap resolution with a real camera', () => {
        const model = { labels: [makeLabel('X', 'far', [0, 0, -0.8]), makeLabel('Y', 'near', [0, 0, -0.2])] };
        const camera: AxisGridCamera = { position: [0, 0, 0], viewMatrix: IDENTITY, projectionMatrix: IDENTITY };
        const projected = projectAxisLabels(model, camera, { width: 100, height: 100 }, { minDistance: 20 });
        expect(projected.map((label) => label.text)).toEqual(['near']);
        expect(projected[0].depth).toBeCloseTo(0.2, 6);
    });

    it('skips hidden projectors, non-finite results, and malformed label positions', () => {
        const model = {
            labels: [
                makeLabel('X', 'missing', [1, 0, 0]),
                makeLabel('Y', 'hidden', [2, 0, 0]),
                makeLabel('Z', 'nan', [3, 0, 0]),
                makeLabel('X', 'bad-position', [Number.NaN, 0, 0])
            ]
        };
        const projector: AxisGridProjector = (position) => {
            if (position[0] === 1) {
                return undefined;
            }
            if (position[0] === 2) {
                return { x: 0, y: 0, visible: false };
            }
            return { x: Number.NaN, y: 0 };
        };
        expect(projectAxisLabels(model, projector, { width: 100, height: 100 })).toEqual([]);
    });

    it('returns an empty array for unusable models, viewports, and cameras', () => {
        const model = { labels: [makeLabel('X', 'label', [0, 0, -1])] };
        const camera: AxisGridCamera = { position: [0, 0, 0], viewMatrix: IDENTITY, projectionMatrix: IDENTITY };
        expect(projectAxisLabels({ labels: [] }, camera, { width: 100, height: 100 })).toEqual([]);
        expect(projectAxisLabels(model, camera, { width: 0, height: 100 })).toEqual([]);
        expect(projectAxisLabels(model, camera, { width: 100, height: Number.NaN })).toEqual([]);
        expect(projectAxisLabels(model, {} as AxisGridCamera, { width: 100, height: 100 })).toEqual([]);
    });

    it('keeps the model label kind and original world anchor', () => {
        const model = { labels: [makeLabel('X', 'Length', [1, 0, 0], 'title')] };
        const projector: AxisGridProjector = () => ({ x: 10, y: 20 });
        const projected = projectAxisLabels(model, projector, { width: 100, height: 100 });
        expect(projected).toEqual([{ axis: 'X', text: 'Length', kind: 'title', position: [1, 0, 0], x: 10, y: 20, depth: 0 }]);
    });
});

describe('defaults', () => {
    it('exposes the documented default tick count', () => {
        expect(DEFAULT_AXES_GRID_TICKS).toBe(5);
        const model = buildAxesGrid({ bounds: BOX });
        const xTicks = model.ticks.filter((tick) => tick.axis === 'X');
        expect(xTicks.map((tick) => tick.value)).toEqual([0, 2.5, 5, 7.5, 10]);
    });
});
