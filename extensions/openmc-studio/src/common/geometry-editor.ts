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
 * Pure editor-model helpers for the CSG Builder.
 *
 * The widget stays a thin renderer: validation grouping, lattice brush
 * operations, fill-target search, and form parsing live here so they can be
 * unit-tested without React or Theia. Validation itself remains in
 * `geometry-validation.ts`; this module only sorts its issues into tabs.
 *
 * @module openmc-studio/common
 */

import { hexLatticeRingSizes } from './geometry-lattices';
import { OpenMCFillType, OpenMCGeometry, OpenMCState, OpenMCSurface, OpenMCSurfaceType, OpenMCUniverse } from './openmc-state-schema';
import type { ValidationIssue } from './openmc-studio-protocol';

/** Geometry tabs in the CSG Builder. */
export type GeometryEditorTab = 'surfaces' | 'cells' | 'universes' | 'lattices';

/** Display labels for the geometry tabs. */
export const GEOMETRY_TAB_LABELS: Record<GeometryEditorTab, string> = {
    surfaces: 'Surfaces',
    cells: 'Cells',
    universes: 'Universes',
    lattices: 'Lattices'
};

/** Issues that belong to one geometry tab. */
export interface GeometryIssueGroup {
    tab: GeometryEditorTab;
    label: string;
    issues: ValidationIssue[];
}

/** Grouped validation result for the geometry view banner. */
export interface GeometryIssueSummary {
    errors: number;
    warnings: number;
    groups: GeometryIssueGroup[];
}

/** Plane surface types eligible for a periodic pair. */
const PLANE_TYPES = new Set<OpenMCSurfaceType>(['x-plane', 'y-plane', 'z-plane', 'plane']);

/** Whether a surface type can carry a periodic boundary. */
export function isPlaneSurface(type: OpenMCSurfaceType): boolean {
    return PLANE_TYPES.has(type);
}

/**
 * Map a validation issue to the tab that owns it.
 *
 * The state path wins when present; otherwise the message names the entity.
 * @param issue - Validation issue from the geometry model.
 * @returns Owning geometry tab.
 */
export function geometryIssueTab(issue: ValidationIssue): GeometryEditorTab {
    const pathMatch = issue.path?.match(/^geometry\.(surfaces|cells|universes|lattices)\./);
    if (pathMatch) {
        return pathMatch[1] as GeometryEditorTab;
    }

    const message = issue.message.toLowerCase();
    if (message.includes('lattice')) {
        return 'lattices';
    }
    if (message.includes('surface') || message.includes('periodic') || message.includes('albedo')) {
        return 'surfaces';
    }
    if (message.includes('universe')) {
        return 'universes';
    }
    return 'cells';
}

/**
 * DOM anchor id for the element that owns an issue, when one can be derived.
 * @param issue - Validation issue.
 * @returns Element id (`csg-focus-<tab>-<id>`), or undefined.
 */
