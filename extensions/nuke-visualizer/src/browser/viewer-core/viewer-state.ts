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
 * Versioned viewer-state schema for the native 3D viewers.
 *
 * One pure, JSON-safe description of everything a `Save view` / `Restore
 * view` pair needs: the orbit camera, the scalar mapping, display sizes,
 * clip planes, threshold, warp, glyphs, volume transfer, orthoslice, legend,
 * and the axes-grid flag. Transient UI state is deliberately absent:
 * measurements, active color-by options, derived ranges/effective scales,
 * selection, sidebar tabs, and file contents never round-trip.
 *
 * Contract:
 *
 * - `serializeViewerState` writes canonical JSON with a fixed key order and a
 *   `version` stamp.
 * - `parseViewerState` is total: malformed JSON, unknown fields, invalid
 *   values, and unknown (future) versions return `undefined`, never throw.
 *   Missing sections fall back to their defaults.
 * - `VIEWER_STATE_VERSION` is the only version accepted by
 *   {@link normalizeViewerState}; older versions upgrade through the
 *   {@link ViewerStateMigration} chain supplied to {@link parseViewerState}.
 *
 * Pure types + functions only; no three.js, no DOM, no Theia imports.
 */

import type { ViewerSettingsPatch, ViewerSettingsSnapshot } from '../viewer-settings/viewer-settings-model';
import { CLIP_AXES, DEFAULT_AXIS_CLIP_STATE, DEFAULT_CLIP_PLANES_STATE, type AxisClipState, type ClipPlanesState } from './clip-plane';
import { DEFAULT_GLYPH_DENSITY, DEFAULT_GLYPH_SCALE, GLYPH_DENSITY_SPEC, GLYPH_SCALE_SPEC } from './glyph-layout';
import { MAGNITUDE_COMPONENT, type ColorRangeMode } from './scalar-mapping';
import { DEFAULT_VIEWER_SHADING_MODE, VIEWER_SHADING_MODES, type ViewerShadingMode } from './shading-mode';
import { SLICE_AXES, type SliceAxis } from './slice-view';
import { DEFAULT_VIEWER_TOOLBAR_STATE, LINE_WIDTH_SPEC, OPACITY_SPEC, POINT_SIZE_SPEC, SOLID_COLOR } from './viewer-toolbar-model';
import {
    DEFAULT_OPACITY_STOPS,
    DEFAULT_VOLUME_TRANSFER,
    MAX_OPACITY_STOPS,
    normalizeOpacityStops,
    type OpacityStop,
    type VolumeBlendMode
} from './volume-transfer';
import { DEFAULT_WARP_SCALE_MODE, WARP_EXAGGERATION_SPEC, WARP_SCALE_MODES, type WarpScaleMode } from './warp-vectors';

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

/** One world-space point as an xyz tuple (camera pose components). */
export type ViewerStateVector = readonly [number, number, number];

/** Orbit-camera pose: perspective position plus the orbit target, up, and projection. */
export interface ViewerCameraState {
    readonly position: ViewerStateVector;
    readonly target: ViewerStateVector;
    readonly up: ViewerStateVector;
    readonly orthographic: boolean;
}

/**
 * Scalar mapping: color-by selection, colormap, component, range, invert/log,
 * and the solid/background colors. `range` is present only in `custom` mode.
 */
export interface ViewerMappingState {
    /** Color-by value (`Solid Color`, `Point: <array>`, `Cell: <array>`, or a categorical key). */
    readonly colorBy: string;
    readonly colormap: string;
    /** Component index, or {@link MAGNITUDE_COMPONENT} for the L2 magnitude. */
    readonly component: number;
    readonly rangeMode: ColorRangeMode;
    /** Custom range endpoints (normalized ascending); absent in `auto` mode. */
    readonly range?: readonly [number, number];
    readonly invert: boolean;
    readonly logScale: boolean;
    /** Solid fill color; absent when the viewer never offered one. */
    readonly solidColor?: string;
    /** Canvas background; absent when the viewer follows the theme. */
    readonly background?: string;
}

/** Per-axis clip planes plus the closed-cap flag. The sidebar's active tab is transient. */
export interface ViewerClipState {
    readonly planes: ClipPlanesState;
    readonly caps: boolean;
}

/** Hide-cells-outside-a-range filter; an absent range follows the data range. */
export interface ViewerThresholdState {
    readonly enabled: boolean;
    readonly range?: readonly [number, number];
}

/** Warp-by-vector state (the array pick is stored; derived auto/effective scales are not). */
export interface ViewerWarpState {
    readonly enabled: boolean;
    /** Point-array name; empty when no vector array is selected. */
    readonly array: string;
    readonly scaleMode: WarpScaleMode;
    readonly scale: number;
}

/** Direction-glyph state (density fraction and size multiplier). */
export interface ViewerGlyphState {
    readonly enabled: boolean;
    readonly density: number;
    readonly scale: number;
}

/** Volume transfer state for axis-aligned grids. */
export interface ViewerVolumeState {
    readonly visible: boolean;
    readonly smooth: boolean;
    readonly opacityStops: readonly OpacityStop[];
    readonly blendMode: VolumeBlendMode;
    readonly shade: boolean;
}

/** Orthoslice state for axis-aligned grids. */
export interface ViewerSliceState {
    readonly axis: SliceAxis;
    readonly fraction: number;
    readonly smooth: boolean;
}

