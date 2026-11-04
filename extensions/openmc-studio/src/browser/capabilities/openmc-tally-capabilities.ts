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
 * OpenMC Tally Capabilities
 *
 * Preview → apply → undo for tally additions, updates, and removals. Preview
 * validates and diffs the requested actions against a cloned tally list and
 * stores a scoped proposal; apply re-checks every change against current state
 * before writing through the state manager, and registers a path-scoped undo.
 * Filters, triggers, and derivatives are preserved: this slice never edits
 * them.
 *
 * @module openmc-studio/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import type {
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
import type { OpenMCTally } from '../../common/openmc-state-schema';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposal, OpenMCChangeProposalService, scopeError } from './openmc-change-proposal-service';
import {
    cloneTallies,
    isTallyEditField,
    MAX_TALLY_ACTIONS,
    OpenMCTallyAction,
    OpenMCTallyEditField,
    OpenMCTallyPreview,
    previewTallyActions,
    tallyClone,
    tallyEquals,
    tallyValue,
    validateTallyActions
} from './openmc-tally-edit';

/** Title shared by the preview and apply change sets. */
const TALLY_CHANGE_TITLE = 'OpenMC tally change';

const TALLY_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    oneOf: [
        {
            type: 'object',
            properties: {
                action: { const: 'update' },
                tallyId: { type: 'integer', minimum: 1 },
                updates: {
                    type: 'object',
                    description: 'Fields to change: name, scores, nuclides, estimator, multiplyDensity, higherMoments.'
                }
            },
            required: ['action', 'tallyId', 'updates'],
            additionalProperties: false
        },
        {
            type: 'object',
            properties: {
                action: { const: 'add' },
                tally: {
                    type: 'object',
                    description: 'Tally draft. The id is assigned during preview; filters are preserved as provided.'
                }
            },
            required: ['action', 'tally'],
            additionalProperties: false
        },
        {
            type: 'object',
            properties: {
                action: { const: 'remove' },
                tallyId: { type: 'integer', minimum: 1 }
            },
            required: ['action', 'tallyId'],
            additionalProperties: false
        }
    ]
};

const PREVIEW_TALLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        actions: {
            type: 'array',
            description: 'One to twenty tally additions, updates, or removals.',
            minItems: 1,
            maxItems: MAX_TALLY_ACTIONS,
            items: TALLY_ACTION_SCHEMA
        },
        summary: { type: 'string' }
    },
    required: ['actions'],
    additionalProperties: false
};

const APPLY_TALLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewTallyChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const TALLY_CHANGE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    label: { type: 'string' },
                    kind: { type: 'string', enum: ['add', 'update', 'remove'] },
                    before: {},
                    after: {}
                },
                required: ['path', 'label', 'kind'],
                additionalProperties: false
            }
        }
    },
    required: ['proposalId', 'summary', 'changes'],
    additionalProperties: false
};

/** One changed field of an updated tally. */
interface TallyFieldChange {
    readonly field: OpenMCTallyEditField;
    readonly before: unknown;
    readonly after: unknown;
}

/** A grouped update for one tally. */
interface TallyUpdateOperation {
    readonly kind: 'update';
    readonly id: number;
    readonly fields: TallyFieldChange[];
}

/** An add operation carrying the full assigned tally. */
interface TallyAddOperation {
    readonly kind: 'add';
    readonly tally: OpenMCTally;
}

/** A remove operation carrying the full before snapshot. */
interface TallyRemoveOperation {
    readonly kind: 'remove';
    readonly tally: OpenMCTally;
}

/** One grouped write derived from a proposal's changes. */
type TallyOperation = TallyUpdateOperation | TallyAddOperation | TallyRemoveOperation;

/** Result of reading the preview `actions` input. */
type TallyActionsReadResult = { ok: true; actions: OpenMCTallyAction[] } | { ok: false; message: string };

/** Result of deriving grouped operations from a proposal diff. */
type TallyOperationsResult = { ok: true; operations: TallyOperation[] } | { ok: false; message: string };

