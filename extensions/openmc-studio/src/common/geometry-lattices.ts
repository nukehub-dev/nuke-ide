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

/**
 * Pure helpers for the canonical lattice data model.
 *
 * Rectangular lattices store universes as `[z][y][x]` with the y index running
 * from the top row, and hexagonal lattices as `[z][ring][theta]` with ring 0
 * outermost and theta starting at the top and proceeding clockwise. Both match
 * `openmc.RectLattice.universes` / `openmc.HexLattice.universes`, so XML and
 * Python export share one ordering.
 *
 * @module openmc-studio/common
 */

import { OpenMCGeometry, OpenMCHexLattice, OpenMCHexOrientation, OpenMCLattice } from './openmc-state-schema';

/** A position in a hexagonal lattice's nested universe array. */
export interface HexRingIndex {
    /** Ring index, 0 = outermost ring. */
    ring: number;
    /** Position within the ring, 0 = top, proceeding clockwise. */
    theta: number;
}

/**
 * Number of universes in each hexagonal ring (outermost first).
 * The center ring has one universe; every other ring has `6 * distance`.
 * @param numRings - Number of rings including the center ring.
 * @returns Ring sizes from the outermost ring inward.
 */
export function hexLatticeRingSizes(numRings: number): number[] {
    const sizes: number[] = [];
    for (let ring = 0; ring < numRings; ring++) {
        sizes.push(Math.max(6 * (numRings - 1 - ring), 1));
    }
    return sizes;
}

/** Total number of universe positions in a 2D hexagonal lattice. */
export function hexLatticeUniverseCount(numRings: number): number {
    return 3 * numRings * numRings - 3 * numRings + 1;
}

/**
 * Row-grouped ring order OpenMC uses in `<hex_lattice><universes>`.
 *
 * Each inner array is one visual row (top to bottom); concatenating the rows
 * gives the flat universe order.
 * @param numRings - Number of rings including the center ring.
 * @param orientation - Hexagon orientation (defaults to 'y').
 * @returns Ring positions grouped by XML row.
 */
export function hexLatticeUniverseRows(numRings: number, orientation: OpenMCHexOrientation = 'y'): HexRingIndex[][] {
    const rowCount = orientation === 'y' ? 1 + 4 * (numRings - 1) : 2 * numRings - 1;
    const middle = orientation === 'y' ? 2 * (numRings - 1) : numRings - 1;
    const rows: HexRingIndex[][] = Array.from({ length: rowCount }, () => []);

    rows[middle] = [{ ring: numRings - 1, theta: 0 }];

    for (let r = 1; r < numRings; r++) {
        const ring = numRings - 1 - r;
        let theta = 0;

        if (orientation === 'y') {
            let y = middle + 2 * r;
            // Climb down the top-right.
            for (let i = 0; i < r; i++) {
                rows[y].push({ ring, theta: theta++ });
                y -= 1;
            }
            // Climb down the right.
            for (let i = 0; i < r; i++) {
                rows[y].push({ ring, theta: theta++ });
                y -= 2;
            }
            // Climb down the bottom-right.
            for (let i = 0; i < r; i++) {
                rows[y].push({ ring, theta: theta++ });
                y -= 1;
            }
            // Climb up the bottom-left.
            for (let i = 0; i < r; i++) {
                rows[y].unshift({ ring, theta: theta++ });
                y += 1;
            }
            // Climb up the left.
            for (let i = 0; i < r; i++) {
                rows[y].unshift({ ring, theta: theta++ });
                y += 2;
            }
            // Climb up the top-left.
            for (let i = 0; i < r; i++) {
                rows[y].unshift({ ring, theta: theta++ });
                y += 1;
            }
        } else {
            let y = middle;
            // Climb down the bottom-right.
            for (let i = 0; i < r; i++) {
                rows[y].push({ ring, theta: theta++ });
                y += 1;
            }
            // Climb left across the bottom.
            for (let i = 0; i < r; i++) {
                rows[y].unshift({ ring, theta: theta++ });
            }
            // Climb up the bottom-left.
            for (let i = 0; i < r; i++) {
                rows[y].unshift({ ring, theta: theta++ });
                y -= 1;
            }
            // Climb up the top-left.
            for (let i = 0; i < r; i++) {
                rows[y].unshift({ ring, theta: theta++ });
                y -= 1;
            }
            // Climb right across the top.
            for (let i = 0; i < r; i++) {
                rows[y].push({ ring, theta: theta++ });
            }
            // Climb down the top-right.
            for (let i = 0; i < r; i++) {
                rows[y].push({ ring, theta: theta++ });
                y += 1;
            }
        }
    }

    return orientation === 'y' ? rows.slice().reverse() : rows;
}