/** Color-legend visibility. */
export interface ViewerLegendState {
    readonly visible: boolean;
}

/** Axes/grid overlay visibility. */
export interface ViewerAxesGridState {
    readonly visible: boolean;
}

/** The only schema version this build writes and accepts directly. */
export type ViewerStateVersion = 1;

/** Current schema version written by {@link serializeViewerState}. */
export const VIEWER_STATE_VERSION: ViewerStateVersion = 1;

/** Complete, self-contained viewer state (no file contents, no derived values). */
export interface ViewerState {
    readonly version: ViewerStateVersion;
    readonly camera: ViewerCameraState;
    readonly mapping: ViewerMappingState;
    readonly shading: ViewerShadingMode;
    readonly opacity: number;
    readonly pointSize: number;
    readonly lineWidth: number;
    readonly clip: ViewerClipState;
    readonly threshold: ViewerThresholdState;
    readonly warp: ViewerWarpState;
    readonly glyph: ViewerGlyphState;
    readonly volume: ViewerVolumeState;
    readonly slice: ViewerSliceState;
    readonly legend: ViewerLegendState;
    readonly axesGrid: ViewerAxesGridState;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Camera default: three.js' up, an isometric direction, perspective, origin target. */
export const DEFAULT_VIEWER_CAMERA_STATE: ViewerCameraState = {
    position: [1, 1, 1],
    target: [0, 0, 0],
    up: [0, 1, 0],
    orthographic: false
};

/** Mapping default: solid color, the trame-default colormap, auto range, linear/non-inverted. */
export const DEFAULT_VIEWER_MAPPING_STATE: ViewerMappingState = {
    colorBy: SOLID_COLOR,
    colormap: DEFAULT_VIEWER_TOOLBAR_STATE.colormap,
    component: MAGNITUDE_COMPONENT,
    rangeMode: 'auto',
    invert: false,
    logScale: false
};

/** Clip default: every plane through its middle and disabled, caps on. */
export const DEFAULT_VIEWER_CLIP_STATE: ViewerClipState = {
    planes: DEFAULT_CLIP_PLANES_STATE,
    caps: true
};

/** Threshold default: disabled, following the data range. */
export const DEFAULT_VIEWER_THRESHOLD_STATE: ViewerThresholdState = {
    enabled: false
};

/** Warp default: disabled, no array, auto scale, x1 exaggeration. */
export const DEFAULT_VIEWER_WARP_STATE: ViewerWarpState = {
    enabled: false,
    array: '',
    scaleMode: DEFAULT_WARP_SCALE_MODE,
    scale: 1
};

/** Glyph default: disabled, 10% density, x1 cone size. */
export const DEFAULT_VIEWER_GLYPH_STATE: ViewerGlyphState = {
    enabled: false,
    density: DEFAULT_GLYPH_DENSITY,
    scale: DEFAULT_GLYPH_SCALE
};

/** Volume default: hidden, per-cell boxes, identity ramp, MIP, no gradient shade. */
export const DEFAULT_VIEWER_VOLUME_STATE: ViewerVolumeState = {
    visible: false,
    smooth: false,
    opacityStops: DEFAULT_VOLUME_TRANSFER.opacityStops,
    blendMode: DEFAULT_VOLUME_TRANSFER.blendMode,
    shade: DEFAULT_VOLUME_TRANSFER.shade
};

/** Slice default: Z through the middle, nearest sampling. */
export const DEFAULT_VIEWER_SLICE_STATE: ViewerSliceState = {
    axis: 'Z',
    fraction: 0.5,
    smooth: false
};

/** Legend default: visible (the native viewer shows the scalar bar once an array is mapped). */
export const DEFAULT_VIEWER_LEGEND_STATE: ViewerLegendState = {
    visible: true
};

/** Axes-grid default: hidden. */
export const DEFAULT_VIEWER_AXES_GRID_STATE: ViewerAxesGridState = {
    visible: false
};

/** Fresh-state defaults for every section (matches the widget factories). */
export const DEFAULT_VIEWER_STATE: ViewerState = {
    version: VIEWER_STATE_VERSION,
    camera: DEFAULT_VIEWER_CAMERA_STATE,
    mapping: DEFAULT_VIEWER_MAPPING_STATE,
    shading: DEFAULT_VIEWER_SHADING_MODE,
    opacity: OPACITY_SPEC.defaultValue,
    pointSize: POINT_SIZE_SPEC.defaultValue,
    lineWidth: LINE_WIDTH_SPEC.defaultValue,
    clip: DEFAULT_VIEWER_CLIP_STATE,
    threshold: DEFAULT_VIEWER_THRESHOLD_STATE,
    warp: DEFAULT_VIEWER_WARP_STATE,
    glyph: DEFAULT_VIEWER_GLYPH_STATE,
    volume: DEFAULT_VIEWER_VOLUME_STATE,
    slice: DEFAULT_VIEWER_SLICE_STATE,
    legend: DEFAULT_VIEWER_LEGEND_STATE,
    axesGrid: DEFAULT_VIEWER_AXES_GRID_STATE
};

// ---------------------------------------------------------------------------
// Migration hooks
// ---------------------------------------------------------------------------

/**
 * Upgrade one raw version-`N` object to version `N + 1`. Return `undefined`
 * to reject the input (the parse then fails cleanly). Hooks are pure and may
 * drop fields that the current schema no longer has.
 */
export type ViewerStateMigration = (state: Readonly<Record<string, unknown>>) => Record<string, unknown> | undefined;

/** Optional parse settings: the migration chain to upgrade older payloads. */
export interface ViewerStateParseOptions {
    /** Hooks keyed by the version they consume; the default chain is empty (only v1 exists). */
    readonly migrations?: Readonly<Partial<Record<number, ViewerStateMigration>>>;
}

/** Default migration chain: no legacy versions exist yet. */
export const VIEWER_STATE_MIGRATIONS: Readonly<Partial<Record<number, ViewerStateMigration>>> = Object.freeze({});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

const VIEWER_STATE_KEYS = [
    'version',
    'camera',
    'mapping',
    'shading',
    'opacity',
    'pointSize',
    'lineWidth',
    'clip',
    'threshold',
    'warp',
    'glyph',
    'volume',
    'slice',
    'legend',
    'axesGrid'
] as const;

const CAMERA_KEYS = ['position', 'target', 'up', 'orthographic'] as const;
const MAPPING_KEYS = ['colorBy', 'colormap', 'component', 'rangeMode', 'range', 'invert', 'logScale', 'solidColor', 'background'] as const;
const CLIP_KEYS = ['planes', 'caps'] as const;
const AXIS_CLIP_KEYS = ['enabled', 'fraction', 'invert'] as const;
const THRESHOLD_KEYS = ['enabled', 'range'] as const;
const WARP_KEYS = ['enabled', 'array', 'scaleMode', 'scale'] as const;
const GLYPH_KEYS = ['enabled', 'density', 'scale'] as const;
const VOLUME_KEYS = ['visible', 'smooth', 'opacityStops', 'blendMode', 'shade'] as const;
const OPACITY_STOP_KEYS = ['t', 'alpha'] as const;
const SLICE_KEYS = ['axis', 'fraction', 'smooth'] as const;
const LEGEND_KEYS = ['visible'] as const;
const AXES_GRID_KEYS = ['visible'] as const;

const COLOR_RANGE_MODES: readonly ColorRangeMode[] = ['auto', 'custom'];
const VOLUME_BLEND_MODES: readonly VolumeBlendMode[] = ['mip', 'composite'];
const SHADING_MODE_IDS: readonly ViewerShadingMode[] = VIEWER_SHADING_MODES.map((entry) => entry.id);
const WARP_SCALE_MODE_IDS: readonly WarpScaleMode[] = WARP_SCALE_MODES.map((entry) => entry.id);

/** Component selectors above the VTK tensor ceiling are invalid. */
const MAX_MAPPING_COMPONENT = 63;

/** Guard against pathological payloads (array names and colors are short). */
const MAX_STATE_STRING_LENGTH = 1024;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: JsonRecord, allowed: readonly string[]): boolean {
    return Object.keys(record).every((key) => allowed.includes(key));
}

