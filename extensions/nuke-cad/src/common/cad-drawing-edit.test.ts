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

import { describe, it, expect } from 'vitest';
import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument } from './cad-document';
import { type TopologyRef } from './topology-refs';
import { DRAWING_CHANGE_LIMIT, prepareDrawingEdit, type DrawingChangeAction, type PreparedDrawingEdit } from './cad-drawing-edit';

function edgeRef(featureId = 'pad-1'): TopologyRef {
    return {
        featureId,
        kind: 'edge',
        fingerprint: { curveType: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0] }
    };
}

function drawingDocument(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'body-1', name: 'Body 1' }],
        sketches: [],
        features: [],
        curves: [],
        drawings: [
            {
                id: 'sheet-1',
                name: 'Sheet 1',
                size: 'A4',
                orientation: 'landscape',
                views: [
                    { id: 'view-front', kind: 'base', orientation: 'front', scale: 1, position: [100, 100] },
                    { id: 'view-top', kind: 'projected', orientation: 'top', scale: 1, position: [100, 160], parentId: 'view-front' }
                ],
                dimensions: [
                    { id: 'dim-distance', kind: 'distance', targets: [edgeRef(), edgeRef()], viewId: 'view-front' },
                    { id: 'dim-radius', kind: 'radius', targets: [edgeRef('pad-2')], viewId: 'view-top' }
                ]
            }
        ]
    };
}

function prepareOk(document: NukeCadDocument, actions: readonly DrawingChangeAction[]): PreparedDrawingEdit {
    const prepared = prepareDrawingEdit(document, actions);
    if (!prepared.ok) {
        throw new Error(prepared.message);
    }
    return prepared.result;
}

function prepareMessage(document: NukeCadDocument, actions: readonly DrawingChangeAction[]): string {
    const prepared = prepareDrawingEdit(document, actions);
    if (prepared.ok) {
        throw new Error('Expected the drawing edit to be rejected');
    }
    return prepared.message;
}

