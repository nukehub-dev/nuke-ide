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
 * OpenMC Material Capabilities
 *
 * Preview, apply, and undo material additions, updates, and removals through
 * the generic OpenMC change proposal store. Reads come from
 * {@link OpenMCStateManager}, writes go back through its material methods, and
 * the reverse handler is path-scoped so unrelated materials and unrelated
 * fields survive both apply and undo.
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
import { OpenMCMaterial } from '../../common/openmc-state-schema';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposal, OpenMCChangeProposalService, scopeError } from './openmc-change-proposal-service';
import {
    isMaterialEditableField,
    materialEquals,
    materialValue,
    MAX_MATERIAL_ACTIONS,
    OpenMCMaterialAction,
    OpenMCMaterialEditableField,
    OpenMCMaterialPreview,
    previewMaterialActions
} from './openmc-material-edit';

/** Read capability that computes and stores a material proposal. */
export const PREVIEW_MATERIAL_CAPABILITY_ID = 'nuke.openmc.previewMaterialChange';

/** Write capability that applies a stored material proposal. */
export const APPLY_MATERIAL_CAPABILITY_ID = 'nuke.openmc.applyMaterialChange';

/** Read-only capability suggested after apply to verify the project. */
export const DIAGNOSE_PROJECT_CAPABILITY_ID = 'nuke.openmc.diagnoseProject';

/** Diff card title shared by preview and apply. */
const MATERIAL_CHANGE_TITLE = 'OpenMC material change';

/** Message for a proposal that is gone or past its TTL. */
const MATERIAL_PROPOSAL_MISSING = 'This materials preview is missing or has expired. Preview again.';

/** Message for an undo whose target was edited after apply. */
const MATERIAL_UNDO_STALE = 'Materials changed since the edit; the change can no longer be undone.';

const MATERIAL_UPDATE_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'update' },
        materialId: { type: 'integer', description: 'Existing material id.' },
        updates: {
            type: 'object',
            description:
                'Editable fields to change: name, density, densityUnit, nuclides, thermalScattering, color, temperature, volume, isDepletable, ncrystalCfg, isotropic.'
        }
    },
    required: ['action', 'materialId', 'updates'],
    additionalProperties: false
};

const MATERIAL_ADD_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'add' },
        material: {
            type: 'object',
            description: 'New material with name, density, and densityUnit plus optional editable fields; the id is assigned automatically.'
        }
    },
    required: ['action', 'material'],
    additionalProperties: false
};

const MATERIAL_REMOVE_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'remove' },
        materialId: { type: 'integer', description: 'Existing material id.' }
    },
    required: ['action', 'materialId'],
    additionalProperties: false
};

const MATERIAL_ACTION_ITEMS_SCHEMA: NukeJsonSchemaProperty = {
    oneOf: [MATERIAL_UPDATE_ACTION_SCHEMA, MATERIAL_ADD_ACTION_SCHEMA, MATERIAL_REMOVE_ACTION_SCHEMA]
};

const PREVIEW_MATERIAL_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        actions: {
            type: 'array',
            description: 'One update, add, or remove action per material.',
            minItems: 1,
            maxItems: MAX_MATERIAL_ACTIONS,
            items: MATERIAL_ACTION_ITEMS_SCHEMA
        },
        summary: { type: 'string', description: 'Optional short description of the whole change.' }
    },
    required: ['actions'],
    additionalProperties: false
};

const MATERIAL_CHANGES_SCHEMA: NukeJsonSchemaProperty = {
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

const MATERIAL_CHANGE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: MATERIAL_CHANGES_SCHEMA
    },
    required: ['proposalId', 'summary', 'changes'],
    additionalProperties: false
};

const APPLY_MATERIAL_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: MATERIAL_CHANGES_SCHEMA,
        undoToken: { type: 'string', description: 'Session undo token for the applied material change.' }
    },
    required: ['proposalId', 'summary', 'changes', 'undoToken'],
    additionalProperties: false
};

const APPLY_MATERIAL_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewMaterialChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

