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

import { OpenMCMesh } from './openmc-state-schema';

/**
 * Compute the number of elements in a state mesh (OpenMC `mesh.n_elements`).
 * Used by MeshSource validation/UI: this OpenMC version requires exactly one
 * sub-source per mesh element (openmc/source.py MeshSource sources setter).
 *
 * @param mesh - The mesh to measure.
 * @returns The element count, or `undefined` when grid data is incomplete.
 */
export function getMeshElementCount(mesh: OpenMCMesh): number | undefined {
    if (mesh.type === 'regular') {
        return mesh.dimension.reduce((product, n) => product * n, 1);
    }
    if (mesh.type === 'cylindrical') {
        return gridElements(mesh.rGrid.length, mesh.phiGrid.length, mesh.zGrid.length);
    }
    return gridElements(mesh.rGrid.length, mesh.thetaGrid.length, mesh.phiGrid.length);
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
