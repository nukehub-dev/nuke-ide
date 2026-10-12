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
 * Tests for the native VTK viewer pure helpers (no DI/DOM): color-by
 * parsing, array classification for the four P1 dataset kinds, colormap
 * sampling, point-budget stride, base64, and the VTK XML reader.
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import { COLORMAP_NAMES } from '../../../../viewer-core/colormaps';
import {
    charOffsetToByteOffset,
    classifyNativeVtkArrays,
    colorByValue,
    decodeAppendedBlock,
    decodeBase64,
    DEFAULT_COLORMAP,
    defaultNativeColorBy,
    detectNativeVtkFamily,
    fluxGroupIndex,
    formatColorBy,
    isValidAppendedOffset,
    NATIVE_PROBE_EXTENSIONS,
    NATIVE_VTK_COLORMAPS,
    parseColorBy,
    parseLegacyVtkAscii,
    parseNativeVtk,
    parseNativeVtkXml,
    parseStructuredGridXml,
    parseUnstructuredGridXml,
    selectSourceColorArray,
    sniffVtkDatasetType,
    SOLID_COLOR,
    strideForBudget,
    voxelInstanceLayout
} from './native-vtk-data';

function array(name: string, association: 'point' | 'cell' = 'point'): OpenMCVtkArrayInfo {
    return { name, association, components: 1, range: [0, 1] };
}

describe('detectNativeVtkFamily', () => {
    it('maps vtk-info types and extensions to families', () => {
        expect(detectNativeVtkFamily('vtkPolyData', '.vtp')).toBe('polydata');
        expect(detectNativeVtkFamily('vtkRectilinearGrid', '.vtr')).toBe('rectilinear');
        expect(detectNativeVtkFamily('vtkImageData', '.vti')).toBe('image');
        expect(detectNativeVtkFamily('', '.vtr')).toBe('rectilinear');
    });

    it('maps the P6 gap kinds onto the existing viewer families', () => {
        // Unstructured grids render through the polydata path (triangle edges/mesh).
        expect(detectNativeVtkFamily('vtkUnstructuredGrid', '.vtu')).toBe('polydata');
        expect(detectNativeVtkFamily('', '.vtu')).toBe('polydata');
        // Structured grids render through the rectilinear path (cell centers + dims).
        expect(detectNativeVtkFamily('vtkStructuredGrid', '.vts')).toBe('rectilinear');
        expect(detectNativeVtkFamily('', '.vts')).toBe('rectilinear');
        // Legacy converter outputs are polydata-shaped pending parse.
        expect(detectNativeVtkFamily('', '.vtk')).toBe('polydata');
        expect([...NATIVE_PROBE_EXTENSIONS]).toEqual(['.vtp', '.vtr', '.vti', '.vtu', '.vts', '.vtk']);
    });

    it('returns undefined for unknown types', () => {
        expect(detectNativeVtkFamily('vtkHyperTreeGrid', '.htg')).toBeUndefined();
        expect(detectNativeVtkFamily('', '.h5')).toBeUndefined();
    });
});

describe('parseColorBy / formatColorBy / colorByValue', () => {
    it('parses the base.serve color-by format', () => {
        expect(parseColorBy('Solid Color')).toEqual({ kind: 'solid' });
        expect(parseColorBy('Point: energy')).toEqual({ kind: 'point', name: 'energy' });
        expect(parseColorBy('Cell: lower_g0')).toEqual({ kind: 'cell', name: 'lower_g0' });
        expect(parseColorBy('  Point:   energy  ')).toEqual({ kind: 'point', name: 'energy' });
    });

    it('rejects empty and unknown values', () => {
        expect(parseColorBy(undefined)).toBeUndefined();
        expect(parseColorBy('')).toBeUndefined();
        expect(parseColorBy('energy')).toBeUndefined();
        expect(parseColorBy('Vertex: energy')).toBeUndefined();
    });

    it('round-trips through formatColorBy', () => {
        expect(formatColorBy('point', 'energy')).toBe('Point: energy');
        expect(formatColorBy('cell', 'id')).toBe('Cell: id');
        expect(parseColorBy(formatColorBy('cell', 'id'))).toEqual({ kind: 'cell', name: 'id' });
        expect(colorByValue(array('energy'))).toBe('Point: energy');
        expect(colorByValue(array('id', 'cell'))).toBe('Cell: id');
        expect(SOLID_COLOR).toBe('Solid Color');
    });

    it('prefers energy, falls back to weight, else solid', () => {
        expect(selectSourceColorArray(['weight', 'energy'])).toBe('energy');
        expect(selectSourceColorArray(['Weight'])).toBe('Weight');
        expect(selectSourceColorArray(['id', 'batch'])).toBeUndefined();
        expect(selectSourceColorArray([])).toBeUndefined();
    });
});

describe('fluxGroupIndex', () => {
    it('parses flux group names shared with the random-ray viewer', () => {
        expect(fluxGroupIndex('flux_group_0')).toBe(0);
        expect(fluxGroupIndex('flux_g3')).toBe(3);
        expect(fluxGroupIndex('flux')).toBe(-1);
        expect(fluxGroupIndex('lower_g0')).toBe(-1);
    });
});

describe('classifyNativeVtkArrays', () => {
    it('classifies a tracks .vtp polyline file', () => {
        const result = classifyNativeVtkArrays([
            array('energy'),
            array('time'),
            array('weight'),
            array('cell_id'),
            array('pdg', 'cell'),
            array('batch', 'cell'),
            array('generation', 'cell'),
            array('particle_id', 'cell'),
            array('track_index', 'cell')
        ]);
        expect(result.energies.map((a) => a.name)).toEqual(['energy']);
        expect(result.scalars.map((a) => a.name)).toEqual(['time', 'weight']);
        expect(result.ids.map((a) => a.name)).toEqual(['cell_id', 'pdg', 'batch', 'generation', 'particle_id', 'track_index']);
        expect(result.other).toEqual([]);
    });

    it('classifies a collision-track .vtp point cloud', () => {
        const result = classifyNativeVtkArrays([
            array('energies'),
            array('energyLosses'),
            array('times'),
            array('weights'),
            array('eventMt'),
            array('cellIds'),
            array('nuclideIds'),
            array('materialIds'),
            array('particles')
        ]);
        expect(result.energies.map((a) => a.name)).toEqual(['energies', 'energyLosses']);
        expect(result.scalars.map((a) => a.name)).toEqual(['times', 'weights']);
        expect(result.ids.map((a) => a.name)).toEqual(['eventMt', 'cellIds', 'nuclideIds', 'materialIds', 'particles']);
    });

    it('groups weight-window lower/upper cell arrays by energy group', () => {
        const result = classifyNativeVtkArrays([
            array('lower_g1', 'cell'),
            array('upper_g1', 'cell'),
            array('lower_g0', 'cell'),
            array('upper_g0', 'cell'),
            array('ww3_lower_g0', 'cell'),
            array('ww3_upper_g0', 'cell')
        ]);
        expect(result.windowGroups.length).toBe(3);
        expect(result.windowGroups[0]).toMatchObject({ group: 0, prefix: '' });
        expect(result.windowGroups[0].lower?.name).toBe('lower_g0');
        expect(result.windowGroups[0].upper?.name).toBe('upper_g0');
        expect(result.windowGroups[1]).toMatchObject({ group: 0, prefix: 'ww3' });
        expect(result.windowGroups[2]).toMatchObject({ group: 1, prefix: '' });
    });

    it('classifies voxel and random-ray legacy arrays', () => {
        const result = classifyNativeVtkArrays([
            array('id', 'cell'),
            array('flux_group_1'),
            array('flux_group_0'),
            array('FSRs'),
            array('total_fission_source')
        ]);
        expect(result.ids.map((a) => a.name)).toEqual(['id', 'FSRs']);
        expect(result.fluxGroups.map((a) => a.name)).toEqual(['flux_group_0', 'flux_group_1']);
        expect(result.sources.map((a) => a.name)).toEqual(['total_fission_source']);
    });
});

