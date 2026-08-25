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
 * Shading-mode state for the CAD viewport.
 *
 * Pure decision logic shared by the viewport's applyShading helper and its
 * shading popover: maps the active mode plus ghost opacity onto per-mesh
 * material flags so x-ray/edges-only semantics stay testable without three.js
 * or Theia imports.
 *
 * @module nuke-cad/browser/widgets
 */

export type ShadingMode = 'shaded' | 'shadedWireframe' | 'edgesOnly' | 'xray';

/** Popover entry: display metadata for one mutually exclusive shading mode. */
export interface ShadingModeInfo {
    readonly id: ShadingMode;
    readonly label: string;
    readonly icon: string;
}

export const SHADING_MODES: readonly ShadingModeInfo[] = [
    { id: 'shaded', label: 'Shaded', icon: 'codicon-eye' },
    { id: 'shadedWireframe', label: 'Shaded + Edges', icon: 'codicon-circuit-board' },
    { id: 'edgesOnly', label: 'Edges Only', icon: 'codicon-nuke-cad-edges' },
    { id: 'xray', label: 'X-Ray', icon: 'codicon-symbol-color' }
];

export const GHOST_OPACITY_MIN = 0.15;
export const GHOST_OPACITY_MAX = 0.6;
export const GHOST_OPACITY_STEP = 0.05;
export const DEFAULT_GHOST_OPACITY = 0.35;

/** Per-mesh material flags decided by the active shading mode. */
export interface MeshShadingFlags {
    readonly faceVisible: boolean;
    readonly wireframe: boolean;
    readonly transparent: boolean;
    readonly opacity: number;
    readonly depthWrite: boolean;
}

const OPAQUE_FLAGS: MeshShadingFlags = {
    faceVisible: true,
    wireframe: false,
    transparent: false,
    opacity: 1,
    depthWrite: true
};

export function clampGhostOpacity(value: number): number {
    return Math.min(GHOST_OPACITY_MAX, Math.max(GHOST_OPACITY_MIN, value));
}

/**
 * Decide the material flags for one face mesh under a shading mode. Edge-line
 * materials are never touched: B-rep edges stay opaque in every mode.
 */
export function meshShadingFlags(mode: ShadingMode, ghostOpacity: number): MeshShadingFlags {
    switch (mode) {
        case 'shaded':
            return OPAQUE_FLAGS;
        case 'shadedWireframe':
            return { ...OPAQUE_FLAGS, wireframe: true };
        case 'edgesOnly':
            return { ...OPAQUE_FLAGS, faceVisible: false };
        case 'xray':
            return {
                faceVisible: true,
                wireframe: false,
                transparent: true,
                opacity: clampGhostOpacity(ghostOpacity),
                depthWrite: false
            };
    }
}
