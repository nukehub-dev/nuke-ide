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
import { describe, expect, it } from 'vitest';
import { buildVoxelMesh, tallyVolumePoints, updateVoxelInstances, voxelInstanceLayout } from './voxel-blocks';

function unitGrid(): { layout: ReturnType<typeof voxelInstanceLayout> } {
    const axes: [Float64Array, Float64Array, Float64Array] = [
        Float64Array.from([0, 1, 2]),
        Float64Array.from([0, 1]),
        Float64Array.from([0, 1])
    ];
    return { layout: voxelInstanceLayout([2, 1, 1], axes) };
}

describe('updateVoxelInstances', () => {
    it('paints colors and collapses empty cells', () => {
        const { layout } = unitGrid();
        const mesh = buildVoxelMesh(layout, 1);
        expect(mesh.count).toBe(2);
        updateVoxelInstances(
            mesh,
            layout,
            (instance) => (instance === 0 ? [1, 0, 0] : [0, 0, 1]),
            (instance) => instance === 1
        );
        // Kept instance: full unit box at x [0, 1].
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(0, matrix);
        expect(matrix.elements[0]).toBeCloseTo(1);
        expect(matrix.elements[12]).toBeCloseTo(0.5);
        // Culled instance: degenerate scale hides it without removing it.
        mesh.getMatrixAt(1, matrix);
        expect(matrix.elements[0]).toBe(0);
        expect(mesh.instanceColor).toBeDefined();
        const red = new THREE.Color();
        mesh.getColorAt(0, red);
        expect([red.r, red.g, red.b]).toEqual([1, 0, 0]);
        const blue = new THREE.Color();
        mesh.getColorAt(1, blue);
        expect([blue.r, blue.g, blue.b]).toEqual([0, 0, 1]);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        mesh.dispose();
    });
});

describe('tallyVolumePoints', () => {
    it('emits one point per non-empty cell center with matching colors', () => {
        const axes: [Float64Array, Float64Array, Float64Array] = [
            Float64Array.from([0, 1, 2]),
            Float64Array.from([0, 1]),
            Float64Array.from([0, 1])
        ];
        const layout = voxelInstanceLayout([2, 1, 1], axes);
        const payload = tallyVolumePoints(
            layout,
            (instance) => instance === 1,
            (instance) => (instance === 0 ? [1, 0, 0] : [0, 0, 1])
        );
        expect([...payload.positions]).toEqual([0.5, 0.5, 0.5]);
        expect([...payload.colors]).toEqual([1, 0, 0]);
    });

    it('emits nothing when every cell is empty', () => {
        const axes: [Float64Array, Float64Array, Float64Array] = [
            Float64Array.from([0, 1]),
            Float64Array.from([0, 1]),
            Float64Array.from([0, 1])
        ];
        const layout = voxelInstanceLayout([1, 1, 1], axes);
        const payload = tallyVolumePoints(
            layout,
            () => true,
            () => [1, 1, 1]
        );
        expect(payload.positions.length).toBe(0);
        expect(payload.colors.length).toBe(0);
    });
});
