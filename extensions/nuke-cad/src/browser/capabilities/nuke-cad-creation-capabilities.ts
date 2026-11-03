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
 * AI creation of new CAD documents from shipped component templates.
 *
 * Three capabilities form one safe slice:
 *
 * - `listDocumentTemplates` is read-only and ungated, so discovery works even
 *   with AI authoring disabled.
 * - `prepareDocumentCreation` resolves typed parameters against a template,
 *   re-solves every sketch that references a changed parameter, and validates
 *   the candidate with a real build in the private preview directory. It never
 *   installs or writes a document.
 * - `createDocumentFromTemplate` redeems the one-shot proposal, validates the
 *   chosen target path, installs and saves the document, schedules the rebuild,
 *   and returns an undo token that removes the file it created.
 *
 * The model supplies a template id and numbers; it never supplies geometry,
 * JSON, or code.
 *
 * @module nuke-cad/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { URI } from '@theia/core/lib/common/uri';
import * as path from 'path';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeCadCommands } from '../commands';
import { NukeCadDocument, validateNukeCadDocument } from '../../common/cad-document';
import {
    COMPONENT_TEMPLATES,
    componentParameterSketchIds,
    getComponentTemplate,
    instantiateComponentTemplate,
    listComponentTemplates,
    resolveComponentTemplateParameters,
    ResolvedComponentParameter
} from '../../common/component-templates';
import { NukeCadPreferences } from '../nuke-cad-preferences';
import { AI_AUTHORING_PREFERENCE } from './nuke-cad-authoring-constants';
import { CadDocumentStore } from '../document/cad-document-store';
import { CadDocumentSaveService } from '../document/cad-document-save-service';
import { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import { NukeCadSketchEditService } from '../sketch/sketch-edit-service';
import { ensureNukeCadExtension } from '../widgets/cad-viewport/cad-save-path';
import { validateCreateTarget } from './create-target-policy';
import { runCandidateBuild } from './cad-preview-build';
import { NukeCadCreationBuild, NukeCadCreationProposalService } from './nuke-cad-creation-proposals';
import { NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';

/** Read-only template discovery; intentionally ungated. */
export const LIST_DOCUMENT_TEMPLATES_ID = 'nuke.cad.listDocumentTemplates';
/** Resolve and build a candidate document without installing it. */
export const PREPARE_DOCUMENT_CREATION_ID = 'nuke.cad.prepareDocumentCreation';
/** Install and save a prepared candidate at a validated path. */
export const CREATE_DOCUMENT_FROM_TEMPLATE_ID = 'nuke.cad.createDocumentFromTemplate';

const CATEGORY = ['CAD', 'Authoring'] as const;

const LIST_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        category: { type: 'string', description: 'Filter by template category.' },
        query: { type: 'string', description: 'Match id, name, keywords, or description.' }
    },
    additionalProperties: false
};

const PREPARE_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        templateId: { type: 'string', description: 'Component template id, for example pincell.' },
        name: { type: 'string', description: 'Document name; defaults to the template name.' },
        parameters: {
            type: 'object',
            description: 'Template parameter values in the template unit (or in `unit` when supplied).',
            additionalProperties: { type: 'number' }
        },
        unit: { type: 'string', description: 'Optional length unit for parameter values: mm, cm, or m.' }
    },
    required: ['templateId'],
    additionalProperties: false
};

const APPLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Id returned by prepareDocumentCreation.' },
        path: {
            type: 'string',
            description: 'Target .nuke-cad path inside a workspace root. A save dialog opens when omitted.'
        },
        replaceExisting: {
            type: 'boolean',
            description: 'Allow replacing a clean, saved active document. A dirty document always refuses.'
        }
    },
    required: ['proposalId'],
    additionalProperties: false
};

