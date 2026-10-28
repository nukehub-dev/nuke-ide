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
 * Generic probe model for the native 3D viewers: map a raycast hit back
 * to the dataset tuple it represents, sample the active numeric array, and
 * serialize point/line probe results.
 *
 * The viewer renders several geometry families from the same parsed dataset
 * ({@link ProbeTopology}); each family reports a different hit index:
 *
 * | hit kind      | cell tuple                     | point tuple                                  |
 * | ------------- | ------------------------------ | -------------------------------------------- |
 * | `mesh`        | `triangleCells[faceIndex]`     | nearest corner of `triangles[faceIndex*3..]` |
 * | `mesh-points` | `triangleCells[floor(i/3)]`    | `triangles[i]`                               |
 * | `lines`       | `segmentCells[floor(i/2)]`     | `segments[i]`                                |
 * | `line-points` | `segmentCells[floor(i/2)]`     | `segments[i]`                                |
 * | `voxel`       | `voxelCells[instanceId]`       | same (grid point arrays are cell-centered)   |
 * | `grid-points` | `pointIndex * stride`          | same (cell-centered grid preview)            |
 * | `points`      | undefined                      | `pointIndex * stride`                        |
 *
 * `stride` is the point-cloud decimation factor (`strideForBudget`), so a hit
 * on a decimated cloud maps back to the source tuple. Point coordinates in
 * `positions` stay xyz triplets; only triangle-corner lookup reads them.
 *
 * All resolvers are total: missing arrays, negative/fractional/out-of-range
 * indices, and non-finite coordinates yield `undefined` instead of throwing.
 * `sampleProbeValue` applies the same rule to missing/short data and uses the
 * L2 magnitude for multi-component arrays when no component is selected.
 *
 * Pure functions + types only; no three.js, DOM, Theia, or tally imports.
 */

/** Which dataset tuples an association reads. */
export type ProbeAssociation = 'point' | 'cell';

/** Default line-profile sample count (matches `base.probe --samples`). */
export const PROBE_DEFAULT_SAMPLES = 100;

/** Minimum line-profile sample count (backend bound). */
export const PROBE_MIN_SAMPLES = 2;

/** Maximum line-profile sample count (backend bound). */
export const PROBE_MAX_SAMPLES = 10000;

/** Visible point-probe history cap (CSV exports every retained sample). */
export const PROBE_SAMPLE_ROW_CAP = 100;

/** One point-probe row: world position plus the sampled tuple/value. */
export interface ProbeSample {
    readonly position: readonly [number, number, number];
    readonly association?: ProbeAssociation;
    readonly array?: string;
    readonly tuple?: number;
    readonly value?: number;
}

/**
 * Flattened render topology a raycast hit maps back onto. `positions` holds
 * xyz triplets (surface/line/point vertices, or grid cell centers) and
 * `nPoints` counts source points (polydata) or grid cells.
 */
export interface ProbeTopology {
    readonly positions: ArrayLike<number>;
    readonly nPoints: number;
    /** Point-cloud decimation factor (1 = undecimated). */
    readonly stride: number;
    /** Triangle point-index triples for surface meshes. */
    readonly triangles?: ArrayLike<number>;
    /** Global cell index per triangle. */
    readonly triangleCells?: ArrayLike<number>;
    /** Line-segment point-index pairs. */
    readonly segments?: ArrayLike<number>;
    /** Global cell index per rendered segment (VTK cell data order). */
    readonly segmentCells?: ArrayLike<number>;
    /** Global cell index per rendered voxel instance. */
    readonly voxelCells?: ArrayLike<number>;
}

/** One raycast hit, classified by the object the ray crossed. */
export interface ProbeHit {
    readonly position: readonly [number, number, number];
    readonly kind: 'mesh' | 'mesh-points' | 'lines' | 'line-points' | 'points' | 'grid-points' | 'voxel';
    /** Triangle index for `mesh` (three.js non-indexed `faceIndex`). */
    readonly faceIndex?: number;
    /** Corner/vertex index in the rendered buffer for the points/line kinds. */
    readonly pointIndex?: number;
    /** Voxel instance index for `voxel`. */
    readonly instanceId?: number;
}

