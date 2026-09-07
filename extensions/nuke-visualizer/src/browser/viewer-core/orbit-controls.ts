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
 * Shared orbit navigation for the native 3D viewers.
 *
 * Replaces the hand-rolled theta/phi orbit state that used to live in each
 * native viewer widget (`attachOrbitHandlers` + manual `applyOrbit`/`panBy`,
 * which fought the camera on every drag) with three.js OrbitControls:
 * left-drag orbits, wheel dollies, right-drag pans, with damping enabled.
 * OrbitControls applies gestures to the camera itself and notifies through
 * its `change` event, so widgets stay render-on-demand (no animation loop):
 * the `onChange` callback repaints the canvas per gesture.
 *
 * The module is Theia-free (no imports from `@theia/*`, keeping viewer-core
 * pure and testable): widgets pass their camera and renderer canvas in and
 * get a disposable handle back. `OrbitControls` itself loads through the
 * same dynamic `import('three/examples/jsm/controls/OrbitControls.js')`
 * style as nuke-cad's viewport, so webpack bundles it identically.
 *
 * The fit math over plain min/max triples is pure and vitest-covered; only
 * `createOrbitControls` touches the DOM and three.js.
 */

import * as THREE from 'three';

/** One corner of an axis-aligned bounding box, as a plain triple. */
export type BoundsCorner = readonly [number, number, number];

/** Multiplier applied to the bounding-sphere radius for fit distances. */
export const ORBIT_FIT_FACTOR = 2.2;

/** Floor for fit distances so degenerate bounds never collapse the camera. */
export const ORBIT_MIN_DISTANCE = 1e-6;

/** Fallback view direction when the camera sits exactly on the fit target. */
export const ORBIT_DEFAULT_DIRECTION: BoundsCorner = [1, 1, 1];

/**
 * Standard CAD-style views offered by the viewer nav cluster. Y-up three.js
 * convention (unlike nuke-cad's Z-up viewport, whose directions differ):
 * top looks down +Y, front looks down +Z, right looks down +X.
 */
export type StandardView = 'iso' | 'top' | 'front' | 'right';

/** Camera direction for each standard view, as a plain triple. Pure data. */
export const STANDARD_VIEW_DIRECTIONS: Record<StandardView, BoundsCorner> = {
    iso: [1, 1, 1],
    top: [0, 1, 0],
    front: [0, 0, 1],
    right: [1, 0, 0]
};

/** Direction triple for a standard view name. Pure. */
export function standardViewDirection(view: StandardView): BoundsCorner {
    return STANDARD_VIEW_DIRECTIONS[view];
}

/** Center of `min`/`max` bounds. Pure. */
export function boundsCenter(min: BoundsCorner, max: BoundsCorner): [number, number, number] {
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/** Half the diagonal length of `min`/`max` bounds (bounding-sphere radius). Pure. */
export function boundsRadius(min: BoundsCorner, max: BoundsCorner): number {
    const dx = max[0] - min[0];
    const dy = max[1] - min[1];
    const dz = max[2] - min[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz) / 2;
}

/** Fit distance for a bounding-sphere radius. Non-finite radii collapse to the floor. Pure. */
export function fitDistanceForRadius(radius: number): number {
    if (!Number.isFinite(radius)) {
        return ORBIT_MIN_DISTANCE;
    }
    return Math.max(radius * ORBIT_FIT_FACTOR, ORBIT_MIN_DISTANCE);
}

/** Callbacks for a managed OrbitControls instance. */
export interface OrbitControlsCallbacks {
    /** Render-on-demand repaint, invoked on every controls change. */
    onChange: () => void;
    /** Invoked when the user starts interacting (orbit/zoom/pan). */
    onStart?: () => void;
}

/**
 * Minimal structural surface of OrbitControls used by this module (same
 * approach as nuke-cad's `OrbitControlsCtor` parameter typing, so no static
 * import from `three/examples/` is needed).
 */
export interface ManagedOrbitControls {
    enableDamping: boolean;
    target: THREE.Vector3;
    update: () => void;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    dispose: () => void;
}

/** Disposable OrbitControls wiring owned by one viewer widget. */
export interface OrbitControlsHandle {
    /** Frame `min`/`max` bounds: sets the target and distance, keeping the current view direction. */
    fitBounds: (min: BoundsCorner, max: BoundsCorner) => void;
    /** Snap the camera to a view direction, keeping the target and distance. */
    setViewDirection: (direction: BoundsCorner) => void;
    /** Dolly toward (`factor` < 1) or away (`factor` > 1) from the target. */
    zoomBy: (factor: number) => void;
    /** Remove listeners and release the controls. */
    dispose: () => void;
}

/**
 * Create and wire an OrbitControls instance on a renderer canvas.
 * Damping is enabled; right-drag pans, so the context menu is suppressed on
 * the canvas (matching the old hand-rolled handlers).
 */
export async function createOrbitControls(
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    callbacks: OrbitControlsCallbacks
): Promise<OrbitControlsHandle> {
    const { OrbitControls: OrbitControlsCtor } = await import('three/examples/jsm/controls/OrbitControls.js');
    const controls = new OrbitControlsCtor(camera, canvas) as ManagedOrbitControls;
    controls.enableDamping = true;
    let disposed = false;
    const handleChange = (): void => {
        if (!disposed) {
            callbacks.onChange();
        }
    };
    controls.addEventListener('change', handleChange);
    const handleStart = (): void => {
        if (!disposed) {
            callbacks.onStart?.();
        }
    };
    if (callbacks.onStart) {
        controls.addEventListener('start', handleStart);
    }
    const suppressMenu = (event: Event): void => event.preventDefault();
    canvas.addEventListener('contextmenu', suppressMenu);
    return {
        fitBounds: (min, max) => {
            if (disposed) {
                return;
            }
            const center = boundsCenter(min, max);
            const distance = fitDistanceForRadius(boundsRadius(min, max));
            const target = new THREE.Vector3(center[0], center[1], center[2]);
            const direction = camera.position.clone().sub(controls.target);
            if (direction.lengthSq() < 1e-12) {
                direction.set(ORBIT_DEFAULT_DIRECTION[0], ORBIT_DEFAULT_DIRECTION[1], ORBIT_DEFAULT_DIRECTION[2]);
            }
            direction.normalize();
            controls.target.copy(target);
            camera.position.copy(target).addScaledVector(direction, distance);
            controls.update();
        },
        setViewDirection: (direction) => {
            if (disposed) {
                return;
            }
            const viewDir = new THREE.Vector3(direction[0], direction[1], direction[2]);
            if (viewDir.lengthSq() < 1e-12) {
                return;
            }
            viewDir.normalize();
            const distance = Math.max(camera.position.distanceTo(controls.target), ORBIT_MIN_DISTANCE);
            camera.position.copy(controls.target).addScaledVector(viewDir, distance);
            controls.update();
        },
        zoomBy: (factor) => {
            if (disposed || !Number.isFinite(factor) || factor <= 0) {
                return;
            }
            const offset = camera.position.clone().sub(controls.target).multiplyScalar(factor);
            camera.position.copy(controls.target).add(offset);
            controls.update();
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            controls.removeEventListener('change', handleChange);
            if (callbacks.onStart) {
                controls.removeEventListener('start', handleStart);
            }
            canvas.removeEventListener('contextmenu', suppressMenu);
            controls.dispose();
        }
    };
}
