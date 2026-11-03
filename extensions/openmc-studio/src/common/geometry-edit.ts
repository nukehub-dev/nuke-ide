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
 * OpenMC Geometry Edit
 *
 * Pure validation and application for CSG surface, cell, universe, and lattice
 * additions, updates, and removals. The model is deep-cloned before any action
 * runs, so previews never share state with the project, and referential
 * removals are rejected before they can leave a dangling region or fill.
 *
 * OpenMC entity ids are independent per type: a surface and a cell may both be
 * `#1`, so the duplicate-id check is per kind. Lattice and universe ids share
 * the fill namespace in a model, but that collision is reported by
 * {@link validateGeometryModel} rather than by this low-level edit loop.
 *
 * @module openmc-studio/common
 */

import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import { OpenMCCell, OpenMCGeometry, OpenMCLattice, OpenMCRegionNode, OpenMCSurface, OpenMCUniverse } from './openmc-state-schema';

/** Maximum number of geometry actions accepted in one preview. */
export const MAX_GEOMETRY_ACTIONS = 48;

/** Geometry entity kinds that can be edited. */
export type GeometryKind = 'surface' | 'cell' | 'universe' | 'lattice';

/** One requested geometry edit. */
export type GeometryAction =
    | { action: 'add'; kind: GeometryKind; value: Record<string, unknown> }
    | { action: 'update'; kind: GeometryKind; id: number; updates: Record<string, unknown> }
    | { action: 'remove'; kind: GeometryKind; id: number };

/** Successful dry-run of a geometry action list. */
export interface GeometryEditSuccess {
    readonly ok: true;
    readonly geometry: OpenMCGeometry;
    readonly changes: readonly NukeChange[];
}

/** Rejected geometry action list. */
export interface GeometryEditFailure {
    readonly ok: false;
    readonly message: string;
}

/** Result of applying a geometry action list to a cloned model. */
export type GeometryEditResult = GeometryEditSuccess | GeometryEditFailure;

/** Any editable geometry entity. */
type GeometryEntity = OpenMCSurface | OpenMCCell | OpenMCUniverse | OpenMCLattice;

/** Plural arrays that hold the editable entity kinds. */
const KIND_PLURALS: Record<GeometryKind, 'surfaces' | 'cells' | 'universes' | 'lattices'> = {
    surface: 'surfaces',
    cell: 'cells',
    universe: 'universes',
    lattice: 'lattices'
};

/** True for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for a supported geometry kind. */
function isGeometryKind(value: unknown): value is GeometryKind {
    return value === 'surface' || value === 'cell' || value === 'universe' || value === 'lattice';
}