/** Safely read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read an optional string field from a capability input object. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

/** True for a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a positive integer tally id. */
function readTallyId(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Read and shape-check the preview `actions` array. */
function readTallyActions(value: unknown): TallyActionsReadResult {
    if (!Array.isArray(value)) {
        return { ok: false, message: `Provide an actions array with 1 to ${MAX_TALLY_ACTIONS} tally edits.` };
    }
    if (value.length < 1 || value.length > MAX_TALLY_ACTIONS) {
        return { ok: false, message: `Provide between 1 and ${MAX_TALLY_ACTIONS} tally actions.` };
    }
    const actions: OpenMCTallyAction[] = [];
    for (const [index, entry] of value.entries()) {
        if (!isRecord(entry)) {
            return { ok: false, message: `Tally action ${index + 1} must be an object.` };
        }
        if (entry.action === 'update') {
            const tallyId = readTallyId(entry.tallyId);
            if (tallyId === undefined || !isRecord(entry.updates)) {
                return { ok: false, message: `Tally action ${index + 1} needs a positive integer tallyId and an updates object.` };
            }
            actions.push({ action: 'update', tallyId, updates: entry.updates });
            continue;
        }
        if (entry.action === 'add') {
            if (!isRecord(entry.tally)) {
                return { ok: false, message: `Tally action ${index + 1} needs a tally object.` };
            }
            actions.push({ action: 'add', tally: entry.tally });
            continue;
        }
        if (entry.action === 'remove') {
            const tallyId = readTallyId(entry.tallyId);
            if (tallyId === undefined) {
                return { ok: false, message: `Tally action ${index + 1} needs a positive integer tallyId.` };
            }
            actions.push({ action: 'remove', tallyId });
            continue;
        }
        return { ok: false, message: `Tally action ${index + 1} must use action update, add, or remove.` };
    }
    return { ok: true, actions };
}

/** Read a full tally snapshot from a proposal or change. */
function readTally(value: unknown): OpenMCTally | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'number' || !Number.isInteger(record.id)) {
        return undefined;
    }
    if (!Array.isArray(record.scores) || !Array.isArray(record.nuclides) || !Array.isArray(record.filters)) {
        return undefined;
    }
    return tallyClone(value as unknown as OpenMCTally);
}

/** Read a full tally-array snapshot from a proposal. */
function readTallySnapshot(value: unknown): OpenMCTally[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const tallies: OpenMCTally[] = [];
    for (const entry of value) {
        const tally = readTally(entry);
        if (!tally) {
            return undefined;
        }
        tallies.push(tally);
    }
    return tallies;
}

/**
 * Derive grouped write operations from a previewed diff. Update changes for
 * the same tally are merged so apply calls `updateTally` once per tally.
 */
function readTallyOperations(changes: readonly NukeChange[]): TallyOperationsResult {
    if (changes.length === 0) {
        return { ok: false, message: 'This tally preview has no changes. Preview again.' };
    }
    const operations: TallyOperation[] = [];
    for (const change of changes) {
        if (change.kind === 'update') {
            const match = /^tallies\.(\d+)\.([A-Za-z]+)$/.exec(change.path);
            if (!match) {
                return { ok: false, message: `Unexpected tally change path: ${change.path}.` };
            }
            const id = Number(match[1]);
            const field = match[2];
            if (!isTallyEditField(field)) {
                return { ok: false, message: `Unexpected tally field in the preview: ${field}.` };
            }
            const fieldChange: TallyFieldChange = {
                field,
                before: tallyClone(change.before),
                after: tallyClone(change.after)
            };
            const existing = operations.find(
                (operation): operation is TallyUpdateOperation => operation.kind === 'update' && operation.id === id
            );
            if (existing) {
                existing.fields.push(fieldChange);
            } else {
                operations.push({ kind: 'update', id, fields: [fieldChange] });
            }
            continue;
        }
        const match = /^tallies\.(\d+)$/.exec(change.path);
        if (!match) {
            return { ok: false, message: `Unexpected tally change path: ${change.path}.` };
        }
        const id = Number(match[1]);
        const tally = readTally(change.kind === 'add' ? change.after : change.before);
        if (!tally || tally.id !== id) {
            return { ok: false, message: `The tally preview is missing its snapshot for tally ${id}. Preview again.` };
        }
        operations.push(change.kind === 'add' ? { kind: 'add', tally } : { kind: 'remove', tally });
    }
    return { ok: true, operations };
}

/**
 * Check every operation against a working copy of current state. Simulating
 * additions and removals in order lets a remove-then-add name reuse pass while
 * still rejecting a name that is genuinely in use.
 */
function preflightTallyOperations(tallies: readonly OpenMCTally[], operations: readonly TallyOperation[]): string | undefined {
    const working = cloneTallies(tallies);
    for (const operation of operations) {
        if (operation.kind === 'update') {
            const tally = working.find((candidate) => candidate.id === operation.id);
            if (!tally) {
                return `Tally ${operation.id} no longer exists. Preview again.`;
            }
            for (const change of operation.fields) {
                if (!tallyEquals(tallyValue(tally, change.field), change.before)) {
                    return `Tally ${operation.id} changed since the preview. Preview again.`;
                }
            }
            const record = tally as unknown as Record<string, unknown>;
            for (const change of operation.fields) {
                record[change.field] = tallyClone(change.after);
            }
            continue;
        }
        if (operation.kind === 'add') {
            if (working.some((candidate) => candidate.id === operation.tally.id)) {
                return `Tally ${operation.tally.id} already exists. Preview again.`;
            }
            if (operation.tally.name && working.some((candidate) => candidate.name === operation.tally.name)) {
                return `A tally named "${operation.tally.name}" already exists. Preview again.`;
            }
            working.push(tallyClone(operation.tally));
            continue;
        }
        const index = working.findIndex((candidate) => candidate.id === operation.tally.id);
        if (index < 0) {
            return `Tally ${operation.tally.id} no longer exists. Preview again.`;
        }
        if (!tallyEquals(working[index], operation.tally)) {
            return `Tally ${operation.tally.id} changed since the preview. Preview again.`;
        }
        working.splice(index, 1);
    }
    return undefined;
}

