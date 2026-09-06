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
import {
    DRAWING_GRID_SNAP_MM,
    clampSheetPosition,
    isPointOnSheet,
    layoutDrawingLabels,
    lockProjectedViewPosition,
    pointerToSheetMm,
    sectionLineEndpoints,
    sheetDimensions,
    sheetMmToSvg,
    snapDrawingPosition,
    validateDrawingSheet,
    type DrawingSheet,
    type DrawingValidationSink
} from './cad-drawing';
import { type TopologyRef } from './topology-refs';

function edgeRef(featureId = 'pad-1'): TopologyRef {
    return {
        featureId,
        kind: 'edge',
        fingerprint: { curveType: 'line', length: 10, start: [0, 0, 0], end: [10, 0, 0] }
    };
}

function validSheet(): DrawingSheet {
    return {
        id: 'sheet-1',
        name: 'Sheet 1',
        size: 'A4',
        orientation: 'landscape',
        views: [
            { id: 'view-base', kind: 'base', orientation: 'front', scale: 1, position: [100, 100] },
            { id: 'view-top', kind: 'projected', orientation: 'top', scale: 1, position: [100, 160], parentId: 'view-base' }
        ],
        dimensions: [{ id: 'dim-1', kind: 'distance', targets: [edgeRef(), edgeRef()], viewId: 'view-base' }]
    };
}

function collectIssues(sheet: unknown): { path: string; message: string }[] {
    const issues: { path: string; message: string }[] = [];
    const claimed = new Set<string>();
    const sink: DrawingValidationSink = {
        issue: (path, message) => issues.push({ path, message }),
        claimId: (path, id) => {
            if (typeof id !== 'string' || id.length === 0) {
                issues.push({ path, message: 'missing or invalid id' });
                return;
            }
            if (claimed.has(id)) {
                issues.push({ path, message: `duplicate id '${id}'` });
                return;
            }
            claimed.add(id);
        }
    };
    validateDrawingSheet(sheet, 'drawings[0]', sink);
    return issues;
}

describe('drawing sheet sizes', () => {
    it('defines A4/A3 landscape dimensions in mm', () => {
        expect(sheetDimensions('A4')).toEqual({ width: 297, height: 210 });
        expect(sheetDimensions('A3')).toEqual({ width: 420, height: 297 });
    });

    it('rejects unknown sheet sizes', () => {
        expect(() => sheetDimensions('A0' as 'A4')).toThrow();
    });
});

describe('validateDrawingSheet', () => {
    it('accepts a well-formed sheet', () => {
        expect(collectIssues(validSheet())).toEqual([]);
    });

    it('accepts section and detail views with their required payload', () => {
        const sheet = validSheet();
        sheet.views.push(
            {
                id: 'view-sec',
                kind: 'section',
                orientation: 'front',
                scale: 1,
                position: [200, 100],
                parentId: 'view-base',
                sectionAxis: 'x',
                sectionFraction: 0.5
            },
            {
                id: 'view-det',
                kind: 'detail',
                orientation: 'front',
                scale: 2,
                position: [250, 160],
                parentId: 'view-base',
                detailCenter: [5, 5],
                detailRadius: 10
            }
        );
        sheet.dimensions.push({ id: 'dim-2', kind: 'radius', targets: [edgeRef()], viewId: 'view-det', stale: true });
        expect(collectIssues(sheet)).toEqual([]);
    });

    it('rejects unknown sizes, orientations, kinds, and orientations', () => {
        const sheet = { ...validSheet(), size: 'A0', orientation: 'portrait' };
        const issues = collectIssues(sheet);
        expect(issues.some((i) => i.path === 'drawings[0].size')).toBe(true);
        expect(issues.some((i) => i.path === 'drawings[0].orientation')).toBe(true);
    });

    it('rejects non-base views without a parent and base views with one', () => {
        const sheet = validSheet();
        sheet.views = [
            { id: 'view-base', kind: 'base', orientation: 'front', scale: 1, position: [100, 100], parentId: 'view-top' },
            { id: 'view-top', kind: 'projected', orientation: 'top', scale: 1, position: [100, 160] }
        ];
        const issues = collectIssues(sheet);
        expect(issues.some((i) => i.path === 'drawings[0].views[0].parentId')).toBe(true);
        expect(issues.some((i) => i.path === 'drawings[0].views[1].parentId')).toBe(true);
    });

    it('rejects dangling parentId and viewId references', () => {
        const sheet = validSheet();
        sheet.views[1].parentId = 'view-missing';
        sheet.dimensions[0].viewId = 'view-missing';
        const issues = collectIssues(sheet);
        expect(issues.some((i) => i.path === 'drawings[0].views[1].parentId')).toBe(true);
        expect(issues.some((i) => i.path === 'drawings[0].dimensions[0].viewId')).toBe(true);
    });

    it('enforces dimension target arity per kind', () => {
        const sheet = validSheet();
        sheet.dimensions = [{ id: 'dim-1', kind: 'radius', targets: [edgeRef(), edgeRef()], viewId: 'view-base' }];
        const issues = collectIssues(sheet);
        expect(issues.some((i) => i.path === 'drawings[0].dimensions[0].targets')).toBe(true);
    });

    it('rejects section views without an axis and detail views without a circle', () => {
        const sheet = validSheet();
        sheet.views.push(
            { id: 'view-sec', kind: 'section', orientation: 'front', scale: 1, position: [200, 100], parentId: 'view-base' },
            { id: 'view-det', kind: 'detail', orientation: 'front', scale: 1, position: [250, 100], parentId: 'view-base' }
        );
        const issues = collectIssues(sheet);
        expect(issues.some((i) => i.path === 'drawings[0].views[2].sectionAxis')).toBe(true);
        expect(issues.some((i) => i.path === 'drawings[0].views[3].detailCenter')).toBe(true);
        expect(issues.some((i) => i.path === 'drawings[0].views[3].detailRadius')).toBe(true);
    });

    it('rejects duplicate ids within the sheet', () => {
        const sheet = validSheet();
        sheet.views.push({ id: 'view-base', kind: 'projected', orientation: 'top', scale: 1, position: [100, 160], parentId: 'view-base' });
        expect(collectIssues(sheet).some((i) => i.message.includes('duplicate id'))).toBe(true);
    });
});