export function geometryIssueAnchor(issue: ValidationIssue): string | undefined {
    const pathMatch = issue.path?.match(/^geometry\.(surfaces|cells|universes|lattices)\.(\d+)/);
    if (pathMatch) {
        return `csg-focus-${pathMatch[1]}-${pathMatch[2]}`;
    }
    const idMatch = issue.message.match(/#(\d+)/);
    if (idMatch) {
        return `csg-focus-${geometryIssueTab(issue)}-${idMatch[1]}`;
    }
    return undefined;
}

/**
 * Group issues by tab and count severities for the validation banner.
 * @param issues - Issues returned by `validateGeometryModel`.
 * @returns Counts plus non-empty groups in tab order.
 */
export function summarizeGeometryIssues(issues: readonly ValidationIssue[]): GeometryIssueSummary {
    const order: GeometryEditorTab[] = ['surfaces', 'cells', 'universes', 'lattices'];
    const byTab = new Map<GeometryEditorTab, ValidationIssue[]>();
    let errors = 0;
    let warnings = 0;
    for (const issue of issues) {
        if (issue.severity === 'error') {
            errors++;
        } else if (issue.severity === 'warning') {
            warnings++;
        }
        const tab = geometryIssueTab(issue);
        const bucket = byTab.get(tab) ?? [];
        bucket.push(issue);
        byTab.set(tab, bucket);
    }
    const groups = order
        .filter((tab) => (byTab.get(tab)?.length ?? 0) > 0)
        .map((tab) => ({ tab, label: GEOMETRY_TAB_LABELS[tab], issues: byTab.get(tab)! }));
    return { errors, warnings, groups };
}

// ============================================================================
// Lattice brush operations
// ============================================================================

/** Position in a rectangular lattice's `[z][y][x]` array. */
export interface RectLatticePosition {
    kind: 'rect';
    z: number;
    y: number;
    x: number;
}

/** Position in a hexagonal lattice's `[z][ring][theta]` array. */
export interface HexLatticePosition {
    kind: 'hex';
    z: number;
    ring: number;
    theta: number;
}

/** A single universe slot in either lattice type. */
export type LatticePosition = RectLatticePosition | HexLatticePosition;

/** Deep-copy a nested lattice universe array. */
function cloneUniverses(universes: number[][][]): number[][][] {
    return universes.map((slice) => slice.map((row) => [...row]));
}

/**
 * Assign one lattice position, returning a new array.
 * @param universes - Current nested array.
 * @param position - Target slot.
 * @param universeId - Universe ID to write.
 * @returns Updated copy; out-of-range positions are ignored.
 */
export function setLatticePosition(universes: number[][][], position: LatticePosition, universeId: number): number[][][] {
    const next = cloneUniverses(universes);
    if (position.kind === 'rect') {
        const row = next[position.z]?.[position.y];
        if (row && position.x >= 0 && position.x < row.length) {
            row[position.x] = universeId;
        }
    } else {
        const ring = next[position.z]?.[position.ring];
        if (ring && position.theta >= 0 && position.theta < ring.length) {
            ring[position.theta] = universeId;
        }
    }
    return next;
}

/**
 * Fill one rectangular row with a universe.
 * @param universes - Current nested array.
 * @param z - Axial slice.
 * @param y - Row index (0 is the top row).
 * @param universeId - Universe ID to write.
 * @returns Updated copy.
 */
export function fillLatticeRow(universes: number[][][], z: number, y: number, universeId: number): number[][][] {
    const next = cloneUniverses(universes);
    const row = next[z]?.[y];
    if (row) {
        next[z][y] = row.map(() => universeId);
    }
    return next;
}

/**
 * Fill one hexagonal ring with a universe.
 * @param universes - Current nested array.
 * @param z - Axial slice.
 * @param ring - Ring index (0 is outermost).
 * @param universeId - Universe ID to write.
 * @returns Updated copy.
 */
export function fillLatticeRing(universes: number[][][], z: number, ring: number, universeId: number): number[][][] {
    const next = cloneUniverses(universes);
    const entries = next[z]?.[ring];
    if (entries) {
        next[z][ring] = entries.map(() => universeId);
    }
    return next;
}

/**
 * Fill every position with a universe.
 * @param universes - Current nested array.
 * @param universeId - Universe ID to write.
 * @returns Updated copy.
 */
export function fillAllLatticeUniverses(universes: number[][][], universeId: number): number[][][] {
    return universes.map((slice) => slice.map((row) => row.map(() => universeId)));
}

/**
 * Clear every position to universe 0 (an explicitly unassigned slot).
 * @param universes - Current nested array.
 * @returns Updated copy.
 */
export function clearLatticeUniverses(universes: number[][][]): number[][][] {
    return fillAllLatticeUniverses(universes, 0);
}

/**
 * Unique universe IDs referenced by a lattice, including the outer fill.
 * @param lattice - Lattice definition.
 * @returns Sorted unique IDs.
 */
export function latticeReferencedUniverses(lattice: OpenMCGeometry['lattices'][number]): number[] {
    const ids = new Set<number>(Array.isArray(lattice.universes) ? (lattice.universes.flat(2) as number[]) : []);
    if (lattice.outer !== undefined) {
        ids.add(lattice.outer);
    }
    return Array.from(ids).sort((a, b) => a - b);
}

/**
 * Referenced universes that exist but have no cells (OpenMC drops them).
 * @param lattice - Lattice definition.
 * @param universes - Universe list from the model.
 * @returns Universe IDs with zero cells, in sorted order.
 */
export function emptyLatticeUniverses(lattice: OpenMCGeometry['lattices'][number], universes: readonly OpenMCUniverse[]): number[] {
    const cellsByUniverse = new Map(universes.map((universe) => [universe.id, universe.cellIds.length]));
    return latticeReferencedUniverses(lattice).filter((id) => cellsByUniverse.get(id) === 0);
}

/** Total number of universe slots in a lattice. */
export function latticePositionCount(lattice: OpenMCGeometry['lattices'][number]): number {
    const universes = lattice.universes ?? [];
    return universes.reduce((total, slice) => total + slice.reduce((rowTotal, row) => rowTotal + row.length, 0), 0);
}

/** Format a number for a compact summary. */
function formatNumber(value: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(4)));
}

