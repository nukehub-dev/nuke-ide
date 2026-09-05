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

import { describe, it, expect } from 'vitest';
import type { Vec3 } from './assembly-document';
import {
    applyRigidTransformToPoint,
    connectorFrameFromDefinition,
    constrainedDofsForMateType,
    countAssemblyDof,
    freeDofsForMateType,
    resolveMatePlacement,
    type ConnectorFrame,
    type RigidTransform
} from './assembly-placement';

const IDENTITY_FRAME: ConnectorFrame = {
    origin: [0, 0, 0],
    xAxis: [1, 0, 0],
    yAxis: [0, 1, 0],
    zAxis: [0, 0, 1]
};

function frame(origin: Vec3, xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): ConnectorFrame {
    return { origin, xAxis, yAxis, zAxis };
}

function expectFramesCoincide(solution: RigidTransform, frameA: ConnectorFrame, frameB: ConnectorFrame): void {
    // The solved transform maps B's origin and axes onto A's.
    expect(applyRigidTransformToPoint(solution, frameB.origin)).toEqual(
        expect.arrayContaining(frameA.origin.map((v) => expect.closeTo(v, 10)))
    );
    for (const [axisB, axisA] of [
        [frameB.xAxis, frameA.xAxis],
        [frameB.yAxis, frameA.yAxis],
        [frameB.zAxis, frameA.zAxis]
    ] as [Vec3, Vec3][]) {
        // Rotation only: zero the matrix translation (overriding `position`
        // alone would leave m[3]/m[7]/m[11] in place).
        const rotationOnly: RigidTransform = {
            position: [0, 0, 0],
            orientation: solution.orientation,
            matrix: [
                solution.matrix[0],
                solution.matrix[1],
                solution.matrix[2],
                0,
                solution.matrix[4],
                solution.matrix[5],
                solution.matrix[6],
                0,
                solution.matrix[8],
                solution.matrix[9],
                solution.matrix[10],
                0,
                0,
                0,
                0,
                1
            ]
        };
        const rotated = applyRigidTransformToPoint(rotationOnly, axisB);
        expect(rotated[0]).toBeCloseTo(axisA[0], 10);
        expect(rotated[1]).toBeCloseTo(axisA[1], 10);
        expect(rotated[2]).toBeCloseTo(axisA[2], 10);
    }
}