/** Set of editable fields used when reading a proposal diff back into operations. */
type MaterialFieldEdit = {
    readonly field: OpenMCMaterialEditableField;
    readonly before: unknown;
    readonly after: unknown;
};

/** Grouped apply/undo operation derived from proposal changes. */
type MaterialApplyOperation =
    | { readonly kind: 'update'; readonly materialId: number; readonly fields: MaterialFieldEdit[] }
    | { readonly kind: 'add'; readonly material: OpenMCMaterial }
    | { readonly kind: 'remove'; readonly material: OpenMCMaterial };

/** Result of reading the preview `actions` input. */
type MaterialActionsReadResult = { ok: true; actions: OpenMCMaterialAction[] } | { ok: false; message: string };

/** Read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read an optional string field from a capability input object. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

/** True for a positive integer. */
function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Read and shape-check the preview `actions` array. */
function readMaterialActions(value: unknown): MaterialActionsReadResult {
    if (!Array.isArray(value)) {
        return { ok: false, message: `Provide an actions array with 1 to ${MAX_MATERIAL_ACTIONS} material actions.` };
    }
    if (value.length < 1 || value.length > MAX_MATERIAL_ACTIONS) {
        return { ok: false, message: `Provide between 1 and ${MAX_MATERIAL_ACTIONS} material actions.` };
    }
    const actions: OpenMCMaterialAction[] = [];
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: 'Each material action must be an object.' };
        }
        const record = entry as Record<string, unknown>;
        switch (record.action) {
            case 'update': {
                if (!isPositiveInteger(record.materialId)) {
                    return { ok: false, message: 'Each update action needs a positive integer materialId.' };
                }
                const updates = record.updates;
                if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
                    return { ok: false, message: `Update for material ${record.materialId} needs an updates object.` };
                }
                actions.push(record as unknown as OpenMCMaterialAction);
                break;
            }
            case 'add': {
                const material = record.material;
                if (material === null || typeof material !== 'object' || Array.isArray(material)) {
                    return { ok: false, message: 'Each add action needs a material object.' };
                }
                actions.push(record as unknown as OpenMCMaterialAction);
                break;
            }
            case 'remove': {
                if (!isPositiveInteger(record.materialId)) {
                    return { ok: false, message: 'Each remove action needs a positive integer materialId.' };
                }
                actions.push(record as unknown as OpenMCMaterialAction);
                break;
            }
            default:
                return { ok: false, message: 'Each material action must be update, add, or remove.' };
        }
    }
    return { ok: true, actions };
}

/** True when a value looks like a complete material snapshot. */
function isMaterialSnapshot(value: unknown): value is OpenMCMaterial {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        typeof record.id === 'number' &&
        Number.isInteger(record.id) &&
        record.id >= 1 &&
        typeof record.name === 'string' &&
        typeof record.density === 'number' &&
        typeof record.densityUnit === 'string' &&
        Array.isArray(record.nuclides) &&
        Array.isArray(record.thermalScattering)
    );
}

/** Read a materials snapshot stored on a generic proposal. */
function readMaterialsSnapshot(value: unknown): OpenMCMaterial[] | undefined {
    if (!Array.isArray(value) || !value.every((entry) => isMaterialSnapshot(entry))) {
        return undefined;
    }
    return value as OpenMCMaterial[];
}

/** Build a default summary from the requested actions and current materials. */
function defaultMaterialSummary(materials: readonly OpenMCMaterial[], actions: readonly OpenMCMaterialAction[]): string {
    if (actions.length !== 1) {
        return `Apply ${actions.length} OpenMC material changes.`;
    }
    const action = actions[0];
    if (action.action === 'add') {
        const name = typeof action.material.name === 'string' ? action.material.name.trim() : '';
        return name.length > 0 ? `Add material ${name}.` : 'Add an OpenMC material.';
    }
    const material = materials.find((candidate) => candidate.id === action.materialId);
    const name = material ? ` ${material.name}` : ` ${action.materialId}`;
    return action.action === 'remove' ? `Remove material${name}.` : `Update material${name}.`;
}

