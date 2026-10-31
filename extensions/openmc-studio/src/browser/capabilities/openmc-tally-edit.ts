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
 * OpenMC Tally Edit
 *
 * Pure validation, diff, and snapshot helpers for the tally fields NukeAI may
 * edit: name, scores, nuclides, estimator, multiply density, and higher
 * moments. Filters are accepted when adding a tally (shallow validation only)
 * and are never edited on an existing tally; triggers and derivatives are
 * always preserved untouched.
 *
 * @module openmc-studio/browser/capabilities
 */

import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import { getFilterDescriptor } from '../../common/filters-catalog';
import type {
    OpenMCTally,
    OpenMCTallyEstimator,
    OpenMCTallyFilter,
    OpenMCTallyFilterType,
    OpenMCTallyScore
} from '../../common/openmc-state-schema';
import { getScoreEntry, isCustomMtScore } from '../../common/scores-catalog';

/** Maximum number of tally actions accepted by one preview. */
export const MAX_TALLY_ACTIONS = 20;

/** Tally fields this capability may edit on an existing tally. */
export const TALLY_EDIT_FIELDS = ['name', 'scores', 'nuclides', 'estimator', 'multiplyDensity', 'higherMoments'] as const;

/** A field from {@link TALLY_EDIT_FIELDS}. */
export type OpenMCTallyEditField = (typeof TALLY_EDIT_FIELDS)[number];

/** Update the editable fields of one existing tally. */
export interface OpenMCTallyUpdateAction {
    readonly action: 'update';
    readonly tallyId: number;
    readonly updates: Record<string, unknown>;
}

/** Add a new tally; the id is assigned during preview. */
export interface OpenMCTallyAddAction {
    readonly action: 'add';
    readonly tally: Record<string, unknown>;
}

/** Remove one existing tally. */
export interface OpenMCTallyRemoveAction {
    readonly action: 'remove';
    readonly tallyId: number;
}

/** One tally edit in a preview request. */
export type OpenMCTallyAction = OpenMCTallyUpdateAction | OpenMCTallyAddAction | OpenMCTallyRemoveAction;

/** The diff and post-state computed by a tally preview. */
export interface OpenMCTallyPreview {
    readonly changes: NukeChange[];
    readonly after: OpenMCTally[];
    readonly addedIds: number[];
}

/** Human labels for the edited tally fields in the diff card. */
const TALLY_FIELD_LABELS: Record<OpenMCTallyEditField, string> = {
    name: 'name',
    scores: 'scores',
    nuclides: 'nuclides',
    estimator: 'estimator',
    multiplyDensity: 'multiply density',
    higherMoments: 'higher moments'
};

/** Fields accepted in a new tally draft. */
const ADD_TALLY_FIELDS = new Set<string>(['name', 'scores', 'nuclides', 'filters', 'estimator', 'multiplyDensity', 'higherMoments']);

/** Fields that this slice deliberately preserves instead of editing. */
const PRESERVED_TALLY_FIELDS = new Set<string>(['filters', 'triggers', 'derivative']);

/**
 * Deep-clone a JSON-compatible value.
 *
 * @param value - Value to clone; `undefined` is returned as-is.
 * @returns A detached copy.
 */
export function tallyClone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Clone a tally array so preview work never touches project state.
 *
 * @param tallies - Tallies to clone.
 * @returns A detached tally array.
 */
export function cloneTallies(tallies: readonly OpenMCTally[]): OpenMCTally[] {
    return tallies.map((tally) => tallyClone(tally));
}

/**
 * Read an editable field from a tally.
 *
 * @param tally - Tally to read, or `undefined` for a missing tally.
 * @param field - Field name.
 * @returns The field value, or `undefined` when absent.
 */
export function tallyValue(tally: OpenMCTally | undefined, field: string): unknown {
    return tally === undefined ? undefined : (tally as unknown as Record<string, unknown>)[field];
}

/**
 * Compare tally values for stale checks.
 *
 * Undefined object properties and missing properties compare equal so optional
 * unset fields never look changed. Arrays compare by index and objects by key,
 * independent of insertion order.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns Whether both values are equivalent.
 */
export function tallyEquals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => tallyEquals(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
    const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    return leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && tallyEquals(leftRecord[key], rightRecord[key])
    );
}

/**
 * Whether a string is an editable tally field.
 *
 * @param field - Field name.
 * @returns Whether the field is in {@link TALLY_EDIT_FIELDS}.
 */
export function isTallyEditField(field: string): field is OpenMCTallyEditField {
    return (TALLY_EDIT_FIELDS as readonly string[]).includes(field);
}

