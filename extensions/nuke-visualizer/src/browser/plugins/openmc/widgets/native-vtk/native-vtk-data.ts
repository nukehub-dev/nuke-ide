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
 * migration): color-by parsing, array classification for the four P1 dataset
 * kinds (tracks `.vtp` polylines, collision `.vtp` points, weight-windows
 * `.vtr` rectilinear grids, voxel `.vti` image data), the 6-map colormap LUT
 * pack, point-budget decimation, and a dependency-free VTK XML reader.
 *
 * No DOM, DI, or three.js dependencies — unit-testable in node. The reader is
 * hand-rolled (rather than three.js `VTKLoader`, which only carries PolyData)
 * so all four kinds parse through one path with named point/cell arrays and
 * ranges preserved for instant client-side color-by. It handles `ascii` and
 * `appended` DataArray encodings; appended blocks may be raw or zlib
 * compressed (vtk default) — decompression uses the platform
 * `DecompressionStream('deflate')`, available in Chromium and Node 18+.
 */

import type { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';

// ============================================================================
// Dataset kinds
// ============================================================================

/** VTK dataset families the native viewer renders. */
export type NativeVtkDatasetFamily = 'polydata' | 'rectilinear' | 'image';

/**
 * Detect the dataset family from an `openmc.vtk-info` type string (e.g.
 * `vtkPolyData`) or a file extension. Returns undefined when unknown.
 */
export function detectNativeVtkFamily(vtkType: string, fileExtension: string): NativeVtkDatasetFamily | undefined {
    const type = vtkType.toLowerCase();
    if (type.includes('rectilinear') || fileExtension.toLowerCase() === '.vtr') {
        return 'rectilinear';
    }
    if (type.includes('imagedata') || fileExtension.toLowerCase() === '.vti') {
        return 'image';
    }
    if (type.includes('polydata') || fileExtension.toLowerCase() === '.vtp') {
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
// Colormaps (the 6 short maps from COLOR_MAPS_SHORT + legend sampling)
// ============================================================================

/** Short colormap pack shipped first (ParaView `ColorMaps.json` names). */
export const NATIVE_VTK_COLORMAPS = ['Plasma', 'Viridis', 'Inferno', 'Jet', 'Hot', 'Cool'] as const;

/** One of the six short colormap names. */
export type NativeVtkColormapName = (typeof NATIVE_VTK_COLORMAPS)[number];

/** Default colormap for freshly opened datasets. */
export const DEFAULT_COLORMAP: NativeVtkColormapName = 'Plasma';

type Rgb = [number, number, number];

/** Control-point stops (0..1 RGB) approximating each short map. */
const COLORMAP_STOPS: Record<NativeVtkColormapName, Rgb[]> = {
    Viridis: [
        [0.267, 0.005, 0.329],
        [0.283, 0.141, 0.458],
        [0.254, 0.265, 0.53],
        [0.207, 0.372, 0.553],
        [0.164, 0.471, 0.558],
        [0.128, 0.567, 0.551],
        [0.135, 0.659, 0.518],
        [0.267, 0.749, 0.441],
        [0.478, 0.821, 0.318],
        [0.741, 0.873, 0.15],
        [0.993, 0.906, 0.144]
    ],
    Plasma: [
        [0.05, 0.031, 0.529],
        [0.254, 0.016, 0.616],
        [0.416, 0.0, 0.659],
        [0.561, 0.051, 0.642],
        [0.694, 0.165, 0.565],
        [0.798, 0.28, 0.47],
        [0.882, 0.392, 0.384],
        [0.949, 0.517, 0.295],
        [0.988, 0.652, 0.211],
        [0.988, 0.807, 0.145],
        [0.941, 0.976, 0.129]
    ],
    Inferno: [
        [0.0, 0.0, 0.016],
        [0.106, 0.047, 0.255],
        [0.29, 0.047, 0.42],
        [0.471, 0.11, 0.427],
        [0.647, 0.173, 0.376],
        [0.812, 0.267, 0.275],
        [0.929, 0.412, 0.145],
        [0.985, 0.608, 0.024],
        [0.969, 0.82, 0.238],
        [0.988, 1.0, 0.643]
    ],
    Jet: [
        [0.0, 0.0, 0.5],
        [0.0, 0.0, 1.0],
        [0.0, 0.5, 1.0],
        [0.0, 1.0, 1.0],
        [0.5, 1.0, 0.5],
        [1.0, 1.0, 0.0],
        [1.0, 0.5, 0.0],
        [1.0, 0.0, 0.0],
        [0.5, 0.0, 0.0]
    ],
    Hot: [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [1.0, 1.0, 1.0]
    ],
    Cool: [
        [0.0, 1.0, 1.0],
        [1.0, 0.0, 1.0]
    ]
};

/** Sample a colormap at t in [0, 1] (clamped) with piecewise-linear stops. */
export function sampleNativeColormap(name: NativeVtkColormapName, t: number): Rgb {
    const stops = COLORMAP_STOPS[name] ?? COLORMAP_STOPS[DEFAULT_COLORMAP];
    const clamped = Math.min(1, Math.max(0, t));
    const scaled = clamped * (stops.length - 1);
    const lower = Math.min(stops.length - 2, Math.floor(scaled));
    const f = scaled - lower;
    const a = stops[lower];
    const b = stops[lower + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Normalize a scalar into [0, 1] over [min, max] (degenerate range maps to 0). */
export function normalizeToUnit(value: number, min: number, max: number): number {
    if (!(max > min)) {
        return 0;
    }
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Scalar value of one tuple (vector magnitude for multi-component arrays). */
export function tupleValue(values: ArrayLike<number>, components: number, tupleIndex: number): number {
    if (components <= 1) {
        return values[tupleIndex];
    }
    let sum = 0;
    for (let c = 0; c < components; c++) {
        const v = values[tupleIndex * components + c];
        sum += v * v;
    }
    return Math.sqrt(sum);
}

// ============================================================================
// Point budget (decimation stride for large clouds/grids)
// ============================================================================

/** Default cap for natively rendered points (CAD 2M-triangle budget thinking). */
export const NATIVE_VTK_POINT_BUDGET = 200000;

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
    pointArrays: NativeVtkDataArray[];
    cellArrays: NativeVtkDataArray[];
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
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 4) {
        const a = lookup.get(clean[i]) ?? 0;
        const b = lookup.get(clean[i + 1]) ?? 0;
        const c = lookup.get(clean[i + 2]) ?? 0;
        const d = lookup.get(clean[i + 3]) ?? 0;
        const triple = (a << 18) | (b << 12) | (c << 6) | d;
        bytes.push((triple >> 16) & 0xff, (triple >> 8) & 0xff, triple & 0xff);
    }
    let length = bytes.length;
    if (clean.endsWith('==')) {
        length -= 2;
    } else if (clean.endsWith('=')) {
        length -= 1;
    }
    return new Uint8Array(bytes.slice(0, length));
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

async function inflateBlock(block: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('Compressed VTK block needs DecompressionStream, which this runtime does not provide');
    }
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    await writer.write(block as unknown as ArrayBuffer);
    await writer.close();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        chunks.push(value);
        total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
}

/**
 * Decode one appended block: `[length][payload]`, payload raw or vtk-zlib
 * (`[#blocks][u-size][p-size][c-size...][data...]`, header_type-sized tokens).
 */
async function decodeAppendedBlock(
    blob: Uint8Array,
    offset: number,
    headerBytes: number,
    compressed: boolean,
    type: string
): Promise<Float64Array> {
    const view = new DataView(blob.buffer, blob.byteOffset + offset);
    const readToken = (at: number): number => {
        let v = 0;
        for (let i = 0; i < headerBytes; i++) {
            v |= view.getUint8(at + i) << (8 * i);
        }
        return v;
    };
    if (!compressed) {
        const nbytes = readToken(0);
        return readTypedValues(blob.subarray(offset + headerBytes, offset + headerBytes + nbytes), type);
    }
    const nBlocks = readToken(0);
    const cSizeStart = 3 * headerBytes;
    const dataStart = offset + (nBlocks + 3) * headerBytes;
    const parts: Uint8Array[] = [];
    let at = dataStart;
    for (let b = 0; b < nBlocks; b++) {
        const cSize = readToken(offset + cSizeStart + b * headerBytes);
        parts.push(await inflateBlock(blob.subarray(at, at + cSize)));
        at += cSize;
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
        joined.set(part, cursor);
        cursor += part.length;
    }
    return readTypedValues(joined, type);
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
    appended: { blob: Uint8Array; headerBytes: number; compressed: boolean } | undefined
): Promise<DecodedArray> {
    const expected = expectedTuples * raw.components;
    if (raw.format === 'appended') {
        if (!appended || raw.offset === undefined) {
            throw new Error(`DataArray '${raw.name || '<connectivity>'}' uses appended encoding but no AppendedData section was found`);
        }
        return {
            values: await decodeAppendedBlock(appended.blob, raw.offset, appended.headerBytes, appended.compressed, dataType),
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
        const v = tupleValue(decoded, raw.components, i);
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
 * ImageData) as written by VTK's XML writers (including
 * `output_vtk.py`): ascii or appended (raw/zlib) encodings, little-endian.
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

    let appended: { blob: Uint8Array; headerBytes: number; compressed: boolean } | undefined;
    const appendedSections = collectSections(text, 'AppendedData');
    if (appendedSections.length > 0) {
        const payload = appendedSections[0].replace(/^\s*_/, '').trim();
        appended = { blob: decodeBase64(payload), headerBytes, compressed };
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

        // Connectivity: walk [n, id...] cells into renderable index lists.
        // Cells are numbered verts-first, then lines, then polys (VTK order).
        const readCells = async (tag: string): Promise<number[][]> => {
            const cells: number[][] = [];
            for (const section of collectSections(text, tag)) {
                for (const { raw, dataType } of typedArrays(section)) {
                    const decoded = await decodeDataArray(raw, dataType, 0, appended);
                    const values = decoded.values;
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
                }
            }
            return cells;
        };
        const vertCells = await readCells('Verts');
        const lineCells = await readCells('Lines');
        const polyCells = await readCells('Polys');
        const segments: number[] = [];
        const segmentCells: number[] = [];
        const vertices: number[] = [];
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
            for (let k = 0; k < ids.length; k++) {
                segments.push(ids[k], ids[(k + 1) % ids.length]);
                segmentCells.push(vertCells.length + lineCells.length + polyIndex);
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
            cellArrays
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
        return { family, nPoints: nCells, positions: centers, gridDimensions: [nx, ny, nz], pointArrays, cellArrays };
    }

    throw new Error(`Unsupported VTK dataset type '${fileType}' (expected PolyData, RectilinearGrid, or ImageData)`);
}
