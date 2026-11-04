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
 * Pure topology-changing feature edit engine for `.nuke-cad` documents.
 *
 * These edits cannot be expressed by the strict scalar-parameter allowlist:
 * a through hole has no `depth` key at all, and a pattern count changes how
 * many solids the feature contributes. The engine validates the whole request
 * against a document clone, applies exact parameter replacements (including
 * key removal), and reports full before/after snapshots plus capability-style
 * changes for preview and undo.
 *
 * The preview build still decides the final solid count, selector map, and
 * region coverage; this module only prepares an exact document revision.
 *
 * @module nuke-cad/common
 */

import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { FeatureDef, FeatureParams, FeatureType, NukeCadDocument } from './cad-document';

/** Maximum number of topology edit actions accepted by one prepared edit. */
export const CAD_TOPOLOGY_EDIT_LIMIT = 8;

/** Largest pattern count one AI topology edit may request. */
export const CAD_TOPOLOGY_PATTERN_COUNT_LIMIT = 1000;

/** One requested topology-changing feature action. Unknown extra keys are ignored. */
export type FeatureTopologyAction =
    | { readonly featureId: string; readonly action: 'holeDepthMode'; readonly mode: 'through' }
    | { readonly featureId: string; readonly action: 'holeDepthMode'; readonly mode: 'blind'; readonly depth: number }
    | { readonly featureId: string; readonly action: 'patternCount'; readonly count: number };

/** One validated topology edit with full detached parameter snapshots. */
export interface ResolvedTopologyEdit {
    readonly featureId: string;
    readonly featureType: FeatureType;
    readonly action: 'holeDepthMode' | 'patternCount';
    /** Full detached params snapshot before the action. */
    readonly before: FeatureParams;
    /** Full detached params snapshot after the action. */
    readonly after: FeatureParams;
}

/** Document clone and resolved edits produced by {@link prepareTopologyEdit}. */
export interface PreparedTopologyEdit {
    readonly afterDocument: NukeCadDocument;
    readonly edits: readonly ResolvedTopologyEdit[];
    readonly changes: readonly NukeChange[];
}

/** Result of {@link prepareTopologyEdit}: a complete edit or a rejection message. */
export type TopologyEditPrepareResult =
    { readonly ok: true; readonly result: PreparedTopologyEdit } | { readonly ok: false; readonly message: string };

interface PendingHoleDepthThrough {
    readonly feature: FeatureDef;
    readonly action: 'holeDepthMode';
    readonly mode: 'through';
}

interface PendingHoleDepthBlind {
    readonly feature: FeatureDef;
    readonly action: 'holeDepthMode';
    readonly mode: 'blind';
    readonly depth: number;
}

interface PendingPatternCount {
    readonly feature: FeatureDef;
    readonly action: 'patternCount';
    readonly count: number;
}

type PendingTopologyAction = PendingHoleDepthThrough | PendingHoleDepthBlind | PendingPatternCount;

type ActionResolution = { readonly ok: true; readonly pending: PendingTopologyAction } | { readonly ok: false; readonly message: string };

function rejectAction(message: string): ActionResolution {
    return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDocument(document: NukeCadDocument): NukeCadDocument {
    return JSON.parse(JSON.stringify(document)) as NukeCadDocument;
}

function cloneParams(params: FeatureParams): FeatureParams {
    return JSON.parse(JSON.stringify(params)) as FeatureParams;
}

/** Stored blind depth, or undefined for a through hole. */
function storedDepth(params: Record<string, unknown>): number | undefined {
    const depth = params.depth;
    return typeof depth === 'number' && Number.isFinite(depth) ? depth : undefined;
}

function resolveHoleDepthMode(feature: FeatureDef, action: Record<string, unknown>): ActionResolution {
    if (feature.type !== 'hole') {
        return rejectAction(`Feature '${feature.name}' has type '${feature.type}'; hole depth mode only applies to holes.`);
    }
    const params = feature.params as Record<string, unknown>;
    if (!isRecord(params)) {
        return rejectAction(`Feature '${feature.name}' has no editable parameters.`);
    }
    const currentDepth = storedDepth(params);
    const mode = action.mode;
    if (mode === 'through') {
        if (currentDepth === undefined) {
            return rejectAction(`Feature '${feature.name}' is already a through hole; it has no blind depth.`);
        }
        if (params.thread === 'modeled') {
            return rejectAction(`Feature '${feature.name}' uses a modeled thread, which requires a blind hole; it cannot become through.`);
        }
        return { ok: true, pending: { feature, action: 'holeDepthMode', mode: 'through' } };
    }
    if (mode === 'blind') {
        const depth = action.depth;
        if (typeof depth !== 'number' || !Number.isFinite(depth) || depth <= 0) {
            return rejectAction(`Feature '${feature.name}' blind depth must be a positive finite number.`);
        }
        if (currentDepth === depth) {
            return rejectAction(`Feature '${feature.name}' depth is already ${depth}; the edit would not change anything.`);
        }
        return { ok: true, pending: { feature, action: 'holeDepthMode', mode: 'blind', depth } };
    }
    return rejectAction(`Feature '${feature.name}' has an unknown hole depth mode '${String(mode)}'.`);
}

function resolvePatternCount(feature: FeatureDef, action: Record<string, unknown>): ActionResolution {
    if (feature.type !== 'linearPattern' && feature.type !== 'circularPattern') {
        return rejectAction(
            `Feature '${feature.name}' has type '${feature.type}'; pattern count only applies to linear or circular patterns.`
        );
    }
    const params = feature.params as Record<string, unknown>;
    if (!isRecord(params)) {
        return rejectAction(`Feature '${feature.name}' has no editable parameters.`);
    }
    const count = action.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
        return rejectAction(`Feature '${feature.name}' count must be a safe integer of at least 1.`);
    }
    if (count > CAD_TOPOLOGY_PATTERN_COUNT_LIMIT) {
        return rejectAction(`Feature '${feature.name}' count must be at most ${CAD_TOPOLOGY_PATTERN_COUNT_LIMIT}.`);
    }
    if (feature.type === 'circularPattern' && params.angle !== undefined && params.angle !== 360 && count < 2) {
        return rejectAction(`Feature '${feature.name}' partial sweep requires a count of at least 2.`);
    }
    const currentCount = params.count;
    if (typeof currentCount !== 'number' || !Number.isSafeInteger(currentCount)) {
        return rejectAction(`Feature '${feature.name}' has no integer count to edit.`);
    }
    if (currentCount === count) {
        return rejectAction(`Feature '${feature.name}' count is already ${count}; the edit would not change anything.`);
    }
    return { ok: true, pending: { feature, action: 'patternCount', count } };
}

