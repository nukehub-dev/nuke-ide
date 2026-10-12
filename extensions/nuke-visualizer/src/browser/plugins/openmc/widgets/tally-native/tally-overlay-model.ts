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
 * Dataset classification for the native tally mesh/overlay/source viewer (P3-D2).
 *
 * Covers the three `tally_viz.py` dataset kinds the P1 viewer already parses
 * (`openmc.visualize-mesh` full-3D grids, `openmc.visualize-overlay` slice or
 * full-3D tally-on-geometry, `openmc.visualize-source` / statepoint-source
 * point clouds) plus the static slice files from `slice_viz.py` (F9): given a
 * VTK family, grid dimensions, and array names, this module picks the viewer
 * kind, the slice axis for thin grids, and the instant color-by default — no
 * server, no restart.
 *
 * Pure functions + types only; no trame, no vuetify, no DOM, no three.js.
 * Array grouping reuses the P1 `native-vtk-data` classifier.
 */

import type { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import type { GeometryNativeCell } from '../geometry-native/geometry-native-model';
import { isDegenerateCell } from '../geometry-native/geometry-native-model';
import type { ViewerContextMenuItem } from '../../../../viewer-core/viewer-context-menu';
import {
    ClassifiedNativeVtkArrays,
    classifyNativeVtkArrays,
    colorByValue,
    defaultNativeColorBy,
    NativeVtkDatasetFamily,
    SOLID_COLOR
} from '../native-vtk/native-vtk-data';

/** Tally dataset kinds served by `tally_viz.py` / `slice_viz.py`. */
export type TallyOverlayKind = 'mesh' | 'slice' | 'source' | 'overlay';

/** All dataset kinds in UI order. */
export const TALLY_OVERLAY_KINDS: readonly TallyOverlayKind[] = ['mesh', 'slice', 'source', 'overlay'];

/** Slice plane axis for thin (single-cell-deep) grids. */
export type SliceAxis = 'x' | 'y' | 'z';

/** Runtime guard for dataset kinds. */
export function isTallyOverlayKind(value: string): value is TallyOverlayKind {
    return (TALLY_OVERLAY_KINDS as readonly string[]).includes(value);
}

/**
 * True for true 3D grids (every axis deeper than one cell): the smooth
 * raycast volume needs a real volume, so slices and clouds stay on voxel
 * boxes and the tally-volume rows stay hidden for them.
 */
export function smoothableGridDims(dims: readonly [number, number, number] | undefined): dims is [number, number, number] {
    return dims !== undefined && dims[0] > 1 && dims[1] > 1 && dims[2] > 1;
}

/** Ghost strengths for the CSG underlay: full context normally, faint while the smooth MIP is showing. */
export interface UnderlayGhostStrength {
    readonly fill: number;
    readonly edge: number;
}

/**
 * Ghost strength for the CSG underlay: full while voxel boxes draw, dimmed
 * while the smooth raycast is active so stacked shells cannot veil the
 * maximum-intensity projection. Pure.
 */
export function underlayGhostStrength(smoothActive: boolean): UnderlayGhostStrength {
    return smoothActive ? { fill: 0.03, edge: 0.12 } : { fill: 0.1, edge: 0.35 };
}

/** Array names that mark a source-distribution point cloud (lowercased). */
const SOURCE_ARRAY_NAMES = new Set(['source', 'sources', 'birth_position', 'positions', 'strength', 'particle_source']);

/** Array names that mark a tally mesh grid (lowercased fragments). */
const MESH_ARRAY_HINTS = ['flux', 'fission', 'tally', 'mean', 'std', 'score', 'reaction'];

/** Weight-window bound arrays (`lower/upper_g<i>`, optional `ww<id>_` prefix). */
const WINDOW_ARRAY_RE = /^(?:ww\d+_)?(lower|upper)_g\d+$/i;

/** True when any array name matches the source-distribution vocabulary. */
export function hasSourceArrays(names: readonly string[]): boolean {
    return names.some((name) => SOURCE_ARRAY_NAMES.has(name.toLowerCase()));
}

/** True when any array name looks like a tally mesh quantity. */
export function hasMeshArrays(names: readonly string[]): boolean {
    const lowered = names.map((name) => name.toLowerCase());
    return lowered.some(
        (name) => WINDOW_ARRAY_RE.test(name) || MESH_ARRAY_HINTS.some((hint) => name.includes(hint)) || /^flux_(?:group_|g)\d+$/i.test(name)
    );
}

/**
 * Detect the thin axis of a grid: the first dimension of extent 1 (x, then y,
 * then z). Returns undefined when no dimension is degenerate (full 3D).
 */
export function detectSliceAxis(dimensions: readonly [number, number, number]): SliceAxis | undefined {
    if (dimensions[0] <= 1) {
        return 'x';
    }
    if (dimensions[1] <= 1) {
        return 'y';
    }
    if (dimensions[2] <= 1) {
        return 'z';
    }
    return undefined;
}

/**
 * Classify a loaded dataset into a tally viewer kind.
 *
 * - `source`: polydata point clouds with source arrays (`visualize-source`).
 * - `slice`: rectilinear/image grids thin in one axis (`slice_viz.py` files).
 * - `mesh`: grids with tally/WT-window arrays (`visualize-mesh`).
 * - `overlay`: anything else (tally-on-geometry full-3D composites).
 */
export function detectTallyOverlayKind(input: {
    family: NativeVtkDatasetFamily;
    gridDimensions?: readonly [number, number, number];
    arrayNames: readonly string[];
}): TallyOverlayKind {
    if (input.family === 'polydata' && hasSourceArrays(input.arrayNames)) {
        return 'source';
    }
    if ((input.family === 'rectilinear' || input.family === 'image') && input.gridDimensions) {
        if (detectSliceAxis(input.gridDimensions) !== undefined) {
            return 'slice';
        }
        if (hasMeshArrays(input.arrayNames)) {
            return 'mesh';
        }
        return 'overlay';
    }
    if (input.family === 'polydata') {
        return hasMeshArrays(input.arrayNames) ? 'overlay' : 'source';
    }
    return 'overlay';
}

/** Per-kind point-size preset for the native point-cloud path. */
export function pointSizeForKind(kind: TallyOverlayKind): number {
    switch (kind) {
        case 'source':
            return 4;
        case 'slice':
            return 2;
        case 'mesh':
            return 3;
        case 'overlay':
            return 3;
    }
}

/**
 * Default color-by for a classified dataset under a viewer kind: source
 * clouds prefer source arrays, slices prefer the first flux group, grids
 * reuse the P1 default (energy → flux → window bound → scalar...), and
 * anything without arrays stays Solid Color.
 */
export function defaultOverlayColorBy(
    kind: TallyOverlayKind,
    classified: ClassifiedNativeVtkArrays,
    family: NativeVtkDatasetFamily
): string {
    if (kind === 'source' && classified.sources.length > 0) {
        return colorByValue(classified.sources[0]);
    }
    if (kind === 'slice' && classified.fluxGroups.length > 0) {
        return colorByValue(classified.fluxGroups[0]);
    }
    return defaultNativeColorBy(classified, family) ?? SOLID_COLOR;
}

/** One-line summary driving the viewer header (`<kind> — <detail>`). */
export function describeTallyOverlayDataset(input: {
    kind: TallyOverlayKind;
    family: NativeVtkDatasetFamily;
    nPoints: number;
    sliceAxis?: SliceAxis;
    colorBy: string;
}): string {
    const points = `${input.nPoints.toLocaleString()} pts`;
    switch (input.kind) {
        case 'source':
            return `Source cloud — ${points} (${input.colorBy})`;
        case 'slice':
            return `Tally slice${input.sliceAxis ? ` ⟂ ${input.sliceAxis}` : ''} — ${points} (${input.colorBy})`;
        case 'mesh':
            return `Mesh tally — ${points} (${input.colorBy})`;
        case 'overlay':
            return `Tally overlay — ${points} (${input.colorBy})`;
    }
}

/** Convenience: classify raw array infos and pick the kind default in one step. */
export function classifyTallyOverlayDataset(
    arrays: readonly OpenMCVtkArrayInfo[],
    family: NativeVtkDatasetFamily,
    gridDimensions?: readonly [number, number, number]
): { classified: ClassifiedNativeVtkArrays; kind: TallyOverlayKind; colorBy: string; sliceAxis: SliceAxis | undefined } {
    const classified = classifyNativeVtkArrays(arrays);
    const names = arrays.map((array) => array.name);
    const kind = detectTallyOverlayKind({ family, gridDimensions, arrayNames: names });
    const sliceAxis = kind === 'slice' && gridDimensions ? detectSliceAxis(gridDimensions) : undefined;
    return { classified, kind, colorBy: defaultOverlayColorBy(kind, classified, family), sliceAxis };
}

/**
 * Cells eligible for the overlay geometry underlay: degenerate bboxes
 * (zero volume) cannot render as boxes and are dropped (the geometry
 * viewer lists, not draws, them). Void cells stay — they render as
 * edge-only shells (no fill), so the big bounding void boxes give context
 * without stacking translucency over the tally.
 */
export function csgUnderlayCells(cells: readonly GeometryNativeCell[]): GeometryNativeCell[] {
    return cells.filter((cell) => !isDegenerateCell(cell));
}

/** Stable id of the tally canvas menu's underlay toggle. */
export const TALLY_UNDERLAY_MENU_ID = 'underlay';

/**
 * Canvas-menu toggle for the CSG underlay (checked while visible,
 * disabled before any cells load). Pure.
 */
export function buildTallyUnderlayMenuItem(hasCells: boolean, visible: boolean): ViewerContextMenuItem {
    return {
        id: TALLY_UNDERLAY_MENU_ID,
        label: hasCells ? 'CSG Underlay' : 'CSG Underlay (none loaded)',
        icon: 'codicon-symbol-struct',
        checked: hasCells && visible,
        separatorAbove: true,
        disabled: !hasCells
    };
}
