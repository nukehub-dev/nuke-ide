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
 * OpenMC DAGMC Capabilities
 *
 * Preview, apply, and undo DAGMC volume material assignments and universe
 * conflict flags through the generic OpenMC change proposal store. Preview is
 * read-only: it validates the requested actions against the loaded model and
 * stores a scoped proposal. Apply writes the .h5m model through the backend
 * first and only then updates the project state, reverting earlier backend
 * writes when a later one fails. Undo restores the previous materials through
 * the backend and then the previous state fields.
 *
 * @module openmc-studio/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import {
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeChange,
    NukeChangeSet,
    NukeJsonSchema,
    NukeJsonSchemaProperty
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { deriveAnnotations } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import { DAGMCInfo, DAGMCVolume, OpenMCMaterial, OpenMCState } from '../../common/openmc-state-schema';
import { OpenMCStudioBackendService } from '../../common/openmc-studio-protocol';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposal, OpenMCChangeProposalService, scopeError } from './openmc-change-proposal-service';

/** Read capability that computes and stores a DAGMC proposal. */
export const PREVIEW_DAGMC_CAPABILITY_ID = 'nuke.openmc.previewDagmcChange';

/** Write capability that applies a stored DAGMC proposal. */
export const APPLY_DAGMC_CAPABILITY_ID = 'nuke.openmc.applyDagmcChange';

/** Maximum number of DAGMC actions in one preview request. */
export const MAX_DAGMC_ACTIONS = 32;

/** Maximum number of material names listed in an unknown-material error. */
const MAX_LISTED_MATERIALS = 5;

/** Diff card title shared by preview and apply. */
const DAGMC_CHANGE_TITLE = 'OpenMC DAGMC change';

/** Message for a project without a loaded DAGMC model. */
const DAGMC_NO_MODEL = 'No DAGMC model is loaded. Import a .h5m first.';

/** Message for a proposal that is gone or past its TTL. */
const DAGMC_PROPOSAL_MISSING = 'This DAGMC preview is missing or has expired. Preview again.';

/** Message for a proposal whose stored snapshots cannot be read. */
const DAGMC_PREVIEW_INCOMPLETE = 'This DAGMC preview is missing its assignment snapshot. Preview again.';

/** Message for a proposal whose diff and snapshots disagree. */
const DAGMC_PREVIEW_INCONSISTENT = 'This DAGMC preview is inconsistent. Preview again.';

/** Message for an apply whose model changed after the preview. */
const DAGMC_STALE = 'DAGMC assignments changed since the preview. Preview again.';

/** Message for an undo whose target was edited after apply. */
const DAGMC_UNDO_STALE = 'DAGMC assignments changed since the edit; the change can no longer be undone.';

/** Assign a material name to one volume; an empty name clears the assignment. */
export interface OpenMCDagmcAssignAction {
    readonly action: 'assign';
    readonly volumeId: number;
    readonly material: string;
}

/** Toggle the DAGMC universe conflict-resolution flags. */
export interface OpenMCDagmcSetFlagsAction {
    readonly action: 'setFlags';
    readonly autoGeomIds?: boolean;
    readonly autoMatIds?: boolean;
}

/** One DAGMC edit requested by a capability caller. */
export type OpenMCDagmcAction = OpenMCDagmcAssignAction | OpenMCDagmcSetFlagsAction;

/** Flag fields editable through {@link OpenMCDagmcSetFlagsAction}. */
type DagmcFlagField = 'autoGeomIds' | 'autoMatIds';

/** Every editable flag field, in diff order. */
const FLAG_FIELDS: readonly DagmcFlagField[] = ['autoGeomIds', 'autoMatIds'];

/** Display labels for the flag diffs. */
const FLAG_LABELS: Record<DagmcFlagField, string> = {
    autoGeomIds: 'Auto geometry IDs',
    autoMatIds: 'Auto material IDs'
};

/** Fields accepted by each action kind. */
const ACTION_KEYS: Record<OpenMCDagmcAction['action'], readonly string[]> = {
    assign: ['action', 'volumeId', 'material'],
    setFlags: ['action', 'autoGeomIds', 'autoMatIds']
};

