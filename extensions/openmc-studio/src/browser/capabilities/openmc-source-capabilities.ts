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
 * OpenMC Source Capabilities
 *
 * Read the fixed-source inventory and preview → apply → undo independent source
 * additions, updates, and removals through the generic OpenMC change proposal
 * store. Preview validates every candidate with the shared source helpers and
 * XML generators, so a source that cannot serialize to settings.xml never
 * reaches the proposal. File, compiled, mesh, and tokamak sources stay
 * read-only: apply only ever writes `settings.sources`.
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
import {
    OpenMCIndependentSource,
    OpenMCSource,
    OpenMCSourceAngle,
    OpenMCSourceEnergy,
    OpenMCSourceSpatial,
    OpenMCSourceTime
} from '../../common/openmc-state-schema';
import { particleTypeName, sanitizeSourceParticle } from '../../common/particle-types';
import {
    generateAngleXml,
    generateSpatialXml,
    generateTimeXml,
    generateUnivariateXml,
    summarizeAngle,
    summarizeSpatial,
    summarizeTime,
    validateSourceDistributions
} from '../../common/source-utils';
import { OpenMCStateManager } from '../openmc-state-manager';
import { clone, OpenMCChangeProposal, OpenMCChangeProposalService, scopeError } from './openmc-change-proposal-service';

/** Read capability that summarizes the source list. */
export const SUMMARIZE_SOURCES_CAPABILITY_ID = 'nuke.openmc.summarizeSources';

/** Read capability that validates and stores a source proposal. */
export const PREVIEW_SOURCE_CAPABILITY_ID = 'nuke.openmc.previewSourceChange';

/** Write capability that applies a stored source proposal. */
export const APPLY_SOURCE_CAPABILITY_ID = 'nuke.openmc.applySourceChange';

/** Read-only capability suggested after apply to verify the project. */
const DIAGNOSE_PROJECT_CAPABILITY_ID = 'nuke.openmc.diagnoseProject';

/** Diff card title shared by preview and apply. */
const SOURCE_CHANGE_TITLE = 'OpenMC source change';

/** Rejection for a proposal that is gone or past its TTL. */
const SOURCE_PROPOSAL_MISSING = 'This sources preview is missing or has expired. Preview again.';

/** Rejection for an apply whose source list changed after the preview. */
const SOURCE_APPLY_STALE = 'Sources changed since the preview. Preview again.';

/** Rejection for an undo whose source list changed after apply. */
const SOURCE_UNDO_STALE = 'Sources changed since the edit; the change can no longer be undone.';

/** Sources are only meaningful in a fixed-source run. */
const FIXED_SOURCE_ONLY = 'Sources only apply to fixed-source runs.';

/** Largest accepted number of actions in one preview. */
export const MAX_SOURCE_ACTIONS = 16;

/** Maximum source rows returned by {@link SUMMARIZE_SOURCES_CAPABILITY_ID}. */
const SOURCE_ROW_LIMIT = 50;

/** Two pi, matching OpenMC's azimuthal range. */
const TWO_PI = 2 * Math.PI;

/** Tolerance for angle range checks. */
const RANGE_EPSILON = 1e-9;

/** Spatial distribution types this capability may author (mesh is excluded). */
const SPATIAL_TYPES = ['point', 'box', 'sphere', 'cylinder', 'cartesian', 'cylindrical', 'spherical', 'pointcloud'] as const;

/** Energy distribution types this capability may author. */
const ENERGY_TYPES = [
    'discrete',
    'uniform',
    'maxwell',
    'watt',
    'normal',
    'powerlaw',
    'tabular',
    'mixture',
    'decay-spectrum',
    'muir'
] as const;

/** Angular distribution types this capability may author. */
const ANGLE_TYPES = ['isotropic', 'monodirectional', 'mu-phi'] as const;

/** Time distribution types this capability may author. */
const TIME_TYPES = ['delta', 'uniform', 'discrete', 'tabular', 'mixture'] as const;

/** Fields authored by an add/update source object. */
const SOURCE_FIELDS = ['spatial', 'energy', 'angle', 'time', 'particle', 'strength'] as const;

