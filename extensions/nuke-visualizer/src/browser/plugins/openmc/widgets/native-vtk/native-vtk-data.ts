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
 * Pure helpers for the native VTK viewer (P1-B2 of the trame-to-frontend
 * migration, P6 format gap closed): color-by parsing, array classification
 * for the dataset kinds the viewer renders (tracks `.vtp` polylines,
 * collision `.vtp` points, weight-windows `.vtr` rectilinear grids, voxel
 * `.vti` image data, plus DAGMC/STEP/FEM outputs: legacy ASCII `.vtk`
 * PolyData/UnstructuredGrid, XML `.vtu` UnstructuredGrid, `.vts`
 * StructuredGrid), the full ParaView-style colormap LUT pack (re-exported
 * from `viewer-core/colormaps.ts`), point-budget decimation, and
 * dependency-free VTK readers.
 *
 * No DOM, DI, or three.js dependencies — unit-testable in node. The XML
 * reader is hand-rolled (rather than three.js `VTKLoader`, which only
 * carries PolyData) so every XML kind parses through one path with named
 * point/cell arrays and ranges preserved for instant client-side color-by.
 * It handles `ascii` and `appended` DataArray encodings; appended blocks
 * may be raw or zlib compressed — decompression is synchronous fflate
 * inflate (no platform DecompressionStream dependency), available in every
 * runtime including headless shells. The legacy reader handles ASCII
 * `DATASET POLYDATA` and `DATASET UNSTRUCTURED_GRID` (binary legacy files
 * are detected and rejected with an ASCII-only error). Unstructured grids decode to the
 * `polydata` family (triangle edges in `segments`, mesh triples in
 * `triangles`); structured grids decode to the `rectilinear` family (cell
 * centers plus `gridDimensions`).
 */

import type { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import type { ColormapName } from '../../../../viewer-core/colormaps';
import { tupleScalar } from '../../../../viewer-core/scalar-mapping';
import { inflateSync, unzlibSync } from 'fflate';

// ============================================================================
// Dataset kinds
// ============================================================================

/** VTK dataset families the native viewer renders. */
export type NativeVtkDatasetFamily = 'polydata' | 'rectilinear' | 'image';

/**
 * File extensions the native probe accepts: XML kinds (`.vtp`/`.vtr`/`.vti`
 * plus `.vtu`/`.vts`) and legacy ASCII `.vtk` (PolyData/UnstructuredGrid).
 */
export const NATIVE_PROBE_EXTENSIONS = ['.vtp', '.vtr', '.vti', '.vtu', '.vts', '.vtk'] as const;

/** One of the probe-accepted file extensions. */
export type NativeProbeExtension = (typeof NATIVE_PROBE_EXTENSIONS)[number];

/**
 * Detect the dataset family from an `openmc.vtk-info` type string (e.g.
 * `vtkPolyData`) or a file extension. Unstructured grids (`.vtu`) render
 * through the `polydata` path (triangle edges/mesh); structured grids
 * (`.vts`) render through the `rectilinear` path (cell centers plus grid
 * dimensions); legacy `.vtk` files are polydata-shaped pending parse.
 * Returns undefined when unknown.
 */
export function detectNativeVtkFamily(vtkType: string, fileExtension: string): NativeVtkDatasetFamily | undefined {
    const type = vtkType.toLowerCase();
    const ext = fileExtension.toLowerCase();
    if (type.includes('rectilinear') || ext === '.vtr') {
        return 'rectilinear';
    }
    // 'unstructured' contains 'structured' — check it first.
    if (type.includes('unstructured') || ext === '.vtu') {
        return 'polydata';
    }
    if (type.includes('structured') || ext === '.vts') {
        return 'rectilinear';
    }
    if (type.includes('imagedata') || ext === '.vti') {
        return 'image';
    }
    if (type.includes('polydata') || ext === '.vtp') {
        return 'polydata';
    }
    if (type.includes('unstructured') || ext === '.vtu') {
        return 'polydata';
    }
    if (ext === '.vtk') {
        return 'polydata';
    }
    return undefined;
}

// ============================================================================
// Color-by values ('Solid Color|Point: <name>|Cell: <name>', base.serve format)
// ============================================================================

/** Solid-color selection: no data array is mapped. */
export const SOLID_COLOR = 'Solid Color';

/** Parsed form of a color-by selection. */
export type ColorBySelection = { kind: 'solid' } | { kind: 'point' | 'cell'; name: string };

const COLOR_BY_RE = /^(Point|Cell):\s*(.+)$/;

/** Parse a color-by string; returns undefined for empty/unknown values. */
export function parseColorBy(value: string | undefined): ColorBySelection | undefined {
    if (value === undefined) {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed === SOLID_COLOR) {
        return { kind: 'solid' };
    }
    const match = COLOR_BY_RE.exec(trimmed);
    if (!match) {
        return undefined;
    }
    return { kind: match[1].toLowerCase() as 'point' | 'cell', name: match[2].trim() };
}

/** Format the color-by value for an array (matches `base.serve --color-by`). */
export function formatColorBy(association: 'point' | 'cell', name: string): string {
    return `${association === 'point' ? 'Point' : 'Cell'}: ${name}`;
}

/** The color-by value for an `OpenMCVtkArrayInfo` (random-ray-arrays parity). */
export function colorByValue(array: OpenMCVtkArrayInfo): string {
    return formatColorBy(array.association, array.name);
}

// ============================================================================
// Array classification (quick-select groups for the four P1 dataset kinds)
// ============================================================================

/** One weight-window energy group: the `lower_g<i>`/`upper_g<i>` cell pair. */
export interface WeightWindowGroup {
    group: number;
    /** Multi-window prefix (`ww<id>_`) or '' for single-window files. */
    prefix: string;
    lower?: OpenMCVtkArrayInfo;
    upper?: OpenMCVtkArrayInfo;
}

/** VTK arrays classified for the native viewer's quick-select bar. */
export interface ClassifiedNativeVtkArrays {
    /** Energy-like scalars (`energy`, `energies`, `energyLosses`, ...) */
    energies: OpenMCVtkArrayInfo[];
    /** Other continuous scalars (time, weight, ...) */
    scalars: OpenMCVtkArrayInfo[];
    /** Discrete identifiers (cell/pdg/batch/mt/material ids, ...) */
    ids: OpenMCVtkArrayInfo[];
    /** Per-group flux arrays (`flux_group_<i>`), sorted by group index */
    fluxGroups: OpenMCVtkArrayInfo[];
    /** Weight-window `lower/upper_g<i>` pairs, sorted by group index */
    windowGroups: WeightWindowGroup[];
    /** Fission/external source arrays */
    sources: OpenMCVtkArrayInfo[];
    /** Everything else */
    other: OpenMCVtkArrayInfo[];
}

const FLUX_GROUP_RE = /^flux_(?:group_|g)(\d+)$/i;
const WINDOW_ARRAY_RE = /^(?:(ww\d+)_)?(lower|upper)_g(\d+)$/i;
const ENERGY_RE = /energ/i;
const SCALAR_RE = /^(times?|weights?|de|delta_?e)$/i;

/** Array names treated as source/fission quantities (lowercased). */
const SOURCE_ARRAY_NAMES = new Set(['total_fission_source', 'external_source', 'fission_source', 'fission', 'source']);

/** Array names treated as domain/material identifiers (lowercased). */
const ID_ARRAY_NAMES = new Set([
    'fsrs',
    'fsr',
    'materials',
    'material',
    'materialid',
    'materialids',
    'cell_id',
    'cellid',
    'cellids',
    'cell',
    'nuclide_id',
    'nuclideid',
    'nuclideids',
    'nuclide',
    'event_mt',
    'eventmt',
    'mt',
    'pdg',
    'batch',
    'generation',
    'particle_id',
    'particleid',
    'particle',
    'particles',
    'track_index',
    'trackindex',
    'id'
]);

/** Group index of a flux array name, or -1 when it is not a flux group array. */
export function fluxGroupIndex(name: string): number {
    const match = FLUX_GROUP_RE.exec(name);
    return match ? parseInt(match[1], 10) : -1;
}

/** Classify VTK arrays into quick-select groups for the native viewer. */
export function classifyNativeVtkArrays(arrays: readonly OpenMCVtkArrayInfo[]): ClassifiedNativeVtkArrays {
    const result: ClassifiedNativeVtkArrays = {
        energies: [],
        scalars: [],
        ids: [],
        fluxGroups: [],
        windowGroups: [],
        sources: [],
        other: []
    };
    const windows = new Map<string, WeightWindowGroup>();
    for (const array of arrays) {
        const lowered = array.name.toLowerCase();
        const windowMatch = WINDOW_ARRAY_RE.exec(array.name);
        if (windowMatch) {
            const prefix = windowMatch[1] ?? '';
            const group = parseInt(windowMatch[3], 10);
            const key = `${prefix}g${group}`;
            let entry = windows.get(key);
            if (!entry) {
                entry = { group, prefix };
                windows.set(key, entry);
            }
            if (windowMatch[2].toLowerCase() === 'lower') {
                entry.lower = array;
            } else {
                entry.upper = array;
            }
            continue;
        }
        if (fluxGroupIndex(array.name) >= 0) {
            result.fluxGroups.push(array);
        } else if (SOURCE_ARRAY_NAMES.has(lowered)) {
            result.sources.push(array);
        } else if (ID_ARRAY_NAMES.has(lowered)) {
            result.ids.push(array);
        } else if (ENERGY_RE.test(array.name)) {
            result.energies.push(array);
        } else if (SCALAR_RE.test(lowered)) {
            result.scalars.push(array);
        } else {
            result.other.push(array);
        }
    }
    result.fluxGroups.sort((a, b) => fluxGroupIndex(a.name) - fluxGroupIndex(b.name));
    result.windowGroups = [...windows.values()].sort((a, b) => a.group - b.group || (a.prefix < b.prefix ? -1 : 1));
    return result;
}

/**
 * Pick the default color-by: first energy scalar, else first flux group, else
 * the first weight-window lower bound, else first scalar/source/id/other.
 * Rectilinear grids prefer the window-group lower bound.
 */
export function defaultNativeColorBy(classified: ClassifiedNativeVtkArrays, family: NativeVtkDatasetFamily): string | undefined {
    if (family === 'rectilinear' && classified.windowGroups.length > 0) {
        const first = classified.windowGroups[0];
        const array = first.lower ?? first.upper;
        if (array) {
            return colorByValue(array);
        }
    }
    const first =
        classified.energies[0] ??
        classified.fluxGroups[0] ??
        classified.windowGroups[0]?.lower ??
        classified.windowGroups[0]?.upper ??
        classified.scalars[0] ??
        classified.sources[0] ??
        classified.ids[0] ??
        classified.other[0];
    return first ? colorByValue(first) : undefined;
}

// ============================================================================
// Colormaps (full LUT pack + scalar mapping from viewer-core)
// ============================================================================

export { COLORMAP_NAMES as NATIVE_VTK_COLORMAPS } from '../../../../viewer-core/colormaps';
export type { ColormapName, ColormapName as NativeVtkColormapName } from '../../../../viewer-core/colormaps';

/** Default colormap for freshly opened datasets (the old trame-era default). */
export const DEFAULT_COLORMAP: ColormapName = 'Cool to Warm';

// ============================================================================
// Point budget (decimation stride for large clouds/grids)
// ============================================================================

/** Default cap for natively rendered points (CAD 2M-triangle budget thinking). */
export const NATIVE_VTK_POINT_BUDGET = 200000;

// Voxel layout + instancing live in viewer-core (shared with the DAGMC
// drape interior); re-exported here so existing imports keep working.
export { buildVoxelMesh, NATIVE_VTK_VOXEL_BUDGET, updateVoxelInstances, voxelInstanceLayout } from '../../../../viewer-core/voxel-blocks';
export type { VoxelInstanceLayout } from '../../../../viewer-core/voxel-blocks';

/** Stride (>= 1) keeping `count` items within `budget` by even decimation. */
export function strideForBudget(count: number, budget: number = NATIVE_VTK_POINT_BUDGET): number {
    if (count <= 0 || budget <= 0) {
        return 1;
    }
    return Math.max(1, Math.ceil(count / budget));
}

// ============================================================================
// VTK XML reader (ascii + appended raw/zlib, little-endian)
// ============================================================================

/** One parsed data array with its value range. */
export interface NativeVtkDataArray {
    name: string;
    association: 'point' | 'cell';
    components: number;
    values: Float64Array;
    range: [number, number];
}

/** Parsed VTK dataset ready for three.js scene building. */
export interface NativeVtkModel {
    family: NativeVtkDatasetFamily;
    /** Number of points (polydata) or grid cells (rectilinear/image). */
    nPoints: number;
    /** Point coordinates (polydata) or cell centers (grids), xyz xyz ... */
    positions: Float32Array;
    /** Line-strip segments as index pairs (polydata lines/polys only). */
    segments?: Uint32Array;
    /**
     * Global cell index per segment (polydata lines/polys only): cells are
     * numbered verts-first, then lines, then polys within the piece, matching
     * VTK cell-data order. Lets the viewer color segments by cell arrays
     * without a server round-trip.
     */
    segmentCells?: Uint32Array;
    /** Vertex indices for point clouds (polydata verts only). */
    vertices?: Uint32Array;
    /** Grid dimensions in cells [nx, ny, nz] (rectilinear/image only). */
    gridDimensions?: [number, number, number];
    /**
     * Cell-boundary axes [x, y, z] (rectilinear/image XML only; absent for
     * `.vts`, whose grid is not axis-aligned). Present exactly when the
     * viewer can render voxel blocks instead of a cell-center preview.
     */
    gridAxes?: [Float64Array, Float64Array, Float64Array];
    pointArrays: NativeVtkDataArray[];
    cellArrays: NativeVtkDataArray[];
    /**
     * Triangle index triples for unstructured surface meshes (`.vtu` XML,
     * legacy `UNSTRUCTURED_GRID` surface cells): point indices, three per
     * triangle, fan-split from polygons/quads/strips.
     */
    triangles?: Uint32Array;
    /** Cell index per triangle in `triangles` (fan-split polygons repeat their cell). */
    triangleCells?: Uint32Array;
    /** Cells skipped while triangulating (non-surface volumetric or unknown types). */
    nonTriangleCells?: number;
    /** Data-array names skipped (string-typed XML arrays, never numeric data). */
    skippedArrays?: string[];
}

interface RawDataArray {
    name: string;
    components: number;
    format: string;
    offset?: number;
    text?: string;
}

const VTKFILE_RE = /<VTKFile\b([^>]*)>/;
const ATTR_RE = /(\w+)="([^"]*)"/g;
const DATAARRAY_RE = /<DataArray\b([^>]*?)(?:\/>|>([\s\S]*?)<\/DataArray>)/g;
const SECTION_RE = (tag: string): RegExp => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');

