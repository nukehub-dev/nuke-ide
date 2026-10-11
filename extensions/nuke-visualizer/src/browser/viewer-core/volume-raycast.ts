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
import type { ClipPlanesState } from './clip-plane';
import { clampClipFraction } from './clip-plane';
import { mapScalar, normalizeToRange, type ScalarMapping } from './scalar-mapping';

/**
 * Smooth tally-volume rendering for the DAGMC drape scene: the same mesh
 * tally the voxel boxes show (`voxel-blocks.ts`, one flat-shaded box per
 * cell), sampled with hardware trilinear filtering instead.
 *
 * Each ray shows its maximum sample (MIP) rather than an alpha composite:
 * compositing veils the hot core in the blue haze of the much longer
 * low-flux path around it, while MIP keeps the core vivid with faint
 * surroundings.
 *
 * Boxes stay the default (exact per-cell values, cheap, no WebGL2 3D-texture
 * dependency beyond the base viewer); this module is the opt-in `smooth`
 * mode behind the Viewer Settings "Smooth volume" switch. Colors are
 * guaranteed to match the boxes: the RGBA lookup table is rebuilt from the
 * shared `ScalarMapping` pipeline (`mapScalar`, so colormap, range, log
 * scale, and invert behave identically), and exact-zero cells stay invisible
 * in both modes (collapsed boxes / zero alpha).
 */

export const VOLUME_LUT_SIZE = 256;

/** Fixed march steps: constant loop bounds (WebGL1-style GLSL restriction). */
export const VOLUME_MARCH_STEPS = 192;

/** Tally-volume representation in the drape scene. */
export type TallyVolumeMode = 'boxes' | 'smooth';

/** Axis-aligned grid a volume texture is packed from (world coordinates). */
export interface VolumeGrid {
    /** Cell counts per axis ([nx, ny, nz]). */
    readonly dims: readonly [number, number, number];
    /** Grid lower corner in world coordinates. */
    readonly min: readonly [number, number, number];
    /** Grid upper corner in world coordinates. */
    readonly max: readonly [number, number, number];
}

/** Center + full-size box placement for the raycast mesh. */
export interface VolumeBoxPlacement {
    readonly center: readonly [number, number, number];
    readonly size: readonly [number, number, number];
}

/**
 * Pack cell scalars into an R8 3D-texture upload, x-major
 * (`i + nx * (j + ny * k)` — the same ordering `voxelInstanceLayout` uses
 * for instance colors, matching `Data3DTexture` x-fastest layout).
 * Normalized over `dataRange`; non-finite values pack as 0 (invisible).
 */
export function packVolumeScalars(
    values: ArrayLike<number>,
    dims: readonly [number, number, number],
    dataRange: readonly [number, number]
): Uint8Array<ArrayBuffer> {
    const [nx, ny, nz] = dims;
    const count = Math.max(0, nx) * Math.max(0, ny) * Math.max(0, nz);
    const out = new Uint8Array(new ArrayBuffer(count));
    const [min, max] = dataRange;
    const span = max - min;
    if (!(span > 0)) {
        return out;
    }
    for (let n = 0; n < count; n++) {
        const v = values[n];
        if (!Number.isFinite(v)) {
            continue;
        }
        out[n] = Math.round(Math.min(1, Math.max(0, (v - min) / span)) * 255);
    }
    return out;
}

/**
 * Build a 256-entry RGBA lookup texture from a resolved `ScalarMapping`:
 * texel `i` holds the color of `dataRange` interpolated at `i / 255`, so
 * volume colors match the instanced boxes texel-for-texel. Exact-zero data
 * values (and non-positive values under log scaling) get zero alpha,
 * mirroring the collapsed empty boxes; anything else ramps from faint to
 * the full `opacity` with display intensity.
 */
