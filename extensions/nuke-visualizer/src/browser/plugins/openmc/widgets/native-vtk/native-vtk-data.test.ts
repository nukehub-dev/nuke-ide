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
import {
    classifyNativeVtkArrays,
    colorByValue,
    decodeBase64,
    DEFAULT_COLORMAP,
    defaultNativeColorBy,
    detectNativeVtkFamily,
    fluxGroupIndex,
    formatColorBy,
    NATIVE_VTK_COLORMAPS,
    normalizeToUnit,
    parseColorBy,
    parseNativeVtkXml,
    sampleNativeColormap,
    SOLID_COLOR,
    strideForBudget,
    tupleValue
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

    it('returns undefined for unknown types', () => {
        expect(detectNativeVtkFamily('vtkUnstructuredGrid', '.vtu')).toBeUndefined();
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
    it('ships the six short maps with Plasma as default', () => {
        expect([...NATIVE_VTK_COLORMAPS]).toEqual(['Plasma', 'Viridis', 'Inferno', 'Jet', 'Hot', 'Cool']);
        expect(DEFAULT_COLORMAP).toBe('Plasma');
    });

    it('pins the map endpoints', () => {
        expect(sampleNativeColormap('Hot', 0)).toEqual([0, 0, 0]);
        expect(sampleNativeColormap('Hot', 1)).toEqual([1, 1, 1]);
        expect(sampleNativeColormap('Cool', 0)).toEqual([0, 1, 1]);
        expect(sampleNativeColormap('Cool', 1)).toEqual([1, 0, 1]);
        expect(sampleNativeColormap('Jet', 0)).toEqual([0, 0, 0.5]);
        expect(sampleNativeColormap('Jet', 1)).toEqual([0.5, 0, 0]);
    });

    it('interpolates midpoints and clamps out-of-range t', () => {
        expect(sampleNativeColormap('Cool', 0.5)).toEqual([0.5, 0.5, 1]);
        expect(sampleNativeColormap('Hot', -1)).toEqual(sampleNativeColormap('Hot', 0));
        expect(sampleNativeColormap('Hot', 2)).toEqual(sampleNativeColormap('Hot', 1));
        const mid = sampleNativeColormap('Viridis', 0.5);
        expect(mid.every((v) => v >= 0 && v <= 1)).toBe(true);
    });

    it('normalizes scalars with a degenerate-range guard', () => {
        expect(normalizeToUnit(5, 0, 10)).toBe(0.5);
        expect(normalizeToUnit(-1, 0, 10)).toBe(0);
        expect(normalizeToUnit(11, 0, 10)).toBe(1);
        expect(normalizeToUnit(5, 5, 5)).toBe(0);
    });

    it('reads scalar tuples and vector magnitudes', () => {
        expect(tupleValue([1, 2, 3], 1, 1)).toBe(2);
        expect(tupleValue([3, 4, 0, 0], 2, 0)).toBe(5);
        expect(tupleValue([3, 4, 0, 0], 2, 1)).toBe(0);
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
        await expect(parseNativeVtkXml('<VTKFile type="UnstructuredGrid" byte_order="LittleEndian"></VTKFile>')).rejects.toThrow(
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

    it.runIf(typeof DecompressionStream !== 'undefined')('parses zlib-compressed appended points', async () => {
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
