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
 * Shading-mode state for the native 3D viewer core.
 *
 * Mode vocabulary mirrors the trame `Representation` list in
 * `viewer-toolbar-model.ts` (`Surface`, `Surface With Edges`, `Wireframe`,
 * `Points`) plus the `xray` ghost mode from nuke-cad's
 * `viewer-core/shading-modes.ts` — adapted to the visualizer's
 * point/line/mesh datasets. Line and point datasets are already
 * wireframe-like, so `wireframe` only changes face meshes while `points`
 * swaps face/line rendering for a point cloud. `edges` (ParaView
 * `Surface With Edges`) renders the shaded mesh plus a dark overlay of every
 * triangle edge; `feature-edges` keeps the shaded faces but limits the
 * overlay to edges whose dihedral angle exceeds
 * {@link FEATURE_EDGE_ANGLE_DEGREES}. Widgets build both overlays from
 * `THREE.EdgesGeometry` and key their visibility off the mode.
 *
 * Pure functions + types only; no three.js, no DOM, no Theia imports.
 * Widgets translate {@link ViewerShadingFlags} onto three.js materials:
 *
 * ```ts
 * const flags = resolveViewerShadingFlags(mode, baseOpacity);
 * meshMaterial.wireframe = flags.wireframe;
 * meshMaterial.transparent = flags.transparent;
 * meshMaterial.opacity = flags.opacity;
 * meshMaterial.depthWrite = flags.depthWrite;
 * mesh.visible = !flags.pointsOnly;
 * points.visible = flags.pointsOnly || <point dataset>;
 * edgesOverlay.visible = mode === 'edges' && !flags.pointsOnly;
 * featureEdgesOverlay.visible = mode === 'feature-edges' && !flags.pointsOnly;
 * ```
 */

/** Shading modes offered by the viewer header select. */
export type ViewerShadingMode = 'shaded' | 'edges' | 'feature-edges' | 'wireframe' | 'points' | 'xray';

/** Select entry: display metadata for one mutually exclusive shading mode. */
export interface ViewerShadingModeInfo {
    readonly id: ViewerShadingMode;
    readonly label: string;
}

export const VIEWER_SHADING_MODES: readonly ViewerShadingModeInfo[] = [
    { id: 'shaded', label: 'Shaded' },
    { id: 'edges', label: 'Shaded + Edges' },
    { id: 'feature-edges', label: 'Feature Edges' },
    { id: 'wireframe', label: 'Wireframe' },
    { id: 'points', label: 'Points' },
    { id: 'xray', label: 'X-Ray' }
];

/** Default shading mode: solid faces / native line + point rendering. */
export const DEFAULT_VIEWER_SHADING_MODE: ViewerShadingMode = 'shaded';

/**
 * Dihedral angle (degrees) above which a shared triangle edge counts as a
 * feature boundary. Widgets pass this to
 * `new THREE.EdgesGeometry(meshGeometry, FEATURE_EDGE_ANGLE_DEGREES)`.
 */
export const FEATURE_EDGE_ANGLE_DEGREES = 30;

/** Next mode in the header select order, wrapping around (context-menu cycle item). Pure. */
export function nextViewerShadingMode(mode: ViewerShadingMode): ViewerShadingMode {
    const index = VIEWER_SHADING_MODES.findIndex((entry) => entry.id === mode);
    return VIEWER_SHADING_MODES[(index + 1) % VIEWER_SHADING_MODES.length].id;
}

/** Ghost opacity factor applied to the base opacity in `xray` mode. */
export const XRAY_OPACITY_SCALE = 0.35;

/**
 * Per-object material flags decided by the active shading mode. `opacity`
 * already folds in the widget's base opacity (and the x-ray scale), so
 * widgets assign it directly instead of combining opacities themselves.
 */
export interface ViewerShadingFlags {
    /** Face meshes render wireframe (no-op on line/point materials). */
    readonly wireframe: boolean;
    /** Face/line rendering hides in favor of a point cloud. */
    readonly pointsOnly: boolean;
    readonly transparent: boolean;
    readonly opacity: number;
    readonly depthWrite: boolean;
}

/** Runtime guard for shading-mode values (header select + props API). */
export function isViewerShadingMode(value: unknown): value is ViewerShadingMode {
    return (
        value === 'shaded' ||
        value === 'edges' ||
        value === 'feature-edges' ||
        value === 'wireframe' ||
        value === 'points' ||
        value === 'xray'
    );
}

/** Clamp a base opacity into [0, 1]; non-finite input means fully opaque. */
export function clampShadingBaseOpacity(value: number): number {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.min(1, Math.max(0, value));
}

/**
 * Decide the material flags for one shading mode under a base opacity.
 * `shaded`/`edges`/`feature-edges`/`wireframe`/`points` stay opaque unless
 * the base opacity is already translucent; `xray` always ghosts
 * (transparent, no depth write). `edges` and `feature-edges` share the
 * `shaded` flags — each edge overlay is an extra object whose visibility
 * the widget keys off the mode.
 */
export function resolveViewerShadingFlags(mode: ViewerShadingMode, baseOpacity: number): ViewerShadingFlags {
    const opacity = clampShadingBaseOpacity(baseOpacity);
    switch (mode) {
        case 'wireframe':
            return { wireframe: true, pointsOnly: false, transparent: opacity < 1, opacity, depthWrite: true };
        case 'points':
            return { wireframe: false, pointsOnly: true, transparent: opacity < 1, opacity, depthWrite: true };
        case 'xray':
            return { wireframe: false, pointsOnly: false, transparent: true, opacity: opacity * XRAY_OPACITY_SCALE, depthWrite: false };
        case 'shaded':
        case 'edges':
        case 'feature-edges':
            return { wireframe: false, pointsOnly: false, transparent: opacity < 1, opacity, depthWrite: true };
    }
}