/** True for a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Human label for a tally in a diff entry. */
function tallyLabel(tally: OpenMCTally): string {
    return tally.name ? `Tally ${tally.id} (${tally.name})` : `Tally ${tally.id}`;
}

/** Validate a score list against the catalog and the numeric MT fallback. */
function validateScores(value: unknown, label: string): string | undefined {
    if (!Array.isArray(value) || value.length === 0) {
        return `${label} must be a non-empty array of OpenMC score names.`;
    }
    for (const score of value) {
        if (typeof score !== 'string' || score.trim().length === 0) {
            return `${label} entries must be non-empty strings.`;
        }
        if (!getScoreEntry(score) && !isCustomMtScore(score)) {
            return `${score} is not an OpenMC catalog score or a numeric MT number.`;
        }
    }
    return undefined;
}

/** Validate a nuclide list. */
function validateNuclides(value: unknown, label: string): string | undefined {
    if (!Array.isArray(value) || value.length === 0) {
        return `${label} must be a non-empty array of nuclide names.`;
    }
    for (const nuclide of value) {
        if (typeof nuclide !== 'string' || nuclide.trim().length === 0) {
            return `${label} entries must be non-empty strings.`;
        }
    }
    return undefined;
}

/** Validate a filter list shallowly: known type and integer bins. */
function validateFilters(value: unknown, label: string): string | undefined {
    if (!Array.isArray(value)) {
        return `${label} must be an array of tally filters.`;
    }
    for (const [index, filter] of value.entries()) {
        const filterLabel = `${label}[${index}]`;
        if (!isRecord(filter)) {
            return `${filterLabel} must be an object.`;
        }
        if (typeof filter.type !== 'string' || !getFilterDescriptor(filter.type as OpenMCTallyFilterType)) {
            return `${filterLabel} has an unknown tally filter type.`;
        }
        if (!Array.isArray(filter.bins) || !filter.bins.every((bin) => typeof bin === 'number' && Number.isInteger(bin))) {
            return `${filterLabel} bins must be an array of integers.`;
        }
    }
    return undefined;
}

/** Validate an estimator. */
function validateEstimator(value: unknown, label: string): string | undefined {
    return value === 'analog' || value === 'tracklength' || value === 'collision'
        ? undefined
        : `${label} must be analog, tracklength, or collision.`;
}

/** Validate an optional boolean. */
function validateBoolean(value: unknown, label: string): string | undefined {
    return typeof value === 'boolean' ? undefined : `${label} must be a boolean.`;
}

/** Validate a tally name and its uniqueness among the simulated tallies. */
function validateName(value: unknown, label: string, counts: Map<string, number>, ownName?: string): string | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return `${label} must be a non-empty string.`;
    }
    const others = (counts.get(value) ?? 0) - (ownName === value ? 1 : 0);
    return others > 0 ? `${label} "${value}" is already used by another tally.` : undefined;
}

/** Adjust a simulated tally-name count. */
function adjustNameCount(counts: Map<string, number>, name: string | undefined, delta: number): void {
    if (name === undefined) {
        return;
    }
    const next = (counts.get(name) ?? 0) + delta;
    if (next <= 0) {
        counts.delete(name);
    } else {
        counts.set(name, next);
    }
}

/** Build the initial simulated name counts for validation. */
function tallyNameCounts(tallies: readonly OpenMCTally[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const tally of tallies) {
        adjustNameCount(counts, tally.name, 1);
    }
    return counts;
}