/** Accept a plain object only when every own key is part of the section. */
function readSection(value: unknown, allowed: readonly string[]): JsonRecord | undefined {
    return isRecord(value) && hasOnlyKeys(value, allowed) ? value : undefined;
}

/** Read a finite number within `[min, max]`; negative zero normalizes to zero. */
function readFinite(value: unknown, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        return undefined;
    }
    return value === 0 ? 0 : value;
}

function readVector(value: unknown): ViewerStateVector | undefined {
    if (!Array.isArray(value) || value.length !== 3) {
        return undefined;
    }
    const x = readFinite(value[0]);
    const y = readFinite(value[1]);
    const z = readFinite(value[2]);
    return x === undefined || y === undefined || z === undefined ? undefined : [x, y, z];
}

function readRange(value: unknown): readonly [number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 2) {
        return undefined;
    }
    const first = readFinite(value[0]);
    const second = readFinite(value[1]);
    if (first === undefined || second === undefined) {
        return undefined;
    }
    return first <= second ? [first, second] : [second, first];
}

function vectorLengthSq(vector: ViewerStateVector): number {
    return vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2];
}

function vectorsEqual(a: ViewerStateVector, b: ViewerStateVector): boolean {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

interface StringFieldOptions {
    readonly allowEmpty?: boolean;
}

/**
 * Field reader that accumulates invalidity: a present field with the wrong
 * type/range records a failure and returns the fallback, so every section
 * can read all fields before discarding the whole payload.
 */
class StateFields {
    private failed = false;

    get valid(): boolean {
        return !this.failed;
    }

    private reject<T>(fallback: T): T {
        this.failed = true;
        return fallback;
    }

    boolean(record: JsonRecord, key: string, fallback: boolean): boolean {
        const value = record[key];
        if (value === undefined) {
            return fallback;
        }
        return typeof value === 'boolean' ? value : this.reject(fallback);
    }

    number(record: JsonRecord, key: string, fallback: number, min?: number, max?: number): number {
        const value = record[key];
        if (value === undefined) {
            return fallback;
        }
        return readFinite(value, min, max) ?? this.reject(fallback);
    }

    requiredNumber(record: JsonRecord, key: string, min?: number, max?: number): number {
        return readFinite(record[key], min, max) ?? this.reject(0);
    }

    integer(record: JsonRecord, key: string, fallback: number, min: number, max: number): number {
        const value = record[key];
        if (value === undefined) {
            return fallback;
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value) || value < min || value > max) {
            return this.reject(fallback);
        }
        return value === 0 ? 0 : value;
    }

    string(record: JsonRecord, key: string, fallback: string, options: StringFieldOptions = {}): string {
        const value = record[key];
        if (value === undefined) {
            return fallback;
        }
        if (typeof value !== 'string' || value.length > MAX_STATE_STRING_LENGTH || (!options.allowEmpty && value.length === 0)) {
            return this.reject(fallback);
        }
        return value;
    }

    optionalString(record: JsonRecord, key: string): string | undefined {
        return record[key] === undefined ? undefined : this.string(record, key, '');
    }

    enumValue<T extends string>(record: JsonRecord, key: string, fallback: T, allowed: readonly T[]): T {
        const value = record[key];
        if (value === undefined) {
            return fallback;
        }
        if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
            return this.reject(fallback);
        }
        return value as T;
    }

    vector(record: JsonRecord, key: string, fallback: ViewerStateVector): ViewerStateVector {
        const value = record[key];
        if (value === undefined) {
            return copyVector(fallback);
        }
        return readVector(value) ?? this.reject(copyVector(fallback));
    }

    range(record: JsonRecord, key: string): readonly [number, number] | undefined {
        const value = record[key];
        if (value === undefined) {
            return undefined;
        }
        return readRange(value) ?? this.reject(undefined);
    }
}