/** One numeric array offered to the probe (flattened tuples of `components`). */
export interface ProbeArray {
    readonly association: ProbeAssociation;
    readonly name: string;
    readonly components: number;
    readonly values: ArrayLike<number>;
}

/** Array-picker entry for the probe dialog (no values; the viewer owns them). */
export interface ProbeArrayOption {
    readonly association: ProbeAssociation;
    readonly name: string;
    readonly components: number;
}

/** One sampled point on a line profile. */
export interface ProbeLinePoint {
    readonly distance: number;
    readonly position: readonly [number, number, number];
    readonly value: number | null;
    readonly valid: boolean;
}

/** A finished line profile from `base.probe` (path mode). */
export interface ProbeLineResult {
    readonly array: string;
    readonly association: ProbeAssociation;
    readonly series: readonly ProbeLinePoint[];
    readonly length?: number;
    readonly dataRange?: readonly [number, number];
}

// ============================================================================
// Tuple resolution
// ============================================================================

function isIndex(value: number | undefined): value is number {
    return value !== undefined && Number.isInteger(value) && value >= 0;
}

/** Number of source tuples; malformed counts behave as empty. */
function sourceCount(value: number): number {
    return Number.isInteger(value) && value > 0 ? value : 0;
}

/** Decimation stride normalized to a positive integer (1 when malformed). */
function sourceStride(value: number): number {
    return Number.isInteger(value) && value >= 1 ? value : 1;
}

/** Cell array lookup; missing arrays and malformed cells yield undefined. */
function cellAt(cells: ArrayLike<number> | undefined, index: number | undefined): number | undefined {
    if (!cells || !isIndex(index) || index >= cells.length) {
        return undefined;
    }
    const cell = cells[index];
    return isIndex(cell) ? cell : undefined;
}

/** Point-index table lookup (`triangles`/`segments`), bounded by `nPoints`. */
function pointAt(points: ArrayLike<number> | undefined, index: number | undefined, nPoints: number): number | undefined {
    if (!points || !isIndex(index) || index >= points.length) {
        return undefined;
    }
    const point = points[index];
    return isIndex(point) && point < nPoints ? point : undefined;
}

/** Source tuple for a hit on the decimated point cloud. */
function cloudTuple(index: number | undefined, nPoints: number, stride: number): number | undefined {
    if (!isIndex(index)) {
        return undefined;
    }
    const tuple = index * stride;
    return Number.isSafeInteger(tuple) && tuple < nPoints ? tuple : undefined;
}

/**
 * Nearest of the three triangle corners to a hit position. Corner entries are
 * source point indices, so positions are read as xyz triplets. Non-finite
 * positions are skipped; a tie keeps the first corner.
 */
function nearestTriangleCorner(
    topology: ProbeTopology,
    faceIndex: number | undefined,
    hitPosition: readonly [number, number, number]
): number | undefined {
    const triangles = topology.triangles;
    const positions = topology.positions;
    if (!triangles || !positions || !isIndex(faceIndex) || !hitPosition) {
        return undefined;
    }
    const base = faceIndex * 3;
    if (base + 2 >= triangles.length) {
        return undefined;
    }
    const nPoints = sourceCount(topology.nPoints);
    let best: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let corner = 0; corner < 3; corner++) {
        const point = triangles[base + corner];
        if (!isIndex(point) || point >= nPoints) {
            continue;
        }
        const offset = point * 3;
        if (offset + 2 >= positions.length) {
            continue;
        }
        const dx = positions[offset] - hitPosition[0];
        const dy = positions[offset + 1] - hitPosition[1];
        const dz = positions[offset + 2] - hitPosition[2];
        const distance = dx * dx + dy * dy + dz * dz;
        if (Number.isFinite(distance) && distance < bestDistance) {
            bestDistance = distance;
            best = point;
        }
    }
    return best;
}