/** Capability contribution for template-based document creation. */
@injectable()
export class NukeCadCreationCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(NukeCadPreferences) protected readonly preferences: NukeCadPreferences,
        @inject(NukeCadFrontendService) protected readonly service: NukeCadFrontendService,
        @inject(CadDocumentStore) protected readonly store: CadDocumentStore,
        @inject(CadDocumentSaveService) protected readonly saveService: CadDocumentSaveService,
        @inject(NukeCadSketchEditService) protected readonly sketchEditService: NukeCadSketchEditService,
        @inject(NukeCadCreationProposalService) protected readonly proposals: NukeCadCreationProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(FileDialogService) protected readonly fileDialogService: FileDialogService,
        @inject(CommandService) protected readonly commands: CommandService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register(this.listTemplatesCapability());
        registry.register(this.prepareCreationCapability());
        registry.register(this.createFromTemplateCapability());
    }

    protected listTemplatesCapability(): NukeCapability {
        return {
            id: LIST_DOCUMENT_TEMPLATES_ID,
            title: 'List CAD document templates',
            description:
                'List the shipped parametric component templates (id, category, units, and typed parameters) that can be ' +
                'used to create a new CAD document. Read-only; available with AI authoring disabled.',
            category: CATEGORY,
            inputSchema: LIST_INPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'templates', 'read'],
            when: () => true,
            invoke: async (input) => this.listTemplates(input)
        };
    }

    protected prepareCreationCapability(): NukeCapability {
        return {
            id: PREPARE_DOCUMENT_CREATION_ID,
            title: 'Prepare CAD document creation',
            description:
                'Resolve typed parameters against a component template, re-solve the affected sketches, and validate the ' +
                'candidate with a real build in a private directory. Nothing is installed or written; the returned ' +
                'proposal id is required to create the document.',
            category: CATEGORY,
            inputSchema: PREPARE_INPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            tags: ['cad', 'templates', 'preview'],
            when: () => this.enabled(),
            invoke: (input, context) => this.prepareCreation(input, context)
        };
    }

    protected createFromTemplateCapability(): NukeCapability {
        return {
            id: CREATE_DOCUMENT_FROM_TEMPLATE_ID,
            title: 'Create CAD document from template',
            description:
                'Create and save a new .nuke-cad document from a prepared template proposal at a validated workspace path, ' +
                'install it as the active document, schedule the rebuild, and return an undo token. Never overwrites a file.',
            category: CATEGORY,
            inputSchema: APPLY_INPUT_SCHEMA,
            risk: 'write',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'templates', 'create'],
            when: () => this.enabled(),
            invoke: (input, context) => this.createFromTemplate(input, context)
        };
    }

    protected enabled(): boolean {
        return this.preferences.get(AI_AUTHORING_PREFERENCE) === true;
    }

    protected disabledResult(): NukeCapabilityResult {
        return {
            ok: false,
            message: 'CAD AI authoring is disabled. Enable "Nuke CAD: AI Authoring" in Settings → Nuke CAD first.'
        };
    }

    /** Read-only catalogue; no document and no authoring switch required. */
    protected listTemplates(input: unknown): NukeCapabilityResult {
        const request = readListInput(input);
        if (!request.ok) {
            return { ok: false, message: request.message };
        }
        const templates = listComponentTemplates(request.value);
        return {
            ok: true,
            data: {
                templateCount: templates.length,
                templates: templates.map((template) => ({
                    id: template.id,
                    name: template.name,
                    description: template.description,
                    category: template.category,
                    keywords: template.keywords,
                    units: template.document.units ?? '',
                    parameters: template.parameters.map((parameter) => ({
                        name: parameter.name,
                        label: parameter.label,
                        kind: parameter.kind,
                        unit: parameter.unit,
                        default: parameter.default,
                        ...(parameter.min !== undefined ? { min: parameter.min } : {}),
                        ...(parameter.max !== undefined ? { max: parameter.max } : {}),
                        ...(parameter.step !== undefined ? { step: parameter.step } : {}),
                        ...(parameter.description !== undefined ? { description: parameter.description } : {}),
                        ...(parameter.pair !== undefined ? { pair: parameter.pair } : {}),
                        ...(parameter.derived !== undefined ? { derivedFrom: parameter.derived } : {})
                    }))
                })),
                totalTemplates: COMPONENT_TEMPLATES.length
            }
        };
    }

    /** Resolve parameters, solve, and build a candidate without touching the active document. */
    protected async prepareCreation(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const request = readPrepareInput(input);
        if (!request.ok) {
            return { ok: false, message: request.message };
        }
        const template = getComponentTemplate(request.value.templateId);
        if (template === undefined) {
            const available = COMPONENT_TEMPLATES.map((entry) => entry.id).join(', ');
            return { ok: false, message: `Unknown CAD template '${request.value.templateId}'. Available templates: ${available}.` };
        }
        const workspaceRoot = context.workspaceRoots[0];
        if (!workspaceRoot) {
            return { ok: false, message: 'A workspace root is required to build a CAD template preview.' };
        }
        const resolved = resolveComponentTemplateParameters(template, request.value.parameters, request.value.unit);
        if (!resolved.ok) {
            return { ok: false, message: resolved.message };
        }
        const name = request.value.name?.trim() || template.name;
        let candidate = instantiateComponentTemplate(template, name);
        const solved = await this.applyParameterValues(candidate, resolved.values);
        if (!solved.ok) {
            return { ok: false, message: solved.message };
        }
        candidate = solved.document;
        const validation = validateNukeCadDocument(candidate);
        if (!validation.valid) {
            const details = validation.issues
                .slice(0, 3)
                .map((issue) => `${issue.path || 'document'}: ${issue.message}`)
                .join('; ');
            return { ok: false, message: `The resolved CAD document is invalid: ${details}` };
        }
        return runCandidateBuild(
            {
                candidate,
                layout: 'private',
                fileService: this.fileService,
                service: this.service,
                workspaceRoot,
                signal: context.signal
            },
            async (build) => {
                const solidCount = build.solidCount ?? 0;
                if (solidCount < 1) {
                    return { ok: false, message: 'The template build produced no solids.', warnings: build.warnings };
                }
                const summary = summarizeCreation(template.name, resolved.resolved);
                const proposal = this.proposals.create({
                    templateId: template.id,
                    templateName: template.name,
                    templateHash: await sha256Hex(JSON.stringify(candidate)),
                    summary,
                    parameters: resolved.resolved,
                    document: candidate,
                    build: creationBuild(build)
                });
                return {
                    ok: true,
                    data: {
                        proposalId: proposal.id,
                        templateId: proposal.templateId,
                        templateName: proposal.templateName,
                        documentName: candidate.name,
                        units: candidate.units ?? '',
                        parameters: proposal.parameters,
                        build: proposal.build,
                        summary
                    },
                    changeSet: {
                        id: proposal.id,
                        title: 'CAD document creation',
                        summary,
                        changes: creationChanges(proposal.parameters),
                        applyCapability: CREATE_DOCUMENT_FROM_TEMPLATE_ID
                    },
                    warnings: build.warnings
                };
            }
        );
    }

    /** Redeem a proposal, validate the target, install, save, and register undo. */
    protected async createFromTemplate(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const request = readApplyInput(input);
        if (!request.ok) {
            return { ok: false, message: request.message };
        }
        const proposal = this.proposals.get(request.value.proposalId);
        if (proposal === undefined) {
            return { ok: false, message: 'This CAD creation preview is missing or expired. Prepare the creation again.' };
        }
        const active = this.store.document;
        if (active !== undefined) {
            if (this.store.dirty) {
                return {
                    ok: false,
                    message: 'The active CAD document has unsaved changes. Save or discard it before creating a new document.'
                };
            }
            if (request.value.replaceExisting !== true) {
                return {
                    ok: false,
                    message: 'A CAD document is already open. Pass replaceExisting: true to create a new document anyway.'
                };
            }
        }
        const target = await this.resolveTarget(request.value.path, context.workspaceRoots);
        if (!target.ok) {
            return { ok: false, message: target.message };
        }
        if ((await sha256Hex(JSON.stringify(proposal.document))) !== proposal.templateHash) {
            return { ok: false, message: 'The prepared CAD document changed after the preview. Prepare the creation again.' };
        }
        const validation = validateNukeCadDocument(proposal.document);
        if (!validation.valid) {
            const details = validation.issues
                .slice(0, 3)
                .map((issue) => `${issue.path || 'document'}: ${issue.message}`)
                .join('; ');
            return { ok: false, message: `The prepared CAD document is invalid: ${details}` };
        }
        const previous = this.store.document !== undefined ? this.store.toJson() : undefined;
        const previousUri = this.store.uri;
        const documentName = path.basename(target.path, '.nuke-cad');
        const install = this.store.createTemplateDocument(documentName, proposal.document);
        if (!install.success) {
            return { ok: false, message: install.error || 'The CAD store rejected the new document.' };
        }
        this.store.setUri(new URI(target.path).toString());
        const saved = await this.saveService.save({ targetPath: target.path });
        if (!saved.ok) {
            if (previous !== undefined) {
                await this.restoreDocument(previous, previousUri);
            } else {
                this.store.createDocument('Untitled');
            }
            return { ok: false, message: saved.message || 'The new CAD document could not be saved.' };
        }
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const writtenHash = await this.hashFile(target.path);
        const undoToken = this.undoService.register({
            title: 'CAD document creation',
            undo: () => this.undoCreation(target.path, writtenHash, previous, previousUri)
        });
        return {
            ok: true,
            message: `Created ${target.path} from '${proposal.templateName}'; rebuild scheduled.`,
            data: {
                documentPath: target.path,
                templateId: proposal.templateId,
                templateName: proposal.templateName,
                parameters: proposal.parameters,
                build: proposal.build,
                undoToken
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD document creation',
                summary: proposal.summary,
                changes: creationChanges(proposal.parameters)
            },
            nextActions: [
                { capability: 'nuke.cad.listSketchDimensions', reason: 'Inspect the created sketch dimensions.' },
                { capability: 'nuke.cad.exportDagmc', reason: 'Export the new model for OpenMC.' }
            ]
        };
    }

    /**
     * Convert resolved document-unit values into solver edits.
     *
     * `prepare` rejects unchanged values and edits one target sketch per call,
     * so this applies only the values that differ and walks them sequentially
     * against the evolving candidate.
     */
    protected async applyParameterValues(
        document: NukeCadDocument,
        values: Readonly<Record<string, number>>
    ): Promise<{ ok: true; document: NukeCadDocument } | { ok: false; message: string }> {
        let candidate = document;
        for (const [name, value] of Object.entries(values)) {
            const current = candidate.parameters[name];
            if (current === value) {
                continue;
            }
            const sketchId = componentParameterSketchIds(candidate, name)[0];
            if (sketchId === undefined) {
                return { ok: false, message: `Parameter '${name}' is not referenced by any sketch in this template.` };
            }
            const prepared = await this.sketchEditService.prepare(candidate, [{ sketchId, parameterName: name, value }]);
            if (!prepared.ok) {
                return { ok: false, message: `Parameter '${name}' could not be applied: ${prepared.message}` };
            }
            candidate = prepared.result.afterDocument;
        }
        return { ok: true, document: candidate };
    }

    /** Use the caller's path, or open the save dialog when none was supplied. */
    protected async resolveTarget(
        requested: string | undefined,
        workspaceRoots: readonly string[]
    ): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
        let candidate = requested;
        if (candidate === undefined) {
            const chosen = await this.fileDialogService.showSaveDialog({
                title: 'Save New CAD Document',
                inputValue: 'Untitled.nuke-cad',
                filters: { 'CAD Document': ['nuke-cad'] }
            });
            if (chosen === undefined) {
                return { ok: false, message: 'No target path was chosen; the new CAD document was not created.' };
            }
            candidate = ensureNukeCadExtension(chosen.path.toString());
        }
        return validateCreateTarget(this.fileService, candidate, workspaceRoots);
    }

    /** Restore a snapshot after a failed save. */
    protected async restoreDocument(json: string | undefined, uri: string | undefined): Promise<void> {
        if (json === undefined) {
            return;
        }
        const restored = this.store.loadDocument(JSON.parse(json) as unknown);
        if (restored.success && uri !== undefined) {
            this.store.setUri(uri);
        }
    }

    /** SHA-256 of the file as written, or an empty string when it cannot be read. */
    protected async hashFile(filePath: string): Promise<string> {
        try {
            const file = await this.fileService.readFile(new URI(filePath));
            return await sha256Hex(file.value.toString());
        } catch {
            return '';
        }
    }

    /** Remove the created file while it still matches what apply wrote, then restore. */
    protected async undoCreation(
        createdPath: string,
        writtenHash: string,
        previous: string | undefined,
        previousUri: string | undefined
    ): Promise<NukeCapabilityResult> {
        let deleted = false;
        const currentHash = await this.hashFile(createdPath);
        if (currentHash.length === 0) {
            // A missing file is already the desired end state; an unreadable one is not.
            deleted = !(await this.fileService.exists(new URI(createdPath)));
        } else if (writtenHash.length > 0 && currentHash === writtenHash) {
            try {
                await this.fileService.delete(new URI(createdPath), { recursive: false, useTrash: false });
                deleted = true;
            } catch {
                deleted = false;
            }
        }
        const stillActive = this.store.uri === new URI(createdPath).toString();
        if (stillActive) {
            if (previous !== undefined) {
                await this.restoreDocument(previous, previousUri);
            } else {
                this.store.createDocument('Untitled');
            }
            void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        }
        return {
            ok: true,
            message: deleted
                ? 'Deleted the created CAD document and restored the previous document.'
                : 'Restored the previous document; the created file was kept because it changed after creation.'
        };
    }
}

