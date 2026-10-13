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
 * Lightweight same-file camera link bus for the native 3D viewers.
 *
 * Linked views share their orbit camera (opt-in per view, default off):
 * a view's orbit `change` hook publishes `{position, target}` under its
 * file-path key, and every other subscriber of the same key applies the
 * view direction through the existing orbit handle. Different files never
 * link — identity is the file path, full stop.
 *
 * Camera-only sync, by construction: the bus carries six numbers (two
 * triples) and nothing else, so display settings (warp, threshold,
 * glyphs, color-by, clip, shading) can never cross views.
 *
 * Echo suppression is two-layered. The bus drops any publish that exactly
 * equals the last pose dispatched for its key (a subscriber rebroadcasting
 * what it just received terminates after one echo instead of ping-ponging),
 * and never delivers an endpoint's own publish back to itself. Widgets add
 * the third layer: they never publish while applying a linked pose.
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports (same
 * discipline as `orbit-controls.ts`). Widgets share the module-level
 * {@link cameraLinkBus}; tests isolate through {@link createCameraLinkBus}.
 */

/** One 3D point as a plain triple (camera position or orbit target). */
export type CameraLinkVector = readonly [number, number, number];

/** Linked camera pose: the orbit position plus its target. */
export interface CameraLinkPose {
    readonly position: CameraLinkVector;
    readonly target: CameraLinkVector;
}

/** Receiver for poses published under one file key. */
export type CameraLinkListener = (pose: CameraLinkPose) => void;

/** One linked view: publish under its key, dispose to leave the bus. */
export interface CameraLinkEndpoint {
    /** Publish a pose to every other subscriber of this endpoint's key (never back to itself). */
    publish: (pose: CameraLinkPose) => void;
    /** Unsubscribe (widget detach/dispose path — no leaked bus listeners). */
    dispose: () => void;
}

/** Squared-length floor below which a pose has no usable view direction (orbit-controls parity). */
const CAMERA_LINK_DIRECTION_EPS_SQ = 1e-12;

/** True when every component is a finite number. */
function isFiniteVector(vector: CameraLinkVector): boolean {
    return Number.isFinite(vector[0]) && Number.isFinite(vector[1]) && Number.isFinite(vector[2]);
}

/** Defensive copy (published poses must not alias caller or listener memory). */
function copyVector(vector: CameraLinkVector): [number, number, number] {
    return [vector[0], vector[1], vector[2]];
}

/** Defensive copy of a pose. */
function copyPose(pose: CameraLinkPose): CameraLinkPose {
    return { position: copyVector(pose.position), target: copyVector(pose.target) };
}

/** Exact component-wise equality (the echo-suppression comparison). */
function posesEqual(a: CameraLinkPose, b: CameraLinkPose): boolean {
    return (
        a.position[0] === b.position[0] &&
        a.position[1] === b.position[1] &&
        a.position[2] === b.position[2] &&
        a.target[0] === b.target[0] &&
        a.target[1] === b.target[1] &&
        a.target[2] === b.target[2]
    );
}

/**
 * Derive the orbit view direction (target → position) from a linked pose,
 * for the subscriber's `setViewDirection` handle. Undefined when the pose
 * is degenerate (non-finite components or a zero-length offset), in which
 * case the subscriber keeps its own view. Pure.
 */
export function cameraPoseDirection(pose: CameraLinkPose): [number, number, number] | undefined {
    if (!isFiniteVector(pose.position) || !isFiniteVector(pose.target)) {
        return undefined;
    }
    const dx = pose.position[0] - pose.target[0];
    const dy = pose.position[1] - pose.target[1];
    const dz = pose.position[2] - pose.target[2];
    const lengthSq = dx * dx + dy * dy + dz * dz;
    if (!(lengthSq > CAMERA_LINK_DIRECTION_EPS_SQ)) {
        return undefined;
    }
    const length = Math.sqrt(lengthSq);
    return [dx / length, dy / length, dz / length];
}

/** Create an isolated bus (widgets share {@link cameraLinkBus} instead). */
export function createCameraLinkBus(): { link: (fileKey: string, listener: CameraLinkListener) => CameraLinkEndpoint } {
    let nextId = 1;
    const groups = new Map<string, Map<number, CameraLinkListener>>();
    const lastPose = new Map<string, CameraLinkPose>();

    function publishPose(fileKey: string, originId: number, pose: CameraLinkPose): void {
        const snapshot = copyPose(pose);
        // Echo suppression: a subscriber rebroadcasting the pose it just
        // received republishes exactly what was dispatched, so it drops
        // here and the loop terminates. A genuinely new pose still passes.
        const previous = lastPose.get(fileKey);
        if (previous !== undefined && posesEqual(previous, snapshot)) {
            return;
        }
        lastPose.set(fileKey, snapshot);
        const group = groups.get(fileKey);
        if (!group) {
            return;
        }
        // Snapshot the membership: listeners may (un)subscribe mid-dispatch,
        // and a departed listener must not be called.
        for (const [id, listener] of [...group]) {
            if (id !== originId && group.get(id) === listener) {
                listener(copyPose(snapshot));
            }
        }
    }

    return {
        link: (fileKey: string, listener: CameraLinkListener): CameraLinkEndpoint => {
            // Without a file identity there is nothing to scope to: hand out
            // an inert endpoint rather than a bus-wide broadcast.
            if (!fileKey) {
                return { publish: () => undefined, dispose: () => undefined };
            }
            let group = groups.get(fileKey);
            if (!group) {
                group = new Map();
                groups.set(fileKey, group);
            }
            const id = nextId++;
            group.set(id, listener);
            let disposed = false;
            return {
                publish: (pose: CameraLinkPose): void => {
                    if (!disposed) {
                        publishPose(fileKey, id, pose);
                    }
                },
                dispose: (): void => {
                    if (disposed) {
                        return;
                    }
                    disposed = true;
                    group?.delete(id);
                    if ((group?.size ?? 0) === 0) {
                        groups.delete(fileKey);
                        lastPose.delete(fileKey);
                    }
                }
            };
        }
    };
}

/** Shared bus for the native viewers (one process, one link scope). */
export const cameraLinkBus = createCameraLinkBus();
