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
 * NukeCAD Feature Authoring Capabilities
 *
 * The narrow AI authoring slice: scalar feature-parameter edits on a saved
 * `.nuke-cad` document. Every preview runs a real build in a private temporary
 * directory, keeps the solid count, selector map, and region coverage
 * unchanged, and stores a short-lived proposal. Apply writes the parameters
 * through the document store, schedules the existing rebuild, and registers a
 * session-scoped undo. The whole surface is default-off behind
 * `nukeCad.aiAuthoringEnabled`.
 *
 * @module nuke-cad/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandService } from '@theia/core/lib/common/command';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import * as path from 'path';
import { FeatureResult, GeometryBuildResult, RegionManifestData } from '../../common/nuke-cad-protocol';
import {
    CAD_FEATURE_EDIT_LIMIT,
    EditableFeatureParam,
    FeatureParamChange,
    prepareFeatureEdit,
    ResolvedFeatureEdit
} from '../../common/cad-feature-edit';
import { FeatureParams } from '../../common/cad-document';
import { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import { NukeCadPreferences } from '../nuke-cad-preferences';
import { CadDocumentStore } from '../document/cad-document-store';
import { NukeCadStateManager } from '../state/nuke-cad-state-manager';
import { NukeCadCommands } from '../commands';
import { NukeCadFeatureProposal, NukeCadProposalService } from './nuke-cad-proposal-service';
import { AI_AUTHORING_PREFERENCE } from './nuke-cad-authoring-constants';

/** Stable capability ids for the feature-authoring slice. */
export const PREVIEW_FEATURE_CHANGE_ID = 'nuke.cad.previewFeatureChange';
export const APPLY_FEATURE_CHANGE_ID = 'nuke.cad.applyFeatureChange';

/** Preview builds must not inherit the backend's one-hour document timeout. */
const PREVIEW_TIMEOUT_SECONDS = 120;

/** The private candidate lives under the workspace and is always deleted. */
const PREVIEW_ROOT = ['.nuke-ide', 'ai', 'cad-previews'] as const;

const CATEGORY = ['CAD', 'Authoring'] as const;

const PREVIEW_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: CAD_FEATURE_EDIT_LIMIT,
            items: {
                type: 'object',
                properties: {
                    featureId: { type: 'string', description: 'Feature id from the active document.' },
                    param: {
                        type: 'string',
                        enum: ['length', 'angle', 'radius', 'thickness'],
                        description: 'Editable scalar for that feature type.'
                    },
                    value: { type: 'number', description: 'New finite scalar value.' }
                },
                required: ['featureId', 'param', 'value'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

const APPLY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewFeatureChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const PREVIEW_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: { type: 'array' },
        impact: { type: 'object' },
        build: { type: 'object' }
    },
    required: ['proposalId', 'summary', 'changes', 'impact']
};

/** Preview/apply capabilities for scalar `.nuke-cad` feature edits. */
@injectable()
export class NukeCadAuthoringCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(NukeCadStateManager) protected readonly stateManager: NukeCadStateManager,
        @inject(NukeCadFrontendService) protected readonly service: NukeCadFrontendService,
        @inject(CadDocumentStore) protected readonly store: CadDocumentStore,
        @inject(NukeCadProposalService) protected readonly proposals: NukeCadProposalService,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(NukeCadPreferences) protected readonly preferences: NukeCadPreferences,
        @inject(CommandService) protected readonly commands: CommandService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register(this.previewCapability());
        registry.register(this.applyCapability());
    }

    protected previewCapability(): NukeCapability {
        return {
            id: PREVIEW_FEATURE_CHANGE_ID,
            title: 'Preview CAD feature change',
            description:
                'Propose scalar feature-parameter edits (length, angle, radius, thickness) for the active saved .nuke-cad ' +
                'document and validate them with a real build before anything is written. The preview is read-only.',
            category: CATEGORY,
            inputSchema: PREVIEW_INPUT_SCHEMA,
            outputSchema: PREVIEW_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'preview'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewFeatureChange(input, context)
        };
    }

    protected applyCapability(): NukeCapability {
        return {
            id: APPLY_FEATURE_CHANGE_ID,
            title: 'Apply CAD feature change',
            description:
                'Apply a previewed scalar feature-parameter change to the active .nuke-cad document, schedule the rebuild, ' +
                'and return an undo token. Accepts only a proposal id.',
            category: CATEGORY,
            inputSchema: APPLY_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.applyFeatureChange(input, context)
        };
    }

    protected enabled(): boolean {
        return this.preferences.get(AI_AUTHORING_PREFERENCE) === true;
    }

    protected hasActiveDocument(): boolean {
        return this.stateManager.model !== undefined && this.store.document !== undefined && this.activeDocumentPath() !== undefined;
    }

    /** Canonical file path of the open document, independent of the URI encoding. */
    protected activeDocumentPath(): string | undefined {
        const uri = this.store.uri;
        return uri ? new URI(uri).path.toString() : undefined;
    }

    protected disabledResult(): NukeCapabilityResult {
        return {
            ok: false,
            message: 'CAD AI authoring is disabled. Enable "Nuke CAD: AI Authoring" in Settings → Nuke CAD first.'
        };
    }

    protected inactiveResult(): NukeCapabilityResult {
        return { ok: false, message: 'Open a saved .nuke-cad document before previewing a feature change.' };
    }

    protected async previewFeatureChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        const model = this.stateManager.model;
        const document = this.store.document;
        const uri = this.store.uri;
        if (!model || !document || !uri) {
            return this.inactiveResult();
        }
        if (!model.result.success) {
            return { ok: false, message: 'Rebuild the active document successfully before previewing a change.' };
        }
        const documentPath = new URI(uri).path.toString();
        const pathError = this.scopeError(documentPath, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        const changes = readFeatureParamChanges(input);
        if (!changes.ok) {
            return { ok: false, message: changes.message };
        }
        const prepared = prepareFeatureEdit(document, changes.changes);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        const workspaceRoot = context.workspaceRoots[0];
        if (!workspaceRoot) {
            return { ok: false, message: 'A workspace root is required to run a CAD preview build.' };
        }

        const previewId = globalThis.crypto.randomUUID();
        const previewDirectory = path.join(workspaceRoot, ...PREVIEW_ROOT, previewId);
        // Keep the transient document beside the source so document-relative
        // imports resolve exactly as they do for the real document. Only the
        // build artifacts go to the private preview directory.
        const candidateStem = `.nuke-ai-preview-${previewId}`;
        const candidatePath = path.join(path.dirname(documentPath), `${candidateStem}.nuke-cad`);
        const jobId = `cad-ai-preview-${previewId}`;
        const abort = (): void => {
            void this.service.cancelJob(jobId);
        };
        context.signal?.addEventListener('abort', abort);
        try {
            await this.fileService.create(new URI(candidatePath), JSON.stringify(prepared.result.afterDocument, null, 2));
            if (context.signal?.aborted) {
                return { ok: false, message: 'The CAD preview was cancelled.' };
            }
            const build = await this.service.buildDocument({
                scriptPath: candidatePath,
                outputDirectory: previewDirectory,
                useCache: false,
                jobId,
                timeoutSeconds: PREVIEW_TIMEOUT_SECONDS
            });
            if (!build.success) {
                return {
                    ok: false,
                    message: build.error || 'The preview build failed.',
                    warnings: build.warnings
                };
            }
            const topologyError = compareBuild(model.result, build);
            if (topologyError) {
                return { ok: false, message: topologyError, warnings: build.warnings };
            }
            const before: Record<string, FeatureParams> = {};
            const after: Record<string, FeatureParams> = {};
            for (const edit of prepared.result.edits) {
                const beforeFeature = document.features.find((feature) => feature.id === edit.featureId);
                const afterFeature = prepared.result.afterDocument.features.find((feature) => feature.id === edit.featureId);
                if (!beforeFeature || !afterFeature) {
                    return { ok: false, message: `Feature '${edit.featureId}' disappeared while preparing the change.` };
                }
                before[edit.featureId] = { ...beforeFeature.params };
                after[edit.featureId] = { ...afterFeature.params };
            }
            if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
                return { ok: false, message: 'The document changed while the preview was building. Preview the change again.' };
            }
            const summary = summarize(prepared.result.edits);
            const impact = buildImpact(model.result, build);
            const proposal = this.proposals.create({
                scope: 'features',
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: prepared.result.changes,
                edits: prepared.result.edits,
                before,
                after
            });
            return {
                ok: true,
                data: {
                    proposalId: proposal.id,
                    summary,
                    changes: proposal.changes,
                    impact,
                    build: buildSummary(build)
                },
                changeSet: {
                    id: proposal.id,
                    title: 'CAD feature change',
                    summary,
                    changes: proposal.changes,
                    applyCapability: APPLY_FEATURE_CHANGE_ID
                },
                warnings: build.warnings
            };
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        } finally {
            context.signal?.removeEventListener('abort', abort);
            await Promise.all([
                this.fileService.delete(new URI(candidatePath), { recursive: false, useTrash: false }).catch(() => undefined),
                this.fileService
                    .delete(new URI(`${candidatePath.slice(0, -'.nuke-cad'.length)}.regions.json`), {
                        recursive: false,
                        useTrash: false
                    })
                    .catch(() => undefined),
                this.fileService.delete(new URI(previewDirectory), { recursive: true, useTrash: false }).catch(() => undefined)
            ]);
        }
    }

    protected async applyFeatureChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        if (!this.enabled()) {
            return this.disabledResult();
        }
        if (!this.hasActiveDocument()) {
            return this.inactiveResult();
        }
        const proposalId = readProposalId(input);
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        const stale = this.staleReason(proposal);
        if (stale) {
            return { ok: false, message: stale };
        }
        const backupPath = path.join(path.dirname(proposal.documentPath), `.nuke-ai-backup-${path.basename(proposal.documentPath)}`);
        try {
            const snapshot = this.store.toJson();
            if (!snapshot) {
                return { ok: false, message: 'The active CAD document could not be read for a backup.' };
            }
            await this.fileService.create(new URI(backupPath), snapshot, { overwrite: true });
        } catch (error) {
            return { ok: false, message: `Could not write the pre-apply CAD backup: ${errorMessage(error)}` };
        }
        const result = this.store.updateFeatureParamsBatch(Object.entries(proposal.after).map(([id, params]) => ({ id, params })));
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the change.', warnings: formatIssues(result.issues) };
        }
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD feature change',
            undo: () => this.undoFeatureChange(proposal, appliedRevision)
        });
        const changeSet = {
            id: proposal.id,
            title: 'CAD feature change',
            summary: proposal.summary,
            changes: proposal.changes
        };
        return {
            ok: true,
            message: 'CAD feature change applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                changes: proposal.changes,
                rebuildScheduled: true
            },
            changeSet,
            undoToken
        };
    }

    protected async undoFeatureChange(proposal: NukeCadFeatureProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
        if (!this.hasActiveDocument()) {
            return { ok: false, message: 'Open the document again before undoing this change.' };
        }
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return { ok: false, message: 'This change belongs to a different document and can no longer be undone.' };
        }
        if (this.store.revision !== appliedRevision) {
            return { ok: false, message: 'The document changed after this edit. Preview the change again.' };
        }
        const current = this.store.document;
        if (!current) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        for (const [id, params] of Object.entries(proposal.after)) {
            const feature = current.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(params)) {
                return { ok: false, message: 'The edited feature changed after apply. Preview the change again.' };
            }
        }
        const result = this.store.updateFeatureParamsBatch(Object.entries(proposal.before).map(([id, params]) => ({ id, params })));
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD change undone.' };
    }

    protected staleReason(proposal: NukeCadFeatureProposal): string | undefined {
        if (this.store.documentEpoch !== proposal.documentEpoch || this.activeDocumentPath() !== proposal.documentPath) {
            return 'The active document changed after this preview. Preview the change again.';
        }
        if (this.store.revision !== proposal.baseRevision) {
            return 'The document changed after this preview. Preview the change again.';
        }
        const document = this.store.document;
        if (!document) {
            return 'No CAD document is active.';
        }
        for (const [id, before] of Object.entries(proposal.before)) {
            const feature = document.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(before)) {
                return `Feature '${id}' changed after this preview. Preview the change again.`;
            }
        }
        return undefined;
    }

    protected scopeError(documentPath: string, workspaceRoots: readonly string[]): string | undefined {
        if (!path.isAbsolute(documentPath)) {
            return 'The active CAD document path must be absolute.';
        }
        if (!isWithinWorkspace(documentPath, workspaceRoots)) {
            return 'The active CAD document is outside every workspace root.';
        }
        return undefined;
    }
}