export function buildVolumeLut(mapping: ScalarMapping, dataRange: readonly [number, number], opacity: number): Uint8Array<ArrayBuffer> {
    const lut = new Uint8Array(new ArrayBuffer(VOLUME_LUT_SIZE * 4));
    const [dataMin, dataMax] = dataRange;
    const span = dataMax - dataMin;
    for (let i = 0; i < VOLUME_LUT_SIZE; i++) {
        const dataValue = Number.isFinite(span) && span > 0 ? dataMin + (i / (VOLUME_LUT_SIZE - 1)) * span : 0;
        const rgb = mapScalar(dataValue, mapping) ?? [0, 0, 0];
        const at = i * 4;
        lut[at] = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
        lut[at + 1] = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
        lut[at + 2] = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
        let alpha = 0;
        if (dataValue !== 0 && !(mapping.logScale && dataValue <= 0)) {
            // Display intensity mirrors mapScalar's t (linear/log + range,
            // deliberately not inverted: alpha follows data magnitude while
            // the colormap direction only affects color).
            let t: number;
            if (mapping.logScale) {
                const [min, max] = mapping.range;
                t = min > 0 && max > 0 ? normalizeToRange(Math.log(dataValue), [Math.log(min), Math.log(max)]) : 0;
            } else {
                t = normalizeToRange(dataValue, mapping.range);
            }
            alpha = opacity * t;
        }
        lut[at + 3] = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
    }
    return lut;
}

/**
 * Intersect the volume box with the enabled per-axis clip half-spaces (same
 * inputs and kept-side contract as `toThreePlaneParamsArray`: non-inverted
 * keeps `p[axis] >= min + fraction * size` over the merged bounds, inverted
 * keeps the opposite side). Returns the visible sub-box, or undefined when
 * fully clipped away. Lets the raycast mesh honor Clip without any shader
 * clipping chunks.
 */
export function clipVolumeBox(
    clip: ClipPlanesState,
    mergedMin: readonly [number, number, number],
    mergedMax: readonly [number, number, number],
    volMin: readonly [number, number, number],
    volMax: readonly [number, number, number]
): VolumeBoxPlacement | undefined {
    const min: [number, number, number] = [volMin[0], volMin[1], volMin[2]];
    const max: [number, number, number] = [volMax[0], volMax[1], volMax[2]];
    const axes = ['X', 'Y', 'Z'] as const;
    for (let a = 0; a < 3; a++) {
        const entry = clip[axes[a]];
        if (!entry.enabled) {
            continue;
        }
        const distance = mergedMin[a] + clampClipFraction(entry.fraction) * (mergedMax[a] - mergedMin[a]);
        if (entry.invert) {
            max[a] = Math.min(max[a], distance);
        } else {
            min[a] = Math.max(min[a], distance);
        }
        if (min[a] > max[a]) {
            return undefined;
        }
    }
    return {
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    };
}

/** Live handle for one raycast volume mesh (owned by the widget). */
export interface VolumeRaycastHandle {
    readonly mesh: THREE.Mesh;
    /** Replace the RGBA lookup (same 256 entries); cheap, no re-upload of the volume. */
    updateLut(lut: Uint8Array): void;
    /** Move/resize the raycast box (clip sections). */
    setBox(center: readonly [number, number, number], size: readonly [number, number, number]): void;
    dispose(): void;
}

