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
 * Pure drawing-sheet edit planner for `.nuke-cad` documents.
 *
 * One prepared edit applies 1–16 sheet-size, view-display, and dimension
 * visibility actions to a document clone. Sheets, views, and dimensions are
 * never added or removed: the planner only changes the existing sheet size,
 * per-view scale/hidden-line display, and the optional `hidden` flag on a
 * dimension. View positions and geometry stay untouched, so applying a plan
 * only needs a drawing refresh (HLR rebuild) and never a geometry rebuild.
 *
 * The store applies the returned candidate document in one `markDrawing`
 * commit; capabilities and the review panel use the before/after rows for
 * their preview.
 *
 * @module nuke-cad/common
 */

import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeCadDocument } from './cad-document';
import { validateNukeCadDocument } from './cad-document';
import {
    DRAWING_SHEET_DIMENSIONS_MM,
    formatDrawingScale,
    type DrawingDimension,
    type DrawingDimensionKind,
    type DrawingSheetSize,
    type DrawingView,
    type DrawingViewKind,
    type DrawingViewOrientation
} from './cad-drawing';

/** Maximum number of actions accepted by one prepared drawing edit. */
export const DRAWING_CHANGE_LIMIT = 16;

/** One requested drawing-sheet edit action. */
export type DrawingChangeAction =
    | { readonly action: 'setSheetSize'; readonly sheetId: string; readonly size: DrawingSheetSize }
    | {
          readonly action: 'setViewDisplay';
          readonly sheetId: string;
          readonly viewId: string;
          readonly scale?: number;
          readonly showHidden?: boolean;
      }
    | { readonly action: 'setDimensionVisibility'; readonly sheetId: string; readonly dimensionId: string; readonly visible: boolean };

/** One changed view with its before/after display state. */
export interface DrawingViewPlanRow {
    readonly id: string;
    readonly kind: DrawingViewKind;
    readonly orientation: DrawingViewOrientation;
    readonly scaleBefore: number;
    readonly scaleAfter: number;
    readonly showHiddenBefore: boolean;
    readonly showHiddenAfter: boolean;
}

/** One changed dimension with its before/after sheet visibility. */
export interface DrawingDimensionPlanRow {
    readonly id: string;
    readonly kind: DrawingDimensionKind;
    readonly viewId: string;
    readonly visibleBefore: boolean;
    readonly visibleAfter: boolean;
}

/** Complete validated drawing edit prepared for preview and one-commit apply. */
export interface PreparedDrawingEdit {
    readonly afterDocument: NukeCadDocument;
    readonly actions: readonly DrawingChangeAction[];
    readonly changes: readonly NukeChange[];
    readonly sheetId: string;
    readonly sheetName: string;
    readonly sizeBefore: DrawingSheetSize;
    readonly sizeAfter: DrawingSheetSize;
    readonly views: readonly DrawingViewPlanRow[];
    readonly dimensions: readonly DrawingDimensionPlanRow[];
    readonly warnings: readonly string[];
    readonly requiresDrawingRefresh: true;
}

/** Result of {@link prepareDrawingEdit}: a complete edit or a rejection message. */
export type DrawingEditPrepareResult =
    { readonly ok: true; readonly result: PreparedDrawingEdit } | { readonly ok: false; readonly message: string };

/** View scales treated as standard drafting ratios; any other value warns. */
const STANDARD_DRAWING_SCALES: readonly number[] = [0.1, 0.2, 0.5, 1, 2, 5, 10];

/** Smallest and largest view scale accepted by one drawing edit. */
const MIN_DRAWING_SCALE = 0.001;
const MAX_DRAWING_SCALE = 1000;

interface PendingSheetSize {
    readonly kind: 'size';
    readonly previous: DrawingSheetSize;
    readonly size: DrawingSheetSize;
}

interface PendingViewDisplay {
    readonly kind: 'view';
    readonly view: DrawingView;
    readonly scale?: number;
    readonly showHidden?: boolean;
    readonly scaleBefore: number;
    readonly showHiddenBefore: boolean;
}