/** Build the change set returned by the preview and apply capabilities. */
function materialChangeSet(proposal: Pick<OpenMCChangeProposal, 'id' | 'summary' | 'changes'>, applyCapability?: string): NukeChangeSet {
    return {
        id: proposal.id,
        title: MATERIAL_CHANGE_TITLE,
        summary: proposal.summary,
        changes: proposal.changes,
        ...(applyCapability ? { applyCapability } : {})
    };
}

/** Group proposal changes into one apply operation per material. */
function materialOperations(
    changes: readonly NukeChange[]
): { ok: true; operations: MaterialApplyOperation[] } | { ok: false; message: string } {
    if (changes.length === 0) {
        return { ok: false, message: 'This materials preview has no changes. Preview again.' };
    }
    const operations: MaterialApplyOperation[] = [];
    const updateById = new Map<number, { kind: 'update'; materialId: number; fields: MaterialFieldEdit[] }>();
    const targeted = new Set<number>();
    for (const change of changes) {
        const match = /^materials\.(\d+)(?:\.([A-Za-z][A-Za-z0-9]*))?$/.exec(change.path);
        if (!match) {
            return { ok: false, message: `The material proposal contains an unsupported change path: ${change.path}.` };
        }
        const materialId = Number.parseInt(match[1], 10);
        if (!isPositiveInteger(materialId)) {
            return { ok: false, message: `The material proposal contains an invalid material id: ${change.path}.` };
        }
        const field = match[2];
        if (change.kind === 'update') {
            if (!field || !isMaterialEditableField(field)) {
                return { ok: false, message: `The material proposal contains an unsupported update path: ${change.path}.` };
            }
            const existing = updateById.get(materialId);
            if (existing) {
                existing.fields.push({ field, before: change.before, after: change.after });
                continue;
            }
            if (targeted.has(materialId)) {
                return { ok: false, message: `The material proposal changes material ${materialId} more than once.` };
            }
            const updateOperation = {
                kind: 'update' as const,
                materialId,
                fields: [{ field, before: change.before, after: change.after }]
            };
            updateById.set(materialId, updateOperation);
            targeted.add(materialId);
            operations.push(updateOperation);
            continue;
        }
        if (field) {
            return { ok: false, message: `The material proposal contains an unsupported change path: ${change.path}.` };
        }
        if (targeted.has(materialId)) {
            return { ok: false, message: `The material proposal changes material ${materialId} more than once.` };
        }
        if (change.kind === 'add') {
            if (!isMaterialSnapshot(change.after) || change.after.id !== materialId) {
                return { ok: false, message: `The material proposal is missing the added material for ${change.path}.` };
            }
            operations.push({ kind: 'add', material: change.after });
        } else if (change.kind === 'remove') {
            if (!isMaterialSnapshot(change.before) || change.before.id !== materialId) {
                return { ok: false, message: `The material proposal is missing the removed material for ${change.path}.` };
            }
            operations.push({ kind: 'remove', material: change.before });
        } else {
            return { ok: false, message: `The material proposal contains an unsupported change kind: ${change.kind}.` };
        }
        targeted.add(materialId);
    }
    return { ok: true, operations };
}

/** Reject the whole apply when any change no longer matches the current materials. */
function preflightMaterialOperations(
    materials: readonly OpenMCMaterial[],
    operations: readonly MaterialApplyOperation[]
): string | undefined {
    for (const operation of operations) {
        if (operation.kind === 'update') {
            const current = materials.find((material) => material.id === operation.materialId);
            if (!current) {
                return `Material ${operation.materialId} no longer exists. Preview again.`;
            }
            for (const edit of operation.fields) {
                if (!materialEquals(materialValue(current, edit.field), edit.before)) {
                    return `Material ${operation.materialId} changed since the preview. Preview again.`;
                }
            }
        } else if (operation.kind === 'add') {
            if (materials.some((material) => material.id === operation.material.id)) {
                return `Material ${operation.material.id} is already in use. Preview again.`;
            }
            if (materials.some((material) => material.name === operation.material.name)) {
                return `Material name "${operation.material.name}" is already in use. Preview again.`;
            }
        } else {
            const current = materials.find((material) => material.id === operation.material.id);
            if (!current || !materialEquals(current, operation.material)) {
                return `Material ${operation.material.id} changed since the preview. Preview again.`;
            }
        }
    }
    return undefined;
}