/**
 * Check the reverse of every operation against a working copy of current
 * state so a stale undo fails before any part of the change is reversed.
 */
function preflightTallyUndo(tallies: readonly OpenMCTally[], operations: readonly TallyOperation[]): string | undefined {
    const working = cloneTallies(tallies);
    for (const operation of [...operations].reverse()) {
        if (operation.kind === 'update') {
            const tally = working.find((candidate) => candidate.id === operation.id);
            if (!tally) {
                return `Tally ${operation.id} changed since the edit; the change can no longer be undone.`;
            }
            for (const change of operation.fields) {
                if (!tallyEquals(tallyValue(tally, change.field), change.after)) {
                    return `Tally ${operation.id} changed since the edit; the change can no longer be undone.`;
                }
            }
            const record = tally as unknown as Record<string, unknown>;
            for (const change of operation.fields) {
                record[change.field] = tallyClone(change.before);
            }
            continue;
        }
        if (operation.kind === 'add') {
            const index = working.findIndex((candidate) => candidate.id === operation.tally.id);
            if (index < 0 || !tallyEquals(working[index], operation.tally)) {
                return `Tally ${operation.tally.id} changed since the edit; the change can no longer be undone.`;
            }
            working.splice(index, 1);
            continue;
        }
        if (working.some((candidate) => candidate.id === operation.tally.id)) {
            return `Tally ${operation.tally.id} is in use; the change can no longer be undone.`;
        }
        if (operation.tally.name && working.some((candidate) => candidate.name === operation.tally.name)) {
            return `A tally named "${operation.tally.name}" is in use; the change can no longer be undone.`;
        }
        working.push(tallyClone(operation.tally));
    }
    return undefined;
}

/** Default summary when the preview request does not provide one. */
function defaultTallySummary(actions: readonly OpenMCTallyAction[], addedIds: readonly number[]): string {
    if (actions.length === 1) {
        const action = actions[0];
        if (action.action === 'update') {
            return `Update tally ${action.tallyId}.`;
        }
        if (action.action === 'remove') {
            return `Remove tally ${action.tallyId}.`;
        }
        return `Add tally ${addedIds[0]}.`;
    }
    const parts: string[] = [];
    const adds = actions.filter((action) => action.action === 'add').length;
    const updates = actions.filter((action) => action.action === 'update').length;
    const removes = actions.filter((action) => action.action === 'remove').length;
    if (adds > 0) {
        parts.push(`${adds} add`);
    }
    if (updates > 0) {
        parts.push(`${updates} update`);
    }
    if (removes > 0) {
        parts.push(`${removes} remove`);
    }
    return `Apply ${actions.length} OpenMC tally edits (${parts.join(', ')}).`;
}

/** Build the change set returned by the preview and apply capabilities. */
function tallyChangeSet(proposal: Pick<OpenMCChangeProposal, 'id' | 'summary' | 'changes'>, applyCapability?: string): NukeChangeSet {
    return {
        id: proposal.id,
        title: TALLY_CHANGE_TITLE,
        summary: proposal.summary,
        changes: proposal.changes,
        ...(applyCapability ? { applyCapability } : {})
    };
}

/**
 * Registers tally preview and apply capabilities with the nuke-core registry.
 */