function parseAttributes(fragment: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let match = ATTR_RE.exec(fragment);
    while (match) {
        attrs[match[1]] = match[2];
        match = ATTR_RE.exec(fragment);
    }
    return attrs;
}

function collectSections(xml: string, tag: string): string[] {
    const sections: string[] = [];
    const re = SECTION_RE(tag);
    let match = re.exec(xml);
    while (match) {
        sections.push(match[1]);
        match = re.exec(xml);
    }
    return sections;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

/** Dependency-free base64 decode (avoids atob binary-string pitfalls). */
export function decodeBase64(base64: string): Uint8Array {
    const clean = base64.replace(/\s+/g, '');
    const lookup = new Map<string, number>();
    for (let i = 0; i < BASE64_CHARS.length; i++) {
        lookup.set(BASE64_CHARS[i], i);
    }
    const decodeQuartet = (a: string, b: string, c: string, d: string): [number, number, number] => {
        const triple = ((lookup.get(a) ?? 0) << 18) | ((lookup.get(b) ?? 0) << 12) | ((lookup.get(c) ?? 0) << 6) | (lookup.get(d) ?? 0);
        return [(triple >> 16) & 0xff, (triple >> 8) & 0xff, triple & 0xff];
    };
    const bytes: number[] = [];
    // Writers (VTK appended payloads) concatenate separately-padded blocks,
    // so padding can appear mid-stream: decode each padded chunk on its own.
    for (const chunk of clean.split('=')) {
        if (chunk.length === 0) {
            continue;
        }
        const padded = chunk + '='.repeat((4 - (chunk.length % 4)) % 4);
        for (let i = 0; i < padded.length; i += 4) {
            const [x, y, z] = decodeQuartet(padded[i], padded[i + 1], padded[i + 2], padded[i + 3]);
            bytes.push(x, y, z);
        }
        const padCount = (4 - (chunk.length % 4)) % 4;
        if (padCount > 0) {
            bytes.splice(bytes.length - padCount, padCount);
        }
    }
    return new Uint8Array(bytes);
}

const VTK_TYPE_SIZES: Record<string, number> = {
    Float64: 8,
    Float32: 4,
    Int64: 8,
    UInt64: 8,
    Int32: 4,
    UInt32: 4,
    Int16: 2,
    UInt16: 2,
    Int8: 1,
    UInt8: 1
};

function readTypedValues(bytes: Uint8Array, type: string): Float64Array {
    const size = VTK_TYPE_SIZES[type];
    if (!size) {
        throw new Error(`Unsupported VTK data type '${type}'`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = Math.floor(bytes.byteLength / size);
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const at = i * size;
        switch (type) {
            case 'Float64':
                out[i] = view.getFloat64(at, true);
                break;
            case 'Float32':
                out[i] = view.getFloat32(at, true);
                break;
            case 'Int64':
                out[i] = Number(view.getBigInt64(at, true));
                break;
            case 'UInt64':
                out[i] = Number(view.getBigUint64(at, true));
                break;
            case 'Int32':
                out[i] = view.getInt32(at, true);
                break;
            case 'UInt32':
                out[i] = view.getUint32(at, true);
                break;
            case 'Int16':
                out[i] = view.getInt16(at, true);
                break;
            case 'UInt16':
                out[i] = view.getUint16(at, true);
                break;
            case 'Int8':
                out[i] = view.getInt8(at);
                break;
            default:
                out[i] = view.getUint8(at);
                break;
        }
    }
    return out;
}

async function inflateBlock(block: Uint8Array, label = 'block'): Promise<Uint8Array> {
    // Synchronous fflate inflate (no DecompressionStream): deterministic on
    // every runtime — the platform stream API stalled indefinitely on some
    // real-world blocks in headless Chromium instead of settling.
    // VTK writers emit RAW deflate blocks while other writers emit
    // zlib-wrapped ones: sniff the zlib header (0x78), trying the sniffed
    // format first and the other as fallback.
    const sniffed = block.length >= 2 && block[0] === 0x78 ? 'wrapped' : 'raw';
    const order: ('raw' | 'wrapped')[] = sniffed === 'wrapped' ? ['wrapped', 'raw'] : ['raw', 'wrapped'];
    let lastError: unknown;
    for (const format of order) {
        try {
            return format === 'wrapped' ? unzlibSync(block) : inflateSync(block);
        } catch (error) {
            lastError = error;
        }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Cannot decompress VTK block '${label}' (${block.length} bytes): ${detail}`);
}

/**
 * Decode one appended block: `[length][payload]`, payload raw or vtk-zlib
 * (`[#blocks][u-size][p-size][c-size...][data...]`, header_type-sized tokens).
 *
 * Offsets are normally byte positions into the decoded blob, but some
 * writers (observed in vtk 9.3 multiblock output) emit base64 CHARACTER
 * offsets instead. The byte position is tried first; when it fails
 * structural validation — or validates ambiguously yet fails to decode —
 * and `payloadText` (the exact string that produced the blob) is available,
 * the character-offset conversion is tried before giving up.
 */
export async function decodeAppendedBlock(
    blob: Uint8Array,
    offset: number,
    headerBytes: number,
    compressed: boolean,
    type: string,
    payloadText?: string,
    label?: string
): Promise<Float64Array> {
    const byteValid = isValidAppendedOffset(blob, offset, headerBytes, compressed);
    const converted = payloadText !== undefined ? charOffsetToByteOffset(payloadText, offset) : undefined;
    const charValid = converted !== undefined && converted !== offset && isValidAppendedOffset(blob, converted, headerBytes, compressed);
    if (!byteValid && !charValid) {
        throw new Error(`VTK appended offset ${offset} is neither a valid byte position nor a base64 character position into the payload`);
    }
    if (byteValid) {
        try {
            return await decodeAppendedBlockAt(blob, offset, headerBytes, compressed, type);
        } catch (error) {
            if (!charValid || converted === undefined) {
                throw error;
            }
            // Structurally plausible but undecodable (e.g. a char offset
            // landing inside another block's header) — fall through to the
            // character-offset conversion below.
        }
    }
    return decodeAppendedBlockAt(blob, converted as number, headerBytes, compressed, type);
}

async function decodeAppendedBlockAt(
    blob: Uint8Array,
    at: number,
    headerBytes: number,
    compressed: boolean,
    type: string
): Promise<Float64Array> {
    const view = new DataView(blob.buffer, blob.byteOffset + at);
    const readToken = (pos: number): number => {
        let v = 0;
        for (let i = 0; i < headerBytes; i++) {
            v |= view.getUint8(pos + i) << (8 * i);
        }
        return v;
    };
    if (!compressed) {
        const nbytes = readToken(0);
        return readTypedValues(blob.subarray(at + headerBytes, at + headerBytes + nbytes), type);
    }
    const nBlocks = readToken(0);
    const cSizeStart = 3 * headerBytes;
    const dataStart = at + (nBlocks + 3) * headerBytes;
    const parts: Uint8Array[] = [];
    let cursor = dataStart;
    for (let b = 0; b < nBlocks; b++) {
        const cSize = readToken(cSizeStart + b * headerBytes);
        parts.push(await inflateBlock(blob.subarray(cursor, cursor + cSize)));
        cursor += cSize;
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let fill = 0;
    for (const part of parts) {
        joined.set(part, fill);
        fill += part.length;
    }
    return readTypedValues(joined, type);
}

/** Structural check for an appended-block header (no decompression). */
export function isValidAppendedOffset(blob: Uint8Array, at: number, headerBytes: number, compressed: boolean): boolean {
    if (!Number.isInteger(at) || at < 0 || at + headerBytes > blob.length) {
        return false;
    }
    if (!compressed) {
        let length = 0;
        for (let i = 0; i < headerBytes; i++) {
            length |= blob[at + i] << (8 * i);
        }
        return length >= 0 && at + headerBytes + length <= blob.length;
    }
    let nBlocks = 0;
    for (let i = 0; i < headerBytes; i++) {
        nBlocks |= blob[at + i] << (8 * i);
    }
    if (nBlocks < 1 || nBlocks > 4096) {
        return false;
    }
    if (at + (nBlocks + 3) * headerBytes > blob.length) {
        return false;
    }
    // Every chunk must lie inside the blob: a byte offset into the middle
    // of another block can accidentally satisfy the header shape above (a
    // base64 char offset landing on a real header's csize field reads it as
    // nblocks), so the chunk table is walked before trusting the position.
    // All reads stay inside the already-validated header (`at +
    // (nBlocks + 3) * headerBytes <= blob.length`).
    let cursor = at + (nBlocks + 3) * headerBytes;
    for (let b = 0; b < nBlocks; b++) {
        let cSize = 0;
        for (let i = 0; i < headerBytes; i++) {
            cSize |= blob[at + (3 + b) * headerBytes + i] << (8 * i);
        }
        if (cSize < 0 || cursor + cSize > blob.length) {
            return false;
        }
        cursor += cSize;
    }
    return true;
}

/**
 * Convert a base64 CHARACTER offset (as emitted by some writers instead of
 * a decoded-byte offset) into a decoded-byte position: the payload prefix
 * is split at padding runs (writers flush padded chunks independently) and
 * each run contributes complete quads plus its remainder (2 chars → 1 byte,
 * 3 chars → 2 bytes).
 */
export function charOffsetToByteOffset(payload: string, charOffset: number): number | undefined {
    if (!Number.isInteger(charOffset) || charOffset < 0 || charOffset > payload.length) {
        return undefined;
    }
    const prefix = payload.slice(0, charOffset).replace(/\s+/g, '');
    let bytes = 0;
    for (const run of prefix.split(/=+/)) {
        if (run.length === 0) {
            continue;
        }
        bytes += Math.floor(run.length / 4) * 3;
        const rem = run.length % 4;
        if (rem === 2) {
            bytes += 1;
        } else if (rem === 3) {
            bytes += 2;
        }
    }
    return bytes;
}

function parseAsciiValues(text: string | undefined, type: string, expected: number): Float64Array {
    if (!text) {
        return new Float64Array(0);
    }
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    const size = VTK_TYPE_SIZES[type] ?? 8;
    const out = new Float64Array(Math.min(tokens.length, expected > 0 ? expected : tokens.length));
    for (let i = 0; i < out.length; i++) {
        out[i] = size === 1 && type !== 'Float32' && type !== 'Float64' ? parseInt(tokens[i], 10) : parseFloat(tokens[i]);
    }
    return out;
}

interface DecodedArray {
    values: Float64Array;
    dataType: string;
}

async function decodeDataArray(
    raw: RawDataArray,
    dataType: string,
    expectedTuples: number,
    appended: { blob: Uint8Array; headerBytes: number; compressed: boolean; payloadText: string } | undefined
): Promise<DecodedArray> {
    const expected = expectedTuples * raw.components;
    if (raw.format === 'appended') {
        if (!appended || raw.offset === undefined) {
            throw new Error(`DataArray '${raw.name || '<connectivity>'}' uses appended encoding but no AppendedData section was found`);
        }
        return {
            values: await decodeAppendedBlock(
                appended.blob,
                raw.offset,
                appended.headerBytes,
                appended.compressed,
                dataType,
                appended.payloadText,
                raw.name || dataType
            ),
            dataType
        };
    }
    return { values: parseAsciiValues(raw.text, dataType, expected), dataType };
}

function toDataArray(raw: RawDataArray, decoded: Float64Array, association: 'point' | 'cell'): NativeVtkDataArray {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const tuples = Math.floor(decoded.length / Math.max(1, raw.components));
    for (let i = 0; i < tuples; i++) {
        const v = tupleScalar(decoded, raw.components, i);
        if (v < min) {
            min = v;
        }
        if (v > max) {
            max = v;
        }
    }
    if (tuples === 0) {
        min = 0;
        max = 0;
    }
    return { name: raw.name, association, components: raw.components, values: decoded, range: [min, max] };
}

function parseExtent(
    extent: string | undefined,
    fallback: [number, number, number, number, number, number]
): [number, number, number, number, number, number] {
    if (!extent) {
        return fallback;
    }
    const parts = extent.split(/\s+/).map((token) => parseInt(token, 10));
    if (parts.length !== 6 || parts.some((v) => Number.isNaN(v))) {
        return fallback;
    }
    return [parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]];
}

function parseTriple(text: string | undefined, fallback: [number, number, number]): [number, number, number] {
    if (!text) {
        return fallback;
    }
    const parts = text.split(/\s+/).map((token) => parseFloat(token));
    if (parts.length !== 3 || parts.some((v) => Number.isNaN(v))) {
        return fallback;
    }
    return [parts[0], parts[1], parts[2]];
}

/**
 * Parse a VTK XML file (`.vtp` PolyData, `.vtr` RectilinearGrid, `.vti`
 * ImageData, `.vtu` UnstructuredGrid, `.vts` StructuredGrid) as written by
 * VTK's XML writers (including `output_vtk.py` and the DAGMC multiblock
 * blocks): ascii or appended (raw/zlib) encodings, little-endian.
 * Unstructured grids decode to the `polydata` family (shared decoder also
 * used by the DAGMC multiblock path); structured grids decode to the
 * `rectilinear` family.
 */
export async function parseNativeVtkXml(text: string): Promise<NativeVtkModel> {
    const fileMatch = VTKFILE_RE.exec(text);
    if (!fileMatch) {
        throw new Error('Not a VTK XML file: missing <VTKFile> root element');
    }
    const fileAttrs = parseAttributes(fileMatch[1]);
    const fileType = fileAttrs['type'] ?? '';
    if ((fileAttrs['byte_order'] ?? 'LittleEndian') !== 'LittleEndian') {
        throw new Error(`Unsupported VTK byte order '${fileAttrs['byte_order']}' (only LittleEndian is supported)`);
    }
    const headerBytes = (fileAttrs['header_type'] ?? 'UInt32') === 'UInt64' ? 8 : 4;
    const compressed = fileAttrs['compressor'] !== undefined;

    let appended: { blob: Uint8Array; headerBytes: number; compressed: boolean; payloadText: string } | undefined;
    const appendedSections = collectSections(text, 'AppendedData');
    if (appendedSections.length > 0) {
        const payload = appendedSections[0].replace(/^\s*_/, '').trim();
        appended = { blob: decodeBase64(payload), headerBytes, compressed, payloadText: payload };
    }

    const pieceMatch = /<Piece\b([^>]*)>/.exec(text);
    const pieceAttrs = pieceMatch ? parseAttributes(pieceMatch[1]) : {};

    // Re-collect with types: DataArray elements carry their type attribute.
    const typedArrays = (sectionText: string): { raw: RawDataArray; dataType: string }[] => {
        const out: { raw: RawDataArray; dataType: string }[] = [];
        DATAARRAY_RE.lastIndex = 0;
        let match = DATAARRAY_RE.exec(sectionText);
        while (match) {
            const attrs = parseAttributes(match[1]);
            out.push({
                raw: {
                    name: attrs['Name'] ?? attrs['name'] ?? '',
                    components: attrs['NumberOfComponents'] !== undefined ? parseInt(attrs['NumberOfComponents'], 10) : 1,
                    format: (attrs['format'] ?? 'ascii').toLowerCase(),
                    offset: attrs['offset'] !== undefined ? parseInt(attrs['offset'], 10) : undefined,
                    text: match[2]
                },
                dataType: attrs['type'] ?? 'Float64'
            });
            match = DATAARRAY_RE.exec(sectionText);
        }
        return out;
    };

    if (fileType === 'PolyData') {
        const nPoints = pieceAttrs['NumberOfPoints'] !== undefined ? parseInt(pieceAttrs['NumberOfPoints'], 10) : 0;
        const pointSections = collectSections(text, 'PointData');
        const cellSections = collectSections(text, 'CellData');
        const pointsSections = collectSections(text, 'Points');
        const pointArrays: NativeVtkDataArray[] = [];
        for (const section of pointSections) {
            for (const { raw, dataType } of typedArrays(section)) {
                const decoded = await decodeDataArray(raw, dataType, nPoints, appended);
                pointArrays.push(toDataArray(raw, decoded.values, 'point'));
            }
        }
        const cellArrays: NativeVtkDataArray[] = [];
        const nCells = ['NumberOfVerts', 'NumberOfLines', 'NumberOfStrips', 'NumberOfPolys']
            .map((key) => (pieceAttrs[key] !== undefined ? parseInt(pieceAttrs[key], 10) : 0))
            .reduce((sum, v) => sum + v, 0);
        for (const section of cellSections) {
            for (const { raw, dataType } of typedArrays(section)) {
                const decoded = await decodeDataArray(raw, dataType, nCells, appended);
                cellArrays.push(toDataArray(raw, decoded.values, 'cell'));
            }
        }
        if (pointsSections.length === 0) {
            throw new Error('PolyData file has no <Points> section');
        }
        const pointsRaw = typedArrays(pointsSections[0]);
        if (pointsRaw.length === 0) {
            throw new Error('PolyData <Points> section has no DataArray');
        }
        const pointsDecoded = await decodeDataArray(pointsRaw[0].raw, pointsRaw[0].dataType, nPoints, appended);
        const positions = new Float32Array(pointsDecoded.values.subarray(0, nPoints * 3));

        // Connectivity: standard VTK XML form is separate `connectivity` +
        // `offsets` arrays (offsets[i] = end of cell i in connectivity);
        // unnamed inline `[n, id...]` arrays are also accepted for compat.
        // Cells are numbered verts-first, then lines, then polys (VTK order).
        // Empty sections (e.g. the empty Lines/Strips/Polys of a vertex
        // cloud) are skipped without touching their arrays: writers still
        // emit (empty) blocks for them, and decoding is pointless — worse,
        // a corrupt offset in a zero-cell section must never fabricate
        // cells, while a corrupt offset in a non-empty section must still
        // throw via the strict appended validator below. Sections without
        // a count attribute decode as before (unknown, not provably empty).
        const readCells = async (tag: string, expectedCells?: number): Promise<number[][]> => {
            const cells: number[][] = [];
            if (expectedCells === 0) {
                return cells;
            }
            const walkInline = (values: Float64Array): void => {
                let cursor = 0;
                while (cursor < values.length) {
                    const count = Math.round(values[cursor]);
                    cursor++;
                    const ids: number[] = [];
                    for (let k = 0; k < count && cursor < values.length; k++, cursor++) {
                        ids.push(Math.round(values[cursor]));
                    }
                    cells.push(ids);
                }
            };
            for (const section of collectSections(text, tag)) {
                let connectivity: Float64Array | undefined;
                let offsets: Float64Array | undefined;
                const inline: Float64Array[] = [];
                for (const { raw, dataType } of typedArrays(section)) {
                    const decoded = await decodeDataArray(raw, dataType, 0, appended);
                    const name = (raw.name ?? '').toLowerCase();
                    if (name === 'connectivity') {
                        connectivity = decoded.values;
                    } else if (name === 'offsets') {
                        offsets = decoded.values;
                    } else {
                        inline.push(decoded.values);
                    }
                }
                if (connectivity !== undefined && offsets !== undefined) {
                    for (let c = 0; c < offsets.length; c++) {
                        const start = c === 0 ? 0 : Math.round(offsets[c - 1]);
                        const end = Math.round(offsets[c]);
                        const ids: number[] = [];
                        for (let k = start; k < end && k < connectivity.length; k++) {
                            ids.push(Math.round(connectivity[k]));
                        }
                        cells.push(ids);
                    }
                } else {
                    // No offsets array: a lone connectivity array (or any other
                    // unnamed array) keeps the historical inline [n, id...]
                    // walk rather than failing the file.
                    if (connectivity !== undefined) {
                        inline.unshift(connectivity);
                    }
                    if (offsets !== undefined) {
                        inline.unshift(offsets);
                    }
                    for (const values of inline) {
                        walkInline(values);
                    }
                }
            }
            return cells;
        };
        const sectionCellCount = (key: string): number | undefined =>
            pieceAttrs[key] !== undefined ? Math.max(0, parseInt(pieceAttrs[key], 10)) : undefined;
        const vertCells = await readCells('Verts', sectionCellCount('NumberOfVerts'));
        const lineCells = await readCells('Lines', sectionCellCount('NumberOfLines'));
        const polyCells = await readCells('Polys', sectionCellCount('NumberOfPolys'));
        const segments: number[] = [];
        const segmentCells: number[] = [];
        const vertices: number[] = [];
        const triangles: number[] = [];
        const triangleCells: number[] = [];
        for (const ids of vertCells) {
            vertices.push(...ids);
        }
        lineCells.forEach((ids, lineIndex) => {
            for (let k = 0; k + 1 < ids.length; k++) {
                segments.push(ids[k], ids[k + 1]);
                segmentCells.push(vertCells.length + lineIndex);
            }
        });
        polyCells.forEach((ids, polyIndex) => {
            const cell = vertCells.length + lineCells.length + polyIndex;
            if (ids.length >= 3) {
                // Filled surface (legacy-path parity): fan-triangulate and
                // keep the outline edges for the `edges` shading mode.
                for (let k = 1; k + 1 < ids.length; k++) {
                    triangles.push(ids[0], ids[k], ids[k + 1]);
                    triangleCells.push(cell);
                    segments.push(ids[0], ids[k], ids[k], ids[k + 1], ids[k + 1], ids[0]);
                    segmentCells.push(cell, cell, cell);
                }
            } else if (ids.length === 2) {
                segments.push(ids[0], ids[1]);
                segmentCells.push(cell);
            } else {
                vertices.push(...ids);
            }
        });
        return {
            family: 'polydata',
            nPoints,
            positions,
            segments: segments.length > 0 ? new Uint32Array(segments) : undefined,
            segmentCells: segmentCells.length > 0 ? new Uint32Array(segmentCells) : undefined,
            vertices: vertices.length > 0 ? new Uint32Array(vertices) : undefined,
            pointArrays,
            cellArrays,
            triangles: triangles.length > 0 ? new Uint32Array(triangles) : undefined,
            triangleCells: triangleCells.length > 0 ? new Uint32Array(triangleCells) : undefined
        };
    }

    if (fileType === 'RectilinearGrid' || fileType === 'ImageData') {
        const family: NativeVtkDatasetFamily = fileType === 'RectilinearGrid' ? 'rectilinear' : 'image';
        const extent = parseExtent(pieceAttrs['Extent'], [0, 0, 0, 0, 0, 0]);
        const nx = Math.max(0, extent[1] - extent[0]);
        const ny = Math.max(0, extent[3] - extent[2]);
        const nz = Math.max(0, extent[5] - extent[4]);
        const nCells = nx * ny * nz;
        if (nCells === 0) {
            throw new Error(`${fileType} file has an empty grid extent`);
        }
        let axes: [Float64Array, Float64Array, Float64Array] | undefined;
        if (family === 'rectilinear') {
            const coordSections = collectSections(text, 'Coordinates');
            if (coordSections.length === 0) {
                throw new Error('RectilinearGrid file has no <Coordinates> section');
            }
            const decoded: Float64Array[] = [];
            for (const { raw, dataType } of typedArrays(coordSections[0])) {
                const expected = [nx + 1, ny + 1, nz + 1][decoded.length] ?? 0;
                decoded.push((await decodeDataArray(raw, dataType, expected, appended)).values);
            }
            if (decoded.length < 3) {
                throw new Error(`RectilinearGrid file has ${decoded.length} coordinate arrays (expected 3)`);
            }
            axes = [decoded[0], decoded[1], decoded[2]];
        } else {
            const imageMatch = /<ImageData\b([^>]*)>/.exec(text);
            const imageAttrs = imageMatch ? parseAttributes(imageMatch[1]) : {};
            const origin = parseTriple(imageAttrs['Origin'], [0, 0, 0]);
            const spacing = parseTriple(imageAttrs['Spacing'], [1, 1, 1]);
            const linspace = (start: number, step: number, count: number): Float64Array => {
                const out = new Float64Array(count);
                for (let i = 0; i < count; i++) {
                    out[i] = start + i * step;
                }
                return out;
            };
            axes = [
                linspace(origin[0], spacing[0], nx + 1),
                linspace(origin[1], spacing[1], ny + 1),
                linspace(origin[2], spacing[2], nz + 1)
            ];
        }
        const cellSections = collectSections(text, 'CellData');
        const cellArrays: NativeVtkDataArray[] = [];
        for (const section of cellSections) {
            for (const { raw, dataType } of typedArrays(section)) {
                const decoded = await decodeDataArray(raw, dataType, nCells, appended);
                if (Math.floor(decoded.values.length / Math.max(1, raw.components)) !== nCells) {
                    throw new Error(`Cell array '${raw.name}' has ${decoded.values.length} values for ${nCells} grid cells`);
                }
                cellArrays.push(toDataArray(raw, decoded.values, 'cell'));
            }
        }
        const pointSections = collectSections(text, 'PointData');
        const pointArrays: NativeVtkDataArray[] = [];
        const nGridPoints = (nx + 1) * (ny + 1) * (nz + 1);
        for (const section of pointSections) {
            for (const { raw, dataType } of typedArrays(section)) {
                const decoded = await decodeDataArray(raw, dataType, nGridPoints, appended);
                pointArrays.push(toDataArray(raw, decoded.values, 'point'));
            }
        }
        const [xAxis, yAxis, zAxis] = axes;
        const centers = new Float32Array(nCells * 3);
        let at = 0;
        for (let k = 0; k < nz; k++) {
            const z = (zAxis[k] + zAxis[k + 1]) / 2;
            for (let j = 0; j < ny; j++) {
                const y = (yAxis[j] + yAxis[j + 1]) / 2;
                for (let i = 0; i < nx; i++) {
                    centers[at++] = (xAxis[i] + xAxis[i + 1]) / 2;
                    centers[at++] = y;
                    centers[at++] = z;
                }
            }
        }
        return {
            family,
            nPoints: nCells,
            positions: centers,
            gridDimensions: [nx, ny, nz],
            gridAxes: [xAxis, yAxis, zAxis],
            pointArrays,
            cellArrays
        };
    }

    if (fileType === 'UnstructuredGrid') {
        return parseUnstructuredGridXml(text);
    }

    if (fileType === 'StructuredGrid') {
        return parseStructuredGridXml(text);
    }

    throw new Error(
        `Unsupported VTK dataset type '${fileType}' (expected PolyData, UnstructuredGrid, StructuredGrid, RectilinearGrid, or ImageData)`
    );
}

// ============================================================================
// Shared .vtu UnstructuredGrid decoder (DAGMC volume blocks + direct .vtu)
// ============================================================================

/** VTK cell type ids triangulated here (triangle + polygon/quad fans). */
const VTK_TRIANGLE = 5;
const VTK_POLYGON = 7;
const VTK_QUAD = 9;

interface RawUnstructuredArray {
    name: string;
    dataType: string;
    components: number;
    format: string;
    offset?: number;
    text?: string;
}

function collectUnstructuredArrays(sectionText: string): RawUnstructuredArray[] {
    const out: RawUnstructuredArray[] = [];
    DATAARRAY_RE.lastIndex = 0;
    let match = DATAARRAY_RE.exec(sectionText);
    while (match) {
        const attrs = parseAttributes(match[1]);
        out.push({
            name: attrs['Name'] ?? attrs['name'] ?? '',
            dataType: attrs['type'] ?? 'Float64',
            components: attrs['NumberOfComponents'] !== undefined ? parseInt(attrs['NumberOfComponents'], 10) : 1,
            format: (attrs['format'] ?? 'ascii').toLowerCase(),
            offset: attrs['offset'] !== undefined ? parseInt(attrs['offset'], 10) : undefined,
            text: match[2]
        });
        match = DATAARRAY_RE.exec(sectionText);
    }
    return out;
}

function parseUnstructuredAsciiValues(text: string | undefined, type: string): Float64Array {
    if (!text) {
        return new Float64Array(0);
    }
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    const out = new Float64Array(tokens.length);
    const integer = VTK_TYPE_SIZES[type] !== undefined && type !== 'Float32' && type !== 'Float64';
    for (let i = 0; i < tokens.length; i++) {
        out[i] = integer ? parseInt(tokens[i], 10) : parseFloat(tokens[i]);
    }
    return out;
}

interface UnstructuredAppended {
    blob: Uint8Array;
    headerBytes: number;
    compressed: boolean;
    payloadText: string;
}

async function decodeUnstructuredArray(raw: RawUnstructuredArray, appended: UnstructuredAppended | undefined): Promise<Float64Array> {
    if (raw.format === 'appended') {
        if (!appended || raw.offset === undefined) {
            throw new Error(`DataArray '${raw.name || '<cells>'}' uses appended encoding but no AppendedData section was found`);
        }
        return decodeAppendedBlock(
            appended.blob,
            raw.offset,
            appended.headerBytes,
            appended.compressed,
            raw.dataType,
            appended.payloadText,
            raw.name || raw.dataType
        );
    }
    return parseUnstructuredAsciiValues(raw.text, raw.dataType);
}

function toUnstructuredDataArray(raw: RawUnstructuredArray, decoded: Float64Array, association: 'point' | 'cell'): NativeVtkDataArray {
    return toDataArray({ name: raw.name, components: raw.components, format: 'ascii' }, decoded, association);
}

/**
 * Parse a `.vtu` unstructured-grid XML document into a `polydata`-family
 * model: triangle edges become `segments` (with per-edge cell ids in
 * `segmentCells` for cell color-by) and the triangle index triples are
 * kept in `triangles` for mesh rendering. Shared by the direct `.vtu`
 * probe path here and the DAGMC multiblock path (`dagmc-multiblock.ts`
 * wraps it to attach block identity — no duplicated decode logic).
 */
export async function parseUnstructuredGridXml(text: string): Promise<NativeVtkModel> {
    const root = VTKFILE_RE.exec(text);
    if (!root) {
        throw new Error('Not a VTK XML file: missing <VTKFile> root element');
    }
    const fileAttrs = parseAttributes(root[1]);
    if ((fileAttrs['type'] ?? '') !== 'UnstructuredGrid') {
        throw new Error(`Unsupported VTK dataset type '${fileAttrs['type'] ?? ''}' (expected UnstructuredGrid)`);
    }
    if ((fileAttrs['byte_order'] ?? 'LittleEndian') !== 'LittleEndian') {
        throw new Error(`Unsupported VTK byte order '${fileAttrs['byte_order']}' (only LittleEndian is supported)`);
    }
    const headerBytes = (fileAttrs['header_type'] ?? 'UInt32') === 'UInt64' ? 8 : 4;
    const compressed = fileAttrs['compressor'] !== undefined;

    let appended: UnstructuredAppended | undefined;
    const appendedSections = collectSections(text, 'AppendedData');
    if (appendedSections.length > 0) {
        const payload = appendedSections[0].replace(/^\s*_/, '').trim();
        appended = { blob: decodeBase64(payload), headerBytes, compressed, payloadText: payload };
    }

    const pieceMatch = /<Piece\b([^>]*)>/.exec(text);
    const pieceAttrs = pieceMatch ? parseAttributes(pieceMatch[1]) : {};
    const nPoints = pieceAttrs['NumberOfPoints'] !== undefined ? parseInt(pieceAttrs['NumberOfPoints'], 10) : 0;

    const pointsSections = collectSections(text, 'Points');
    if (pointsSections.length === 0) {
        throw new Error('UnstructuredGrid file has no <Points> section');
    }
    const pointsArrays = collectUnstructuredArrays(pointsSections[0]);
    if (pointsArrays.length === 0) {
        throw new Error('UnstructuredGrid <Points> section has no DataArray');
    }
    const pointsDecoded = await decodeUnstructuredArray(pointsArrays[0], appended);
    const positions = new Float32Array(pointsDecoded.subarray(0, nPoints * 3));

    const pointArrays: NativeVtkDataArray[] = [];
    const cellArrays: NativeVtkDataArray[] = [];
    const skippedArrays: string[] = [];
    const decodeSection = async (tag: 'PointData' | 'CellData'): Promise<NativeVtkDataArray[]> => {
        const out: NativeVtkDataArray[] = [];
        for (const section of collectSections(text, tag)) {
            for (const raw of collectUnstructuredArrays(section)) {
                if (raw.dataType === 'String') {
                    skippedArrays.push(raw.name);
                    continue;
                }
                out.push(
                    toUnstructuredDataArray(raw, await decodeUnstructuredArray(raw, appended), tag === 'PointData' ? 'point' : 'cell')
                );
            }
        }
        return out;
    };
    pointArrays.push(...(await decodeSection('PointData')));
    cellArrays.push(...(await decodeSection('CellData')));

    const cellsSections = collectSections(text, 'Cells');
    if (cellsSections.length === 0) {
        throw new Error('UnstructuredGrid file has no <Cells> section');
    }
    let connectivity: Float64Array = new Float64Array(0);
    let offsets: Float64Array = new Float64Array(0);
    let types: Float64Array = new Float64Array(0);
    for (const raw of collectUnstructuredArrays(cellsSections[0])) {
        const lowered = raw.name.toLowerCase();
        const decoded = await decodeUnstructuredArray(raw, appended);
        if (lowered === 'connectivity') {
            connectivity = decoded;
        } else if (lowered === 'offsets') {
            offsets = decoded;
        } else if (lowered === 'types') {
            types = decoded;
        }
    }
    if (types.length === 0) {
        throw new Error('UnstructuredGrid <Cells> section has no cell types array');
    }

    const triangles: number[] = [];
    const triangleCells: number[] = [];
    const segments: number[] = [];
    const segmentCells: number[] = [];
    let nonTriangleCells = 0;
    const cellCount = types.length;
    for (let c = 0; c < cellCount; c++) {
        const type = Math.round(types[c]);
        const start = c === 0 ? 0 : Math.round(offsets[c - 1]);
        const end = c < offsets.length ? Math.round(offsets[c]) : connectivity.length;
        const ids: number[] = [];
        for (let k = start; k < end; k++) {
            ids.push(Math.round(connectivity[k]));
        }
        const pushTriangle = (a: number, b: number, d: number): void => {
            triangles.push(a, b, d);
            triangleCells.push(c);
            segments.push(a, b, b, d, d, a);
            segmentCells.push(c, c, c);
        };
        if (type === VTK_TRIANGLE && ids.length === 3) {
            pushTriangle(ids[0], ids[1], ids[2]);
        } else if ((type === VTK_POLYGON || type === VTK_QUAD) && ids.length >= 3) {
            for (let k = 1; k + 1 < ids.length; k++) {
                pushTriangle(ids[0], ids[k], ids[k + 1]);
            }
        } else {
            nonTriangleCells++;
        }
    }

    return {
        family: 'polydata',
        nPoints,
        positions,
        segments: segments.length > 0 ? new Uint32Array(segments) : undefined,
        segmentCells: segmentCells.length > 0 ? new Uint32Array(segmentCells) : undefined,
        pointArrays,
        cellArrays,
        triangles: triangles.length > 0 ? new Uint32Array(triangles) : undefined,
        triangleCells: triangleCells.length > 0 ? new Uint32Array(triangleCells) : undefined,
        nonTriangleCells,
        skippedArrays
    };
}

// ============================================================================
// .vts StructuredGrid XML decoder (cell centers + grid dimensions)
// ============================================================================

function parseDimensions(text: string | undefined, fallback: [number, number, number]): [number, number, number] {
    if (!text) {
        return fallback;
    }
    const parts = text.split(/\s+/).map((token) => parseInt(token, 10));
    if (parts.length !== 3 || parts.some((v) => Number.isNaN(v))) {
        return fallback;
    }
    return [parts[0], parts[1], parts[2]];
}

/**
 * Parse a `.vts` structured-grid XML document into a `rectilinear`-family
 * model: explicit grid points are averaged into cell centers (matching the
 * rectilinear/image rendering path) with `gridDimensions` in cells.
 */
export async function parseStructuredGridXml(text: string): Promise<NativeVtkModel> {
    const root = VTKFILE_RE.exec(text);
    if (!root) {
        throw new Error('Not a VTK XML file: missing <VTKFile> root element');
    }
    const fileAttrs = parseAttributes(root[1]);
    if ((fileAttrs['type'] ?? '') !== 'StructuredGrid') {
        throw new Error(`Unsupported VTK dataset type '${fileAttrs['type'] ?? ''}' (expected StructuredGrid)`);
    }
    if ((fileAttrs['byte_order'] ?? 'LittleEndian') !== 'LittleEndian') {
        throw new Error(`Unsupported VTK byte order '${fileAttrs['byte_order']}' (only LittleEndian is supported)`);
    }
    const headerBytes = (fileAttrs['header_type'] ?? 'UInt32') === 'UInt64' ? 8 : 4;
    const compressed = fileAttrs['compressor'] !== undefined;

    let appended: UnstructuredAppended | undefined;
    const appendedSections = collectSections(text, 'AppendedData');
    if (appendedSections.length > 0) {
        const payload = appendedSections[0].replace(/^\s*_/, '').trim();
        appended = { blob: decodeBase64(payload), headerBytes, compressed, payloadText: payload };
    }

    const pieceMatch = /<Piece\b([^>]*)>/.exec(text);
    const pieceAttrs = pieceMatch ? parseAttributes(pieceMatch[1]) : {};
    const [nx, ny, nz] = parseDimensions(pieceAttrs['Dimensions'], [0, 0, 0]);
    if (nx <= 0 || ny <= 0 || nz <= 0) {
        throw new Error('StructuredGrid file has an empty grid (Dimensions must be positive)');
    }
    const nGridPoints = nx * ny * nz;
    const cx = nx - 1;
    const cy = ny - 1;
    const cz = nz - 1;
    const nCells = cx * cy * cz;
    if (nCells === 0) {
        throw new Error('StructuredGrid file has an empty grid (no cells)');
    }

    const pointsSections = collectSections(text, 'Points');
    if (pointsSections.length === 0) {
        throw new Error('StructuredGrid file has no <Points> section');
    }
    const pointsArrays = collectUnstructuredArrays(pointsSections[0]);
    if (pointsArrays.length === 0) {
        throw new Error('StructuredGrid <Points> section has no DataArray');
    }
    const gridPoints = await decodeUnstructuredArray(pointsArrays[0], appended);
    if (gridPoints.length < nGridPoints * 3) {
        throw new Error(`StructuredGrid points array has ${gridPoints.length} values for ${nGridPoints} grid points`);
    }

    const pointAt = (i: number, j: number, k: number): [number, number, number] => {
        const at = ((k * ny + j) * nx + i) * 3;
        return [gridPoints[at], gridPoints[at + 1], gridPoints[at + 2]];
    };
    const centers = new Float32Array(nCells * 3);
    let at = 0;
    for (let k = 0; k < cz; k++) {
        for (let j = 0; j < cy; j++) {
            for (let i = 0; i < cx; i++) {
                let sx = 0;
                let sy = 0;
                let sz = 0;
                let count = 0;
                for (let dk = 0; dk <= (cz > 0 && nz > 1 ? 1 : 0); dk++) {
                    for (let dj = 0; dj <= (cy > 0 && ny > 1 ? 1 : 0); dj++) {
                        for (let di = 0; di <= (cx > 0 && nx > 1 ? 1 : 0); di++) {
                            const [px, py, pz] = pointAt(i + di, j + dj, k + dk);
                            sx += px;
                            sy += py;
                            sz += pz;
                            count++;
                        }
                    }
                }
                centers[at++] = sx / count;
                centers[at++] = sy / count;
                centers[at++] = sz / count;
            }
        }
    }

    const cellSections = collectSections(text, 'CellData');
    const cellArrays: NativeVtkDataArray[] = [];
    for (const section of cellSections) {
        for (const raw of collectUnstructuredArrays(section)) {
            if (raw.dataType === 'String') {
                continue;
            }
            const decoded = await decodeUnstructuredArray(raw, appended);
            if (Math.floor(decoded.length / Math.max(1, raw.components)) !== nCells) {
                throw new Error(`Cell array '${raw.name}' has ${decoded.length} values for ${nCells} grid cells`);
            }
            cellArrays.push(toUnstructuredDataArray(raw, decoded, 'cell'));
        }
    }
    const pointSections = collectSections(text, 'PointData');
    const pointArrays: NativeVtkDataArray[] = [];
    for (const section of pointSections) {
        for (const raw of collectUnstructuredArrays(section)) {
            if (raw.dataType === 'String') {
                continue;
            }
            pointArrays.push(toUnstructuredDataArray(raw, await decodeUnstructuredArray(raw, appended), 'point'));
        }
    }
    return { family: 'rectilinear', nPoints: nCells, positions: centers, gridDimensions: [cx, cy, cz], pointArrays, cellArrays };
}

// ============================================================================
// Legacy VTK ASCII reader (.vtk as emitted by gmsh/MOAB/FEM converters)
// ============================================================================

/** VTK legacy cell-type ids with wireframe edge tables (corner indices). */
const LEGACY_CELL_EDGES: Record<number, [number, number][]> = {
    3: [[0, 1]],
    5: [
        [0, 1],
        [1, 2],
        [2, 0]
    ],
    7: [],
    8: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0]
    ],
    9: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0]
    ],
    10: [
        [0, 1],
        [0, 2],
        [0, 3],
        [1, 2],
        [1, 3],
        [2, 3]
    ],
    11: [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 3],
        [4, 5],
        [4, 6],
        [5, 7],
        [6, 7],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7]
    ],
    12: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7]
    ],
    13: [
        [0, 1],
        [1, 2],
        [2, 0],
        [3, 4],
        [4, 5],
        [5, 3],
        [0, 3],
        [1, 4],
        [2, 5]
    ],
    14: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [0, 4],
        [1, 4],
        [2, 4],
        [3, 4]
    ]
};

