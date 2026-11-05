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
 * OpenMC Project Capabilities
 *
 * Creates a new OpenMC project from a template, saves it through the backend,
 * and installs it as the active project only after the save succeeds. Template,
 * path, and active-project checks run before any write so a rejected request
 * leaves the open project untouched.
 *
 * Also previews and applies project metadata edits (name, description, author)
 * through the shared change proposal store. Metadata is not simulation input,
 * so neither handler generates XML or calls the backend.
 *
 * @module openmc-studio/browser/capabilities
 */

import * as path from 'path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    NukeCapabilityContext,
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeChange,
    NukeChangeSet,
    NukeJsonSchema,
    NukeJsonSchemaProperty
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { deriveAnnotations, isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import { OpenMCProjectMetadata, OpenMCState } from '../../common/openmc-state-schema';
import { OpenMCStudioBackendService, ProjectSaveRequest } from '../../common/openmc-studio-protocol';
import { buildProjectTemplate, getProjectTemplate, PROJECT_TEMPLATE_DEFINITIONS } from '../../common/project-templates';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposal, OpenMCChangeProposalService, scopeError } from './openmc-change-proposal-service';

/** Write capability that creates and installs a project from a template. */
export const CREATE_PROJECT_CAPABILITY_ID = 'nuke.openmc.createProject';

/** Read capability that computes and stores a project metadata proposal. */
export const PREVIEW_PROJECT_METADATA_CAPABILITY_ID = 'nuke.openmc.previewProjectMetadata';

/** Write capability that applies a stored project metadata proposal. */
export const APPLY_PROJECT_METADATA_CAPABILITY_ID = 'nuke.openmc.applyProjectMetadata';

/** Read-only capability suggested after creating a project. */
const VALIDATE_PROJECT_CAPABILITY_ID = 'nuke.openmc.validateProject';

/** Read-only capability suggested after a metadata change. */
const SUMMARIZE_PROJECT_CAPABILITY_ID = 'nuke.openmc.summarizeProject';

/** Template used when the request omits `templateId`. */
const DEFAULT_TEMPLATE_ID = 'blank';

/** Extension required for OpenMC project files. */
const PROJECT_FILE_EXTENSION = '.nuke-openmc';

/** Longest accepted project path. */
const MAX_PROJECT_PATH_LENGTH = 1024;

/** C0 control characters and DEL are never valid in a project path. */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const CREATE_PROJECT_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        name: { type: 'string', description: 'Project name stored in the project metadata.' },
        path: {
            type: 'string',
            description: 'Project file path ending in .nuke-openmc; absolute or relative to the first workspace root.'
        },
        templateId: { type: 'string', description: 'Template id from the project template catalog. Defaults to blank.' },
        parameters: {
            type: 'object',
            description: 'Numeric template parameter overrides keyed by parameter name.',
            additionalProperties: { type: 'number' }
        },
        replaceExisting: { type: 'boolean', description: 'Allow replacing a clean active project. Refused for a dirty project.' }
    },
    required: ['name', 'path'],
    additionalProperties: false
};

const CREATE_PROJECT_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        projectPath: { type: 'string', description: 'Absolute path of the saved project file.' },
        templateId: { type: 'string', description: 'Canonical template id used to build the project.' },
        counts: {
            type: 'object',
            properties: {
                materials: { type: 'integer' },
                surfaces: { type: 'integer' },
                cells: { type: 'integer' },
                universes: { type: 'integer' },
                lattices: { type: 'integer' }
            },
            required: ['materials', 'surfaces', 'cells', 'universes', 'lattices'],
            additionalProperties: false
        }
    },
    required: ['projectPath', 'templateId', 'counts'],
    additionalProperties: false
};

/** Metadata fields the preview may edit. */
export const PROJECT_METADATA_EDITABLE_FIELDS = ['name', 'description', 'author'] as const;

/** One editable project metadata field. */
export type OpenMCProjectMetadataField = (typeof PROJECT_METADATA_EDITABLE_FIELDS)[number];

