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
 * OpenMC Geometry Capabilities
 *
 * Preview, apply, and undo CSG geometry edits through the generic OpenMC
 * change proposal store. Previews run the pure {@link applyGeometryActions}
 * loop, then the shared geometry validator and the backend validator, so the
 * AI capability path and the CSG Builder reject the same invalid models.
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
import { applyGeometryActions, GeometryAction, GeometryKind, MAX_GEOMETRY_ACTIONS } from '../../common/geometry-edit';
import { validateGeometryModel } from '../../common/geometry-validation';
import { OpenMCGeometry } from '../../common/openmc-state-schema';
import { OpenMCStudioBackendService, ValidationIssue } from '../../common/openmc-studio-protocol';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposal, OpenMCChangeProposalService, scopeError } from './openmc-change-proposal-service';

/** Read capability that validates and stores a CSG geometry proposal. */
export const PREVIEW_GEOMETRY_CAPABILITY_ID = 'nuke.openmc.previewGeometryChange';

/** Write capability that applies a stored CSG geometry proposal. */
export const APPLY_GEOMETRY_CAPABILITY_ID = 'nuke.openmc.applyGeometryChange';

/** Read-only capability suggested after apply to verify the project. */
const DIAGNOSE_PROJECT_CAPABILITY_ID = 'nuke.openmc.diagnoseProject';

/** Diff card title shared by preview and apply. */
const GEOMETRY_CHANGE_TITLE = 'OpenMC geometry change';

/** Rejection for a proposal that is gone or past its TTL. */
const GEOMETRY_PROPOSAL_MISSING = 'This geometry preview is missing or has expired. Preview again.';

/** Rejection for an apply whose model changed after the preview. */
const GEOMETRY_APPLY_STALE = 'Geometry changed since the preview. Preview again.';

/** Rejection for an undo whose model changed after apply. */
const GEOMETRY_UNDO_STALE = 'Geometry changed since the edit; the change can no longer be undone.';

/** DAGMC projects own their geometry in the `.h5m` file. */
const DAGMC_GEOMETRY_MESSAGE = 'This project uses DAGMC geometry. Clear the DAGMC file before authoring CSG geometry.';

/** Action-kind values accepted by the input schema and reader. */
const GEOMETRY_KINDS: readonly GeometryKind[] = ['surface', 'cell', 'universe', 'lattice'];

/** Number of actions per change kind. */
interface GeometryCounts {
    readonly add: number;
    readonly update: number;
    readonly remove: number;
}

/** Result of reading the preview `actions` input. */
type GeometryActionsReadResult = { ok: true; actions: GeometryAction[] } | { ok: false; message: string };

const GEOMETRY_KIND_SCHEMA: NukeJsonSchemaProperty = {
    type: 'string',
    enum: [...GEOMETRY_KINDS],
    description: 'Geometry entity kind.'
};

const GEOMETRY_ADD_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'add' },
        kind: GEOMETRY_KIND_SCHEMA,
        value: {
            type: 'object',
            description: 'New entity; the id is assigned automatically when omitted, otherwise it must be unique for the kind.'
        }
    },
    required: ['action', 'kind', 'value'],
    additionalProperties: false
};

const GEOMETRY_UPDATE_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'update' },
        kind: GEOMETRY_KIND_SCHEMA,
        id: { type: 'integer', description: 'Existing entity id.' },
        updates: { type: 'object', description: 'Fields to change; id is read-only.' }
    },
    required: ['action', 'kind', 'id', 'updates'],
    additionalProperties: false
};

const GEOMETRY_REMOVE_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'remove' },
        kind: GEOMETRY_KIND_SCHEMA,
        id: { type: 'integer', description: 'Existing entity id.' }
    },
    required: ['action', 'kind', 'id'],
    additionalProperties: false
};

const PREVIEW_GEOMETRY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        actions: {
            type: 'array',
            description: 'One add, update, or remove action per geometry entity.',
            minItems: 1,
            maxItems: MAX_GEOMETRY_ACTIONS,
            items: { oneOf: [GEOMETRY_ADD_ACTION_SCHEMA, GEOMETRY_UPDATE_ACTION_SCHEMA, GEOMETRY_REMOVE_ACTION_SCHEMA] }
        },
        summary: { type: 'string', description: 'Optional short description of the whole change.' }
    },
    required: ['actions'],
    additionalProperties: false
};

