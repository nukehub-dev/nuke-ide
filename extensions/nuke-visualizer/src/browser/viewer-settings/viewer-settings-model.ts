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

import type { ClipAxis, ClipPlanesState } from '../viewer-core/clip-plane';
import type { BoundsCorner } from '../viewer-core/orbit-controls';
import type { ViewerShadingMode } from '../viewer-core/shading-mode';

/**
 * Shared settings contract between the native 3D viewer widgets and the
 * Viewer Settings sidebar panel.
 *
 * Sync is single-direction with no duplicated state: the panel renders a
 * {@link ViewerSettingsSnapshot} read from the active widget and applies
 * edits through {@link ViewerSettingsHost.applyViewerSettings} — the same
 * setters the viewer headers used to call. Widgets own every value; the
 * panel never caches them. Sections the active viewer does not support
 * (geometry-native has no color-by/shading/measure, Exodus has no
 * shading/clip/measure, Solid Color mode drops the mapping controls) are
 * absent from the snapshot and render nothing.
 *
 * Pure types + selection helpers only; no three.js, no DOM, no Theia imports.
 */

/** One color-by entry offered by a viewer (`Solid Color` or `Point/Cell: <name>`). */
export interface ViewerColorByOption {
    readonly value: string;
    readonly label: string;
}

/** Color-by section of a settings snapshot. */
export interface ViewerColorBySettings {
    readonly value: string;
    readonly options: readonly ViewerColorByOption[];
}

/** Colormap section of a settings snapshot. */
export interface ViewerColormapSettings {
    readonly value: string;
    readonly options: readonly string[];
    /** True in Solid Color mode (there is no array to map). */
    readonly disabled: boolean;
    /** Map sampled in reverse (legend gradient honors it). */
    readonly invert: boolean;
    /** Log-scaled mapping; disabled when the effective range is not strictly positive. */
    readonly logScale: { readonly value: boolean; readonly disabled: boolean };
}

/** Scalar-bar (color legend) section of a settings snapshot. */
export interface ViewerScalarBarSettings {
    readonly visible: boolean;
}

/** Vector-component section (present only when the color-by array has multiple components). */
export interface ViewerComponentSettings {
    /** Selected component index; -1 is the L2 magnitude. */
    readonly value: number;
    readonly options: readonly ViewerComponentOption[];
}

export interface ViewerComponentOption {
    readonly value: number;
    readonly label: string;
}

/** Color-range section of a settings snapshot. */
export interface ViewerRangeSettings {
    readonly mode: 'auto' | 'custom';
    /** Effective range (data range in auto mode, the user range otherwise). */
    readonly min: number;
    readonly max: number;
    /** Data range of the active color-by array (Auto reset target). */
    readonly dataMin: number;
    readonly dataMax: number;
}

/** Hex color section (solid color, background) of a settings snapshot. */
export interface ViewerColorSettings {
    readonly value: string;
}

/** Shading section of a settings snapshot. */
export interface ViewerShadingSettings {
    readonly value: ViewerShadingMode;
}

/** Clip section of a settings snapshot (per-axis state plus the active tab). */
export interface ViewerClipSettings {
    readonly state: ClipPlanesState;
    readonly tab: ClipAxis;
}

/** Distance-measure section of a settings snapshot. */
export interface ViewerMeasureSettings {
    readonly active: boolean;
}

/** Tally-volume section (DAGMC drape interior); absent without a loaded tally volume. */
export interface ViewerTallyVolumeSettings {
    readonly visible: boolean;
    /** Smooth trilinear raycast instead of per-cell voxel boxes. */
    readonly smooth: boolean;
}

