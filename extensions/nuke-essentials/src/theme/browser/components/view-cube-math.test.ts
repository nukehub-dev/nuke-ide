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
 * Tests for the shared view-cube projection math (no DOM, no three.js):
 * quaternion rotation, axis projection through camera orientations,
 * back-to-front paint order, knob labels, and overlay-layout constants.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    VIEW_CUBE_AXES,
    VIEW_CUBE_BOX,
    VIEW_CUBE_CENTER,
    VIEW_CUBE_IDENTITY,
    VIEW_CUBE_KNOB,
    VIEW_CUBE_KNOB_DIAMETER,
    VIEW_CUBE_KNOB_NEGATIVE_DIAMETER,
    VIEW_CUBE_RADIUS,
    projectViewCube,
    rotateVectorByQuaternion,
    viewCubeAxisFamily,
    viewCubeKnobLabel,
    type ViewCubeAxisId,
    type ViewCubeProjection
} from './view-cube-math';

const IDENTITY = VIEW_CUBE_IDENTITY;

function projectionOf(axis: ViewCubeAxisId): ViewCubeProjection {
    const found = projectViewCube(IDENTITY).find((entry) => entry.axis === axis);
    if (!found) {
        throw new Error(`missing projection for ${axis}`);
    }
    return found;
}

describe('rotateVectorByQuaternion', () => {
    it('leaves vectors alone under identity', () => {
        expect(rotateVectorByQuaternion([1, 0, 0], [0, 0, 0, 1])).toEqual([1, 0, 0]);
        expect(rotateVectorByQuaternion([0, 1, 0], [0, 0, 0, 1])).toEqual([0, 1, 0]);
    });

    it('rotates 180 degrees about Y (X and Z flip, Y stays)', () => {
        // cos(90°) = 0, sin(90°) = 1: quaternion [0, 1, 0, 0].
        expect(rotateVectorByQuaternion([1, 0, 0], [0, 1, 0, 0])).toEqual([-1, 0, 0]);
        expect(rotateVectorByQuaternion([0, 1, 0], [0, 1, 0, 0])).toEqual([0, 1, 0]);
        expect(rotateVectorByQuaternion([0, 0, 1], [0, 1, 0, 0])).toEqual([0, 0, -1]);
    });

    it('rotates 90 degrees about Z (X becomes +Y)', () => {
        const half = Math.SQRT1_2;
        const [x, y, z] = rotateVectorByQuaternion([1, 0, 0], [0, 0, half, half]);
        expect(x).toBeCloseTo(0, 12);
        expect(y).toBeCloseTo(1, 12);
        expect(z).toBeCloseTo(0, 12);
    });
});

describe('projectViewCube', () => {
    it('projects the identity orientation onto the unit axes', () => {
        expect(projectionOf('X')).toMatchObject({ x: 1, y: 0, depth: 0, positive: true });
        expect(projectionOf('Y')).toMatchObject({ x: 0, y: 1, depth: 0, positive: true });
        expect(projectionOf('Z')).toMatchObject({ x: 0, y: 0, depth: 1, positive: true });
        expect(projectionOf('-Z')).toMatchObject({ x: 0, y: 0, depth: -1, positive: false });
    });

    it('returns six entries with unit-disc radius', () => {
        // A non-trivial orientation (120° about the (1, 1, 1) axis).
        const projections = projectViewCube({ quaternion: [0.5, 0.5, 0.5, 0.5] });
        expect(projections).toHaveLength(6);
        for (const entry of projections) {
            expect(entry.x * entry.x + entry.y * entry.y + entry.depth * entry.depth).toBeCloseTo(1, 12);
        }
    });

    it('sorts back-to-front so the front-most knob paints last', () => {
        const projections = projectViewCube(IDENTITY);
        for (let i = 1; i < projections.length; i++) {
            expect(projections[i].depth).toBeGreaterThanOrEqual(projections[i - 1].depth);
        }
        expect(projections[0].axis).toBe('-Z');
        expect(projections[projections.length - 1].axis).toBe('Z');
    });

    it('mirrors a turned camera (180° about Y swaps the X knobs front-to-back)', () => {
        const projections = projectViewCube({ quaternion: [0, 1, 0, 0] });
        const byAxis = new Map(projections.map((entry) => [entry.axis, entry]));
        expect(byAxis.get('X')).toMatchObject({ x: -1, y: 0 });
        expect(byAxis.get('-X')).toMatchObject({ x: 1, y: 0 });
    });

    it('falls back to identity for degenerate quaternions instead of NaNs', () => {
        for (const quaternion of [
            [0, 0, 0, 0],
            [NaN, 0, 0, 1],
            [Infinity, 0, 0, 1]
        ] as const) {
            const projections = projectViewCube({ quaternion });
            expect(projections.map((entry) => entry.axis).sort()).toEqual(['-X', '-Y', '-Z', 'X', 'Y', 'Z']);
            for (const entry of projections) {
                expect(Number.isFinite(entry.x)).toBe(true);
                expect(Number.isFinite(entry.y)).toBe(true);
                expect(Number.isFinite(entry.depth)).toBe(true);
            }
        }
    });

    it('covers all six axes in knob order before sorting', () => {
        expect(VIEW_CUBE_AXES.map((axis) => axis.id)).toEqual(['X', 'Y', 'Z', '-X', '-Y', '-Z']);
    });
});