describe('sheet math', () => {
    it('snaps to the 5 mm grid by default', () => {
        expect(DRAWING_GRID_SNAP_MM).toBe(5);
        expect(snapDrawingPosition(12)).toBe(10);
        expect(snapDrawingPosition(13)).toBe(15);
        expect(snapDrawingPosition(12.5)).toBe(15);
    });

    it('maps client pointers to sheet mm with a flipped y', () => {
        const rect = { left: 10, top: 20, width: 594, height: 420 };
        expect(pointerToSheetMm(10, 20, rect, 297, 210)).toEqual([0, 210]);
        expect(pointerToSheetMm(604, 440, rect, 297, 210)).toEqual([297, 0]);
        expect(pointerToSheetMm(307, 230, rect, 297, 210)).toEqual([148.5, 105]);
    });

    it('maps sheet mm to SVG units with a flipped y', () => {
        expect(sheetMmToSvg(10, 200, 210)).toEqual([10, 10]);
        expect(sheetMmToSvg(0, 0, 210)).toEqual([0, 210]);
    });

    it('locks projected alignment axes to the parent', () => {
        const parent: [number, number] = [100, 100];
        expect(lockProjectedViewPosition('top', parent, [120, 160])).toEqual([100, 160]);
        expect(lockProjectedViewPosition('front', parent, [120, 160])).toEqual([100, 160]);
        expect(lockProjectedViewPosition('right', parent, [200, 130])).toEqual([200, 100]);
        expect(lockProjectedViewPosition('iso', parent, [200, 130])).toEqual([200, 130]);
    });

    it('clamps positions to the sheet and reports containment', () => {
        expect(clampSheetPosition([-5, 300], 297, 210)).toEqual([0, 210]);
        expect(clampSheetPosition([150, 100], 297, 210)).toEqual([150, 100]);
        expect(isPointOnSheet([150, 100], 297, 210)).toBe(true);
        expect(isPointOnSheet([300, 100], 297, 210)).toBe(false);
    });

    it('draws section lines across the parent center', () => {
        expect(sectionLineEndpoints([100, 100], 30, 'x')).toEqual([
            [70, 100],
            [130, 100]
        ]);
        expect(sectionLineEndpoints([100, 100], 30, 'y')).toEqual([
            [100, 70],
            [100, 130]
        ]);
        expect(sectionLineEndpoints([100, 100], 30, 'z')).toEqual([
            [100, 70],
            [100, 130]
        ]);
    });

    it('stacks overlapping labels downward without moving free ones', () => {
        const laidOut = layoutDrawingLabels(
            [
                { id: 'a', x: 50, y: 50, width: 24, height: 8 },
                { id: 'b', x: 50, y: 50, width: 24, height: 8 },
                { id: 'c', x: 200, y: 100, width: 24, height: 8 }
            ],
            297,
            210
        );
        expect(laidOut.get('a')).toEqual({ x: 50, y: 50 });
        expect(laidOut.get('b')!.y).toBeGreaterThan(50);
        expect(laidOut.get('c')).toEqual({ x: 200, y: 100 });
    });
});