describe('defaultNativeColorBy', () => {
    it('prefers energy for polydata', () => {
        const classified = classifyNativeVtkArrays([array('cell_id'), array('energy'), array('time')]);
        expect(defaultNativeColorBy(classified, 'polydata')).toBe('Point: energy');
    });

    it('prefers the first window lower bound for rectilinear grids', () => {
        const classified = classifyNativeVtkArrays([array('upper_g0', 'cell'), array('lower_g1', 'cell'), array('lower_g0', 'cell')]);
        expect(defaultNativeColorBy(classified, 'rectilinear')).toBe('Cell: lower_g0');
    });

    it('falls back through flux, scalars, sources, ids, other', () => {
        expect(defaultNativeColorBy(classifyNativeVtkArrays([array('FSRs'), array('flux_group_1')]), 'image')).toBe('Point: flux_group_1');
        expect(defaultNativeColorBy(classifyNativeVtkArrays([array('id', 'cell')]), 'image')).toBe('Cell: id');
        expect(defaultNativeColorBy(classifyNativeVtkArrays([array('phi')]), 'image')).toBe('Point: phi');
        expect(defaultNativeColorBy(classifyNativeVtkArrays([]), 'polydata')).toBeUndefined();
    });
});

describe('colormaps', () => {
    it('re-exports the full LUT pack with the trame-era default', () => {
        expect([...NATIVE_VTK_COLORMAPS]).toEqual([...COLORMAP_NAMES]);
        expect(NATIVE_VTK_COLORMAPS).toHaveLength(34);
        expect(NATIVE_VTK_COLORMAPS).toContain('Cool to Warm');
        expect(NATIVE_VTK_COLORMAPS).toContain('Viridis');
        expect(DEFAULT_COLORMAP).toBe('Cool to Warm');
    });
});

describe('strideForBudget', () => {
    it('keeps small datasets whole and decimates large ones evenly', () => {
        expect(strideForBudget(100)).toBe(1);
        expect(strideForBudget(200000)).toBe(1);
        expect(strideForBudget(200001)).toBe(2);
        expect(strideForBudget(1000000)).toBe(5);
        expect(strideForBudget(0)).toBe(1);
    });
});

describe('decodeBase64', () => {
    it('round-trips binary payloads', () => {
        const expected = new Uint8Array([0, 1, 2, 250, 255, 16, 32, 64, 128]);
        const encoded = Buffer.from(expected).toString('base64');
        expect(decodeBase64(encoded)).toEqual(expected);
    });
});

const VTP_ASCII = `<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">
<PolyData>
<Piece NumberOfPoints="3" NumberOfVerts="0" NumberOfLines="1" NumberOfStrips="0" NumberOfPolys="0">
<PointData>
<DataArray type="Float64" Name="energy" NumberOfComponents="1" format="ascii">
1.0 2.0 4.0
</DataArray>
<DataArray type="Float64" Name="mom" NumberOfComponents="2" format="ascii">
3 4 0 0 1 1
</DataArray>
</PointData>
<CellData>
<DataArray type="Int32" Name="pdg" NumberOfComponents="1" format="ascii">
11
</DataArray>
</CellData>
<Points>
<DataArray type="Float64" NumberOfComponents="3" format="ascii">
0 0 0 1 0 0 1 1 0
</DataArray>
</Points>
<Lines>
<DataArray type="Int64" format="ascii">
3 0 1 2
</DataArray>
</Lines>
</Piece>
</PolyData>
</VTKFile>`;

const VTR_ASCII = `<VTKFile type="RectilinearGrid" version="0.1" byte_order="LittleEndian">
<RectilinearGrid WholeExtent="0 2 0 1 0 1">
<Piece Extent="0 2 0 1 0 1">
<Coordinates>
<DataArray type="Float64" Name="XCoordinates" NumberOfComponents="1" format="ascii">
0 1 2
</DataArray>
<DataArray type="Float64" Name="YCoordinates" NumberOfComponents="1" format="ascii">
0 5
</DataArray>
<DataArray type="Float64" Name="ZCoordinates" NumberOfComponents="1" format="ascii">
0 10
</DataArray>
</Coordinates>
<CellData>
<DataArray type="Float64" Name="lower_g0" NumberOfComponents="1" format="ascii">
1.0 2.0
</DataArray>
<DataArray type="Float64" Name="upper_g0" NumberOfComponents="1" format="ascii">
3.0 4.0
</DataArray>
</CellData>
</Piece>
</RectilinearGrid>
</VTKFile>`;

const VTI_ASCII = `<VTKFile type="ImageData" version="0.1" byte_order="LittleEndian">
<ImageData WholeExtent="0 2 0 1 0 1" Origin="0 0 0" Spacing="1 2 4">
<Piece Extent="0 2 0 1 0 1">
<CellData>
<DataArray type="Int32" Name="id" NumberOfComponents="1" format="ascii">
7 8
</DataArray>
</CellData>
</Piece>
</ImageData>
</VTKFile>`;