/** Metadata keys that are never editable through this flow. */
const PROJECT_METADATA_READ_ONLY_FIELDS: readonly string[] = ['version', 'created', 'modified', 'mgBackup'];

/** Display label for each editable metadata field. */
const PROJECT_METADATA_FIELD_LABELS: Record<OpenMCProjectMetadataField, string> = {
    name: 'Project name',
    description: 'Project description',
    author: 'Project author'
};

/** Longest accepted value per editable metadata field. */
const PROJECT_METADATA_MAX_LENGTH: Record<OpenMCProjectMetadataField, number> = {
    name: 120,
    description: 500,
    author: 120
};

/** Diff card title shared by the preview and apply capabilities. */
const PROJECT_METADATA_CHANGE_TITLE = 'OpenMC project metadata change';

/** Message for a proposal that is gone or past its TTL. */
const PROJECT_METADATA_PROPOSAL_MISSING = 'This project metadata preview is missing or has expired. Preview again.';

/** Message for an apply whose pinned metadata no longer matches. */
const PROJECT_METADATA_STALE = 'Project metadata changed since the preview. Preview again.';

/** Message for an undo whose target was edited after apply. */
const PROJECT_METADATA_UNDO_STALE = 'Project metadata changed since the edit; the change can no longer be undone.';

/** Description may keep tabs and line breaks but no other control characters. */
const DESCRIPTION_CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const PREVIEW_PROJECT_METADATA_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        updates: {
            type: 'object',
            description: 'Metadata fields to change: name, description, and/or author.',
            properties: {
                name: { type: 'string', description: 'Project name; non-empty after trimming, at most 120 characters.' },
                description: {
                    type: 'string',
                    description: 'Project description; at most 500 characters. An empty string clears it.'
                },
                author: { type: 'string', description: 'Project author; at most 120 characters. An empty string clears it.' }
            },
            additionalProperties: false
        },
        summary: { type: 'string', description: 'Optional short description of the whole change.' }
    },
    required: ['updates'],
    additionalProperties: false
};

const APPLY_PROJECT_METADATA_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewProjectMetadata.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const PROJECT_METADATA_CHANGES_SCHEMA: NukeJsonSchemaProperty = {
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

const PROJECT_METADATA_CHANGE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: PROJECT_METADATA_CHANGES_SCHEMA
    },
    required: ['proposalId', 'summary', 'changes'],
    additionalProperties: false
};

const APPLY_PROJECT_METADATA_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: PROJECT_METADATA_CHANGES_SCHEMA,
        undoToken: { type: 'string', description: 'Session undo token for the applied project metadata change.' }
    },
    required: ['proposalId', 'summary', 'changes', 'undoToken'],
    additionalProperties: false
};

/** Result of reading the requested template id. */
type TemplateReadResult = { ok: true; templateId: string } | { ok: false; message: string };

/** Result of reading the optional numeric template parameters. */
type ParametersReadResult = { ok: true; parameters: Record<string, number> } | { ok: false; message: string };

/** Result of resolving and validating the target project path. */
type ProjectPathReadResult = { ok: true; projectPath: string } | { ok: false; message: string };

/** Read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read an optional string field from a capability input object. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Resolve the requested template id, defaulting to blank when it exists. */
function readTemplateId(record: Record<string, unknown>): TemplateReadResult {
    const validIds = PROJECT_TEMPLATE_DEFINITIONS.map((template) => template.id);
    const requested = readString(record, 'templateId')?.trim();
    const templateId = requested && requested.length > 0 ? requested : getProjectTemplate(DEFAULT_TEMPLATE_ID)?.id;
    if (!templateId) {
        return { ok: false, message: `templateId is required. Valid templates: ${validIds.join(', ')}.` };
    }

    const template = getProjectTemplate(templateId);
    if (!template) {
        return { ok: false, message: `Unknown project template "${templateId}". Valid templates: ${validIds.join(', ')}.` };
    }
    return { ok: true, templateId: template.id };
}