/** Detached snapshot of the editable DAGMC fields pinned by a preview. */
interface DagmcSnapshot {
    readonly volumes: DAGMCVolume[];
    readonly autoGeomIds?: boolean;
    readonly autoMatIds?: boolean;
}

/** One material assignment derived from a preview. */
interface DagmcAssignment {
    readonly volumeId: number;
    readonly before: string;
    readonly after: string;
}

/** One flag edit derived from a preview. */
interface DagmcFlagEdit {
    readonly field: DagmcFlagField;
    readonly before: boolean;
    readonly after: boolean;
}

/** Before/after snapshots plus the edits that connect them. */
interface DagmcPlan {
    readonly before: DagmcSnapshot;
    readonly after: DagmcSnapshot;
    readonly assignments: DagmcAssignment[];
    readonly flags: DagmcFlagEdit[];
}

/** A loaded DAGMC model: project file path plus parsed metadata. */
interface DagmcModel {
    readonly filePath: string;
    readonly info: DAGMCInfo;
}

/** Result of reading the preview `actions` input. */
type DagmcActionsReadResult = { ok: true; actions: OpenMCDagmcAction[] } | { ok: false; message: string };

/** Result of validating and diffing a preview request. */
type DagmcPreviewBuildResult =
    { ok: true; before: DagmcSnapshot; after: DagmcSnapshot; changes: NukeChange[]; summary: string } | { ok: false; message: string };

/** Result of deriving an apply/undo plan from a stored proposal. */
type DagmcPlanResult = { ok: true; plan: DagmcPlan } | { ok: false; message: string };

const ASSIGN_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'assign' },
        volumeId: { type: 'integer', description: 'Existing DAGMC volume id.' },
        material: { type: 'string', description: 'Project material name; an empty string removes the assignment.' }
    },
    required: ['action', 'volumeId', 'material'],
    additionalProperties: false
};

const SET_FLAGS_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'setFlags' },
        autoGeomIds: { type: 'boolean', description: 'Resolve geometry id conflicts on the DAGMC universe.' },
        autoMatIds: { type: 'boolean', description: 'Resolve material id conflicts on the DAGMC universe.' }
    },
    required: ['action'],
    additionalProperties: false
};

const PREVIEW_DAGMC_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        actions: {
            type: 'array',
            description: 'One material assignment or universe flag action per volume or flag.',
            minItems: 1,
            maxItems: MAX_DAGMC_ACTIONS,
            items: { oneOf: [ASSIGN_ACTION_SCHEMA, SET_FLAGS_ACTION_SCHEMA] }
        },
        summary: { type: 'string', description: 'Optional short description of the whole change.' }
    },
    required: ['actions'],
    additionalProperties: false
};

const DAGMC_CHANGES_SCHEMA: NukeJsonSchemaProperty = {
    type: 'array',
    items: {
        type: 'object',
        properties: {
            path: { type: 'string' },
            label: { type: 'string' },
            kind: { type: 'string', enum: ['update'] },
            before: {},
            after: {}
        },
        required: ['path', 'label', 'kind'],
        additionalProperties: false
    }
};

const DAGMC_CHANGE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: DAGMC_CHANGES_SCHEMA
    },
    required: ['proposalId', 'summary', 'changes'],
    additionalProperties: false
};

const APPLY_DAGMC_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: DAGMC_CHANGES_SCHEMA,
        undoToken: { type: 'string', description: 'Session undo token for the applied DAGMC change.' }
    },
    required: ['proposalId', 'summary', 'changes', 'undoToken'],
    additionalProperties: false
};

const APPLY_DAGMC_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewDagmcChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

/** Read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read an optional string field from a capability input object. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

/** True for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for an integer number. */
function isInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value);
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Deep-clone DAGMC volumes so proposal snapshots stay detached. */
function cloneVolumes(volumes: readonly DAGMCVolume[]): DAGMCVolume[] {
    return JSON.parse(JSON.stringify(volumes)) as DAGMCVolume[];
}

/** Read the loaded DAGMC model from project state. */
function readDagmcModel(state: OpenMCState): DagmcModel | undefined {
    const filePath = state.settings.dagmcFile;
    const info = state.settings.dagmcInfo;
    return filePath && info ? { filePath, info } : undefined;
}

