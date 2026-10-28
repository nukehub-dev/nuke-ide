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
 * Tests for the native geometry viewer pure model (no DI/DOM/three.js):
 * tolerant CSG JSON parsing, tree↔3D selection mapping, filtering, bounds,
 * and palette colors.
 */

import { describe, expect, it } from 'vitest';
import {
    buildGeometryContextMenuItems,
    cellDisplayName,
    cellEdgeColor,
    cellIdFromMeshName,
    cellIndexById,
    colorForCell,
    colorForCellOnTheme,
    filterGeometryCells,
    geometryBounds,
    GeometryNativeModelError,
    isDegenerateCell,
    isGeometryCellVisible,
    isGeometryMaterialVisible,
    isVoidMaterial,
    materialNamesInOrder,
    meshNameForCell,
    meshNameToSelection,
    parseGeometryNativeJson,
    parseGeometryNativeModel,
    treeSelectionToHighlight
} from './geometry-native-model';

describe('parseGeometryNativeModel', () => {
    it('parses the CSG extractor shape', () => {
        const model = parseGeometryNativeModel({
            cells: [
                { id: 1, name: 'fuel', material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] }, color: '#ff0000' },
                { id: 2, material: 'water', bbox: { min: [-1, -1, -1], max: [2, 2, 2] } }
            ],
            surfaces: [{ id: 10, type: 'z-cylinder', boundary: 'transmission' }]
        });
        expect(model.cells.length).toBe(2);
        expect(model.cells[0]).toMatchObject({ id: 1, name: 'fuel', material: 'uo2', color: '#ff0000' });
        expect(model.cells[1]).toMatchObject({ id: 2, name: 'Cell 2', material: 'water', color: undefined });
        expect(model.surfaces).toEqual([{ id: 10, type: 'z-cylinder', boundary: 'transmission' }]);
    });

    it('ignores extras and defaults missing sections', () => {
        const model = parseGeometryNativeModel({
            cells: [{ id: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, region: '-1', lattice: [1, 2], extra: true }],
            universes: [{ id: 0 }],
            version: 'p3-d1'
        });
        expect(model.cells.length).toBe(1);
        expect(model.cells[0]).toMatchObject({ id: 1, name: 'Cell 1', material: 'void' });
        expect(model.surfaces).toEqual([]);
        expect(parseGeometryNativeModel({})).toEqual({ cells: [], surfaces: [] });
    });

    it('falls back on bad colors instead of failing the payload', () => {
        const model = parseGeometryNativeModel({
            cells: [
                { id: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, color: 'red' },
                { id: 2, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, color: '#ab12cd' }
            ]
        });
        expect(model.cells[0].color).toBeUndefined();
        expect(model.cells[1].color).toBe('#ab12cd');
    });

    it('rejects missing ids, bboxes, and bad shapes', () => {
        expect(() => parseGeometryNativeModel({ cells: [{ bbox: { min: [0, 0, 0], max: [1, 1, 1] } }] })).toThrow(GeometryNativeModelError);
        expect(() => parseGeometryNativeModel({ cells: [{ id: 1 }] })).toThrow(GeometryNativeModelError);
        expect(() => parseGeometryNativeModel({ cells: [{ id: 1, bbox: { min: [0, 0], max: [1, 1, 1] } }] })).toThrow(
            GeometryNativeModelError
        );
        expect(() => parseGeometryNativeModel({ cells: 'nope' })).toThrow(GeometryNativeModelError);
        expect(parseGeometryNativeModel({ surfaces: [{ id: 1 }] }).surfaces).toEqual([
            { id: 1, type: 'unknown', boundary: 'transmission' }
        ]);
        expect(() => parseGeometryNativeModel(null)).toThrow(GeometryNativeModelError);
    });
});

describe('parseGeometryNativeJson', () => {
    it('parses text and wraps syntax errors', () => {
        expect(parseGeometryNativeJson('{"cells": []}')).toEqual({ cells: [], surfaces: [] });
        expect(() => parseGeometryNativeJson('{oops')).toThrow(GeometryNativeModelError);
    });
});