/** Map higher-order legacy cell types onto their linear corner subsets. */
function linearizeLegacyCell(type: number, ids: number[]): { edges: [number, number][]; surface: number[] | undefined } {
    if (type === 1 || type === 2) {
        return { edges: [], surface: undefined };
    }
    if (type === 4) {
        const edges: [number, number][] = [];
        for (let k = 0; k + 1 < ids.length; k++) {
            edges.push([ids[k], ids[k + 1]]);
        }
        return { edges, surface: undefined };
    }
    if (type === 6) {
        const triangles: number[][] = [];
        for (let k = 0; k + 2 < ids.length; k++) {
            const tri = k % 2 === 0 ? [ids[k], ids[k + 1], ids[k + 2]] : [ids[k + 1], ids[k], ids[k + 2]];
            triangles.push(tri);
        }
        const edges: [number, number][] = [];
        for (const tri of triangles) {
            edges.push([tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]);
        }
        return { edges, surface: triangles.length === 1 ? triangles[0] : undefined };
    }
    const table = LEGACY_CELL_EDGES[type];
    if (table !== undefined) {
        if (type === 7) {
            const edges: [number, number][] = [];
            for (let k = 0; k < ids.length; k++) {
                edges.push([ids[k], ids[(k + 1) % ids.length]]);
            }
            return { edges, surface: ids.length >= 3 ? ids : undefined };
        }
        // Surface cells fan-triangulate in the caller; volumetric cells wireframe.
        const surface = type === 5 || type === 8 || type === 9 ? ids : undefined;
        return { edges: table.map(([a, b]) => [ids[a], ids[b]] as [number, number]), surface };
    }
    // Quadratic counterparts reuse their linear corner nodes.
    if (type === 21 && ids.length >= 2) {
        return { edges: [[ids[0], ids[1]]], surface: undefined };
    }
    if (type === 22 && ids.length >= 3) {
        return linearizeLegacyCell(5, ids.slice(0, 3));
    }
    if (type === 23 && ids.length >= 4) {
        return linearizeLegacyCell(9, ids.slice(0, 4));
    }
    if (type === 24 && ids.length >= 4) {
        return linearizeLegacyCell(10, ids.slice(0, 4));
    }
    if (type === 25 && ids.length >= 8) {
        return linearizeLegacyCell(12, ids.slice(0, 8));
    }
    if (type === 26 && ids.length >= 6) {
        return linearizeLegacyCell(13, ids.slice(0, 6));
    }
    if (type === 27 && ids.length >= 5) {
        return linearizeLegacyCell(14, ids.slice(0, 5));
    }
    return { edges: [], surface: undefined };
}