describe('prepareDrawingEdit', () => {
    it('applies a sheet size change without touching views or dimensions', () => {
        const before = drawingDocument();
        const beforeJson = JSON.stringify(before);
        const result = prepareOk(before, [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' }]);

        expect(result.sheetId).toBe('sheet-1');
        expect(result.sheetName).toBe('Sheet 1');
        expect(result.sizeBefore).toBe('A4');
        expect(result.sizeAfter).toBe('A3');
        expect(result.requiresDrawingRefresh).toBe(true);
        expect(result.views).toEqual([]);
        expect(result.dimensions).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.changes).toEqual([
            { path: 'drawings.sheet-1.size', label: 'Sheet Sheet 1 size', kind: 'update', before: 'A4', after: 'A3' }
        ]);
        expect(result.afterDocument.drawings![0].size).toBe('A3');
        expect(result.afterDocument.drawings![0].views).toHaveLength(2);
        expect(result.afterDocument.drawings![0].dimensions).toHaveLength(2);
        expect(JSON.stringify(before)).toBe(beforeJson);
    });

    it('shrinks A3 to A4 only while every view stays on the sheet', () => {
        const doc = drawingDocument();
        doc.drawings![0].size = 'A3';
        const result = prepareOk(doc, [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A4' }]);
        expect(result.sizeAfter).toBe('A4');
        expect(result.afterDocument.drawings![0].size).toBe('A4');
        expect(result.afterDocument.drawings![0].views.map((view) => view.position)).toEqual([
            [100, 100],
            [100, 160]
        ]);
        expect(result.warnings).toContain('A4 is smaller; view positions stay fixed.');

        const outside = drawingDocument();
        outside.drawings![0].size = 'A3';
        outside.drawings![0].views[1].position = [350, 250];
        expect(prepareMessage(outside, [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A4' }])).toContain('outside the A4 bounds');

        const negative = drawingDocument();
        negative.drawings![0].size = 'A3';
        negative.drawings![0].views[0].position = [-5, 100];
        expect(prepareMessage(negative, [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A4' }])).toContain('outside the A4 bounds');
    });

    it('grows A4 to A3 without shrinking warnings', () => {
        const doc = drawingDocument();
        const result = prepareOk(doc, [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' }]);
        expect(result.warnings).toEqual([]);
        expect(result.afterDocument.drawings![0].views[1].position).toEqual([100, 160]);
    });

    it('updates view scale and hidden lines in one plan row', () => {
        const doc = drawingDocument();
        const result = prepareOk(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-top', scale: 0.5, showHidden: true }]);

        expect(result.views).toEqual([
            {
                id: 'view-top',
                kind: 'projected',
                orientation: 'top',
                scaleBefore: 1,
                scaleAfter: 0.5,
                showHiddenBefore: false,
                showHiddenAfter: true
            }
        ]);
        expect(result.changes).toEqual([
            { path: 'drawings.sheet-1.views.view-top.scale', label: 'View view-top scale', kind: 'update', before: 1, after: 0.5 },
            {
                path: 'drawings.sheet-1.views.view-top.showHidden',
                label: 'View view-top hidden lines',
                kind: 'update',
                before: false,
                after: true
            }
        ]);
        expect(result.warnings).toEqual([]);
        const view = result.afterDocument.drawings![0].views.find((candidate) => candidate.id === 'view-top')!;
        expect(view.scale).toBe(0.5);
        expect(view.showHidden).toBe(true);
    });

    it('reports only the view fields that actually changed', () => {
        const doc = drawingDocument();
        doc.drawings![0].views[0].showHidden = true;
        const result = prepareOk(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 2, showHidden: true }]);
        expect(result.changes).toEqual([
            { path: 'drawings.sheet-1.views.view-front.scale', label: 'View view-front scale', kind: 'update', before: 1, after: 2 }
        ]);
        expect(result.views[0].showHiddenBefore).toBe(true);
        expect(result.views[0].showHiddenAfter).toBe(true);
    });

    it('warns about non-standard drawing scales', () => {
        const doc = drawingDocument();
        const result = prepareOk(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 0.3 }]);
        expect(result.warnings.some((warning) => warning.includes('non-standard scale'))).toBe(true);
        expect(result.afterDocument.drawings![0].views[0].scale).toBe(0.3);
    });

    it('hides and shows dimensions without deleting them', () => {
        const doc = drawingDocument();
        const hidden = prepareOk(doc, [
            { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-distance', visible: false }
        ]);
        expect(hidden.dimensions).toEqual([
            { id: 'dim-distance', kind: 'distance', viewId: 'view-front', visibleBefore: true, visibleAfter: false }
        ]);
        expect(hidden.changes).toEqual([
            {
                path: 'drawings.sheet-1.dimensions.dim-distance.hidden',
                label: 'Dimension dim-distance visibility',
                kind: 'update',
                before: false,
                after: true
            }
        ]);
        expect(hidden.afterDocument.drawings![0].dimensions).toHaveLength(2);
        expect(hidden.afterDocument.drawings![0].dimensions[0].hidden).toBe(true);

        const restore = drawingDocument();
        restore.drawings![0].dimensions[1].hidden = true;
        const shown = prepareOk(restore, [
            { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-radius', visible: true }
        ]);
        expect(shown.dimensions).toEqual([
            { id: 'dim-radius', kind: 'radius', viewId: 'view-top', visibleBefore: false, visibleAfter: true }
        ]);
        expect(shown.changes[0].before).toBe(true);
        expect(shown.changes[0].after).toBe(false);
        expect(shown.afterDocument.drawings![0].dimensions[1].hidden).toBe(false);
    });

    it('applies mixed actions in request order', () => {
        const doc = drawingDocument();
        const actions: DrawingChangeAction[] = [
            { action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' },
            { action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 2 },
            { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-distance', visible: false }
        ];
        const result = prepareOk(doc, actions);
        expect(result.actions).toBe(actions);
        expect(result.sizeAfter).toBe('A3');
        expect(result.changes.map((change) => change.path)).toEqual([
            'drawings.sheet-1.size',
            'drawings.sheet-1.views.view-front.scale',
            'drawings.sheet-1.dimensions.dim-distance.hidden'
        ]);
        expect(result.views).toHaveLength(1);
        expect(result.dimensions).toHaveLength(1);
    });

    it('accepts the full action limit', () => {
        const doc = drawingDocument();
        const sheet = doc.drawings![0];
        for (let index = 0; index < 14; index++) {
            sheet.dimensions.push({ id: `dim-extra-${index}`, kind: 'radius', targets: [edgeRef(`pad-${index}`)], viewId: 'view-front' });
        }
        const actions: DrawingChangeAction[] = sheet.dimensions.map((dimension) => ({
            action: 'setDimensionVisibility',
            sheetId: 'sheet-1',
            dimensionId: dimension.id,
            visible: false
        }));
        expect(actions).toHaveLength(DRAWING_CHANGE_LIMIT);
        const result = prepareOk(doc, actions);
        expect(result.dimensions).toHaveLength(DRAWING_CHANGE_LIMIT);
        expect(result.changes).toHaveLength(DRAWING_CHANGE_LIMIT);
    });

    it('rejects malformed, oversized, and mixed-sheet requests', () => {
        const doc = drawingDocument();
        expect(prepareMessage(doc, [])).toContain('No drawing change actions');
        const tooMany = Array.from({ length: DRAWING_CHANGE_LIMIT + 1 }, () => ({
            action: 'setSheetSize' as const,
            sheetId: 'sheet-1',
            size: 'A3' as const
        }));
        expect(prepareMessage(doc, tooMany)).toContain('Too many drawing change actions');
        expect(prepareMessage(doc, [null as unknown as DrawingChangeAction])).toContain('must be an object');
        expect(prepareMessage(doc, [{ action: 'setSheetSize', sheetId: '', size: 'A3' }])).toContain('non-empty sheet id');
        expect(
            prepareMessage(doc, [
                { action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' },
                { action: 'setDimensionVisibility', sheetId: 'sheet-2', dimensionId: 'dim-distance', visible: false }
            ])
        ).toContain('same sheet');
        expect(prepareMessage(doc, [{ action: 'setSheetSize', sheetId: 'sheet-missing', size: 'A3' }])).toContain('not found');
        expect(prepareMessage(doc, [{ action: 'renameSheet', sheetId: 'sheet-1' } as unknown as DrawingChangeAction])).toContain(
            'unknown action'
        );
    });

    it('rejects sheet size no-ops, unknown sizes, and duplicates', () => {
        const doc = drawingDocument();
        expect(prepareMessage(doc, [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A4' }])).toContain('would not change anything');
        expect(prepareMessage(doc, [{ action: 'setSheetSize', sheetId: 'sheet-1', size: 'A0' as unknown as 'A4' }])).toContain(
            "must be 'A4' or 'A3'"
        );
        expect(
            prepareMessage(doc, [
                { action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' },
                { action: 'setSheetSize', sheetId: 'sheet-1', size: 'A4' }
            ])
        ).toContain('Duplicate drawing edit for sheet');
    });

    it('rejects invalid view display actions', () => {
        const doc = drawingDocument();
        expect(prepareMessage(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: '', scale: 1 }])).toContain(
            'non-empty view id'
        );
        expect(prepareMessage(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'missing', scale: 1 }])).toContain('not found');
        expect(prepareMessage(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front' }])).toContain(
            'requires a scale or showHidden'
        );
        expect(prepareMessage(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 0.0009 }])).toContain(
            '[0.001, 1000]'
        );
        expect(prepareMessage(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 1001 }])).toContain(
            '[0.001, 1000]'
        );
        expect(prepareMessage(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: Number.NaN }])).toContain(
            '[0.001, 1000]'
        );
        expect(
            prepareMessage(doc, [
                { action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', showHidden: 'yes' as unknown as boolean }
            ])
        ).toContain('showHidden must be a boolean');
        expect(prepareMessage(doc, [{ action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 1 }])).toContain(
            'would not change anything'
        );
        expect(
            prepareMessage(doc, [
                { action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', scale: 2 },
                { action: 'setViewDisplay', sheetId: 'sheet-1', viewId: 'view-front', showHidden: true }
            ])
        ).toContain('Duplicate drawing edit for view');
    });

    it('rejects invalid dimension visibility actions', () => {
        const doc = drawingDocument();
        expect(prepareMessage(doc, [{ action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: '', visible: false }])).toContain(
            'non-empty dimension id'
        );
        expect(
            prepareMessage(doc, [{ action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'missing', visible: false }])
        ).toContain('not found');
        expect(
            prepareMessage(doc, [
                { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-distance', visible: 'no' as unknown as boolean }
            ])
        ).toContain('visibility must be a boolean');
        expect(
            prepareMessage(doc, [{ action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-distance', visible: true }])
        ).toContain('would not change anything');
        const hidden = drawingDocument();
        hidden.drawings![0].dimensions[0].hidden = true;
        expect(
            prepareMessage(hidden, [{ action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-distance', visible: false }])
        ).toContain('would not change anything');
        expect(
            prepareMessage(doc, [
                { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-distance', visible: false },
                { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'dim-distance', visible: true }
            ])
        ).toContain('Duplicate drawing edit for dimension');
    });

    it('leaves the source document unchanged after a rejected plan', () => {
        const doc = drawingDocument();
        const before = JSON.stringify(doc);
        prepareMessage(doc, [
            { action: 'setSheetSize', sheetId: 'sheet-1', size: 'A3' },
            { action: 'setDimensionVisibility', sheetId: 'sheet-1', dimensionId: 'missing', visible: false }
        ]);
        expect(JSON.stringify(doc)).toBe(before);
    });
});
