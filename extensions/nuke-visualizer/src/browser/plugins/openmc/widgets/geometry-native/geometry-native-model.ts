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
 * Tolerant JSON model for the native geometry viewer (P3-D2).
 *
 * Consumes the P3-D1 CSG→mesh extractor shape: `{ cells: [...], surfaces: [...] }`
 * where each cell carries `{ id, name?, material?, bbox: { min, max }, color? }`
 * and each surface summary carries `{ id, type, boundary? }`. Anything extra
 * (regions, lattices, universes, coefficients) is ignored — the tree groups
 * cells by material and the 3D view renders one box per cell bbox.
 *
 * Pure functions + types only; no trame, no vuetify, no DOM, no three.js.
 */

/** Axis-aligned bounding box as xyz triples (world units, usually cm). */
export interface GeometryNativeBBox {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
}

/** One CSG cell rendered as a single box mesh. */
export interface GeometryNativeCell {
    readonly id: number;
    readonly name: string;
    readonly material: string;
    readonly bbox: GeometryNativeBBox;
    /** Optional CSS hex color (`#rrggbb`); undefined means "assign from palette". */
    readonly color: string | undefined;
}

/** Lightweight surface summary (counts + tree badges only; no 3D role). */
export interface GeometryNativeSurfaceSummary {
    readonly id: number;
    readonly type: string;
    readonly boundary: string;
}

/** Validated subset of the P3-D1 extractor payload the native viewer needs. */
export interface GeometryNativeModel {
    readonly cells: GeometryNativeCell[];
    readonly surfaces: GeometryNativeSurfaceSummary[];
}

/** Tree↔3D selection: a cell pick from either side. */
export interface GeometryNativeSelection {
    readonly kind: 'cell';
    readonly id: number;
}

/** Error thrown when a geometry JSON payload fails validation. */
export class GeometryNativeModelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GeometryNativeModelError';
    }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new GeometryNativeModelError(`geometry payload field '${field}' must be an object`);
    }
    return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new GeometryNativeModelError(`geometry payload field '${field}' must be a finite number`);
    }
    return value;
}

