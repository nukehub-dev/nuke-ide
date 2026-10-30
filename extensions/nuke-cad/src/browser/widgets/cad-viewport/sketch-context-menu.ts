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
 * Selection-aware sketch context menu.
 *
 * The model builder is pure so vitest can cover the applicability rules:
 * only constraints the solver can actually accept for the selected primitive
 * types are offered. Value constraints (length, distance, radius, angle) open
 * the existing constraint value box with their targets pre-seeded, so a
 * right-click is one action away from a dimension instead of another pick
 * session.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import type { ConstraintKind } from '../../sketch/sketch-session';

export type SketchPrimitiveType = 'point' | 'line' | 'circle' | 'arc' | 'ellipse' | 'bspline';

/** One selected primitive as the menu needs it (no solver objects). */
export interface SketchContextTarget {
    readonly id: string;
    readonly type: SketchPrimitiveType;
    readonly construction: boolean;
    /** Endpoints of a line, used for the length dimension. */
    readonly linePointIds?: readonly [string, string];
}

/** Actions the viewport widget dispatches for a sketch menu item. */
export type SketchContextMenuAction =
    | { readonly kind: 'constraint'; readonly constraint: ConstraintKind; readonly targetIds: readonly string[] }
    | {
          readonly kind: 'valueConstraint';
          readonly constraint: 'distance' | 'radius' | 'angle';
          readonly targetIds: readonly string[];
      }
    | { readonly kind: 'setConstruction'; readonly ids: readonly string[]; readonly construction: boolean }
    | { readonly kind: 'delete'; readonly ids: readonly string[] }
    | { readonly kind: 'clearSelection' }
    | { readonly kind: 'fitSketch' }
    | { readonly kind: 'toggleGrid'; readonly enabled: boolean }
    | { readonly kind: 'finishSketch' };

export interface SketchContextMenuItem {
    readonly label: string;
    readonly icon: string;
    readonly disabled?: boolean;
    readonly reason?: string;
    readonly separatorAbove?: boolean;
    readonly hint?: string;
    readonly action: SketchContextMenuAction;
}

export interface SketchContextMenuInput {
    /** Current selection; duplicates are ignored. Order is selection order. */
    readonly selection: readonly SketchContextTarget[];
    /** Grid preference at the time the menu opens. */
    readonly gridEnabled: boolean;
    /** True when the pointer hit empty canvas rather than a primitive. */
    readonly canvas: boolean;
}

const CONSTRAINT_LABELS: Readonly<Record<ConstraintKind, string>> = {
    coincident: 'Coincident',
    fix: 'Fix',
    horizontal: 'Horizontal',
    vertical: 'Vertical',
    parallel: 'Parallel',
    perpendicular: 'Perpendicular',
    tangent: 'Tangent',
    equal: 'Equal',
    concentric: 'Concentric',
    distance: 'Distance',
    angle: 'Angle',
    radius: 'Radius',
    symmetry: 'Symmetry',
    pointOnObject: 'Point on Object'
};

const CONSTRAINT_ICONS: Readonly<Record<ConstraintKind, string>> = {
    coincident: 'codicon-merge',
    fix: 'codicon-lock',
    horizontal: 'codicon-arrow-right',
    vertical: 'codicon-arrow-down',
    parallel: 'codicon-arrow-both',
    perpendicular: 'codicon-arrow-swap',
    tangent: 'codicon-circle-outline',
    equal: 'codicon-symbol-operator',
    concentric: 'codicon-target',
    distance: 'codicon-symbol-ruler',
    angle: 'codicon-triangle-right',
    radius: 'codicon-circle-large-outline',
    symmetry: 'codicon-mirror',
    pointOnObject: 'codicon-pin'
};

