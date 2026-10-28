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
 * Tests for the pure generic-probe model (no DOM, no three.js): hit-to-tuple
 * mapping for every render kind, decimation stride and nearest-corner logic,
 * malformed-input safety, array sampling (component/magnitude), CSV export,
 * value/point formatting, sample-count clamping, and default endpoints.
 */

import { describe, expect, it } from 'vitest';
import {
    clampProbeSamples,
    defaultProbeEndpoints,
    formatProbePoint,
    formatProbeValue,
    parseProbePoint,
    probeLineToCsv,
    probeSamplesToCsv,
    resolveProbeTuple,
    sampleProbeValue,
    type ProbeArray,
    type ProbeHit,
    type ProbeLineResult,
    type ProbeSample,
    type ProbeTopology
} from './probe-model';

/** Mesh topology: two triangles over four points, one cell per triangle. */
const MESH: ProbeTopology = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]),
    nPoints: 4,
    stride: 1,
    triangles: new Uint32Array([0, 1, 2, 1, 3, 2]),
    triangleCells: new Uint32Array([10, 11])
};

/** Line topology: three segments over four points, one cell per segment. */
const LINES: ProbeTopology = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
    nPoints: 4,
    stride: 1,
    segments: new Uint32Array([0, 1, 1, 2, 2, 3]),
    segmentCells: new Uint32Array([7, 8, 9])
};

function meshHit(position: readonly [number, number, number], faceIndex: number): ProbeHit {
    return { kind: 'mesh', position, faceIndex };
}

function hit(kind: ProbeHit['kind'], extra: Partial<ProbeHit>): ProbeHit {
    return { kind, position: [0, 0, 0], ...extra };
}

function scalar(values: number[], components = 1): ProbeArray {
    return { association: 'cell', name: 'flux', components, values: new Float64Array(values) };
}

describe('resolveProbeTuple — mesh', () => {
    it('maps cell hits through triangleCells[faceIndex]', () => {
        expect(resolveProbeTuple(MESH, meshHit([0.2, 0.1, 0], 0), 'cell')).toBe(10);
        expect(resolveProbeTuple(MESH, meshHit([4.9, 4.8, 5], 1), 'cell')).toBe(11);
    });

    it('maps point hits to the nearest triangle corner', () => {
        expect(resolveProbeTuple(MESH, meshHit([0.1, 0.1, 0], 0), 'point')).toBe(0);
        expect(resolveProbeTuple(MESH, meshHit([0.9, 0.2, 0], 0), 'point')).toBe(1);
        expect(resolveProbeTuple(MESH, meshHit([0.1, 0.9, 0], 0), 'point')).toBe(2);
        expect(resolveProbeTuple(MESH, meshHit([4.9, 4.9, 5], 1), 'point')).toBe(3);
    });

    it('keeps the first corner on an exact tie', () => {
        expect(resolveProbeTuple(MESH, meshHit([0.5, 0, 0], 0), 'point')).toBe(0);
    });

    it('rejects missing triangles and out-of-range face indices', () => {
        const noTriangles: ProbeTopology = { ...MESH, triangles: undefined };
        expect(resolveProbeTuple(noTriangles, meshHit([0, 0, 0], 0), 'point')).toBeUndefined();
        expect(resolveProbeTuple(noTriangles, meshHit([0, 0, 0], 0), 'cell')).toBe(10);
        expect(resolveProbeTuple(MESH, meshHit([0, 0, 0], 2), 'point')).toBeUndefined();
        expect(resolveProbeTuple(MESH, meshHit([0, 0, 0], 2), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(MESH, meshHit([0, 0, 0], -1), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(MESH, meshHit([0, 0, 0], Number.NaN), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(MESH, meshHit([0, 0, 0], 1.5), 'cell')).toBeUndefined();
    });

    it('rejects non-finite hit positions and short position buffers', () => {
        expect(resolveProbeTuple(MESH, meshHit([Number.NaN, 0, 0], 0), 'point')).toBeUndefined();
        expect(resolveProbeTuple(MESH, meshHit([0, Number.POSITIVE_INFINITY, 0], 0), 'point')).toBeUndefined();
        const shortPositions: ProbeTopology = { ...MESH, positions: new Float32Array(0) };
        expect(resolveProbeTuple(shortPositions, meshHit([0, 0, 0], 0), 'point')).toBeUndefined();
    });
});

describe('resolveProbeTuple — mesh points', () => {
    it('maps a corner in the triangle soup to its source point', () => {
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 0 }), 'point')).toBe(0);
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 2 }), 'point')).toBe(2);
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 3 }), 'point')).toBe(1);
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 5 }), 'point')).toBe(2);
    });

    it('maps corners to cells with floor(pointIndex / 3)', () => {
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 0 }), 'cell')).toBe(10);
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 2 }), 'cell')).toBe(10);
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 3 }), 'cell')).toBe(11);
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 6 }), 'cell')).toBeUndefined();
    });

    it('rejects missing and malformed corner indices', () => {
        expect(resolveProbeTuple(MESH, hit('mesh-points', {}), 'point')).toBeUndefined();
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: -1 }), 'point')).toBeUndefined();
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 1.5 }), 'point')).toBeUndefined();
        expect(resolveProbeTuple(MESH, hit('mesh-points', { pointIndex: 6 }), 'point')).toBeUndefined();
        const noTriangles: ProbeTopology = { ...MESH, triangles: undefined };
        expect(resolveProbeTuple(noTriangles, hit('mesh-points', { pointIndex: 0 }), 'point')).toBeUndefined();
    });
});