/** Extract a readable message from a backend result. */
function backendMessage(result: { error?: string; message?: string }): string {
    return result.error || result.message || 'The DAGMC backend reported a failure.';
}

/** Build an unknown-material error that lists a few valid project materials. */
function unknownMaterialMessage(name: string, materials: readonly OpenMCMaterial[]): string {
    const names = materials.map((material) => material.name).filter((candidate) => candidate.length > 0);
    if (names.length === 0) {
        return `Material "${name}" does not exist. No project materials are defined.`;
    }
    const listed = names.slice(0, MAX_LISTED_MATERIALS).join(', ');
    const suffix = names.length > MAX_LISTED_MATERIALS ? ', ...' : '';
    return `Material "${name}" does not exist. Valid materials: ${listed}${suffix}.`;
}

/** Read and shape-check the preview `actions` array. */
function readDagmcActions(value: unknown): DagmcActionsReadResult {
    if (!Array.isArray(value)) {
        return { ok: false, message: `Provide an actions array with 1 to ${MAX_DAGMC_ACTIONS} DAGMC actions.` };
    }
    if (value.length < 1 || value.length > MAX_DAGMC_ACTIONS) {
        return { ok: false, message: `Provide between 1 and ${MAX_DAGMC_ACTIONS} DAGMC actions.` };
    }
    const actions: OpenMCDagmcAction[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            return { ok: false, message: 'Each DAGMC action must be an object.' };
        }
        switch (entry.action) {
            case 'assign': {
                const extraKeys = Object.keys(entry).filter((key) => !ACTION_KEYS.assign.includes(key));
                if (extraKeys.length > 0) {
                    return { ok: false, message: `Assign actions do not accept ${extraKeys.join(', ')}.` };
                }
                if (!isInteger(entry.volumeId) || entry.volumeId < 0) {
                    return { ok: false, message: 'Each assign action needs an integer volumeId.' };
                }
                if (typeof entry.material !== 'string') {
                    return {
                        ok: false,
                        message: 'Each assign action needs a material name (use an empty string to unassign).'
                    };
                }
                actions.push({ action: 'assign', volumeId: entry.volumeId, material: entry.material });
                break;
            }
            case 'setFlags': {
                const extraKeys = Object.keys(entry).filter((key) => !ACTION_KEYS.setFlags.includes(key));
                if (extraKeys.length > 0) {
                    return { ok: false, message: `Set-flag actions do not accept ${extraKeys.join(', ')}.` };
                }
                const autoGeomIds = entry.autoGeomIds;
                const autoMatIds = entry.autoMatIds;
                if (autoGeomIds === undefined && autoMatIds === undefined) {
                    return { ok: false, message: 'Each setFlags action needs autoGeomIds, autoMatIds, or both.' };
                }
                if (autoGeomIds !== undefined && typeof autoGeomIds !== 'boolean') {
                    return { ok: false, message: 'autoGeomIds must be a boolean.' };
                }
                if (autoMatIds !== undefined && typeof autoMatIds !== 'boolean') {
                    return { ok: false, message: 'autoMatIds must be a boolean.' };
                }
                actions.push({
                    action: 'setFlags',
                    ...(autoGeomIds !== undefined ? { autoGeomIds } : {}),
                    ...(autoMatIds !== undefined ? { autoMatIds } : {})
                });
                break;
            }
            default:
                return { ok: false, message: 'Each DAGMC action must be assign or setFlags.' };
        }
    }
    return { ok: true, actions };
}

/** Build a default summary from the edits that actually change the model. */
function defaultDagmcSummary(assignments: readonly DagmcAssignment[], flags: readonly DagmcFlagEdit[]): string {
    const count = assignments.length + flags.length;
    if (count !== 1) {
        return `Apply ${count} DAGMC changes.`;
    }
    if (assignments.length === 1) {
        const assignment = assignments[0];
        if (assignment.after.length === 0) {
            return `Remove the material assignment from volume ${assignment.volumeId}.`;
        }
        if (assignment.before.length === 0) {
            return `Assign material "${assignment.after}" to volume ${assignment.volumeId}.`;
        }
        return `Change volume ${assignment.volumeId} from material "${assignment.before}" to "${assignment.after}".`;
    }
    const flag = flags[0];
    const label = flag.field === 'autoGeomIds' ? 'auto geometry IDs' : 'auto material IDs';
    return `${flag.after ? 'Enable' : 'Disable'} ${label}.`;
}

