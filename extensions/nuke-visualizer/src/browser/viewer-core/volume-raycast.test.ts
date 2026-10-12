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
import { createClipPlanesState } from './clip-plane';
import { getColormap } from './colormaps';
import { MAGNITUDE_COMPONENT, mapScalar, type ScalarMapping } from './scalar-mapping';
import {
    buildVolumeLut,
    clipVolumeBox,
    createVolumeRaycastMesh,
    packVolumeScalars,
    VOLUME_LUT_SIZE,
    type VolumeGrid
} from './volume-raycast';

function testMapping(): ScalarMapping {
    const definition = getColormap('Cool to Warm');
    if (!definition) {
        throw new Error('Cool to Warm colormap missing');
    }
    return { definition, range: [0, 10] as const, logScale: false, invert: false, component: MAGNITUDE_COMPONENT };
}

describe('packVolumeScalars', () => {
    it('packs x-major cells normalized over the data range', () => {
        // Values ascend in x-major order: texel index must match flat order.
        const packed = packVolumeScalars([0, 5, 10, 2.5], [2, 2, 1], [0, 10]);
        expect([...packed]).toEqual([0, 128, 255, 64]);
    });

    it('clamps out-of-range values and drops non-finite ones to zero', () => {
        const packed = packVolumeScalars([-4, 99, Number.NaN, 10], [2, 2, 1], [0, 10]);
        expect([...packed]).toEqual([0, 255, 0, 255]);
    });

    it('packs all zeros on a degenerate range', () => {
        expect([...packVolumeScalars([7, 7], [2, 1, 1], [7, 7])]).toEqual([0, 0]);
    });
});

describe('buildVolumeLut', () => {
    it('matches the shared scalar pipeline texel for texel', () => {
        const mapping = testMapping();
        const lut = buildVolumeLut(mapping, [0, 10], 1);
        expect(lut.length).toBe(VOLUME_LUT_SIZE * 4);
        // Exact-zero data stays invisible in both volume modes, keeping its mapped color.
        const zeroRgb = mapScalar(0, mapping)!;
        expect([lut[0], lut[1], lut[2], lut[3]]).toEqual([
            Math.round(zeroRgb[0] * 255),
            Math.round(zeroRgb[1] * 255),
            Math.round(zeroRgb[2] * 255),
            0
        ]);
        // Full-scale texel carries the mapped color at full opacity.
        const rgb = mapScalar(10, mapping)!;
        const top = (VOLUME_LUT_SIZE - 1) * 4;
        expect([lut[top], lut[top + 1], lut[top + 2]]).toEqual([
            Math.round(rgb[0] * 255),
            Math.round(rgb[1] * 255),
            Math.round(rgb[2] * 255)
        ]);
        expect(lut[top + 3]).toBe(255);
        // Mid texel matches mapScalar at the interpolated data value.
        const mid = 128 * 4;
        const midRgb = mapScalar(10 * (128 / 255), mapping)!;
        expect([lut[mid], lut[mid + 1], lut[mid + 2]]).toEqual([
            Math.round(midRgb[0] * 255),
            Math.round(midRgb[1] * 255),
            Math.round(midRgb[2] * 255)
        ]);
    });

    it('scales alpha by the widget opacity', () => {
        const lut = buildVolumeLut(testMapping(), [0, 10], 0.5);
        expect(lut[(VOLUME_LUT_SIZE - 1) * 4 + 3]).toBeLessThan(255);
        expect(lut[(VOLUME_LUT_SIZE - 1) * 4 + 3]).toBeGreaterThan(0);
    });

    it('ramps alpha from zero with no floor (faint regions must not haze)', () => {
        // A per-sample floor saturates to opaque milk over ~200 march steps;
        // density scaling in the shader only works if near-zero data maps to
        // near-zero alpha here.
        const lut = buildVolumeLut(testMapping(), [0, 10], 1);
        expect(lut[1 * 4 + 3]).toBe(1);
        expect(lut[2 * 4 + 3]).toBe(2);
    });
});

