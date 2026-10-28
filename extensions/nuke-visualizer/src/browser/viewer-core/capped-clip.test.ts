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
 * Tests for the pure capped-clipping builder: axis and oblique planes, cube
 * faces lying exactly in the plane, shared/duplicated contact points,
 * collinear boundary points, open soups, degenerate input, disjoint loops,
 * winding, tolerance handling, and the perf guards.
 */

import { describe, expect, it } from 'vitest';
import { buildClipCap, MAX_CAP_LOOP_VERTICES } from './capped-clip';

interface TestSoup {
    positions: number[];
    triangles: number[];
}

/** Axis-aligned box triangulated with outward-facing triangles. */
function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): TestSoup {
    const positions = [
        minX,
        minY,
        minZ,
        maxX,
        minY,
        minZ,
        maxX,
        maxY,
        minZ,
        minX,
        maxY,
        minZ,
        minX,
        minY,
        maxZ,
        maxX,
        minY,
        maxZ,
        maxX,
        maxY,
        maxZ,
        minX,
        maxY,
        maxZ
    ];
    const triangles = [
        0,
        2,
        1,
        0,
        3,
        2, // z = min
        4,
        5,
        6,
        4,
        6,
        7, // z = max
        0,
        1,
        5,
        0,
        5,
        4, // y = min
        3,
        7,
        6,
        3,
        6,
        2, // y = max
        0,
        4,
        7,
        0,
        7,
        3, // x = min
        1,
        2,
        6,
        1,
        6,
        5 // x = max
    ];
    return { positions, triangles };
}

function unitCube(): TestSoup {
    return box(0, 0, 0, 1, 1, 1);
}

/**
 * Tube wall along Z with `segments` quads; the Z = 0 cut is a closed ring of
 * two points per quad. `innerRadius < 1` alternates the profile radii so the
 * section is a gear-like simple polygon whose points are never collinear.
 */
function tube(segments: number, innerRadius = 1): TestSoup {
    const positions: number[] = [];
    const triangles: number[] = [];
    for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const radius = i % 2 === 0 ? 1 : innerRadius;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        positions.push(x, y, -1);
        positions.push(x, y, 1);
    }
    for (let i = 0; i < segments; i++) {
        const next = (i + 1) % segments;
        const a = i * 2;
        const b = i * 2 + 1;
        const aNext = next * 2;
        const bNext = next * 2 + 1;
        triangles.push(a, b, bNext, a, bNext, aNext);
    }
    return { positions, triangles };
}

/** Extruded prism over a 2D `[y, z]` section; the X = 0.5 cut is the section polygon. */
function prism(section: ReadonlyArray<readonly [number, number]>): TestSoup {
    const positions: number[] = [];
    const triangles: number[] = [];
    for (const [y, z] of section) {
        positions.push(0, y, z);
        positions.push(1, y, z);
    }
    for (let i = 0; i < section.length; i++) {
        const next = (i + 1) % section.length;
        const a0 = i * 2;
        const a1 = i * 2 + 1;
        const b0 = next * 2;
        const b1 = next * 2 + 1;
        triangles.push(a0, a1, b1, a0, b1, b0);
    }
    return { positions, triangles };
}

function mergeSoups(...soups: TestSoup[]): TestSoup {
    const positions: number[] = [];
    const triangles: number[] = [];
    let offset = 0;
    for (const soup of soups) {
        positions.push(...soup.positions);
        for (const index of soup.triangles) {
            triangles.push(index + offset);
        }
        offset += soup.positions.length / 3;
    }
    return { positions, triangles };
}