/** Top-level source keys accepted from the caller. */
const SOURCE_INPUT_KEYS = new Set<string>(['type', ...SOURCE_FIELDS]);

/** One source edit requested by the preview input. */
type SourceAction =
    | { readonly action: 'add'; readonly source: Record<string, unknown> }
    | { readonly action: 'update'; readonly index: number; readonly source: Record<string, unknown> }
    | { readonly action: 'remove'; readonly index: number };

/** Result of reading the preview `actions` input. */
type SourceActionsReadResult = { ok: true; actions: SourceAction[] } | { ok: false; message: string };

/** Result of validating one candidate source. */
type SourceCandidateResult = { ok: true; source: OpenMCIndependentSource } | { ok: false; message: string };

const SOURCE_OBJECT_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    description:
        'Independent source: spatial and energy distributions plus optional angle, time, particle, and strength. File, compiled, mesh, and tokamak sources are not editable.',
    properties: {
        type: { type: 'string', enum: ['independent'], description: 'Optional; only independent sources are editable.' },
        spatial: {
            type: 'object',
            description: 'Spatial distribution: point, box, sphere, cylinder, cartesian, cylindrical, spherical, or pointcloud.'
        },
        energy: {
            type: 'object',
            description:
                'Energy distribution: discrete, uniform, maxwell, watt, normal, powerlaw, tabular, mixture, decay-spectrum, or muir.'
        },
        angle: { type: 'object', description: 'Optional angular distribution: isotropic, monodirectional, or mu-phi.' },
        time: { type: 'object', description: 'Optional time distribution in seconds: delta, uniform, discrete, tabular, or mixture.' },
        particle: { description: 'Optional particle name, PDG number, or { name, pdg } object. Defaults to neutron.' },
        strength: { type: 'number', description: 'Optional positive relative source strength.' }
    },
    required: ['spatial', 'energy'],
    additionalProperties: false
};

const SOURCE_ADD_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'add' },
        source: SOURCE_OBJECT_SCHEMA
    },
    required: ['action', 'source'],
    additionalProperties: false
};

const SOURCE_UPDATE_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'update' },
        index: { type: 'integer', minimum: 0, description: 'Existing source index; read it from nuke.openmc.summarizeSources.' },
        source: SOURCE_OBJECT_SCHEMA
    },
    required: ['action', 'index', 'source'],
    additionalProperties: false
};

const SOURCE_REMOVE_ACTION_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        action: { const: 'remove' },
        index: { type: 'integer', minimum: 0, description: 'Existing source index; read it from nuke.openmc.summarizeSources.' }
    },
    required: ['action', 'index'],
    additionalProperties: false
};

const PREVIEW_SOURCE_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        actions: {
            type: 'array',
            description: 'One to sixteen source additions, updates, or removals.',
            minItems: 1,
            maxItems: MAX_SOURCE_ACTIONS,
            items: { oneOf: [SOURCE_ADD_ACTION_SCHEMA, SOURCE_UPDATE_ACTION_SCHEMA, SOURCE_REMOVE_ACTION_SCHEMA] }
        },
        summary: { type: 'string', description: 'Optional short description of the whole change.' }
    },
    required: ['actions'],
    additionalProperties: false
};

const SOURCE_CHANGES_SCHEMA: NukeJsonSchemaProperty = {
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

const SOURCE_CHANGE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: SOURCE_CHANGES_SCHEMA
    },
    required: ['proposalId', 'summary', 'changes'],
    additionalProperties: false
};

const APPLY_SOURCE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: SOURCE_CHANGES_SCHEMA,
        undoToken: { type: 'string', description: 'Session undo token for the applied source change.' }
    },
    required: ['proposalId', 'summary', 'changes', 'undoToken'],
    additionalProperties: false
};