/**
 * Validate the requested DAGMC actions against the loaded model, skip no-op
 * assignments and flags, and build the before/after snapshots plus the diff.
 * Nothing is written: assignments only change the detached snapshot.
 */
function buildDagmcPreview(
    materials: readonly OpenMCMaterial[],
    info: DAGMCInfo,
    actions: readonly OpenMCDagmcAction[]
): DagmcPreviewBuildResult {
    const volumes = cloneVolumes(info.volumes);
    const volumeById = new Map(volumes.map((volume) => [volume.id, volume]));
    const materialNames = new Set(materials.map((material) => material.name));
    const assigned = new Set<number>();
    const requestedFlags: Partial<Record<DagmcFlagField, boolean>> = {};

    for (const action of actions) {
        if (action.action === 'assign') {
            const volume = volumeById.get(action.volumeId);
            if (!volume) {
                return { ok: false, message: `Volume ${action.volumeId} does not exist in the loaded DAGMC model.` };
            }
            if (assigned.has(action.volumeId)) {
                return { ok: false, message: `Volume ${action.volumeId} is assigned more than once in one preview.` };
            }
            assigned.add(action.volumeId);
            const material = action.material.trim();
            const current = (volume.material ?? '').trim();
            if (material.length > 0 && material !== current && !materialNames.has(material)) {
                return { ok: false, message: unknownMaterialMessage(material, materials) };
            }
            continue;
        }
        if (action.autoGeomIds !== undefined) {
            requestedFlags.autoGeomIds = action.autoGeomIds;
        }
        if (action.autoMatIds !== undefined) {
            requestedFlags.autoMatIds = action.autoMatIds;
        }
    }

    const assignments: DagmcAssignment[] = [];
    const changes: NukeChange[] = [];
    for (const action of actions) {
        if (action.action !== 'assign') {
            continue;
        }
        const volume = volumeById.get(action.volumeId)!;
        const before = volume.material ?? '';
        const after = action.material.trim();
        if (before === after) {
            continue;
        }
        assignments.push({ volumeId: volume.id, before, after });
        changes.push({
            path: `settings.dagmcInfo.volumes.${volume.id}.material`,
            label: `Volume ${volume.id} material`,
            kind: 'update',
            before,
            after
        });
    }

    const flags: DagmcFlagEdit[] = [];
    for (const field of FLAG_FIELDS) {
        const requested = requestedFlags[field];
        if (requested === undefined) {
            continue;
        }
        const before = info[field] ?? false;
        if (requested === before) {
            continue;
        }
        flags.push({ field, before, after: requested });
        changes.push({
            path: `settings.dagmcInfo.${field}`,
            label: FLAG_LABELS[field],
            kind: 'update',
            before,
            after: requested
        });
    }

    if (changes.length === 0) {
        return { ok: false, message: 'No DAGMC change to preview.' };
    }

    const afterVolumes = cloneVolumes(volumes);
    const materialByVolume = new Map(assignments.map((assignment) => [assignment.volumeId, assignment.after]));
    for (const volume of afterVolumes) {
        if (materialByVolume.has(volume.id)) {
            volume.material = materialByVolume.get(volume.id)!;
        }
    }

    const autoGeomIds = requestedFlags.autoGeomIds ?? info.autoGeomIds;
    const autoMatIds = requestedFlags.autoMatIds ?? info.autoMatIds;
    return {
        ok: true,
        before: { volumes, autoGeomIds: info.autoGeomIds, autoMatIds: info.autoMatIds },
        after: { volumes: afterVolumes, autoGeomIds, autoMatIds },
        changes,
        summary: defaultDagmcSummary(assignments, flags)
    };
}