/** Build the right-click menu for the current selection or empty canvas. */
export function buildSketchContextMenu(input: SketchContextMenuInput): readonly SketchContextMenuItem[] {
    const selection = dedupe(input.selection);
    if (input.canvas || selection.length === 0) {
        return buildCanvasMenu(input.gridEnabled, selection.length > 0);
    }
    const items: SketchContextMenuItem[] = [];

    const constraint = (kind: ConstraintKind, targetIds: readonly string[]): SketchContextMenuItem => ({
        label: CONSTRAINT_LABELS[kind],
        icon: CONSTRAINT_ICONS[kind],
        action: { kind: 'constraint', constraint: kind, targetIds }
    });
    const dimension = (label: string, kind: 'distance' | 'radius' | 'angle', targetIds: readonly string[]): SketchContextMenuItem => ({
        label,
        icon: CONSTRAINT_ICONS[kind],
        separatorAbove: items.length > 0,
        action: { kind: 'valueConstraint', constraint: kind, targetIds }
    });

    if (selection.length === 1) {
        const target = selection[0];
        if (target.type === 'point') {
            items.push(constraint('fix', [target.id]));
        } else if (target.type === 'line') {
            items.push(constraint('horizontal', [target.id]), constraint('vertical', [target.id]));
            if (target.linePointIds !== undefined) {
                items.push(dimension('Add Length Dimension…', 'distance', target.linePointIds));
            }
        } else if (isCurve(target.type)) {
            items.push(dimension('Add Radius Dimension…', 'radius', [target.id]));
        }
    } else if (selection.length === 2) {
        const [a, b] = selection;
        if (a.type === 'point' && b.type === 'point') {
            items.push(constraint('coincident', [a.id, b.id]));
            items.push(dimension('Add Distance Dimension…', 'distance', [a.id, b.id]));
        } else if (a.type === 'point' && isCurveOrLine(b.type)) {
            items.push(constraint('pointOnObject', [a.id, b.id]));
        } else if (b.type === 'point' && isCurveOrLine(a.type)) {
            items.push(constraint('pointOnObject', [b.id, a.id]));
        } else if (a.type === 'line' && b.type === 'line') {
            items.push(constraint('parallel', [a.id, b.id]), constraint('perpendicular', [a.id, b.id]), constraint('equal', [a.id, b.id]));
            // The dimension anchor is the shared endpoint; without one the
            // solver accepts the angle but the label has nowhere to render.
            if (shareEndpoint(a, b)) {
                items.push(dimension('Add Angle Dimension…', 'angle', [a.id, b.id]));
            }
        } else if (a.type === 'line' && isCurve(b.type)) {
            items.push(constraint('tangent', [a.id, b.id]));
        } else if (b.type === 'line' && isCurve(a.type)) {
            items.push(constraint('tangent', [b.id, a.id]));
        } else if (isCurve(a.type) && isCurve(b.type)) {
            items.push(constraint('concentric', [a.id, b.id]), constraint('equal', [a.id, b.id]), constraint('tangent', [a.id, b.id]));
        }
    }

    const ids = selection.map((target) => target.id);
    const allConstruction = selection.every((target) => target.construction);
    items.push({
        label: allConstruction ? 'Make Normal' : 'Make Construction',
        icon: 'codicon-nuke-cad-construction',
        separatorAbove: items.length > 0,
        action: { kind: 'setConstruction', ids, construction: !allConstruction }
    });
    items.push({
        label: 'Delete',
        icon: 'codicon-trash',
        hint: 'Del',
        action: { kind: 'delete', ids }
    });
    items.push({
        label: 'Clear Selection',
        icon: 'codicon-clear-all',
        hint: 'Esc',
        separatorAbove: true,
        action: { kind: 'clearSelection' }
    });
    return items;
}

function buildCanvasMenu(gridEnabled: boolean, hasSelection: boolean): readonly SketchContextMenuItem[] {
    const items: SketchContextMenuItem[] = [
        { label: 'Fit Sketch', icon: 'codicon-screen-full', hint: 'F', action: { kind: 'fitSketch' } },
        {
            label: gridEnabled ? 'Hide Grid' : 'Show Grid',
            icon: 'codicon-symbol-method',
            action: { kind: 'toggleGrid', enabled: !gridEnabled }
        }
    ];
    if (hasSelection) {
        items.push({
            label: 'Clear Selection',
            icon: 'codicon-clear-all',
            hint: 'Esc',
            separatorAbove: true,
            action: { kind: 'clearSelection' }
        });
    }
    items.push({
        label: 'Finish Sketch',
        icon: 'codicon-check',
        separatorAbove: true,
        action: { kind: 'finishSketch' }
    });
    return items;
}

function dedupe(selection: readonly SketchContextTarget[]): SketchContextTarget[] {
    const seen = new Set<string>();
    return selection.filter((target) => {
        if (seen.has(target.id)) {
            return false;
        }
        seen.add(target.id);
        return true;
    });
}

function isCurve(type: SketchPrimitiveType): boolean {
    return type === 'circle' || type === 'arc';
}

function isCurveOrLine(type: SketchPrimitiveType): boolean {
    return type === 'line' || isCurve(type);
}

function shareEndpoint(a: SketchContextTarget, b: SketchContextTarget): boolean {
    const aPoints = a.linePointIds;
    const bPoints = b.linePointIds;
    if (aPoints === undefined || bPoints === undefined) {
        return false;
    }
    return aPoints.some((id) => bPoints.includes(id));
}