describe('tree↔3D selection mapping', () => {
    it('round-trips mesh names and selections', () => {
        expect(meshNameForCell(7)).toBe('cell:7');
        expect(cellIdFromMeshName('cell:7')).toBe(7);
        expect(cellIdFromMeshName('block:7')).toBeUndefined();
        expect(cellIdFromMeshName('cell:abc')).toBeUndefined();
        expect(treeSelectionToHighlight(7)).toEqual({ kind: 'cell', id: 7 });
        expect(meshNameToSelection('cell:7')).toEqual({ kind: 'cell', id: 7 });
        expect(meshNameToSelection('Volume_7')).toBeUndefined();
    });

    it('indexes cells by id, first wins', () => {
        const model = parseGeometryNativeModel({
            cells: [
                { id: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
                { id: 1, name: 'dup', bbox: { min: [0, 0, 0], max: [1, 1, 1] } }
            ]
        });
        expect(cellIndexById(model.cells).get(1)?.name).toBe('Cell 1');
        expect(cellDisplayName(model.cells[0])).toBe('Cell 1');
        expect(cellDisplayName({ ...model.cells[0], name: 'fuel' })).toBe('fuel (1)');
    });
});

describe('filtering, groups, bounds', () => {
    const cells = parseGeometryNativeModel({
        cells: [
            { id: 1, name: 'fuel pin', material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
            { id: 2, name: 'clad', material: 'zr', bbox: { min: [-1, -1, -1], max: [2, 2, 2] } },
            { id: 3, name: 'moderator', material: 'water', bbox: { min: [-5, -5, -5], max: [5, 5, 5] } }
        ]
    }).cells;

    it('filters by id, name, and material', () => {
        expect(filterGeometryCells(cells, '').length).toBe(3);
        expect(filterGeometryCells(cells, 'fuel').map((c) => c.id)).toEqual([1]);
        expect(filterGeometryCells(cells, 'ZR').map((c) => c.id)).toEqual([2]);
        expect(filterGeometryCells(cells, '3').map((c) => c.id)).toEqual([3]);
        expect(filterGeometryCells(cells, 'nope')).toEqual([]);
    });

    it('lists materials in first-seen order and bounds over all cells', () => {
        expect(materialNamesInOrder(cells)).toEqual(['uo2', 'zr', 'water']);
        expect(geometryBounds(cells)).toEqual({ min: [-5, -5, -5], max: [5, 5, 5] });
        expect(geometryBounds([])).toBeUndefined();
    });

    it('flags degenerate bboxes', () => {
        expect(isDegenerateCell(cells[0])).toBe(false);
        const flat = parseGeometryNativeModel({ cells: [{ id: 9, bbox: { min: [0, 0, 0], max: [1, 1, 0] } }] }).cells[0];
        expect(isDegenerateCell(flat)).toBe(true);
    });

    it('assigns explicit colors and palette fallbacks deterministically', () => {
        const explicit = parseGeometryNativeModel({
            cells: [{ id: 1, material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] }, color: '#123456' }]
        }).cells[0];
        expect(colorForCell(explicit)).toBe('#123456');
        const a = parseGeometryNativeModel({ cells: [{ id: 1, material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] } }] }).cells[0];
        const b = parseGeometryNativeModel({ cells: [{ id: 2, material: 'uo2', bbox: { min: [0, 0, 0], max: [2, 2, 2] } }] }).cells[0];
        expect(colorForCell(a)).toBe(colorForCell(b));
        expect(colorForCell(a)).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('keeps material hues across themes with light variants deepened', () => {
        const cell = parseGeometryNativeModel({ cells: [{ id: 1, material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] } }] }).cells[0];
        expect(colorForCell(cell)).toBe(colorForCellOnTheme(cell, true));
        expect(colorForCellOnTheme(cell, false)).toMatch(/^#[0-9a-f]{6}$/);
        expect(colorForCellOnTheme(cell, false)).not.toBe(colorForCellOnTheme(cell, true));
        const explicit = parseGeometryNativeModel({
            cells: [{ id: 1, material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] }, color: '#123456' }]
        }).cells[0];
        expect(colorForCellOnTheme(explicit, false)).toBe('#123456');
    });

    it('detects void materials case-insensitively', () => {
        expect(isVoidMaterial('void')).toBe(true);
        expect(isVoidMaterial('Void')).toBe(true);
        expect(isVoidMaterial(' VOID ')).toBe(true);
        expect(isVoidMaterial('fuel')).toBe(false);
        expect(isVoidMaterial('')).toBe(false);
    });

    it('picks edge colors per theme', () => {
        expect(cellEdgeColor(true)).toMatch(/^#[0-9a-f]{6}$/);
        expect(cellEdgeColor(false)).toMatch(/^#[0-9a-f]{6}$/);
        expect(cellEdgeColor(true)).not.toBe(cellEdgeColor(false));
    });

    it('shares one visibility rule across outline and canvas', () => {
        const cells = parseGeometryNativeModel({
            cells: [
                { id: 1, material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
                { id: 2, material: 'void', bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
                { id: 3, material: 'water', bbox: { min: [0, 0, 0], max: [1, 1, 0] } }
            ]
        }).cells;
        expect(isGeometryCellVisible(cells[0], [], [], true)).toBe(true);
        expect(isGeometryCellVisible(cells[0], ['uo2'], [], true)).toBe(false);
        expect(isGeometryCellVisible(cells[0], [], [1], true)).toBe(false);
        expect(isGeometryCellVisible(cells[1], [], [], true)).toBe(true);
        expect(isGeometryCellVisible(cells[1], [], [], false)).toBe(false);
        expect(isGeometryCellVisible(cells[2], [], [], true)).toBe(false);
    });

    it('builds the canvas menu with selection-aware rows', () => {
        const items = buildGeometryContextMenuItems({ clipChecked: false, selectedCellId: 2, hasHidden: false });
        expect(items.map((entry) => entry.id)).toEqual(['fit', 'screenshot', 'clip', 'hide-selected', 'isolate-selected', 'show-all']);
        expect(items[2].checked).toBe(false);
        expect(items[3].disabled).toBe(false);
        expect(items[3].label).toContain('Cell 2');
        expect(items[5].disabled).toBe(true);
        const empty = buildGeometryContextMenuItems({ clipChecked: true, selectedCellId: null, hasHidden: true });
        expect(empty[2].checked).toBe(true);
        expect(empty[3].disabled).toBe(true);
        expect(empty[4].disabled).toBe(true);
        expect(empty[5].disabled).toBe(false);
    });

    it('reads the void material hidden while the void switch is off', () => {
        expect(isGeometryMaterialVisible('void', [], true)).toBe(true);
        expect(isGeometryMaterialVisible('void', [], false)).toBe(false);
        expect(isGeometryMaterialVisible('void', ['void'], true)).toBe(false);
        expect(isGeometryMaterialVisible('uo2', [], false)).toBe(true);
        expect(isGeometryMaterialVisible('uo2', ['uo2'], true)).toBe(false);
    });
});