function asTriple(value: unknown, field: string): [number, number, number] {
    if (!Array.isArray(value) || value.length !== 3) {
        throw new GeometryNativeModelError(`geometry payload field '${field}' must be an [x, y, z] triple`);
    }
    return [asFiniteNumber(value[0], `${field}[0]`), asFiniteNumber(value[1], `${field}[1]`), asFiniteNumber(value[2], `${field}[2]`)];
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function asOptionalColor(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    return typeof value === 'string' && HEX_COLOR_RE.test(value.trim()) ? value.trim() : undefined;
}

function parseCell(value: unknown, index: number): GeometryNativeCell {
    const entry = asRecord(value, `cells[${index}]`);
    const id = asFiniteNumber(entry['id'], `cells[${index}].id`);
    const name = typeof entry['name'] === 'string' && entry['name'].length > 0 ? entry['name'] : `Cell ${id}`;
    const material = typeof entry['material'] === 'string' && entry['material'].length > 0 ? entry['material'] : 'void';
    const bboxRaw = asRecord(entry['bbox'], `cells[${index}].bbox`);
    const min = asTriple(bboxRaw['min'], `cells[${index}].bbox.min`);
    const max = asTriple(bboxRaw['max'], `cells[${index}].bbox.max`);
    return { id, name, material, bbox: { min, max }, color: asOptionalColor(entry['color']) };
}

function parseSurface(value: unknown, index: number): GeometryNativeSurfaceSummary {
    const entry = asRecord(value, `surfaces[${index}]`);
    const id = asFiniteNumber(entry['id'], `surfaces[${index}].id`);
    const type = typeof entry['type'] === 'string' && entry['type'].length > 0 ? entry['type'] : 'unknown';
    const boundary = typeof entry['boundary'] === 'string' ? entry['boundary'] : 'transmission';
    return { id, type, boundary };
}

/**
 * Validate an unknown JSON value as the P3-D1 extractor shape the native
 * geometry viewer needs. Missing `cells`/`surfaces` default to empty arrays;
 * extra fields anywhere are ignored. Cells without a valid `id` or `bbox`
 * are rejected (the 3D view cannot place them); bad `color` values fall back
 * to undefined (palette assignment) rather than failing the whole payload.
 */
export function parseGeometryNativeModel(value: unknown): GeometryNativeModel {
    const root = asRecord(value, '<root>');
    const cells: GeometryNativeCell[] = [];
    if (root['cells'] !== undefined) {
        if (!Array.isArray(root['cells'])) {
            throw new GeometryNativeModelError("geometry payload field 'cells' must be an array");
        }
        (root['cells'] as unknown[]).forEach((entry, index) => cells.push(parseCell(entry, index)));
    }
    const surfaces: GeometryNativeSurfaceSummary[] = [];
    if (root['surfaces'] !== undefined) {
        if (!Array.isArray(root['surfaces'])) {
            throw new GeometryNativeModelError("geometry payload field 'surfaces' must be an array");
        }
        (root['surfaces'] as unknown[]).forEach((entry, index) => surfaces.push(parseSurface(entry, index)));
    }
    return { cells, surfaces };
}

/** Parse already-read JSON text (FileService channel); wraps SyntaxError. */
export function parseGeometryNativeJson(text: string): GeometryNativeModel {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new GeometryNativeModelError(`geometry file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseGeometryNativeModel(value);
}

/** Display name for a cell row (`<name>` plus id when they differ). */
export function cellDisplayName(cell: GeometryNativeCell): string {
    return cell.name === `Cell ${cell.id}` ? cell.name : `${cell.name} (${cell.id})`;
}

/** Index of cells by id (first wins on duplicates). */
export function cellIndexById(cells: readonly GeometryNativeCell[]): Map<number, GeometryNativeCell> {
    const index = new Map<number, GeometryNativeCell>();
    for (const cell of cells) {
        if (!index.has(cell.id)) {
            index.set(cell.id, cell);
        }
    }
    return index;
}

/** three.js object name for a cell mesh (tree↔3D sync key). */
export function meshNameForCell(id: number): string {
    return `cell:${id}`;
}

/** Cell id for a three.js object name, or undefined for foreign objects. */
export function cellIdFromMeshName(name: string): number | undefined {
    const match = /^cell:(-?\d+)$/.exec(name.trim());
    if (!match) {
        return undefined;
    }
    const id = parseInt(match[1], 10);
    return Number.isFinite(id) ? id : undefined;
}

/** Selection payload for picking a cell in the tree (drives 3D highlight). */
export function treeSelectionToHighlight(id: number): GeometryNativeSelection {
    return { kind: 'cell', id };
}

/** Selection payload for picking a mesh in the 3D view (drives tree scroll). */
export function meshNameToSelection(name: string): GeometryNativeSelection | undefined {
    const id = cellIdFromMeshName(name);
    return id === undefined ? undefined : { kind: 'cell', id };
}

/** Case-insensitive substring filter over id/name/material for the tree list. */
export function filterGeometryCells(cells: readonly GeometryNativeCell[], text: string): GeometryNativeCell[] {
    const filter = text.trim().toLowerCase();
    if (filter.length === 0) {
        return [...cells];
    }
    return cells.filter(
        (cell) =>
            cell.id.toString().includes(filter) || cell.name.toLowerCase().includes(filter) || cell.material.toLowerCase().includes(filter)
    );
}

/** Material names in first-seen order (tree group headers). */
export function materialNamesInOrder(cells: readonly GeometryNativeCell[]): string[] {
    const names: string[] = [];
    for (const cell of cells) {
        if (!names.includes(cell.material)) {
            names.push(cell.material);
        }
    }
    return names;
}

/** Overall bounds over all cell bboxes; undefined when there are no cells. */
export function geometryBounds(cells: readonly GeometryNativeCell[]): GeometryNativeBBox | undefined {
    if (cells.length === 0) {
        return undefined;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const cell of cells) {
        minX = Math.min(minX, cell.bbox.min[0], cell.bbox.max[0]);
        minY = Math.min(minY, cell.bbox.min[1], cell.bbox.max[1]);
        minZ = Math.min(minZ, cell.bbox.min[2], cell.bbox.max[2]);
        maxX = Math.max(maxX, cell.bbox.min[0], cell.bbox.max[0]);
        maxY = Math.max(maxY, cell.bbox.min[1], cell.bbox.max[1]);
        maxZ = Math.max(maxZ, cell.bbox.min[2], cell.bbox.max[2]);
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Degenerate bboxes (zero volume) cannot render as boxes; listed, not drawn. */
export function isDegenerateCell(cell: GeometryNativeCell): boolean {
    const minX = Math.min(cell.bbox.min[0], cell.bbox.max[0]);
    const minY = Math.min(cell.bbox.min[1], cell.bbox.max[1]);
    const minZ = Math.min(cell.bbox.min[2], cell.bbox.max[2]);
    const maxX = Math.max(cell.bbox.min[0], cell.bbox.max[0]);
    const maxY = Math.max(cell.bbox.min[1], cell.bbox.max[1]);
    const maxZ = Math.max(cell.bbox.min[2], cell.bbox.max[2]);
    return !(maxX > minX && maxY > minY && maxZ > minZ);
}

/** Void-cell material marker (CSG counterpart of the DAGMC graveyard switch). */
export function isVoidMaterial(material: string): boolean {
    return material.trim().toLowerCase() === 'void';
}

/**
 * Single visibility rule for a CSG cell: material toggles, per-cell
 * toggles, the void switch, and degenerate bboxes (never drawn) all
 * apply. Snapshot rows, `visibleCells()`, and the three.js `buildScene`
 * must all route through here so the outline checkbox and the canvas can
 * never disagree again.
 */
export function isGeometryCellVisible(
    cell: GeometryNativeCell,
    hiddenMaterials: readonly string[],
    hiddenCellIds: readonly number[],
    showVoid: boolean
): boolean {
    if (hiddenMaterials.includes(cell.material) || hiddenCellIds.includes(cell.id)) {
        return false;
    }
    if (!showVoid && isVoidMaterial(cell.material)) {
        return false;
    }
    return !isDegenerateCell(cell);
}

/**
 * Material-row visibility: the material hidden-set plus the void-switch
 * override (DAGMC graveyard parity) — while the switch is off, the void
 * material reads hidden even though it is not in the set.
 */
export function isGeometryMaterialVisible(material: string, hiddenMaterials: readonly string[], showVoid: boolean): boolean {
    return !hiddenMaterials.includes(material) && (showVoid || !isVoidMaterial(material));
}

/** Small deterministic palette for cells without an explicit color (dark themes). */
const CELL_PALETTE_DARK = ['#4da3ff', '#ffb84d', '#5fd68a', '#e06ba8', '#9a7bff', '#ffd24d', '#4dd6d6', '#ff7a5c'];

/**
 * Light-theme counterpart: the same eight hues, deepened for contrast on
 * light editor backgrounds (a light theme's near-black foreground would
 * silhouette vivid fills, mirroring the CAD viewport convention).
 */
const CELL_PALETTE_LIGHT = ['#1f6fd6', '#b25e00', '#1f8a4c', '#b03070', '#5b3fd6', '#8a6d00', '#0f766e', '#c2431f'];

function hashMaterial(material: string): number {
    let hash = 0;
    for (let i = 0; i < material.length; i++) {
        hash = (hash * 31 + material.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

/** Effective CSS color for a cell: explicit color wins, else palette by material for the active theme. */
export function colorForCellOnTheme(cell: GeometryNativeCell, dark: boolean): string {
    if (cell.color) {
        return cell.color;
    }
    const palette = dark ? CELL_PALETTE_DARK : CELL_PALETTE_LIGHT;
    return palette[hashMaterial(cell.material) % palette.length];
}

/** Effective CSS color for a cell on dark themes (historical palette). */
export function colorForCell(cell: GeometryNativeCell): string {
    return colorForCellOnTheme(cell, true);
}

/** Edge-line color for cell boxes (light grid on dark themes, dark slate on light ones). */
export function cellEdgeColor(dark: boolean): string {
    return dark ? '#e8e8e8' : '#33393f';
}

/** State behind the geometry canvas context menu (view actions + selection hide/isolate). */
export interface GeometryContextMenuState {
    readonly clipChecked: boolean;
    readonly selectedCellId: number | null;
    readonly hasHidden: boolean;
}

/** One canvas context-menu row (mirrors the viewer-core menu item shape without importing DOM code). */
export interface GeometryContextMenuItem {
    readonly id: string;
    readonly label: string;
    readonly icon?: string;
    readonly checked?: boolean;
    readonly separatorAbove?: boolean;
    readonly disabled?: boolean;
}

/**
 * Canvas context-menu contents for the geometry viewer: Fit / Screenshot,
 * then the clip toggle, then selection actions (Hide / Isolate the
 * selected cell, Show all while anything is hidden). Pure.
 */
export function buildGeometryContextMenuItems(state: GeometryContextMenuState): GeometryContextMenuItem[] {
    const hasSelection = state.selectedCellId !== null;
    const selectedLabel = hasSelection ? `Cell ${state.selectedCellId}` : 'selected cell';
    return [
        { id: 'fit', label: 'Fit to View', icon: 'codicon-zoom-in' },
        { id: 'screenshot', label: 'Save Screenshot (PNG)', icon: 'codicon-device-camera' },
        {
            id: 'clip',
            label: 'Clip Planes',
            icon: 'codicon-layers',
            checked: state.clipChecked,
            separatorAbove: true
        },
        {
            id: 'hide-selected',
            label: `Hide ${selectedLabel}`,
            icon: 'codicon-eye-closed',
            separatorAbove: true,
            disabled: !hasSelection
        },
        {
            id: 'isolate-selected',
            label: `Isolate ${selectedLabel}`,
            icon: 'codicon-eye',
            disabled: !hasSelection
        },
        {
            id: 'show-all',
            label: 'Show All Cells',
            icon: 'codicon-eye-watch',
            disabled: !state.hasHidden
        }
    ];
}