/** Read a detached DAGMC snapshot stored on a generic proposal. */
function readDagmcSnapshot(value: unknown): DagmcSnapshot | undefined {
    if (!isRecord(value) || !Array.isArray(value.volumes)) {
        return undefined;
    }
    const volumes: DAGMCVolume[] = [];
    for (const entry of value.volumes) {
        if (!isRecord(entry) || !isInteger(entry.id) || typeof entry.material !== 'string') {
            return undefined;
        }
        volumes.push(entry as unknown as DAGMCVolume);
    }
    const autoGeomIds = value.autoGeomIds;
    const autoMatIds = value.autoMatIds;
    if (autoGeomIds !== undefined && typeof autoGeomIds !== 'boolean') {
        return undefined;
    }
    if (autoMatIds !== undefined && typeof autoMatIds !== 'boolean') {
        return undefined;
    }
    return { volumes, autoGeomIds, autoMatIds };
}

/**
 * Derive the apply plan from a stored proposal, verifying that the diff rows
 * and the pinned snapshots agree so a tampered proposal cannot write materials
 * the preview never showed.
 */
function dagmcPlan(proposal: OpenMCChangeProposal): DagmcPlanResult {
    const before = readDagmcSnapshot(proposal.before);
    const after = readDagmcSnapshot(proposal.after);
    if (!before || !after) {
        return { ok: false, message: DAGMC_PREVIEW_INCOMPLETE };
    }
    if (proposal.changes.length === 0) {
        return { ok: false, message: 'This DAGMC preview has no changes. Preview again.' };
    }
    const beforeById = new Map(before.volumes.map((volume) => [volume.id, volume]));
    const afterById = new Map(after.volumes.map((volume) => [volume.id, volume]));
    if (beforeById.size !== before.volumes.length || afterById.size !== after.volumes.length || beforeById.size !== afterById.size) {
        return { ok: false, message: DAGMC_PREVIEW_INCONSISTENT };
    }

    const assignments: DagmcAssignment[] = [];
    const flags: DagmcFlagEdit[] = [];
    for (const change of proposal.changes) {
        if (change.kind !== 'update') {
            return { ok: false, message: DAGMC_PREVIEW_INCONSISTENT };
        }
        const volumeMatch = /^settings\.dagmcInfo\.volumes\.(-?\d+)\.material$/.exec(change.path);
        if (volumeMatch) {
            const volumeId = Number.parseInt(volumeMatch[1], 10);
            const beforeVolume = beforeById.get(volumeId);
            const afterVolume = afterById.get(volumeId);
            if (
                !beforeVolume ||
                !afterVolume ||
                assignments.some((assignment) => assignment.volumeId === volumeId) ||
                typeof change.before !== 'string' ||
                typeof change.after !== 'string' ||
                beforeVolume.material !== change.before ||
                afterVolume.material !== change.after ||
                beforeVolume.material === afterVolume.material
            ) {
                return { ok: false, message: DAGMC_PREVIEW_INCONSISTENT };
            }
            assignments.push({ volumeId, before: beforeVolume.material, after: afterVolume.material });
            continue;
        }
        if (change.path === 'settings.dagmcInfo.autoGeomIds' || change.path === 'settings.dagmcInfo.autoMatIds') {
            const field: DagmcFlagField = change.path === 'settings.dagmcInfo.autoGeomIds' ? 'autoGeomIds' : 'autoMatIds';
            if (
                flags.some((flag) => flag.field === field) ||
                typeof change.before !== 'boolean' ||
                typeof change.after !== 'boolean' ||
                (before[field] ?? false) !== change.before ||
                (after[field] ?? false) !== change.after ||
                change.before === change.after
            ) {
                return { ok: false, message: DAGMC_PREVIEW_INCONSISTENT };
            }
            flags.push({ field, before: change.before, after: change.after });
            continue;
        }
        return { ok: false, message: `The DAGMC proposal contains an unsupported change path: ${change.path}.` };
    }

    for (const beforeVolume of before.volumes) {
        const afterVolume = afterById.get(beforeVolume.id);
        if (!afterVolume) {
            return { ok: false, message: DAGMC_PREVIEW_INCONSISTENT };
        }
        if (beforeVolume.material !== afterVolume.material && !assignments.some((assignment) => assignment.volumeId === beforeVolume.id)) {
            return { ok: false, message: DAGMC_PREVIEW_INCONSISTENT };
        }
    }
    for (const field of FLAG_FIELDS) {
        if ((before[field] ?? false) !== (after[field] ?? false) && !flags.some((flag) => flag.field === field)) {
            return { ok: false, message: DAGMC_PREVIEW_INCONSISTENT };
        }
    }
    if (assignments.length === 0 && flags.length === 0) {
        return { ok: false, message: 'This DAGMC preview has no changes. Preview again.' };
    }
    return { ok: true, plan: { before, after, assignments, flags } };
}