/**
 * Compact one-line lattice summary (dimensions, pitch, positions).
 * @param lattice - Lattice definition.
 * @returns Summary string.
 */
export function latticeSummary(lattice: OpenMCGeometry['lattices'][number]): string {
    const positions = latticePositionCount(lattice);
    const universeCount = latticeReferencedUniverses(lattice).filter((id) => id !== 0).length;
    if (lattice.type === 'rect') {
        const dimensions =
            lattice.dimensions?.length === 3 ? lattice.dimensions : [lattice.dimensions?.[0] ?? 0, lattice.dimensions?.[1] ?? 0, 1];
        return `${dimensions.join('×')} · pitch ${lattice.pitch.map(formatNumber).join(' × ')} · ${positions} ${
            positions === 1 ? 'position' : 'positions'
        }, ${universeCount} ${universeCount === 1 ? 'universe' : 'universes'}`;
    }
    const axial = lattice.nAxial && lattice.nAxial > 1 ? `${lattice.nAxial} axial` : '2D';
    return `${lattice.rings} rings · ${axial} · pitch ${lattice.pitch.map(formatNumber).join(' × ')} · ${positions} ${
        positions === 1 ? 'position' : 'positions'
    }, ${universeCount} ${universeCount === 1 ? 'universe' : 'universes'}`;
}

/**
 * Number of universes per ring, outermost first (used by the ring editor).
 * @param rings - Ring count including the center ring.
 * @returns Ring sizes.
 */
export function latticeRingSizes(rings: number): number[] {
    return hexLatticeRingSizes(rings);
}

// ============================================================================
// Fill target picker
// ============================================================================

/** Kinds of non-void cell fill targets. */
export type FillTargetKind = 'material' | 'universe' | 'lattice';

/** One selectable fill target. */
export interface FillTarget {
    kind: FillTargetKind;
    id: number;
    /** `#id name` line shown in the picker. */
    label: string;
    /** Type badge text. */
    badge: string;
    /** Lower-case haystack for search. */
    searchText: string;
}

/** Fill targets grouped by kind. */
export interface FillTargetGroup {
    kind: FillTargetKind;
    label: string;
    targets: FillTarget[];
}

/**
 * Build the grouped fill targets for the cell editor. Universe 0 (the root) is
 * excluded because OpenMC cannot use it as a fill.
 * @param state - Current model.
 * @returns Non-empty groups in material/universe/lattice order.
 */
export function buildFillTargetGroups(state: OpenMCState): FillTargetGroup[] {
    const materials: FillTargetGroup = {
        kind: 'material',
        label: 'Materials',
        targets: state.materials.map((material) => ({
            kind: 'material',
            id: material.id,
            label: `#${material.id} ${material.name}`,
            badge: 'Material',
            searchText: `#${material.id} ${material.name} material`.toLowerCase()
        }))
    };
    const universes: FillTargetGroup = {
        kind: 'universe',
        label: 'Universes',
        targets: state.geometry.universes
            .filter((universe) => universe.id !== 0)
            .map((universe) => {
                const name = universe.name || `Universe ${universe.id}`;
                return {
                    kind: 'universe',
                    id: universe.id,
                    label: `#${universe.id} ${name}`,
                    badge: 'Universe',
                    searchText: `#${universe.id} ${name} universe`.toLowerCase()
                };
            })
    };
    const lattices: FillTargetGroup = {
        kind: 'lattice',
        label: 'Lattices',
        targets: state.geometry.lattices.map((lattice) => {
            const name = lattice.name || `Lattice ${lattice.id}`;
            const kind = lattice.type === 'hex' ? 'Hexagonal lattice' : 'Rectangular lattice';
            return {
                kind: 'lattice',
                id: lattice.id,
                label: `#${lattice.id} ${name}`,
                badge: lattice.type === 'hex' ? 'Hex lattice' : 'Rect lattice',
                searchText: `#${lattice.id} ${name} lattice ${kind}`.toLowerCase()
            };
        })
    };
    return [materials, universes, lattices].filter((group) => group.targets.length > 0);
}

