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
 * Drawing-sheet data model for `.nuke-cad` documents (Wave D2).
 *
 * Implements brief §2 verbatim: an optional top-level `drawings:
 * DrawingSheet[]` block on the `.nuke-cad` document (schema stays v3, purely
 * additive, no migration). Dimensions reference model `TopologyRef`
 * fingerprints, never projected-geometry ids; `stale` marks refs the backend
 * could not re-resolve (`unmatched`/`ambiguous` keep last-good text).
 *
 * This module also owns the drawing RPC JSON shapes (brief §3:
 * `buildDrawing({scriptPath, sheetId})` returning per-view polylines +
 * dimension values + svg/dxf strings) and the pure sheet-math helpers the
 * drawing-sheet widget and the document store share (5 mm snap, pointer
 * mapping, projected-view alignment lock, section-line geometry, and the
 * auto-deconflict label layout mirroring the sketch dimension-label
 * patterns).
 *
 * @module nuke-cad/common
 */

import { validateTopologyRef, type TopologyRef } from './topology-refs';

/** Landscape sheet sizes supported by the fixed title-block template (brief §1: no title-block editor). */
export type DrawingSheetSize = 'A4' | 'A3';

/** Sheet orientation; only landscape is supported in this phase. */
export type DrawingSheetOrientation = 'landscape';

/** View kinds: one base view plus views derived from a parent view. */
export type DrawingViewKind = 'base' | 'projected' | 'section' | 'detail';

/** Standard projection orientations for a view. */
export type DrawingViewOrientation = 'front' | 'top' | 'right' | 'iso';

/** Associative dimension kinds (brief §2). */
export type DrawingDimensionKind = 'distance' | 'radius' | 'diameter';

/** Per-dimension resolution status reported by `buildDrawing`. */
export type DrawingReferenceStatus = 'matched' | 'ambiguous' | 'unmatched';

/** A single orthographic drawing sheet (brief §2, verbatim). */
export interface DrawingSheet {
    id: string;
    name: string;
    size: DrawingSheetSize;
    orientation: DrawingSheetOrientation;
    views: DrawingView[];
    dimensions: DrawingDimension[];
}

/** A single view placed on a drawing sheet (brief §2, verbatim). */
export interface DrawingView {
    id: string;
    kind: DrawingViewKind;
    orientation: DrawingViewOrientation;
    scale: number;
    /** Sheet mm from bottom-left. */
    position: [number, number];
    /** Projected/section/detail source view. */
    parentId?: string;
    sectionAxis?: 'x' | 'y' | 'z';
    sectionFlip?: boolean;
    sectionFraction?: number;
    /** Model units, in parent-view plane. */
    detailCenter?: [number, number];
    detailRadius?: number;
    showHidden?: boolean;
}

/** An associative dimension on a drawing sheet (brief §2, verbatim). */
export interface DrawingDimension {
    id: string;
    kind: DrawingDimensionKind;
    /** 1 (radius/diameter) or 2 (distance) model refs. */
    targets: TopologyRef[];
    viewId: string;
    labelOffset?: [number, number];
    value?: number;
    stale?: boolean;
}

/** Sheet dimensions in mm for the fixed landscape templates. */
export const DRAWING_SHEET_DIMENSIONS_MM: Record<DrawingSheetSize, { width: number; height: number }> = {
    A4: { width: 297, height: 210 },
    A3: { width: 420, height: 297 }
};

/** Drag-to-place snap grid step in sheet mm (brief §4). */
export const DRAWING_GRID_SNAP_MM = 5;

/** Downward stack step for the auto-deconflict label layout, in sheet mm. */
export const DRAWING_LABEL_STACK_STEP_MM = 5;

/** Default label offset (sheet mm, above the owning view) for new dimensions. */
export const DRAWING_DEFAULT_LABEL_OFFSET: [number, number] = [0, 12];

/** Dimensions of a sheet size in mm; throws on unknown sizes. */
export function sheetDimensions(size: DrawingSheetSize): { width: number; height: number } {
    const dims = DRAWING_SHEET_DIMENSIONS_MM[size];
    if (dims === undefined) {
        throw new Error(`Unknown drawing sheet size '${size}' (expected 'A4' or 'A3')`);
    }
    return dims;
}

/** Snap a sheet-mm coordinate to the placement grid. */
export function snapDrawingPosition(value: number, step: number = DRAWING_GRID_SNAP_MM): number {
    return Math.round(value / step) * step;
}

/**
 * Human-readable drawing scale (`1:1`, `1:2`, `2:1`, `1:2.5`).
 *
 * View `scale` is a multiplier (1 = 1:1, 0.5 = 1:2, 2 = 2:1); drafting
 * labels use the ratio form so a reduced view never reads `0.5:1`.
 */