/** True when the current model still carries the snapshot's volume materials. */
function dagmcVolumeMaterialsMatch(expected: readonly DAGMCVolume[], info: DAGMCInfo): boolean {
    if (info.volumes.length !== expected.length) {
        return false;
    }
    const current = new Map(info.volumes.map((volume) => [volume.id, volume.material ?? '']));
    return expected.every((volume) => current.get(volume.id) === (volume.material ?? ''));
}

/** Reject the whole apply when the loaded volume materials or flags changed after the preview. */
function staleDagmcPlan(plan: DagmcPlan, info: DAGMCInfo): string | undefined {
    if (!dagmcVolumeMaterialsMatch(plan.before.volumes, info)) {
        return DAGMC_STALE;
    }
    for (const field of FLAG_FIELDS) {
        if ((info[field] ?? false) !== (plan.before[field] ?? false)) {
            return DAGMC_STALE;
        }
    }
    return undefined;
}

/** Reject the whole undo when the applied volume materials or flags changed again. */
function staleDagmcUndo(plan: DagmcPlan, info: DAGMCInfo): string | undefined {
    if (!dagmcVolumeMaterialsMatch(plan.after.volumes, info)) {
        return DAGMC_UNDO_STALE;
    }
    for (const field of FLAG_FIELDS) {
        if ((info[field] ?? false) !== (plan.after[field] ?? false)) {
            return DAGMC_UNDO_STALE;
        }
    }
    return undefined;
}

/** Reject an apply whose target material was removed after the preview. */
function missingAppliedMaterial(plan: DagmcPlan, materials: readonly OpenMCMaterial[]): string | undefined {
    const names = new Set(materials.map((material) => material.name));
    for (const assignment of plan.assignments) {
        if (assignment.after.length > 0 && !names.has(assignment.after)) {
            return `Material "${assignment.after}" no longer exists. Preview again.`;
        }
    }
    return undefined;
}

/** Copy the volumes, replacing the materials of the plan's targeted volumes. */
function planVolumes(volumes: readonly DAGMCVolume[], plan: DagmcPlan, side: 'before' | 'after'): DAGMCVolume[] {
    const materials = new Map(plan.assignments.map((assignment) => [assignment.volumeId, assignment[side]]));
    return volumes.map((volume) => {
        const material = materials.get(volume.id);
        return material === undefined ? volume : { ...volume, material };
    });
}

/** Build the change set returned by the preview and apply capabilities. */
function dagmcChangeSet(proposal: Pick<OpenMCChangeProposal, 'id' | 'summary' | 'changes'>, applyCapability?: string): NukeChangeSet {
    return {
        id: proposal.id,
        title: DAGMC_CHANGE_TITLE,
        summary: proposal.summary,
        changes: proposal.changes,
        ...(applyCapability ? { applyCapability } : {})
    };
}

/**
 * Registers the OpenMC DAGMC preview/apply capabilities with the nuke-core
 * registry.
 */