/** Read and shape-check the preview input; semantic checks live in the pure engine. */
export function readFeatureParamChanges(
    input: unknown
): { ok: true; changes: readonly FeatureParamChange[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: 'changes must contain 1 to 16 feature edits.' };
    }
    if (raw.length > CAD_FEATURE_EDIT_LIMIT) {
        return { ok: false, message: `changes must contain at most ${CAD_FEATURE_EDIT_LIMIT} feature edits.` };
    }
    const changes: FeatureParamChange[] = [];
    for (const entry of raw) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: 'Each change must be an object.' };
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.featureId !== 'string' || record.featureId.length === 0) {
            return { ok: false, message: 'Each change needs a non-empty featureId.' };
        }
        if (record.param !== 'length' && record.param !== 'angle' && record.param !== 'radius' && record.param !== 'thickness') {
            return { ok: false, message: `Unsupported feature parameter '${String(record.param)}'.` };
        }
        if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
            return { ok: false, message: `Feature '${record.featureId}' needs a finite numeric value.` };
        }
        changes.push({ featureId: record.featureId, param: record.param as EditableFeatureParam, value: record.value });
    }
    return { ok: true, changes };
}

function readProposalId(input: unknown): string | undefined {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }
    const value = (input as Record<string, unknown>).proposalId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function summarize(edits: readonly ResolvedFeatureEdit[]): string {
    return edits.map((edit) => `${edit.featureId} ${edit.param}: ${formatNumber(edit.before)} → ${formatNumber(edit.after)}`).join('; ');
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function buildSummary(build: GeometryBuildResult): Record<string, unknown> {
    return {
        success: build.success,
        solidCount: build.solidCount ?? 0,
        faceCount: build.faceCount ?? 0,
        triangleCount: build.triangleCount ?? 0,
        boundingBox: build.boundingBox
    };
}

function buildImpact(before: GeometryBuildResult, after: GeometryBuildResult): Record<string, unknown> {
    return {
        solids: { before: before.solidCount ?? 0, after: after.solidCount ?? 0 },
        faces: { before: before.faceCount ?? 0, after: after.faceCount ?? 0 },
        triangles: { before: before.triangleCount ?? 0, after: after.triangleCount ?? 0 },
        boundingBox: { before: before.boundingBox, after: after.boundingBox }
    };
}

/** Reject any preview that changes topology or region coverage. */
export function compareBuild(before: GeometryBuildResult, after: GeometryBuildResult): string | undefined {
    const failed = (after.featureResults ?? []).filter((feature: FeatureResult) => feature.status === 'failed');
    if (failed.length > 0) {
        return `The preview build failed for feature(s): ${failed.map((feature) => feature.featureId).join(', ')}.`;
    }
    const beforeSolids = before.solidCount ?? 0;
    const afterSolids = after.solidCount ?? 0;
    if (beforeSolids !== afterSolids) {
        return `The edit changes the solid count (${beforeSolids} → ${afterSolids}); topology changes are not allowed.`;
    }
    if (stableStringify(before.selectorMap ?? null) !== stableStringify(after.selectorMap ?? null)) {
        return 'The edit changes the selector map; region identity must stay unchanged.';
    }
    if (manifestCoverage(before.regionManifest) !== manifestCoverage(after.regionManifest)) {
        return 'The edit changes the region manifest coverage; region identity must stay unchanged.';
    }
    if ((after.triangleCount ?? 0) === 0) {
        return 'The preview build produced no tessellation; the edit is not a usable geometry change.';
    }
    if (!validBoundingBox(after.boundingBox)) {
        return 'The preview build produced an invalid bounding box; the edit is not a usable geometry change.';
    }
    return undefined;
}

function validBoundingBox(box: GeometryBuildResult['boundingBox']): boolean {
    if (!box || !Array.isArray(box.min) || !Array.isArray(box.max) || box.min.length !== 3 || box.max.length !== 3) {
        return false;
    }
    return box.min.every((value, index) => Number.isFinite(value) && Number.isFinite(box.max[index]) && box.max[index] > value);
}

function manifestCoverage(manifest: RegionManifestData | undefined): string {
    if (!manifest) {
        return 'none';
    }
    return stableStringify({
        volumes: manifest.volumes.map((volume) => volume.selector),
        surfaces: manifest.surfaces.map((surface) => surface.selector)
    });
}

/** JSON stringify with sorted object keys, so object key order cannot fake a difference. */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'undefined';
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
}

function formatIssues(issues: readonly { path: string; message: string }[] | undefined): string[] | undefined {
    return issues && issues.length > 0 ? issues.map((issue) => `${issue.path}: ${issue.message}`) : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