describe('view-cube labels', () => {
    it('labels knobs by family (both ends share the letter)', () => {
        expect(viewCubeKnobLabel('X')).toBe('X');
        expect(viewCubeKnobLabel('-X')).toBe('X');
        expect(viewCubeKnobLabel('-Z')).toBe('Z');
        expect(viewCubeAxisFamily('-Y')).toBe('y');
    });
});

describe('view-cube overlay layout', () => {
    it('keeps the overlay geometry self-consistent (box/center/radius/knob)', () => {
        expect(VIEW_CUBE_BOX).toBeGreaterThan(0);
        expect(VIEW_CUBE_CENTER).toBe(VIEW_CUBE_BOX / 2);
        expect(VIEW_CUBE_RADIUS).toBeGreaterThan(0);
        expect(VIEW_CUBE_RADIUS).toBeLessThan(VIEW_CUBE_CENTER);
        // Knob slots stay clickable hit targets; the visible knob circles
        // fit exactly inside the box at extreme spoke endpoints.
        expect(VIEW_CUBE_KNOB).toBeGreaterThanOrEqual(20);
        expect(VIEW_CUBE_KNOB_DIAMETER).toBeGreaterThan(VIEW_CUBE_KNOB_NEGATIVE_DIAMETER);
        expect(VIEW_CUBE_CENTER - VIEW_CUBE_RADIUS).toBeGreaterThanOrEqual(VIEW_CUBE_KNOB_DIAMETER / 2);
    });

    it('matches the overlay stylesheet (fixed-size box, real knob hit boxes)', () => {
        const css = readFileSync(join(__dirname, 'view-cube.css'), 'utf8');
        const box = cssRuleBlock(css, '.nuke-view-cube');
        expect(cssPixels(box, 'width')).toBe(VIEW_CUBE_BOX);
        expect(cssPixels(box, 'height')).toBe(VIEW_CUBE_BOX);
        const slot = cssRuleBlock(css, '.nuke-view-cube-knob-slot');
        expect(cssPixels(slot, 'width')).toBe(VIEW_CUBE_KNOB);
        expect(cssPixels(slot, 'height')).toBe(VIEW_CUBE_KNOB);
        const knob = cssRuleBlock(css, '.nuke-view-cube-knob');
        expect(cssPixels(knob, 'width')).toBe(VIEW_CUBE_KNOB_DIAMETER);
        expect(cssPixels(knob, 'height')).toBe(VIEW_CUBE_KNOB_DIAMETER);
    });
});

/** Raw declaration block of the first `selector { ... }` rule in `css` (comments stripped). */
function cssRuleBlock(css: string, selector: string): string {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const start = flat.indexOf(`${selector} {`);
    if (start < 0) {
        throw new Error(`missing ${selector} rule in view-cube.css`);
    }
    const open = flat.indexOf('{', start);
    const close = flat.indexOf('}', open);
    return flat.slice(open + 1, close);
}

/** Pixel value of a `prop` declaration inside a rule block. */
function cssPixels(block: string, prop: string): number {
    const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(`;${block}`);
    if (!match) {
        throw new Error(`missing ${prop} declaration`);
    }
    return parseFloat(match[1]);
}