describe('resolveProbeTuple — lines', () => {
    it('maps both line hit kinds through segments/segmentCells', () => {
        for (const kind of ['lines', 'line-points'] as const) {
            expect(resolveProbeTuple(LINES, hit(kind, { pointIndex: 0 }), 'point')).toBe(0);
            expect(resolveProbeTuple(LINES, hit(kind, { pointIndex: 3 }), 'point')).toBe(2);
            expect(resolveProbeTuple(LINES, hit(kind, { pointIndex: 5 }), 'point')).toBe(3);
            expect(resolveProbeTuple(LINES, hit(kind, { pointIndex: 0 }), 'cell')).toBe(7);
            expect(resolveProbeTuple(LINES, hit(kind, { pointIndex: 2 }), 'cell')).toBe(8);
            expect(resolveProbeTuple(LINES, hit(kind, { pointIndex: 5 }), 'cell')).toBe(9);
        }
    });

    it('rejects out-of-range endpoints and missing cell maps', () => {
        expect(resolveProbeTuple(LINES, hit('line-points', { pointIndex: 6 }), 'point')).toBeUndefined();
        expect(resolveProbeTuple(LINES, hit('line-points', { pointIndex: 6 }), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(LINES, hit('line-points', { pointIndex: -2 }), 'cell')).toBeUndefined();
        const noCells: ProbeTopology = { ...LINES, segmentCells: undefined };
        expect(resolveProbeTuple(noCells, hit('line-points', { pointIndex: 4 }), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(noCells, hit('line-points', { pointIndex: 4 }), 'point')).toBe(2);
    });
});

describe('resolveProbeTuple — voxel', () => {
    const VOXEL: ProbeTopology = {
        positions: new Float32Array(9),
        nPoints: 3,
        stride: 1,
        voxelCells: new Uint32Array([4, 5, 6])
    };

    it('maps instance ids to the same cell tuple for both associations', () => {
        expect(resolveProbeTuple(VOXEL, hit('voxel', { instanceId: 0 }), 'cell')).toBe(4);
        expect(resolveProbeTuple(VOXEL, hit('voxel', { instanceId: 0 }), 'point')).toBe(4);
        expect(resolveProbeTuple(VOXEL, hit('voxel', { instanceId: 2 }), 'point')).toBe(6);
    });

    it('rejects missing and out-of-range instance ids', () => {
        expect(resolveProbeTuple(VOXEL, hit('voxel', { instanceId: 3 }), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(VOXEL, hit('voxel', { instanceId: -1 }), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(VOXEL, hit('voxel', { instanceId: Number.NaN }), 'cell')).toBeUndefined();
        const noCells: ProbeTopology = { ...VOXEL, voxelCells: undefined };
        expect(resolveProbeTuple(noCells, hit('voxel', { instanceId: 0 }), 'cell')).toBeUndefined();
    });
});

describe('resolveProbeTuple — point clouds and grids', () => {
    const CLOUD: ProbeTopology = {
        positions: new Float32Array(27),
        nPoints: 9,
        stride: 2
    };

    it('applies the decimation stride for points (point association only)', () => {
        expect(resolveProbeTuple(CLOUD, hit('points', { pointIndex: 0 }), 'point')).toBe(0);
        expect(resolveProbeTuple(CLOUD, hit('points', { pointIndex: 3 }), 'point')).toBe(6);
        expect(resolveProbeTuple(CLOUD, hit('points', { pointIndex: 4 }), 'point')).toBe(8);
        expect(resolveProbeTuple(CLOUD, hit('points', { pointIndex: 5 }), 'point')).toBeUndefined();
        expect(resolveProbeTuple(CLOUD, hit('points', { pointIndex: 3 }), 'cell')).toBeUndefined();
    });

    it('applies the stride for both associations on grid previews', () => {
        expect(resolveProbeTuple(CLOUD, hit('grid-points', { pointIndex: 0 }), 'point')).toBe(0);
        expect(resolveProbeTuple(CLOUD, hit('grid-points', { pointIndex: 2 }), 'cell')).toBe(4);
        expect(resolveProbeTuple(CLOUD, hit('grid-points', { pointIndex: 4 }), 'cell')).toBe(8);
        expect(resolveProbeTuple(CLOUD, hit('grid-points', { pointIndex: 5 }), 'point')).toBeUndefined();
    });

    it('treats undecimated clouds and malformed strides as stride 1', () => {
        const undecimated: ProbeTopology = { ...CLOUD, stride: 1 };
        expect(resolveProbeTuple(undecimated, hit('points', { pointIndex: 3 }), 'point')).toBe(3);
        const badStride: ProbeTopology = { ...CLOUD, stride: Number.NaN };
        expect(resolveProbeTuple(badStride, hit('points', { pointIndex: 3 }), 'point')).toBe(3);
        const zeroStride: ProbeTopology = { ...CLOUD, stride: 0 };
        expect(resolveProbeTuple(zeroStride, hit('points', { pointIndex: 3 }), 'point')).toBe(3);
    });

    it('rejects missing/non-finite indices and unusable counts', () => {
        expect(resolveProbeTuple(CLOUD, hit('grid-points', {}), 'point')).toBeUndefined();
        expect(resolveProbeTuple(CLOUD, hit('grid-points', { pointIndex: Number.NaN }), 'cell')).toBeUndefined();
        expect(resolveProbeTuple(CLOUD, hit('grid-points', { pointIndex: 1.5 }), 'cell')).toBeUndefined();
        const empty: ProbeTopology = { ...CLOUD, nPoints: 0 };
        expect(resolveProbeTuple(empty, hit('points', { pointIndex: 0 }), 'point')).toBeUndefined();
        const malformed: ProbeTopology = { ...CLOUD, nPoints: Number.NaN };
        expect(resolveProbeTuple(malformed, hit('grid-points', { pointIndex: 0 }), 'cell')).toBeUndefined();
    });
});

describe('resolveProbeTuple — defensive safety', () => {
    it('returns undefined for missing topology/hit and unknown hit kinds', () => {
        expect(resolveProbeTuple(undefined as unknown as ProbeTopology, meshHit([0, 0, 0], 0), 'point')).toBeUndefined();
        expect(resolveProbeTuple(MESH, undefined as unknown as ProbeHit, 'point')).toBeUndefined();
        expect(resolveProbeTuple(MESH, { kind: 'bogus' } as unknown as ProbeHit, 'point')).toBeUndefined();
    });

    it('never throws and never mutates the topology', () => {
        const before = {
            positions: Array.from(MESH.positions),
            triangles: Array.from(MESH.triangles ?? []),
            triangleCells: Array.from(MESH.triangleCells ?? [])
        };
        const sample = meshHit([0.1, 0.1, 0], 0);
        expect(() => resolveProbeTuple(MESH, sample, 'point')).not.toThrow();
        expect(Array.from(MESH.positions)).toEqual(before.positions);
        expect(Array.from(MESH.triangles ?? [])).toEqual(before.triangles);
        expect(Array.from(MESH.triangleCells ?? [])).toEqual(before.triangleCells);
    });
});

describe('sampleProbeValue', () => {
    it('reads scalar tuples and rejects out-of-range tuples', () => {
        const array = scalar([10, -2.5]);
        expect(sampleProbeValue(array, 0)).toBe(10);
        expect(sampleProbeValue(array, 1)).toBe(-2.5);
        expect(sampleProbeValue(array, 2)).toBeUndefined();
        expect(sampleProbeValue(array, -1)).toBeUndefined();
        expect(sampleProbeValue(array, 0.5)).toBeUndefined();
        expect(sampleProbeValue(array, Number.NaN)).toBeUndefined();
    });

    it('selects one component of a multi-component tuple', () => {
        const array = scalar([1, 2, 3, 4, 5, 6], 3);
        expect(sampleProbeValue(array, 0, 0)).toBe(1);
        expect(sampleProbeValue(array, 0, 2)).toBe(3);
        expect(sampleProbeValue(array, 1, 1)).toBe(5);
        expect(sampleProbeValue(array, 1, 3)).toBeUndefined();
        expect(sampleProbeValue(array, 1, 1.5)).toBeUndefined();
        expect(sampleProbeValue(array, 1, Number.NaN)).toBeUndefined();
        expect(sampleProbeValue(array, 1, Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(sampleProbeValue(array, 1, Number.NEGATIVE_INFINITY)).toBeUndefined();
    });

    it('uses the L2 magnitude for multi-component arrays by default', () => {
        expect(sampleProbeValue(scalar([1, 2, 2], 3), 0)).toBe(3);
        expect(sampleProbeValue(scalar([1, 2, 3, 4, 5, 6], 3), 1)).toBeCloseTo(Math.sqrt(77), 12);
        expect(sampleProbeValue(scalar([0, 0, 0], 3), 0)).toBe(0);
        // Negative selects magnitude too (scalar-mapping sentinel parity).
        expect(sampleProbeValue(scalar([1, 2, 2], 3), 0, -1)).toBe(3);
        expect(sampleProbeValue(scalar([1, 2, 2], 3), 0, -99)).toBe(3);
    });

    it('rejects non-finite and missing values', () => {
        expect(sampleProbeValue(scalar([Number.NaN]), 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([Number.POSITIVE_INFINITY]), 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, Number.NaN, 3], 3), 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, Number.NaN, 3], 3), 0, 0)).toBe(1);
        expect(sampleProbeValue(scalar([1, Number.NaN, 3], 3), 0, 1)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, 2], 3), 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, 2], 3), 0, 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([]), 0)).toBeUndefined();
    });

    it('rejects malformed arrays and component counts', () => {
        expect(sampleProbeValue(undefined as unknown as ProbeArray, 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, 2], 0), 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, 2], -1), 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, 2], 1.5), 0)).toBeUndefined();
        expect(sampleProbeValue(scalar([1, 2], Number.NaN), 0)).toBeUndefined();
    });
});