@injectable()
export class OpenMCTallyCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCChangeProposalService) protected readonly proposalService: OpenMCChangeProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: 'nuke.openmc.previewTallyChange',
            title: 'Preview OpenMC tally change',
            description:
                'Validate proposed tally additions, updates, and removals, return a before/after diff, and store an in-memory proposal without changing project state.',
            category: ['OpenMC', 'Tallies'],
            inputSchema: PREVIEW_TALLY_INPUT_SCHEMA,
            outputSchema: TALLY_CHANGE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => true,
            invoke: async (input) => this.previewTallyChange(input)
        });

        registry.register({
            id: 'nuke.openmc.applyTallyChange',
            title: 'Apply OpenMC tally change',
            description:
                'Apply a previously previewed tally change, reject stale previews, and register an in-memory undo for the affected tallies and fields.',
            category: ['OpenMC', 'Tallies'],
            inputSchema: APPLY_TALLY_INPUT_SCHEMA,
            outputSchema: TALLY_CHANGE_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: true,
            when: () => true,
            invoke: async (input) => this.applyTallyChange(input)
        });
    }

    /**
     * Validate and diff proposed tally actions without touching state. The
     * stored proposal pins the current tallies so apply can detect a stale
     * preview.
     */
    protected async previewTallyChange(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const parsed = readTallyActions(record.actions);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }

        const tallies = cloneTallies(this.stateManager.getState().tallies);
        const errors = validateTallyActions(tallies, parsed.actions);
        if (errors.length > 0) {
            return { ok: false, message: errors.join(' ') };
        }

        let preview: OpenMCTallyPreview;
        try {
            preview = previewTallyActions(tallies, parsed.actions, this.stateManager.getNextTallyId());
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        }

        const summary = readString(record, 'summary')?.trim() || defaultTallySummary(parsed.actions, preview.addedIds);
        const proposal = this.proposalService.create({
            scope: 'tallies',
            summary,
            changes: preview.changes,
            before: tallies,
            after: preview.after
        });
        return {
            ok: true,
            data: { proposalId: proposal.id, summary, changes: preview.changes },
            changeSet: tallyChangeSet(proposal, 'nuke.openmc.applyTallyChange'),
            nextActions: [{ capability: 'nuke.openmc.applyTallyChange', reason: 'Apply the previewed tally change after confirmation.' }]
        };
    }

    /**
     * Apply a live tally proposal after verifying every change against current
     * state, then register a session undo that reverses only those tallies and
     * fields.
     */
    protected async applyTallyChange(input: unknown): Promise<NukeCapabilityResult> {
        const proposalId = readString(readRecord(input), 'proposalId')?.trim();
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }

        const proposal = this.proposalService.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This tally preview is missing or has expired. Preview again.' };
        }
        const wrongScope = scopeError(proposal, 'tallies');
        if (wrongScope) {
            return { ok: false, message: wrongScope };
        }
        const beforeSnapshot = readTallySnapshot(proposal.before);
        const afterSnapshot = readTallySnapshot(proposal.after);
        if (!beforeSnapshot || !afterSnapshot) {
            return { ok: false, message: 'This tally preview is missing its tally snapshot. Preview again.' };
        }

        const parsed = readTallyOperations(proposal.changes);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }

        const current = cloneTallies(this.stateManager.getState().tallies);
        const stale = preflightTallyOperations(current, parsed.operations);
        if (stale) {
            return { ok: false, message: stale };
        }

        for (const operation of parsed.operations) {
            if (operation.kind === 'update') {
                this.stateManager.updateTally(operation.id, this.updateFields(operation.fields, 'after'));
                continue;
            }
            if (operation.kind === 'add') {
                this.stateManager.addTally(tallyClone(operation.tally));
                continue;
            }
            this.stateManager.removeTally(operation.tally.id);
        }
        this.proposalService.remove(proposal.id);
        const undoToken = this.undoService.register(this.createTallyUndo(proposal, parsed.operations));
        return {
            ok: true,
            data: { proposalId: proposal.id, summary: proposal.summary, changes: proposal.changes },
            changeSet: tallyChangeSet(proposal),
            undoToken,
            nextActions: [{ capability: 'nuke.openmc.diagnoseProject', reason: 'Check the project after applying the tally change.' }]
        };
    }

    /** Collect field values into an `updateTally` payload. */
    protected updateFields(fields: readonly TallyFieldChange[], side: 'before' | 'after'): Partial<OpenMCTally> {
        const updates: Record<string, unknown> = {};
        for (const field of fields) {
            updates[field.field] = tallyClone(side === 'before' ? field.before : field.after);
        }
        return updates as Partial<OpenMCTally>;
    }

    /** Build the undo handler for an applied tally proposal. */
    protected createTallyUndo(proposal: OpenMCChangeProposal, operations: readonly TallyOperation[]): NukeUndoEntry {
        return {
            title: `Undo ${proposal.summary}`,
            undo: async () => {
                const current = cloneTallies(this.stateManager.getState().tallies);
                const stale = preflightTallyUndo(current, operations);
                if (stale) {
                    return { ok: false, message: stale };
                }
                for (const operation of [...operations].reverse()) {
                    if (operation.kind === 'update') {
                        this.stateManager.updateTally(operation.id, this.updateFields(operation.fields, 'before'));
                        continue;
                    }
                    if (operation.kind === 'add') {
                        this.stateManager.removeTally(operation.tally.id);
                        continue;
                    }
                    this.stateManager.addTally(tallyClone(operation.tally));
                }
                return { ok: true, message: 'Tally change undone.' };
            }
        };
    }
}
