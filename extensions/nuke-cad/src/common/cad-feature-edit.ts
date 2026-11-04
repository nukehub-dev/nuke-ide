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
 * Only topology-preserving scalar parameters are editable. The preview build
 * still has the final say on solid count, selector map, and region coverage.
 *
 * @module nuke-cad/common
 */

import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { FeatureDef, FeatureParams, FeatureType, NukeCadDocument } from './cad-document';

/** Maximum number of parameter changes accepted by one prepared edit. */
export const CAD_FEATURE_EDIT_LIMIT = 16;

/** Feature parameters that the pure edit engine can change. */
export type EditableFeatureParam = 'length' | 'angle' | 'radius' | 'thickness' | 'distance' | 'spacing' | 'diameter' | 'depth';

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

/** Editable parameters for each feature type; absent types are read-only. */
const EDITABLE_PARAMS: Partial<Record<FeatureType, readonly EditableFeatureParam[]>> = {
    pad: ['length'],
    pocket: ['length'],
    revolve: ['angle'],
    groove: ['angle'],
    fillet: ['radius'],
    chamfer: ['distance'],
    draft: ['angle'],
    shell: ['thickness'],
    linearPattern: ['spacing'],
    circularPattern: ['angle'],
    hole: ['diameter', 'depth']
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

function hasEdges(params: Record<string, unknown>): boolean {
    return Array.isArray(params.edges) && params.edges.length > 0;
}

function validateChangeValue(
    feature: FeatureDef,
    params: Record<string, unknown>,
    param: EditableFeatureParam,
    value: number
): string | undefined {
    const name = feature.name;
    switch (param) {
        case 'length':
            if (value <= 0) {
                return `Feature '${name}' length must be greater than 0.`;
            }
            if (feature.type === 'pad' || feature.type === 'pocket') {
                const end = params.end;
                if (end !== undefined && end !== 'blind') {
                    return `Feature '${name}' length can only change for blind (or default) extrusions, not '${String(end)}'.`;
                }
            }
            return undefined;
        case 'radius':
            if (value <= 0) {
                return `Feature '${name}' radius must be greater than 0.`;
            }
            if (!hasEdges(params)) {
                return `Feature '${name}' radius requires a non-empty edges array.`;
            }
            return undefined;
        case 'thickness':
            return value > 0 ? undefined : `Feature '${name}' thickness must be greater than 0.`;
        case 'diameter':
            return value > 0 ? undefined : `Feature '${name}' diameter must be greater than 0.`;
        case 'depth':
            if (!(typeof params.depth === 'number' && Number.isFinite(params.depth))) {
                return `Feature '${name}' depth can only change for a blind hole; this hole is through.`;
            }
            return value > 0 ? undefined : `Feature '${name}' depth must be greater than 0.`;
        case 'distance':
            if (params.distances !== undefined) {
                return `Feature '${name}' uses two-distance chamfer mode; only symmetric distance mode is editable.`;
            }
            if (!hasEdges(params)) {
                return `Feature '${name}' distance requires a non-empty edges array.`;
            }
            return value > 0 ? undefined : `Feature '${name}' distance must be greater than 0.`;
        case 'spacing':
            return value === 0 ? `Feature '${name}' spacing must be a non-zero finite number.` : undefined;
        case 'angle':
            if (feature.type === 'draft') {
                return value > -90 && value < 90 ? undefined : `Feature '${name}' draft angle must be between -90 and 90 degrees.`;
            }
            if (value <= 0 || value > MAX_REVOLVE_ANGLE) {
                return `Feature '${name}' angle must be greater than 0 and at most 360 degrees.`;
            }
            if (feature.type === 'circularPattern' && value !== 360 && (params.count as number) < 2) {
                return `Feature '${name}' partial sweep requires a count of at least 2.`;
            }
            return undefined;
        default:
            return `Feature '${name}' parameter '${String(param)}' is not editable.`;
    }
}

/** Default stored value when a feature omits an optional parameter. */
function effectiveBefore(feature: FeatureDef, params: Record<string, unknown>, param: EditableFeatureParam): number | undefined {
    const stored = params[param];
    if (typeof stored === 'number' && Number.isFinite(stored)) {
        return stored;
    }
    if (param === 'angle' && feature.type === 'circularPattern') {
        return 360;
    }
    return undefined;
}

function resolveChange(feature: FeatureDef, change: FeatureParamChange): ChangeResolution {
    const editable = EDITABLE_PARAMS[feature.type];
    if (editable === undefined) {
        return rejectChange(`Feature '${feature.name}' has type '${feature.type}', which has no editable parameters.`);
    }
    if (!editable.includes(change.param)) {
        return rejectChange(`Feature '${feature.name}' edits ${editable.join(' or ')}, not '${String(change.param)}'.`);
    }

    const value = change.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return rejectChange(`Feature '${feature.name}' ${change.param} must be a finite number.`);
    }
    const params: FeatureParams = feature.params;
    if (!isRecord(params)) {
        return rejectChange(`Feature '${feature.name}' has no editable parameters.`);
    }
    const validationError = validateChangeValue(feature, params, change.param, value);
    if (validationError) {
        return rejectChange(validationError);
    }
    const before = effectiveBefore(feature, params, change.param);
    if (before === undefined) {
        return rejectChange(`Feature '${feature.name}' has no finite ${change.param} to edit.`);
    }
    if (before === value) {
        return rejectChange(`Feature '${feature.name}' ${change.param} is already ${value}; the edit would not change anything.`);
    }
    return { ok: true, edit: { feature, param: change.param, before, after: value } };
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