describe('probeSamplesToCsv', () => {
    it('writes the header and a full sample row', () => {
        const samples: ProbeSample[] = [{ position: [0.5, 1, -2], association: 'cell', array: 'flux', tuple: 3, value: 1.25 }];
        expect(probeSamplesToCsv(samples)).toBe('x,y,z,association,array,tuple,value\n0.5,1,-2,cell,flux,3,1.25\n');
    });

    it('leaves optional fields blank', () => {
        expect(probeSamplesToCsv([{ position: [1, 2, 3] }])).toBe('x,y,z,association,array,tuple,value\n1,2,3,,,,\n');
        expect(probeSamplesToCsv([{ position: [1, 2, 3], association: 'point', tuple: 0 }])).toBe(
            'x,y,z,association,array,tuple,value\n1,2,3,point,,0,\n'
        );
        expect(probeSamplesToCsv([{ position: [1, 2, 3], value: Number.NaN }])).toBe('x,y,z,association,array,tuple,value\n1,2,3,,,,\n');
    });

    it('exports the header for no samples and quotes delimiters', () => {
        expect(probeSamplesToCsv([])).toBe('x,y,z,association,array,tuple,value\n');
        const quoted: ProbeSample[] = [{ position: [0.5, 1, -2], association: 'cell', array: 'flux, fast', tuple: 3, value: 1.25 }];
        expect(probeSamplesToCsv(quoted)).toContain('"flux, fast"');
    });

    it('orders rows exactly as given and terminates with a newline', () => {
        const csv = probeSamplesToCsv([
            { position: [2, 0, 0], association: 'point', array: 'a', tuple: 2, value: 2 },
            { position: [1, 0, 0], association: 'point', array: 'a', tuple: 1, value: 1 }
        ]);
        const rows = csv.trimEnd().split('\n');
        expect(rows).toEqual(['x,y,z,association,array,tuple,value', '2,0,0,point,a,2,2', '1,0,0,point,a,1,1']);
        expect(csv.endsWith('\n')).toBe(true);
    });
});