const VOLUME_VERTEX_SHADER = `out vec3 vWorldPos;
void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const VOLUME_FRAGMENT_SHADER = `uniform highp sampler3D volumeMap;
uniform highp sampler2D lutMap;
uniform vec3 boxMin;
uniform vec3 boxMax;
in vec3 vWorldPos;
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define MARCH_STEPS ${VOLUME_MARCH_STEPS}
vec2 boxHit(vec3 ro, vec3 rd) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (boxMin - ro) * inv;
    vec3 t1 = (boxMax - ro) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - cameraPosition);
    vec2 hit = boxHit(ro, rd);
    float start = max(hit.x, 0.0);
    if (hit.y <= start) {
        discard;
    }
    float dt = (hit.y - start) / float(MARCH_STEPS);
    vec3 span = boxMax - boxMin;
    // Maximum-intensity projection: each ray shows its hottest sample.
    // Alpha compositing instead would veil the core in the blue haze of
    // the (much longer) low-flux path around it.
    float maxS = 0.0;
    for (int i = 0; i < MARCH_STEPS; i++) {
        vec3 p = ro + rd * (start + (float(i) + 0.5) * dt);
        vec3 uvw = (p - boxMin) / span;
        maxS = max(maxS, texture(volumeMap, uvw).r);
    }
    vec4 lut = texture(lutMap, vec2(maxS, 0.5));
    if (lut.a <= 0.0) {
        discard;
    }
    gl_FragColor = vec4(lut.rgb, lut.a);
}
`;

/**
 * Assemble the raycast mesh over `grid` from packed R8 scalars and an RGBA
 * LUT (see `packVolumeScalars` / `buildVolumeLut`). BackSide rasterization
 * yields the exit point per pixel (also when the camera sits inside the
 * volume); entry comes from the analytic box hit. Throws on degenerate
 * grids so callers can fall back to voxel boxes.
 */
export function createVolumeRaycastMesh(options: {
    grid: VolumeGrid;
    scalars: Uint8Array<ArrayBuffer>;
    lut: Uint8Array<ArrayBuffer>;
}): VolumeRaycastHandle {
    const { grid, scalars, lut } = options;
    const [nx, ny, nz] = grid.dims;
    if (!(nx > 0 && ny > 0 && nz > 0)) {
        throw new Error('Volume raycast needs a non-empty grid');
    }
    if (scalars.length !== nx * ny * nz) {
        throw new Error(`Volume scalars hold ${scalars.length} values, expected ${nx * ny * nz}`);
    }
    if (lut.length !== VOLUME_LUT_SIZE * 4) {
        throw new Error(`Volume LUT holds ${lut.length} bytes, expected ${VOLUME_LUT_SIZE * 4}`);
    }
    const size: [number, number, number] = [grid.max[0] - grid.min[0], grid.max[1] - grid.min[1], grid.max[2] - grid.min[2]];
    if (!(size[0] > 0 && size[1] > 0 && size[2] > 0)) {
        throw new Error('Volume raycast needs a non-degenerate grid box');
    }
    const volumeTexture = new THREE.Data3DTexture(scalars, nx, ny, nz);
    volumeTexture.format = THREE.RedFormat;
    volumeTexture.type = THREE.UnsignedByteType;
    volumeTexture.minFilter = THREE.LinearFilter;
    volumeTexture.magFilter = THREE.LinearFilter;
    volumeTexture.wrapS = THREE.ClampToEdgeWrapping;
    volumeTexture.wrapT = THREE.ClampToEdgeWrapping;
    volumeTexture.wrapR = THREE.ClampToEdgeWrapping;
    volumeTexture.unpackAlignment = 1;
    volumeTexture.needsUpdate = true;
    const lutTexture = new THREE.DataTexture(lut, VOLUME_LUT_SIZE, 1);
    lutTexture.format = THREE.RGBAFormat;
    lutTexture.type = THREE.UnsignedByteType;
    lutTexture.minFilter = THREE.LinearFilter;
    lutTexture.magFilter = THREE.LinearFilter;
    lutTexture.wrapS = THREE.ClampToEdgeWrapping;
    lutTexture.wrapT = THREE.ClampToEdgeWrapping;
    lutTexture.unpackAlignment = 1;
    lutTexture.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
            volumeMap: { value: volumeTexture },
            lutMap: { value: lutTexture },
            boxMin: { value: new THREE.Vector3(...grid.min) },
            boxMax: { value: new THREE.Vector3(...grid.max) }
        },
        vertexShader: VOLUME_VERTEX_SHADER,
        fragmentShader: VOLUME_FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    mesh.position.set((grid.min[0] + grid.max[0]) / 2, (grid.min[1] + grid.max[1]) / 2, (grid.min[2] + grid.max[2]) / 2);
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.frustumCulled = false;
    mesh.name = 'tally-volume-smooth';
    // Flagged so viewer material sweeps skip it: opacity/wireframe live in
    // the RGBA lookup and the custom shader, not built-in material flags.
    mesh.userData['tallyVolumeSmooth'] = true;
    return {
        mesh,
        updateLut(next: Uint8Array<ArrayBuffer>): void {
            if (next.length !== VOLUME_LUT_SIZE * 4) {
                throw new Error(`Volume LUT holds ${next.length} bytes, expected ${VOLUME_LUT_SIZE * 4}`);
            }
            (lutTexture.image.data as Uint8Array).set(next);
            lutTexture.needsUpdate = true;
        },
        setBox(center: readonly [number, number, number], boxSize: readonly [number, number, number]): void {
            mesh.position.set(center[0], center[1], center[2]);
            mesh.scale.set(boxSize[0], boxSize[1], boxSize[2]);
            (material.uniforms['boxMin'] as THREE.IUniform).value.set(
                center[0] - boxSize[0] / 2,
                center[1] - boxSize[1] / 2,
                center[2] - boxSize[2] / 2
            );
            (material.uniforms['boxMax'] as THREE.IUniform).value.set(
                center[0] + boxSize[0] / 2,
                center[1] + boxSize[1] / 2,
                center[2] + boxSize[2] / 2
            );
        },
        dispose(): void {
            mesh.geometry.dispose();
            material.dispose();
            volumeTexture.dispose();
            lutTexture.dispose();
        }
    };
}