interface PendingDimensionVisibility {
    readonly kind: 'dimension';
    readonly dimension: DrawingDimension;
    readonly visible: boolean;
    readonly visibleBefore: boolean;
}

type PendingDrawingAction = PendingSheetSize | PendingViewDisplay | PendingDimensionVisibility;

function reject(message: string): { readonly ok: false; readonly message: string } {
    return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDocument(document: NukeCadDocument): NukeCadDocument {
    return JSON.parse(JSON.stringify(document)) as NukeCadDocument;
}

function formatDocumentIssues(issues: readonly { path: string; message: string }[]): string {
    return issues.map((issue) => `${issue.path || 'document'}: ${issue.message}`).join('; ');
}

function isStandardDrawingScale(scale: number): boolean {
    return STANDARD_DRAWING_SCALES.some((standard) => standard === scale);
}

/** A4 bounds used to reject shrinking a sheet under views that would fall off it. */
function viewFitsA4(view: DrawingView): boolean {
    const { width, height } = DRAWING_SHEET_DIMENSIONS_MM.A4;
    if (!Array.isArray(view.position) || view.position.length !== 2) {
        return false;
    }
    const [x, y] = view.position;
    return x >= 0 && x <= width && y >= 0 && y <= height;
}

/**
 * Validate and apply drawing-sheet actions to a copy of `document`.
 *
 * The whole request is rejected if any action is invalid, so a call either
 * produces a complete candidate or no document at all. All actions must target
 * one existing sheet; duplicate targets and no-op actions are rejected because
 * a batch exists to make real changes. A3 → A4 additionally requires every
 * view to fit inside A4, since view positions never move.
 */
export function prepareDrawingEdit(document: NukeCadDocument, actions: readonly DrawingChangeAction[]): DrawingEditPrepareResult {
    if (!isRecord(document)) {
        return reject('The document must be an object.');
    }
    if (!Array.isArray(actions) || actions.length === 0) {
        return reject('No drawing change actions were provided.');
    }
    if (actions.length > DRAWING_CHANGE_LIMIT) {
        return reject(`Too many drawing change actions (${actions.length}); at most ${DRAWING_CHANGE_LIMIT} are allowed.`);
    }

    let sheetId: string | undefined;
    for (const [index, action] of actions.entries()) {
        if (!isRecord(action)) {
            return reject(`Drawing change action ${index + 1} must be an object.`);
        }
        const actionSheetId = action.sheetId;
        if (typeof actionSheetId !== 'string' || actionSheetId.length === 0) {
            return reject(`Drawing change action ${index + 1} requires a non-empty sheet id.`);
        }
        if (sheetId === undefined) {
            sheetId = actionSheetId;
        } else if (sheetId !== actionSheetId) {
            return reject('All drawing change actions must target the same sheet.');
        }
        const kind = action.action;
        if (kind !== 'setSheetSize' && kind !== 'setViewDisplay' && kind !== 'setDimensionVisibility') {
            return reject(`Drawing change action ${index + 1} has an unknown action '${String(kind)}'.`);
        }
    }

    const beforeSheet = (Array.isArray(document.drawings) ? document.drawings : []).find((sheet) => sheet.id === sheetId);
    if (beforeSheet === undefined) {
        return reject(`Drawing sheet '${sheetId}' not found.`);
    }
    if (!Array.isArray(beforeSheet.views) || !Array.isArray(beforeSheet.dimensions)) {
        return reject(`Drawing sheet '${beforeSheet.id}' is malformed.`);
    }

    const claimedViews = new Set<string>();
    const claimedDimensions = new Set<string>();
    const pending: PendingDrawingAction[] = [];
    let sheetSizeSeen = false;

    for (const [index, action] of actions.entries()) {
        if (action.action === 'setSheetSize') {
            if (sheetSizeSeen) {
                return reject(`Duplicate drawing edit for sheet '${beforeSheet.id}'.`);
            }
            sheetSizeSeen = true;
            const size = action.size;
            if (size !== 'A4' && size !== 'A3') {
                return reject(`Drawing change action ${index + 1} sheet size must be 'A4' or 'A3'.`);
            }
            if (size === beforeSheet.size) {
                return reject(`Sheet '${beforeSheet.name}' is already ${size}; the edit would not change anything.`);
            }
            if (size === 'A4' && beforeSheet.views.some((view) => !viewFitsA4(view))) {
                return reject(
                    `Sheet '${beforeSheet.name}' cannot shrink to A4 because at least one view lies outside the A4 bounds; move it first.`
                );
            }
            pending.push({ kind: 'size', previous: beforeSheet.size, size });
            continue;
        }

        if (action.action === 'setViewDisplay') {
            const viewId = action.viewId;
            if (typeof viewId !== 'string' || viewId.length === 0) {
                return reject(`Drawing change action ${index + 1} requires a non-empty view id.`);
            }
            if (claimedViews.has(viewId)) {
                return reject(`Duplicate drawing edit for view '${viewId}'.`);
            }
            claimedViews.add(viewId);
            const view = beforeSheet.views.find((candidate) => candidate.id === viewId);
            if (view === undefined) {
                return reject(`View '${viewId}' not found on sheet '${beforeSheet.id}'.`);
            }
            const scale = action.scale;
            const showHidden = action.showHidden;
            if (scale === undefined && showHidden === undefined) {
                return reject(`View '${viewId}' requires a scale or showHidden change.`);
            }
            if (
                scale !== undefined &&
                (typeof scale !== 'number' || !Number.isFinite(scale) || scale < MIN_DRAWING_SCALE || scale > MAX_DRAWING_SCALE)
            ) {
                return reject(`View '${viewId}' scale must be a finite number in [0.001, 1000].`);
            }
            if (showHidden !== undefined && typeof showHidden !== 'boolean') {
                return reject(`View '${viewId}' showHidden must be a boolean.`);
            }
            const scaleBefore = view.scale;
            const showHiddenBefore = view.showHidden === true;
            const scaleChanged = scale !== undefined && scale !== scaleBefore;
            const showHiddenChanged = showHidden !== undefined && showHidden !== showHiddenBefore;
            if (!scaleChanged && !showHiddenChanged) {
                return reject(`View '${viewId}' already has the requested display; the edit would not change anything.`);
            }
            pending.push({
                kind: 'view',
                view,
                scaleBefore,
                showHiddenBefore,
                ...(scale !== undefined ? { scale } : {}),
                ...(showHidden !== undefined ? { showHidden } : {})
            });
            continue;
        }

        const dimensionId = action.dimensionId;
        if (typeof dimensionId !== 'string' || dimensionId.length === 0) {
            return reject(`Drawing change action ${index + 1} requires a non-empty dimension id.`);
        }
        if (claimedDimensions.has(dimensionId)) {
            return reject(`Duplicate drawing edit for dimension '${dimensionId}'.`);
        }
        claimedDimensions.add(dimensionId);
        const dimension = beforeSheet.dimensions.find((candidate) => candidate.id === dimensionId);
        if (dimension === undefined) {
            return reject(`Dimension '${dimensionId}' not found on sheet '${beforeSheet.id}'.`);
        }
        const visible = action.visible;
        if (typeof visible !== 'boolean') {
            return reject(`Dimension '${dimensionId}' visibility must be a boolean.`);
        }
        const visibleBefore = dimension.hidden !== true;
        if (visibleBefore === visible) {
            return reject(`Dimension '${dimensionId}' already has the requested visibility; the edit would not change anything.`);
        }
        pending.push({ kind: 'dimension', dimension, visible, visibleBefore });
    }

    if (pending.length === 0) {
        return reject('The drawing edit has no effective changes.');
    }

    const afterDocument = cloneDocument(document);
    const afterSheet = (afterDocument.drawings ?? []).find((sheet) => sheet.id === beforeSheet.id);
    if (afterSheet === undefined) {
        return reject(`Drawing sheet '${beforeSheet.id}' disappeared while preparing the edit.`);
    }

    for (const change of pending) {
        if (change.kind === 'size') {
            afterSheet.size = change.size;
            continue;
        }
        if (change.kind === 'view') {
            const target = afterSheet.views.find((view) => view.id === change.view.id);
            if (target === undefined) {
                return reject(`View '${change.view.id}' disappeared while preparing the edit.`);
            }
            if (change.scale !== undefined) {
                target.scale = change.scale;
            }
            if (change.showHidden !== undefined) {
                target.showHidden = change.showHidden;
            }
            continue;
        }
        const target = afterSheet.dimensions.find((dimension) => dimension.id === change.dimension.id);
        if (target === undefined) {
            return reject(`Dimension '${change.dimension.id}' disappeared while preparing the edit.`);
        }
        target.hidden = !change.visible;
    }

    const validation = validateNukeCadDocument(afterDocument);
    if (!validation.valid) {
        return reject(`The edited document is invalid: ${formatDocumentIssues(validation.issues)}`);
    }
    if (afterSheet.views.length !== beforeSheet.views.length || afterSheet.dimensions.length !== beforeSheet.dimensions.length) {
        return reject('The drawing edit changed the sheet view or dimension count.');
    }

    const changes: NukeChange[] = [];
    const views: DrawingViewPlanRow[] = [];
    const dimensions: DrawingDimensionPlanRow[] = [];
    const warnings: string[] = [];
    let sizeAfter = beforeSheet.size;

    for (const change of pending) {
        if (change.kind === 'size') {
            sizeAfter = change.size;
            changes.push({
                path: `drawings.${beforeSheet.id}.size`,
                label: `Sheet ${beforeSheet.name} size`,
                kind: 'update',
                before: change.previous,
                after: change.size
            });
            continue;
        }
        if (change.kind === 'view') {
            const { view } = change;
            if (change.scale !== undefined && change.scale !== change.scaleBefore) {
                changes.push({
                    path: `drawings.${beforeSheet.id}.views.${view.id}.scale`,
                    label: `View ${view.id} scale`,
                    kind: 'update',
                    before: change.scaleBefore,
                    after: change.scale
                });
                if (!isStandardDrawingScale(change.scale)) {
                    warnings.push(`View '${view.id}' uses non-standard scale ${formatDrawingScale(change.scale)}.`);
                }
            }
            if (change.showHidden !== undefined && change.showHidden !== change.showHiddenBefore) {
                changes.push({
                    path: `drawings.${beforeSheet.id}.views.${view.id}.showHidden`,
                    label: `View ${view.id} hidden lines`,
                    kind: 'update',
                    before: change.showHiddenBefore,
                    after: change.showHidden
                });
            }
            views.push({
                id: view.id,
                kind: view.kind,
                orientation: view.orientation,
                scaleBefore: change.scaleBefore,
                scaleAfter: change.scale ?? change.scaleBefore,
                showHiddenBefore: change.showHiddenBefore,
                showHiddenAfter: change.showHidden ?? change.showHiddenBefore
            });
            continue;
        }
        const { dimension } = change;
        changes.push({
            path: `drawings.${beforeSheet.id}.dimensions.${dimension.id}.hidden`,
            label: `Dimension ${dimension.id} visibility`,
            kind: 'update',
            before: !change.visibleBefore,
            after: !change.visible
        });
        dimensions.push({
            id: dimension.id,
            kind: dimension.kind,
            viewId: dimension.viewId,
            visibleBefore: change.visibleBefore,
            visibleAfter: change.visible
        });
    }

    if (sizeAfter === 'A4' && beforeSheet.size === 'A3') {
        warnings.push('A4 is smaller; view positions stay fixed.');
    }

    return {
        ok: true,
        result: {
            afterDocument,
            actions,
            changes,
            sheetId: beforeSheet.id,
            sheetName: beforeSheet.name,
            sizeBefore: beforeSheet.size,
            sizeAfter,
            views,
            dimensions,
            warnings,
            requiresDrawingRefresh: true
        }
    };
}