describe('probeLineToCsv', () => {
    const result: ProbeLineResult = {
        array: 'flux',
        association: 'cell',
        length: 2.5,
        dataRange: [1, 3],
        series: [
            { distance: 0, position: [0, 0, 0], value: 1, valid: true },
            { distance: 2.5, position: [2.5, 0, 0], value: null, valid: false }
        ]
    };

    it('writes distance/position/value rows with blank invalid values', () => {
        expect(probeLineToCsv(result)).toBe('distance,x,y,z,value\n0,0,0,0,1\n2.5,2.5,0,0,\n');
    });

    it('writes only the header for an empty or missing series', () => {
        expect(probeLineToCsv({ array: 'flux', association: 'cell', series: [] })).toBe('distance,x,y,z,value\n');
        expect(probeLineToCsv({ array: 'flux', association: 'cell' } as unknown as ProbeLineResult)).toBe('distance,x,y,z,value\n');
    });
});

describe('formatProbeValue', () => {
    it('renders an em dash for missing and non-finite values', () => {
        expect(formatProbeValue(undefined)).toBe('—');
        expect(formatProbeValue(Number.NaN)).toBe('—');
        expect(formatProbeValue(Number.POSITIVE_INFINITY)).toBe('—');
        expect(formatProbeValue(Number.NEGATIVE_INFINITY)).toBe('—');
    });

    it('keeps values compact at four significant digits', () => {
        expect(formatProbeValue(0)).toBe('0');
        expect(formatProbeValue(-0)).toBe('0');
        expect(formatProbeValue(42)).toBe('42');
        expect(formatProbeValue(1.23456)).toBe('1.235');
        expect(formatProbeValue(-1.23456)).toBe('-1.235');
        expect(formatProbeValue(1234.5)).toBe('1235');
        expect(formatProbeValue(123456789)).toBe('123500000');
        expect(formatProbeValue(0.00000012)).toBe('1.2e-7');
    });
});