describe('parseNativeVtkXml ascii', () => {
    it('parses a tracks-style .vtp polyline file', async () => {
        const model = await parseNativeVtkXml(VTP_ASCII);
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(3);
        expect([...model.positions]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
        expect(model.segments ? [...model.segments] : []).toEqual([0, 1, 1, 2]);
        expect(model.segmentCells ? [...model.segmentCells] : []).toEqual([0, 0]);
        const energy = model.pointArrays.find((a) => a.name === 'energy');
        expect(energy?.range).toEqual([1, 4]);
        // Multi-component ranges cover magnitudes: |(3,4)|=5, |(0,0)|=0, |(1,1)|=sqrt(2)
        const mom = model.pointArrays.find((a) => a.name === 'mom');
        expect(mom?.components).toBe(2);
        expect(mom?.range[0]).toBe(0);
        expect(mom?.range[1]).toBe(5);
        expect(model.cellArrays.find((a) => a.name === 'pdg')?.values[0]).toBe(11);
    });

    it('parses a weight-windows-style .vtr rectilinear grid', async () => {
        const model = await parseNativeVtkXml(VTR_ASCII);
        expect(model.family).toBe('rectilinear');
        expect(model.gridDimensions).toEqual([2, 1, 1]);
        expect([...model.positions]).toEqual([0.5, 2.5, 5, 1.5, 2.5, 5]);
        expect(model.cellArrays.map((a) => a.name)).toEqual(['lower_g0', 'upper_g0']);
        expect(model.cellArrays[0].range).toEqual([1, 2]);
        expect(model.gridAxes?.map((axis) => [...axis])).toEqual([
            [0, 1, 2],
            [0, 5],
            [0, 10]
        ]);
    });

    it('parses a voxel-style .vti image grid', async () => {
        const model = await parseNativeVtkXml(VTI_ASCII);
        expect(model.family).toBe('image');
        expect(model.gridDimensions).toEqual([2, 1, 1]);
        expect([...model.positions]).toEqual([0.5, 1, 2, 1.5, 1, 2]);
        expect(model.cellArrays[0].name).toBe('id');
        expect([...model.cellArrays[0].values]).toEqual([7, 8]);
    });

    it('maps segments to global cell indices across verts and lines', async () => {
        const xml = `<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">
<PolyData>
<Piece NumberOfPoints="6" NumberOfVerts="2" NumberOfLines="2" NumberOfStrips="0" NumberOfPolys="0">
<CellData>
<DataArray type="Int32" Name="pdg" NumberOfComponents="1" format="ascii">
10 20 30 40
</DataArray>
</CellData>
<Points>
<DataArray type="Float64" NumberOfComponents="3" format="ascii">
0 0 0 1 0 0 2 0 0 3 0 0 4 0 0 5 0 0
</DataArray>
</Points>
<Verts>
<DataArray type="Int64" format="ascii">
1 0 1 1
</DataArray>
</Verts>
<Lines>
<DataArray type="Int64" format="ascii">
2 2 3 2 4 5
</DataArray>
</Lines>
</Piece>
</PolyData>
</VTKFile>`;
        const model = await parseNativeVtkXml(xml);
        expect(model.vertices ? [...model.vertices] : []).toEqual([0, 1]);
        expect(model.segments ? [...model.segments] : []).toEqual([2, 3, 4, 5]);
        // Vert cells are 0-1, line cells are 2-3 (VTK verts-first order)
        expect(model.segmentCells ? [...model.segmentCells] : []).toEqual([2, 3]);
        expect(model.cellArrays[0].values.length).toBe(4);
    });

    it('rejects non-VTK, unsupported types, and bad extents', async () => {
        await expect(parseNativeVtkXml('<html></html>')).rejects.toThrow(/Not a VTK XML/);
        await expect(parseNativeVtkXml('<VTKFile type="vtkMultiBlockDataSet" byte_order="LittleEndian"></VTKFile>')).rejects.toThrow(
            /Unsupported VTK dataset type/
        );
        await expect(parseNativeVtkXml('<VTKFile type="PolyData" byte_order="BigEndian"></VTKFile>')).rejects.toThrow(/byte order/);
        await expect(parseNativeVtkXml(VTR_ASCII.replace('<Piece Extent="0 2 0 1 0 1">', '<Piece Extent="0 0 0 1 0 1">'))).rejects.toThrow(
            /empty grid/
        );
    });
});

function appendedVtp(payload: Uint8Array, headerBytes: number, compressor: boolean): string {
    const encoded = Buffer.from(payload).toString('base64');
    return `<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian"${compressor ? ' compressor="vtkZLibDataCompressor"' : ''}>
<PolyData>
<Piece NumberOfPoints="2" NumberOfVerts="2" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="0">
<Points>
<DataArray type="Float32" NumberOfComponents="3" format="appended" offset="0" />
</Points>
<Verts>
<DataArray type="Int32" Name="nv" NumberOfComponents="1" format="ascii">
1 0 1 1
</DataArray>
</Verts>
</Piece>
</PolyData>
<AppendedData encoding="base64">
_${encoded}
</AppendedData>
</VTKFile>`;
}

function rawBlock(values: Float32Array): Uint8Array {
    const out = new Uint8Array(4 + values.byteLength);
    new DataView(out.buffer).setUint32(0, values.byteLength, true);
    out.set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength), 4);
    return out;
}

describe('parseNativeVtkXml appended', () => {
    it('parses uncompressed appended points with verts', async () => {
        const model = await parseNativeVtkXml(appendedVtp(rawBlock(new Float32Array([0, 0, 0, 3, 0, 4])), 4, false));
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(2);
        expect([...model.positions]).toEqual([0, 0, 0, 3, 0, 4]);
        expect(model.vertices ? [...model.vertices] : []).toEqual([0, 1]);
        expect(model.segments).toBeUndefined();
    });

    it('parses zlib-compressed appended points', async () => {
        const raw = new Uint8Array(new Float32Array([0, 0, 0, 3, 0, 4]).buffer);
        const compressed = deflateSync(raw);
        const block = new Uint8Array(4 * 4 + compressed.length);
        const view = new DataView(block.buffer);
        view.setUint32(0, 1, true);
        view.setUint32(4, raw.length, true);
        view.setUint32(8, 0, true);
        view.setUint32(12, compressed.length, true);
        block.set(compressed, 16);
        const model = await parseNativeVtkXml(appendedVtp(block, 4, true));
        expect([...model.positions]).toEqual([0, 0, 0, 3, 0, 4]);
    });
});

describe('parseNativeVtkXml appended', () => {
    it('parses uncompressed appended points with verts', async () => {
        const model = await parseNativeVtkXml(appendedVtp(rawBlock(new Float32Array([0, 0, 0, 3, 0, 4])), 4, false));
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(2);
        expect([...model.positions]).toEqual([0, 0, 0, 3, 0, 4]);
        expect(model.vertices ? [...model.vertices] : []).toEqual([0, 1]);
        expect(model.segments).toBeUndefined();
    });

    it('parses zlib-compressed appended points', async () => {
        const raw = new Uint8Array(new Float32Array([0, 0, 0, 3, 0, 4]).buffer);
        const compressed = deflateSync(raw);
        const block = new Uint8Array(4 * 4 + compressed.length);
        const view = new DataView(block.buffer);
        view.setUint32(0, 1, true);
        view.setUint32(4, raw.length, true);
        view.setUint32(8, 0, true);
        view.setUint32(12, compressed.length, true);
        block.set(compressed, 16);
        const model = await parseNativeVtkXml(appendedVtp(block, 4, true));
        expect([...model.positions]).toEqual([0, 0, 0, 3, 0, 4]);
    });
});

const VTU_SHARED_FIXTURE = `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian" header_type="UInt32">
<UnstructuredGrid>
<Piece NumberOfPoints="4" NumberOfCells="2">
<PointData>
<DataArray type="Float64" Name="temperature" format="ascii">
300 310 320 330
</DataArray>
</PointData>
<CellData>
<DataArray type="Int32" Name="volume_id" format="ascii">
1 2
</DataArray>
<DataArray type="String" Name="material" format="ascii">
fuel clad
</DataArray>
</CellData>
<Points>
<DataArray type="Float32" NumberOfComponents="3" format="ascii">
0 0 0  1 0 0  1 1 0  0 1 0
</DataArray>
</Points>
<Cells>
<DataArray type="Int32" Name="connectivity" format="ascii">
0 1 2  0 2 3
</DataArray>
<DataArray type="Int32" Name="offsets" format="ascii">
3 6
</DataArray>
<DataArray type="UInt8" Name="types" format="ascii">
5 5
</DataArray>
</Cells>
</Piece>
</UnstructuredGrid>
</VTKFile>
`;