const GEOMETRY_CHANGES_SCHEMA: NukeJsonSchemaProperty = {
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
};

const GEOMETRY_COUNTS_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        add: { type: 'integer' },
        update: { type: 'integer' },
        remove: { type: 'integer' }
    },
    required: ['add', 'update', 'remove'],
    additionalProperties: false
};

const GEOMETRY_CHANGE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: GEOMETRY_CHANGES_SCHEMA,
        counts: GEOMETRY_COUNTS_SCHEMA
    },
    required: ['proposalId', 'summary', 'changes', 'counts'],
    additionalProperties: false
};

const APPLY_GEOMETRY_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: GEOMETRY_CHANGES_SCHEMA,
        counts: GEOMETRY_COUNTS_SCHEMA,
        undoToken: { type: 'string', description: 'Session undo token for the applied geometry change.' }
    },
    required: ['proposalId', 'summary', 'changes', 'counts', 'undoToken'],
    additionalProperties: false
};

const APPLY_GEOMETRY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewGeometryChange.' }
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

/** True for a non-negative integer id; universe 0 is a real, editable universe. */
function isEntityId(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** True for a supported geometry kind. */
function isGeometryKind(value: unknown): value is GeometryKind {
    return typeof value === 'string' && (GEOMETRY_KINDS as readonly string[]).includes(value);
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Read and shape-check the preview `actions` array. */
function readGeometryActions(value: unknown): GeometryActionsReadResult {
    if (!Array.isArray(value)) {
        return { ok: false, message: `Provide an actions array with 1 to ${MAX_GEOMETRY_ACTIONS} geometry actions.` };
    }
    if (value.length < 1 || value.length > MAX_GEOMETRY_ACTIONS) {
        return { ok: false, message: `Provide between 1 and ${MAX_GEOMETRY_ACTIONS} geometry actions.` };
    }

    const actions: GeometryAction[] = [];
    for (const entry of value) {
        if (!isRecord(entry)) {
            return { ok: false, message: 'Each geometry action must be an object.' };
        }
        if (!isGeometryKind(entry.kind)) {
            return { ok: false, message: 'Each geometry action needs a kind of surface, cell, universe, or lattice.' };
        }
        if (entry.action === 'add') {
            if (!isRecord(entry.value)) {
                return { ok: false, message: 'Each add action needs a value object.' };
            }
            actions.push({ action: 'add', kind: entry.kind, value: entry.value });
        } else if (entry.action === 'update') {
            if (!isEntityId(entry.id) || !isRecord(entry.updates)) {
                return { ok: false, message: 'Each update action needs a non-negative integer id and an updates object.' };
            }
            actions.push({ action: 'update', kind: entry.kind, id: entry.id, updates: entry.updates });
        } else if (entry.action === 'remove') {
            if (!isEntityId(entry.id)) {
                return { ok: false, message: 'Each remove action needs a non-negative integer id.' };
            }
            actions.push({ action: 'remove', kind: entry.kind, id: entry.id });
        } else {
            return { ok: false, message: 'Each geometry action must be add, update, or remove.' };
        }
    }
    return { ok: true, actions };
}

/** Count changes by kind. */
function countChanges(changes: readonly NukeChange[]): GeometryCounts {
    return {
        add: changes.filter((change) => change.kind === 'add').length,
        update: changes.filter((change) => change.kind === 'update').length,
        remove: changes.filter((change) => change.kind === 'remove').length
    };
}

/** Build the change set returned by the preview and apply capabilities. */
function geometryChangeSet(proposal: Pick<OpenMCChangeProposal, 'id' | 'summary' | 'changes'>, applyCapability?: string): NukeChangeSet {
    return {
        id: proposal.id,
        title: GEOMETRY_CHANGE_TITLE,
        summary: proposal.summary,
        changes: proposal.changes,
        ...(applyCapability ? { applyCapability } : {})
    };
}

/** Default summary when the preview request does not provide one. */
function defaultGeometrySummary(changes: readonly NukeChange[]): string {
    if (changes.length === 1) {
        return `${changes[0].label}.`;
    }
    return `Apply ${changes.length} CSG geometry changes.`;
}

/** True when a value looks like a complete CSG geometry snapshot. */
function isGeometrySnapshot(value: unknown): value is OpenMCGeometry {
    if (!isRecord(value)) {
        return false;
    }
    return (
        Array.isArray(value.surfaces) &&
        Array.isArray(value.cells) &&
        Array.isArray(value.universes) &&
        Array.isArray(value.lattices) &&
        typeof value.rootUniverseId === 'number'
    );
}

/** Deep-clone a geometry snapshot before it enters a proposal. */
function cloneGeometry(geometry: OpenMCGeometry): OpenMCGeometry {
    return JSON.parse(JSON.stringify(geometry)) as OpenMCGeometry;
}

/**
 * Compare JSON-like values by structure.
 *
 * Optional unset fields compare equal to missing keys, and object key order is
 * irrelevant, so serializing and deserializing a snapshot never looks stale.
 */
function structuralEquals(left: unknown, right: unknown): boolean {
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
        return left.every((value, index) => structuralEquals(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
    const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    return leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && structuralEquals(leftRecord[key], rightRecord[key])
    );
}

/** Error messages from validation issues, capped at three for the capability reply. */
function validationMessages(issues: readonly ValidationIssue[]): string[] {
    return issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
}

/**
 * Registers the OpenMC CSG geometry preview/apply capabilities with the
 * nuke-core registry.
 */
@injectable()
export class OpenMCGeometryCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCChangeProposalService) protected readonly proposalService: OpenMCChangeProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService,
        @inject(OpenMCStudioBackendService) protected readonly backendService: OpenMCStudioBackendService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: PREVIEW_GEOMETRY_CAPABILITY_ID,
            title: 'Preview OpenMC CSG geometry change',
            description:
                'Validate proposed surface, cell, universe, and lattice edits, return a before/after diff, and store an in-memory proposal without changing project state.',
            category: ['OpenMC', 'Geometry'],
            inputSchema: PREVIEW_GEOMETRY_INPUT_SCHEMA,
            outputSchema: GEOMETRY_CHANGE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [
                {
                    description: 'Add an outer z-plane and use it in a new cell region.',
                    input: {
                        actions: [
                            { action: 'add', kind: 'surface', value: { id: 10, type: 'z-plane', coefficients: { z0: 10 } } },
                            { action: 'add', kind: 'cell', value: { id: 10, regionString: '-10', fillType: 'void' } }
                        ]
                    }
                },
                {
                    description: 'Rename a universe.',
                    input: { actions: [{ action: 'update', kind: 'universe', id: 1, updates: { name: 'Assembly' } }] }
                }
            ],
            when: () => true,
            invoke: async (input) => this.previewGeometryChange(input)
        });

        registry.register({
            id: APPLY_GEOMETRY_CAPABILITY_ID,
            title: 'Apply OpenMC CSG geometry change',
            description:
                'Apply a previously previewed CSG geometry change, reject stale or cross-domain previews, and register an in-memory undo.',
            category: ['OpenMC', 'Geometry'],
            inputSchema: APPLY_GEOMETRY_INPUT_SCHEMA,
            outputSchema: APPLY_GEOMETRY_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: true,
            examples: [{ description: 'Apply the previewed geometry change.', input: { proposalId: 'proposal-id' } }],
            when: () => true,
            invoke: async (input) => this.applyGeometryChange(input)
        });
    }

    /**
     * Validate and diff proposed geometry actions without touching state. The
     * stored proposal pins the current geometry so apply can detect a stale
     * preview.
     */
    protected async previewGeometryChange(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const parsed = readGeometryActions(record.actions);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }

        const state = this.stateManager.getState();
        if (typeof state.settings.dagmcFile === 'string' && state.settings.dagmcFile.trim().length > 0) {
            return { ok: false, message: DAGMC_GEOMETRY_MESSAGE };
        }

        const preview = applyGeometryActions(state.geometry, parsed.actions);
        if (!preview.ok) {
            return { ok: false, message: preview.message };
        }

        const messages = validationMessages(validateGeometryModel(preview.geometry));
        if (this.backendService) {
            try {
                const validation = await this.backendService.validateState({
                    state: { ...state, geometry: preview.geometry },
                    level: 'standard'
                });
                messages.push(...validationMessages(validation.issues));
            } catch {
                // The backend is unavailable; the pure geometry validator still ran.
            }
        }
        const uniqueMessages = [...new Set(messages)];
        if (uniqueMessages.length > 0) {
            return { ok: false, message: uniqueMessages.slice(0, 3).join(' ') };
        }

        const summary = readString(record, 'summary')?.trim() || defaultGeometrySummary(preview.changes);
        const proposal = this.proposalService.create({
            scope: 'geometry',
            summary,
            changes: preview.changes,
            before: state.geometry,
            after: preview.geometry
        });
        const counts = countChanges(preview.changes);
        return {
            ok: true,
            data: { proposalId: proposal.id, summary, changes: preview.changes, counts },
            changeSet: geometryChangeSet(proposal, APPLY_GEOMETRY_CAPABILITY_ID),
            nextActions: [{ capability: APPLY_GEOMETRY_CAPABILITY_ID, reason: 'Apply the previewed geometry change after confirmation.' }]
        };
    }

    /**
     * Apply a live geometry proposal after verifying the current geometry is
     * still the snapshot the preview was built from, then register an undo.
     */
    protected async applyGeometryChange(input: unknown): Promise<NukeCapabilityResult> {
        const proposalId = readString(readRecord(input), 'proposalId')?.trim();
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }

        const proposal = this.proposalService.get(proposalId);
        if (!proposal) {
            return { ok: false, message: GEOMETRY_PROPOSAL_MISSING };
        }
        const wrongScope = scopeError(proposal, 'geometry');
        if (wrongScope) {
            return { ok: false, message: wrongScope };
        }
        if (!isGeometrySnapshot(proposal.before) || !isGeometrySnapshot(proposal.after)) {
            return { ok: false, message: 'This geometry preview is missing its geometry snapshot. Preview again.' };
        }

        const before = cloneGeometry(proposal.before);
        const after = cloneGeometry(proposal.after);
        const state = this.stateManager.getState();
        if (!structuralEquals(state.geometry, before)) {
            return { ok: false, message: GEOMETRY_APPLY_STALE };
        }

        try {
            this.stateManager.setState({ ...state, geometry: after }, true);
        } catch (error) {
            return { ok: false, message: `Applying the geometry change failed: ${errorMessage(error)}` };
        }
        this.proposalService.remove(proposal.id);
        const undoToken = this.undoService.register(this.createGeometryUndo(proposal.summary, before, after));
        return {
            ok: true,
            data: { proposalId: proposal.id, summary: proposal.summary, changes: proposal.changes, counts: countChanges(proposal.changes) },
            changeSet: geometryChangeSet(proposal),
            undoToken,
            nextActions: [{ capability: DIAGNOSE_PROJECT_CAPABILITY_ID, reason: 'Check the project after applying the geometry change.' }]
        };
    }

    /** Build the reverse handler for an applied geometry proposal. */
    protected createGeometryUndo(summary: string, before: OpenMCGeometry, after: OpenMCGeometry): NukeUndoEntry {
        return {
            title: `Undo ${summary}`,
            undo: async () => {
                const state = this.stateManager.getState();
                if (!structuralEquals(state.geometry, after)) {
                    return { ok: false, message: GEOMETRY_UNDO_STALE };
                }
                try {
                    this.stateManager.setState({ ...state, geometry: before }, true);
                } catch (error) {
                    return { ok: false, message: `Undoing the geometry change failed: ${errorMessage(error)}` };
                }
                return { ok: true, message: 'Geometry change undone.' };
            }
        };
    }
}