describe('parseProbePoint / formatProbePoint', () => {
    it('parses comma- and whitespace-separated points', () => {
        expect(parseProbePoint('0.5, 1, -2')).toEqual([0.5, 1, -2]);
        expect(parseProbePoint('0.5 1 -2')).toEqual([0.5, 1, -2]);
        expect(parseProbePoint('  1,2,3  ')).toEqual([1, 2, 3]);
        expect(parseProbePoint('1;2;3')).toEqual([1, 2, 3]);
        expect(parseProbePoint('1e-3, -2e2, +4')).toEqual([0.001, -200, 4]);
    });

    it('rejects malformed or non-finite input', () => {
        expect(parseProbePoint('')).toBeUndefined();
        expect(parseProbePoint('1,2')).toBeUndefined();
        expect(parseProbePoint('1,2,3,4')).toBeUndefined();
        expect(parseProbePoint('a, b, c')).toBeUndefined();
        expect(parseProbePoint('1, 2, Infinity')).toBeUndefined();
        expect(parseProbePoint('NaN, 1, 2')).toBeUndefined();
        expect(parseProbePoint('1,,2')).toBeUndefined();
    });

    it('formats full-precision round-trippable points', () => {
        expect(formatProbePoint([1, 2.5, -3])).toBe('1, 2.5, -3');
        const point = parseProbePoint('0.1, -2.25, 3000') as readonly [number, number, number];
        expect(parseProbePoint(formatProbePoint(point))).toEqual([0.1, -2.25, 3000]);
    });
});

