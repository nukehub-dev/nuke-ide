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

import * as THREE from 'three';

/**
 * Shared instanced voxel blocks for axis-aligned grids (weight-window
 * `.vtr`, voxel `.vti`, tally mesh volumes, DAGMC drape interiors):
 * one unit box per kept cell, per-axis scaled, colors painted per
 * instance. Uniform 3D thinning past the budget keeps coverage complete
 * (a flat index stride would punch interior holes while rendering every
 * boundary box).
 */

/** Default cap for voxel-block instances (uniform 3D thinning past it). */
export const NATIVE_VTK_VOXEL_BUDGET = 100000;

/** Per-axis cell subsets surviving a uniform thinning step. */
export interface VoxelInstanceLayout {
    /** Kept flat cell indices (x-major) driving instance colors. */
    cells: Uint32Array;
    /** Box centers, 3 per instance. */
    centers: Float32Array;
    /** Box sizes (full cell extents, possibly non-uniform), 3 per instance. */
    sizes: Float32Array;
}

/**
 * Uniform voxel subset for instanced rendering. Render instance r colors
 * cell `cells[r]`, so recolor needs no separate mapping.
 */
export function voxelInstanceLayout(
    dims: readonly [number, number, number],
    axes: readonly [Float64Array, Float64Array, Float64Array],
    budget: number = NATIVE_VTK_VOXEL_BUDGET
): VoxelInstanceLayout {
    const [nx, ny, nz] = dims;
    const nCells = Math.max(0, nx) * Math.max(0, ny) * Math.max(0, nz);
    const step = Math.max(1, Math.ceil(Math.cbrt(nCells / Math.max(1, budget))));
    const kept: number[] = [];
    for (let k = 0; k < nz; k += step) {
        for (let j = 0; j < ny; j += step) {
            for (let i = 0; i < nx; i += step) {
                kept.push(i + nx * (j + ny * k));
            }
        }
    }
    const [xAxis, yAxis, zAxis] = axes;
    const centers = new Float32Array(kept.length * 3);
    const sizes = new Float32Array(kept.length * 3);
    kept.forEach((cell, r) => {
        const i = cell % nx;
        const j = Math.floor(cell / nx) % ny;
        const k = Math.floor(cell / (nx * ny));
        centers[r * 3] = (xAxis[i] + xAxis[i + 1]) / 2;
        centers[r * 3 + 1] = (yAxis[j] + yAxis[j + 1]) / 2;
        centers[r * 3 + 2] = (zAxis[k] + zAxis[k + 1]) / 2;
        sizes[r * 3] = xAxis[i + 1] - xAxis[i];
        sizes[r * 3 + 1] = yAxis[j + 1] - yAxis[j];
        sizes[r * 3 + 2] = zAxis[k + 1] - zAxis[k];
    });
    return { cells: new Uint32Array(kept), centers, sizes };
}

/**
 * Refresh one voxel mesh: full-size boxes with painted colors, degenerate
 * (scale-zero) boxes for empty cells. Zero-valued cells (void/background)
 * would otherwise render as translucent wash hiding the geometry — with
 * only real values left, sparse tallies read as glowing bricks instead of
 * fog. Matrices and colors update together every recolor (array switches
 * restore culled cells); both buffers flag for upload.
 */
export function updateVoxelInstances(
    mesh: THREE.InstancedMesh,
    layout: VoxelInstanceLayout,
    colorAt: (instance: number) => [number, number, number],
    isEmpty: (instance: number) => boolean
): void {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    for (let r = 0; r < layout.cells.length; r++) {
        if (isEmpty(r)) {
            scale.set(0, 0, 0);
            position.set(0, 0, 0);
        } else {
            position.set(layout.centers[r * 3], layout.centers[r * 3 + 1], layout.centers[r * 3 + 2]);
            scale.set(layout.sizes[r * 3], layout.sizes[r * 3 + 1], layout.sizes[r * 3 + 2]);
        }
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(r, matrix);
        const [cr, cg, cb] = colorAt(r);
        mesh.setColorAt(r, color.setRGB(cr, cg, cb));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
    }
}

/** Instanced unit-box mesh over a voxel layout (per-instance colors painted later). */
export function buildVoxelMesh(layout: VoxelInstanceLayout, opacity: number): THREE.InstancedMesh {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshLambertMaterial({ transparent: true, opacity });
    const mesh = new THREE.InstancedMesh(geometry, material, layout.cells.length);
    // Instanced bounds are version-sensitive; never let whole-grid culling
    // hide the volume when the origin leaves the frustum.
    mesh.frustumCulled = false;
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let r = 0; r < layout.cells.length; r++) {
        position.set(layout.centers[r * 3], layout.centers[r * 3 + 1], layout.centers[r * 3 + 2]);
        scale.set(layout.sizes[r * 3], layout.sizes[r * 3 + 1], layout.sizes[r * 3 + 2]);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(r, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
}