function triangleArea(data: ArrayLike<number>, offset: number): number {
    const ax = data[offset];
    const ay = data[offset + 1];
    const az = data[offset + 2];
    const ux = data[offset + 3] - ax;
    const uy = data[offset + 4] - ay;
    const uz = data[offset + 5] - az;
    const vx = data[offset + 6] - ax;
    const vy = data[offset + 7] - ay;
    const vz = data[offset + 8] - az;
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

function capTriangles(cap: Float32Array): number {
    return cap.length / 9;
}

function capArea(cap: Float32Array): number {
    let area = 0;
    for (let offset = 0; offset < cap.length; offset += 9) {
        area += triangleArea(cap, offset);
    }
    return area;
}

function capNormals(cap: Float32Array): Array<[number, number, number]> {
    const normals: Array<[number, number, number]> = [];
    for (let offset = 0; offset < cap.length; offset += 9) {
        const ax = cap[offset];
        const ay = cap[offset + 1];
        const az = cap[offset + 2];
        const ux = cap[offset + 3] - ax;
        const uy = cap[offset + 4] - ay;
        const uz = cap[offset + 5] - az;
        const vx = cap[offset + 6] - ax;
        const vy = cap[offset + 7] - ay;
        const vz = cap[offset + 8] - az;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        normals.push([nx / length, ny / length, nz / length]);
    }
    return normals;
}

function expectWinding(cap: Float32Array, normal: readonly [number, number, number]): void {
    const length = Math.hypot(normal[0], normal[1], normal[2]);
    for (const faceNormal of capNormals(cap)) {
        expect(faceNormal[0]).toBeCloseTo(normal[0] / length, 5);
        expect(faceNormal[1]).toBeCloseTo(normal[1] / length, 5);
        expect(faceNormal[2]).toBeCloseTo(normal[2] / length, 5);
    }
}

describe('buildClipCap: axis-aligned planes', () => {
    it('caps a unit cube cut exactly at its X = 0 face (area 1)', () => {
        const cap = buildClipCap(unitCube(), [1, 0, 0], 0);
        expect(cap).toBeDefined();
        expect(cap).toBeInstanceOf(Float32Array);
        expect(capTriangles(cap!)).toBe(2);
        expect(capArea(cap!)).toBeCloseTo(1, 6);
        for (let i = 0; i < cap!.length; i += 3) {
            expect(cap![i]).toBeCloseTo(0, 6);
        }
        expectWinding(cap!, [1, 0, 0]);
    });

    it('caps a cube cut through the middle (shared points, collinear boundary points)', () => {
        const cap = buildClipCap(unitCube(), [1, 0, 0], -0.5);
        expect(cap).toBeDefined();
        // Eight boundary points (four face-centre diagonal crossings removed as collinear) -> two triangles.
        expect(capTriangles(cap!)).toBe(2);
        expect(capArea(cap!)).toBeCloseTo(1, 6);
        for (let i = 0; i < cap!.length; i += 3) {
            expect(cap![i]).toBeCloseTo(0.5, 6);
        }
        expectWinding(cap!, [1, 0, 0]);
    });

    it('caps Y and Z cuts with the same unit area', () => {
        const yCap = buildClipCap(unitCube(), [0, 1, 0], -0.5);
        expect(yCap).toBeDefined();
        expect(capTriangles(yCap!)).toBe(2);
        expect(capArea(yCap!)).toBeCloseTo(1, 6);
        for (let i = 1; i < yCap!.length; i += 3) {
            expect(yCap![i]).toBeCloseTo(0.5, 6);
        }
        expectWinding(yCap!, [0, 1, 0]);

        const zCap = buildClipCap(unitCube(), [0, 0, 1], -0.5);
        expect(zCap).toBeDefined();
        expect(capTriangles(zCap!)).toBe(2);
        expect(capArea(zCap!)).toBeCloseTo(1, 6);
        for (let i = 2; i < zCap!.length; i += 3) {
            expect(zCap![i]).toBeCloseTo(0.5, 6);
        }
        expectWinding(zCap!, [0, 0, 1]);
    });

    it('winds the cap along the negated plane normal', () => {
        const cap = buildClipCap(unitCube(), [0, 0, -2], 1);
        expect(cap).toBeDefined();
        expect(capArea(cap!)).toBeCloseTo(1, 6);
        expectWinding(cap!, [0, 0, -1]);
    });

    it('normalizes a scaled normal with its constant', () => {
        const cap = buildClipCap(unitCube(), [4, 0, 0], -2);
        expect(cap).toBeDefined();
        expect(capArea(cap!)).toBeCloseTo(1, 6);
        for (let i = 0; i < cap!.length; i += 3) {
            expect(cap![i]).toBeCloseTo(0.5, 6);
        }
        expectWinding(cap!, [1, 0, 0]);
    });
});

describe('buildClipCap: oblique planes and closed soups', () => {
    it('caps a cube cut by X + Y = 1 (duplicate segments from both sides of a mesh edge)', () => {
        const cap = buildClipCap(unitCube(), [1, 1, 0], -1);
        expect(cap).toBeDefined();
        expect(capTriangles(cap!)).toBe(2);
        expect(capArea(cap!)).toBeCloseTo(Math.SQRT2, 5);
        for (let i = 0; i < cap!.length; i += 3) {
            expect(cap![i] + cap![i + 1]).toBeCloseTo(1, 6);
        }
        expectWinding(cap!, [1, 1, 0]);
    });

    it('caps a closed tetrahedron with a single triangle', () => {
        const soup: TestSoup = {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
            triangles: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
        };
        const cap = buildClipCap(soup, [1, 0, 0], -0.5);
        expect(cap).toBeDefined();
        expect(capTriangles(cap!)).toBe(1);
        expect(capArea(cap!)).toBeCloseTo(0.125, 6);
        for (let i = 0; i < cap!.length; i += 3) {
            expect(cap![i]).toBeCloseTo(0.5, 6);
        }
        expectWinding(cap!, [1, 0, 0]);
    });

    it('ear-clips a non-convex (L-shaped) section', () => {
        const section: ReadonlyArray<readonly [number, number]> = [
            [0, 0],
            [2, 0],
            [2, 1],
            [1, 1],
            [1, 2],
            [0, 2]
        ];
        const cap = buildClipCap(prism(section), [1, 0, 0], -0.5);
        expect(cap).toBeDefined();
        // Six boundary vertices -> n - 2 = 4 triangles, area = 2 * 1 + 1 * 1.
        expect(capTriangles(cap!)).toBe(4);
        expect(capArea(cap!)).toBeCloseTo(3, 6);
        for (let i = 0; i < cap!.length; i += 3) {
            expect(cap![i]).toBeCloseTo(0.5, 6);
        }
        expectWinding(cap!, [1, 0, 0]);
    });
});

describe('buildClipCap: empty results', () => {
    it('returns undefined for a single triangle crossing the plane (open chain)', () => {
        const soup: TestSoup = {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            triangles: [0, 1, 2]
        };
        expect(buildClipCap(soup, [1, 0, 0], -0.5)).toBeUndefined();
    });

    it('returns undefined for an open soup (cube without its top face)', () => {
        const cube = unitCube();
        // Triangles 6..11 are the z = max face.
        const open: TestSoup = {
            positions: cube.positions,
            triangles: [...cube.triangles.slice(0, 6), ...cube.triangles.slice(12)]
        };
        expect(buildClipCap(open, [1, 0, 0], -0.5)).toBeUndefined();
    });

    it('returns undefined for a fully kept or fully clipped cube', () => {
        expect(buildClipCap(unitCube(), [1, 0, 0], 1)).toBeUndefined();
        expect(buildClipCap(unitCube(), [1, 0, 0], -2)).toBeUndefined();
    });

    it('returns undefined for a triangle lying exactly in the plane', () => {
        const soup: TestSoup = {
            positions: [0, 0, 0, 0, 1, 0, 0, 0, 1],
            triangles: [0, 1, 2]
        };
        expect(buildClipCap(soup, [1, 0, 0], 0)).toBeUndefined();
    });

    it('returns undefined for an empty or invalid soup', () => {
        expect(buildClipCap({ positions: [], triangles: [] }, [1, 0, 0], 0)).toBeUndefined();
        expect(buildClipCap({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 9] }, [1, 0, 0], 0)).toBeUndefined();
        expect(buildClipCap({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, Number.NaN] }, [1, 0, 0], 0)).toBeUndefined();
    });

    it('returns undefined for degenerate normals and constants', () => {
        const cube = unitCube();
        expect(buildClipCap(cube, [0, 0, 0], 0)).toBeUndefined();
        expect(buildClipCap(cube, [Number.NaN, 0, 0], 0)).toBeUndefined();
        expect(buildClipCap(cube, [Number.POSITIVE_INFINITY, 0, 0], 0)).toBeUndefined();
        expect(buildClipCap(cube, [1, 0, 0], Number.NaN)).toBeUndefined();
    });
});