/** Read the optional template parameters, rejecting non-numeric values. */
function readParameters(value: unknown): ParametersReadResult {
    if (value === undefined) {
        return { ok: true, parameters: {} };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, message: 'parameters must be an object of numeric template parameter values.' };
    }

    const parameters: Record<string, number> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) {
            return { ok: false, message: `Template parameter "${key}" must be a finite number.` };
        }
        parameters[key] = entry;
    }
    return { ok: true, parameters };
}

/** Find the workspace root that contains an absolute path. */
function findWorkspaceRoot(candidate: string, roots: readonly string[]): string | undefined {
    return roots.find((root) => isWithinWorkspace(candidate, [root]));
}

/** Filesystem stat plus the real path a provider may report after following a link. */
type ResolvedPathStat = { readonly isSymbolicLink: boolean; readonly realPath?: string };

/** True when a provider-reported real path points away from the logical entry. */
function resolvedElsewhere(stat: ResolvedPathStat, logicalPath: string): boolean {
    return typeof stat.realPath === 'string' && stat.realPath.length > 0 && path.resolve(stat.realPath) !== path.resolve(logicalPath);
}

/** Return the first path segment below the root that is a symbolic link. */
async function findSymlinkSegment(fileService: FileService, root: string, projectPath: string): Promise<string | undefined> {
    let current = root;
    for (const segment of path.relative(root, projectPath).split(path.sep)) {
        if (segment.length === 0) {
            continue;
        }
        current = path.join(current, segment);
        let stat: Awaited<ReturnType<FileService['resolve']>>;
        try {
            stat = await fileService.resolve(new URI(current));
        } catch {
            // The remaining path does not exist; the parent check reports it.
            return undefined;
        }
        if (stat.isSymbolicLink || resolvedElsewhere(stat, current)) {
            return current;
        }
    }
    return undefined;
}

/** Resolve and validate a target project file path before writing anything. */
async function readProjectPath(value: unknown, roots: readonly string[], fileService: FileService): Promise<ProjectPathReadResult> {
    const requested = typeof value === 'string' ? value.trim() : undefined;
    if (!requested) {
        return { ok: false, message: 'path is required.' };
    }
    if (CONTROL_CHARACTER_PATTERN.test(requested)) {
        return { ok: false, message: 'Project path must not contain control characters.' };
    }

    const firstRoot = roots[0];
    if (!path.isAbsolute(requested) && !firstRoot) {
        return { ok: false, message: 'Relative project paths need an open workspace.' };
    }
    const projectPath = firstRoot && !path.isAbsolute(requested) ? path.resolve(firstRoot, requested) : path.resolve(requested);
    if (projectPath.length > MAX_PROJECT_PATH_LENGTH) {
        return { ok: false, message: `Project path must be ${MAX_PROJECT_PATH_LENGTH} characters or fewer.` };
    }
    if (path.extname(projectPath) !== PROJECT_FILE_EXTENSION) {
        return { ok: false, message: `Project path must end with ${PROJECT_FILE_EXTENSION}.` };
    }
    if (!isWithinWorkspace(projectPath, roots)) {
        return { ok: false, message: 'Project path must be inside the workspace.' };
    }

    const root = findWorkspaceRoot(projectPath, roots);
    if (!root) {
        return { ok: false, message: 'Project path must be inside the workspace.' };
    }
    const symlinkSegment = await findSymlinkSegment(fileService, root, projectPath);
    if (symlinkSegment) {
        return { ok: false, message: `Project path crosses a symbolic link: ${symlinkSegment}` };
    }

    const parent = path.dirname(projectPath);
    let parentIsDirectory = false;
    try {
        parentIsDirectory = (await fileService.resolve(new URI(parent))).isDirectory;
    } catch {
        return { ok: false, message: `Project directory does not exist: ${parent}` };
    }
    if (!parentIsDirectory) {
        return { ok: false, message: `Project parent is not a directory: ${parent}` };
    }

    let targetExists = false;
    try {
        targetExists = await fileService.exists(new URI(projectPath));
    } catch {
        targetExists = false;
    }
    if (targetExists) {
        return { ok: false, message: `A file already exists at ${projectPath}.` };
    }
    return { ok: true, projectPath };
}