/** Validate the editable fields of one update action. */
function validateUpdateAction(
    action: OpenMCTallyUpdateAction,
    working: Map<number, OpenMCTally>,
    counts: Map<string, number>,
    errors: string[]
): void {
    const id = action.tallyId;
    if (!Number.isInteger(id) || id < 1) {
        errors.push('Each tally action needs a positive integer tallyId.');
        return;
    }
    const tally = working.get(id);
    if (!tally) {
        errors.push(`Tally ${id} does not exist.`);
        return;
    }
    if (!isRecord(action.updates)) {
        errors.push(`Tally ${id} updates must be an object.`);
        return;
    }
    const fields = Object.keys(action.updates);
    if (fields.length === 0) {
        errors.push(`Update tally ${id} needs at least one field.`);
        return;
    }
    let fieldErrors = false;
    let changed = false;
    for (const field of fields) {
        if (!isTallyEditField(field)) {
            const suffix = PRESERVED_TALLY_FIELDS.has(field)
                ? 'cannot be edited here; filters, triggers, and derivatives are preserved'
                : 'is not an editable tally field';
            errors.push(`Tally ${id} ${field} ${suffix}.`);
            fieldErrors = true;
            continue;
        }
        const value = action.updates[field];
        let error: string | undefined;
        switch (field) {
            case 'name':
                error = validateName(value, `Tally ${id} name`, counts, tally.name);
                break;
            case 'scores':
                error = validateScores(value, `Tally ${id} scores`);
                break;
            case 'nuclides':
                error = validateNuclides(value, `Tally ${id} nuclides`);
                break;
            case 'estimator':
                error = validateEstimator(value, `Tally ${id} estimator`);
                break;
            case 'multiplyDensity':
                error = validateBoolean(value, `Tally ${id} multiplyDensity`);
                break;
            case 'higherMoments':
                error = validateBoolean(value, `Tally ${id} higherMoments`);
                break;
        }
        if (error) {
            errors.push(error);
            fieldErrors = true;
            continue;
        }
        if (!changed && !tallyEquals(tallyValue(tally, field), value)) {
            changed = true;
        }
    }
    if (!fieldErrors && !changed) {
        errors.push(`Tally ${id} already has the requested values.`);
        return;
    }
    if (!fieldErrors && Object.prototype.hasOwnProperty.call(action.updates, 'name')) {
        const nextName = action.updates.name as string;
        if (tally.name !== nextName) {
            adjustNameCount(counts, tally.name, -1);
            adjustNameCount(counts, nextName, 1);
            working.set(id, { ...tally, name: nextName });
        }
    }
}

/** Validate one add action (draft shape, scores, nuclides, filters, names). */
function validateAddAction(action: OpenMCTallyAddAction, counts: Map<string, number>, errors: string[]): void {
    if (!isRecord(action.tally)) {
        errors.push('Each add action needs a tally object.');
        return;
    }
    const draft = action.tally;
    for (const key of Object.keys(draft)) {
        if (key === 'id') {
            errors.push('A new tally cannot set an id; one is assigned automatically.');
            continue;
        }
        if (PRESERVED_TALLY_FIELDS.has(key) && key !== 'filters') {
            errors.push(`A new tally ${key} cannot be edited here; triggers and derivatives are out of scope.`);
            continue;
        }
        if (!ADD_TALLY_FIELDS.has(key)) {
            errors.push(`${key} is not a supported tally field.`);
        }
    }
    const scoresError = validateScores(draft.scores, 'A new tally scores');
    if (scoresError) {
        errors.push(scoresError);
    }
    if (draft.nuclides !== undefined) {
        const nuclidesError = validateNuclides(draft.nuclides, 'A new tally nuclides');
        if (nuclidesError) {
            errors.push(nuclidesError);
        }
    }
    if (draft.filters !== undefined) {
        const filtersError = validateFilters(draft.filters, 'A new tally filters');
        if (filtersError) {
            errors.push(filtersError);
        }
    }
    if (draft.name !== undefined) {
        const nameError = validateName(draft.name, 'A new tally name', counts);
        if (nameError) {
            errors.push(nameError);
        } else {
            adjustNameCount(counts, draft.name as string, 1);
        }
    }
    if (draft.estimator !== undefined) {
        const estimatorError = validateEstimator(draft.estimator, 'A new tally estimator');
        if (estimatorError) {
            errors.push(estimatorError);
        }
    }
    if (draft.multiplyDensity !== undefined) {
        const densityError = validateBoolean(draft.multiplyDensity, 'A new tally multiplyDensity');
        if (densityError) {
            errors.push(densityError);
        }
    }
    if (draft.higherMoments !== undefined) {
        const momentsError = validateBoolean(draft.higherMoments, 'A new tally higherMoments');
        if (momentsError) {
            errors.push(momentsError);
        }
    }
}

/**
 * Validate tally actions against the current tally list.
 *
 * @param tallies - Current tallies; never mutated.
 * @param actions - Proposed actions.
 * @returns Error messages; empty when every action is valid.
 */
export function validateTallyActions(tallies: readonly OpenMCTally[], actions: readonly OpenMCTallyAction[]): string[] {
    if (actions.length < 1) {
        return ['Provide at least one tally action.'];
    }
    if (actions.length > MAX_TALLY_ACTIONS) {
        return [`Provide at most ${MAX_TALLY_ACTIONS} tally actions.`];
    }

    const errors: string[] = [];
    const working = new Map<number, OpenMCTally>(tallies.map((tally) => [tally.id, { ...tally }]));
    const counts = tallyNameCounts(tallies);
    const targeted = new Set<number>();

    for (const action of actions) {
        if (!isRecord(action) || (action.action !== 'update' && action.action !== 'add' && action.action !== 'remove')) {
            errors.push('Each tally action must be an update, add, or remove action.');
            continue;
        }
        if (action.action === 'add') {
            validateAddAction(action, counts, errors);
            continue;
        }
        const id = action.tallyId;
        if (!Number.isInteger(id) || id < 1) {
            errors.push('Each tally action needs a positive integer tallyId.');
            continue;
        }
        if (targeted.has(id)) {
            errors.push(`Tally ${id} can only be updated or removed once.`);
            continue;
        }
        targeted.add(id);
        if (action.action === 'update') {
            validateUpdateAction(action, working, counts, errors);
            continue;
        }
        const tally = working.get(id);
        if (!tally) {
            errors.push(`Tally ${id} does not exist.`);
            continue;
        }
        adjustNameCount(counts, tally.name, -1);
        working.delete(id);
    }
    return errors;
}

