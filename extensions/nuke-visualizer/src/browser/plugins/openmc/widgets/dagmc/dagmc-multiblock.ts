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
 * Client-side multiblock expand for DAGMC volumes.
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
 * the DAGMC volume format — decode through the shared unstructured-grid
 * parser in `native-vtk-data.ts` (imported here, so the ascii/appended
 * raw/zlib handling lives in exactly one place).
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
import type { NativeVtkModel } from '../native-vtk/native-vtk-data';
import {
    parseNativeVtkXml,
    parseUnstructuredGridXml as parseUnstructuredGridBase,
    sniffVtkDatasetType
} from '../native-vtk/native-vtk-data';

export { sniffVtkDatasetType };

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
// .vtu unstructured-grid decoder (DAGMC volume blocks, shared implementation)
// ---------------------------------------------------------------------------

/**
 * Parse a `.vtu` unstructured-grid block (the DAGMC volume format) into a
 * `polydata`-family model: triangle edges become `segments` (with per-edge
 * cell ids in `segmentCells` for cell color-by) and the triangle index
 * triples are kept in `triangles` for mesh rendering. Geometry decoding is
 * shared with the direct `.vtu` probe path (`parseUnstructuredGridBase` in
 * `native-vtk-data.ts`); this wrapper only attaches the manifest identity.
 */
export async function parseUnstructuredGridXml(text: string, blockName = '', blockIndex = 0, sourceFile = ''): Promise<DagmcBlockModel> {
    const model = await parseUnstructuredGridBase(text);
    return {
        ...model,
        blockName,
        blockIndex,
        sourceFile,
        triangles: model.triangles,
        triangleCells: model.triangleCells,
        nonTriangleCells: model.nonTriangleCells ?? 0,
        skippedArrays: model.skippedArrays ?? []
    };
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