const VTS_SHARED_FIXTURE = `<VTKFile type="StructuredGrid" version="0.1" byte_order="LittleEndian">
<StructuredGrid WholeExtent="0 1 0 1 0 1">
<Piece Extent="0 1 0 1 0 1" Dimensions="2 2 2">
<PointData>
<DataArray type="Float64" Name="node_temp" format="ascii">
10 20 30 40 50 60 70 80
</DataArray>
</PointData>
<CellData>
<DataArray type="Float64" Name="flux_group_0" format="ascii">
1.5
</DataArray>
</CellData>
<Points>
<DataArray type="Float64" NumberOfComponents="3" format="ascii">
0 0 0  2 0 0  0 4 0  2 4 0  0 0 6  2 0 6  0 4 6  2 4 6
</DataArray>
</Points>
</Piece>
</StructuredGrid>
</VTKFile>`;

describe('parseNativeVtkXml appended vtk writer quirks', () => {
    /**
     * vtk 9 writers (observed 9.3 multiblock, 9.6 overlay) emit base64
     * CHARACTER offsets into the appended payload instead of decoded-byte
     * offsets, flush each block as an independently padded chunk, and still
     * write (empty) blocks for zero-cell sections. Build such a payload the
     * way the writer does and expect the vertex cloud plus its point array.
     */
    const compressedBlock = (raw: Uint8Array): Uint8Array => {
        const compressed = deflateSync(raw);
        const block = new Uint8Array(4 * 4 + compressed.length);
        const view = new DataView(block.buffer);
        view.setUint32(0, 1, true);
        view.setUint32(4, raw.length, true);
        view.setUint32(8, 0, true);
        view.setUint32(12, compressed.length, true);
        block.set(compressed, 16);
        return block;
    };
    const emptyCompressedBlock = (): Uint8Array => {
        const block = new Uint8Array(3 * 4);
        new DataView(block.buffer).setUint32(0, 0, true);
        return block;
    };
    const int32Bytes = (values: number[]): Uint8Array => {
        const out = new Uint8Array(values.length * 4);
        const view = new DataView(out.buffer);
        values.forEach((v, i) => view.setInt32(i * 4, v, true));
        return out;
    };

    it('parses char offsets with an empty Lines section', async () => {
        const blocks = [
            compressedBlock(new Uint8Array(new Float32Array([0, 0, 0, 3, 0, 4]).buffer)),
            compressedBlock(new Uint8Array(new Float64Array([10, 20]).buffer)),
            compressedBlock(int32Bytes([0, 1])),
            compressedBlock(int32Bytes([1, 2])),
            emptyCompressedBlock(),
            emptyCompressedBlock()
        ];
        const chunks = blocks.map((block) => Buffer.from(block).toString('base64'));
        const charOffsets: number[] = [];
        let cursor = 0;
        for (const chunk of chunks) {
            charOffsets.push(cursor);
            cursor += chunk.length;
        }
        const sections = [
            `<PointData>\n<DataArray type="Float64" Name="flux" format="appended" offset="${charOffsets[1]}" />\n</PointData>`,
            `<Points>\n<DataArray type="Float32" NumberOfComponents="3" format="appended" offset="${charOffsets[0]}" />\n</Points>`,
            `<Verts>\n<DataArray type="Int32" Name="connectivity" format="appended" offset="${charOffsets[2]}" />\n<DataArray type="Int32" Name="offsets" format="appended" offset="${charOffsets[3]}" />\n</Verts>`,
            `<Lines>\n<DataArray type="Int32" Name="connectivity" format="appended" offset="${charOffsets[4]}" />\n<DataArray type="Int32" Name="offsets" format="appended" offset="${charOffsets[5]}" />\n</Lines>`
        ];
        const text =
            `<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian" header_type="UInt32" compressor="vtkZLibDataCompressor">\n` +
            `<PolyData>\n<Piece NumberOfPoints="2" NumberOfVerts="2" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="0">\n` +
            `${sections.join('\n')}\n</Piece>\n</PolyData>\n<AppendedData encoding="base64">\n_${chunks.join('')}\n</AppendedData>\n</VTKFile>`;
        const model = await parseNativeVtkXml(text);
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(2);
        expect([...model.positions]).toEqual([0, 0, 0, 3, 0, 4]);
        expect(model.vertices ? [...model.vertices] : []).toEqual([0, 1]);
        expect(model.segments).toBeUndefined();
        expect(model.pointArrays.map((array) => array.name)).toEqual(['flux']);
        expect([...model.pointArrays[0].values]).toEqual([10, 20]);
    });

    it('fan-triangulates polys into surfaces with outline edges', async () => {
        const square = new Float32Array([0, 0, 0, 3, 0, 0, 3, 3, 0, 0, 3, 0]);
        const blocks = [
            compressedBlock(new Uint8Array(square.buffer)),
            compressedBlock(new Uint8Array(new Float64Array([1, 2, 3, 4]).buffer)),
            compressedBlock(int32Bytes([0, 1, 2, 3])),
            compressedBlock(int32Bytes([4]))
        ];
        const chunks = blocks.map((block) => Buffer.from(block).toString('base64'));
        const charOffsets: number[] = [];
        let cursor = 0;
        for (const chunk of chunks) {
            charOffsets.push(cursor);
            cursor += chunk.length;
        }
        const text =
            `<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian" header_type="UInt32" compressor="vtkZLibDataCompressor">\n` +
            `<PolyData>\n<Piece NumberOfPoints="4" NumberOfVerts="0" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="1">\n` +
            `<PointData>\n<DataArray type="Float64" Name="flux" format="appended" offset="${charOffsets[1]}" />\n</PointData>\n` +
            `<Points>\n<DataArray type="Float32" NumberOfComponents="3" format="appended" offset="${charOffsets[0]}" />\n</Points>\n` +
            `<Polys>\n<DataArray type="Int32" Name="connectivity" format="appended" offset="${charOffsets[2]}" />\n` +
            `<DataArray type="Int32" Name="offsets" format="appended" offset="${charOffsets[3]}" />\n</Polys>\n` +
            `</Piece>\n</PolyData>\n<AppendedData encoding="base64">\n_${chunks.join('')}\n</AppendedData>\n</VTKFile>`;
        const model = await parseNativeVtkXml(text);
        expect(model.family).toBe('polydata');
        expect(model.triangles ? [...model.triangles] : []).toEqual([0, 1, 2, 0, 2, 3]);
        expect(model.triangleCells ? [...model.triangleCells] : []).toEqual([0, 0]);
        expect(model.segments ? [...model.segments] : []).toEqual([0, 1, 1, 2, 2, 0, 0, 2, 2, 3, 3, 0]);
        expect([...model.pointArrays[0].values]).toEqual([1, 2, 3, 4]);
    });
});

describe('voxelInstanceLayout', () => {
    const axes = (nx: number, ny: number, nz: number): [Float64Array, Float64Array, Float64Array] => [
        Float64Array.from({ length: nx + 1 }, (_, i) => i * 2),
        Float64Array.from({ length: ny + 1 }, (_, i) => i * 3),
        Float64Array.from({ length: nz + 1 }, (_, i) => i * 5)
    ];

    it('lays out full boxes over a small grid', () => {
        const layout = voxelInstanceLayout([2, 1, 1], axes(2, 1, 1));
        expect([...layout.cells]).toEqual([0, 1]);
        expect([...layout.centers]).toEqual([1, 1.5, 2.5, 3, 1.5, 2.5]);
        expect([...layout.sizes]).toEqual([2, 3, 5, 2, 3, 5]);
    });

    it('thins uniformly past the budget with complete coverage', () => {
        const layout = voxelInstanceLayout([10, 10, 10], axes(10, 10, 10), 100);
        // cbrt(1000/100) -> step 3 -> 4^3 kept cells, all inside the grid.
        expect(layout.cells.length).toBe(64);
        expect(Math.max(...layout.cells)).toBeLessThan(1000);
        const maxCorner = Math.max(...layout.centers.map((c, i) => c + layout.sizes[i] / 2));
        expect(maxCorner).toBeLessThanOrEqual(50);
    });
});