export function formatDrawingScale(scale: number): string {
    if (!Number.isFinite(scale) || scale <= 0) {
        return '?';
    }
    const trim = (value: number): string => value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return scale >= 1 ? `${trim(scale)}:1` : `1:${trim(1 / scale)}`;
}

/** Clamp a sheet-mm position inside the sheet bounds. */
export function clampSheetPosition(position: readonly [number, number], sheetWidthMm: number, sheetHeightMm: number): [number, number] {
    return [Math.min(Math.max(position[0], 0), sheetWidthMm), Math.min(Math.max(position[1], 0), sheetHeightMm)];
}

/** True when a sheet-mm position lies inside the sheet bounds. */
export function isPointOnSheet(position: readonly [number, number], sheetWidthMm: number, sheetHeightMm: number): boolean {
    return position[0] >= 0 && position[0] <= sheetWidthMm && position[1] >= 0 && position[1] <= sheetHeightMm;
}

/** Client bounding rect of the rendered sheet SVG (plain data, no DOM dependency). */
export interface DrawingViewportRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Map a client pointer position to sheet mm from bottom-left.
 *
 * The sheet SVG renders with `y = sheetHeight - svgY` (sheet origin at
 * bottom-left, SVG origin at top-left), so client y is flipped here.
 */
export function pointerToSheetMm(
    clientX: number,
    clientY: number,
    rect: DrawingViewportRect,
    sheetWidthMm: number,
    sheetHeightMm: number
): [number, number] {
    const x = ((clientX - rect.left) / rect.width) * sheetWidthMm;
    const svgY = ((clientY - rect.top) / rect.height) * sheetHeightMm;
    return [x, sheetHeightMm - svgY];
}

/** Map sheet mm (bottom-left origin) to SVG user units (top-left origin). */
export function sheetMmToSvg(x: number, y: number, sheetHeightMm: number): [number, number] {
    return [x, sheetHeightMm - y];
}

/**
 * Lock a projected/section/detail view's alignment axis to its parent.
 *
 * Brief §4: projected views keep alignment axis locked to parent. `top`
 * shares the parent's x, `right` shares the parent's y, `front` shares the
 * parent's x (vertical alignment stack), and `iso` is free. Detail views use
 * their own orientation the same way.
 */
export function lockProjectedViewPosition(
    orientation: DrawingViewOrientation,
    parent: readonly [number, number],
    candidate: readonly [number, number]
): [number, number] {
    if (orientation === 'right') {
        return [candidate[0], parent[1]];
    }
    if (orientation === 'iso') {
        return [candidate[0], candidate[1]];
    }
    return [parent[0], candidate[1]];
}

/**
 * Section cutting-line endpoints across a parent view, in sheet mm.
 *
 * The line is centered on the parent position with the given half-length.
 * Cuts normal to sheet-x (`sectionAxis 'x'`) draw horizontally; cuts normal
 * to sheet-y/z draw vertically. Arrowheads render at the endpoints pointing
 * along `sectionFlip`.
 */
export function sectionLineEndpoints(
    center: readonly [number, number],
    halfLengthMm: number,
    axis: 'x' | 'y' | 'z'
): [[number, number], [number, number]] {
    if (axis === 'x') {
        return [
            [center[0] - halfLengthMm, center[1]],
            [center[0] + halfLengthMm, center[1]]
        ];
    }
    return [
        [center[0], center[1] - halfLengthMm],
        [center[0], center[1] + halfLengthMm]
    ];
}

