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
 * Client-side multiblock expand for DAGMC volumes (P2-C2 of the
 * trame-to-frontend migration).
 *
 * The Python converter (`convert_h5m_to_multiblock_vtk` in
 * `python/plugins/base/lib/dagmc.py`) writes one `.vtm` manifest whose
 * `<DataSet>` entries reference per-volume `.vtu` files. This module expands
 * that manifest in the browser: parse the `.vtm` XML into block references,
 * resolve each block file against the manifest path, and parse every block
 * into a renderable model.
 *
 * Blocks written by other writers (`.vtp`/`.vtr`/`.vti`) go through the
 * native-vtk parse path (`parseNativeVtkXml`); `.vtu` unstructured grids —
 * the DAGMC volume format — are parsed here because the P1 reader only
 * covers PolyData/RectilinearGrid/ImageData. The `.vtu` decoder mirrors its
 * ascii/appended (raw/zlib) handling; the small amount of duplicated decode
 * logic is deliberate so the P1 module stays untouched.
 *
 * String cell arrays (`material`, `groups`) are recorded by name but not
 * decoded — per-cell material labels reach the UI through the
 * `get_dagmc_model_info` JSON channel (see `dagmc-toggle-model.ts`), which
 * carries material/group/volume membership without parsing strings out of
 * the geometry files. Numeric cell arrays (`volume_id`, ...) decode fully
 * and stay available for color-by.
 *
 * Pure functions + one async expand helper driven by a caller-supplied
 * `readFile` callback, so the widget injects `FileService` reads and tests
 * inject in-memory fixtures. No DOM, no DI, no three.js.
 */

import type { AxisAlignedBounds } from '../../../../viewer-core/clip-plane';
import { boundingBoxFromPositions } from '../../../../viewer-core/clip-plane';
import type { NativeVtkDataArray, NativeVtkModel } from '../native-vtk/native-vtk-data';
import { decodeBase64, parseNativeVtkXml, tupleValue } from '../native-vtk/native-vtk-data';

/** One block referenced by a `.vtm` manifest. */
export interface DagmcBlockRef {
    readonly index: number;
    readonly name: string;
    readonly file: string;
}

/**
 * One expanded block: a native VTK model plus its manifest identity and —
 * for unstructured surface blocks — the triangle index triples used to build
 * a three.js mesh (`triangles` holds point indices, three per triangle).
 * Non-`.vtu` blocks reuse the native model shape with no `triangles`.
 */
export interface DagmcBlockModel extends NativeVtkModel {
    readonly blockName: string;
    readonly blockIndex: number;
    readonly sourceFile: string;
    readonly triangles?: Uint32Array;
    /** Cell index per triangle in `triangles` (fan-split polygons repeat their cell). */
    readonly triangleCells?: Uint32Array;
    /** Cells skipped while triangulating (non-triangle/polygon/quad types). */
    readonly nonTriangleCells: number;
    /** Data-array names skipped (string-typed arrays; see module docs). */
    readonly skippedArrays: string[];
}

/** Callback supplying block file text for a resolved block path. */
export type DagmcBlockReader = (resolvedPath: string) => Promise<string>;

// ---------------------------------------------------------------------------
// .vtm manifest
// ---------------------------------------------------------------------------

const VTM_TYPE_RE = /<VTKFile\b([^>]*)>/;
const VTM_DATASET_RE = /<(?:DataSet|Block)\b([^>]*?)\/>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

function parseXmlAttributes(fragment: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    ATTR_RE.lastIndex = 0;
    let match = ATTR_RE.exec(fragment);
    while (match) {
        attrs[match[1]] = match[2];
        match = ATTR_RE.exec(fragment);
    }
    return attrs;
}

/**
 * Parse a `.vtm` manifest into its block references (sorted by index).
 * Throws when the text is not a multiblock manifest or a block lacks the
 * `file` attribute needed for client-side expansion.
 */