/** True for a positive integer id. */
function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** True for an existing-entity id; universe 0 is a real, editable universe. */
function isEntityId(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Deep-clone a JSON-compatible value. */
function cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** The entity array owned by a kind in the current working model. */
function entitiesFor(geometry: OpenMCGeometry, kind: GeometryKind): GeometryEntity[] {
    return geometry[KIND_PLURALS[kind]] as GeometryEntity[];
}

/** Next free id for a kind: one past the largest existing id (1 when empty). */
function nextId(entities: readonly GeometryEntity[]): number {
    return Math.max(0, ...entities.map((entity) => entity.id)) + 1;
}

/** Collect the (absolute) surface ids named by a region string. */
function regionStringSurfaceIds(regionString: string): number[] {
    return (regionString.match(/[+-]?\d+/g) ?? []).map((token) => Math.abs(Number.parseInt(token.replace(/[+-]/, ''), 10)));
}

/** Whether a region tree references a surface id. */
function regionReferencesSurface(region: OpenMCRegionNode | undefined, surfaceId: number): boolean {
    if (!region) {
        return false;
    }
    if (region.type === 'surface' && region.surfaceId === surfaceId) {
        return true;
    }
    return (region.children ?? []).some((child) => regionReferencesSurface(child, surfaceId));
}

/** Whether a region tree references a cell id. */
function regionReferencesCell(region: OpenMCRegionNode | undefined, cellId: number): boolean {
    if (!region) {
        return false;
    }
    if (region.type === 'cell' && region.cellId === cellId) {
        return true;
    }
    return (region.children ?? []).some((child) => regionReferencesCell(child, cellId));
}

/** Reject a cell fill that points at a missing universe or lattice. */
function cellFillError(cell: OpenMCCell, geometry: OpenMCGeometry): string | undefined {
    if (cell.fillType === 'universe') {
        if (cell.fillId === undefined) {
            return `Cell #${cell.id} is filled with a universe but has no fill ID.`;
        }
        if (!geometry.universes.some((universe) => universe.id === cell.fillId)) {
            return `Cell #${cell.id} fills universe #${cell.fillId}, which does not exist.`;
        }
    }
    if (cell.fillType === 'lattice') {
        if (cell.fillId === undefined) {
            return `Cell #${cell.id} is filled with a lattice but has no fill ID.`;
        }
        if (!geometry.lattices.some((lattice) => lattice.id === cell.fillId)) {
            return `Cell #${cell.id} fills lattice #${cell.fillId}, which does not exist.`;
        }
    }
    return undefined;
}

/** Explain why a surface cannot be removed, if anything references it. */
function surfaceRemovalError(geometry: OpenMCGeometry, surfaceId: number): string | undefined {
    for (const cell of geometry.cells) {
        const inTree = regionReferencesSurface(cell.region, surfaceId);
        const inString = cell.regionString !== undefined && regionStringSurfaceIds(cell.regionString).includes(surfaceId);
        if (inTree || inString) {
            return `Surface #${surfaceId} is used by cell #${cell.id}. Remove it from the cell region first.`;
        }
    }
    return undefined;
}

/** Explain why a cell cannot be removed, if anything references it. */
function cellRemovalError(geometry: OpenMCGeometry, cellId: number): string | undefined {
    const universe = geometry.universes.find((candidate) => (candidate.cellIds ?? []).includes(cellId));
    if (universe) {
        return `Cell #${cellId} belongs to universe #${universe.id}. Remove it from the universe first.`;
    }
    const regionCell = geometry.cells.find((candidate) => candidate.id !== cellId && regionReferencesCell(candidate.region, cellId));
    if (regionCell) {
        return `Cell #${cellId} is referenced by cell #${regionCell.id}'s region. Remove that reference first.`;
    }
    return undefined;
}

/** Explain why a universe cannot be removed, if anything references it. */
function universeRemovalError(geometry: OpenMCGeometry, universeId: number): string | undefined {
    if (universeId === geometry.rootUniverseId) {
        return `Universe #${universeId} is the root universe and cannot be removed.`;
    }
    const filledCell = geometry.cells.find((cell) => cell.fillType === 'universe' && cell.fillId === universeId);
    if (filledCell) {
        return `Universe #${universeId} is filled by cell #${filledCell.id}. Change the cell fill first.`;
    }
    for (const lattice of geometry.lattices) {
        if (lattice.outer === universeId) {
            return `Universe #${universeId} is the outer fill of lattice #${lattice.id}. Clear the outer fill first.`;
        }
        if ((lattice.universes ?? []).flat(2).includes(universeId)) {
            return `Universe #${universeId} is used by lattice #${lattice.id}. Replace it in the lattice first.`;
        }
    }
    return undefined;
}

/** Explain why a lattice cannot be removed, if anything references it. */
function latticeRemovalError(geometry: OpenMCGeometry, latticeId: number): string | undefined {
    const filledCell = geometry.cells.find((cell) => cell.fillType === 'lattice' && cell.fillId === latticeId);
    if (filledCell) {
        return `Lattice #${latticeId} is filled by cell #${filledCell.id}. Change the cell fill first.`;
    }
    return undefined;
}

/** Apply one add action to the working model. */
function applyAdd(geometry: OpenMCGeometry, kind: GeometryKind, value: unknown, changes: NukeChange[]): string | undefined {
    if (!isRecord(value)) {
        return `The ${kind} value must be an object.`;
    }
    const entities = entitiesFor(geometry, kind);
    const requestedId = value.id;
    let id: number;
    if (requestedId === undefined) {
        id = nextId(entities);
    } else if (!isPositiveInteger(requestedId)) {
        return `A ${kind} id must be a positive integer.`;
    } else if (entities.some((entity) => entity.id === requestedId)) {
        return `A ${kind} with id #${requestedId} already exists.`;
    } else {
        id = requestedId;
    }

    const entity = cloneValue({ ...value, id }) as unknown as GeometryEntity;
    entities.push(entity);
    changes.push({
        path: `geometry.${KIND_PLURALS[kind]}.${id}`,
        label: `Add ${kind} #${id}`,
        kind: 'add',
        after: cloneValue(entity)
    });
    return undefined;
}

/** Apply one update action to the working model. */
function applyUpdate(
    geometry: OpenMCGeometry,
    kind: GeometryKind,
    rawId: unknown,
    updates: unknown,
    changes: NukeChange[]
): string | undefined {
    if (!isEntityId(rawId)) {
        return `Each update action needs a non-negative integer id.`;
    }
    if (!isRecord(updates) || Object.keys(updates).length === 0) {
        return `The update for ${kind} #${rawId} needs at least one field.`;
    }
    if ('id' in updates && updates.id !== rawId) {
        return `The ${kind} id cannot be changed.`;
    }
    const entities = entitiesFor(geometry, kind);
    const index = entities.findIndex((entity) => entity.id === rawId);
    if (index < 0) {
        return `A ${kind} with id #${rawId} does not exist.`;
    }

    const before = entities[index];
    const next = cloneValue({ ...before, ...updates, id: rawId }) as unknown as GeometryEntity;
    if (kind === 'cell' && ('fillId' in updates || 'fillType' in updates)) {
        const error = cellFillError(next as OpenMCCell, geometry);
        if (error) {
            return error;
        }
    }

    entities[index] = next;
    changes.push({
        path: `geometry.${KIND_PLURALS[kind]}.${rawId}`,
        label: `Update ${kind} #${rawId}`,
        kind: 'update',
        before: cloneValue(before),
        after: cloneValue(next)
    });
    return undefined;
}

/** Apply one remove action to the working model. */
function applyRemove(geometry: OpenMCGeometry, kind: GeometryKind, rawId: unknown, changes: NukeChange[]): string | undefined {
    if (!isEntityId(rawId)) {
        return `Each remove action needs a non-negative integer id.`;
    }
    const entities = entitiesFor(geometry, kind);
    const index = entities.findIndex((entity) => entity.id === rawId);
    if (index < 0) {
        return `A ${kind} with id #${rawId} does not exist.`;
    }

    let error: string | undefined;
    if (kind === 'surface') {
        error = surfaceRemovalError(geometry, rawId);
    } else if (kind === 'cell') {
        error = cellRemovalError(geometry, rawId);
    } else if (kind === 'universe') {
        error = universeRemovalError(geometry, rawId);
    } else {
        error = latticeRemovalError(geometry, rawId);
    }
    if (error) {
        return error;
    }

    const [removed] = entities.splice(index, 1);
    changes.push({
        path: `geometry.${KIND_PLURALS[kind]}.${rawId}`,
        label: `Remove ${kind} #${rawId}`,
        kind: 'remove',
        before: cloneValue(removed)
    });
    return undefined;
}

/**
 * Apply geometry actions to a cloned model and produce one diff row per action.
 *
 * Actions run in order against the working clone, so an add earlier in the
 * list satisfies a fill or region reference used by a later action. The input
 * geometry is never mutated.
 *
 * @param geometry - Current CSG geometry.
 * @param actions - Add, update, and remove actions to dry-run.
 * @returns The edited clone plus diff rows, or a rejection message.
 */
export function applyGeometryActions(geometry: OpenMCGeometry, actions: readonly GeometryAction[]): GeometryEditResult {
    if (actions.length < 1 || actions.length > MAX_GEOMETRY_ACTIONS) {
        return { ok: false, message: `Provide between 1 and ${MAX_GEOMETRY_ACTIONS} geometry actions.` };
    }

    const working = cloneValue(geometry);
    const changes: NukeChange[] = [];
    for (const raw of actions) {
        const action = raw as unknown as Record<string, unknown>;
        const kind = action.kind;
        if (!isGeometryKind(kind)) {
            return { ok: false, message: 'Each geometry action needs a kind of surface, cell, universe, or lattice.' };
        }

        let error: string | undefined;
        if (action.action === 'add') {
            error = applyAdd(working, kind, action.value, changes);
        } else if (action.action === 'update') {
            error = applyUpdate(working, kind, action.id, action.updates, changes);
        } else if (action.action === 'remove') {
            error = applyRemove(working, kind, action.id, changes);
        } else {
            return { ok: false, message: 'Each geometry action must be add, update, or remove.' };
        }
        if (error) {
            return { ok: false, message: error };
        }
    }
    return { ok: true, geometry: working, changes };
}