/** Reject the whole undo when any applied change was edited again. */
function preflightMaterialUndo(materials: readonly OpenMCMaterial[], operations: readonly MaterialApplyOperation[]): string | undefined {
    for (const operation of operations) {
        if (operation.kind === 'update') {
            const current = materials.find((material) => material.id === operation.materialId);
            if (!current) {
                return MATERIAL_UNDO_STALE;
            }
            for (const edit of operation.fields) {
                if (!materialEquals(materialValue(current, edit.field), edit.after)) {
                    return MATERIAL_UNDO_STALE;
                }
            }
        } else if (operation.kind === 'add') {
            const current = materials.find((material) => material.id === operation.material.id);
            if (!current || !materialEquals(current, operation.material)) {
                return MATERIAL_UNDO_STALE;
            }
        } else {
            if (
                materials.some((material) => material.id === operation.material.id) ||
                materials.some((material) => material.name === operation.material.name)
            ) {
                return MATERIAL_UNDO_STALE;
            }
        }
    }
    return undefined;
}

/** Deep-clone a material before handing it to the state manager. */
function cloneMaterial(material: OpenMCMaterial): OpenMCMaterial {
    return JSON.parse(JSON.stringify(material)) as OpenMCMaterial;
}

/**
 * Registers the OpenMC material preview/apply capabilities with the nuke-core
 * registry.
 */