export function parseVtmManifest(text: string): DagmcBlockRef[] {
    const root = VTM_TYPE_RE.exec(text);
    if (!root) {
        throw new Error('Not a VTK XML file: missing <VTKFile> root element');
    }
    const rootType = parseXmlAttributes(root[1])['type'] ?? '';
    if (rootType !== 'vtkMultiBlockDataSet') {
        throw new Error(`Not a multiblock manifest: VTK type is '${rootType}' (expected vtkMultiBlockDataSet)`);
    }
    const refs: DagmcBlockRef[] = [];
    VTM_DATASET_RE.lastIndex = 0;
    let match = VTM_DATASET_RE.exec(text);
    while (match) {
        const attrs = parseXmlAttributes(match[1]);
        const file = attrs['file'];
        if (!file) {
            throw new Error('Multiblock manifest has a <DataSet> entry without a file attribute (inline blocks are not supported)');
        }
        const index = attrs['index'] !== undefined ? parseInt(attrs['index'], 10) : refs.length;
        refs.push({ index: Number.isNaN(index) ? refs.length : index, name: attrs['name'] ?? `Block_${refs.length}`, file });
        match = VTM_DATASET_RE.exec(text);
    }
    return refs.sort((a, b) => a.index - b.index);
}

/**
 * Resolve a manifest-relative block file against the manifest path using
 * `/`-separated path semantics (no node `path` import — this runs in the
 * browser). Absolute block files pass through unchanged.
 */
export function resolveBlockPath(vtmPath: string, blockFile: string): string {
    if (blockFile.startsWith('/')) {
        return blockFile;
    }
    const slash = vtmPath.lastIndexOf('/');
    const base = slash >= 0 ? vtmPath.slice(0, slash + 1) : '';
    const parts: string[] = [];
    for (const part of `${base}${blockFile}`.split('/')) {
        if (part === '' || part === '.') {
            if (part === '' && parts.length === 0) {
                parts.push('');
            }
            continue;
        }
        if (part === '..') {
            if (parts.length > 1) {
                parts.pop();
            }
            continue;
        }
        parts.push(part);
    }
    const joined = parts.join('/');
    return joined === '' ? blockFile : joined;
}

// ---------------------------------------------------------------------------
// .vtu unstructured-grid decoder (DAGMC volume blocks)
// ---------------------------------------------------------------------------

const VTU_SECTION_RE = (tag: string): RegExp => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
const VTU_DATAARRAY_RE = /<DataArray\b([^>]*?)(?:\/>|>([\s\S]*?)<\/DataArray>)/g;

interface RawVtuArray {
    name: string;
    dataType: string;
    components: number;
    format: string;
    offset?: number;
    text?: string;
}

function collectVtuSections(xml: string, tag: string): string[] {
    const sections: string[] = [];
    const re = VTU_SECTION_RE(tag);
    let match = re.exec(xml);
    while (match) {
        sections.push(match[1]);
        match = re.exec(xml);
    }
    return sections;
}

function collectVtuArrays(sectionText: string): RawVtuArray[] {
    const out: RawVtuArray[] = [];
    VTU_DATAARRAY_RE.lastIndex = 0;
    let match = VTU_DATAARRAY_RE.exec(sectionText);
    while (match) {
        const attrs = parseXmlAttributes(match[1]);
        out.push({
            name: attrs['Name'] ?? attrs['name'] ?? '',
            dataType: attrs['type'] ?? 'Float64',
            components: attrs['NumberOfComponents'] !== undefined ? parseInt(attrs['NumberOfComponents'], 10) : 1,
            format: (attrs['format'] ?? 'ascii').toLowerCase(),
            offset: attrs['offset'] !== undefined ? parseInt(attrs['offset'], 10) : undefined,
            text: match[2]
        });
        match = VTU_DATAARRAY_RE.exec(sectionText);
    }
    return out;
}