function makeLegacyArray(name: string, association: 'point' | 'cell', components: number, values: Float64Array): NativeVtkDataArray {
    return toDataArray({ name, components, format: 'ascii' }, values, association);
}

/**
 * Parse a legacy VTK ASCII file (`.vtk` as emitted by gmsh `step.py`,
 * MOAB `dagmc.py`, nuke-cad `fem_service.py`, and OpenMC mesh exports):
 * `DATASET POLYDATA` (`POINTS` plus `VERTICES`/`LINES`/`POLYGONS`/
 * `TRIANGLE_STRIPS`), `DATASET UNSTRUCTURED_GRID` (`POINTS` plus `CELLS`/
 * `CELL_TYPES`), or `DATASET STRUCTURED_GRID` (`DIMENSIONS` plus `POINTS`,
 * averaged to cell centers like the `.vts` path, with voxel axes when the
 * lattice is axis-aligned), with `POINT_DATA`/`CELL_DATA` carrying
 * `SCALARS`/`VECTORS`/`FIELD` (plus `NORMALS`/`TENSORS`). Produces the same
 * `NativeVtkModel` shape the classifier consumes. Binary files are
 * rejected with an ASCII-only error.
 */
export function parseLegacyVtkAscii(text: string): NativeVtkModel {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0 || !/^#\s*vtk DataFile/i.test(lines[0].trim())) {
        throw new Error('Not a legacy VTK file: missing "# vtk DataFile" header');
    }
    const formatLine = (lines[2] ?? '').trim().toUpperCase();
    if (formatLine === 'BINARY') {
        throw new Error('Legacy VTK BINARY format is not supported (ASCII-only): re-export the file as ASCII');
    }
    if (formatLine !== 'ASCII') {
        if (text.includes('\0')) {
            throw new Error('Legacy VTK BINARY format is not supported (ASCII-only): re-export the file as ASCII');
        }
        throw new Error(`Unsupported legacy VTK format '${(lines[2] ?? '').trim()}' (expected ASCII)`);
    }
    let dataset = '';
    let datasetLine = -1;
    for (let i = 3; i < lines.length; i++) {
        const match = /^\s*DATASET\s+(\w+)/i.exec(lines[i]);
        if (match) {
            dataset = match[1].toUpperCase();
            datasetLine = i;
            break;
        }
    }
    if (!dataset) {
        throw new Error('Legacy VTK file has no DATASET section');
    }
    if (dataset !== 'POLYDATA' && dataset !== 'UNSTRUCTURED_GRID' && dataset !== 'STRUCTURED_GRID') {
        throw new Error(`Unsupported legacy VTK dataset '${dataset}' (expected POLYDATA, UNSTRUCTURED_GRID, or STRUCTURED_GRID)`);
    }

    // Token cursor over the remaining lines (values flow across line breaks).
    const rest = lines.slice(datasetLine + 1).join('\n');
    const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
    let cursor = 0;
    const peek = (): string | undefined => tokens[cursor];
    const next = (): string => {
        if (cursor >= tokens.length) {
            throw new Error('Unexpected end of legacy VTK file (truncated data section)');
        }
        return tokens[cursor++];
    };
    const nextInt = (what: string): number => {
        const token = next();
        if (KEYWORDS.has(token.toUpperCase())) {
            throw new Error('Unexpected end of legacy VTK file (truncated data section)');
        }
        const v = parseInt(token, 10);
        if (Number.isNaN(v)) {
            throw new Error(`Malformed legacy VTK file: expected an integer ${what}`);
        }
        return v;
    };
    const nextFloat = (what: string): number => {
        const token = next();
        if (KEYWORDS.has(token.toUpperCase())) {
            throw new Error('Unexpected end of legacy VTK file (truncated data section)');
        }
        const v = parseFloat(token);
        if (Number.isNaN(v)) {
            throw new Error(`Malformed legacy VTK file: expected a number ${what}`);
        }
        return v;
    };
    const KEYWORDS = new Set([
        'POINTS',
        'DIMENSIONS',
        'VERTICES',
        'LINES',
        'POLYGONS',
        'POLYLINES',
        'TRIANGLE_STRIPS',
        'CELLS',
        'CELL_TYPES',
        'OFFSETS',
        'POINT_DATA',
        'CELL_DATA',
        'SCALARS',
        'VECTORS',
        'NORMALS',
        'TENSORS',
        'FIELD',
        'LOOKUP_TABLE'
    ]);

    let positions = new Float32Array(0);
    let nPoints = 0;
    let pointsSeen = false;
    let gridDims: [number, number, number] | undefined;
    const vertCells: number[][] = [];
    const lineCells: number[][] = [];
    const polyCells: number[][] = [];
    const stripCells: number[][] = [];
    const ugCells: number[][] = [];
    let ugTypes: number[] = [];
    const pointArrays: NativeVtkDataArray[] = [];
    const cellArrays: NativeVtkDataArray[] = [];
    let pointDataCount = -1;
    let cellDataCount = -1;
    let dataAssociation: 'point' | 'cell' | undefined;

    const readCellList = (count: number): number[][] => {
        const cells: number[][] = [];
        for (let c = 0; c < count; c++) {
            const size = nextInt('cell size');
            if (size < 0) {
                throw new Error('Malformed legacy VTK file: negative cell size');
            }
            const ids: number[] = [];
            for (let k = 0; k < size; k++) {
                ids.push(nextInt('cell index'));
            }
            cells.push(ids);
        }
        return cells;
    };

    const readDataArray = (name: string, components: number, tuples: number): Float64Array => {
        const out = new Float64Array(tuples * components);
        for (let i = 0; i < out.length; i++) {
            out[i] = nextFloat(`data value for array '${name}'`);
        }
        return out;
    };

    while (cursor < tokens.length) {
        const keyword = peek()?.toUpperCase();
        if (keyword === 'DIMENSIONS') {
            next();
            const dims = [nextInt('DIMENSIONS nx'), nextInt('DIMENSIONS ny'), nextInt('DIMENSIONS nz')];
            if (dims.some((d) => d < 1)) {
                throw new Error('Malformed legacy VTK file: DIMENSIONS values must be positive');
            }
            gridDims = [dims[0], dims[1], dims[2]];
        } else if (keyword === 'POINTS') {
            next();
            const count = nextInt('POINTS count');
            next(); // data type (float/double/...)
            const values = new Float32Array(count * 3);
            for (let i = 0; i < values.length; i++) {
                values[i] = nextFloat('point coordinate');
            }
            positions = values;
            nPoints = count;
            pointsSeen = true;
        } else if (
            keyword === 'VERTICES' ||
            keyword === 'LINES' ||
            keyword === 'POLYGONS' ||
            keyword === 'POLYLINES' ||
            keyword === 'TRIANGLE_STRIPS' ||
            keyword === 'CELLS'
        ) {
            const section = next().toUpperCase();
            const count = nextInt(`${section} count`);
            nextInt(`${section} size`);
            // VTK 5+ writers (MOAB, recent vtk) emit an OFFSETS array instead
            // of inline [n, id...] counts, optionally followed by an explicit
            // CONNECTIVITY section. Offsets may carry a leading zero (N+1
            // entries for N cells); cells are paired with an implicit
            // leading zero and zero-length pairs are dropped, which accepts
            // both forms and the leading-zero variant alike.
            let cells: number[][];
            if ((peek() ?? '').toUpperCase() === 'OFFSETS') {
                next(); // OFFSETS
                if (/^vtk/i.test(peek() ?? '')) {
                    next(); // dtype tag, e.g. vtktypeint64
                }
                const offsets: number[] = [];
                while (true) {
                    const token = peek();
                    if (token === undefined || KEYWORDS.has(token.toUpperCase()) || !/^-?\d+$/.test(token)) {
                        break;
                    }
                    offsets.push(parseInt(next(), 10));
                }
                if ((peek() ?? '').toUpperCase() === 'CONNECTIVITY') {
                    next(); // CONNECTIVITY
                    if (/^vtk/i.test(peek() ?? '')) {
                        next(); // dtype tag
                    }
                }
                const total = offsets.length > 0 ? offsets[offsets.length - 1] : 0;
                const conn: number[] = [];
                for (let k = 0; k < total; k++) {
                    conn.push(nextInt('cell index'));
                }
                cells = [];
                let previous = 0;
                for (const end of offsets) {
                    if (end > previous) {
                        cells.push(conn.slice(previous, end).map((v) => Math.round(v)));
                    }
                    previous = end;
                }
            } else {
                cells = readCellList(count);
            }
            // NOTE: plain for-loop append — spread (`push(...cells)`) blows
            // the call stack on real files (100k+ cells in DAGMC outputs).
            if (section === 'VERTICES') {
                for (let i = 0; i < cells.length; i++) {
                    vertCells.push(cells[i]);
                }
            } else if (section === 'LINES' || section === 'POLYLINES') {
                for (let i = 0; i < cells.length; i++) {
                    lineCells.push(cells[i]);
                }
            } else if (section === 'POLYGONS') {
                for (let i = 0; i < cells.length; i++) {
                    polyCells.push(cells[i]);
                }
            } else if (section === 'TRIANGLE_STRIPS') {
                for (let i = 0; i < cells.length; i++) {
                    stripCells.push(cells[i]);
                }
            } else {
                for (let i = 0; i < cells.length; i++) {
                    ugCells.push(cells[i]);
                }
            }
        } else if (keyword === 'CELL_TYPES') {
            next();
            const count = nextInt('CELL_TYPES count');
            ugTypes = [];
            for (let i = 0; i < count; i++) {
                ugTypes.push(nextInt('cell type'));
            }
        } else if (keyword === 'POINT_DATA' || keyword === 'CELL_DATA') {
            const section = next().toUpperCase();
            const count = nextInt(`${section} count`);
            dataAssociation = section === 'POINT_DATA' ? 'point' : 'cell';
            if (dataAssociation === 'point') {
                pointDataCount = count;
            } else {
                cellDataCount = count;
            }
        } else if (keyword === 'SCALARS') {
            if (!dataAssociation) {
                throw new Error('Malformed legacy VTK file: SCALARS outside POINT_DATA/CELL_DATA');
            }
            next();
            const name = next();
            next(); // data type
            let components = 1;
            if (peek() !== undefined && /^-?\d+$/.test(peek() ?? '')) {
                components = Math.max(1, parseInt(peek() ?? '1', 10));
                next();
            }
            const lookup = next();
            if (lookup.toUpperCase() !== 'LOOKUP_TABLE') {
                throw new Error(`Malformed legacy VTK file: SCALARS '${name}' is missing its LOOKUP_TABLE line`);
            }
            next(); // table name (usually 'default')
            const expected = dataAssociation === 'point' ? pointDataCount : cellDataCount;
            if (expected < 0) {
                throw new Error(`Malformed legacy VTK file: SCALARS '${name}' has no tuple count`);
            }
            const values = readDataArray(name, components, expected);
            (dataAssociation === 'point' ? pointArrays : cellArrays).push(makeLegacyArray(name, dataAssociation, components, values));
        } else if (keyword === 'VECTORS' || keyword === 'NORMALS') {
            if (!dataAssociation) {
                throw new Error(`Malformed legacy VTK file: ${keyword} outside POINT_DATA/CELL_DATA`);
            }
            next();
            const name = next();
            next(); // data type
            const expected = dataAssociation === 'point' ? pointDataCount : cellDataCount;
            const values = readDataArray(name, 3, expected);
            (dataAssociation === 'point' ? pointArrays : cellArrays).push(makeLegacyArray(name, dataAssociation, 3, values));
        } else if (keyword === 'TENSORS') {
            if (!dataAssociation) {
                throw new Error('Malformed legacy VTK file: TENSORS outside POINT_DATA/CELL_DATA');
            }
            next();
            const name = next();
            next(); // data type
            const expected = dataAssociation === 'point' ? pointDataCount : cellDataCount;
            const values = readDataArray(name, 9, expected);
            (dataAssociation === 'point' ? pointArrays : cellArrays).push(makeLegacyArray(name, dataAssociation, 9, values));
        } else if (keyword === 'FIELD') {
            if (!dataAssociation) {
                throw new Error('Malformed legacy VTK file: FIELD outside POINT_DATA/CELL_DATA');
            }
            next(); // FIELD keyword
            next(); // field name
            const numArrays = nextInt('FIELD array count');
            const expected = dataAssociation === 'point' ? pointDataCount : cellDataCount;
            for (let a = 0; a < numArrays; a++) {
                const arrayName = next();
                const numComponents = nextInt(`FIELD array '${arrayName}' component count`);
                const numTuples = nextInt(`FIELD array '${arrayName}' tuple count`);
                next(); // data type
                if (numTuples !== expected) {
                    throw new Error(`FIELD array '${arrayName}' has ${numTuples} tuples for ${expected} ${dataAssociation} entries`);
                }
                const values = readDataArray(arrayName, numComponents, numTuples);
                (dataAssociation === 'point' ? pointArrays : cellArrays).push(
                    makeLegacyArray(arrayName, dataAssociation, numComponents, values)
                );
            }
        } else {
            throw new Error(`Unsupported legacy VTK section '${peek()}'`);
        }
    }

    if (!pointsSeen) {
        throw new Error('Legacy VTK file has no POINTS section');
    }
    if (dataset === 'UNSTRUCTURED_GRID') {
        if (ugCells.length === 0) {
            throw new Error('Legacy VTK UNSTRUCTURED_GRID file has no CELLS section');
        }
        if (ugTypes.length === 0) {
            throw new Error('Legacy VTK UNSTRUCTURED_GRID file has no CELL_TYPES section');
        }
        if (ugTypes.length !== ugCells.length) {
            throw new Error(`Legacy VTK CELLS (${ugCells.length}) and CELL_TYPES (${ugTypes.length}) counts disagree`);
        }
    }

    const segments: number[] = [];
    const segmentCells: number[] = [];
    const vertices: number[] = [];
    const triangles: number[] = [];
    const triangleCells: number[] = [];
    let nonTriangleCells = 0;
    const pushTriangle = (tri: number[], cell: number): void => {
        triangles.push(tri[0], tri[1], tri[2]);
        triangleCells.push(cell);
        segments.push(tri[0], tri[1], tri[1], tri[2], tri[2], tri[0]);
        segmentCells.push(cell, cell, cell);
    };

    if (dataset === 'STRUCTURED_GRID') {
        // Regular-grid datasets (OpenMC mesh exports): average the 8
        // corners into cell centers like the `.vts` path. Axis-aligned
        // lattices additionally carry voxel axes (possibly non-uniform);
        // anything else stays a cell-center preview.
        if (!gridDims) {
            throw new Error('Legacy VTK STRUCTURED_GRID file has no DIMENSIONS section');
        }
        const [snx, sny, snz] = gridDims;
        const cellDims: [number, number, number] = [snx - 1, sny - 1, snz - 1];
        if (cellDims.some((d) => d < 1)) {
            throw new Error('Legacy VTK STRUCTURED_GRID file has an empty grid (DIMENSIONS must exceed 1 per axis)');
        }
        if (nPoints !== snx * sny * snz) {
            throw new Error(`Legacy VTK STRUCTURED_GRID has ${nPoints} points for a ${snx}x${sny}x${snz} grid`);
        }
        const structuredCells = cellDims[0] * cellDims[1] * cellDims[2];
        if (cellDataCount >= 0 && cellDataCount !== structuredCells) {
            throw new Error(`Legacy VTK CELL_DATA (${cellDataCount}) does not match the cell count (${structuredCells})`);
        }
        if (pointDataCount >= 0 && pointDataCount !== nPoints) {
            throw new Error(`Legacy VTK POINT_DATA (${pointDataCount}) does not match the point count (${nPoints})`);
        }
        const cornerAt = (i: number, j: number, k: number): number => (i + snx * (j + sny * k)) * 3;
        const centers = new Float32Array(structuredCells * 3);
        let centerAt = 0;
        for (let k = 0; k < cellDims[2]; k++) {
            for (let j = 0; j < cellDims[1]; j++) {
                for (let i = 0; i < cellDims[0]; i++) {
                    for (let d = 0; d < 3; d++) {
                        centers[centerAt + d] =
                            (positions[cornerAt(i, j, k) + d] +
                                positions[cornerAt(i + 1, j, k) + d] +
                                positions[cornerAt(i, j + 1, k) + d] +
                                positions[cornerAt(i + 1, j + 1, k) + d] +
                                positions[cornerAt(i, j, k + 1) + d] +
                                positions[cornerAt(i + 1, j, k + 1) + d] +
                                positions[cornerAt(i, j + 1, k + 1) + d] +
                                positions[cornerAt(i + 1, j + 1, k + 1) + d]) /
                            8;
                    }
                    centerAt += 3;
                }
            }
        }
        // Axis alignment (exact match: generated lattices repeat decimals):
        // x varies only with i, y only with j, z only with k, strictly
        // increasing so voxel boxes keep positive sizes.
        const axisOf = (axis: 0 | 1 | 2): Float64Array | undefined => {
            const count = [snx, sny, snz][axis];
            const values = new Float64Array(count);
            for (let n = 0; n < count; n++) {
                const probe = axis === 0 ? cornerAt(n, 0, 0) + axis : axis === 1 ? cornerAt(0, n, 0) + axis : cornerAt(0, 0, n) + axis;
                values[n] = positions[probe] ?? Number.NaN;
            }
            for (let n = 1; n < count; n++) {
                if (!(values[n] > values[n - 1])) {
                    return undefined;
                }
            }
            return values;
        };
        const matchesAxis = (axis: 0 | 1 | 2, reference: Float64Array): boolean => {
            for (let k = 0; k < snz; k++) {
                for (let j = 0; j < sny; j++) {
                    for (let i = 0; i < snx; i++) {
                        const probe = axis === 0 ? i : axis === 1 ? j : k;
                        if (positions[cornerAt(i, j, k) + axis] !== reference[probe]) {
                            return false;
                        }
                    }
                }
            }
            return true;
        };
        const xAxis = axisOf(0);
        const yAxis = axisOf(1);
        const zAxis = axisOf(2);
        const gridAxes: [Float64Array, Float64Array, Float64Array] | undefined =
            xAxis && yAxis && zAxis && matchesAxis(0, xAxis) && matchesAxis(1, yAxis) && matchesAxis(2, zAxis)
                ? [xAxis, yAxis, zAxis]
                : undefined;
        return {
            family: 'rectilinear',
            nPoints: structuredCells,
            positions: centers,
            gridDimensions: cellDims,
            gridAxes,
            pointArrays,
            cellArrays
        };
    }

    if (dataset === 'POLYDATA') {
        for (const ids of vertCells) {
            vertices.push(...ids);
        }
        lineCells.forEach((ids, lineIndex) => {
            for (let k = 0; k + 1 < ids.length; k++) {
                segments.push(ids[k], ids[k + 1]);
                segmentCells.push(vertCells.length + lineIndex);
            }
        });
        polyCells.forEach((ids, polyIndex) => {
            const cell = vertCells.length + lineCells.length + polyIndex;
            if (ids.length >= 3) {
                for (let k = 1; k + 1 < ids.length; k++) {
                    pushTriangle([ids[0], ids[k], ids[k + 1]], cell);
                }
            } else if (ids.length === 2) {
                segments.push(ids[0], ids[1]);
                segmentCells.push(cell);
            } else {
                vertices.push(...ids);
            }
        });
        stripCells.forEach((ids, stripIndex) => {
            const cell = vertCells.length + lineCells.length + polyCells.length + stripIndex;
            const { edges } = linearizeLegacyCell(6, ids);
            if (ids.length >= 3) {
                for (let k = 0; k + 2 < ids.length; k++) {
                    const tri = k % 2 === 0 ? [ids[k], ids[k + 1], ids[k + 2]] : [ids[k + 1], ids[k], ids[k + 2]];
                    pushTriangle(tri, cell);
                }
            } else {
                for (const [a, b] of edges) {
                    segments.push(a, b);
                    segmentCells.push(cell);
                }
            }
        });
        const totalCells = vertCells.length + lineCells.length + polyCells.length + stripCells.length;
        if (cellDataCount >= 0 && cellDataCount !== totalCells) {
            throw new Error(`Legacy VTK CELL_DATA (${cellDataCount}) does not match the cell count (${totalCells})`);
        }
        if (pointDataCount >= 0 && pointDataCount !== nPoints) {
            throw new Error(`Legacy VTK POINT_DATA (${pointDataCount}) does not match the point count (${nPoints})`);
        }
    } else {
        ugTypes.forEach((type, cell) => {
            const ids = ugCells[cell];
            if (type === 1 || type === 2) {
                vertices.push(...ids);
                return;
            }
            const { edges, surface } = linearizeLegacyCell(type, ids);
            if (surface && surface.length === 3) {
                pushTriangle(surface, cell);
                return;
            }
            if (surface && surface.length > 3) {
                for (let k = 1; k + 1 < surface.length; k++) {
                    pushTriangle([surface[0], surface[k], surface[k + 1]], cell);
                }
                return;
            }
            if (edges.length > 0) {
                for (const [a, b] of edges) {
                    segments.push(a, b);
                    segmentCells.push(cell);
                }
                return;
            }
            if (type === 5 || type === 7 || type === 9) {
                nonTriangleCells++;
                return;
            }
            nonTriangleCells++;
        });
        if (cellDataCount >= 0 && cellDataCount !== ugCells.length) {
            throw new Error(`Legacy VTK CELL_DATA (${cellDataCount}) does not match the cell count (${ugCells.length})`);
        }
        if (pointDataCount >= 0 && pointDataCount !== nPoints) {
            throw new Error(`Legacy VTK POINT_DATA (${pointDataCount}) does not match the point count (${nPoints})`);
        }
    }

    return {
        family: 'polydata',
        nPoints,
        positions,
        segments: segments.length > 0 ? new Uint32Array(segments) : undefined,
        segmentCells: segmentCells.length > 0 ? new Uint32Array(segmentCells) : undefined,
        vertices: vertices.length > 0 ? new Uint32Array(vertices) : undefined,
        pointArrays,
        cellArrays,
        triangles: triangles.length > 0 ? new Uint32Array(triangles) : undefined,
        triangleCells: triangleCells.length > 0 ? new Uint32Array(triangleCells) : undefined,
        nonTriangleCells,
        skippedArrays: []
    };
}