describe('clampProbeSamples', () => {
    it('defaults non-finite counts to 100', () => {
        expect(clampProbeSamples(Number.NaN)).toBe(100);
        expect(clampProbeSamples(Number.POSITIVE_INFINITY)).toBe(100);
        expect(clampProbeSamples(Number.NEGATIVE_INFINITY)).toBe(100);
    });

    it('floors and clamps into 2..10000', () => {
        expect(clampProbeSamples(0)).toBe(2);
        expect(clampProbeSamples(1.9)).toBe(2);
        expect(clampProbeSamples(2)).toBe(2);
        expect(clampProbeSamples(50.9)).toBe(50);
        expect(clampProbeSamples(100)).toBe(100);
        expect(clampProbeSamples(10000)).toBe(10000);
        expect(clampProbeSamples(10001)).toBe(10000);
    });
});

describe('defaultProbeEndpoints', () => {
    it('spans X through the bounds center', () => {
        expect(defaultProbeEndpoints({ min: [0, 0, 0], max: [10, 4, 2] })).toEqual({ p0: [0, 2, 1], p1: [10, 2, 1] });
        expect(defaultProbeEndpoints({ min: [-2, -4, -6], max: [2, 4, 6] })).toEqual({ p0: [-2, 0, 0], p1: [2, 0, 0] });
        expect(defaultProbeEndpoints({ min: [5, 5, 5], max: [5, 5, 5] })).toEqual({ p0: [5, 5, 5], p1: [5, 5, 5] });
    });

    it('falls back to the unit diagonal without usable bounds', () => {
        expect(defaultProbeEndpoints(undefined)).toEqual({ p0: [0, 0, 0], p1: [1, 1, 1] });
        expect(defaultProbeEndpoints({ min: [Number.NaN, 0, 0], max: [1, 1, 1] })).toEqual({
            p0: [0, 0, 0],
            p1: [1, 1, 1]
        });
        expect(defaultProbeEndpoints({ min: [0, 0, 0], max: [1, Number.POSITIVE_INFINITY, 1] })).toEqual({ p0: [0, 0, 0], p1: [1, 1, 1] });
    });
});