/**
 * Resolve the tuple an active array should read for a raycast hit.
 * Returns undefined for any missing/malformed/out-of-range input; never
 * throws and never mutates the topology or hit.
 */
export function resolveProbeTuple(topology: ProbeTopology, hit: ProbeHit, association: ProbeAssociation): number | undefined {
    if (!topology || !hit) {
        return undefined;
    }
    const nPoints = sourceCount(topology.nPoints);
    const stride = sourceStride(topology.stride);
    switch (hit.kind) {
        case 'mesh':
            return association === 'cell'
                ? cellAt(topology.triangleCells, hit.faceIndex)
                : nearestTriangleCorner(topology, hit.faceIndex, hit.position);
        case 'mesh-points':
            if (association === 'cell') {
                return isIndex(hit.pointIndex) ? cellAt(topology.triangleCells, Math.floor(hit.pointIndex / 3)) : undefined;
            }
            return pointAt(topology.triangles, hit.pointIndex, nPoints);
        case 'lines':
        case 'line-points':
            if (association === 'cell') {
                return isIndex(hit.pointIndex) ? cellAt(topology.segmentCells, Math.floor(hit.pointIndex / 2)) : undefined;
            }
            return pointAt(topology.segments, hit.pointIndex, nPoints);
        case 'voxel':
            // Grid point arrays are cell-centered in this viewer: both
            // associations read the voxel's cell tuple.
            return cellAt(topology.voxelCells, hit.instanceId);
        case 'grid-points':
            // Cell-centered grid preview: the cloud instance maps back to
            // the source tuple for both associations.
            return cloudTuple(hit.pointIndex, nPoints, stride);
        case 'points':
            return association === 'point' ? cloudTuple(hit.pointIndex, nPoints, stride) : undefined;
        default:
            return undefined;
    }
}

// ============================================================================
// Sampling
// ============================================================================

/**
 * Read one tuple scalar. `component` picks a single 0-based component; a
 * negative integer or omitted component uses the L2 magnitude for
 * multi-component arrays (single-component arrays pass through).
 * Out-of-range/non-finite components, short/malformed arrays, and non-finite
 * values return undefined.
 */
export function sampleProbeValue(array: ProbeArray, tuple: number, component?: number): number | undefined {
    if (!array || !array.values) {
        return undefined;
    }
    const components = array.components;
    if (!Number.isInteger(components) || components < 1) {
        return undefined;
    }
    if (!isIndex(tuple) || tuple >= Math.floor(array.values.length / components)) {
        return undefined;
    }
    const offset = tuple * components;
    if (component !== undefined) {
        if (!Number.isInteger(component)) {
            return undefined;
        }
        if (component >= 0) {
            if (component >= components) {
                return undefined;
            }
            const value = array.values[offset + component];
            return Number.isFinite(value) ? value : undefined;
        }
    }
    if (components === 1) {
        const value = array.values[offset];
        return Number.isFinite(value) ? value : undefined;
    }
    let sum = 0;
    for (let c = 0; c < components; c++) {
        const value = array.values[offset + c];
        if (!Number.isFinite(value)) {
            return undefined;
        }
        sum += value * value;
    }
    return Number.isFinite(sum) ? Math.sqrt(sum) : undefined;
}

// ============================================================================
// CSV
// ============================================================================