// ---------------------------------------------------------------------------
// Section normalization (defaults for absent sections, strict for present ones)
// ---------------------------------------------------------------------------

function copyVector(vector: ViewerStateVector): ViewerStateVector {
    return [vector[0], vector[1], vector[2]];
}

function copyCamera(camera: ViewerCameraState): ViewerCameraState {
    return {
        position: copyVector(camera.position),
        target: copyVector(camera.target),
        up: copyVector(camera.up),
        orthographic: camera.orthographic
    };
}

function copyAxisClip(axis: AxisClipState): AxisClipState {
    return { enabled: axis.enabled, fraction: axis.fraction, invert: axis.invert };
}

function copyClipPlanes(planes: ClipPlanesState): ClipPlanesState {
    return { X: copyAxisClip(planes.X), Y: copyAxisClip(planes.Y), Z: copyAxisClip(planes.Z) };
}

function copyClipState(clip: ViewerClipState): ViewerClipState {
    return { planes: copyClipPlanes(clip.planes), caps: clip.caps };
}

function copyOpacityStops(stops: readonly OpacityStop[]): OpacityStop[] {
    return stops.map((stop) => ({ t: stop.t, alpha: stop.alpha }));
}

function copyWarp(warp: ViewerWarpState): ViewerWarpState {
    return { enabled: warp.enabled, array: warp.array, scaleMode: warp.scaleMode, scale: warp.scale };
}

function copyVolume(volume: ViewerVolumeState): ViewerVolumeState {
    return {
        visible: volume.visible,
        smooth: volume.smooth,
        opacityStops: copyOpacityStops(volume.opacityStops),
        blendMode: volume.blendMode,
        shade: volume.shade
    };
}

function copySlice(slice: ViewerSliceState): ViewerSliceState {
    return { axis: slice.axis, fraction: slice.fraction, smooth: slice.smooth };
}

