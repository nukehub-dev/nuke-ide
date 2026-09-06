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
 * Section-plane state for the CAD viewport.
 *
 * Pure plane math shared by the viewport's applyShading helper and its section
 * popover: maps an axis/flip/fraction triple onto a THREE.Plane-style
 * normal/constant pair against the current model bounding box, so the clipping
 * math stays testable without three.js or Theia imports.
 *
 * @module nuke-cad/browser/viewer-core
 */

export type SectionAxis = 'x' | 'y' | 'z';

/** Section mode state: an axis-orthogonal cut at a fraction of the model bbox. */
export interface SectionState {
    readonly axis: SectionAxis;
    readonly flip: boolean;
    readonly fraction: number;
}

export interface SectionBoundingBox {
    readonly min: number[];
    readonly max: number[];
}

/**
 * Plane in THREE.Plane terms: points p with normal·p + constant >= 0 stay
 * visible; the negative side is clipped away by renderer.localClippingEnabled.
 */
export interface SectionPlane {
    readonly normal: [number, number, number];
    readonly constant: number;
}

export const SECTION_AXES: readonly { id: SectionAxis; label: string }[] = [
    { id: 'x', label: 'X' },
    { id: 'y', label: 'Y' },
    { id: 'z', label: 'Z' }
];

export const AXIS_INDEX: Record<SectionAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

export const DEFAULT_SECTION_FRACTION = 0.5;

export function clampSectionFraction(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/** Model-space position of the cut along the chosen axis: min + fraction*(max-min). */
export function sectionOffset(section: SectionState, box: SectionBoundingBox): number {
    const index = AXIS_INDEX[section.axis];
    const lo = box.min[index];
    const hi = box.max[index];
    return lo + clampSectionFraction(section.fraction) * (hi - lo);
}

/**
 * Plane through min + fraction*(max-min) on the chosen axis. Unflipped, the
 * normal points toward the bbox minimum so the material below the plane stays
 * visible; flipping negates the normal and keeps the upper half instead.
 */
export function sectionPlaneFromBox(section: SectionState, box: SectionBoundingBox): SectionPlane {
    const sign = section.flip ? 1 : -1;
    const normal: [number, number, number] = [0, 0, 0];
    normal[AXIS_INDEX[section.axis]] = sign;
    const offset = sectionOffset(section, box);
    return { normal, constant: -sign * offset };
}

/** Compact status label, e.g. "Z @ 50%". */
export function sectionStatusLabel(section: SectionState): string {
    const label = SECTION_AXES.find((candidate) => candidate.id === section.axis)?.label ?? section.axis.toUpperCase();
    const percent = Math.round(clampSectionFraction(section.fraction) * 100);
    return `${label} @ ${percent}%`;
}