@injectable()
export class OpenMCDagmcCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCStudioBackendService) protected readonly backendService: OpenMCStudioBackendService,
        @inject(OpenMCChangeProposalService) protected readonly proposalService: OpenMCChangeProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: PREVIEW_DAGMC_CAPABILITY_ID,
            title: 'Preview OpenMC DAGMC change',
            description:
                'Validate DAGMC volume material assignments and universe conflict flags, return a before/after diff, and store an in-memory proposal without changing the model or project state.',
            category: ['OpenMC', 'DAGMC'],
            inputSchema: PREVIEW_DAGMC_INPUT_SCHEMA,
            outputSchema: DAGMC_CHANGE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [
                {
                    description: 'Assign Water to volume 3.',
                    input: { actions: [{ action: 'assign', volumeId: 3, material: 'Water' }] }
                },
                {
                    description: 'Enable automatic geometry id resolution.',
                    input: { actions: [{ action: 'setFlags', autoGeomIds: true }] }
                }
            ],
            when: () => true,
            invoke: async (input) => this.previewDagmcChange(input)
        });

        registry.register({
            id: APPLY_DAGMC_CAPABILITY_ID,
            title: 'Apply OpenMC DAGMC change',
            description:
                'Apply a previously previewed DAGMC change to the .h5m model and project state, reject stale or cross-domain previews, and register an in-memory undo.',
            category: ['OpenMC', 'DAGMC'],
            inputSchema: APPLY_DAGMC_INPUT_SCHEMA,
            outputSchema: APPLY_DAGMC_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: true,
            examples: [{ description: 'Apply the previewed DAGMC change.', input: { proposalId: 'proposal-id' } }],
            when: () => true,
            invoke: async (input) => this.applyDagmcChange(input)
        });
    }

    /**
     * Validate and diff proposed DAGMC actions without touching the model or
     * project state. The stored proposal pins the current volume materials and
     * flags so apply can detect a stale preview.
     */
    protected async previewDagmcChange(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const extraKeys = Object.keys(record).filter((key) => key !== 'actions' && key !== 'summary');
        if (extraKeys.length > 0) {
            return { ok: false, message: `Preview input does not accept ${extraKeys.join(', ')}.` };
        }
        const parsed = readDagmcActions(record.actions);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }

        const state = this.stateManager.getState();
        const model = readDagmcModel(state);
        if (!model) {
            return { ok: false, message: DAGMC_NO_MODEL };
        }

        const built = buildDagmcPreview(state.materials, model.info, parsed.actions);
        if (!built.ok) {
            return { ok: false, message: built.message };
        }

        const summary = readString(record, 'summary')?.trim() || built.summary;
        const proposal = this.proposalService.create({
            scope: 'dagmc',
            summary,
            changes: built.changes,
            before: built.before,
            after: built.after
        });
        return {
            ok: true,
            data: { proposalId: proposal.id, summary, changes: built.changes },
            changeSet: dagmcChangeSet(proposal, APPLY_DAGMC_CAPABILITY_ID),
            nextActions: [{ capability: APPLY_DAGMC_CAPABILITY_ID, reason: 'Apply the previewed DAGMC change after confirmation.' }]
        };
    }

    /**
     * Apply a live DAGMC proposal after verifying every assignment against the
     * current model, write the .h5m file through the backend, then update the
     * project state and register an undo.
     */
    protected async applyDagmcChange(input: unknown): Promise<NukeCapabilityResult> {
        const proposalId = readString(readRecord(input), 'proposalId')?.trim();
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }

        const proposal = this.proposalService.get(proposalId);
        if (!proposal) {
            return { ok: false, message: DAGMC_PROPOSAL_MISSING };
        }
        const wrongScope = scopeError(proposal, 'dagmc');
        if (wrongScope) {
            return { ok: false, message: wrongScope };
        }

        const state = this.stateManager.getState();
        const model = readDagmcModel(state);
        if (!model) {
            return { ok: false, message: DAGMC_NO_MODEL };
        }

        const derived = dagmcPlan(proposal);
        if (!derived.ok) {
            return { ok: false, message: derived.message };
        }
        const plan = derived.plan;
        const stale = staleDagmcPlan(plan, model.info);
        if (stale) {
            return { ok: false, message: stale };
        }
        const missing = missingAppliedMaterial(plan, state.materials);
        if (missing) {
            return { ok: false, message: missing };
        }

        const applied: DagmcAssignment[] = [];
        for (const assignment of plan.assignments) {
            let result: { success: boolean; error?: string; message?: string };
            try {
                result = await this.backendService.dagmcAssignMaterial(model.filePath, assignment.volumeId, assignment.after);
            } catch (error) {
                const failure = `Failed to assign material to volume ${assignment.volumeId}: ${errorMessage(error)}`;
                return { ok: false, message: `${failure}${await this.revertDagmcAssignments(model.filePath, applied)}` };
            }
            if (!result.success) {
                const failure = `Failed to assign material to volume ${assignment.volumeId}: ${backendMessage(result)}`;
                return { ok: false, message: `${failure}${await this.revertDagmcAssignments(model.filePath, applied)}` };
            }
            applied.push(assignment);
        }

        const current = this.stateManager.getState();
        const info = current.settings.dagmcInfo;
        if (!info) {
            return { ok: false, message: DAGMC_NO_MODEL };
        }
        this.stateManager.updateSettings({
            dagmcInfo: {
                ...info,
                volumes: planVolumes(info.volumes, plan, 'after'),
                autoGeomIds: plan.after.autoGeomIds,
                autoMatIds: plan.after.autoMatIds
            }
        });

        this.proposalService.remove(proposal.id);
        const undoToken = this.undoService.register(this.createDagmcUndo(proposal, plan));
        return {
            ok: true,
            data: { proposalId: proposal.id, summary: proposal.summary, changes: proposal.changes },
            changeSet: dagmcChangeSet(proposal),
            undoToken,
            nextActions: [{ capability: 'nuke.openmc.diagnoseProject', reason: 'Check the project after applying the DAGMC change.' }]
        };
    }

    /**
     * Best-effort restore of earlier backend writes after a later assignment
     * fails. Returns a message suffix when a revert also fails.
     */
    protected async revertDagmcAssignments(filePath: string, applied: readonly DagmcAssignment[]): Promise<string> {
        const failures = await this.restoreDagmcAssignments(filePath, applied, 'before');
        return failures.length > 0 ? ` Reverting the earlier assignments also failed (${failures.join('; ')}).` : '';
    }

    /**
     * Rewrite the given volumes through the backend in reverse order and
     * return the per-volume failures, so callers can keep state and model
     * consistent after a partial restore.
     */
    protected async restoreDagmcAssignments(
        filePath: string,
        assignments: readonly DagmcAssignment[],
        side: 'before' | 'after'
    ): Promise<string[]> {
        const failures: string[] = [];
        for (let index = assignments.length - 1; index >= 0; index -= 1) {
            const assignment = assignments[index];
            try {
                const result = await this.backendService.dagmcAssignMaterial(filePath, assignment.volumeId, assignment[side]);
                if (!result.success) {
                    failures.push(`volume ${assignment.volumeId}: ${backendMessage(result)}`);
                }
            } catch (error) {
                failures.push(`volume ${assignment.volumeId}: ${errorMessage(error)}`);
            }
        }
        return failures;
    }

    /** Build the reverse handler for an applied DAGMC proposal. */
    protected createDagmcUndo(proposal: OpenMCChangeProposal, plan: DagmcPlan): NukeUndoEntry {
        return {
            title: `Undo ${proposal.summary}`,
            undo: async () => {
                const state = this.stateManager.getState();
                const model = readDagmcModel(state);
                if (!model) {
                    return { ok: false, message: DAGMC_UNDO_STALE };
                }
                const stale = staleDagmcUndo(plan, model.info);
                if (stale) {
                    return { ok: false, message: stale };
                }

                const reverted: DagmcAssignment[] = [];
                for (let index = plan.assignments.length - 1; index >= 0; index -= 1) {
                    const assignment = plan.assignments[index];
                    let failure: string | undefined;
                    try {
                        const result = await this.backendService.dagmcAssignMaterial(
                            model.filePath,
                            assignment.volumeId,
                            assignment.before
                        );
                        if (!result.success) {
                            failure = `Failed to restore material for volume ${assignment.volumeId}: ${backendMessage(result)}`;
                        }
                    } catch (error) {
                        failure = `Failed to restore material for volume ${assignment.volumeId}: ${errorMessage(error)}`;
                    }
                    if (failure) {
                        const rollback = await this.restoreDagmcAssignments(model.filePath, reverted, 'after');
                        const note = rollback.length > 0 ? ` Restoring the reverted assignments also failed (${rollback.join('; ')}).` : '';
                        return { ok: false, message: `${failure}${note}` };
                    }
                    reverted.push(assignment);
                }

                const current = this.stateManager.getState();
                const info = current.settings.dagmcInfo;
                if (!info) {
                    return { ok: false, message: DAGMC_UNDO_STALE };
                }
                this.stateManager.updateSettings({
                    dagmcInfo: {
                        ...info,
                        volumes: planVolumes(info.volumes, plan, 'before'),
                        autoGeomIds: plan.before.autoGeomIds,
                        autoMatIds: plan.before.autoMatIds
                    }
                });
                return { ok: true, message: 'DAGMC change undone.' };
            }
        };
    }
}