/** Allocate the next unused tally id at or above `start`. */
function allocateTallyId(start: number, used: Set<number>): number {
    let id = Number.isInteger(start) && start >= 1 ? start : 1;
    while (used.has(id)) {
        id += 1;
    }
    used.add(id);
    return id;
}

/** Build the full tally record for an add action. */
function buildAddedTally(draft: Record<string, unknown>, id: number): OpenMCTally {
    const tally: OpenMCTally = {
        id,
        scores: tallyClone(draft.scores as OpenMCTallyScore[]),
        nuclides: draft.nuclides === undefined ? ['total'] : tallyClone(draft.nuclides as string[]),
        filters: draft.filters === undefined ? [] : tallyClone(draft.filters as OpenMCTallyFilter[])
    };
    if (draft.name !== undefined) {
        tally.name = draft.name as string;
    }
    if (draft.estimator !== undefined) {
        tally.estimator = draft.estimator as OpenMCTallyEstimator;
    }
    if (draft.multiplyDensity !== undefined) {
        tally.multiplyDensity = draft.multiplyDensity as boolean;
    }
    if (draft.higherMoments !== undefined) {
        tally.higherMoments = draft.higherMoments as boolean;
    }
    return tally;
}

/**
 * Compute the diff and post-state for tally actions without touching state.
 *
 * @param tallies - Current tallies; never mutated.
 * @param actions - Proposed actions.
 * @param firstTallyId - First id to assign to added tallies. Defaults to one
 * higher than the largest existing id; the capability passes the state
 * manager's `getNextTallyId()`.
 * @returns The diff, the full post-state, and the assigned add ids.
 * @throws Error when the actions are invalid; see {@link validateTallyActions}.
 */
export function previewTallyActions(
    tallies: readonly OpenMCTally[],
    actions: readonly OpenMCTallyAction[],
    firstTallyId?: number
): OpenMCTallyPreview {
    const errors = validateTallyActions(tallies, actions);
    if (errors.length > 0) {
        throw new Error(errors.join(' '));
    }

    const after = cloneTallies(tallies);
    const usedIds = new Set(after.map((tally) => tally.id));
    let nextId = firstTallyId ?? Math.max(0, ...after.map((tally) => tally.id)) + 1;
    const changes: NukeChange[] = [];
    const addedIds: number[] = [];

    for (const action of actions) {
        if (action.action === 'update') {
            const tally = after.find((candidate) => candidate.id === action.tallyId);
            if (!tally) {
                continue;
            }
            for (const field of TALLY_EDIT_FIELDS) {
                if (!Object.prototype.hasOwnProperty.call(action.updates, field)) {
                    continue;
                }
                const before = tallyValue(tally, field);
                const value = tallyClone(action.updates[field]);
                if (tallyEquals(before, value)) {
                    continue;
                }
                changes.push({
                    path: `tallies.${tally.id}.${field}`,
                    label: `${tallyLabel(tally)} ${TALLY_FIELD_LABELS[field]}`,
                    kind: 'update',
                    before: tallyClone(before),
                    after: value
                });
                (tally as unknown as Record<string, unknown>)[field] = value;
            }
            continue;
        }
        if (action.action === 'add') {
            const id = allocateTallyId(nextId, usedIds);
            nextId = id + 1;
            const tally = buildAddedTally(action.tally, id);
            addedIds.push(id);
            changes.push({ path: `tallies.${id}`, label: tallyLabel(tally), kind: 'add', after: tallyClone(tally) });
            after.push(tally);
            continue;
        }
        const index = after.findIndex((candidate) => candidate.id === action.tallyId);
        if (index < 0) {
            continue;
        }
        const [tally] = after.splice(index, 1);
        changes.push({ path: `tallies.${tally.id}`, label: tallyLabel(tally), kind: 'remove', before: tallyClone(tally) });
    }

    return { changes, after, addedIds };
}
