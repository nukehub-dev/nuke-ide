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

import { describe, expect, it } from 'vitest';
import { buildSketchContextMenu, type SketchContextMenuItem, type SketchContextTarget } from './sketch-context-menu';

const labels = (items: readonly SketchContextMenuItem[]): string[] => items.map((item) => item.label);

function target(
    id: string,
    type: SketchContextTarget['type'],
    construction = false,
    linePointIds?: readonly [string, string]
): SketchContextTarget {
    return { id, type, construction, linePointIds };
}

describe('buildSketchContextMenu', () => {
    it('offers the single-line constraints and a length dimension', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line', false, ['p1', 'p2'])],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toEqual([
            'Horizontal',
            'Vertical',
            'Add Length Dimension…',
            'Make Construction',
            'Delete',
            'Clear Selection'
        ]);
        expect(items.find((item) => item.label === 'Add Length Dimension…')?.action).toEqual({
            kind: 'valueConstraint',
            constraint: 'distance',
            targetIds: ['p1', 'p2']
        });
    });

    it('offers Fix only for a single point', () => {
        const items = buildSketchContextMenu({
            selection: [target('point-1', 'point')],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toEqual(['Fix', 'Make Construction', 'Delete', 'Clear Selection']);
        expect(items[0].action).toEqual({ kind: 'constraint', constraint: 'fix', targetIds: ['point-1'] });
    });

    it('offers line/line relations and an angle dimension at a shared endpoint', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line', false, ['a', 'b']), target('line-2', 'line', false, ['b', 'c'])],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toEqual([
            'Parallel',
            'Perpendicular',
            'Equal',
            'Add Angle Dimension…',
            'Make Construction',
            'Delete',
            'Clear Selection'
        ]);
        expect(items.find((item) => item.label === 'Add Angle Dimension…')?.action).toEqual({
            kind: 'valueConstraint',
            constraint: 'angle',
            targetIds: ['line-1', 'line-2']
        });
    });

    it('does not offer invalid coincident constraints for line pairs', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line'), target('line-2', 'line')],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).not.toContain('Coincident');
    });

    it('omits the angle dimension for disjoint lines (no visible label anchor)', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line', false, ['a', 'b']), target('line-2', 'line', false, ['c', 'd'])],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).not.toContain('Add Angle Dimension…');
        expect(labels(items)).toContain('Parallel');
    });

    it('offers curve/curve relations', () => {
        const items = buildSketchContextMenu({
            selection: [target('arc-1', 'arc'), target('circle-1', 'circle')],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items).slice(0, 3)).toEqual(['Concentric', 'Equal', 'Tangent']);
    });

    it('orders point-on-object with the point first', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line'), target('point-1', 'point')],
            gridEnabled: true,
            canvas: false
        });

        expect(items[0].action).toEqual({
            kind: 'constraint',
            constraint: 'pointOnObject',
            targetIds: ['point-1', 'line-1']
        });
    });

    it('offers coincident and distance for two points', () => {
        const items = buildSketchContextMenu({
            selection: [target('point-1', 'point'), target('point-2', 'point')],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toEqual(['Coincident', 'Add Distance Dimension…', 'Make Construction', 'Delete', 'Clear Selection']);
        expect(items[1].action).toEqual({
            kind: 'valueConstraint',
            constraint: 'distance',
            targetIds: ['point-1', 'point-2']
        });
    });

    it('flips the construction action for an all-construction selection', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line', true)],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toContain('Make Normal');
        expect(items.find((item) => item.label === 'Make Normal')?.action).toEqual({
            kind: 'setConstruction',
            ids: ['line-1'],
            construction: false
        });
    });

    it('does not offer constraints for unsupported primitive combinations', () => {
        const items = buildSketchContextMenu({
            selection: [target('ellipse-1', 'ellipse')],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toEqual(['Make Construction', 'Delete', 'Clear Selection']);
    });

    it('offers only entity actions for a three-entity selection', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line'), target('line-2', 'line'), target('line-3', 'line')],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toEqual(['Make Construction', 'Delete', 'Clear Selection']);
    });

    it('deduplicates repeated selection ids', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line'), target('line-1', 'line')],
            gridEnabled: true,
            canvas: false
        });

        expect(labels(items)).toContain('Horizontal');
        expect(items.find((item) => item.label === 'Delete')?.action).toEqual({
            kind: 'delete',
            ids: ['line-1']
        });
    });

    it('offers canvas actions on empty space', () => {
        const items = buildSketchContextMenu({ selection: [], gridEnabled: true, canvas: true });

        expect(labels(items)).toEqual(['Fit Sketch', 'Hide Grid', 'Finish Sketch']);
        expect(items[1].action).toEqual({ kind: 'toggleGrid', enabled: false });
    });

    it('adds clear-selection to the canvas menu when a selection exists', () => {
        const items = buildSketchContextMenu({
            selection: [target('line-1', 'line')],
            gridEnabled: false,
            canvas: true
        });

        expect(labels(items)).toEqual(['Fit Sketch', 'Show Grid', 'Clear Selection', 'Finish Sketch']);
    });
});