describe('resolveMatePlacement', () => {
    it('returns identity for coincident axis-aligned frames', () => {
        const solution = resolveMatePlacement('fixed', IDENTITY_FRAME, IDENTITY_FRAME);
        expect(solution.transform.position).toEqual([0, 0, 0]);
        expect(solution.transform.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        expect(solution.freeDofs).toEqual([]);
    });

    it('translates B onto A for offset axis-aligned frames', () => {
        const frameB = frame([4, -2, 7], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
        const solution = resolveMatePlacement('fixed', IDENTITY_FRAME, frameB);
        expect(solution.transform.position).toEqual([-4, 2, -7]);
        expect(applyRigidTransformToPoint(solution.transform, [4, -2, 7])).toEqual(
            expect.arrayContaining([expect.closeTo(0, 10), expect.closeTo(0, 10), expect.closeTo(0, 10)])
        );
    });

    it('counter-rotates a 90-degree tilted frame', () => {
        // Frame B spun +90 degrees about z: its x points along +y.
        const frameB = frame([0, 0, 0], [0, 1, 0], [-1, 0, 0], [0, 0, 1]);
        const solution = resolveMatePlacement('revolute', IDENTITY_FRAME, frameB);
        // R = Ra * Rb^T is the -90-degree spin; entry (0, 1) is +1.
        expect(solution.transform.matrix[1]).toBeCloseTo(1, 12);
        expect(solution.transform.matrix[4]).toBeCloseTo(-1, 12);
        expect(solution.freeDofs).toEqual([{ kind: 'rotation', axis: 'z' }]);
        expectFramesCoincide(solution.transform, IDENTITY_FRAME, frameB);
    });

    it('coincides tilted frames (axis-aligned A, rotated offset B)', () => {
        const c = Math.SQRT1_2;
        // Frame B: 45 degrees about z, offset from the origin.
        const frameB = frame([3, 1, -2], [c, c, 0], [-c, c, 0], [0, 0, 1]);
        const solution = resolveMatePlacement('cylindrical', IDENTITY_FRAME, frameB);
        expectFramesCoincide(solution.transform, IDENTITY_FRAME, frameB);
        expect(solution.freeDofs).toEqual([
            { kind: 'rotation', axis: 'z' },
            { kind: 'translation', axis: 'z' }
        ]);
    });

    it('coincides fully tilted frames (neither axis-aligned)', () => {
        const c = Math.SQRT1_2;
        // A: 90 degrees about x (y -> z). B: 45 degrees about z, offset.
        const frameA = frame([1, 2, 3], [1, 0, 0], [0, 0, 1], [0, -1, 0]);
        const frameB = frame([-1, 0.5, 4], [c, c, 0], [-c, c, 0], [0, 0, 1]);
        const solution = resolveMatePlacement('ball', frameA, frameB);
        expectFramesCoincide(solution.transform, frameA, frameB);
    });

    it('is deterministic for the same inputs', () => {
        const c = Math.SQRT1_2;
        const frameB = frame([3, 1, -2], [c, c, 0], [-c, c, 0], [0, 0, 1]);
        const first = resolveMatePlacement('planar', IDENTITY_FRAME, frameB);
        const second = resolveMatePlacement('planar', IDENTITY_FRAME, frameB);
        expect(second).toEqual(first);
    });
});

describe('free DOFs', () => {
    it.each([
        ['fixed', []],
        ['revolute', [{ kind: 'rotation', axis: 'z' }]],
        ['slider', [{ kind: 'translation', axis: 'z' }]],
        [
            'cylindrical',
            [
                { kind: 'rotation', axis: 'z' },
                { kind: 'translation', axis: 'z' }
            ]
        ],
        [
            'ball',
            [
                { kind: 'rotation', axis: 'x' },
                { kind: 'rotation', axis: 'y' },
                { kind: 'rotation', axis: 'z' }
            ]
        ],
        [
            'planar',
            [
                { kind: 'translation', axis: 'x' },
                { kind: 'translation', axis: 'y' },
                { kind: 'rotation', axis: 'z' }
            ]
        ]
    ] as const)('describes %s mates', (type, expected) => {
        expect(freeDofsForMateType(type)).toEqual(expected);
        expect(constrainedDofsForMateType(type)).toBe(6 - expected.length);
    });
});

describe('countAssemblyDof', () => {
    it('counts a lone grounded instance as fully defined', () => {
        expect(countAssemblyDof(1, [])).toBe(0);
    });

    it('counts an unmated pair as free', () => {
        expect(countAssemblyDof(2, [])).toBe(6);
    });

    it('subtracts each mate type contribution', () => {
        expect(countAssemblyDof(2, ['fixed'])).toBe(0);
        expect(countAssemblyDof(2, ['revolute'])).toBe(1);
        expect(countAssemblyDof(2, ['slider'])).toBe(1);
        expect(countAssemblyDof(2, ['cylindrical'])).toBe(2);
        expect(countAssemblyDof(2, ['ball'])).toBe(3);
        expect(countAssemblyDof(2, ['planar'])).toBe(3);
    });

    it('accumulates across a chain', () => {
        // Three instances, two revolute mates: 12 - 5 - 5 = 2.
        expect(countAssemblyDof(3, ['revolute', 'revolute'])).toBe(2);
    });
});

describe('connectorFrameFromDefinition', () => {
    it('completes z and copies the origin', () => {
        const frameDef = connectorFrameFromDefinition({ origin: [1, 2, 3], xAxis: [1, 0, 0], yAxis: [0, 1, 0] });
        expect(frameDef).toEqual({ origin: [1, 2, 3], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1] });
    });
});
