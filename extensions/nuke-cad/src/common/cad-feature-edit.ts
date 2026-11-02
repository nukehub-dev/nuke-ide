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
 * Pure feature-parameter edit engine for `.nuke-cad` documents.
 *
 * A capability or dialog proposes `(feature, parameter, value)` changes; this
 * module validates them against the editable allowlist, resolves the current
 * values, and returns an updated document clone plus the changes it applied.
 * The input document is never mutated and validation failures are reported as
 * messages rather than thrown errors.
 *
 * @module nuke-cad/common
 */

import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { FeatureDef, FeatureParams, FeatureType, NukeCadDocument } from './cad-document';

/** Maximum number of parameter changes accepted by one prepared edit. */
export const CAD_FEATURE_EDIT_LIMIT = 16;

/** Feature parameters that the pure edit engine can change. */
export type EditableFeatureParam = 'length' | 'angle' | 'radius' | 'thickness';

/** One requested parameter change. Unknown extra keys are ignored. */
export interface FeatureParamChange {
    readonly featureId: string;
    readonly param: EditableFeatureParam;
    readonly value: number;
}

/** One validated parameter change with its resolved type and previous value. */
export interface ResolvedFeatureEdit {
    readonly featureId: string;
    readonly featureType: FeatureType;
    readonly param: EditableFeatureParam;
    readonly before: number;
    readonly after: number;
}

/** Document clone and resolved edits produced by {@link prepareFeatureEdit}. */
export interface PreparedFeatureEdit {
    readonly afterDocument: NukeCadDocument;
    readonly edits: readonly ResolvedFeatureEdit[];
    readonly changes: readonly NukeChange[];
}

/** Maximum revolve/groove angle in degrees. */
const MAX_REVOLVE_ANGLE = 360;

/** Editable parameter for each feature type; absent types are read-only. */
const EDITABLE_PARAMS: Partial<Record<FeatureType, EditableFeatureParam>> = {
    pad: 'length',
    pocket: 'length',
    revolve: 'angle',
    groove: 'angle',
    fillet: 'radius',
    shell: 'thickness'
};

interface PendingEdit {
    readonly feature: FeatureDef;
    readonly param: EditableFeatureParam;
    readonly before: number;
    readonly after: number;
}

type ChangeResolution = { readonly ok: true; readonly edit: PendingEdit } | { readonly ok: false; readonly message: string };

function rejectChange(message: string): ChangeResolution {
    return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDocument(document: NukeCadDocument): NukeCadDocument {
    return JSON.parse(JSON.stringify(document)) as NukeCadDocument;
}

function resolveChange(feature: FeatureDef, change: FeatureParamChange): ChangeResolution {
    const expected = EDITABLE_PARAMS[feature.type];
    if (expected === undefined) {
        return rejectChange(`Feature '${feature.name}' has type '${feature.type}', which has no editable parameters.`);
    }
    if (change.param !== expected) {
        return rejectChange(`Feature '${feature.name}' edits '${expected}', not '${String(change.param)}'.`);
    }

    const value = change.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return rejectChange(`Feature '${feature.name}' ${expected} must be a finite number.`);
    }
    if (expected === 'angle') {
        if (value <= 0 || value > MAX_REVOLVE_ANGLE) {
            return rejectChange(`Feature '${feature.name}' angle must be greater than 0 and at most 360 degrees.`);
        }
    } else if (value <= 0) {
        return rejectChange(`Feature '${feature.name}' ${expected} must be greater than 0.`);
    }

    const params: FeatureParams = feature.params;
    if (!isRecord(params)) {
        return rejectChange(`Feature '${feature.name}' has no editable parameters.`);
    }
    if (feature.type === 'pad' || feature.type === 'pocket') {
        const end = params.end;
        if (end !== undefined && end !== 'blind') {
            return rejectChange(
                `Feature '${feature.name}' length can only change for blind (or default) extrusions, not '${String(end)}'.`
            );
        }
    }
    if (feature.type === 'fillet') {
        const edges = params.edges;
        if (!Array.isArray(edges) || edges.length === 0) {
            return rejectChange(`Feature '${feature.name}' radius requires a non-empty edges array.`);
        }
    }

    const before = params[expected];
    if (typeof before !== 'number' || !Number.isFinite(before)) {
        return rejectChange(`Feature '${feature.name}' has no finite ${expected} to edit.`);
    }
    if (before === value) {
        return rejectChange(`Feature '${feature.name}' ${expected} is already ${value}; the edit would not change anything.`);
    }
    return { ok: true, edit: { feature, param: expected, before, after: value } };
}

/**
 * Validate and apply feature-parameter changes to a copy of `document`.
 *
 * The whole request is rejected if any change is invalid, so a call either
 * produces a complete edit or no document at all. The returned `changes` use
 * capability-style `features.<id>.params.<param>` paths for preview and undo.
 */
export function prepareFeatureEdit(
    document: NukeCadDocument,
    changes: readonly FeatureParamChange[]
): { ok: true; result: PreparedFeatureEdit } | { ok: false; message: string } {
    if (!Array.isArray(changes) || changes.length === 0) {
        return { ok: false, message: 'No feature parameter changes were provided.' };
    }
    if (changes.length > CAD_FEATURE_EDIT_LIMIT) {
        return {
            ok: false,
            message: `Too many feature parameter changes (${changes.length}); at most ${CAD_FEATURE_EDIT_LIMIT} are allowed.`
        };
    }

    const featureById = new Map<string, FeatureDef>();
    for (const feature of document.features) {
        featureById.set(feature.id, feature);
    }

    const seen = new Set<string>();
    const pending: PendingEdit[] = [];
    for (const change of changes) {
        const key = JSON.stringify([change.featureId, change.param]);
        if (seen.has(key)) {
            return { ok: false, message: `Duplicate change for feature '${change.featureId}' parameter '${change.param}'.` };
        }
        seen.add(key);

        const feature = featureById.get(change.featureId);
        if (feature === undefined) {
            return { ok: false, message: `Unknown feature '${change.featureId}'.` };
        }
        const resolution = resolveChange(feature, change);
        if (!resolution.ok) {
            return { ok: false, message: resolution.message };
        }
        pending.push(resolution.edit);
    }

    const afterDocument = cloneDocument(document);
    const afterFeatureById = new Map<string, FeatureDef>();
    for (const feature of afterDocument.features) {
        afterFeatureById.set(feature.id, feature);
    }

    const edits: ResolvedFeatureEdit[] = [];
    const nukeChanges: NukeChange[] = [];
    for (const edit of pending) {
        const feature = afterFeatureById.get(edit.feature.id);
        if (feature === undefined) {
            return { ok: false, message: `Unknown feature '${edit.feature.id}'.` };
        }
        const params = feature.params as Record<string, unknown>;
        params[edit.param] = edit.after;
        edits.push({
            featureId: feature.id,
            featureType: feature.type,
            param: edit.param,
            before: edit.before,
            after: edit.after
        });
        nukeChanges.push({
            path: `features.${feature.id}.params.${edit.param}`,
            label: `Feature ${feature.name} ${edit.param}`,
            kind: 'update',
            before: edit.before,
            after: edit.after
        });
    }

    return { ok: true, result: { afterDocument, edits, changes: nukeChanges } };
}