/**
 * Filter grouped fill targets by a free-text query.
 * @param groups - Groups from {@link buildFillTargetGroups}.
 * @param query - Case-insensitive search text.
 * @returns Groups with matching targets; empty groups removed.
 */
export function filterFillTargetGroups(groups: readonly FillTargetGroup[], query: string): FillTargetGroup[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
        return [...groups];
    }
    return groups
        .map((group) => ({ ...group, targets: group.targets.filter((target) => target.searchText.includes(normalized)) }))
        .filter((group) => group.targets.length > 0);
}

/**
 * Find one fill target by kind and id.
 * @param groups - Groups from {@link buildFillTargetGroups}.
 * @param kind - Fill kind.
 * @param id - Target ID.
 * @returns The target, or undefined.
 */
export function findFillTarget(groups: readonly FillTargetGroup[], kind: FillTargetKind, id: number | undefined): FillTarget | undefined {
    if (id === undefined) {
        return undefined;
    }
    return groups.find((group) => group.kind === kind)?.targets.find((target) => target.id === id);
}

// ============================================================================
// Periodic partners
// ============================================================================

/**
 * Candidate partners for a periodic surface: other plane surfaces with a
 * periodic boundary, never the surface itself.
 * @param surfaces - All surfaces.
 * @param surfaceId - Surface being edited.
 * @returns Candidate list.
 */
export function periodicPartnerCandidates(surfaces: readonly OpenMCSurface[], surfaceId?: number): OpenMCSurface[] {
    return surfaces.filter((surface) => surface.id !== surfaceId && surface.boundary === 'periodic' && isPlaneSurface(surface.type));
}

// ============================================================================
// Form parsing (inline validation)
// ============================================================================

/** Parsed optional three-value form vector. */
export interface OptionalVectorInput {
    value?: [number, number, number];
    error?: string;
}

/**
 * Parse a rotation/translation form vector. All blank means "unset"; a partial
 * or non-numeric entry is an error.
 * @param values - Three raw input strings.
 * @param label - Human-readable field name for the error message.
 * @returns Parsed tuple or an inline error.
 */
export function parseOptionalVectorInput(values: readonly string[], label: string): OptionalVectorInput {
    const trimmed = values.map((value) => value.trim());
    if (trimmed.every((value) => value.length === 0)) {
        return {};
    }
    if (trimmed.some((value) => value.length === 0)) {
        return { error: `${label} needs all three values or all three blank.` };
    }
    const parsed = trimmed.map((value) => Number(value));
    if (parsed.some((value) => !Number.isFinite(value))) {
        return { error: `${label} values must be numbers.` };
    }
    return { value: parsed as [number, number, number] };
}

/**
 * Parse the optional per-cell density override.
 * @param value - Raw input.
 * @returns Parsed density or an inline error.
 */
export function parseDensityOverride(value: string): { value?: number; error?: string } {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return {};
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return { error: 'Density override must be greater than zero; leave blank to use the material density.' };
    }
    return { value: parsed };
}

/**
 * Inline error for a missing non-void fill target.
 * @param fillType - Selected fill kind.
 * @param fillId - Selected target id.
 * @returns Error message, or undefined.
 */
export function fillTargetError(fillType: OpenMCFillType, fillId: number | undefined): string | undefined {
    if (fillType === 'void') {
        return undefined;
    }
    if (fillId === undefined || fillId <= 0) {
        return `Select a ${fillType} for this cell.`;
    }
    return undefined;
}

/**
 * Parse the optional surface albedo. OpenMC requires a positive multiplier;
 * values above 1 are legal but unphysical and surface as a warning.
 * @param value - Raw input.
 * @returns Parsed albedo, error, or warning.
 */
export function parseAlbedoInput(value: string): { value?: number; error?: string; warning?: string } {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return {};
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return { error: 'Albedo must be a number greater than zero (1 is the OpenMC default).' };
    }
    if (parsed > 1) {
        return { value: parsed, warning: 'Albedo above 1 increases particle weight and can produce unphysical results.' };
    }
    return { value: parsed };
}