/**
 * Flat universe order OpenMC uses in `<hex_lattice><universes>`.
 *
 * This mirrors `HexLattice._repr_axial_slice_x` / `_repr_axial_slice_y`: the
 * text is a visual top-to-bottom walk of the hexagon, and both the C++ reader
 * and `HexLattice.from_xml_element` consume that order. The same order is used
 * in reverse by {@link reshapeHexLatticeUniverses}, so generation and import
 * can never disagree.
 *
 * @param numRings - Number of rings including the center ring.
 * @param orientation - Hexagon orientation (defaults to 'y').
 * @returns Ring positions in XML order.
 */
export function hexLatticeUniverseOrder(numRings: number, orientation: OpenMCHexOrientation = 'y'): HexRingIndex[] {
    return hexLatticeUniverseRows(numRings, orientation).flat();
}

/**
 * Flatten a rectangular lattice into XML rows (one line per z/y row,
 * x-fastest). The order matches OpenMC's `RectLattice.create_xml_subelement`.
 * @param lattice - Rectangular lattice.
 * @returns Universe IDs grouped by row.
 */
export function flattenRectLatticeUniverses(lattice: OpenMCLattice): number[][] {
    if (lattice.type !== 'rect') {
        return [];
    }
    const [nx, ny, nz = 1] = lattice.dimensions;
    const rows: number[][] = [];
    for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
            const row: number[] = [];
            for (let x = 0; x < nx; x++) {
                row.push(lattice.universes[z]?.[y]?.[x] ?? 0);
            }
            rows.push(row);
        }
    }
    return rows;
}

/**
 * Reshape a flat `<lattice><universes>` list into `[z][y][x]`.
 * @param flat - Universe IDs in XML order.
 * @param dimensions - `[nx, ny]` or `[nx, ny, nz]`.
 * @returns Nested universe array; missing entries fall back to 0.
 */
export function reshapeRectLatticeUniverses(flat: number[], dimensions: [number, number] | [number, number, number]): number[][][] {
    const [nx, ny, nz = 1] = dimensions;
    const universes: number[][][] = [];
    let index = 0;
    for (let z = 0; z < nz; z++) {
        const slice: number[][] = [];
        for (let y = 0; y < ny; y++) {
            const row: number[] = [];
            for (let x = 0; x < nx; x++) {
                row.push(flat[index++] ?? 0);
            }
            slice.push(row);
        }
        universes.push(slice);
    }
    return universes;
}

/**
 * Flatten a hexagonal lattice into OpenMC XML universe order.
 * @param lattice - Hexagonal lattice.
 * @returns Universe IDs in XML order across all axial slices.
 */
export function flattenHexLatticeUniverses(lattice: OpenMCHexLattice): number[] {
    const order = hexLatticeUniverseOrder(lattice.rings, lattice.orientation ?? 'y');
    const axialSlices = Math.max(lattice.nAxial ?? 1, 1);
    const flat: number[] = [];
    for (let z = 0; z < axialSlices; z++) {
        for (const { ring, theta } of order) {
            flat.push(lattice.universes[z]?.[ring]?.[theta] ?? 0);
        }
    }
    return flat;
}

/**
 * Reshape a flat `<hex_lattice><universes>` list into `[z][ring][theta]`.
 * @param flat - Universe IDs in XML order.
 * @param numRings - Number of rings including the center ring.
 * @param orientation - Hexagon orientation.
 * @param numAxial - Number of axial slices (1 for 2D).
 * @returns Nested universe array; missing entries fall back to 0.
 */
export function reshapeHexLatticeUniverses(
    flat: number[],
    numRings: number,
    orientation: OpenMCHexOrientation,
    numAxial = 1
): number[][][] {
    const order = hexLatticeUniverseOrder(numRings, orientation);
    const sizes = hexLatticeRingSizes(numRings);
    const universes: number[][][] = [];
    let index = 0;
    for (let z = 0; z < Math.max(numAxial, 1); z++) {
        const rings: number[][] = sizes.map((size) => new Array<number>(size).fill(0));
        for (const { ring, theta } of order) {
            rings[ring][theta] = flat[index++] ?? 0;
        }
        universes.push(rings);
    }
    return universes;
}

/**
 * Resize a rectangular lattice's universe array to its dimensions, preserving
 * existing values and filling new positions with universe 0.
 * @param universes - Current `[z][y][x]` array.
 * @param dimensions - Target `[nx, ny]` or `[nx, ny, nz]`.
 * @returns A new nested array with the target shape.
 */
export function resizeRectLatticeUniverses(universes: number[][][], dimensions: [number, number] | [number, number, number]): number[][][] {
    const [nx, ny, nz = 1] = dimensions;
    const next: number[][][] = [];
    for (let z = 0; z < nz; z++) {
        const slice: number[][] = [];
        for (let y = 0; y < ny; y++) {
            const row: number[] = [];
            for (let x = 0; x < nx; x++) {
                row.push(universes[z]?.[y]?.[x] ?? 0);
            }
            slice.push(row);
        }
        next.push(slice);
    }
    return next;
}

