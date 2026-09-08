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
 * Tests for the viewer-core orientation-gizmo math (no DOM, no three.js):
 * axis projection through camera poses, screen scaling, octant buckets, and
 * front-most picking.
 */

import { describe, expect, it } from 'vitest';
import {
    GIZMO_AXES,
    GIZMO_CENTER_EPSILON,
    GIZMO_OCTANT_COUNT,
    GIZMO_VIEW_DIRECTIONS,
    gizmoOctantFor,
    pickFrontAxisPerOctant,
    projectGizmoAxes,
    toGizmoScreen,
    type GizmoCameraPose,
    type GizmoProjection
} from './orientation-gizmo';

const FRONT_POSE: GizmoCameraPose = { look: [0, 0, -1], up: [0, 1, 0] };

function projectionOf(axis: GizmoProjection['axis'], pose: GizmoCameraPose = FRONT_POSE): GizmoProjection {
    const found = projectGizmoAxes(pose).find((entry) => entry.axis === axis);
    if (!found) {
        throw new Error(`missing projection for ${axis}`);
    }
    return found;
}

describe('projectGizmoAxes', () => {
    it('projects the front view onto the unit axes', () => {
        expect(projectionOf('X')).toMatchObject({ x: 1, y: 0, facing: 0 });
        expect(projectionOf('Y')).toMatchObject({ x: 0, y: 1, facing: 0 });
        expect(projectionOf('Z')).toMatchObject({ x: 0, y: 0, facing: 1 });
        expect(projectionOf('-Z')).toMatchObject({ x: 0, y: 0, facing: -1 });
    });

    it('returns six entries in knob order with unit radius', () => {
        const projections = projectGizmoAxes({ look: [-1, -1, -1], up: [0, 1, 0] });
        expect(projections.map((entry) => entry.axis)).toEqual(['X', 'Y', 'Z', '-X', '-Y', '-Z']);
        for (const entry of projections) {
            expect(entry.x * entry.x + entry.y * entry.y + entry.facing * entry.facing).toBeCloseTo(1, 12);
        }
    });

    it('centers the axis running along the view (top view hides Y)', () => {
        const up = projectionOf('Y', { look: [0, -1, 0], up: [0, 0, 1] });
        expect(up.facing).toBeCloseTo(1, 12);
        expect(up.length).toBeCloseTo(0, 12);
        expect(up.length).toBeLessThan(GIZMO_CENTER_EPSILON);
    });

    it('stays finite and unit-circled for degenerate input', () => {
        const projections = projectGizmoAxes({ look: [0, 0, 0], up: [0, 0, 0] });
        expect(projections).toHaveLength(6);
        for (const entry of projections) {
            expect(Number.isFinite(entry.x)).toBe(true);
            expect(Number.isFinite(entry.y)).toBe(true);
            expect(Number.isFinite(entry.facing)).toBe(true);
            expect(entry.x * entry.x + entry.y * entry.y + entry.facing * entry.facing).toBeCloseTo(1, 12);
        }
    });

    it('survives up parallel to the view with finite output', () => {
        const projections = projectGizmoAxes({ look: [0, 1, 0], up: [0, 2, 0] });
        for (const entry of projections) {
            expect(Number.isFinite(entry.x)).toBe(true);
            expect(Number.isFinite(entry.y)).toBe(true);
            expect(Number.isFinite(entry.facing)).toBe(true);
        }
    });

    it('matches the click-to-snap directions axis for axis', () => {
        expect(GIZMO_AXES).toHaveLength(6);
        for (const { id, direction } of GIZMO_AXES) {
            expect(GIZMO_VIEW_DIRECTIONS[id]).toEqual(direction);
        }
    });
});

describe('toGizmoScreen', () => {
    it('scales overlay units by the spoke radius', () => {
        expect(toGizmoScreen({ x: 1, y: -0.5 }, 32)).toEqual({ x: 32, y: -16 });
    });

    it('maps invalid radii to the origin', () => {
        expect(toGizmoScreen({ x: 1, y: 1 }, Number.NaN)).toEqual({ x: 0, y: 0 });
        expect(toGizmoScreen({ x: 1, y: 1 }, -4)).toEqual({ x: 0, y: 0 });
    });
});

describe('gizmoOctantFor', () => {
    it('buckets the cardinal directions', () => {
        expect(gizmoOctantFor(1, 0)).toBe(0);
        expect(gizmoOctantFor(0, 1)).toBe(2);
        expect(gizmoOctantFor(-1, 0)).toBe(4);
        expect(gizmoOctantFor(0, -1)).toBe(6);
        expect(GIZMO_OCTANT_COUNT).toBe(8);
    });

    it('returns -1 for centered and non-finite points', () => {
        expect(gizmoOctantFor(0, 0)).toBe(-1);
        expect(gizmoOctantFor(Number.NaN, 0)).toBe(-1);
        expect(gizmoOctantFor(1, Number.POSITIVE_INFINITY)).toBe(-1);
    });
});

describe('pickFrontAxisPerOctant', () => {
    it('keeps the front-most projection when two share an octant', () => {
        const back: GizmoProjection = { axis: '-Z', x: 0.9, y: 0.1, facing: -0.4, length: 0.9 };
        const front: GizmoProjection = { axis: 'X', x: 0.8, y: 0.2, facing: 0.6, length: 0.8 };
        expect(gizmoOctantFor(back.x, back.y)).toBe(gizmoOctantFor(front.x, front.y));
        expect(pickFrontAxisPerOctant([back, front])).toEqual([front]);
    });

    it('keeps every axis in its own octant and skips centered ones', () => {
        const projections = projectGizmoAxes({ look: [0, 0, -1], up: [0, 1, 0] });
        const winners = pickFrontAxisPerOctant(projections);
        // +Z/-Z run along the view (centered); the other four own an octant each.
        expect(winners.map((entry) => entry.axis).sort()).toEqual(['-X', '-Y', 'X', 'Y']);
    });
});