describe('parseLegacyVtkAscii STRUCTURED_GRID', () => {
    const structuredGrid = (points: number[]): string =>
        `# vtk DataFile Version 5.1
vtk output
ASCII
DATASET STRUCTURED_GRID
DIMENSIONS 2 2 2
POINTS 8 float
${points.join(' ')}
CELL_DATA 1
SCALARS flux float
LOOKUP_TABLE default
7
`;

    it('averages corners into centers with voxel axes on aligned lattices', async () => {
        const corners: number[] = [];
        for (let k = 0; k < 2; k++) {
            for (let j = 0; j < 2; j++) {
                for (let i = 0; i < 2; i++) {
                    corners.push(i, j * 2, k * 4);
                }
            }
        }
        const model = await parseNativeVtk(structuredGrid(corners), '.vtk');
        expect(model.family).toBe('rectilinear');
        expect(model.gridDimensions).toEqual([1, 1, 1]);
        expect([...model.positions]).toEqual([0.5, 1, 2]);
        expect(model.gridAxes?.map((axis) => [...axis])).toEqual([
            [0, 1],
            [0, 2],
            [0, 4]
        ]);
        expect(model.cellArrays.map((array) => array.name)).toEqual(['flux']);
        expect([...model.cellArrays[0].values]).toEqual([7]);
    });

    it('falls back to center points on curvilinear lattices', async () => {
        const corners: number[] = [];
        for (let k = 0; k < 2; k++) {
            for (let j = 0; j < 2; j++) {
                for (let i = 0; i < 2; i++) {
                    corners.push(i + (j === 1 && k === 1 ? 0.5 : 0), j * 2, k * 4);
                }
            }
        }
        const model = await parseNativeVtk(structuredGrid(corners), '.vtk');
        expect(model.family).toBe('rectilinear');
        expect(model.gridAxes).toBeUndefined();
        expect([...model.positions]).toEqual([0.625, 1, 2]);
    });

    it('rejects grids without dimensions or cells', async () => {
        await expect(parseNativeVtk('POINTS 1 float\n0 0 0\n', '.vtk')).rejects.toThrow();
        const noDims = `# vtk DataFile Version 5.1
vtk output
ASCII
DATASET STRUCTURED_GRID
POINTS 8 float
0 0 0 1 0 0 0 1 0 1 1 0 0 0 1 1 0 1 0 1 1 1 1 1
`;
        await expect(parseNativeVtk(noDims, '.vtk')).rejects.toThrow(/DIMENSIONS/);
    });
});

describe('parseUnstructuredGridXml (shared .vtu decoder)', () => {
    it('decodes ascii triangles into a polydata model', async () => {
        const model = await parseUnstructuredGridXml(VTU_SHARED_FIXTURE);
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(4);
        expect([...(model.triangles ?? [])]).toEqual([0, 1, 2, 0, 2, 3]);
        expect([...(model.triangleCells ?? [])]).toEqual([0, 1]);
        expect(model.segments).toHaveLength(12);
        expect([...(model.segmentCells ?? [])]).toEqual([0, 0, 0, 1, 1, 1]);
        expect(model.nonTriangleCells).toBe(0);
        expect(model.skippedArrays).toEqual(['material']);
        const volumeId = model.cellArrays.find((a) => a.name === 'volume_id');
        expect(volumeId?.association).toBe('cell');
        expect([...(volumeId?.values ?? [])]).toEqual([1, 2]);
        const temperature = model.pointArrays.find((a) => a.name === 'temperature');
        expect(temperature?.range).toEqual([300, 330]);
    });

    it('is reachable through parseNativeVtkXml for direct .vtu files', async () => {
        const model = await parseNativeVtkXml(VTU_SHARED_FIXTURE);
        expect(model.family).toBe('polydata');
        expect([...(model.triangles ?? [])]).toEqual([0, 1, 2, 0, 2, 3]);
    });

    it('rejects non-unstructured input and malformed blocks', async () => {
        await expect(parseUnstructuredGridXml(VTP_ASCII)).rejects.toThrow(/expected UnstructuredGrid/);
        await expect(parseUnstructuredGridXml('nope')).rejects.toThrow(/missing <VTKFile>/);
        await expect(parseUnstructuredGridXml(VTU_SHARED_FIXTURE.replace(/<Cells>[\s\S]*<\/Cells>/, ''))).rejects.toThrow(/no <Cells>/);
    });
});

describe('parseStructuredGridXml (.vts decoder)', () => {
    it('averages grid points into cell centers with grid dimensions', async () => {
        const model = await parseStructuredGridXml(VTS_SHARED_FIXTURE);
        expect(model.family).toBe('rectilinear');
        expect(model.gridDimensions).toEqual([1, 1, 1]);
        expect(model.nPoints).toBe(1);
        expect([...model.positions]).toEqual([1, 2, 3]);
        expect(model.cellArrays.map((a) => a.name)).toEqual(['flux_group_0']);
        expect(model.pointArrays.map((a) => a.name)).toEqual(['node_temp']);
    });

    it('is reachable through parseNativeVtkXml', async () => {
        const model = await parseNativeVtkXml(VTS_SHARED_FIXTURE);
        expect(model.family).toBe('rectilinear');
        expect(model.gridDimensions).toEqual([1, 1, 1]);
    });

    it('rejects empty grids and cell-count mismatches', async () => {
        await expect(parseStructuredGridXml(VTS_SHARED_FIXTURE.replace('Dimensions="2 2 2"', 'Dimensions="1 1 1"'))).rejects.toThrow(
            /empty grid/
        );
        await expect(parseStructuredGridXml(VTS_SHARED_FIXTURE.replace('1.5', '1.5 2.5'))).rejects.toThrow(
            /has .* values for 1 grid cells/
        );
        await expect(parseStructuredGridXml(VTP_ASCII)).rejects.toThrow(/expected StructuredGrid/);
    });
});

const LEGACY_POLYDATA_FIXTURE = `# vtk DataFile Version 2.0
nuke-ide legacy polydata fixture
ASCII
DATASET POLYDATA
POINTS 4 float
0 0 0 1 0 0 1 1 0 0 1 0
VERTICES 1 2
1 0
LINES 1 3
2 1 2
POLYGONS 1 5
4 0 1 2 3
POINT_DATA 4
SCALARS energy float 1
LOOKUP_TABLE default
1.0 2.0 4.0 8.0
CELL_DATA 3
SCALARS pdg int 1
LOOKUP_TABLE default
11 12 13
`;

const LEGACY_UNSTRUCTURED_FIXTURE = `# vtk DataFile Version 2.0
nuke-cad FEM results
ASCII
DATASET UNSTRUCTURED_GRID
POINTS 5 float
0 0 0 1 0 0 1 1 0 0 1 0 0.5 0.5 1
CELLS 2 10
4 0 1 2 3
4 0 1 2 4
CELL_TYPES 2
9
10
POINT_DATA 5
VECTORS displacement float
0 0 0 0.1 0 0 0.2 0 0 0.3 0 0 0.4 0 0
SCALARS temperature float 1
LOOKUP_TABLE default
300 310 320 330 340
`;

