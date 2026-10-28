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
 * Build highlight geometry for a Find Data selection.
 *
 * The dialog/query layer returns tuple indices. This module turns those
 * indices into plain positions/indices for the viewer to wrap in
 * `THREE.Points`, `THREE.Mesh`, or `THREE.LineSegments`. It never touches
 * three.js, the DOM, or the dataset itself.
 *
 * Cell selections on triangle soups expand to the selected triangles; line
 * cells expand to their segments; vertex cells expand to points. Grid cell
 * selections highlight the cell centers (the native grid stores cell-center
 * positions). Point selections highlight the selected vertices.
 */

/** Minimal model surface needed to build a selection overlay. */
export interface SelectionOverlaySource {
    readonly positions: ArrayLike<number>;
    readonly family: 'polydata' | 'rectilinear' | 'image';
    readonly pointCount: number;
    readonly cellCount: number;
    readonly triangles?: ArrayLike<number>;
    readonly triangleCells?: ArrayLike<number>;
    readonly segments?: ArrayLike<number>;
    readonly segmentCells?: ArrayLike<number>;
    readonly vertices?: ArrayLike<number>;
}

/** Plain highlight geometry in world coordinates. */
export interface SelectionOverlay {
    /** Selected point positions (xyz xyz ...) for point/vertex/grid selections. */
    readonly points?: Float32Array;
    /** Triangle indices into `points` for selected triangle cells. */
    readonly triangles?: Uint32Array;
    /** Segment index pairs into `points` for selected line cells. */
    readonly segments?: Uint32Array;
}

function selectedSet(indices: ArrayLike<number>): Set<number> {
    const set = new Set<number>();
    for (let i = 0; i < indices.length; i++) {
        const value = indices[i];
        if (Number.isInteger(value) && value >= 0) {
            set.add(value);
        }
    }
    return set;
}

function pointPosition(source: SelectionOverlaySource, point: number): [number, number, number] | undefined {
    if (point < 0 || point * 3 + 2 >= source.positions.length) {
        return undefined;
    }
    return [source.positions[point * 3], source.positions[point * 3 + 1], source.positions[point * 3 + 2]];
}

/**
 * Build the overlay for one selection. Returns undefined when no valid
 * tuples remain (empty selection, out-of-range indices, or unsupported cell
 * types). The caller owns the returned arrays.
 */
export function buildSelectionOverlay(
    source: SelectionOverlaySource,
    association: 'point' | 'cell',
    indices: ArrayLike<number>
): SelectionOverlay | undefined {
    const selected = selectedSet(indices);
    if (selected.size === 0) {
        return undefined;
    }

    if (association === 'point') {
        const positions: number[] = [];
        for (const point of selected) {
            const position = pointPosition(source, point);
            if (position) {
                positions.push(...position);
            }
        }
        return positions.length > 0 ? { points: new Float32Array(positions) } : undefined;
    }

    const triangles = source.triangles;
    const triangleCells = source.triangleCells;
    if (triangles && triangleCells && triangles.length > 0) {
        const points: number[] = [];
        const local = new Map<number, number>();
        const out: number[] = [];
        for (let t = 0; t + 2 < triangles.length; t += 3) {
            const cell = triangleCells[t / 3];
            if (cell === undefined || !selected.has(cell)) {
                continue;
            }
            const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
            let complete = true;
            const mapped: number[] = [];
            for (const id of ids) {
                const position = pointPosition(source, id);
                if (!position) {
                    complete = false;
                    break;
                }
                let index = local.get(id);
                if (index === undefined) {
                    index = points.length / 3;
                    local.set(id, index);
                    points.push(...position);
                }
                mapped.push(index);
            }
            if (complete) {
                out.push(mapped[0], mapped[1], mapped[2]);
            }
        }
        if (out.length > 0) {
            return { points: new Float32Array(points), triangles: new Uint32Array(out) };
        }
    }

    const segments = source.segments;
    const segmentCells = source.segmentCells;
    if (segments && segmentCells && segments.length > 0) {
        const points: number[] = [];
        const out: number[] = [];
        for (let s = 0; s + 1 < segments.length; s += 2) {
            const cell = segmentCells[s / 2];
            if (cell === undefined || !selected.has(cell)) {
                continue;
            }
            const a = pointPosition(source, segments[s]);
            const b = pointPosition(source, segments[s + 1]);
            if (!a || !b) {
                continue;
            }
            out.push(points.length / 3, points.length / 3 + 1);
            points.push(...a, ...b);
        }
        if (out.length > 0) {
            return { points: new Float32Array(points), segments: new Uint32Array(out) };
        }
    }

    // Vertex cells and grid cell centers: highlight the selected cell's
    // position directly. Grid positions are cell centers; polydata vertex
    // cells are points at the same index.
    const positions: number[] = [];
    for (const cell of selected) {
        if (cell < 0 || cell >= source.cellCount) {
            continue;
        }
        let point = cell;
        if (source.family === 'polydata' && source.vertices && source.vertices.length > 0) {
            // VTK cell order is verts-first in the native parser: vertex
            // cell `n` maps through `vertices[n]`. Only fall back when the
            // selected cell is actually a vertex cell.
            if (cell < source.vertices.length) {
                point = source.vertices[cell];
            }
        }
        const position = pointPosition(source, point);
        if (position) {
            positions.push(...position);
        }
    }
    return positions.length > 0 ? { points: new Float32Array(positions) } : undefined;
}