function resolveTopologyAction(feature: FeatureDef, action: Record<string, unknown>): ActionResolution {
    if (action.action === 'holeDepthMode') {
        return resolveHoleDepthMode(feature, action);
    }
    if (action.action === 'patternCount') {
        return resolvePatternCount(feature, action);
    }
    return rejectAction(`Feature '${feature.name}' has an unknown topology action '${String(action.action)}'.`);
}

/**
 * Validate and apply topology-changing actions to a copy of `document`.
 *
 * The whole request is rejected if any action is invalid, so a call either
 * produces a complete edit or no document at all. Actions are validated against
 * the clone before any parameter is mutated. The returned `changes` use
 * capability-style `features.<id>.params.<param>` paths for preview and undo;
 * through-hole changes use `kind: 'remove'` because the key must disappear.
 */
export function prepareTopologyEdit(document: NukeCadDocument, actions: readonly FeatureTopologyAction[]): TopologyEditPrepareResult {
    if (!Array.isArray(actions) || actions.length === 0) {
        return { ok: false, message: 'No topology edit actions were provided.' };
    }
    if (actions.length > CAD_TOPOLOGY_EDIT_LIMIT) {
        return {
            ok: false,
            message: `Too many topology edit actions (${actions.length}); at most ${CAD_TOPOLOGY_EDIT_LIMIT} are allowed.`
        };
    }

    const afterDocument = cloneDocument(document);
    const featureById = new Map<string, FeatureDef>();
    for (const feature of afterDocument.features) {
        featureById.set(feature.id, feature);
    }

    const seen = new Set<string>();
    const pending: PendingTopologyAction[] = [];
    for (const action of actions) {
        if (!isRecord(action)) {
            return { ok: false, message: 'Each topology edit action must be an object.' };
        }
        const featureId = action.featureId;
        if (typeof featureId !== 'string' || featureId.length === 0) {
            return { ok: false, message: 'Each topology edit action requires a non-empty feature id.' };
        }
        if (seen.has(featureId)) {
            return { ok: false, message: `Duplicate topology edit for feature '${featureId}'.` };
        }
        seen.add(featureId);

        const feature = featureById.get(featureId);
        if (feature === undefined) {
            return { ok: false, message: `Unknown feature '${featureId}'.` };
        }
        const resolution = resolveTopologyAction(feature, action);
        if (!resolution.ok) {
            return { ok: false, message: resolution.message };
        }
        pending.push(resolution.pending);
    }

    const edits: ResolvedTopologyEdit[] = [];
    const changes: NukeChange[] = [];
    for (const action of pending) {
        const feature = action.feature;
        const before = cloneParams(feature.params);
        const params = feature.params as Record<string, unknown>;

        if (action.action === 'holeDepthMode') {
            const previousDepth = storedDepth(params);
            if (action.mode === 'through') {
                delete params.depth;
            } else {
                params.depth = action.depth;
            }
            feature.params = cloneParams(feature.params);
            edits.push({
                featureId: feature.id,
                featureType: feature.type,
                action: 'holeDepthMode',
                before,
                after: feature.params
            });
            if (action.mode === 'through') {
                changes.push({
                    path: `features.${feature.id}.params.depth`,
                    label: `Feature ${feature.name} depth`,
                    kind: 'remove',
                    before: previousDepth,
                    after: undefined
                });
            } else {
                changes.push({
                    path: `features.${feature.id}.params.depth`,
                    label: `Feature ${feature.name} depth`,
                    kind: previousDepth === undefined ? 'add' : 'update',
                    before: previousDepth,
                    after: action.depth
                });
            }
            continue;
        }

        const previousCount = params.count;
        params.count = action.count;
        feature.params = cloneParams(feature.params);
        edits.push({
            featureId: feature.id,
            featureType: feature.type,
            action: 'patternCount',
            before,
            after: feature.params
        });
        changes.push({
            path: `features.${feature.id}.params.count`,
            label: `Feature ${feature.name} count`,
            kind: 'update',
            before: previousCount,
            after: action.count
        });
    }

    return { ok: true, result: { afterDocument, edits, changes } };
}