const APPLY_SOURCE_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewSourceChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const EMPTY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const SUMMARIZE_SOURCES_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        runMode: { type: 'string', description: 'Current OpenMC run mode.' },
        fixedSource: { type: 'boolean', description: 'Whether the run mode is fixed source.' },
        sources: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    index: { type: 'integer', description: 'Source index accepted by previewSourceChange.' },
                    type: { type: 'string', description: 'Source type (independent, file, compiled, mesh, or tokamak).' },
                    editable: { type: 'boolean', description: 'Whether this capability can edit the source.' },
                    spatial: { type: 'string', description: 'Compact spatial-distribution summary for independent sources.' },
                    energyType: { type: 'string', description: 'Energy distribution type for independent sources.' },
                    angle: { type: 'string', description: 'Compact angular-distribution summary for independent sources.' },
                    time: { type: 'string', description: 'Compact time-distribution summary for independent sources.' },
                    particle: { type: 'string', description: 'Source particle name; defaults to neutron.' },
                    detail: { type: 'string', description: 'Compact description for read-only source types.' },
                    fixedSource: { type: 'boolean', description: 'Whether the run mode is fixed source.' }
                },
                required: ['index', 'type', 'editable', 'fixedSource'],
                additionalProperties: false
            }
        },
        total: { type: 'integer' },
        truncated: { type: 'boolean' }
    },
    required: ['runMode', 'fixedSource', 'sources', 'total', 'truncated'],
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