const LEGACY_FIELD_FIXTURE = `# vtk DataFile Version 2.0
field fixture
ASCII
DATASET POLYDATA
POINTS 2 float
0 0 0 1 0 0
VERTICES 2 4
1 0 1 1
POINT_DATA 2
FIELD FieldData 2
energy 1 2 float
1.5 2.5
mom 3 2 float
0 0 1 0 1 0
`;

describe('parseLegacyVtkAscii', () => {
    it('parses a legacy POLYDATA file with scalars', () => {
        const model = parseLegacyVtkAscii(LEGACY_POLYDATA_FIXTURE);
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(4);
        expect([...model.positions]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
        expect(model.vertices ? [...model.vertices] : []).toEqual([0]);
        // Line cell 1 (verts-first order) plus two fan triangles from the quad.
        expect(model.segments ? [...model.segments] : []).toEqual([1, 2, 0, 1, 1, 2, 2, 0, 0, 2, 2, 3, 3, 0]);
        expect(model.segmentCells ? [...model.segmentCells] : []).toEqual([1, 2, 2, 2, 2, 2, 2]);
        expect([...(model.triangles ?? [])]).toEqual([0, 1, 2, 0, 2, 3]);
        const energy = model.pointArrays.find((a) => a.name === 'energy');
        expect(energy?.range).toEqual([1, 8]);
        const pdg = model.cellArrays.find((a) => a.name === 'pdg');
        expect(pdg?.association).toBe('cell');
        expect([...(pdg?.values ?? [])]).toEqual([11, 12, 13]);
    });

    it('parses a FEM-style legacy UNSTRUCTURED_GRID with vectors', () => {
        const model = parseLegacyVtkAscii(LEGACY_UNSTRUCTURED_FIXTURE);
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(5);
        // Quad surfaces triangulate; the tetra contributes its 6 wireframe edges.
        expect([...(model.triangles ?? [])]).toEqual([0, 1, 2, 0, 2, 3]);
        expect([...(model.triangleCells ?? [])]).toEqual([0, 0]);
        expect(model.segments?.length).toBe(24);
        expect(model.nonTriangleCells).toBe(0);
        const displacement = model.pointArrays.find((a) => a.name === 'displacement');
        expect(displacement?.components).toBe(3);
        expect(displacement?.range).toEqual([0, 0.4]);
        const temperature = model.pointArrays.find((a) => a.name === 'temperature');
        expect(temperature?.range).toEqual([300, 340]);
    });

    it('parses FIELD arrays with scalar and vector components', () => {
        const model = parseLegacyVtkAscii(LEGACY_FIELD_FIXTURE);
        const energy = model.pointArrays.find((a) => a.name === 'energy');
        expect(energy?.components).toBe(1);
        expect([...(energy?.values ?? [])]).toEqual([1.5, 2.5]);
        const mom = model.pointArrays.find((a) => a.name === 'mom');
        expect(mom?.components).toBe(3);
        expect(mom?.range[1]).toBe(1);
    });

    it('rejects binary, unsupported datasets, and malformed files', () => {
        expect(() => parseLegacyVtkAscii('# vtk DataFile Version 2.0\ntitle\nBINARY\nDATASET POLYDATA\n')).toThrow(/ASCII-only/);
        expect(() => parseLegacyVtkAscii('not vtk at all')).toThrow(/missing "# vtk DataFile"/);
        expect(() => parseLegacyVtkAscii('# vtk DataFile Version 2.0\nt\nASCII\nDATASET STRUCTURED_POINTS\n')).toThrow(
            /Unsupported legacy VTK dataset/
        );
        expect(() => parseLegacyVtkAscii('# vtk DataFile Version 2.0\nt\nASCII\nDATASET POLYDATA\nVERTICES 1 2\n1 0\n')).toThrow(
            /no POINTS/
        );
        expect(() =>
            parseLegacyVtkAscii(
                '# vtk DataFile Version 2.0\nmismatch\nASCII\nDATASET POLYDATA\nPOINTS 2 float\n0 0 0 1 0 0\nVERTICES 2 4\n1 0 1 1\nCELL_DATA 1\nSCALARS id int 1\nLOOKUP_TABLE default\n7\n'
            )
        ).toThrow(/does not match/);
        expect(() => parseLegacyVtkAscii(LEGACY_POLYDATA_FIXTURE.replace('POINTS 4 float', 'POINTS 40 float'))).toThrow(/truncated/);
    });
});

describe('parseNativeVtk dispatcher', () => {
    it('auto-detects XML and legacy content', async () => {
        expect((await parseNativeVtk(VTP_ASCII)).family).toBe('polydata');
        const vtu = await parseNativeVtk(VTU_SHARED_FIXTURE, '.vtu');
        expect(vtu.triangles).toBeDefined();
        const vts = await parseNativeVtk(VTS_SHARED_FIXTURE, '.vts');
        expect(vts.gridDimensions).toEqual([1, 1, 1]);
        const legacy = await parseNativeVtk(LEGACY_UNSTRUCTURED_FIXTURE, '.vtk');
        expect(legacy.family).toBe('polydata');
        expect(legacy.pointArrays.map((a) => a.name)).toEqual(['displacement', 'temperature']);
    });

    it('rejects non-VTK text', async () => {
        await expect(parseNativeVtk('<html></html>')).rejects.toThrow(/Not a VTK dataset/);
        await expect(parseNativeVtk('garbage')).rejects.toThrow(/Not a VTK dataset/);
    });
});

describe('sniffVtkDatasetType', () => {
    it('reads XML and legacy dataset types without parsing', () => {
        expect(sniffVtkDatasetType(VTP_ASCII)).toBe('PolyData');
        expect(sniffVtkDatasetType(VTU_SHARED_FIXTURE)).toBe('UnstructuredGrid');
        expect(sniffVtkDatasetType(VTS_SHARED_FIXTURE)).toBe('StructuredGrid');
        expect(sniffVtkDatasetType(LEGACY_UNSTRUCTURED_FIXTURE)).toBe('UNSTRUCTURED_GRID');
        expect(sniffVtkDatasetType('garbage')).toBeUndefined();
    });
});

describe('classifier coverage for the newly accepted kinds', () => {
    it('classifies unstructured, structured, and legacy arrays', () => {
        const result = classifyNativeVtkArrays([
            array('temperature'),
            array('volume_id', 'cell'),
            array('flux_group_0', 'cell'),
            array('energy'),
            array('pdg', 'cell'),
            array('displacement')
        ]);
        expect(result.energies.map((a) => a.name)).toEqual(['energy']);
        expect(result.fluxGroups.map((a) => a.name)).toEqual(['flux_group_0']);
        expect(result.ids.map((a) => a.name)).toEqual(['pdg']);
        expect(result.other.map((a) => a.name).sort()).toEqual(['displacement', 'temperature', 'volume_id']);
    });

    it('picks defaults for unstructured and structured models', () => {
        const unstructured = classifyNativeVtkArrays([array('volume_id', 'cell'), array('energy')]);
        expect(defaultNativeColorBy(unstructured, 'polydata')).toBe('Point: energy');
        const structured = classifyNativeVtkArrays([array('flux_group_0', 'cell')]);
        expect(defaultNativeColorBy(structured, 'rectilinear')).toBe('Cell: flux_group_0');
    });
});

describe('large-file robustness (screenshot regression)', () => {
    it('parses a 150k-cell legacy UNSTRUCTURED_GRID without stack overflow', async () => {
        // Guards the real-world failure: DAGMC outputs carry 100k+ cells and
        // spread-push (`push(...cells)`) blows the call stack on them.
        const nCells = 150000;
        const points = ['# vtk DataFile Version 3.0', 'large', 'ASCII', 'DATASET UNSTRUCTURED_GRID', `POINTS ${nCells + 1} float`];
        for (let i = 0; i <= nCells; i++) {
            points.push(`${i} 0 0`);
        }
        const cells: string[] = [`CELLS ${nCells} ${nCells * 3}`, ...Array.from({ length: nCells }, (_, i) => `2 ${i} ${i + 1}`)];
        const types: string[] = [`CELL_TYPES ${nCells}`, ...Array(nCells).fill('3')];
        const text = [...points, ...cells, ...types].join('\n');
        const model = await parseNativeVtk(text, '.vtk');
        expect(model.nPoints).toBe(nCells + 1);
        expect(model.segments?.length).toBe(nCells * 2);
    });
});

describe('standard connectivity+offsets form (Playwright regression)', () => {
    it('parses Polys connectivity+offsets exactly, with in-range indices', async () => {
        const text = await import('fs').then((fs) => fs.promises.readFile('tests/ui/fixtures/native-polydata.vtp', 'utf8'));
        const model = await parseNativeVtk(text, '.vtp');
        expect(model.nPoints).toBe(4);
        // Two triangles as closed loops: 3 segments each.
        expect(model.segments ? Array.from(model.segments) : []).toEqual([0, 1, 1, 2, 2, 0, 0, 2, 2, 3, 3, 0]);
        const maxIndex = Math.max(...(model.segments ?? []));
        expect(maxIndex).toBeLessThan(model.nPoints);
        expect(Array.from(model.positions).every((v) => Number.isFinite(v))).toBe(true);
    });
});

describe('legacy VTK9 OFFSETS+CONNECTIVITY form', () => {
    const VTK9_OFFSETS = `# vtk DataFile Version 5.1
MOAB 5.5.1
ASCII
DATASET UNSTRUCTURED_GRID
POINTS 4 float
0 0 0 1 0 0 1 1 0 0 1 0
CELLS 2 5
OFFSETS vtktypeint64
0 2 5
CONNECTIVITY vtktypeint64
0 1 2 3 0
CELL_TYPES 2
3
5
CELL_DATA 2
SCALARS volume_id int 1
LOOKUP_TABLE default
1
2
`;
    it('pairs leading-zero offsets and skips the empty head cell', async () => {
        const model = await parseNativeVtk(VTK9_OFFSETS, '.vtk');
        expect(model.nPoints).toBe(4);
        // Line (0-1) + triangle (2-3-0) as closed loop: 2 + 6 segment indices.
        expect(model.segments ? Array.from(model.segments) : []).toEqual([0, 1, 2, 3, 3, 0, 0, 2]);
        const maxIndex = Math.max(...(model.segments ?? []));
        expect(maxIndex).toBeLessThan(model.nPoints);
    });
});

describe('appended offset conventions', () => {
    it('converts base64 character offsets to byte positions', () => {
        // Two independently padded chunks: "ABC" + "DEFGH" (the vtk writer
        // flushes per array): chars "QUJD" + "==" + "REFH" + "==".
        const payload = 'QUJD==REFH==';
        expect(charOffsetToByteOffset(payload, 0)).toBe(0);
        expect(charOffsetToByteOffset(payload, 6)).toBe(3);
        expect(charOffsetToByteOffset(payload, 12)).toBe(6);
        expect(charOffsetToByteOffset(payload, -1)).toBeUndefined();
        expect(charOffsetToByteOffset(payload, 99)).toBeUndefined();
    });

    it('parses appended arrays addressed by character offsets (vtk writer quirk)', async () => {
        // Points block + energy block, each padded separately; the energy
        // offset is its base64 character position, not a byte position.
        const points = rawBlock(new Float32Array([0, 0, 0, 1, 0, 0]));
        const energy = rawBlock(new Float32Array([5, 6]));
        const enc = (b: Uint8Array): string => Buffer.from(b).toString('base64');
        const pText = enc(points);
        const eText = enc(energy);
        const xml = `<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">
<PolyData>
<Piece NumberOfPoints="2" NumberOfVerts="0" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="0">
<PointData>
<DataArray type="Float32" Name="energy" format="appended" offset="${pText.length}" />
</PointData>
<Points>
<DataArray type="Float32" NumberOfComponents="3" format="appended" offset="0" />
</Points>
</Piece>
</PolyData>
<AppendedData encoding="base64">
_${pText}${eText}
</AppendedData>
</VTKFile>`;
        const model = await parseNativeVtkXml(xml);
        expect([...model.positions]).toEqual([0, 0, 0, 1, 0, 0]);
        expect(model.pointArrays.map((a) => a.name)).toEqual(['energy']);
    });

    it('parses compressed arrays addressed by character offsets', async () => {
        // Same quirk as above but with vtk-zlib blocks (the real multiblock
        // failure): each block padded separately, second offset in chars.
        const zblock = (values: Float32Array): Uint8Array => {
            const raw = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
            const compressed = deflateSync(raw);
            const block = new Uint8Array(16 + compressed.length);
            const view = new DataView(block.buffer);
            view.setUint32(0, 1, true);
            view.setUint32(4, raw.length, true);
            view.setUint32(8, 0, true);
            view.setUint32(12, compressed.length, true);
            block.set(compressed, 16);
            return block;
        };
        const enc = (b: Uint8Array): string => Buffer.from(b).toString('base64');
        const pText = enc(zblock(new Float32Array([0, 0, 0, 1, 0, 0])));
        const eText = enc(zblock(new Float32Array([5, 6])));
        const xml = `<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian" compressor="vtkZLibDataCompressor">
<PolyData>
<Piece NumberOfPoints="2" NumberOfVerts="0" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="0">
<PointData>
<DataArray type="Float32" Name="energy" format="appended" offset="${pText.length}" />
</PointData>
<Points>
<DataArray type="Float32" NumberOfComponents="3" format="appended" offset="0" />
</Points>
</Piece>
</PolyData>
<AppendedData encoding="base64">
_${pText}${eText}
</AppendedData>
</VTKFile>`;
        const model = await parseNativeVtkXml(xml);
        expect([...model.positions]).toEqual([0, 0, 0, 1, 0, 0]);
        expect(model.pointArrays[0].values).toEqual(new Float64Array([5, 6]));
    });

    it('rejects a byte offset landing inside another block (chunk walk)', () => {
        // A bare header shape (nblocks + fit) is not enough: the chunk table
        // must walk inside the blob too. Here nblocks reads 2 with room for
        // the header, but the second chunk overruns the blob.
        const blob = new Uint8Array([2, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 4, 0, 0, 0, 90, 0, 0, 0]);
        expect(isValidAppendedOffset(blob, 0, 4, true)).toBe(false);
        expect(isValidAppendedOffset(blob, 99, 4, true)).toBe(false);
        expect(isValidAppendedOffset(blob, 0, 4, false)).toBe(true);
    });

    it('resolves an ambiguous char offset to the true block (drape regression)', async () => {
        // Minimal .vtu mirroring the failing tokamak drape blocks: one
        // triangle, CellData volume_id then flux-mean, every block padded
        // separately exactly like vtk 9.3 multiblock output, so every XML
        // offset is a base64 CHARACTER position. The flux char offset
        // happens to satisfy the loose byte-position header shape (it lands
        // on the flux header's own csize field), which used to send the
        // parser down the byte path into undecodable garbage
        // ("Cannot decompress VTK block ... invalid zlib data").
        const le32 = (v: number): Uint8Array => {
            const b = new Uint8Array(4);
            new DataView(b.buffer).setUint32(0, v, true);
            return b;
        };
        const le64 = (v: number): Uint8Array => {
            const b = new Uint8Array(8);
            new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
            return b;
        };
        const f64 = (v: number[]): Uint8Array => {
            const b = new Uint8Array(8 * v.length);
            const view = new DataView(b.buffer);
            v.forEach((x, i) => view.setFloat64(i * 8, x, true));
            return b;
        };
        const concat = (...parts: Uint8Array[]): Uint8Array => {
            const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const p of parts) {
                out.set(p, at);
                at += p.length;
            }
            return out;
        };
        const zblock = (raw: Uint8Array): Uint8Array => {
            const compressed = deflateSync(raw);
            return concat(le32(1), le32(raw.length), le32(0), le32(compressed.length), compressed);
        };
        const enc = (b: Uint8Array): string => Buffer.from(b).toString('base64');
        const volBlock = zblock(le32(11));
        const fluxBlock = zblock(f64([42.5]));
        const pointsBlock = zblock(f64([0, 0, 0, 1, 0, 0, 0, 1, 0]));
        const connBlock = zblock(concat(le64(0), le64(1), le64(2)));
        const offsBlock = zblock(le64(3));
        const typesBlock = zblock(new Uint8Array([5]));
        const blocks: Array<[string, Uint8Array]> = [
            ['volume_id', volBlock],
            ['flux-mean', fluxBlock],
            ['Points', pointsBlock],
            ['connectivity', connBlock],
            ['offsets', offsBlock],
            ['types', typesBlock]
        ];
        let payload = '';
        const charOffsets = new Map<string, number>();
        for (const [name, block] of blocks) {
            charOffsets.set(name, payload.length);
            payload += enc(block);
        }
        const blob = decodeBase64(payload);
        const fluxChar = charOffsets.get('flux-mean')!;
        const fluxByte = volBlock.length;
        // Pin the ambiguity this test guards: as raw bytes, the flux char
        // offset satisfies the loose header shape (the old validator took
        // the byte path and died in zlib), while the strengthened chunk
        // walk rejects it and the char conversion lands on the true header.
        // (If zlib ever changes its tiny-input encoding these fail loudly
        // instead of silently weakening the test.)
        expect(fluxChar + 4 <= blob.length).toBe(true);
        const loose = new DataView(blob.buffer).getUint32(fluxChar, true);
        expect(loose).toBeGreaterThanOrEqual(1);
        expect(loose).toBeLessThanOrEqual(4096);
        expect(fluxChar + (loose + 3) * 4 <= blob.length).toBe(true);
        expect(isValidAppendedOffset(blob, fluxChar, 4, true)).toBe(false);
        expect(charOffsetToByteOffset(payload, fluxChar)).toBe(fluxByte);
        const at = (name: string): number => charOffsets.get(name)!;
        const xml = `<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian" compressor="vtkZLibDataCompressor">
<UnstructuredGrid>
<Piece NumberOfPoints="3" NumberOfCells="1">
<PointData>
</PointData>
<CellData>
<DataArray type="Int32" Name="volume_id" format="appended" offset="${at('volume_id')}" />
<DataArray type="Float64" Name="flux-mean" format="appended" offset="${at('flux-mean')}" />
</CellData>
<Points>
<DataArray type="Float64" Name="Points" NumberOfComponents="3" format="appended" offset="${at('Points')}" />
</Points>
<Cells>
<DataArray type="Int64" Name="connectivity" format="appended" offset="${at('connectivity')}" />
<DataArray type="Int64" Name="offsets" format="appended" offset="${at('offsets')}" />
<DataArray type="UInt8" Name="types" format="appended" offset="${at('types')}" />
</Cells>
</Piece>
</UnstructuredGrid>
<AppendedData encoding="base64">
_${payload}
</AppendedData>
</VTKFile>`;
        const model = await parseUnstructuredGridXml(xml);
        expect([...model.positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        expect(model.triangles && [...model.triangles]).toEqual([0, 1, 2]);
        const byName = new Map(model.cellArrays.map((a) => [a.name, a]));
        expect([...byName.get('flux-mean')!.values]).toEqual([42.5]);
        expect([...byName.get('volume_id')!.values]).toEqual([11]);
    });

    it('falls back to the character offset when the byte offset fails to decode', async () => {
        // Fully hand-built blob (no writer involved): F filler bytes, then
        // the true block (zlib-compressed Float64 [7.5]), then a decoy block
        // whose header is structurally perfect (nblocks = 1, one 8-byte
        // chunk inside the blob) but whose chunk is zero bytes — invalid
        // zlib in both raw and wrapped form. The payload is cut after F
        // bytes, so XML offset 4F/3 lands exactly on the decoy while
        // converting back to the true header at F.
        const real = deflateSync(new Uint8Array(new Float64Array([7.5]).buffer));
        const fillerLen = 48 + 3 * real.length;
        const trueAt = fillerLen;
        const decoyAt = fillerLen + 16 + real.length;
        const blob = new Uint8Array(decoyAt + 24);
        const view = new DataView(blob.buffer);
        view.setUint32(trueAt, 1, true);
        view.setUint32(trueAt + 4, 8, true);
        view.setUint32(trueAt + 8, 8, true);
        view.setUint32(trueAt + 12, real.length, true);
        blob.set(real, trueAt + 16);
        view.setUint32(decoyAt, 1, true);
        view.setUint32(decoyAt + 4, 8, true);
        view.setUint32(decoyAt + 8, 8, true);
        view.setUint32(decoyAt + 12, 8, true);
        // Zero chunk stays zero (Uint8Array initializes to 0).
        const payload =
            Buffer.from(blob.subarray(0, fillerLen)).toString('base64') + Buffer.from(blob.subarray(fillerLen)).toString('base64');
        const xmlOffset = (4 * fillerLen) / 3;
        expect(charOffsetToByteOffset(payload, xmlOffset)).toBe(trueAt);
        // The decoy fully validates yet cannot decode: this is the case the
        // chunk-walk alone cannot save.
        expect(isValidAppendedOffset(blob, decoyAt, 4, true)).toBe(true);
        expect(xmlOffset).toBe(decoyAt);
        const values = await decodeAppendedBlock(blob, xmlOffset, 4, true, 'Float64', payload);
        expect([...values]).toEqual([7.5]);
        // Without the payload there is no conversion to fall back to: the
        // original decode error surfaces.
        await expect(decodeAppendedBlock(blob, xmlOffset, 4, true, 'Float64')).rejects.toThrow('Cannot decompress');
    });
});