/** RFC 4180 field: quote only when a delimiter/quote/newline is present. */
function csvField(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Full-precision numeric CSV cell; non-finite values export blank. */
function csvNumber(value: number): string {
    return Number.isFinite(value) ? String(value) : '';
}

/** Optional numeric CSV cell; missing/non-finite values export blank. */
function csvOptionalNumber(value: number | undefined): string {
    return value !== undefined && Number.isFinite(value) ? String(value) : '';
}

/**
 * Serialize point-probe samples to CSV (`x,y,z,association,array,tuple,value`)
 * plus a trailing newline. Optional fields are blank when absent, numbers are
 * full precision, and names needing it are quoted.
 */
export function probeSamplesToCsv(samples: readonly ProbeSample[]): string {
    const lines = ['x,y,z,association,array,tuple,value'];
    for (const sample of samples ?? []) {
        const [x, y, z] = sample.position;
        lines.push(
            [
                csvNumber(x),
                csvNumber(y),
                csvNumber(z),
                sample.association ?? '',
                sample.array ?? '',
                isIndex(sample.tuple) ? String(sample.tuple) : '',
                csvOptionalNumber(sample.value)
            ]
                .map(csvField)
                .join(',')
        );
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Serialize a line profile to CSV (`distance,x,y,z,value`) plus a trailing
 * newline. Invalid samples (null value) export a blank value cell.
 */
export function probeLineToCsv(result: ProbeLineResult): string {
    const lines = ['distance,x,y,z,value'];
    for (const point of result?.series ?? []) {
        lines.push(
            [
                csvNumber(point.distance),
                csvNumber(point.position[0]),
                csvNumber(point.position[1]),
                csvNumber(point.position[2]),
                csvOptionalNumber(point.value ?? undefined)
            ]
                .map(csvField)
                .join(',')
        );
    }
    return `${lines.join('\n')}\n`;
}

// ============================================================================
// Display + input helpers
// ============================================================================

/** Compact 4-significant-digit display value; missing/non-finite as an em dash. */
export function formatProbeValue(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '—';
    }
    if (value === 0) {
        return '0';
    }
    return Number(value.toPrecision(4)).toString();
}

/** Parse one coordinate: finite numbers only, anything else is undefined. */
function parseProbeCoordinate(text: string): number | undefined {
    const trimmed = text.trim();
    if (trimmed === '') {
        return undefined;
    }
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : undefined;
}

/** Parse `x, y, z` or `x y z` (semicolons also work) into a finite point. */
export function parseProbePoint(text: string): readonly [number, number, number] | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }
    const parts = text.split(/[\s,;]+/).filter((part) => part !== '');
    if (parts.length !== 3) {
        return undefined;
    }
    const x = parseProbeCoordinate(parts[0]);
    const y = parseProbeCoordinate(parts[1]);
    const z = parseProbeCoordinate(parts[2]);
    if (x === undefined || y === undefined || z === undefined) {
        return undefined;
    }
    return [x, y, z];
}

/** Format an endpoint for the text inputs (full-precision round-trip). */
export function formatProbePoint(point: readonly [number, number, number]): string {
    return `${point[0]}, ${point[1]}, ${point[2]}`;
}

/** Clamp a sample count into 2..10000; non-finite falls back to 100. */
export function clampProbeSamples(value: number): number {
    if (!Number.isFinite(value)) {
        return PROBE_DEFAULT_SAMPLES;
    }
    return Math.min(PROBE_MAX_SAMPLES, Math.max(PROBE_MIN_SAMPLES, Math.floor(value)));
}

/** True when all three coordinates exist and are finite. */
function isFinitePoint(point: readonly [number, number, number] | undefined): boolean {
    return point !== undefined && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

/**
 * Default line-profile endpoints: the X-axis span through the dataset center,
 * so the first run shows a full-width profile without typing. Without usable
 * bounds, the unit diagonal keeps the panel usable before a dataset loads.
 */
export function defaultProbeEndpoints(
    bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } | undefined
): { readonly p0: readonly [number, number, number]; readonly p1: readonly [number, number, number] } {
    if (!bounds || !isFinitePoint(bounds.min) || !isFinitePoint(bounds.max)) {
        return { p0: [0, 0, 0], p1: [1, 1, 1] };
    }
    const midY = (bounds.min[1] + bounds.max[1]) / 2;
    const midZ = (bounds.min[2] + bounds.max[2]) / 2;
    return {
        p0: [bounds.min[0], midY, midZ],
        p1: [bounds.max[0], midY, midZ]
    };
}