/**
 * Resize a hexagonal lattice's universe array to its ring/axial shape,
 * preserving existing values and filling new positions with universe 0.
 * @param universes - Current `[z][ring][theta]` array.
 * @param numRings - Target number of rings including the center ring.
 * @param numAxial - Target number of axial slices (1 for 2D).
 * @returns A new nested array with the target shape.
 */
export function resizeHexLatticeUniverses(universes: number[][][], numRings: number, numAxial = 1): number[][][] {
    const sizes = hexLatticeRingSizes(numRings);
    const next: number[][][] = [];
    for (let z = 0; z < Math.max(numAxial, 1); z++) {
        const rings: number[][] = sizes.map((size, ring) => {
            const entries: number[] = [];
            for (let theta = 0; theta < size; theta++) {
                entries.push(universes[z]?.[ring]?.[theta] ?? 0);
            }
            return entries;
        });
        next.push(rings);
    }
    return next;
}

/** Runtime shape of a lattice loaded from an older project file. */
interface LegacyLatticeShape {
    type?: string;
    orientation?: string;
    axial?: { pitch?: number; offset?: number; nStacks?: number };
    pitch?: number[];
    dimensions?: number[];
    universes?: number[][][];
    [key: string]: unknown;
}

/**
 * Normalize one lattice loaded from a project file.
 *
 * Older projects used `x-hex`/`y-hex` types and an `axial` sub-object instead of
 * the OpenMC-native `orientation` and `nAxial` fields. Rectangular universe
 * arrays used to be written bottom-up as `[y][x][z]`; those are transposed to
 * `[z][y][x]` when the shape is unambiguous.
 * @param lattice - Lattice as parsed from disk.
 * @returns The canonical lattice.
 */
export function normalizeLatticeForLoad(lattice: OpenMCLattice): OpenMCLattice {
    const legacy = lattice as unknown as LegacyLatticeShape;
    const normalized = { ...legacy } as LegacyLatticeShape;

    if (legacy.type === 'x-hex' || legacy.type === 'y-hex') {
        normalized.type = 'hex';
        normalized.orientation = legacy.type === 'x-hex' ? 'x' : 'y';
    }

    if (normalized.type === 'hex' && legacy.axial) {
        const radialPitch = Array.isArray(legacy.pitch) ? legacy.pitch[0] : undefined;
        const axialPitch = legacy.axial.pitch;
        if (radialPitch !== undefined && axialPitch !== undefined) {
            normalized.pitch = [radialPitch, axialPitch];
        }
        if (legacy.axial.nStacks !== undefined) {
            normalized.nAxial = legacy.axial.nStacks;
        }
        delete normalized.axial;
    }

    if (
        normalized.type === 'hex' &&
        !(typeof normalized.rings === 'number' && Number.isInteger(normalized.rings) && normalized.rings > 0) &&
        Array.isArray(legacy.universes)
    ) {
        // Legacy files always stored one ring list per array level; the 2D
        // ring count is the length of the first axial slice.
        const firstSlice = legacy.universes[0];
        if (Array.isArray(firstSlice)) {
            normalized.rings = firstSlice.length;
        }
    }

    if (normalized.type === 'rect' && Array.isArray(legacy.dimensions) && Array.isArray(legacy.universes)) {
        const [nx, ny, nz = 1] = legacy.dimensions;
        const universes = legacy.universes;
        const canonicalShape = universes.length === nz && universes[0]?.length === ny;
        const legacyShape = universes.length === ny && universes[0]?.length === nx;
        if (!canonicalShape && legacyShape) {
            const transposed: number[][][] = [];
            for (let z = 0; z < nz; z++) {
                const slice: number[][] = [];
                for (let y = 0; y < ny; y++) {
                    const row: number[] = [];
                    for (let x = 0; x < nx; x++) {
                        // Legacy arrays ran bottom-up; the canonical y index
                        // runs top-down (OpenMC's universes[0] is the top row).
                        row.push(universes[ny - 1 - y]?.[x]?.[z] ?? 0);
                    }
                    slice.push(row);
                }
                transposed.push(slice);
            }
            normalized.universes = transposed;
        }
    }

    return normalized as unknown as OpenMCLattice;
}

/**
 * Normalize geometry loaded from a project file: strip the retired `isRoot`
 * flag, default the root universe ID, and canonicalize lattices.
 * @param geometry - Geometry as parsed from disk.
 * @returns Geometry at the current canonical representation.
 */
export function normalizeGeometryForLoad(geometry: OpenMCGeometry): OpenMCGeometry {
    const universes = (geometry.universes ?? []).map((universe) => {
        const normalized = { ...universe };
        delete (normalized as { isRoot?: boolean }).isRoot;
        return normalized;
    });
    return {
        ...geometry,
        universes,
        lattices: (geometry.lattices ?? []).map(normalizeLatticeForLoad),
        rootUniverseId: geometry.rootUniverseId ?? 0
    };
}