/** Return the template counts reported after a project is installed. */
function projectCounts(state: OpenMCState): Record<string, number> {
    return {
        materials: state.materials.length,
        surfaces: state.geometry.surfaces.length,
        cells: state.geometry.cells.length,
        universes: state.geometry.universes.length,
        lattices: state.geometry.lattices.length
    };
}

/** True for a metadata field the preview may edit. */
function isEditableMetadataField(field: string): field is OpenMCProjectMetadataField {
    return (PROJECT_METADATA_EDITABLE_FIELDS as readonly string[]).includes(field);
}

/** Result of reading one editable metadata value. */
type MetadataFieldReadResult = { ok: true; value: string } | { ok: false; message: string };

/**
 * Trim and validate one editable metadata value. Names and authors are single
 * line; descriptions may keep tabs and line breaks. An empty description or
 * author clears the field.
 */
function readMetadataField(field: OpenMCProjectMetadataField, value: string): MetadataFieldReadResult {
    const label = PROJECT_METADATA_FIELD_LABELS[field];
    const normalized = value.trim();
    if (field === 'name' && normalized.length === 0) {
        return { ok: false, message: 'Project name must not be empty.' };
    }
    const controlCharacters =
        field === 'description' ? DESCRIPTION_CONTROL_CHARACTER_PATTERN.test(normalized) : CONTROL_CHARACTER_PATTERN.test(normalized);
    if (controlCharacters) {
        return { ok: false, message: `${label} must not contain control characters.` };
    }
    const maximum = PROJECT_METADATA_MAX_LENGTH[field];
    if (normalized.length > maximum) {
        return { ok: false, message: `${label} must be ${maximum} characters or fewer.` };
    }
    return { ok: true, value: normalized };
}

/** Result of reading the preview `updates` map. */
type MetadataUpdatesReadResult =
    { ok: true; updates: Partial<Record<OpenMCProjectMetadataField, string>> } | { ok: false; message: string };

/**
 * Read and shape-check the preview `updates` map. Object keys are unique by
 * construction, so an unknown key is the only field-level shape error; stored
 * change rows are re-checked for duplicate fields before apply.
 */
function readMetadataUpdates(value: unknown): MetadataUpdatesReadResult {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, message: 'Provide an updates object with name, description, or author.' };
    }
    const updates: Partial<Record<OpenMCProjectMetadataField, string>> = {};
    for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
        if (PROJECT_METADATA_READ_ONLY_FIELDS.includes(field)) {
            return {
                ok: false,
                message: `Project metadata field "${field}" is read-only. Editable fields: name, description, author.`
            };
        }
        if (!isEditableMetadataField(field)) {
            return {
                ok: false,
                message: `Unknown project metadata field "${field}". Editable fields: name, description, author.`
            };
        }
        if (typeof raw !== 'string') {
            return { ok: false, message: `${PROJECT_METADATA_FIELD_LABELS[field]} must be a string.` };
        }
        const read = readMetadataField(field, raw);
        if (!read.ok) {
            return { ok: false, message: read.message };
        }
        updates[field] = read.value;
    }
    return { ok: true, updates };
}

/** Default summary when the preview request does not provide one. */
function defaultMetadataSummary(changes: readonly NukeChange[]): string {
    return changes.length === 1 ? `Update ${changes[0].label.toLowerCase()}.` : `Update ${changes.length} project metadata fields.`;
}

/** Build the change set returned by the preview and apply capabilities. */
function metadataChangeSet(proposal: Pick<OpenMCChangeProposal, 'id' | 'summary' | 'changes'>, applyCapability?: string): NukeChangeSet {
    return {
        id: proposal.id,
        title: PROJECT_METADATA_CHANGE_TITLE,
        summary: proposal.summary,
        changes: proposal.changes,
        ...(applyCapability ? { applyCapability } : {})
    };
}

