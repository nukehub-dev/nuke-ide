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
 * Face-picking helpers for the CAD viewport.
 *
 * Maps three.js raycast hits to source face indices and assembles
 * fingerprint-based {@link TopologyRef} objects for sketch-on-face and external
 * geometry. Picks bind to the owning body's current tip feature so references
 * survive downstream boolean or pocket operations on the same body.
 *
 * @module nuke-cad/browser/widgets
 */

import * as THREE from 'three';
import { type TopologyRef, type FaceFingerprint } from '../../../common/topology-refs';

/** Per-face tessellation data consumed by the viewport. */
export interface TessFaceData {
    readonly faceId: number;
    readonly nodes: number[][];
    readonly triangles: number[][];
    readonly bodyId?: string;
    readonly fingerprint?: FaceFingerprint;
}

/** A single raycast hit against a tessellated face mesh. */
export interface FacePickHit {
    readonly solidId: number;
    readonly faceId: number;
    readonly bodyId?: string;
    readonly mesh: THREE.Mesh;
    readonly fingerprint?: FaceFingerprint;
}

/**
 * Build a TopologyRef for a picked face.
 *
 * The reference points at the current tip feature of the body that owns the
 * picked face. ``resolveBodyTipFeature`` maps a body id to the most recent
 * non-suppressed solid-producing feature targeting that body; when the mapping
 * is unavailable the reference falls back to the supplied fallback feature id.
 */
export function buildTopologyRef(
    fallbackFeatureId: string,
    hit: FacePickHit,
    resolveBodyTipFeature?: (bodyId: string) => string | undefined
): TopologyRef | undefined {
    if (hit.fingerprint === undefined) {
        return undefined;
    }
    const featureId =
        hit.bodyId !== undefined && resolveBodyTipFeature !== undefined
            ? (resolveBodyTipFeature(hit.bodyId) ?? fallbackFeatureId)
            : fallbackFeatureId;
    return {
        featureId,
        kind: 'face',
        fingerprint: hit.fingerprint
    };
}

/** Convert a DOM pointer position to normalized device coordinates. */
export function pointerToNdc(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
    return {
        x: ((clientX - rect.left) / rect.width) * 2 - 1,
        y: -((clientY - rect.top) / rect.height) * 2 + 1
    };
}

/**
 * Raycast against the viewport face meshes and return the closest hit.
 *
 * ``meshes`` is expected to be the array of per-face meshes built by the
 * viewport; each mesh's ``userData`` must contain ``solidId`` and ``faceId``,
 * and its geometry must correspond to a {@link TessFaceData} entry carrying a
 * fingerprint.
 */
export function raycastFace(
    meshes: readonly THREE.Mesh[],
    raycaster: THREE.Raycaster,
    ndc: { x: number; y: number },
    camera: THREE.Camera
): FacePickHit | undefined {
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const intersects = raycaster.intersectObjects([...meshes], false);
    if (intersects.length === 0) {
        return undefined;
    }
    const object = intersects[0].object;
    const data = object.userData as {
        solidId?: number;
        faceId?: number;
        bodyId?: string;
        fingerprint?: FaceFingerprint;
    };
    if (typeof data.solidId !== 'number' || typeof data.faceId !== 'number') {
        return undefined;
    }
    return {
        solidId: data.solidId,
        faceId: data.faceId,
        bodyId: data.bodyId,
        mesh: object as THREE.Mesh,
        fingerprint: data.fingerprint
    };
}

/** Reusable highlighter that overlays a translucent mesh on the hovered face. */
export class FaceHighlighter {
    private readonly highlightMesh: THREE.Mesh;
    private highlighted?: THREE.Mesh;

    constructor(color: THREE.Color) {
        const material = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.35,
            depthTest: false,
            side: THREE.DoubleSide
        });
        this.highlightMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
        this.highlightMesh.name = 'cad-face-highlight';
        this.highlightMesh.visible = false;
        this.highlightMesh.renderOrder = 1000;
    }

    /** Attach the highlight mesh to a parent (the model group). */
    attach(parent: THREE.Object3D): void {
        parent.add(this.highlightMesh);
    }

    /** Detach and dispose resources. */
    dispose(): void {
        this.highlightMesh.geometry.dispose();
        (this.highlightMesh.material as THREE.Material).dispose();
        this.highlightMesh.removeFromParent();
    }

    /** Highlight the given source mesh. */
    highlight(mesh: THREE.Mesh): void {
        if (this.highlighted === mesh) {
            return;
        }
        this.highlighted = mesh;
        this.highlightMesh.geometry.dispose();
        this.highlightMesh.geometry = mesh.geometry.clone();
        this.highlightMesh.matrix.copy(mesh.matrixWorld);
        this.highlightMesh.matrixAutoUpdate = false;
        this.highlightMesh.visible = true;
    }

    /** Clear the highlight. */
    clear(): void {
        this.highlighted = undefined;
        this.highlightMesh.visible = false;
    }

    /** True when a face is currently highlighted. */
    get isActive(): boolean {
        return this.highlighted !== undefined;
    }
}
