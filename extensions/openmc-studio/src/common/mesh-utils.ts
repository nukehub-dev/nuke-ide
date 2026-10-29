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
 * Mesh helpers shared across the extension (validation, UI, codegen).
 *
 * @module openmc-studio/common
 */

import {
    OpenMCMesh,
    OpenMCMeshType,
    OpenMCRectilinearMesh,
    OpenMCUnstructuredMesh,
    OpenMCUnstructuredMeshLibrary
} from './openmc-state-schema';

/** Human-readable labels for every mesh type. */
export const MESH_TYPE_LABELS: Record<OpenMCMeshType, string> = {
    regular: 'Regular (Cartesian)',
    rectilinear: 'Rectilinear',
    cylindrical: 'Cylindrical',
    spherical: 'Spherical',
    unstructured: 'Unstructured'
};

/**
 * File extensions (lower-case, without the dot) accepted by each unstructured
 * mesh library. MOAB reads native HDF5/VTK meshes plus Exodus; libMesh reads
 * Exodus only (openmc.mesh.UnstructuredMesh).
 */
export const UNSTRUCTURED_MESH_EXTENSIONS: Record<OpenMCUnstructuredMeshLibrary, string[]> = {
    moab: ['h5m', 'h5', 'vtk', 'e', 'exo', 'ex2'],
    libmesh: ['e', 'exo', 'ex2']
};

/**
 * Compute the number of elements in a state mesh (OpenMC `mesh.n_elements`).
 * Used by MeshSource validation/UI: this OpenMC version requires exactly one
 * sub-source per mesh element (openmc/source.py MeshSource sources setter).
 *
 * Unstructured element counts come from statepoint data, so they cannot be
 * derived before a run.
 *
 * @param mesh - The mesh to measure.
 * @returns The element count, or `undefined` when grid data is incomplete.
 */
export function getMeshElementCount(mesh: OpenMCMesh): number | undefined {
    if (mesh.type === 'regular') {
        return mesh.dimension.reduce((product, n) => product * n, 1);
    }
    if (mesh.type === 'rectilinear') {
        return gridElements(mesh.xGrid.length, mesh.yGrid.length, mesh.zGrid.length);
    }
    if (mesh.type === 'cylindrical') {
        return gridElements(mesh.rGrid.length, mesh.phiGrid.length, mesh.zGrid.length);
    }
    if (mesh.type === 'spherical') {
        return gridElements(mesh.rGrid.length, mesh.thetaGrid.length, mesh.phiGrid.length);
    }
    return undefined;
}

/**
 * Element count from structured grid boundary counts (boundaries - 1 per axis).
 * @param counts - Number of grid boundaries on each axis.
 * @returns The element count, or `undefined` when any axis lacks boundaries.
 */
function gridElements(...counts: number[]): number | undefined {
    if (counts.some((c) => c < 2)) {
        return undefined;
    }
    return counts.reduce((product, c) => product * (c - 1), 1);
}

/**
 * Validate a single rectilinear grid axis.
 *
 * @param values - Grid boundary values.
 * @returns An actionable message, or `undefined` when the grid is valid.
 */
export function validateMeshGrid(values: number[]): string | undefined {
    if (!Array.isArray(values) || values.length < 2) {
        return 'Add at least two boundaries';
    }
    if (values.some((value) => !Number.isFinite(value))) {
        return 'Boundaries must be finite numbers';
    }
    for (let i = 1; i < values.length; i++) {
        if (values[i] <= values[i - 1]) {
            return `Boundaries must strictly increase (${values[i - 1]} then ${values[i]})`;
        }
    }
    return undefined;
}

/**
 * Collect invalid axes for a rectilinear mesh.
 *
 * @param mesh - Rectilinear mesh to validate.
 * @returns One issue per invalid axis.
 */
export function validateRectilinearMesh(mesh: OpenMCRectilinearMesh): Array<{ axis: 'x' | 'y' | 'z'; message: string }> {
    const issues: Array<{ axis: 'x' | 'y' | 'z'; message: string }> = [];
    for (const axis of ['x', 'y', 'z'] as const) {
        const grid = axis === 'x' ? mesh.xGrid : axis === 'y' ? mesh.yGrid : mesh.zGrid;
        const message = validateMeshGrid(grid);
        if (message) {
            issues.push({ axis, message });
        }
    }
    return issues;
}

/**
 * Extract the lower-case extension (without the dot) from a mesh filename.
 *
 * @param filename - File name or path.
 * @returns The extension, or an empty string when there is none.
 */
export function getUnstructuredMeshExtension(filename: string): string {
    const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * Infer the unstructured mesh library from the file extension, mirroring
 * `openmc.UnstructuredMesh` construction.
 *
 * @param filename - File name or path.
 * @returns The inferred library, or `undefined` for an unrecognized extension.
 */
export function inferUnstructuredMeshLibrary(filename: string): OpenMCUnstructuredMeshLibrary | undefined {
    const extension = getUnstructuredMeshExtension(filename);
    if (['h5m', 'h5', 'vtk'].includes(extension)) {
        return 'moab';
    }
    if (['e', 'exo', 'ex2'].includes(extension)) {
        return 'libmesh';
    }
    return undefined;
}

/**
 * Validate an unstructured mesh filename against its selected library.
 *
 * @param filename - File name or path.
 * @param library - Selected mesh library.
 * @returns An actionable message, or `undefined` when the filename is usable.
 */
export function validateUnstructuredMeshFilename(filename: string, library: OpenMCUnstructuredMeshLibrary): string | undefined {
    if (!filename.trim()) {
        return 'Choose an unstructured mesh file';
    }
    const extension = getUnstructuredMeshExtension(filename);
    if (!extension) {
        return `Cannot infer the mesh format: add a file extension (${UNSTRUCTURED_MESH_EXTENSIONS[library].map((e) => `.${e}`).join(', ')})`;
    }
    if (!UNSTRUCTURED_MESH_EXTENSIONS[library].includes(extension)) {
        return `.${
            extension
        } is not supported by the ${library} library: use ${UNSTRUCTURED_MESH_EXTENSIONS[library].map((e) => `.${e}`).join(', ')}`;
    }
    return undefined;
}

/**
 * Human-readable summary of an unstructured mesh (file name + library).
 *
 * @param mesh - Unstructured mesh.
 * @returns A compact description for list rows and summaries.
 */
export function describeUnstructuredMesh(mesh: OpenMCUnstructuredMesh): string {
    const base = mesh.filename.replace(/\\/g, '/').split('/').pop();
    return base ? `${base} · ${mesh.library}` : `No file · ${mesh.library}`;
}