/** Read the `<VTKFile type="...">` dataset type without fully parsing. */
export function sniffVtkDatasetType(text: string): string | undefined {
    const root = VTKFILE_RE.exec(text);
    if (root) {
        return parseAttributes(root[1])['type'];
    }
    const legacy = /^\s*#\s*vtk DataFile[\s\S]*?^\s*DATASET\s+(\w+)/im.exec(text);
    return legacy ? legacy[1] : undefined;
}

/**
 * Parse any natively supported VTK text: XML kinds (`.vtp`/`.vtr`/`.vti`
 * plus `.vtu`/`.vts`) or legacy ASCII `.vtk` (PolyData/UnstructuredGrid).
 * Dispatches on content (the `<VTKFile` root vs the legacy header), so the
 * generic visualizer probe accepts converted DAGMC/STEP/FEM outputs
 * without an extension gate. Binary legacy files throw an ASCII-only error.
 */
export async function parseNativeVtk(text: string, fileExtension = ''): Promise<NativeVtkModel> {
    const trimmed = text.replace(/^\s+/, '');
    if (trimmed.includes('<VTKFile')) {
        return parseNativeVtkXml(text);
    }
    if (/^#\s*vtk DataFile/i.test(trimmed.slice(0, 256))) {
        return parseLegacyVtkAscii(text);
    }
    if (fileExtension.toLowerCase() === '.vtk') {
        return parseLegacyVtkAscii(text);
    }
    throw new Error('Not a VTK dataset: missing <VTKFile> root element or legacy "# vtk DataFile" header');
}

/**
 * Viewer read budget: Theia's `files.maxFileSizeMB` gate targets editors,
 * and converter meshes (a filtered DAGMC file is tens of MB) legitimately
 * exceed it. Viewer reads raise the limit explicitly instead of failing.
 */
export const NATIVE_VTK_MAX_READ_BYTES = 256 * 1024 * 1024;

/** Minimal structural surface of Theia's `FileService.read` (keeps this module import-free). */
export interface VtkTextReader {
    read(uri: unknown, options?: { limits?: { readonly size?: number } }): Promise<{ value: string }>;
}

/** Read VTK/JSON text through a `FileService` with the viewer budget applied. */
export async function readVtkText(reader: VtkTextReader, uri: unknown): Promise<string> {
    try {
        const content = await reader.read(uri, { limits: { size: NATIVE_VTK_MAX_READ_BYTES } });
        return content.value;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/too large/i.test(message)) {
            throw new Error(
                `File exceeds the ${Math.round(NATIVE_VTK_MAX_READ_BYTES / 1024 / 1024)} MB viewer read budget. ` +
                    'Decimate or split the mesh before opening it.'
            );
        }
        throw error;
    }
}