/** Generic slider section of a settings snapshot (opacity, point size, line width). */
export interface ViewerSliderSettings {
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

/** Opacity section of a settings snapshot. */
export type ViewerOpacitySettings = ViewerSliderSettings;

/** Time-step section of a settings snapshot (Exodus viewer). */
export interface ViewerStepSettings {
    readonly index: number;
    readonly count: number;
    readonly label: string;
}

/**
 * Everything the sidebar panel renders for one active viewer. Only the
 * sections the viewer supports are present; `hasDataset` is false before a
 * file loads (controls hide, the title still identifies the tab).
 */
export interface ViewerSettingsSnapshot {
    readonly widgetId: string;
    readonly title: string;
    readonly hasDataset: boolean;
    readonly colorBy?: ViewerColorBySettings;
    readonly colormap?: ViewerColormapSettings;
    readonly component?: ViewerComponentSettings;
    readonly range?: ViewerRangeSettings;
    readonly scalarBar?: ViewerScalarBarSettings;
    readonly tallyVolume?: ViewerTallyVolumeSettings;
    readonly solidColor?: ViewerColorSettings;
    readonly background?: ViewerColorSettings;
    readonly shading?: ViewerShadingSettings;
    readonly clip?: ViewerClipSettings;
    readonly measure?: ViewerMeasureSettings;
    readonly opacity?: ViewerOpacitySettings;
    readonly pointSize?: ViewerSliderSettings;
    readonly lineWidth?: ViewerSliderSettings;
    readonly step?: ViewerStepSettings;
}

/** Axis-snap button id. `top/front/right` match the nav cluster; `x/y/z` snap the +axes explicitly. */
export type ViewerSnapId = 'iso' | 'top' | 'front' | 'right' | 'x' | 'y' | 'z';

/**
 * One sidebar edit. Every field is optional; hosts apply the fields they
 * support and ignore the rest. `snap` drives the orbit handle's
 * `setViewDirection` (view-only, never stored).
 */
export interface ViewerSettingsPatch {
    readonly colorBy?: string;
    readonly colormap?: string;
    readonly component?: number;
    readonly range?: 'auto' | readonly [number, number];
    readonly invert?: boolean;
    readonly logScale?: boolean;
    readonly scalarBarVisible?: boolean;
    readonly tallyVolumeVisible?: boolean;
    readonly tallyVolumeSmooth?: boolean;
    readonly solidColor?: string;
    readonly background?: string;
    readonly shading?: ViewerShadingMode;
    readonly clip?: ClipPlanesState;
    readonly clipTab?: ClipAxis;
    readonly measureActive?: boolean;
    readonly opacity?: number;
    readonly pointSize?: number;
    readonly lineWidth?: number;
    readonly stepIndex?: number;
    readonly snap?: ViewerSnapId;
}

/** Structural surface a viewer widget exposes to the sidebar panel (bound once, not per viewer). */
export interface ViewerSettingsHost {
    /** Read the current settings; undefined when the widget cannot report any (never for open viewers). */
    getViewerSettingsSnapshot(): ViewerSettingsSnapshot | undefined;
    /** Apply a sidebar edit through the widget's existing setters. */
    applyViewerSettings(patch: ViewerSettingsPatch): void;
}

/**
 * Base widget ids bound to the settings panel. Subclass viewers
 * (tracks/collision/weight-windows/random-ray/tally/generic) keep their own
 * ids but inherit the native base, so every id is listed. Open instances
 * append `:<path>` to the base id (`setVtkFile`/`setVtmFile`/…).
 */
export const VIEWER_SETTINGS_WIDGET_IDS: readonly string[] = [
    'native-vtk-viewer-widget',
    'openmc-tracks-viewer-widget',
    'openmc-collision-track-viewer-widget',
    'openmc-weight-windows-viewer-widget',
    'openmc-random-ray-results-widget',
    'tally-native-viewer-widget',
    'dagmc-viewer-widget',
    'geometry-native-viewer-widget',
    'exodus-time-slider-widget',
    'nuke-visualizer.widget'
];

/** Whether a widget id belongs to a viewer bound to the settings panel (instance suffixes included). */
export function isViewerSettingsWidgetId(id: string): boolean {
    return VIEWER_SETTINGS_WIDGET_IDS.some((base) => id === base || id.startsWith(`${base}:`));
}

/**
 * Pick the widget id the panel binds to: the active tab wins, otherwise the
 * current tab, otherwise the fallback (the main area's current tab — this is
 * what lets the panel bind when it has just been opened and holds both active
 * and current itself), otherwise nothing (empty state). Non-viewer ids never
 * match.
 */
export function resolveViewerSettingsTargetId(
    activeId: string | undefined,
    currentId: string | undefined,
    fallbackId?: string | undefined
): string | undefined {
    if (activeId !== undefined && isViewerSettingsWidgetId(activeId)) {
        return activeId;
    }
    if (currentId !== undefined && isViewerSettingsWidgetId(currentId)) {
        return currentId;
    }
    if (fallbackId !== undefined && isViewerSettingsWidgetId(fallbackId)) {
        return fallbackId;
    }
    return undefined;
}

/** One axis-snap button: label plus the orbit-handle direction triple. */
export interface ViewerSnapAction {
    readonly id: ViewerSnapId;
    readonly label: string;
    readonly tooltip: string;
    readonly direction: BoundsCorner;
}

/**
 * Sidebar snap group. ISO/T/F/R mirror the canvas nav cluster through the
 * same standard directions; X/Y/Z snap the +axes explicitly (geometrically
 * identical to R/T/F — the labels exist for keyboard/screen-reader clarity,
 * not new views).
 */
export const VIEWER_SNAP_ACTIONS: readonly ViewerSnapAction[] = [
    { id: 'iso', label: 'ISO', tooltip: 'Isometric view', direction: [1, 1, 1] },
    { id: 'top', label: 'T', tooltip: 'Top view (+Y)', direction: [0, 1, 0] },
    { id: 'front', label: 'F', tooltip: 'Front view (+Z)', direction: [0, 0, 1] },
    { id: 'right', label: 'R', tooltip: 'Right view (+X)', direction: [1, 0, 0] },
    { id: 'x', label: 'X', tooltip: 'Snap to the +X axis', direction: [1, 0, 0] },
    { id: 'y', label: 'Y', tooltip: 'Snap to the +Y axis', direction: [0, 1, 0] },
    { id: 'z', label: 'Z', tooltip: 'Snap to the +Z axis', direction: [0, 0, 1] }
];

/** Orbit-handle direction triple for a snap button id. */
export function viewerSnapDirection(id: ViewerSnapId): BoundsCorner {
    const action = VIEWER_SNAP_ACTIONS.find((entry) => entry.id === id);
    return action ? action.direction : [1, 1, 1];
}