/** A dimension label's anchor and on-screen size in sheet mm (mirrors the measure-tool pattern). */
export interface DrawingLabelCandidate {
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Clamp a label center so the whole label box stays on the sheet. Labels are
 * centered on their anchor, so the clamp bounds are half the label size from
 * each edge.
 */
export function clampDrawingLabel(
    x: number,
    y: number,
    width: number,
    height: number,
    sheetWidthMm: number,
    sheetHeightMm: number
): { x: number; y: number } {
    const halfW = Math.max(width / 2, 0.5);
    const halfH = Math.max(height / 2, 0.5);
    return {
        x: Math.min(Math.max(x, halfW), Math.max(halfW, sheetWidthMm - halfW)),
        y: Math.min(Math.max(y, halfH), Math.max(halfH, sheetHeightMm - halfH))
    };
}

/**
 * Auto-deconflict dimension label layout (sketch dimension-label pattern:
 * labels auto-shift apart unless the user pinned a screen offset — pinned
 * labels are resolved by the caller and never passed here).
 *
 * Labels are processed in input order and a label whose box would overlap an
 * already-placed one stacks downward in `DRAWING_LABEL_STACK_STEP_MM` steps
 * until free or pinned by the clamp. Returns the final center per label id.
 */
export function layoutDrawingLabels(
    labels: readonly DrawingLabelCandidate[],
    sheetWidthMm: number,
    sheetHeightMm: number
): Map<string, { x: number; y: number }> {
    const placed: DrawingLabelCandidate[] = [];
    const result = new Map<string, { x: number; y: number }>();
    const overlaps = (x: number, y: number, width: number, height: number): boolean =>
        placed.some((p) => Math.abs(p.x - x) < (p.width + width) / 2 && Math.abs(p.y - y) < (p.height + height) / 2);
    for (const label of labels) {
        let { x, y } = clampDrawingLabel(label.x, label.y, label.width, label.height, sheetWidthMm, sheetHeightMm);
        for (let attempt = 0; attempt < 20 && overlaps(x, y, label.width, label.height); attempt++) {
            y = clampDrawingLabel(x, y + DRAWING_LABEL_STACK_STEP_MM, label.width, label.height, sheetWidthMm, sheetHeightMm).y;
        }
        placed.push({ ...label, x, y });
        result.set(label.id, { x, y });
    }
    return result;
}

// *****************************************************************************
// Drawing RPC shapes (brief §3, reconciled to landed D1 keys).
//
// D1 owns `python/drawing_service.py` (dispatched append-only through
// `python/geometry_service.py --from-drawing --sheet-id <id>`) and its JSON
// is normative here: `buildDrawing({scriptPath, sheetId})` returns per-view
// polylines + dimension values + svg/dxf strings.
// *****************************************************************************

/** Request to build one drawing sheet's HLR linework. */
export interface DrawingBuildRequest {
    /** Absolute path to the `.nuke-cad` document (carried in `scriptPath` for service dispatch). */
    readonly scriptPath: string;
    /** Id of the sheet to build. */
    readonly sheetId: string;
    /** Optional output directory; defaults to the document file's directory. */
    readonly outputDirectory?: string;
}

/** Analytic circle metadata for an exactly-projected circular edge (D1 `_analytic_circle`). */
export interface DrawingCircle2D {
    readonly center: [number, number];
    readonly radius: number;
}

/** Analytic arc metadata for an exactly-projected circular edge (D1 `_analytic_circle`, degrees). */
export interface DrawingArc2D {
    readonly center: [number, number];
    readonly radius: number;
    readonly startAngle: number;
    readonly endAngle: number;
}

/**
 * A single projected polyline in absolute sheet-mm 2D (y-up from
 * bottom-left, D1 `_edge_to_polyline`).
 */
export interface DrawingPolyline {
    /** Absolute sheet-mm points. */
    readonly points: [number, number][];
    readonly closed?: boolean;
    /**
     * Backend-assigned projected-edge id. Positional and re-sorted every
     * rebuild — never stored; resolved to a model `TopologyRef` through
     * `DrawingBuildResult.edgeRefMap` at click time. Absent until D1 ships
     * the projected-edge → TopologyRef map (see contract deviations).
     */
    readonly edgeId?: string;
    readonly circle?: DrawingCircle2D;
    readonly arc?: DrawingArc2D;
}

/** A hatched cut-face loop on a section view (D1 `_face_wire_loops`). */
export interface DrawingHatchLoop {
    readonly loop: [number, number][];
    readonly area?: number;
}

/** HLR linework for one view, in absolute sheet-mm 2D (D1 `project_view`). */
export interface DrawingViewOutput {
    readonly id: string;
    readonly kind?: string;
    readonly orientation?: string;
    readonly scale?: number;
    readonly position?: [number, number];
    readonly showHidden?: boolean;
    readonly visible: DrawingPolyline[];
    readonly hidden: DrawingPolyline[];
    readonly hatchLoops?: DrawingHatchLoop[];
    readonly sectionArea?: number;
    readonly center?: [number, number];
}

/** Recomputed value for one associative dimension (D1 `compute_dimensions`). */
export interface DrawingDimensionOutput {
    readonly id: string;
    readonly kind?: string;
    readonly viewId?: string;
    readonly value?: number;
    /** Unmatched/ambiguous refs keep last-good text and set `stale: true` (brief §2). */
    readonly stale: boolean;
    readonly text?: string;
    /** Projected 2D anchors in absolute sheet-mm for extension lines. */
    readonly anchors?: [number, number][];
    readonly note?: string;
}

/** Result of a `buildDrawing` request (D1 `build_drawing`). */
export interface DrawingBuildResult {
    readonly success: boolean;
    readonly error?: string;
    readonly sheetId?: string;
    readonly size?: string;
    readonly orientation?: string;
    readonly sheetSizeMm?: [number, number];
    readonly views?: DrawingViewOutput[];
    /** Recomputed dimension values keyed by dimension id. */
    readonly dimensions?: DrawingDimensionOutput[];
    /**
     * Projected-edge → model `TopologyRef` map for the dimension tool: edge
     * identity comes from the backend (never positional ids). Dimensions
     * store the mapped `TopologyRef`, never a projected id. Absent until D1
     * ships the map (see contract deviations).
     */
    readonly edgeRefMap?: Record<string, TopologyRef>;
    readonly svg?: string;
    readonly dxf?: string;
    readonly dxfError?: string;
    readonly warnings?: string[];
    readonly scriptPath?: string;
    /** Captured stderr/stdout from the drawing service. */
    readonly output?: string;
}

// *****************************************************************************
// Validation (called from `validateNukeCadDocument`; schema stays v3).
// *****************************************************************************

/** Issue/claim sink so this module stays decoupled from `cad-document.ts` internals. */
export interface DrawingValidationSink {
    issue(path: string, message: string): void;
    claimId(path: string, id: unknown): void;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSheetPosition(sink: DrawingValidationSink, path: string, value: unknown): void {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((v: unknown) => isFiniteNumber(v))) {
        sink.issue(path, 'position must be a [x, y] tuple of finite numbers (sheet mm from bottom-left)');
    }
}

function validateDrawingView(sink: DrawingValidationSink, path: string, view: unknown): void {
    if (!isPlainObject(view)) {
        sink.issue(path, 'view must be an object');
        return;
    }
    sink.claimId(`${path}.id`, view.id);
    const kinds: DrawingViewKind[] = ['base', 'projected', 'section', 'detail'];
    if (!kinds.includes(view.kind as DrawingViewKind)) {
        sink.issue(`${path}.kind`, `unknown view kind '${view.kind}'`);
    }
    const orientations: DrawingViewOrientation[] = ['front', 'top', 'right', 'iso'];
    if (!orientations.includes(view.orientation as DrawingViewOrientation)) {
        sink.issue(`${path}.orientation`, `unknown view orientation '${view.orientation}'`);
    }
    if (!isFiniteNumber(view.scale) || (view.scale as number) <= 0) {
        sink.issue(`${path}.scale`, 'scale is required and must be a positive finite number');
    }
    validateSheetPosition(sink, `${path}.position`, view.position);
    const kind = view.kind as DrawingViewKind;
    if (kind === 'base') {
        if (view.parentId !== undefined) {
            sink.issue(`${path}.parentId`, 'base views must not have a parentId');
        }
    } else if (kind === 'projected' || kind === 'section' || kind === 'detail') {
        if (!isString(view.parentId) || (view.parentId as string).length === 0) {
            sink.issue(`${path}.parentId`, `view kind '${kind}' requires a parentId naming a view on the same sheet`);
        }
    }
    if (kind === 'section') {
        if (view.sectionAxis !== 'x' && view.sectionAxis !== 'y' && view.sectionAxis !== 'z') {
            sink.issue(`${path}.sectionAxis`, "section views require sectionAxis 'x', 'y' or 'z'");
        }
        if (view.sectionFlip !== undefined && typeof view.sectionFlip !== 'boolean') {
            sink.issue(`${path}.sectionFlip`, 'sectionFlip must be a boolean when present');
        }
        if (
            view.sectionFraction !== undefined &&
            (!isFiniteNumber(view.sectionFraction) || (view.sectionFraction as number) < 0 || (view.sectionFraction as number) > 1)
        ) {
            sink.issue(`${path}.sectionFraction`, 'sectionFraction must be in [0, 1] when present');
        }
    }
    if (kind === 'detail') {
        const center = view.detailCenter;
        if (!Array.isArray(center) || center.length !== 2 || !center.every((v: unknown) => isFiniteNumber(v))) {
            sink.issue(`${path}.detailCenter`, 'detail views require detailCenter as a [x, y] tuple of finite numbers (model units)');
        }
        if (!isFiniteNumber(view.detailRadius) || (view.detailRadius as number) <= 0) {
            sink.issue(`${path}.detailRadius`, 'detail views require a positive finite detailRadius (model units)');
        }
    }
    if (view.showHidden !== undefined && typeof view.showHidden !== 'boolean') {
        sink.issue(`${path}.showHidden`, 'showHidden must be a boolean when present');
    }
}

function validateDrawingDimension(sink: DrawingValidationSink, path: string, dimension: unknown): void {
    if (!isPlainObject(dimension)) {
        sink.issue(path, 'dimension must be an object');
        return;
    }
    sink.claimId(`${path}.id`, dimension.id);
    const kinds: DrawingDimensionKind[] = ['distance', 'radius', 'diameter'];
    if (!kinds.includes(dimension.kind as DrawingDimensionKind)) {
        sink.issue(`${path}.kind`, `unknown dimension kind '${dimension.kind}'`);
    }
    const expectedTargets = dimension.kind === 'distance' ? 2 : 1;
    if (!Array.isArray(dimension.targets) || dimension.targets.length !== expectedTargets) {
        sink.issue(`${path}.targets`, `dimension kind '${dimension.kind}' requires exactly ${expectedTargets} TopologyRef target(s)`);
    } else {
        for (const [i, target] of dimension.targets.entries()) {
            if (!isPlainObject(target)) {
                sink.issue(`${path}.targets[${i}]`, 'expected a TopologyRef object');
                continue;
            }
            const result = validateTopologyRef(target as unknown as TopologyRef);
            for (const sub of result.issues) {
                sink.issue(`${path}.targets[${i}]`, sub);
            }
        }
    }
    if (!isString(dimension.viewId) || (dimension.viewId as string).length === 0) {
        sink.issue(`${path}.viewId`, 'viewId is required and must be a non-empty string');
    }
    if (dimension.labelOffset !== undefined) {
        if (!Array.isArray(dimension.labelOffset) || dimension.labelOffset.length !== 2) {
            sink.issue(`${path}.labelOffset`, 'labelOffset must be a [x, y] tuple');
        } else {
            for (const [j, v] of dimension.labelOffset.entries()) {
                if (!isFiniteNumber(v)) {
                    sink.issue(`${path}.labelOffset[${j}]`, 'labelOffset component must be finite');
                }
            }
        }
    }
    if (dimension.value !== undefined && !isFiniteNumber(dimension.value)) {
        sink.issue(`${path}.value`, 'value must be a finite number when present');
    }
    if (dimension.stale !== undefined && typeof dimension.stale !== 'boolean') {
        sink.issue(`${path}.stale`, 'stale must be a boolean when present');
    }
}

/**
 * Validate one drawing sheet, including in-sheet dangling references
 * (non-base `parentId` and dimension `viewId` must name a view on the same
 * sheet).
 */
export function validateDrawingSheet(sheet: unknown, path: string, sink: DrawingValidationSink): void {
    if (!isPlainObject(sheet)) {
        sink.issue(path, 'drawing sheet must be an object');
        return;
    }
    sink.claimId(`${path}.id`, sheet.id);
    if (!isString(sheet.name)) {
        sink.issue(`${path}.name`, 'name must be a string');
    }
    if (sheet.size !== 'A4' && sheet.size !== 'A3') {
        sink.issue(`${path}.size`, `unknown sheet size '${sheet.size}' (expected 'A4' or 'A3')`);
    }
    if (sheet.orientation !== 'landscape') {
        sink.issue(`${path}.orientation`, `unknown sheet orientation '${sheet.orientation}' (expected 'landscape')`);
    }
    const views = sheet.views;
    if (!Array.isArray(views)) {
        sink.issue(`${path}.views`, 'views must be an array');
        return;
    }
    for (const [i, view] of views.entries()) {
        validateDrawingView(sink, `${path}.views[${i}]`, view);
    }
    const viewIds = new Set<string>(
        views
            .filter(isPlainObject)
            .map((v) => v.id)
            .filter(isString)
    );
    for (const [i, view] of views.entries()) {
        if (!isPlainObject(view)) {
            continue;
        }
        const kind = view.kind as DrawingViewKind;
        if ((kind === 'projected' || kind === 'section' || kind === 'detail') && isString(view.parentId) && !viewIds.has(view.parentId)) {
            sink.issue(`${path}.views[${i}].parentId`, `unknown view '${view.parentId}' on the same sheet`);
        }
    }
    const dimensions = (sheet as Record<string, unknown>).dimensions;
    if (!Array.isArray(dimensions)) {
        sink.issue(`${path}.dimensions`, 'dimensions must be an array');
        return;
    }
    for (const [i, dimension] of dimensions.entries()) {
        validateDrawingDimension(sink, `${path}.dimensions[${i}]`, dimension);
        if (isPlainObject(dimension) && isString(dimension.viewId) && !viewIds.has(dimension.viewId)) {
            sink.issue(`${path}.dimensions[${i}].viewId`, `unknown view '${dimension.viewId}' on the same sheet`);
        }
    }
}