function normalizeCamera(value: unknown): ViewerCameraState | undefined {
    if (value === undefined) {
        return copyCamera(DEFAULT_VIEWER_CAMERA_STATE);
    }
    const record = readSection(value, CAMERA_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const camera: ViewerCameraState = {
        position: fields.vector(record, 'position', DEFAULT_VIEWER_CAMERA_STATE.position),
        target: fields.vector(record, 'target', DEFAULT_VIEWER_CAMERA_STATE.target),
        up: fields.vector(record, 'up', DEFAULT_VIEWER_CAMERA_STATE.up),
        orthographic: fields.boolean(record, 'orthographic', DEFAULT_VIEWER_CAMERA_STATE.orthographic)
    };
    if (!fields.valid) {
        return undefined;
    }
    // Degenerate poses cannot be restored by the orbit controls.
    if (vectorLengthSq(camera.up) === 0 || vectorsEqual(camera.position, camera.target)) {
        return undefined;
    }
    return camera;
}

function normalizeMapping(value: unknown): ViewerMappingState | undefined {
    if (value === undefined) {
        return { ...DEFAULT_VIEWER_MAPPING_STATE };
    }
    const record = readSection(value, MAPPING_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const colorBy = fields.string(record, 'colorBy', DEFAULT_VIEWER_MAPPING_STATE.colorBy);
    const colormap = fields.string(record, 'colormap', DEFAULT_VIEWER_MAPPING_STATE.colormap);
    const component = fields.integer(
        record,
        'component',
        DEFAULT_VIEWER_MAPPING_STATE.component,
        MAGNITUDE_COMPONENT,
        MAX_MAPPING_COMPONENT
    );
    const rangeMode = fields.enumValue(record, 'rangeMode', DEFAULT_VIEWER_MAPPING_STATE.rangeMode, COLOR_RANGE_MODES);
    const range = fields.range(record, 'range');
    const invert = fields.boolean(record, 'invert', DEFAULT_VIEWER_MAPPING_STATE.invert);
    const logScale = fields.boolean(record, 'logScale', DEFAULT_VIEWER_MAPPING_STATE.logScale);
    const solidColor = fields.optionalString(record, 'solidColor');
    const background = fields.optionalString(record, 'background');
    if (!fields.valid) {
        return undefined;
    }
    // `range` belongs to custom mode only, and custom mode needs one.
    if (rangeMode === 'custom' ? range === undefined : record['range'] !== undefined) {
        return undefined;
    }
    return {
        colorBy,
        colormap,
        component,
        rangeMode,
        ...(range ? { range } : {}),
        invert,
        logScale,
        ...(solidColor !== undefined ? { solidColor } : {}),
        ...(background !== undefined ? { background } : {})
    };
}

function normalizeAxisClip(value: unknown): AxisClipState | undefined {
    const record = readSection(value, AXIS_CLIP_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const axis: AxisClipState = {
        enabled: fields.boolean(record, 'enabled', DEFAULT_AXIS_CLIP_STATE.enabled),
        fraction: fields.number(record, 'fraction', DEFAULT_AXIS_CLIP_STATE.fraction, 0, 1),
        invert: fields.boolean(record, 'invert', DEFAULT_AXIS_CLIP_STATE.invert)
    };
    return fields.valid ? axis : undefined;
}

function normalizeClipPlanes(value: unknown): ClipPlanesState | undefined {
    if (value === undefined) {
        return copyClipPlanes(DEFAULT_CLIP_PLANES_STATE);
    }
    const record = readSection(value, CLIP_AXES);
    if (!record) {
        return undefined;
    }
    const X = normalizeAxisClip(record['X']);
    const Y = normalizeAxisClip(record['Y']);
    const Z = normalizeAxisClip(record['Z']);
    return X && Y && Z ? { X, Y, Z } : undefined;
}

function normalizeClip(value: unknown): ViewerClipState | undefined {
    if (value === undefined) {
        return copyClipState(DEFAULT_VIEWER_CLIP_STATE);
    }
    const record = readSection(value, CLIP_KEYS);
    if (!record) {
        return undefined;
    }
    const planes = normalizeClipPlanes(record['planes']);
    if (!planes) {
        return undefined;
    }
    const fields = new StateFields();
    const caps = fields.boolean(record, 'caps', DEFAULT_VIEWER_CLIP_STATE.caps);
    return fields.valid ? { planes, caps } : undefined;
}

function normalizeThreshold(value: unknown): ViewerThresholdState | undefined {
    if (value === undefined) {
        return { ...DEFAULT_VIEWER_THRESHOLD_STATE };
    }
    const record = readSection(value, THRESHOLD_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const enabled = fields.boolean(record, 'enabled', DEFAULT_VIEWER_THRESHOLD_STATE.enabled);
    const range = fields.range(record, 'range');
    if (!fields.valid) {
        return undefined;
    }
    return { enabled, ...(range ? { range } : {}) };
}

function normalizeWarp(value: unknown): ViewerWarpState | undefined {
    if (value === undefined) {
        return copyWarp(DEFAULT_VIEWER_WARP_STATE);
    }
    const record = readSection(value, WARP_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const enabled = fields.boolean(record, 'enabled', DEFAULT_VIEWER_WARP_STATE.enabled);
    const array = fields.string(record, 'array', DEFAULT_VIEWER_WARP_STATE.array, { allowEmpty: true });
    const scaleMode = fields.enumValue(record, 'scaleMode', DEFAULT_VIEWER_WARP_STATE.scaleMode, WARP_SCALE_MODE_IDS);
    const scale = fields.number(record, 'scale', DEFAULT_VIEWER_WARP_STATE.scale, WARP_EXAGGERATION_SPEC.min, WARP_EXAGGERATION_SPEC.max);
    if (!fields.valid || (enabled && array.length === 0)) {
        return undefined;
    }
    return { enabled, array, scaleMode, scale };
}

function normalizeGlyph(value: unknown): ViewerGlyphState | undefined {
    if (value === undefined) {
        return { ...DEFAULT_VIEWER_GLYPH_STATE };
    }
    const record = readSection(value, GLYPH_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const enabled = fields.boolean(record, 'enabled', DEFAULT_VIEWER_GLYPH_STATE.enabled);
    const density = fields.number(record, 'density', DEFAULT_VIEWER_GLYPH_STATE.density, GLYPH_DENSITY_SPEC.min, GLYPH_DENSITY_SPEC.max);
    const scale = fields.number(record, 'scale', DEFAULT_VIEWER_GLYPH_STATE.scale, GLYPH_SCALE_SPEC.min, GLYPH_SCALE_SPEC.max);
    return fields.valid ? { enabled, density, scale } : undefined;
}

function readOpacityStops(value: unknown): readonly OpacityStop[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPACITY_STOPS) {
        return undefined;
    }
    const fields = new StateFields();
    const stops: OpacityStop[] = [];
    for (const entry of value) {
        const record = readSection(entry, OPACITY_STOP_KEYS);
        if (!record) {
            return undefined;
        }
        const t = fields.requiredNumber(record, 't', 0, 1);
        const alpha = fields.requiredNumber(record, 'alpha', 0, 1);
        stops.push({ t, alpha });
    }
    if (!fields.valid) {
        return undefined;
    }
    // Canonical order: ascending t, duplicates collapse to the later stop.
    return normalizeOpacityStops(stops);
}

function normalizeVolume(value: unknown): ViewerVolumeState | undefined {
    if (value === undefined) {
        return copyVolume(DEFAULT_VIEWER_VOLUME_STATE);
    }
    const record = readSection(value, VOLUME_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const visible = fields.boolean(record, 'visible', DEFAULT_VIEWER_VOLUME_STATE.visible);
    const smooth = fields.boolean(record, 'smooth', DEFAULT_VIEWER_VOLUME_STATE.smooth);
    const opacityStops =
        record['opacityStops'] === undefined ? copyOpacityStops(DEFAULT_OPACITY_STOPS) : readOpacityStops(record['opacityStops']);
    const blendMode = fields.enumValue(record, 'blendMode', DEFAULT_VIEWER_VOLUME_STATE.blendMode, VOLUME_BLEND_MODES);
    const shade = fields.boolean(record, 'shade', DEFAULT_VIEWER_VOLUME_STATE.shade);
    if (!opacityStops || !fields.valid) {
        return undefined;
    }
    return { visible, smooth, opacityStops, blendMode, shade };
}

function normalizeSlice(value: unknown): ViewerSliceState | undefined {
    if (value === undefined) {
        return copySlice(DEFAULT_VIEWER_SLICE_STATE);
    }
    const record = readSection(value, SLICE_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const axis = fields.enumValue(record, 'axis', DEFAULT_VIEWER_SLICE_STATE.axis, SLICE_AXES);
    const fraction = fields.number(record, 'fraction', DEFAULT_VIEWER_SLICE_STATE.fraction, 0, 1);
    const smooth = fields.boolean(record, 'smooth', DEFAULT_VIEWER_SLICE_STATE.smooth);
    return fields.valid ? { axis, fraction, smooth } : undefined;
}

function normalizeLegend(value: unknown): ViewerLegendState | undefined {
    if (value === undefined) {
        return { ...DEFAULT_VIEWER_LEGEND_STATE };
    }
    const record = readSection(value, LEGEND_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const visible = fields.boolean(record, 'visible', DEFAULT_VIEWER_LEGEND_STATE.visible);
    return fields.valid ? { visible } : undefined;
}

function normalizeAxesGrid(value: unknown): ViewerAxesGridState | undefined {
    if (value === undefined) {
        return { ...DEFAULT_VIEWER_AXES_GRID_STATE };
    }
    const record = readSection(value, AXES_GRID_KEYS);
    if (!record) {
        return undefined;
    }
    const fields = new StateFields();
    const visible = fields.boolean(record, 'visible', DEFAULT_VIEWER_AXES_GRID_STATE.visible);
    return fields.valid ? { visible } : undefined;
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

/**
 * Upgrade a raw viewer-state object to {@link VIEWER_STATE_VERSION}.
 *
 * Unknown future versions are rejected outright (a newer build's files are
 * never down-converted). Older versions need a registered migration per
 * version step; a missing or misbehaving hook rejects the payload. Never
 * throws, even when a caller-supplied hook does.
 */
export function migrateViewerState(
    raw: unknown,
    migrations: Readonly<Partial<Record<number, ViewerStateMigration>>> = VIEWER_STATE_MIGRATIONS
): Record<string, unknown> | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    const version = raw['version'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > VIEWER_STATE_VERSION) {
        return undefined;
    }
    let current = raw;
    for (let from = version; from < VIEWER_STATE_VERSION; from++) {
        const migration = migrations[from];
        if (!migration) {
            return undefined;
        }
        let next: Record<string, unknown> | undefined;
        try {
            next = migration(current);
        } catch {
            return undefined;
        }
        if (!isRecord(next) || next['version'] !== from + 1) {
            return undefined;
        }
        current = next;
    }
    return current;
}

/**
 * Strictly validate an already-parsed value against the current schema.
 * Missing sections default; unknown keys, wrong types, non-finite numbers,
 * and out-of-range values reject the whole state. Does not run migrations.
 */
export function normalizeViewerState(value: unknown): ViewerState | undefined {
    const record = readSection(value, VIEWER_STATE_KEYS);
    if (!record || record['version'] !== VIEWER_STATE_VERSION) {
        return undefined;
    }
    const camera = normalizeCamera(record['camera']);
    const mapping = normalizeMapping(record['mapping']);
    const clip = normalizeClip(record['clip']);
    const threshold = normalizeThreshold(record['threshold']);
    const warp = normalizeWarp(record['warp']);
    const glyph = normalizeGlyph(record['glyph']);
    const volume = normalizeVolume(record['volume']);
    const slice = normalizeSlice(record['slice']);
    const legend = normalizeLegend(record['legend']);
    const axesGrid = normalizeAxesGrid(record['axesGrid']);
    if (!camera || !mapping || !clip || !threshold || !warp || !glyph || !volume || !slice || !legend || !axesGrid) {
        return undefined;
    }
    const fields = new StateFields();
    const shading = fields.enumValue(record, 'shading', DEFAULT_VIEWER_SHADING_MODE, SHADING_MODE_IDS);
    const opacity = fields.number(record, 'opacity', OPACITY_SPEC.defaultValue, OPACITY_SPEC.min, OPACITY_SPEC.max);
    const pointSize = fields.number(record, 'pointSize', POINT_SIZE_SPEC.defaultValue, POINT_SIZE_SPEC.min, POINT_SIZE_SPEC.max);
    const lineWidth = fields.number(record, 'lineWidth', LINE_WIDTH_SPEC.defaultValue, LINE_WIDTH_SPEC.min, LINE_WIDTH_SPEC.max);
    if (!fields.valid) {
        return undefined;
    }
    return {
        version: VIEWER_STATE_VERSION,
        camera,
        mapping,
        shading,
        opacity,
        pointSize,
        lineWidth,
        clip,
        threshold,
        warp,
        glyph,
        volume,
        slice,
        legend,
        axesGrid
    };
}

/**
 * Serialize to canonical JSON: fixed key order (schema order), version stamp,
 * ascending ranges, sorted opacity stops, and no `undefined`/non-finite
 * values. Throws only when handed a state that violates the schema (a
 * programmer error); parsed payloads are always safe to re-serialize.
 */
export function serializeViewerState(state: ViewerState): string {
    const normalized = normalizeViewerState(state);
    if (!normalized) {
        throw new TypeError('serializeViewerState: invalid viewer state');
    }
    return JSON.stringify(toSerializableState(normalized));
}

function toSerializableState(state: ViewerState): Record<string, unknown> {
    const range = state.mapping.range;
    const thresholdRange = state.threshold.range;
    return {
        version: state.version,
        camera: {
            position: [...state.camera.position],
            target: [...state.camera.target],
            up: [...state.camera.up],
            orthographic: state.camera.orthographic
        },
        mapping: {
            colorBy: state.mapping.colorBy,
            colormap: state.mapping.colormap,
            component: state.mapping.component,
            rangeMode: state.mapping.rangeMode,
            ...(range ? { range: [...range] } : {}),
            invert: state.mapping.invert,
            logScale: state.mapping.logScale,
            ...(state.mapping.solidColor !== undefined ? { solidColor: state.mapping.solidColor } : {}),
            ...(state.mapping.background !== undefined ? { background: state.mapping.background } : {})
        },
        shading: state.shading,
        opacity: state.opacity,
        pointSize: state.pointSize,
        lineWidth: state.lineWidth,
        clip: {
            planes: {
                X: { enabled: state.clip.planes.X.enabled, fraction: state.clip.planes.X.fraction, invert: state.clip.planes.X.invert },
                Y: { enabled: state.clip.planes.Y.enabled, fraction: state.clip.planes.Y.fraction, invert: state.clip.planes.Y.invert },
                Z: { enabled: state.clip.planes.Z.enabled, fraction: state.clip.planes.Z.fraction, invert: state.clip.planes.Z.invert }
            },
            caps: state.clip.caps
        },
        threshold: {
            enabled: state.threshold.enabled,
            ...(thresholdRange ? { range: [...thresholdRange] } : {})
        },
        warp: {
            enabled: state.warp.enabled,
            array: state.warp.array,
            scaleMode: state.warp.scaleMode,
            scale: state.warp.scale
        },
        glyph: {
            enabled: state.glyph.enabled,
            density: state.glyph.density,
            scale: state.glyph.scale
        },
        volume: {
            visible: state.volume.visible,
            smooth: state.volume.smooth,
            opacityStops: state.volume.opacityStops.map((stop) => ({ t: stop.t, alpha: stop.alpha })),
            blendMode: state.volume.blendMode,
            shade: state.volume.shade
        },
        slice: {
            axis: state.slice.axis,
            fraction: state.slice.fraction,
            smooth: state.slice.smooth
        },
        legend: { visible: state.legend.visible },
        axesGrid: { visible: state.axesGrid.visible }
    };
}

/**
 * Parse a serialized viewer state. Total by contract: malformed JSON,
 * non-object payloads, unknown versions, unknown fields, invalid types,
 * non-finite numbers, and out-of-range values all return `undefined`.
 */
export function parseViewerState(text: string, options: ViewerStateParseOptions = {}): ViewerState | undefined {
    if (typeof text !== 'string' || text.length === 0) {
        return undefined;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return undefined;
    }
    try {
        const migrated = migrateViewerState(raw, options.migrations ?? VIEWER_STATE_MIGRATIONS);
        return migrated ? normalizeViewerState(migrated) : undefined;
    } catch {
        // A caller-supplied migration may return a hostile object; parse stays total.
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * Translate a restored state onto the Viewer Settings edit surface. Only
 * durable fields are emitted: measure mode, clip tab, snaps, and time-step
 * selection stay transient.
 */
export function viewerStateToPatch(state: ViewerState): ViewerSettingsPatch {
    const range = state.mapping.range;
    return {
        colorBy: state.mapping.colorBy,
        colormap: state.mapping.colormap,
        component: state.mapping.component,
        range: state.mapping.rangeMode === 'custom' && range ? range : 'auto',
        invert: state.mapping.invert,
        logScale: state.mapping.logScale,
        ...(state.mapping.solidColor !== undefined ? { solidColor: state.mapping.solidColor } : {}),
        ...(state.mapping.background !== undefined ? { background: state.mapping.background } : {}),
        scalarBarVisible: state.legend.visible,
        shading: state.shading,
        clip: state.clip.planes,
        clipCaps: state.clip.caps,
        opacity: state.opacity,
        pointSize: state.pointSize,
        lineWidth: state.lineWidth,
        thresholdEnabled: state.threshold.enabled,
        thresholdRange: state.threshold.range ?? 'data',
        warpEnabled: state.warp.enabled,
        warpArray: state.warp.array,
        warpScaleMode: state.warp.scaleMode,
        warpScale: state.warp.scale,
        glyphEnabled: state.glyph.enabled,
        glyphDensity: state.glyph.density,
        glyphScale: state.glyph.scale,
        volumeVisible: state.volume.visible,
        volumeSmooth: state.volume.smooth,
        volumeOpacityStops: state.volume.opacityStops,
        volumeBlendMode: state.volume.blendMode,
        volumeShade: state.volume.shade,
        sliceAxis: state.slice.axis,
        sliceFraction: state.slice.fraction,
        sliceSmooth: state.slice.smooth,
        axesGridVisible: state.axesGrid.visible
    };
}

/**
 * Capture the active viewer's current settings into a state. Sections the
 * viewer does not report fall back to defaults; a threshold window equal to
 * the data range is stored as "follow the data" rather than a custom window.
 * Returns `undefined` when the supplied camera pose is unusable.
 */
export function viewerStateFromSnapshot(snapshot: ViewerSettingsSnapshot, camera: ViewerCameraState): ViewerState | undefined {
    const snapshotRange = snapshot.range;
    const customRange: readonly [number, number] | undefined =
        snapshotRange && snapshotRange.mode === 'custom' && Number.isFinite(snapshotRange.min) && Number.isFinite(snapshotRange.max)
            ? [snapshotRange.min, snapshotRange.max]
            : undefined;
    const threshold = snapshot.threshold;
    const thresholdRange: readonly [number, number] | undefined =
        threshold &&
        Number.isFinite(threshold.min) &&
        Number.isFinite(threshold.max) &&
        (threshold.min !== threshold.dataMin || threshold.max !== threshold.dataMax)
            ? [threshold.min, threshold.max]
            : undefined;
    const candidate: ViewerState = {
        version: VIEWER_STATE_VERSION,
        camera,
        mapping: {
            colorBy: snapshot.colorBy?.value ?? DEFAULT_VIEWER_MAPPING_STATE.colorBy,
            colormap: snapshot.colormap?.value ?? DEFAULT_VIEWER_MAPPING_STATE.colormap,
            component: snapshot.component?.value ?? DEFAULT_VIEWER_MAPPING_STATE.component,
            rangeMode: customRange ? 'custom' : 'auto',
            ...(customRange ? { range: customRange } : {}),
            invert: snapshot.colormap?.invert ?? DEFAULT_VIEWER_MAPPING_STATE.invert,
            logScale: snapshot.colormap?.logScale.value ?? DEFAULT_VIEWER_MAPPING_STATE.logScale,
            ...(snapshot.solidColor ? { solidColor: snapshot.solidColor.value } : {}),
            ...(snapshot.background ? { background: snapshot.background.value } : {})
        },
        shading: snapshot.shading?.value ?? DEFAULT_VIEWER_SHADING_MODE,
        opacity: snapshot.opacity?.value ?? OPACITY_SPEC.defaultValue,
        pointSize: snapshot.pointSize?.value ?? POINT_SIZE_SPEC.defaultValue,
        lineWidth: snapshot.lineWidth?.value ?? LINE_WIDTH_SPEC.defaultValue,
        clip: snapshot.clip
            ? { planes: snapshot.clip.state, caps: snapshot.clip.caps ?? DEFAULT_VIEWER_CLIP_STATE.caps }
            : copyClipState(DEFAULT_VIEWER_CLIP_STATE),
        threshold: {
            enabled: threshold?.enabled ?? DEFAULT_VIEWER_THRESHOLD_STATE.enabled,
            ...(thresholdRange ? { range: thresholdRange } : {})
        },
        warp: snapshot.warp
            ? {
                  enabled: snapshot.warp.enabled,
                  array: snapshot.warp.array,
                  scaleMode: snapshot.warp.scaleMode,
                  scale: snapshot.warp.scale
              }
            : copyWarp(DEFAULT_VIEWER_WARP_STATE),
        glyph: snapshot.glyph
            ? { enabled: snapshot.glyph.enabled, density: snapshot.glyph.density, scale: snapshot.glyph.scale }
            : { ...DEFAULT_VIEWER_GLYPH_STATE },
        volume: snapshot.volume
            ? {
                  visible: snapshot.volume.visible,
                  smooth: snapshot.volume.smooth,
                  opacityStops: snapshot.volume.opacityStops,
                  blendMode: snapshot.volume.blendMode,
                  shade: snapshot.volume.shade
              }
            : copyVolume(DEFAULT_VIEWER_VOLUME_STATE),
        slice: snapshot.slice
            ? { axis: snapshot.slice.axis, fraction: snapshot.slice.fraction, smooth: snapshot.slice.smooth }
            : copySlice(DEFAULT_VIEWER_SLICE_STATE),
        legend: { visible: snapshot.scalarBar?.visible ?? DEFAULT_VIEWER_LEGEND_STATE.visible },
        axesGrid: snapshot.axesGrid ? { visible: snapshot.axesGrid.visible } : { ...DEFAULT_VIEWER_AXES_GRID_STATE }
    };
    return normalizeViewerState(candidate);
}