@injectable()
export class OpenMCMaterialCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCChangeProposalService) protected readonly proposalService: OpenMCChangeProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: PREVIEW_MATERIAL_CAPABILITY_ID,
            title: 'Preview OpenMC material change',
            description:
                'Validate proposed material additions, updates, and removals, return a before/after diff, and store an in-memory proposal without changing project state.',
            category: ['OpenMC', 'Materials'],
            inputSchema: PREVIEW_MATERIAL_INPUT_SCHEMA,
            outputSchema: MATERIAL_CHANGE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [
                {
                    description: 'Rename the Water material and lower its density.',
                    input: { actions: [{ action: 'update', materialId: 1, updates: { name: 'Coolant', density: 0.998 } }] }
                },
                {
                    description: 'Add a depletable steel material.',
                    input: {
                        actions: [
                            {
                                action: 'add',
                                material: {
                                    name: 'Steel',
                                    density: 7.87,
                                    densityUnit: 'g/cm3',
                                    nuclides: [{ name: 'Fe56', fraction: 1, fractionType: 'ao' }],
                                    isDepletable: true,
                                    volume: 100
                                }
                            }
                        ]
                    }
                }
            ],
            when: () => true,
            invoke: async (input) => this.previewMaterialChange(input)
        });

        registry.register({
            id: APPLY_MATERIAL_CAPABILITY_ID,
            title: 'Apply OpenMC material change',
            description:
                'Apply a previously previewed material change, reject stale or cross-domain previews, and register a path-scoped in-memory undo.',
            category: ['OpenMC', 'Materials'],
            inputSchema: APPLY_MATERIAL_INPUT_SCHEMA,
            outputSchema: APPLY_MATERIAL_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: true,
            examples: [{ description: 'Apply the previewed material change.', input: { proposalId: 'proposal-id' } }],
            when: () => true,
            invoke: async (input) => this.applyMaterialChange(input)
        });
    }

    /**
     * Validate and diff proposed material actions without touching state. The
     * stored proposal pins the current materials so apply can detect a stale
     * preview.
     */
    protected async previewMaterialChange(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const parsed = readMaterialActions(record.actions);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }

        const materials = this.stateManager.getState().materials;
        let preview: OpenMCMaterialPreview;
        try {
            preview = previewMaterialActions(materials, parsed.actions, this.stateManager.getNextMaterialId());
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        }

        const summary = readString(record, 'summary')?.trim() || defaultMaterialSummary(materials, parsed.actions);
        const proposal = this.proposalService.create({
            scope: 'materials',
            summary,
            changes: preview.changes,
            before: materials,
            after: preview.after
        });
        return {
            ok: true,
            data: { proposalId: proposal.id, summary, changes: preview.changes },
            changeSet: materialChangeSet(proposal, APPLY_MATERIAL_CAPABILITY_ID),
            nextActions: [{ capability: APPLY_MATERIAL_CAPABILITY_ID, reason: 'Apply the previewed material change after confirmation.' }]
        };
    }

    /**
     * Apply a live material proposal after verifying every change against the
     * current materials, then register a path-scoped undo.
     */
    protected async applyMaterialChange(input: unknown): Promise<NukeCapabilityResult> {
        const proposalId = readString(readRecord(input), 'proposalId')?.trim();
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }

        const proposal = this.proposalService.get(proposalId);
        if (!proposal) {
            return { ok: false, message: MATERIAL_PROPOSAL_MISSING };
        }
        const wrongScope = scopeError(proposal, 'materials');
        if (wrongScope) {
            return { ok: false, message: wrongScope };
        }
        if (!readMaterialsSnapshot(proposal.before) || !readMaterialsSnapshot(proposal.after)) {
            return { ok: false, message: 'This materials preview is missing its materials snapshot. Preview again.' };
        }

        const derived = materialOperations(proposal.changes);
        if (!derived.ok) {
            return { ok: false, message: derived.message };
        }

        const stale = preflightMaterialOperations(this.stateManager.getState().materials, derived.operations);
        if (stale) {
            return { ok: false, message: stale };
        }

        this.applyMaterialOperations(derived.operations);
        this.proposalService.remove(proposal.id);
        const undoToken = this.undoService.register(this.createMaterialUndo(proposal, derived.operations));
        return {
            ok: true,
            data: { proposalId: proposal.id, summary: proposal.summary, changes: proposal.changes },
            changeSet: materialChangeSet(proposal),
            undoToken,
            nextActions: [{ capability: DIAGNOSE_PROJECT_CAPABILITY_ID, reason: 'Check the project after applying the material change.' }]
        };
    }

    /** Apply grouped operations in preview order. */
    protected applyMaterialOperations(operations: readonly MaterialApplyOperation[]): void {
        for (const operation of operations) {
            if (operation.kind === 'update') {
                const updates: Record<string, unknown> = {};
                for (const edit of operation.fields) {
                    updates[edit.field] = edit.after;
                }
                this.stateManager.updateMaterial(operation.materialId, updates as Partial<OpenMCMaterial>);
            } else if (operation.kind === 'add') {
                this.stateManager.addMaterial(cloneMaterial(operation.material));
            } else {
                this.stateManager.removeMaterial(operation.material.id);
            }
        }
    }

    /** Build the reverse handler for an applied material proposal. */
    protected createMaterialUndo(proposal: OpenMCChangeProposal, operations: readonly MaterialApplyOperation[]): NukeUndoEntry {
        return {
            title: `Undo ${proposal.summary}`,
            undo: async () => {
                const stale = preflightMaterialUndo(this.stateManager.getState().materials, operations);
                if (stale) {
                    return { ok: false, message: stale };
                }
                for (let index = operations.length - 1; index >= 0; index -= 1) {
                    const operation = operations[index];
                    if (operation.kind === 'update') {
                        const updates: Record<string, unknown> = {};
                        for (const edit of operation.fields) {
                            updates[edit.field] = edit.before;
                        }
                        this.stateManager.updateMaterial(operation.materialId, updates as Partial<OpenMCMaterial>);
                    } else if (operation.kind === 'add') {
                        this.stateManager.removeMaterial(operation.material.id);
                    } else {
                        this.stateManager.addMaterial(cloneMaterial(operation.material));
                    }
                }
                return { ok: true, message: 'Material change undone.' };
            }
        };
    }
}
