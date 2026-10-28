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

import type { BivariateOptions, UncertaintyChannel } from '../viewer-core/bivariate-mapping';
import type { ClipAxis, ClipPlanesState } from '../viewer-core/clip-plane';
import type { BoundsCorner } from '../viewer-core/orbit-controls';
import type { ViewerShadingMode } from '../viewer-core/shading-mode';
import type { SliceAxis } from '../viewer-core/slice-view';
import type { OpacityStop, VolumeBlendMode } from '../viewer-core/volume-transfer';
import type { ViewerState } from '../viewer-core/viewer-state';
import type { WarpScaleMode } from '../viewer-core/warp-vectors';

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
    /** Legend title override; undefined shows the active array name. */
    readonly title?: string;
    /** Stack the min/max labels vertically instead of side by side. */
    readonly verticalLabels?: boolean;
}

/**
 * Bivariate (mean + relative statistical error) section of a settings
 * snapshot. Present only when the active color-by cell array has a
 * `-std`/`-rel-err` companion (or an explicit `<name>-rel-err`); viewers
 * without a pair hide the whole section instead of showing dead controls.
 * `enabled` is the master switch; the remaining fields are the shared
 * {@link BivariateOptions} the editor edits.
 */
export interface ViewerBivariateSettings {
    readonly enabled: boolean;
    readonly channel: UncertaintyChannel;
    readonly maxRelativeError: number;
    readonly lowQualityColor: string;
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

/** Dual-slider resolution for the custom range control (per-mille of the data span). */
export const RANGE_SLIDER_STEPS = 1000;

/**
 * Threshold (hide-cells-outside-a-range) section of a settings snapshot.
 * Present whenever a data array is the active color-by (parsed or a
 * transient derived field); absent in Solid Color mode (no array to test).
 * `min`/`max` is the effective window (the custom window, or the data
 * range before the user edits one); `dataMin`/`dataMax` is the reset
 * target. `visible`/`total` counts the active-array tuples inside the
 * window (non-finite tuples count as visible — the `nanColor` rule).
 */
export interface ViewerThresholdSettings {
    readonly enabled: boolean;
    readonly min: number;
    readonly max: number;
    readonly dataMin: number;
    readonly dataMax: number;
    readonly visible: number;
    readonly total: number;
}

/** Map a dual-slider thumb (0..RANGE_SLIDER_STEPS) onto the data span. Pure. */
export function rangeSliderToValue(thumb: number, dataMin: number, dataMax: number): number {
    const clamped = Math.min(RANGE_SLIDER_STEPS, Math.max(0, thumb));
    return dataMin + (clamped / RANGE_SLIDER_STEPS) * (dataMax - dataMin);
}

/** Map a range value onto a dual-slider thumb (0..RANGE_SLIDER_STEPS). Pure. */
export function rangeValueToSlider(value: number, dataMin: number, dataMax: number): number {
    if (!(dataMax > dataMin)) {
        return 0;
    }
    return Math.min(RANGE_SLIDER_STEPS, Math.max(0, Math.round(((value - dataMin) / (dataMax - dataMin)) * RANGE_SLIDER_STEPS)));
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
    /** Closed-cut caps; absent when the viewer does not support capping. */
    readonly caps?: boolean;
}

/** Distance-measure section of a settings snapshot. */
export interface ViewerMeasureSettings {
    readonly active: boolean;
}

/**
 * Comparison-workspace section of a settings snapshot. Present only while the
 * viewer participates in a comparison session; absent outside one so
 * the panel hides the whole section. `range` is the current union of the
 * panes' active-array data ranges (undefined until at least one pane reports
 * one).
 */
export interface ViewerComparisonSettings {
    readonly label: string;
    readonly linkCameras: boolean;
    readonly sharedRange: boolean;
    readonly showLabels: boolean;
    readonly range?: readonly [number, number];
}

/** Bounding-box axes/grid section. */
export interface ViewerAxesGridSettings {
    readonly visible: boolean;
}

/** Tally-volume section (DAGMC drape interior); absent without a loaded tally volume. */
export interface ViewerTallyVolumeSettings {
    readonly visible: boolean;
    /** Smooth trilinear raycast instead of per-cell voxel boxes. */
    readonly smooth: boolean;
}

/**
 * Volume section for any axis-aligned grid (`vti`/`vtr`/`vts`/tally mesh).
 * `opacityStops` is the editable transfer curve; `blendMode` chooses MIP or
 * front-to-back compositing; `shade` enables gradient headlight shading.
 * Absent when the dataset has no volume grid.
 */
export interface ViewerVolumeSettings {
    readonly visible: boolean;
    readonly smooth: boolean;
    readonly opacityStops: readonly OpacityStop[];
    readonly blendMode: VolumeBlendMode;
    readonly shade: boolean;
}

/** One 2D slice preview for the Slice section (RGBA, row-major). */
export interface ViewerSlicePreview {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8ClampedArray;
    readonly range: readonly [number, number];
}

/** Orthoslice section for axis-aligned grids; absent for non-grid datasets. */
export interface ViewerSliceSettings {
    readonly axis: SliceAxis;
    readonly fraction: number;
    readonly smooth: boolean;
}

/**
 * Warp-by-vector section (FEM magnified deformation); absent unless the
 * dataset carries a 3-component point array (nodal DISP today). The viewer
 * displaces its position buffers along the chosen array and recomputes mesh
 * normals; `effectiveScale` is the scale actually applied (`true` = 1,
 * `auto` = `autoScale`, `capped` = `scale` clamped to the slider maximum).
 */
export interface ViewerWarpSettings {
    readonly enabled: boolean;
    readonly array: string;
    readonly options: readonly ViewerColorByOption[];
    readonly scaleMode: WarpScaleMode;
    /** User exaggeration (slider/numeric value; live in `capped` mode). */
    readonly scale: number;
    /** Data-reset target: the 10%-of-size auto scale for the current array. */
    readonly autoScale: number;
    /** Effective scale applied to the position buffers (0 when warp is off). */
    readonly effectiveScale: number;
}

/** Generic slider section of a settings snapshot (opacity, point size, line width). */
export interface ViewerSliderSettings {
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

/**
 * Direction-glyph section (cone instancing along per-point vectors); absent
 * unless the dataset resolves glyph vectors (track polylines always do via
 * tangents; other viewers need a 3-component point array). `density` is the
 * fraction of candidate points carrying a cone, `scale` the size multiplier
 * over the auto cone height; `count`/`total` are live vs candidate cones
 * (decimated, zero-vector and threshold-hidden skipped).
 */
export interface ViewerGlyphSettings {
    readonly enabled: boolean;
    readonly density: number;
    readonly scale: number;
    readonly count: number;
    readonly total: number;
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
    /**
     * Optional short status note under the panel header for modes that
     * change how every control is interpreted (e.g. DAGMC `Color by
     * material`, `volume`, or `group`, where no scalar mapping applies).
     */
    readonly note?: string;
    readonly colorBy?: ViewerColorBySettings;
    readonly colormap?: ViewerColormapSettings;
    readonly component?: ViewerComponentSettings;
    readonly range?: ViewerRangeSettings;
    readonly threshold?: ViewerThresholdSettings;
    readonly scalarBar?: ViewerScalarBarSettings;
    readonly bivariate?: ViewerBivariateSettings;
    readonly tallyVolume?: ViewerTallyVolumeSettings;
    readonly volume?: ViewerVolumeSettings;
    readonly slice?: ViewerSliceSettings;
    readonly warp?: ViewerWarpSettings;
    readonly glyph?: ViewerGlyphSettings;
    readonly solidColor?: ViewerColorSettings;
    readonly background?: ViewerColorSettings;
    readonly shading?: ViewerShadingSettings;
    readonly clip?: ViewerClipSettings;
    readonly measure?: ViewerMeasureSettings;
    /** Comparison-workspace state; absent outside a comparison session. */
    readonly comparison?: ViewerComparisonSettings;
    readonly axesGrid?: ViewerAxesGridSettings;
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
    readonly thresholdEnabled?: boolean;
    /** Custom threshold window; `'data'` clears it back to the data range (Range `auto` parity). */
    readonly thresholdRange?: 'data' | readonly [number, number];
    readonly invert?: boolean;
    readonly logScale?: boolean;
    readonly scalarBarVisible?: boolean;
    /** Legend title override (empty string restores the array name). */
    readonly scalarBarTitle?: string;
    /** Stack the legend min/max labels vertically. */
    readonly scalarBarVertical?: boolean;
    /** Bivariate master switch (only meaningful with a mean/std/rel-err pair). */
    readonly bivariateEnabled?: boolean;
    /** Complete bivariate options (channel, threshold, mask color) after an editor edit. */
    readonly bivariate?: BivariateOptions;
    readonly tallyVolumeVisible?: boolean;
    readonly tallyVolumeSmooth?: boolean;
    readonly volumeVisible?: boolean;
    readonly volumeSmooth?: boolean;
    readonly volumeOpacityStops?: readonly OpacityStop[];
    readonly volumeBlendMode?: VolumeBlendMode;
    readonly volumeShade?: boolean;
    readonly sliceAxis?: SliceAxis;
    readonly sliceFraction?: number;
    readonly sliceSmooth?: boolean;
    readonly warpEnabled?: boolean;
    readonly warpArray?: string;
    readonly warpScaleMode?: WarpScaleMode;
    readonly warpScale?: number;
    readonly glyphEnabled?: boolean;
    /** Fraction of candidate points carrying a cone (slider range). */
    readonly glyphDensity?: number;
    /** Cone size multiplier over the auto height (slider range). */
    readonly glyphScale?: number;
    readonly solidColor?: string;
    readonly background?: string;
    readonly shading?: ViewerShadingMode;
    readonly clip?: ClipPlanesState;
    readonly clipTab?: ClipAxis;
    readonly clipCaps?: boolean;
    readonly measureActive?: boolean;
    /** Comparison workspace: link cameras across panes (per-pane opt-out). */
    readonly comparisonLinkCameras?: boolean;
    /** Comparison workspace: share the union of the panes' data ranges. */
    readonly comparisonSharedRange?: boolean;
    /** Comparison workspace: show the A/B/C pane badge. */
    readonly comparisonShowLabels?: boolean;
    /** Leave the comparison session (restores the captured link/range state). */
    readonly comparisonLeave?: boolean;
    readonly axesGridVisible?: boolean;
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
    /**
     * Render the current 2D orthoslice for the Slice section. Optional: only
     * axis-aligned grid viewers implement it; when absent the section stays
     * hidden. Pure data in, RGBA out — the panel owns the canvas.
     */
    getSlicePreview?(settings: ViewerSliceSettings): ViewerSlicePreview | undefined;
    /** Capture the complete state (including camera) for Save view. */
    getViewerState?(): ViewerState | undefined;
    /** Restore a previously captured state (settings + camera). */
    applyViewerState?(state: ViewerState): void;
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