/** Resolve a value to lowercase SHA-256 hex. */
async function sha256Hex(value: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Map a preview build to the stored creation build shape. */
function creationBuild(build: {
    solidCount?: number;
    faceCount?: number;
    triangleCount?: number;
    warnings?: readonly string[];
}): NukeCadCreationBuild {
    return {
        success: true,
        solidCount: build.solidCount ?? 0,
        faceCount: build.faceCount ?? 0,
        triangleCount: build.triangleCount ?? 0,
        warnings: build.warnings ?? []
    };
}

/** One human-readable line per resolved parameter. */
function summarizeCreation(templateName: string, parameters: readonly ResolvedComponentParameter[]): string {
    const rows = parameters
        .filter((parameter) => parameter.kind === 'length')
        .map((parameter) => `${parameter.name} ${parameter.value} ${parameter.unit}`);
    return `Create ${templateName} (${rows.join(', ')})`.slice(0, 200);
}

/** One change row per resolved parameter. */
function creationChanges(
    parameters: readonly ResolvedComponentParameter[]
): readonly { path: string; label: string; kind: 'update'; before: number; after: number }[] {
    return parameters.map((parameter) => ({
        path: `parameters.${parameter.name}`,
        label: parameter.label,
        kind: 'update' as const,
        before: parameter.defaultValue,
        after: parameter.value
    }));
}

/** Shape-check the list input. */
function readListInput(input: unknown): { ok: true; value: { category?: string; query?: string } } | { ok: false; message: string } {
    if (input === undefined || input === null) {
        return { ok: true, value: {} };
    }
    if (typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'Expected an object with optional category and query.' };
    }
    const record = input as Record<string, unknown>;
    const unknownKey = Object.keys(record).find((key) => key !== 'category' && key !== 'query');
    if (unknownKey !== undefined) {
        return { ok: false, message: `Unknown input '${unknownKey}'.` };
    }
    const category = record.category;
    if (category !== undefined && typeof category !== 'string') {
        return { ok: false, message: 'category must be a string.' };
    }
    const query = record.query;
    if (query !== undefined && typeof query !== 'string') {
        return { ok: false, message: 'query must be a string.' };
    }
    return { ok: true, value: { ...(category !== undefined ? { category } : {}), ...(query !== undefined ? { query } : {}) } };
}