const VTU_TYPE_SIZES: Record<string, number> = {
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

function readVtuTypedValues(bytes: Uint8Array, type: string): Float64Array {
    const size = VTU_TYPE_SIZES[type];
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

async function inflateVtuBlock(block: Uint8Array): Promise<Uint8Array> {
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

async function decodeVtuAppendedBlock(
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
        return readVtuTypedValues(blob.subarray(offset + headerBytes, offset + headerBytes + nbytes), type);
    }
    const nBlocks = readToken(0);
    const cSizeStart = 3 * headerBytes;
    const dataStart = offset + (nBlocks + 3) * headerBytes;
    const parts: Uint8Array[] = [];
    let at = dataStart;
    for (let b = 0; b < nBlocks; b++) {
        const cSize = readToken(offset + cSizeStart + b * headerBytes);
        parts.push(await inflateVtuBlock(blob.subarray(at, at + cSize)));
        at += cSize;
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts) {
        joined.set(part, cursor);
        cursor += part.length;
    }
    return readVtuTypedValues(joined, type);
}

function parseVtuAsciiValues(text: string | undefined, type: string): Float64Array {
    if (!text) {
        return new Float64Array(0);
    }
    const tokens = text.split(/\s+/).filter((token) => token.length > 0);
    const out = new Float64Array(tokens.length);
    const integer = VTU_TYPE_SIZES[type] !== undefined && type !== 'Float32' && type !== 'Float64';
    for (let i = 0; i < tokens.length; i++) {
        out[i] = integer ? parseInt(tokens[i], 10) : parseFloat(tokens[i]);
    }
    return out;
}

interface VtuAppended {
    blob: Uint8Array;
    headerBytes: number;
    compressed: boolean;
}

async function decodeVtuArray(raw: RawVtuArray, appended: VtuAppended | undefined): Promise<Float64Array> {
    if (raw.format === 'appended') {
        if (!appended || raw.offset === undefined) {
            throw new Error(`DataArray '${raw.name || '<cells>'}' uses appended encoding but no AppendedData section was found`);
        }
        return decodeVtuAppendedBlock(appended.blob, raw.offset, appended.headerBytes, appended.compressed, raw.dataType);
    }
    return parseVtuAsciiValues(raw.text, raw.dataType);
}

function toVtuDataArray(raw: RawVtuArray, decoded: Float64Array, association: 'point' | 'cell'): NativeVtkDataArray {
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

/** VTK cell type ids triangulated here (triangle + polygon/quad fans). */
const VTK_TRIANGLE = 5;
const VTK_POLYGON = 7;
const VTK_QUAD = 9;

/**
 * Parse a `.vtu` unstructured-grid block (the DAGMC volume format) into a
 * `polydata`-family model: triangle edges become `segments` (with per-edge
 * cell ids in `segmentCells` for cell color-by) and the triangle index
 * triples are kept in `triangles` for mesh rendering.
 */
export async function parseUnstructuredGridXml(text: string, blockName = '', blockIndex = 0, sourceFile = ''): Promise<DagmcBlockModel> {
    const root = VTM_TYPE_RE.exec(text);
    if (!root) {
        throw new Error('Not a VTK XML file: missing <VTKFile> root element');
    }
    const fileAttrs = parseXmlAttributes(root[1]);
    if ((fileAttrs['type'] ?? '') !== 'UnstructuredGrid') {
        throw new Error(`Unsupported VTK dataset type '${fileAttrs['type'] ?? ''}' (expected UnstructuredGrid)`);
    }
    if ((fileAttrs['byte_order'] ?? 'LittleEndian') !== 'LittleEndian') {
        throw new Error(`Unsupported VTK byte order '${fileAttrs['byte_order']}' (only LittleEndian is supported)`);
    }
    const headerBytes = (fileAttrs['header_type'] ?? 'UInt32') === 'UInt64' ? 8 : 4;
    const compressed = fileAttrs['compressor'] !== undefined;

    let appended: VtuAppended | undefined;
    const appendedSections = collectVtuSections(text, 'AppendedData');
    if (appendedSections.length > 0) {
        appended = { blob: decodeBase64(appendedSections[0].replace(/^\s*_/, '').trim()), headerBytes, compressed };
    }

    const pieceMatch = /<Piece\b([^>]*)>/.exec(text);
    const pieceAttrs = pieceMatch ? parseXmlAttributes(pieceMatch[1]) : {};
    const nPoints = pieceAttrs['NumberOfPoints'] !== undefined ? parseInt(pieceAttrs['NumberOfPoints'], 10) : 0;

    const pointsSections = collectVtuSections(text, 'Points');
    if (pointsSections.length === 0) {
        throw new Error('UnstructuredGrid file has no <Points> section');
    }
    const pointsArrays = collectVtuArrays(pointsSections[0]);
    if (pointsArrays.length === 0) {
        throw new Error('UnstructuredGrid <Points> section has no DataArray');
    }
    const pointsDecoded = await decodeVtuArray(pointsArrays[0], appended);
    const positions = new Float32Array(pointsDecoded.subarray(0, nPoints * 3));

    const pointArrays: NativeVtkDataArray[] = [];
    const cellArrays: NativeVtkDataArray[] = [];
    const skippedArrays: string[] = [];
    const decodeSection = async (tag: 'PointData' | 'CellData'): Promise<NativeVtkDataArray[]> => {
        const out: NativeVtkDataArray[] = [];
        for (const section of collectVtuSections(text, tag)) {
            for (const raw of collectVtuArrays(section)) {
                if (raw.dataType === 'String') {
                    skippedArrays.push(raw.name);
                    continue;
                }
                out.push(toVtuDataArray(raw, await decodeVtuArray(raw, appended), tag === 'PointData' ? 'point' : 'cell'));
            }
        }
        return out;
    };
    pointArrays.push(...(await decodeSection('PointData')));
    cellArrays.push(...(await decodeSection('CellData')));

    const cellsSections = collectVtuSections(text, 'Cells');
    if (cellsSections.length === 0) {
        throw new Error('UnstructuredGrid file has no <Cells> section');
    }
    let connectivity: Float64Array = new Float64Array(0);
    let offsets: Float64Array = new Float64Array(0);
    let types: Float64Array = new Float64Array(0);
    for (const raw of collectVtuArrays(cellsSections[0])) {
        const lowered = raw.name.toLowerCase();
        const decoded = await decodeVtuArray(raw, appended);
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
        blockName,
        blockIndex,
        sourceFile,
        triangles: triangles.length > 0 ? new Uint32Array(triangles) : undefined,
        triangleCells: triangleCells.length > 0 ? new Uint32Array(triangleCells) : undefined,
        nonTriangleCells,
        skippedArrays
    };
}

/** Read the `<VTKFile type="...">` dataset type without fully parsing. */
export function sniffVtkDatasetType(text: string): string | undefined {
    const root = VTM_TYPE_RE.exec(text);
    return root ? parseXmlAttributes(root[1])['type'] : undefined;
}

/**
 * Parse one block dataset, dispatching on the block file extension:
 * `.vtu` (or sniffed `UnstructuredGrid`) through the unstructured-grid
 * decoder, everything else through the native-vtk parse path.
 */
export async function parseBlockDataset(blockFile: string, text: string, blockName: string, blockIndex: number): Promise<DagmcBlockModel> {
    const extension = blockFile.slice(blockFile.lastIndexOf('.')).toLowerCase();
    if (extension === '.vtu' || sniffVtkDatasetType(text) === 'UnstructuredGrid') {
        return parseUnstructuredGridXml(text, blockName, blockIndex, blockFile);
    }
    const model = await parseNativeVtkXml(text);
    return { ...model, blockName, blockIndex, sourceFile: blockFile, nonTriangleCells: 0, skippedArrays: [] };
}

/**
 * Expand a `.vtm` manifest into per-block models: parse the manifest,
 * resolve each block file against `vtmPath`, read it through `readFile`,
 * and parse it. Failures name the offending block file. Models come back
 * sorted by block index.
 */
export async function expandDagmcMultiblock(manifestText: string, vtmPath: string, readFile: DagmcBlockReader): Promise<DagmcBlockModel[]> {
    const refs = parseVtmManifest(manifestText);
    const models: DagmcBlockModel[] = [];
    for (const ref of refs) {
        const resolved = resolveBlockPath(vtmPath, ref.file);
        let text: string;
        try {
            text = await readFile(resolved);
        } catch (error) {
            throw new Error(
                `Cannot read DAGMC block '${ref.name}' (${resolved}): ${error instanceof Error ? error.message : String(error)}`
            );
        }
        try {
            models.push(await parseBlockDataset(ref.file, text, ref.name, ref.index));
        } catch (error) {
            throw new Error(
                `Cannot parse DAGMC block '${ref.name}' (${resolved}): ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
    return models.sort((a, b) => a.blockIndex - b.blockIndex);
}

/** Union bounding box over all block positions; undefined when empty. */
export function mergeDagmcBounds(models: readonly DagmcBlockModel[]): AxisAlignedBounds | undefined {
    let min: [number, number, number] | undefined;
    let max: [number, number, number] | undefined;
    for (const model of models) {
        const bounds = boundingBoxFromPositions(model.positions);
        if (!bounds) {
            continue;
        }
        if (!min || !max) {
            min = [bounds.min[0], bounds.min[1], bounds.min[2]];
            max = [bounds.max[0], bounds.max[1], bounds.max[2]];
            continue;
        }
        for (let i = 0; i < 3; i++) {
            if (bounds.min[i] < min[i]) {
                min[i] = bounds.min[i];
            }
            if (bounds.max[i] > max[i]) {
                max[i] = bounds.max[i];
            }
        }
    }
    return min && max ? { min, max } : undefined;
}