/** True for a non-negative integer. */
function isSourceIndex(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** True for a finite positive number. */
function isPositiveFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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

/** Return the first key outside an allow-list, if any. */
function unknownKey(record: Record<string, unknown>, allowed: readonly string[]): string | undefined {
    return Object.keys(record).find((key) => !allowed.includes(key));
}

/** True when a type belongs to a supported union. */
function isKnownType(value: unknown, types: readonly string[]): value is string {
    return typeof value === 'string' && types.includes(value);
}

/**
 * Validate a `mu` or `phi` distribution against its OpenMC range.
 * @param distribution - Sampled angular distribution.
 * @param min - Inclusive lower bound.
 * @param max - Inclusive upper bound.
 * @param label - Field name used in the message.
 * @returns A rejection message, or undefined when every explicit value is in range.
 */
function distributionRangeIssue(distribution: OpenMCSourceEnergy, min: number, max: number, label: string): string | undefined {
    const outside = (values: readonly number[]): boolean =>
        values.some((value) => value < min - RANGE_EPSILON || value > max + RANGE_EPSILON);
    const message = label === 'phi' ? 'Angle phi values must be within [0, 2π].' : 'Angle mu values must be within [-1, 1].';
    switch (distribution.type) {
        case 'discrete':
            return outside(distribution.energies) ? message : undefined;
        case 'uniform':
            return outside([distribution.min, distribution.max]) ? message : undefined;
        case 'tabular':
            return outside(distribution.energies) ? message : undefined;
        case 'powerlaw':
            return outside([distribution.a, distribution.b]) ? message : undefined;
        case 'normal':
            return outside([distribution.mean]) ? message : undefined;
        case 'mixture':
            for (const child of distribution.distributions) {
                const issue = distributionRangeIssue(child, min, max, label);
                if (issue) {
                    return issue;
                }
            }
            return undefined;
        default:
            return undefined;
    }
}

/** Validate the angular range of a mu-phi distribution. */
function angleRangeIssue(angle: OpenMCSourceAngle | undefined): string | undefined {
    if (!angle || angle.type !== 'mu-phi') {
        return undefined;
    }
    return distributionRangeIssue(angle.mu, -1, 1, 'mu') ?? distributionRangeIssue(angle.phi, 0, TWO_PI, 'phi');
}

/** Describe an unsupported or missing source distribution type. */
function distributionTypeIssue(value: unknown, types: readonly string[], label: string): string | undefined {
    const type = isRecord(value) ? value.type : undefined;
    if (isKnownType(type, types)) {
        return undefined;
    }
    return typeof type === 'string' && type.length > 0
        ? `${label} distribution type "${type}" is not supported.`
        : `${label} distribution needs a type: ${types.join(', ')}.`;
}

/**
 * Validate one caller-supplied independent source and normalize its particle.
 * Shared distribution validation and the XML generators run here so a source
 * that cannot serialize is rejected before a proposal exists.
 */
function validateSourceCandidate(raw: Record<string, unknown>): SourceCandidateResult {
    if (raw.type !== undefined && raw.type !== 'independent') {
        return {
            ok: false,
            message: `Only independent sources can be edited; source type ${JSON.stringify(raw.type)} is not supported.`
        };
    }
    const unknown = unknownKey(raw, [...SOURCE_INPUT_KEYS]);
    if (unknown) {
        return {
            ok: false,
            message: `Source field "${unknown}" is not editable; use spatial, energy, angle, time, particle, or strength.`
        };
    }

    const spatial = raw.spatial;
    if (!isRecord(spatial)) {
        return { ok: false, message: 'Each source needs a spatial distribution object.' };
    }
    if (spatial.type === 'mesh') {
        return { ok: false, message: 'Mesh spatial sources are not supported; use an independent spatial distribution.' };
    }
    const spatialIssue = distributionTypeIssue(spatial, SPATIAL_TYPES, 'Spatial');
    if (spatialIssue) {
        return { ok: false, message: spatialIssue };
    }

    const energy = raw.energy;
    if (!isRecord(energy)) {
        return { ok: false, message: 'Each source needs an energy distribution object.' };
    }
    const energyIssue = distributionTypeIssue(energy, ENERGY_TYPES, 'Energy');
    if (energyIssue) {
        return { ok: false, message: energyIssue };
    }

    if (raw.angle !== undefined) {
        if (!isRecord(raw.angle)) {
            return { ok: false, message: 'Angle must be a distribution object.' };
        }
        const angleIssue = distributionTypeIssue(raw.angle, ANGLE_TYPES, 'Angular');
        if (angleIssue) {
            return { ok: false, message: angleIssue };
        }
    }
    if (raw.time !== undefined) {
        if (!isRecord(raw.time)) {
            return { ok: false, message: 'Time must be a distribution object.' };
        }
        const timeIssue = distributionTypeIssue(raw.time, TIME_TYPES, 'Time');
        if (timeIssue) {
            return { ok: false, message: timeIssue };
        }
    }
    if (raw.strength !== undefined && !isPositiveFinite(raw.strength)) {
        return { ok: false, message: 'Source strength must be a finite number greater than zero.' };
    }

    const source: OpenMCIndependentSource = {
        spatial: spatial as unknown as OpenMCSourceSpatial,
        energy: energy as unknown as OpenMCSourceEnergy
    };
    if (raw.angle !== undefined) {
        source.angle = raw.angle as unknown as OpenMCSourceAngle;
    }
    if (raw.time !== undefined) {
        source.time = raw.time as unknown as OpenMCSourceTime;
    }
    if (raw.particle !== undefined) {
        const sanitized = sanitizeSourceParticle(raw.particle);
        if (sanitized.warning) {
            return { ok: false, message: sanitized.warning };
        }
        source.particle = sanitized.particle;
    }
    if (raw.strength !== undefined) {
        source.strength = raw.strength as number;
    }

    try {
        const issues = validateSourceDistributions(source);
        if (issues.length > 0) {
            return {
                ok: false,
                message: issues
                    .slice(0, 3)
                    .map((issue) => issue.message)
                    .join(' ')
            };
        }
        const rangeIssue = angleRangeIssue(source.angle);
        if (rangeIssue) {
            return { ok: false, message: rangeIssue };
        }
        const spatialXml = generateSpatialXml(source.spatial);
        const energyXml = generateUnivariateXml(source.energy, 'energy');
        const angleXml = source.angle ? generateAngleXml(source.angle) : '<angle/>';
        const timeXml = source.time ? generateTimeXml(source.time) : '<time/>';
        if (!spatialXml) {
            return { ok: false, message: 'The spatial distribution is invalid and cannot be serialized to settings.xml.' };
        }
        if (!energyXml) {
            return { ok: false, message: 'The energy distribution is invalid and cannot be serialized to settings.xml.' };
        }
        if (!angleXml) {
            return { ok: false, message: 'The angular distribution is invalid and cannot be serialized to settings.xml.' };
        }
        if (!timeXml) {
            return { ok: false, message: 'The time distribution is invalid and cannot be serialized to settings.xml.' };
        }
    } catch (error) {
        return { ok: false, message: `The source could not be validated: ${errorMessage(error)}` };
    }

    return { ok: true, source };
}

/** Read and shape-check the preview `actions` array. */
function readSourceActions(value: unknown): SourceActionsReadResult {
    if (!Array.isArray(value)) {
        return { ok: false, message: `Provide an actions array with 1 to ${MAX_SOURCE_ACTIONS} source actions.` };
    }
    if (value.length < 1 || value.length > MAX_SOURCE_ACTIONS) {
        return { ok: false, message: `Provide between 1 and ${MAX_SOURCE_ACTIONS} source actions.` };
    }

    const actions: SourceAction[] = [];
    const indexes = new Set<number>();
    for (const [position, entry] of value.entries()) {
        if (!isRecord(entry)) {
            return { ok: false, message: `Source action ${position + 1} must be an object.` };
        }
        if (entry.action !== 'add' && entry.action !== 'update' && entry.action !== 'remove') {
            return { ok: false, message: `Source action ${position + 1} must use action add, update, or remove.` };
        }
        const allowed =
            entry.action === 'add' ? ['action', 'source'] : entry.action === 'update' ? ['action', 'index', 'source'] : ['action', 'index'];
        const unknown = unknownKey(entry, allowed);
        if (unknown) {
            return { ok: false, message: `Source action ${position + 1} has an unknown field "${unknown}".` };
        }
        if (entry.action === 'add') {
            if (!isRecord(entry.source)) {
                return { ok: false, message: `Source action ${position + 1} needs a source object.` };
            }
            actions.push({ action: 'add', source: entry.source });
            continue;
        }
        if (entry.action === 'update') {
            if (!isSourceIndex(entry.index) || !isRecord(entry.source)) {
                return {
                    ok: false,
                    message: `Source action ${position + 1} needs a non-negative integer index and a source object.`
                };
            }
            if (indexes.has(entry.index)) {
                return { ok: false, message: `Source index ${entry.index} is targeted more than once in one preview.` };
            }
            indexes.add(entry.index);
            actions.push({ action: 'update', index: entry.index, source: entry.source });
            continue;
        }
        if (entry.action === 'remove') {
            if (!isSourceIndex(entry.index)) {
                return { ok: false, message: `Source action ${position + 1} needs a non-negative integer index.` };
            }
            if (indexes.has(entry.index)) {
                return { ok: false, message: `Source index ${entry.index} is targeted more than once in one preview.` };
            }
            indexes.add(entry.index);
            actions.push({ action: 'remove', index: entry.index });
            continue;
        }
        return { ok: false, message: `Source action ${position + 1} must use action add, update, or remove.` };
    }
    return { ok: true, actions };
}

/** Diff one updated source against its current value. */
function sourceUpdateChanges(index: number, before: OpenMCSource, after: OpenMCIndependentSource): NukeChange[] {
    const changes: NukeChange[] = [];
    for (const field of SOURCE_FIELDS) {
        const beforeValue = (before as unknown as Record<string, unknown>)[field];
        const afterValue = (after as unknown as Record<string, unknown>)[field];
        if (structuralEquals(beforeValue, afterValue)) {
            continue;
        }
        changes.push({
            path: `settings.sources.${index}.${field}`,
            label: `Source ${index} ${field}`,
            kind: 'update',
            ...(beforeValue !== undefined ? { before: clone(beforeValue) } : {}),
            ...(afterValue !== undefined ? { after: clone(afterValue) } : {})
        });
    }
    return changes;
}

/** Default summary when the preview request does not provide one. */
function defaultSourceSummary(actions: readonly SourceAction[]): string {
    if (actions.length === 1) {
        const action = actions[0];
        if (action.action === 'add') {
            return 'Add an independent source.';
        }
        return action.action === 'update' ? `Update source ${action.index}.` : `Remove source ${action.index}.`;
    }
    const adds = actions.filter((action) => action.action === 'add').length;
    const updates = actions.filter((action) => action.action === 'update').length;
    const removes = actions.filter((action) => action.action === 'remove').length;
    const parts: string[] = [];
    if (adds > 0) {
        parts.push(`${adds} add`);
    }
    if (updates > 0) {
        parts.push(`${updates} update`);
    }
    if (removes > 0) {
        parts.push(`${removes} remove`);
    }
    return `Apply ${actions.length} OpenMC source edits (${parts.join(', ')}).`;
}

/** Build the change set returned by the preview and apply capabilities. */
function sourceChangeSet(proposal: Pick<OpenMCChangeProposal, 'id' | 'summary' | 'changes'>, applyCapability?: string): NukeChangeSet {
    return {
        id: proposal.id,
        title: SOURCE_CHANGE_TITLE,
        summary: proposal.summary,
        changes: proposal.changes,
        ...(applyCapability ? { applyCapability } : {})
    };
}

/** Compact description for a source type this capability cannot edit. */
function readonlySourceDetail(source: OpenMCSource): string {
    switch (source.type) {
        case 'file':
            return `File source: ${source.path}`;
        case 'compiled':
            return `Compiled source: ${source.library}`;
        case 'mesh':
            return `Mesh source${source.meshId !== undefined ? ` for mesh ${source.meshId}` : ''} with ${
                source.sources?.length ?? 0
            } sub-source${(source.sources?.length ?? 0) === 1 ? '' : 's'}`;
        case 'tokamak':
            return `Tokamak source R0=${source.majorRadius} cm, a=${source.minorRadius} cm`;
        default:
            return 'Source';
    }
}

/** Build one summary row. */
function sourceRow(source: OpenMCSource, index: number, fixedSource: boolean): Record<string, unknown> {
    if (source.type === undefined || source.type === 'independent') {
        const independent = source as OpenMCIndependentSource;
        return {
            index,
            type: 'independent',
            editable: true,
            spatial: independent.spatial ? summarizeSpatial(independent.spatial) : 'missing',
            energyType: independent.energy?.type ?? 'unknown',
            angle: summarizeAngle(independent.angle),
            time: summarizeTime(independent.time),
            particle: particleTypeName(independent.particle) ?? 'neutron',
            fixedSource
        };
    }
    return {
        index,
        type: source.type,
        editable: false,
        detail: readonlySourceDetail(source),
        fixedSource
    };
}

/**
 * Registers the OpenMC source summary, preview, and apply capabilities with the
 * nuke-core registry.
 */
@injectable()
export class OpenMCSourceCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCChangeProposalService) protected readonly proposalService: OpenMCChangeProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: SUMMARIZE_SOURCES_CAPABILITY_ID,
            title: 'Summarize OpenMC sources',
            description:
                'Read-only source inventory for the active OpenMC project: the run mode, whether it is fixed source, and up to 50 rows with ' +
                'each source index, type, compact spatial/angle/time summaries, energy distribution type, particle, and editability. Use the ' +
                'returned indexes with nuke.openmc.previewSourceChange.',
            category: ['OpenMC', 'Sources'],
            inputSchema: EMPTY_INPUT_SCHEMA,
            outputSchema: SUMMARIZE_SOURCES_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [{ description: 'List every source index before previewing a source change.', input: {} }],
            when: () => true,
            invoke: async () => this.summarizeSources()
        });

        registry.register({
            id: PREVIEW_SOURCE_CAPABILITY_ID,
            title: 'Preview OpenMC source change',
            description:
                'Validate proposed independent-source additions, updates, and removals for a fixed-source run, return a before/after diff, and ' +
                'store an in-memory proposal without changing project state.',
            category: ['OpenMC', 'Sources'],
            inputSchema: PREVIEW_SOURCE_INPUT_SCHEMA,
            outputSchema: SOURCE_CHANGE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [
                {
                    description: 'Add a 14 MeV point source.',
                    input: {
                        actions: [
                            {
                                action: 'add',
                                source: {
                                    spatial: { type: 'point', origin: [0, 0, 0] },
                                    energy: { type: 'discrete', energies: [14.1e6], probabilities: [1] },
                                    angle: { type: 'isotropic' },
                                    particle: 'neutron'
                                }
                            }
                        ]
                    }
                },
                {
                    description: 'Replace the first source with an isotropic sphere.',
                    input: {
                        actions: [
                            {
                                action: 'update',
                                index: 0,
                                source: {
                                    spatial: { type: 'sphere', center: [0, 0, 0], radius: 5 },
                                    energy: { type: 'watt', a: 0.988e6, b: 2.249e-6 }
                                }
                            }
                        ]
                    }
                }
            ],
            when: () => true,
            invoke: async (input) => this.previewSourceChange(input)
        });

        registry.register({
            id: APPLY_SOURCE_CAPABILITY_ID,
            title: 'Apply OpenMC source change',
            description:
                'Apply a previously previewed source change, reject stale or cross-domain previews, and register an in-memory undo that restores ' +
                'the previous source list.',
            category: ['OpenMC', 'Sources'],
            inputSchema: APPLY_SOURCE_INPUT_SCHEMA,
            outputSchema: APPLY_SOURCE_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: true,
            examples: [{ description: 'Apply the previewed source change.', input: { proposalId: 'proposal-id' } }],
            when: () => true,
            invoke: async (input) => this.applySourceChange(input)
        });
    }

    /** Read the fixed-source inventory without mutating state. */
    protected summarizeSources(): NukeCapabilityResult {
        const settings = this.stateManager.getState().settings;
        const sources = settings.sources ?? [];
        const runMode = settings.run?.mode ?? 'unknown';
        const fixedSource = runMode === 'fixed source';
        return {
            ok: true,
            data: {
                runMode,
                fixedSource,
                sources: sources.slice(0, SOURCE_ROW_LIMIT).map((source, index) => sourceRow(source, index, fixedSource)),
                total: sources.length,
                truncated: sources.length > SOURCE_ROW_LIMIT
            }
        };
    }

    /**
     * Validate and diff proposed source actions without touching state. The
     * stored proposal pins the current source list so apply can detect a stale
     * preview.
     */
    protected async previewSourceChange(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const unknown = unknownKey(record, ['actions', 'summary']);
        if (unknown) {
            return { ok: false, message: `Unknown input field "${unknown}".` };
        }
        const parsed = readSourceActions(record.actions);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }

        const state = this.stateManager.getState();
        if (state.settings.run?.mode !== 'fixed source') {
            return { ok: false, message: FIXED_SOURCE_ONLY };
        }
        const currentSources = clone(state.settings.sources ?? []);

        const updates = new Map<number, OpenMCIndependentSource>();
        const removes = new Set<number>();
        const adds: OpenMCIndependentSource[] = [];
        for (const action of parsed.actions) {
            if (action.action === 'add') {
                const candidate = validateSourceCandidate(action.source);
                if (!candidate.ok) {
                    return { ok: false, message: candidate.message };
                }
                adds.push(candidate.source);
                continue;
            }
            if (action.index >= currentSources.length) {
                return {
                    ok: false,
                    message: `Source index ${action.index} is out of range; the project has ${currentSources.length} source${
                        currentSources.length === 1 ? '' : 's'
                    }.`
                };
            }
            const target = currentSources[action.index];
            if (target.type !== undefined && target.type !== 'independent') {
                return {
                    ok: false,
                    message: `Source ${action.index} is a ${target.type} source; only independent sources can be updated or removed.`
                };
            }
            if (action.action === 'remove') {
                removes.add(action.index);
                continue;
            }
            const candidate = validateSourceCandidate(action.source);
            if (!candidate.ok) {
                return { ok: false, message: `Source ${action.index}: ${candidate.message}` };
            }
            updates.set(action.index, candidate.source);
        }

        const afterSources = clone(currentSources);
        for (const [index, source] of updates) {
            afterSources[index] = clone(source);
        }
        for (const index of [...removes].sort((left, right) => right - left)) {
            afterSources.splice(index, 1);
        }
        const appendedBase = afterSources.length;

        const changes: NukeChange[] = [];
        let addOrdinal = 0;
        for (const action of parsed.actions) {
            if (action.action === 'add') {
                const source = adds[addOrdinal];
                const index = appendedBase + addOrdinal;
                addOrdinal += 1;
                afterSources.push(clone(source));
                changes.push({
                    path: `settings.sources.${index}`,
                    label: `Source ${index}`,
                    kind: 'add',
                    after: clone(source)
                });
                continue;
            }
            if (action.action === 'update') {
                const source = updates.get(action.index);
                if (source) {
                    changes.push(...sourceUpdateChanges(action.index, currentSources[action.index], source));
                }
                continue;
            }
            changes.push({
                path: `settings.sources.${action.index}`,
                label: `Source ${action.index}`,
                kind: 'remove',
                before: clone(currentSources[action.index])
            });
        }

        if (changes.length === 0) {
            return { ok: false, message: 'The preview does not change any source. Preview again.' };
        }

        const summary = readString(record, 'summary')?.trim() || defaultSourceSummary(parsed.actions);
        const proposal = this.proposalService.create({
            scope: 'sources',
            summary,
            changes,
            before: currentSources,
            after: afterSources
        });
        return {
            ok: true,
            data: { proposalId: proposal.id, summary, changes },
            changeSet: sourceChangeSet(proposal, APPLY_SOURCE_CAPABILITY_ID),
            nextActions: [{ capability: APPLY_SOURCE_CAPABILITY_ID, reason: 'Apply the previewed source change after confirmation.' }]
        };
    }

    /**
     * Apply a live source proposal after verifying the current source list is
     * still the snapshot the preview was built from, then register a session
     * undo that restores the previous list.
     */
    protected async applySourceChange(input: unknown): Promise<NukeCapabilityResult> {
        const proposalId = readString(readRecord(input), 'proposalId')?.trim();
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }

        const proposal = this.proposalService.get(proposalId);
        if (!proposal) {
            return { ok: false, message: SOURCE_PROPOSAL_MISSING };
        }
        const wrongScope = scopeError(proposal, 'sources');
        if (wrongScope) {
            return { ok: false, message: wrongScope };
        }
        if (!Array.isArray(proposal.before) || !Array.isArray(proposal.after)) {
            return { ok: false, message: 'This sources preview is missing its source snapshot. Preview again.' };
        }

        const state = this.stateManager.getState();
        if (state.settings.run?.mode !== 'fixed source') {
            return { ok: false, message: FIXED_SOURCE_ONLY };
        }
        const currentSources = state.settings.sources ?? [];
        if (!structuralEquals(currentSources, proposal.before)) {
            return { ok: false, message: SOURCE_APPLY_STALE };
        }

        this.stateManager.updateSettings({ sources: clone(proposal.after) });
        this.proposalService.remove(proposal.id);
        const undoToken = this.undoService.register(this.createSourceUndo(proposal.summary, clone(proposal.before), clone(proposal.after)));
        return {
            ok: true,
            data: { proposalId: proposal.id, summary: proposal.summary, changes: proposal.changes },
            changeSet: sourceChangeSet(proposal),
            undoToken,
            nextActions: [{ capability: DIAGNOSE_PROJECT_CAPABILITY_ID, reason: 'Check the project after applying the source change.' }]
        };
    }

    /** Build the reverse handler for an applied source proposal. */
    protected createSourceUndo(summary: string, before: OpenMCSource[], after: OpenMCSource[]): NukeUndoEntry {
        return {
            title: `Undo ${summary}`,
            undo: async () => {
                const current = this.stateManager.getState().settings.sources ?? [];
                if (!structuralEquals(current, after)) {
                    return { ok: false, message: SOURCE_UNDO_STALE };
                }
                this.stateManager.updateSettings({ sources: clone(before) });
                return { ok: true, message: 'Source change undone.' };
            }
        };
    }
}