/** Shape-check the prepare input. */
function readPrepareInput(
    input: unknown
):
    | { ok: true; value: { templateId: string; name?: string; parameters: Record<string, number>; unit?: string } }
    | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'Expected an object with a templateId.' };
    }
    const record = input as Record<string, unknown>;
    const unknownKey = Object.keys(record).find((key) => !['templateId', 'name', 'parameters', 'unit'].includes(key));
    if (unknownKey !== undefined) {
        return { ok: false, message: `Unknown input '${unknownKey}'.` };
    }
    if (typeof record.templateId !== 'string' || record.templateId.trim().length === 0) {
        return { ok: false, message: 'templateId is required.' };
    }
    if (record.name !== undefined && typeof record.name !== 'string') {
        return { ok: false, message: 'name must be a string.' };
    }
    if (record.unit !== undefined && typeof record.unit !== 'string') {
        return { ok: false, message: 'unit must be a string.' };
    }
    const parameters: Record<string, number> = {};
    if (record.parameters !== undefined) {
        if (record.parameters === null || typeof record.parameters !== 'object' || Array.isArray(record.parameters)) {
            return { ok: false, message: 'parameters must be an object of numbers.' };
        }
        for (const [name, value] of Object.entries(record.parameters as Record<string, unknown>)) {
            if (typeof value !== 'number') {
                return { ok: false, message: `Parameter '${name}' must be a number.` };
            }
            parameters[name] = value;
        }
    }
    return {
        ok: true,
        value: {
            templateId: record.templateId,
            parameters,
            ...(typeof record.name === 'string' ? { name: record.name } : {}),
            ...(typeof record.unit === 'string' ? { unit: record.unit } : {})
        }
    };
}

/** Shape-check the apply input. */
function readApplyInput(
    input: unknown
): { ok: true; value: { proposalId: string; path?: string; replaceExisting?: boolean } } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'Expected an object with a proposalId.' };
    }
    const record = input as Record<string, unknown>;
    const unknownKey = Object.keys(record).find((key) => !['proposalId', 'path', 'replaceExisting'].includes(key));
    if (unknownKey !== undefined) {
        return { ok: false, message: `Unknown input '${unknownKey}'.` };
    }
    if (typeof record.proposalId !== 'string' || record.proposalId.trim().length === 0) {
        return { ok: false, message: 'proposalId is required.' };
    }
    if (record.path !== undefined && typeof record.path !== 'string') {
        return { ok: false, message: 'path must be a string.' };
    }
    if (record.replaceExisting !== undefined && typeof record.replaceExisting !== 'boolean') {
        return { ok: false, message: 'replaceExisting must be a boolean.' };
    }
    return {
        ok: true,
        value: {
            proposalId: record.proposalId,
            ...(typeof record.path === 'string' ? { path: record.path } : {}),
            ...(typeof record.replaceExisting === 'boolean' ? { replaceExisting: record.replaceExisting } : {})
        }
    };
}