describe('clipVolumeBox', () => {
    const mergedMin: [number, number, number] = [0, 0, 0];
    const mergedMax: [number, number, number] = [10, 10, 10];
    const volMin: [number, number, number] = [2, 2, 2];
    const volMax: [number, number, number] = [8, 8, 8];

    it('keeps the full box when every axis is disabled', () => {
        expect(clipVolumeBox(createClipPlanesState(), mergedMin, mergedMax, volMin, volMax)).toEqual({
            center: [5, 5, 5],
            size: [6, 6, 6]
        });
    });

    it('cuts the low side off a non-inverted plane (three.js parity)', () => {
        const box = clipVolumeBox(createClipPlanesState({ X: { enabled: true, fraction: 0.5 } }), mergedMin, mergedMax, volMin, volMax);
        expect(box).toEqual({ center: [6.5, 5, 5], size: [3, 6, 6] });
    });

    it('keeps the opposite side when inverted', () => {
        const box = clipVolumeBox(
            createClipPlanesState({ Z: { enabled: true, fraction: 0.5, invert: true } }),
            mergedMin,
            mergedMax,
            volMin,
            volMax
        );
        expect(box).toEqual({ center: [5, 5, 3.5], size: [6, 6, 3] });
    });

    it('returns undefined when clipped away entirely', () => {
        expect(
            clipVolumeBox(createClipPlanesState({ X: { enabled: true, fraction: 1 } }), mergedMin, mergedMax, volMin, volMax)
        ).toBeUndefined();
    });
});

describe('createVolumeRaycastMesh', () => {
    const grid: VolumeGrid = { dims: [2, 1, 1], min: [0, 0, 0], max: [2, 1, 1] };

    it('places a unit box over the grid bounds with packed textures', () => {
        const mapping = testMapping();
        const handle = createVolumeRaycastMesh({
            grid,
            scalars: packVolumeScalars([0, 10], [2, 1, 1], [0, 10]),
            lut: buildVolumeLut(mapping, [0, 10], 1)
        });
        expect(handle.mesh.position.toArray()).toEqual([1, 0.5, 0.5]);
        expect(handle.mesh.scale.toArray()).toEqual([2, 1, 1]);
        const uniforms = (handle.mesh.material as THREE.ShaderMaterial).uniforms;
        expect(uniforms['boxMin'].value.toArray()).toEqual([0, 0, 0]);
        expect(uniforms['boxMax'].value.toArray()).toEqual([2, 1, 1]);
        expect(Object.keys(uniforms).sort()).toEqual(['boxMax', 'boxMin', 'clipMax', 'clipMin', 'lutMap', 'volumeMap']);
        const volume = uniforms['volumeMap'].value as THREE.Data3DTexture;
        expect([volume.image.width, volume.image.height, volume.image.depth]).toEqual([2, 1, 1]);
        handle.updateLut(buildVolumeLut(mapping, [0, 10], 0.5));
        handle.setBox([0, 0, 0], [1, 1, 1]);
        expect(handle.mesh.position.toArray()).toEqual([0, 0, 0]);
        // The march window follows the cut, but the UV mapping stays on
        // the full grid — otherwise clipping stretches data instead of
        // cutting it.
        expect(uniforms['clipMin'].value.toArray()).toEqual([-0.5, -0.5, -0.5]);
        expect(uniforms['clipMax'].value.toArray()).toEqual([0.5, 0.5, 0.5]);
        expect(uniforms['boxMin'].value.toArray()).toEqual([0, 0, 0]);
        expect(uniforms['boxMax'].value.toArray()).toEqual([2, 1, 1]);
        handle.dispose();
    });

    it('rejects degenerate grids and mismatched payloads', () => {
        const mapping = testMapping();
        const lut = buildVolumeLut(mapping, [0, 10], 1);
        expect(() =>
            createVolumeRaycastMesh({ grid: { dims: [0, 1, 1], min: [0, 0, 0], max: [1, 1, 1] }, scalars: new Uint8Array(0), lut })
        ).toThrow();
        expect(() => createVolumeRaycastMesh({ grid, scalars: new Uint8Array(3), lut })).toThrow();
        expect(() => createVolumeRaycastMesh({ grid, scalars: new Uint8Array(2), lut: new Uint8Array(4) })).toThrow();
    });
});