describe('buildClipCap: disjoint loops and non-finite data', () => {
    it('returns every disjoint outer loop (one cap disc per solid)', () => {
        const cap = buildClipCap(mergeSoups(box(0, 0, 0, 1, 1, 1), box(0, 2, 0, 1, 3, 1)), [1, 0, 0], -0.5);
        expect(cap).toBeDefined();
        expect(capTriangles(cap!)).toBe(4);
        expect(capArea(cap!)).toBeCloseTo(2, 6);
        expectWinding(cap!, [1, 0, 0]);
    });

    it('caps a small loop and a larger loop together', () => {
        const cap = buildClipCap(mergeSoups(box(0, 0, 0, 1, 1, 1), box(0, 3, 0, 2, 5, 2)), [1, 0, 0], -0.5);
        expect(cap).toBeDefined();
        expect(capArea(cap!)).toBeCloseTo(5, 6);
    });

    it('skips non-finite vertices without losing the rest of the soup', () => {
        const cube = unitCube();
        const positions = [...cube.positions];
        const triangles = [...cube.triangles, 0, 1, 8];
        positions.push(Number.NaN, 0, 0);
        const cap = buildClipCap({ positions, triangles }, [1, 0, 0], -0.5);
        expect(cap).toBeDefined();
        expect(capArea(cap!)).toBeCloseTo(1, 6);
    });

    it('accepts typed-array soups and does not mutate the input', () => {
        const cube = unitCube();
        const before = cube.positions.slice();
        const cap = buildClipCap(
            { positions: Float32Array.from(cube.positions), triangles: Uint32Array.from(cube.triangles) },
            [1, 0, 0],
            0
        );
        expect(cap).toBeDefined();
        expect(capArea(cap!)).toBeCloseTo(1, 5);
        expect(cube.positions).toEqual(before);
    });

    it('treats float-noise vertices as on the plane (default epsilon)', () => {
        const cube = unitCube();
        cube.positions[0] = -1e-9;
        const cap = buildClipCap(cube, [1, 0, 0], 0);
        expect(cap).toBeDefined();
        expect(capTriangles(cap!)).toBe(2);
        expect(capArea(cap!)).toBeCloseTo(1, 5);
    });
});

describe('buildClipCap: perf guards', () => {
    it('caps a moderately fine circular section', () => {
        const cap = buildClipCap(tube(64), [0, 0, 1], 0);
        expect(cap).toBeDefined();
        expect(capArea(cap!)).toBeGreaterThan(3);
        expect(capArea(cap!)).toBeLessThan(3.2);
    });

    it('drops loops above the boundary-vertex guard', () => {
        // Every quad contributes two ring points; the chord midpoints collapse as collinear,
        // leaving one point per quad. One more quad than the guard must therefore be dropped.
        expect(buildClipCap(tube(MAX_CAP_LOOP_VERTICES + 1, 0.5), [0, 0, 1], 0)).toBeUndefined();
    });
});
