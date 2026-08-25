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
import {
    AXIS_INDEX,
    DEFAULT_SECTION_FRACTION,
    SECTION_AXES,
    clampSectionFraction,
    sectionOffset,
    sectionPlaneFromBox,
    sectionStatusLabel
} from './section-plane';

const BOX = { min: [0, -10, 100], max: [10, 30, 200] };

describe('section-plane', () => {
    it('lists the popover axes in X/Y/Z order', () => {
        expect(SECTION_AXES.map((axis) => axis.id)).toEqual(['x', 'y', 'z']);
        expect(AXIS_INDEX).toEqual({ x: 0, y: 1, z: 2 });
    });

    it('maps fraction 0% to the min edge and 100% to the max edge of each axis', () => {
        expect(sectionOffset({ axis: 'x', flip: false, fraction: 0 }, BOX)).toBe(0);
        expect(sectionOffset({ axis: 'x', flip: false, fraction: 1 }, BOX)).toBe(10);
        expect(sectionOffset({ axis: 'y', flip: false, fraction: 0 }, BOX)).toBe(-10);
        expect(sectionOffset({ axis: 'y', flip: false, fraction: 1 }, BOX)).toBe(30);
        expect(sectionOffset({ axis: 'z', flip: false, fraction: 0 }, BOX)).toBe(100);
        expect(sectionOffset({ axis: 'z', flip: false, fraction: 1 }, BOX)).toBe(200);
    });

    it('defaults to the model center at 50%', () => {
        expect(DEFAULT_SECTION_FRACTION).toBe(0.5);
        expect(sectionOffset({ axis: 'z', flip: false, fraction: DEFAULT_SECTION_FRACTION }, BOX)).toBe(150);
    });

    it('clamps fractions outside 0..1 for both offset and slider input', () => {
        expect(clampSectionFraction(-0.5)).toBe(0);
        expect(clampSectionFraction(1.5)).toBe(1);
        expect(sectionOffset({ axis: 'y', flip: false, fraction: -3 }, BOX)).toBe(-10);
        expect(sectionOffset({ axis: 'y', flip: false, fraction: 7 }, BOX)).toBe(30);
    });

    it('points the unflipped normal toward bbox min and keeps the lower half visible', () => {
        const plane = sectionPlaneFromBox({ axis: 'z', flip: false, fraction: 0.5 }, BOX);
        expect(plane.normal).toEqual([0, 0, -1]);
        expect(plane.constant).toBe(150);
        // THREE.Plane visibility: normal·p + constant >= 0 → p.z <= 150 stays.
        expect(plane.normal[2] * 149 + plane.constant).toBeGreaterThan(0);
        expect(plane.normal[2] * 151 + plane.constant).toBeLessThan(0);
    });

    it('negates normal and constant when flipped so the upper half stays visible', () => {
        const plane = sectionPlaneFromBox({ axis: 'z', flip: true, fraction: 0.5 }, BOX);
        expect(plane.normal).toEqual([0, 0, 1]);
        expect(plane.constant).toBe(-150);
    });

    it('emits unit normals along x and y with their own offsets', () => {
        expect(sectionPlaneFromBox({ axis: 'x', flip: false, fraction: 0.25 }, BOX)).toEqual({
            normal: [-1, 0, 0],
            constant: 2.5
        });
        expect(sectionPlaneFromBox({ axis: 'y', flip: true, fraction: 0.75 }, BOX)).toEqual({
            normal: [0, 1, 0],
            constant: -20
        });
    });

    it('handles degenerate zero-extent boxes without NaNs', () => {
        const plane = sectionPlaneFromBox({ axis: 'x', flip: false, fraction: 0.4 }, { min: [5, 5, 5], max: [5, 5, 5] });
        expect(plane.normal).toEqual([-1, 0, 0]);
        expect(plane.constant).toBe(5);
    });

    it('formats the status label as AXIS @ percent', () => {
        expect(sectionStatusLabel({ axis: 'z', flip: false, fraction: 0.5 })).toBe('Z @ 50%');
        expect(sectionStatusLabel({ axis: 'x', flip: true, fraction: 0 })).toBe('X @ 0%');
        expect(sectionStatusLabel({ axis: 'y', flip: false, fraction: 1 })).toBe('Y @ 100%');
        expect(sectionStatusLabel({ axis: 'y', flip: false, fraction: 0.3333 })).toBe('Y @ 33%');
    });
});
