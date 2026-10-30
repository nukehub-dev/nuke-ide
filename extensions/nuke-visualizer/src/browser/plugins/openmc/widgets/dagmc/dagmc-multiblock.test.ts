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
 * Tests for the DAGMC multiblock expand: `.vtm` manifest parsing, block
 * path resolution, ascii/appended `.vtu` decoding, dispatch onto the
 * native-vtk parse path, and the async expand helper.
 */

import { describe, expect, it } from 'vitest';
import {
    expandDagmcMultiblock,
    mergeDagmcBounds,
    parseBlockDataset,
    parseUnstructuredGridXml,
    parseVtmManifest,
    resolveBlockPath,
    sniffVtkDatasetType
} from './dagmc-multiblock';

const VTM_FIXTURE = `<?xml version="1.0"?>
<VTKFile type="vtkMultiBlockDataSet" version="1.0" byte_order="LittleEndian" header_type="UInt32">
<vtkMultiBlockDataSet>
<DataSet index="1" name="Volume_2" file="tokamak_volumes_1.vtu"/>
<DataSet index="0" name="Volume_1" file="tokamak_volumes_0.vtu"/>
</vtkMultiBlockDataSet>
</VTKFile>
`;

const VTU_ASCII_FIXTURE = `<?xml version="1.0"?>
<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian" header_type="UInt32">
<UnstructuredGrid>
<Piece NumberOfPoints="4" NumberOfCells="2">
<PointData>
</PointData>
<CellData>
<DataArray type="Int32" Name="volume_id" format="ascii">
1 1
</DataArray>
<DataArray type="String" Name="material" format="ascii">
fuel
fuel
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

const VTP_FIXTURE = `<?xml version="1.0"?>
<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">
<PolyData>
<Piece NumberOfPoints="2" NumberOfVerts="0" NumberOfLines="1" NumberOfStrips="0" NumberOfPolys="0">
<PointData>
</PointData>
<CellData>
</CellData>
<Points>
<DataArray type="Float32" NumberOfComponents="3" format="ascii">
0 0 0  1 0 0
</DataArray>
</Points>
<Verts>
</Verts>
<Lines>
<DataArray type="Int32" Name="connectivity" format="ascii">
2 0 1
</DataArray>
</Lines>
<Polys>
</Polys>
</Piece>
</PolyData>
</VTKFile>
`;

/** Wrap raw little-endian bytes as one appended `[length][payload]` block. */
function appendedBlock(payload: Buffer): { base64: string; size: number } {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    return { base64: Buffer.concat([header, payload]).toString('base64'), size: 4 + payload.length };
}

function float32Block(values: number[]): { base64: string; size: number } {
    const payload = Buffer.alloc(4 * values.length);
    values.forEach((value, i) => payload.writeFloatLE(value, i * 4));
    return appendedBlock(payload);
}

describe('parseVtmManifest', () => {
    it('parses block references sorted by index', () => {
        expect(parseVtmManifest(VTM_FIXTURE)).toEqual([
            { index: 0, name: 'Volume_1', file: 'tokamak_volumes_0.vtu' },
            { index: 1, name: 'Volume_2', file: 'tokamak_volumes_1.vtu' }
        ]);
    });

    it('rejects non-manifest input', () => {
        expect(() => parseVtmManifest('not xml')).toThrow(/missing <VTKFile>/);
        expect(() => parseVtmManifest(VTU_ASCII_FIXTURE)).toThrow(/Not a multiblock manifest/);
        expect(() => parseVtmManifest(VTM_FIXTURE.replace('file="tokamak_volumes_0.vtu"', ''))).toThrow(/without a file attribute/);
    });
});

describe('resolveBlockPath', () => {
    it('joins manifest-relative files', () => {
        expect(resolveBlockPath('/tmp/nuke/dagmc/tokamak_volumes.vtm', 'tokamak_volumes_0.vtu')).toBe(
            '/tmp/nuke/dagmc/tokamak_volumes_0.vtu'
        );
        expect(resolveBlockPath('/tmp/nuke/dagmc/tokamak_volumes.vtm', 'sub/block.vtu')).toBe('/tmp/nuke/dagmc/sub/block.vtu');
        expect(resolveBlockPath('/tmp/nuke/dagmc/tokamak_volumes.vtm', '/abs/block.vtu')).toBe('/abs/block.vtu');
        expect(resolveBlockPath('tokamak_volumes.vtm', 'tokamak_volumes_0.vtu')).toBe('tokamak_volumes_0.vtu');
    });
});

describe('parseUnstructuredGridXml', () => {
    it('decodes ascii triangles into mesh + edge models', async () => {
        const model = await parseUnstructuredGridXml(VTU_ASCII_FIXTURE, 'Volume_1', 0, 'tokamak_volumes_0.vtu');
        expect(model.family).toBe('polydata');
        expect(model.nPoints).toBe(4);
        expect(model.blockName).toBe('Volume_1');
        expect(model.sourceFile).toBe('tokamak_volumes_0.vtu');
        expect([...(model.triangles ?? [])]).toEqual([0, 1, 2, 0, 2, 3]);
        expect(model.segments).toHaveLength(12);
        expect([...(model.segmentCells ?? [])]).toEqual([0, 0, 0, 1, 1, 1]);
        expect(model.positions.slice(0, 3)).toEqual(new Float32Array([0, 0, 0]));
        expect([...(model.triangleCells ?? [])]).toEqual([0, 1]);
        const volumeId = model.cellArrays.find((array) => array.name === 'volume_id');
        expect(volumeId?.values).toEqual(new Float64Array([1, 1]));
        expect(volumeId?.range).toEqual([1, 1]);
        expect(model.skippedArrays).toEqual(['material']);
        expect(model.nonTriangleCells).toBe(0);
    });

    it('decodes appended points alongside ascii cells', async () => {
        const points = float32Block([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
        const text = VTU_ASCII_FIXTURE.replace(
            '<DataArray type="Float32" NumberOfComponents="3" format="ascii">',
            '<DataArray type="Float32" NumberOfComponents="3" format="appended" offset="0">'
        )
            .replace('0 0 0  1 0 0  1 1 0  0 1 0', '')
            .replace('</Piece>', `<AppendedData encoding="base64">_${points.base64}</AppendedData></Piece>`);
        const model = await parseUnstructuredGridXml(text, 'Volume_1', 0);
        expect(model.nPoints).toBe(4);
        expect([...(model.triangles ?? [])]).toEqual([0, 1, 2, 0, 2, 3]);
        expect(model.positions[3]).toBeCloseTo(1);
    });

    it('fan-triangulates quads and counts other cells as skipped', async () => {
        const text = VTU_ASCII_FIXTURE.replace('0 1 2  0 2 3', '0 1 2 3  0 1').replace('3 6', '4 6').replace('5 5', '9 3');
        const model = await parseUnstructuredGridXml(text);
        expect([...(model.triangles ?? [])]).toEqual([0, 1, 2, 0, 2, 3]);
        expect([...(model.triangleCells ?? [])]).toEqual([0, 0]);
        expect(model.nonTriangleCells).toBe(1);
    });

    it('rejects non-unstructured input', async () => {
        await expect(parseUnstructuredGridXml(VTP_FIXTURE)).rejects.toThrow(/expected UnstructuredGrid/);
        await expect(parseUnstructuredGridXml('nope')).rejects.toThrow(/missing <VTKFile>/);
    });
});

describe('parseBlockDataset / sniffVtkDatasetType', () => {
    it('sniffs dataset types and dispatches .vtp through the native path', async () => {
        expect(sniffVtkDatasetType(VTM_FIXTURE)).toBe('vtkMultiBlockDataSet');
        expect(sniffVtkDatasetType(VTU_ASCII_FIXTURE)).toBe('UnstructuredGrid');
        expect(sniffVtkDatasetType('nope')).toBeUndefined();
        const model = await parseBlockDataset('track.pvtp', VTP_FIXTURE, 'Track', 4);
        expect(model.family).toBe('polydata');
        expect(model.blockName).toBe('Track');
        expect(model.blockIndex).toBe(4);
        expect(model.triangles).toBeUndefined();
        expect(model.segments).toHaveLength(2);
    });
});

describe('expandDagmcMultiblock', () => {
    it('expands every manifest block through the reader callback', async () => {
        const files: Record<string, string> = {
            '/tmp/nuke/dagmc/tokamak_volumes_0.vtu': VTU_ASCII_FIXTURE,
            '/tmp/nuke/dagmc/tokamak_volumes_1.vtu': VTU_ASCII_FIXTURE
        };
        const models = await expandDagmcMultiblock(VTM_FIXTURE, '/tmp/nuke/dagmc/tokamak_volumes.vtm', async (path) => {
            const text = files[path];
            if (text === undefined) {
                throw new Error(`missing fixture for ${path}`);
            }
            return text;
        });
        expect(models.map((model) => model.blockName)).toEqual(['Volume_1', 'Volume_2']);
        expect(mergeDagmcBounds(models)).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
        expect(mergeDagmcBounds([])).toBeUndefined();
    });

    it('names the failing block in read and parse errors', async () => {
        await expect(
            expandDagmcMultiblock(VTM_FIXTURE, '/tmp/x.vtm', async () => {
                throw new Error('denied');
            })
        ).rejects.toThrow(/Volume_1.*denied/);
        await expect(expandDagmcMultiblock(VTM_FIXTURE, '/tmp/x.vtm', async () => 'garbage')).rejects.toThrow(/Volume_1/);
    });
});
