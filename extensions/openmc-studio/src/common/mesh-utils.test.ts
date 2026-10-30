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
 * Mesh helper tests: element counts, grid validation, and unstructured format
 * inference/validation.
 */

import { describe, it, expect } from 'vitest';
import {
    describeUnstructuredMesh,
    getMeshElementCount,
    getUnstructuredMeshExtension,
    inferUnstructuredMeshLibrary,
    validateMeshGrid,
    validateRectilinearMesh,
    validateUnstructuredMeshFilename
} from './mesh-utils';

describe('mesh-utils', () => {
    it('counts rectilinear elements from grid boundaries', () => {
        expect(getMeshElementCount({ type: 'rectilinear', id: 1, xGrid: [0, 1, 2], yGrid: [0, 1], zGrid: [-1, 1] })).toBe(2);
        expect(getMeshElementCount({ type: 'rectilinear', id: 1, xGrid: [0], yGrid: [0, 1], zGrid: [-1, 1] })).toBeUndefined();
        expect(getMeshElementCount({ type: 'unstructured', id: 2, filename: 'core.h5m', library: 'moab' })).toBeUndefined();
    });

    it('validates finite, strictly increasing grids', () => {
        expect(validateMeshGrid([0, 1, 2])).toBeUndefined();
        expect(validateMeshGrid([0])).toContain('at least two');
        expect(validateMeshGrid([0, 1, 1])).toContain('strictly increase');
        expect(validateMeshGrid([0, Number.NaN, 1])).toContain('finite');

        const issues = validateRectilinearMesh({
            type: 'rectilinear',
            id: 3,
            xGrid: [0],
            yGrid: [0, 2, 1],
            zGrid: [-1, 0, 1]
        });
        expect(issues.map((issue) => issue.axis)).toEqual(['x', 'y']);
    });

    it('infers libraries and validates extensions the same way OpenMC does', () => {
        expect(getUnstructuredMeshExtension('/meshes/core.H5M')).toBe('h5m');
        expect(getUnstructuredMeshExtension('core')).toBe('');
        expect(inferUnstructuredMeshLibrary('core.h5m')).toBe('moab');
        expect(inferUnstructuredMeshLibrary('core.exo')).toBe('libmesh');
        expect(inferUnstructuredMeshLibrary('core.bin')).toBeUndefined();

        expect(validateUnstructuredMeshFilename('core.h5m', 'moab')).toBeUndefined();
        expect(validateUnstructuredMeshFilename('core.exo', 'libmesh')).toBeUndefined();
        expect(validateUnstructuredMeshFilename('core.vtk', 'libmesh')).toContain('.vtk is not supported');
        expect(validateUnstructuredMeshFilename('', 'moab')).toContain('Choose');
        expect(validateUnstructuredMeshFilename('core', 'moab')).toContain('extension');
    });

    it('describes unstructured meshes by file name and library', () => {
        expect(describeUnstructuredMesh({ type: 'unstructured', id: 1, filename: '/meshes/core.h5m', library: 'moab' })).toBe(
            'core.h5m · moab'
        );
        expect(describeUnstructuredMesh({ type: 'unstructured', id: 1, filename: '', library: 'libmesh' })).toBe('No file · libmesh');
    });
});