/** True when a value looks like a complete project metadata snapshot. */
function isMetadataSnapshot(value: unknown): value is OpenMCProjectMetadata {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return ['version', 'name', 'created', 'modified'].every((key) => typeof record[key] === 'string');
}

/** Stable JSON serialization that sorts keys so metadata snapshots compare by value. */
function canonicalMetadata(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalMetadata).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalMetadata(entry)}`);
        return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** One applied metadata change read back from a stored proposal. */
type ProjectMetadataEdit = {
    readonly field: OpenMCProjectMetadataField;
    readonly before: string;
    readonly after: string;
};

/** Result of reading the stored proposal changes back into metadata edits. */
type ProjectMetadataEditsReadResult = { ok: true; edits: ProjectMetadataEdit[] } | { ok: false; message: string };

/** Read and validate the per-field change rows of a stored metadata proposal. */
function readProjectMetadataEdits(changes: readonly NukeChange[]): ProjectMetadataEditsReadResult {
    if (changes.length === 0) {
        return { ok: false, message: 'This project metadata preview has no changes. Preview again.' };
    }
    const edits: ProjectMetadataEdit[] = [];
    const seen = new Set<OpenMCProjectMetadataField>();
    for (const change of changes) {
        const match = /^metadata\.([A-Za-z][A-Za-z0-9]*)$/.exec(change.path);
        const field = match?.[1];
        if (!field || !isEditableMetadataField(field)) {
            return { ok: false, message: `The project metadata proposal contains an unsupported change path: ${change.path}.` };
        }
        if (change.kind !== 'update') {
            return { ok: false, message: `The project metadata proposal contains an unsupported change kind: ${change.kind}.` };
        }
        if (seen.has(field)) {
            return { ok: false, message: `The project metadata proposal changes ${field} more than once.` };
        }
        if (typeof change.before !== 'string' || typeof change.after !== 'string') {
            return { ok: false, message: `The project metadata proposal is missing the values for ${change.path}.` };
        }
        seen.add(field);
        edits.push({ field, before: change.before, after: change.after });
    }
    return { ok: true, edits };
}

/**
 * Registers the OpenMC project creation and metadata capabilities with the
 * nuke-core registry.
 */
@injectable()
export class OpenMCProjectCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCStudioBackendService) protected readonly backendService: OpenMCStudioBackendService,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(OpenMCChangeProposalService) protected readonly proposalService: OpenMCChangeProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: CREATE_PROJECT_CAPABILITY_ID,
            title: 'Create OpenMC project',
            description:
                'Create a new OpenMC project from a template, save it to a workspace path, and install it as the active project. Existing files are never overwritten.',
            category: ['OpenMC', 'Project'],
            inputSchema: CREATE_PROJECT_INPUT_SCHEMA,
            outputSchema: CREATE_PROJECT_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: false,
            examples: [
                {
                    description: 'Create a blank project at the workspace root.',
                    input: { name: 'Pincell', path: 'pincell.nuke-openmc' }
                },
                {
                    description: 'Create a 17x17 assembly project with 4.2% enrichment.',
                    input: {
                        name: 'Assembly',
                        path: 'projects/assembly.nuke-openmc',
                        templateId: 'fuel-assembly',
                        parameters: { enrichmentPct: 4.2 }
                    }
                }
            ],
            when: () => true,
            invoke: async (input, context) => this.createProject(input, context)
        });

        registry.register({
            id: PREVIEW_PROJECT_METADATA_CAPABILITY_ID,
            title: 'Preview OpenMC project metadata change',
            description:
                'Validate proposed project name, description, and author edits, return a before/after diff, and store an in-memory proposal without changing project state.',
            category: ['OpenMC', 'Project'],
            inputSchema: PREVIEW_PROJECT_METADATA_INPUT_SCHEMA,
            outputSchema: PROJECT_METADATA_CHANGE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            examples: [
                {
                    description: 'Rename the project and set its author.',
                    input: { updates: { name: 'Pincell assembly', author: 'Ada Lovelace' } }
                },
                {
                    description: 'Clear the project description.',
                    input: { updates: { description: '' } }
                }
            ],
            when: () => true,
            invoke: async (input) => this.previewProjectMetadata(input)
        });

        registry.register({
            id: APPLY_PROJECT_METADATA_CAPABILITY_ID,
            title: 'Apply OpenMC project metadata change',
            description:
                'Apply a previously previewed project metadata change, reject stale previews, and register an in-memory undo for the changed fields.',
            category: ['OpenMC', 'Project'],
            inputSchema: APPLY_PROJECT_METADATA_INPUT_SCHEMA,
            outputSchema: APPLY_PROJECT_METADATA_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            undoable: true,
            examples: [{ description: 'Apply the previewed project metadata change.', input: { proposalId: 'proposal-id' } }],
            when: () => true,
            invoke: async (input) => this.applyProjectMetadata(input)
        });
    }

    /**
     * Validate the template, target path, and active-project state, then save
     * the new project and adopt it only after the backend confirms the write.
     */
    protected async createProject(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const name = readString(record, 'name')?.trim();
        if (!name) {
            return { ok: false, message: 'Project name is required.' };
        }

        const template = readTemplateId(record);
        if (!template.ok) {
            return { ok: false, message: template.message };
        }

        const parameters = readParameters(record.parameters);
        if (!parameters.ok) {
            return { ok: false, message: parameters.message };
        }

        const target = await readProjectPath(record.path, context.workspaceRoots, this.fileService);
        if (!target.ok) {
            return { ok: false, message: target.message };
        }

        if (this.stateManager.projectPath !== undefined) {
            if (this.stateManager.isDirty) {
                return { ok: false, message: 'Save or discard the current project first.' };
            }
            if (record.replaceExisting !== true) {
                return {
                    ok: false,
                    message: 'An OpenMC project is already open. Set replaceExisting to true to create a new project.'
                };
            }
        }

        const state = buildProjectTemplate(template.templateId, parameters.parameters);
        state.metadata.name = name;

        const request: ProjectSaveRequest = { projectPath: target.projectPath, state };
        let saved: { success: boolean; error?: string };
        try {
            saved = await this.backendService.saveProject(request);
        } catch (error) {
            return { ok: false, message: `Failed to save the OpenMC project: ${errorMessage(error)}` };
        }
        if (!saved.success) {
            return { ok: false, message: saved.error ?? 'Failed to save the OpenMC project.' };
        }

        this.stateManager.setState(state);
        this.stateManager.setProjectPath(target.projectPath);
        this.stateManager.markClean();

        return {
            ok: true,
            data: {
                projectPath: target.projectPath,
                templateId: template.templateId,
                counts: projectCounts(state)
            },
            nextActions: [
                {
                    capability: VALIDATE_PROJECT_CAPABILITY_ID,
                    reason: 'Validate the new project before adding geometry or starting a run.'
                }
            ]
        };
    }

    /**
     * Validate and diff proposed metadata edits without touching state. The
     * stored proposal pins the current metadata so apply can detect a stale
     * preview.
     */
    protected async previewProjectMetadata(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const unknownKey = Object.keys(record).find((key) => key !== 'updates' && key !== 'summary');
        if (unknownKey) {
            return { ok: false, message: `Unknown input field "${unknownKey}". Provide updates and an optional summary.` };
        }

        const requested = readMetadataUpdates(record.updates);
        if (!requested.ok) {
            return { ok: false, message: requested.message };
        }

        const metadata = this.stateManager.getState().metadata;
        const changes: NukeChange[] = [];
        const updates: Partial<OpenMCProjectMetadata> = {};
        for (const field of PROJECT_METADATA_EDITABLE_FIELDS) {
            const proposed = requested.updates[field];
            if (proposed === undefined) {
                continue;
            }
            const current = metadata[field] ?? '';
            if (proposed === current) {
                return { ok: false, message: `${PROJECT_METADATA_FIELD_LABELS[field]} already has that value.` };
            }
            changes.push({
                path: `metadata.${field}`,
                label: PROJECT_METADATA_FIELD_LABELS[field],
                kind: 'update',
                before: current,
                after: proposed
            });
            updates[field] = proposed;
        }
        if (changes.length === 0) {
            return { ok: false, message: 'Provide at least one project metadata field to change.' };
        }

        const summary = readString(record, 'summary')?.trim() || defaultMetadataSummary(changes);
        const proposal = this.proposalService.create({
            scope: 'project',
            summary,
            changes,
            before: metadata,
            after: { ...metadata, ...updates }
        });
        return {
            ok: true,
            data: { proposalId: proposal.id, summary, changes },
            changeSet: metadataChangeSet(proposal, APPLY_PROJECT_METADATA_CAPABILITY_ID),
            nextActions: [
                {
                    capability: APPLY_PROJECT_METADATA_CAPABILITY_ID,
                    reason: 'Apply the previewed project metadata change after confirmation.'
                }
            ]
        };
    }

    /**
     * Apply a live metadata proposal after verifying the pinned snapshot is
     * still current, then register a field-scoped in-memory undo.
     */
    protected async applyProjectMetadata(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const unknownKey = Object.keys(record).find((key) => key !== 'proposalId');
        if (unknownKey) {
            return { ok: false, message: `Unknown input field "${unknownKey}". Provide proposalId.` };
        }
        const proposalId = readString(record, 'proposalId')?.trim();
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }

        const proposal = this.proposalService.get(proposalId);
        if (!proposal) {
            return { ok: false, message: PROJECT_METADATA_PROPOSAL_MISSING };
        }
        const wrongScope = scopeError(proposal, 'project');
        if (wrongScope) {
            return { ok: false, message: wrongScope };
        }
        if (!isMetadataSnapshot(proposal.before)) {
            return { ok: false, message: 'This project metadata preview is missing its metadata snapshot. Preview again.' };
        }
        const derived = readProjectMetadataEdits(proposal.changes);
        if (!derived.ok) {
            return { ok: false, message: derived.message };
        }

        const current = this.stateManager.getState().metadata;
        if (canonicalMetadata(current) !== canonicalMetadata(proposal.before)) {
            return { ok: false, message: PROJECT_METADATA_STALE };
        }

        const updates: Partial<Record<OpenMCProjectMetadataField, string>> = {};
        for (const edit of derived.edits) {
            updates[edit.field] = edit.after;
        }
        this.stateManager.updateMetadata(updates);
        this.proposalService.remove(proposal.id);
        const undoToken = this.undoService.register(this.createProjectMetadataUndo(proposal, derived.edits));
        return {
            ok: true,
            data: { proposalId: proposal.id, summary: proposal.summary, changes: proposal.changes },
            changeSet: metadataChangeSet(proposal),
            undoToken,
            nextActions: [{ capability: SUMMARIZE_PROJECT_CAPABILITY_ID, reason: 'Confirm the updated project metadata.' }]
        };
    }

    /** Build the reverse handler for an applied metadata proposal. */
    protected createProjectMetadataUndo(proposal: OpenMCChangeProposal, edits: readonly ProjectMetadataEdit[]): NukeUndoEntry {
        return {
            title: `Undo ${proposal.summary}`,
            undo: async () => {
                const current = this.stateManager.getState().metadata;
                const changed = edits.some((edit) => (current[edit.field] ?? '') !== edit.after);
                if (changed) {
                    return { ok: false, message: PROJECT_METADATA_UNDO_STALE };
                }

                const updates: Partial<Record<OpenMCProjectMetadataField, string>> = {};
                for (const edit of edits) {
                    updates[edit.field] = edit.before;
                }
                this.stateManager.updateMetadata(updates);
                return { ok: true, message: 'Project metadata change undone.' };
            }
        };
    }
}
