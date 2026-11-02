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
 * NukeCAD Authoring Capabilities
 *
 * The narrow AI authoring slice: scalar feature-parameter edits, sketch
 * driving-dimension edits, and topology-impacting hole-depth/pattern-count
 * edits on a saved `.nuke-cad` document. Every preview runs a real build in a
 * private temporary directory and stores a short-lived proposal. Scalar and
 * sketch previews keep the solid count, selector map, and region coverage
 * unchanged; topology previews report the solid and region impact and check
 * saved OpenMC DAGMC references before apply. Apply writes the changes through
 * the document store, schedules the existing rebuild, and registers a
 * session-scoped undo. The whole authoring surface is default-off behind
 * `nukeCad.aiAuthoringEnabled`; listing sketch dimensions is read-only metadata
 * and stays available.
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
import {
    CAD_TOPOLOGY_EDIT_LIMIT,
    CAD_TOPOLOGY_PATTERN_COUNT_LIMIT,
    FeatureTopologyAction,
    prepareTopologyEdit,
    ResolvedTopologyEdit
} from '../../common/cad-topology-edit';
import { findOpenmcRegionBlockers } from '../../common/openmc-region-references';
import { buildTopologyRegions, diffTopology, TopologyBuildSnapshot } from '../../common/topology-impact';
import { FeatureParams, NukeCadDocument, SketchDef, validateNukeCadDocument } from '../../common/cad-document';
import { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import { NukeCadPreferences } from '../nuke-cad-preferences';
import { CadDocumentStore, featuresConsumingSketch } from '../document/cad-document-store';
import { NukeCadStateManager } from '../state/nuke-cad-state-manager';
import { NukeCadCommands } from '../commands';
import {
    isSketchProposal,
    isTopologyProposal,
    NukeCadFeatureProposal,
    NukeCadProposalBuild,
    NukeCadProposalImpact,
    NukeCadProposalService,
    NukeCadSketchProposal,
    NukeCadTopologyProposal
} from './nuke-cad-proposal-service';
import { compareCandidateSolids } from '../preview/ghost-preview-diff';
import { NukeCadGhostPreviewService } from '../preview/nuke-cad-ghost-preview-service';
import { parseTessellationAsync } from '../widgets/cad-viewport/tess-parse-client';
import { AI_AUTHORING_PREFERENCE } from './nuke-cad-authoring-constants';
import { NukeCadSketchEditService, sketchDefinitionsEqual } from '../sketch/sketch-edit-service';
import { CAD_SKETCH_EDIT_LIMIT, PreparedSketchEdit, SketchEditRequest } from '../sketch/sketch-edit-types';
import { readOpenmcRegionReferences } from './openmc-region-reference-reader';

/** Stable capability ids for the feature- and sketch-authoring slice. */
export const PREVIEW_FEATURE_CHANGE_ID = 'nuke.cad.previewFeatureChange';
export const APPLY_FEATURE_CHANGE_ID = 'nuke.cad.applyFeatureChange';
export const LIST_SKETCH_DIMENSIONS_ID = 'nuke.cad.listSketchDimensions';
export const PREVIEW_SKETCH_CHANGE_ID = 'nuke.cad.previewSketchChange';
export const APPLY_SKETCH_CHANGE_ID = 'nuke.cad.applySketchChange';
export const PREVIEW_TOPOLOGY_CHANGE_ID = 'nuke.cad.previewTopologyChange';
export const APPLY_TOPOLOGY_CHANGE_ID = 'nuke.cad.applyTopologyChange';

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
                        enum: ['length', 'angle', 'radius', 'thickness', 'distance', 'spacing', 'diameter', 'depth'],
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

const APPLY_SKETCH_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewSketchChange.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const PREVIEW_TOPOLOGY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: CAD_TOPOLOGY_EDIT_LIMIT,
            items: {
                type: 'object',
                properties: {
                    featureId: { type: 'string', description: 'Feature id from the active document.' },
                    action: {
                        type: 'string',
                        enum: ['holeDepthMode', 'patternCount'],
                        description: 'Topology-changing action for that feature.'
                    },
                    mode: {
                        type: 'string',
                        enum: ['blind', 'through'],
                        description: 'Hole depth mode; only for holeDepthMode.'
                    },
                    depth: { type: 'number', description: 'Positive blind-hole depth; only for holeDepthMode blind.' },
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: CAD_TOPOLOGY_PATTERN_COUNT_LIMIT,
                        description: 'Pattern instance count; only for patternCount.'
                    }
                },
                required: ['featureId', 'action'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

const APPLY_TOPOLOGY_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.cad.previewTopologyChange.' },
        acknowledgeRegionChanges: {
            type: 'boolean',
            description: 'Must be true to confirm the reported solid and region impact.'
        }
    },
    required: ['proposalId', 'acknowledgeRegionChanges'],
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

const LIST_SKETCH_DIMENSIONS_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const LIST_SKETCH_DIMENSIONS_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Canonical path of the active .nuke-cad document.' },
        parameters: {
            type: 'object',
            description: 'Document parameter name to current value.',
            additionalProperties: { type: 'number' }
        },
        sketches: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    datumId: { type: 'string' },
                    consumedByFeatureIds: { type: 'array', items: { type: 'string' } },
                    dimensions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                kind: {
                                    type: 'string',
                                    enum: ['distance', 'distanceH', 'distanceV', 'angle', 'radius', 'diameter']
                                },
                                driving: { type: 'boolean' },
                                parameter: { type: 'string', description: 'Document parameter driving the dimension, when bound.' },
                                value: { type: 'number' }
                            },
                            required: ['id', 'kind', 'driving', 'value'],
                            additionalProperties: false
                        }
                    }
                },
                required: ['id', 'name', 'datumId', 'consumedByFeatureIds', 'dimensions'],
                additionalProperties: false
            }
        }
    },
    required: ['documentPath', 'parameters', 'sketches']
};

const PREVIEW_SKETCH_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        changes: {
            type: 'array',
            minItems: 1,
            maxItems: CAD_SKETCH_EDIT_LIMIT,
            items: {
                type: 'object',
                properties: {
                    sketchId: { type: 'string', description: 'Sketch id from nuke.cad.listSketchDimensions.' },
                    dimensionId: { type: 'string', description: 'Driving dimension id on that sketch.' },
                    parameterName: { type: 'string', description: 'Document parameter referenced by that sketch.' },
                    value: { type: 'number', description: 'New finite scalar value.' }
                },
                required: ['sketchId', 'value'],
                additionalProperties: false
            }
        }
    },
    required: ['changes'],
    additionalProperties: false
};

/** Preview/apply capabilities for scalar feature and sketch-dimension `.nuke-cad` edits. */
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
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService,
        @inject(NukeCadGhostPreviewService) protected readonly ghostPreview: NukeCadGhostPreviewService,
        @inject(NukeCadSketchEditService) protected readonly sketchEditService: NukeCadSketchEditService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register(this.listSketchDimensionsCapability());
        registry.register(this.previewCapability());
        registry.register(this.applyCapability());
        registry.register(this.previewSketchCapability());
        registry.register(this.applySketchCapability());
        registry.register(this.previewTopologyCapability());
        registry.register(this.applyTopologyCapability());
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

    protected listSketchDimensionsCapability(): NukeCapability {
        return {
            id: LIST_SKETCH_DIMENSIONS_ID,
            title: 'List CAD sketch dimensions',
            description:
                'Read the active .nuke-cad document parameters, sketches, and driving/reference dimensions. This is read-only ' +
                'metadata to call before previewing a sketch change; it works even when AI authoring is off.',
            category: CATEGORY,
            inputSchema: LIST_SKETCH_DIMENSIONS_INPUT_SCHEMA,
            outputSchema: LIST_SKETCH_DIMENSIONS_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'sketch', 'read'],
            when: () => this.store.document !== undefined,
            invoke: () => this.listSketchDimensions()
        };
    }

    protected previewSketchCapability(): NukeCapability {
        return {
            id: PREVIEW_SKETCH_CHANGE_ID,
            title: 'Preview CAD sketch change',
            description:
                'Propose driving-dimension or referenced-parameter edits for one sketch in the active saved .nuke-cad ' +
                'document, re-solve the affected sketches, and validate the result with a real build before anything is written. ' +
                'The preview is read-only.',
            category: CATEGORY,
            inputSchema: PREVIEW_SKETCH_INPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'preview', 'sketch'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewSketchChange(input, context)
        };
    }

    protected applySketchCapability(): NukeCapability {
        return {
            id: APPLY_SKETCH_CHANGE_ID,
            title: 'Apply CAD sketch change',
            description:
                'Apply a previewed sketch-dimension change to the active .nuke-cad document, schedule the rebuild, and ' +
                'return an undo token. Accepts only a proposal id.',
            category: CATEGORY,
            inputSchema: APPLY_SKETCH_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply', 'sketch'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input) => this.applySketchChange(input)
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

    protected previewTopologyCapability(): NukeCapability {
        return {
            id: PREVIEW_TOPOLOGY_CHANGE_ID,
            title: 'Preview CAD topology change',
            description:
                'Propose hole blind/through or pattern-count edits for the active saved .nuke-cad document, validate the ' +
                'candidate with a real build, and report the solid and region impact plus any saved OpenMC references ' +
                'the change would break. The preview is read-only.',
            category: CATEGORY,
            inputSchema: PREVIEW_TOPOLOGY_INPUT_SCHEMA,
            outputSchema: PREVIEW_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            tags: ['cad', 'authoring', 'preview', 'topology'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.previewTopologyChange(input, context)
        };
    }

    protected applyTopologyCapability(): NukeCapability {
        return {
            id: APPLY_TOPOLOGY_CHANGE_ID,
            title: 'Apply CAD topology change',
            description:
                'Apply a previewed topology change after the region impact is acknowledged, schedule the rebuild, and ' +
                'return an undo token. Rejects proposals that would break saved OpenMC DAGMC references.',
            category: CATEGORY,
            inputSchema: APPLY_TOPOLOGY_INPUT_SCHEMA,
            risk: 'execute',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            undoable: true,
            tags: ['cad', 'authoring', 'apply', 'topology'],
            when: () => this.enabled() && this.hasActiveDocument(),
            invoke: (input, context) => this.applyTopologyChange(input, context)
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
        this.ghostPreview.clear();
        return this.runCandidateBuild(prepared.result.afterDocument, documentPath, context, async (build) => {
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
            const parsedCandidate = await this.readCandidateTessellation(build.tessPath);
            const proposal = this.proposals.create({
                scope: 'features',
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: prepared.result.changes,
                edits: prepared.result.edits,
                before,
                after,
                impact,
                build: buildSummary(build)
            });
            if (parsedCandidate) {
                const diff = compareCandidateSolids(this.stateManager.solidSummaries, parsedCandidate);
                this.ghostPreview.show({
                    proposalId: proposal.id,
                    tessData: parsedCandidate,
                    ...diff
                });
            }
            void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
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
        });
    }

    /**
     * Write the detached candidate beside the source document, run one private
     * build, and delegate the review step. The document's region manifest is
     * copied beside the candidate so the build sees the same region identity as
     * the real document. The transient document, its region sidecar, and the
     * preview directory are always deleted.
     */
    protected async runCandidateBuild(
        candidate: NukeCadDocument,
        documentPath: string,
        context: NukeCapabilityContext,
        review: (build: GeometryBuildResult) => Promise<NukeCapabilityResult>
    ): Promise<NukeCapabilityResult> {
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
        const candidateSidecarPath = `${candidatePath.slice(0, -'.nuke-cad'.length)}.regions.json`;
        const sourceSidecarPath = regionSidecarPath(documentPath);
        const jobId = `cad-ai-preview-${previewId}`;
        const abort = (): void => {
            void this.service.cancelJob(jobId);
        };
        context.signal?.addEventListener('abort', abort);
        try {
            if (sourceSidecarPath !== undefined) {
                let sourceExists: boolean;
                try {
                    sourceExists = await this.fileService.exists(new URI(sourceSidecarPath));
                } catch (error) {
                    return {
                        ok: false,
                        message: `The CAD region manifest '${sourceSidecarPath}' could not be inspected: ${errorMessage(error)}`
                    };
                }
                if (sourceExists) {
                    try {
                        const source = await this.fileService.readFile(new URI(sourceSidecarPath));
                        await this.fileService.create(new URI(candidateSidecarPath), source.value.toString());
                    } catch (error) {
                        return {
                            ok: false,
                            message: `The CAD region manifest '${sourceSidecarPath}' could not be copied for the preview: ${errorMessage(error)}`
                        };
                    }
                }
            }
            await this.fileService.create(new URI(candidatePath), JSON.stringify(candidate, null, 2));
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
            return await review(build);
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        } finally {
            context.signal?.removeEventListener('abort', abort);
            await Promise.all([
                this.fileService.delete(new URI(candidatePath), { recursive: false, useTrash: false }).catch(() => undefined),
                this.fileService
                    .delete(new URI(candidateSidecarPath), {
                        recursive: false,
                        useTrash: false
                    })
                    .catch(() => undefined),
                this.fileService.delete(new URI(previewDirectory), { recursive: true, useTrash: false }).catch(() => undefined)
            ]);
        }
    }

    /** Read-only sketch and dimension metadata for the active document. */
    protected async listSketchDimensions(): Promise<NukeCapabilityResult> {
        const document = this.store.document;
        if (!document) {
            return this.inactiveResult();
        }
        return {
            ok: true,
            data: {
                documentPath: this.activeDocumentPath() ?? '',
                parameters: { ...document.parameters },
                sketches: document.sketches.map((sketch) => ({
                    id: sketch.id,
                    name: sketch.name,
                    datumId: sketch.datumId,
                    consumedByFeatureIds: featuresConsumingSketch(document, sketch.id),
                    dimensions: (sketch.dimensions ?? []).map((dimension) => ({
                        id: dimension.id,
                        kind: dimension.kind,
                        driving: dimension.driving,
                        ...(dimension.parameter !== undefined ? { parameter: dimension.parameter } : {}),
                        value: dimension.value
                    }))
                }))
            }
        };
    }

    protected async previewSketchChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
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
        const requests = readSketchEditRequests(input);
        if (!requests.ok) {
            return { ok: false, message: requests.message };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        const prepared = await this.sketchEditService.prepare(document, requests.changes);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
            return { ok: false, message: 'The document changed while the sketch was solving. Preview the change again.' };
        }
        this.ghostPreview.clear();
        const sketch = prepared.result;
        return this.runCandidateBuild(sketch.afterDocument, documentPath, context, async (build) => {
            const topologyError = compareBuild(model.result, build);
            if (topologyError) {
                return { ok: false, message: topologyError, warnings: build.warnings };
            }
            if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
                return { ok: false, message: 'The document changed while the preview was building. Preview the change again.' };
            }
            const summary = summarizeSketchEdit(sketch);
            const impact = buildImpact(model.result, build);
            const parsedCandidate = await this.readCandidateTessellation(build.tessPath);
            const details = {
                targetSketchId: sketch.targetSketchId,
                targetSketchName: sketch.targetSketchName,
                affectedSketchIds: sketch.affectedSketchIds,
                affectedFeatureIds: sketch.affectedFeatureIds,
                beforeSketches: sketch.beforeSketches,
                afterSketches: sketch.afterSketches,
                beforeParameters: sketch.beforeParameters,
                afterParameters: sketch.afterParameters,
                solver: sketch.solver,
                edits: sketch.edits
            };
            const proposal = this.proposals.create({
                scope: 'sketch',
                applyCapability: APPLY_SKETCH_CHANGE_ID,
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: sketch.changes,
                impact,
                build: buildSummary(build),
                sketch: details
            });
            if (parsedCandidate) {
                const diff = compareCandidateSolids(this.stateManager.solidSummaries, parsedCandidate);
                this.ghostPreview.show({
                    proposalId: proposal.id,
                    tessData: parsedCandidate,
                    ...diff
                });
            }
            void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
            return {
                ok: true,
                data: {
                    proposalId: proposal.id,
                    summary,
                    changes: proposal.changes,
                    impact,
                    build: buildSummary(build),
                    sketch: details
                },
                changeSet: {
                    id: proposal.id,
                    title: 'CAD sketch dimension change',
                    summary,
                    changes: proposal.changes,
                    applyCapability: APPLY_SKETCH_CHANGE_ID
                },
                warnings: build.warnings
            };
        });
    }

    protected async previewTopologyChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
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
        const actions = readTopologyActions(input);
        if (!actions.ok) {
            return { ok: false, message: actions.message };
        }
        const prepared = prepareTopologyEdit(document, actions.actions);
        if (!prepared.ok) {
            return { ok: false, message: prepared.message };
        }
        const candidateValidation = validateNukeCadDocument(prepared.result.afterDocument);
        if (!candidateValidation.valid) {
            const details = candidateValidation.issues
                .slice(0, 3)
                .map((issue) => `${issue.path || 'document'}: ${issue.message}`)
                .join('; ');
            return { ok: false, message: `The topology edit produced an invalid CAD document: ${details}` };
        }
        const baseEpoch = this.store.documentEpoch;
        const baseRevision = this.store.revision;
        this.ghostPreview.clear();
        return this.runCandidateBuild(prepared.result.afterDocument, documentPath, context, async (build) => {
            const validationError = validateTopologyCandidateBuild(build);
            if (validationError) {
                return { ok: false, message: validationError, warnings: build.warnings };
            }
            if (this.store.documentEpoch !== baseEpoch || this.store.revision !== baseRevision) {
                return { ok: false, message: 'The document changed while the preview was building. Preview the change again.' };
            }
            const parsedCandidate = await this.readCandidateTessellation(build.tessPath);
            const solidDiff = parsedCandidate
                ? compareCandidateSolids(this.stateManager.solidSummaries, parsedCandidate)
                : { addedSolidIds: [], removedSolidIds: [], changedSolidIds: [], changedBodyIds: [] };
            const beforeSnapshot: TopologyBuildSnapshot = {
                solidCount: model.result.solidCount ?? 0,
                faceCount: model.result.faceCount ?? 0,
                triangleCount: model.result.triangleCount ?? 0,
                selectorMap: model.result.selectorMap,
                regionManifest: model.result.regionManifest
            };
            const afterSnapshot: TopologyBuildSnapshot = {
                solidCount: build.solidCount ?? 0,
                faceCount: build.faceCount ?? 0,
                triangleCount: build.triangleCount ?? 0,
                selectorMap: build.selectorMap,
                regionManifest: build.regionManifest
            };
            const topologyImpact = diffTopology(beforeSnapshot, afterSnapshot, solidDiff);
            const afterRegions = buildTopologyRegions(afterSnapshot);
            const openmc = await readOpenmcRegionReferences(this.fileService, context.activeOpenmcProject);
            const blockedRegions = findOpenmcRegionBlockers(topologyImpact, afterRegions, openmc);
            const summary = summarizeTopologyEdit(document, prepared.result.edits);
            const sizeImpact = buildImpact(model.result, build);
            const proposal = this.proposals.create({
                scope: 'topology',
                applyCapability: APPLY_TOPOLOGY_CHANGE_ID,
                summary,
                documentPath,
                documentEpoch: baseEpoch,
                baseRevision,
                changes: prepared.result.changes,
                impact: sizeImpact,
                build: buildSummary(build),
                topology: {
                    actions: actions.actions,
                    before: Object.fromEntries(prepared.result.edits.map((edit) => [edit.featureId, edit.before])),
                    after: Object.fromEntries(prepared.result.edits.map((edit) => [edit.featureId, edit.after])),
                    topology: topologyImpact,
                    afterRegions,
                    blockedRegions,
                    openmcStatus: openmc.status,
                    ...(openmc.projectPath ? { openmcProjectPath: openmc.projectPath } : {}),
                    openmcWarnings: openmc.warnings
                }
            });
            if (parsedCandidate) {
                this.ghostPreview.show({
                    proposalId: proposal.id,
                    tessData: parsedCandidate,
                    ...solidDiff
                });
            }
            void this.commands.executeCommand(NukeCadCommands.OPEN_REVIEW_PANEL.id).catch(() => undefined);
            return {
                ok: true,
                data: {
                    proposalId: proposal.id,
                    summary,
                    changes: proposal.changes,
                    impact: sizeImpact,
                    regionImpact: topologyImpact,
                    blockedRegions,
                    openmcStatus: openmc.status,
                    openmcWarnings: openmc.warnings,
                    build: buildSummary(build)
                },
                changeSet: {
                    id: proposal.id,
                    title: 'CAD topology change',
                    summary,
                    changes: proposal.changes,
                    ...(blockedRegions.length === 0 ? { applyCapability: APPLY_TOPOLOGY_CHANGE_ID } : {})
                },
                warnings: [...(build.warnings ?? []), ...openmc.warnings]
            };
        });
    }

    /** Read and parse the candidate tessellation before the temp directory is deleted. */
    protected async readCandidateTessellation(
        tessPath: string | undefined
    ): Promise<Awaited<ReturnType<typeof parseTessellationAsync>> | undefined> {
        if (!tessPath) {
            return undefined;
        }
        try {
            const content = await this.fileService.readFile(new URI(tessPath));
            return await parseTessellationAsync(content.value.toString());
        } catch (error) {
            console.warn('[NukeCadAuthoring] Candidate tessellation could not be parsed:', error);
            return undefined;
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
        if (isSketchProposal(proposal)) {
            return { ok: false, message: 'This proposal is a sketch change; apply it with nuke.cad.applySketchChange.' };
        }
        if (isTopologyProposal(proposal)) {
            return { ok: false, message: 'This proposal is a topology change; apply it with nuke.cad.applyTopologyChange.' };
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

    protected async applySketchChange(input: unknown): Promise<NukeCapabilityResult> {
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
        if (isTopologyProposal(proposal)) {
            return { ok: false, message: 'This proposal is a topology change; apply it with nuke.cad.applyTopologyChange.' };
        }
        if (!isSketchProposal(proposal)) {
            return { ok: false, message: 'This proposal is a feature change; apply it with nuke.cad.applyFeatureChange.' };
        }
        const stale = this.sketchStaleReason(proposal);
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
        const result = this.store.applySketchAuthoringEdit({
            sketches: Object.values(proposal.sketch.afterSketches),
            parameters: proposal.sketch.afterParameters
        });
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the change.', warnings: formatIssues(result.issues) };
        }
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD sketch dimension change',
            undo: () => this.undoSketchChange(proposal, appliedRevision)
        });
        return {
            ok: true,
            message: 'CAD sketch change applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                changes: proposal.changes,
                rebuildScheduled: true,
                affectedFeatureIds: proposal.sketch.affectedFeatureIds
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD sketch dimension change',
                summary: proposal.summary,
                changes: proposal.changes,
                applyCapability: APPLY_SKETCH_CHANGE_ID
            },
            undoToken
        };
    }

    protected async undoSketchChange(proposal: NukeCadSketchProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
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
        for (const [id, after] of Object.entries(proposal.sketch.afterSketches)) {
            const currentSketch = current.sketches.find((candidate) => candidate.id === id);
            if (!sketchDefinitionsEqual(persistedSketch(currentSketch), persistedSketch(after))) {
                return { ok: false, message: `Sketch '${id}' changed after apply. Preview the change again.` };
            }
        }
        for (const [name, after] of Object.entries(proposal.sketch.afterParameters)) {
            if (current.parameters[name] !== after) {
                return { ok: false, message: `Parameter '${name}' changed after apply. Preview the change again.` };
            }
        }
        const result = this.store.applySketchAuthoringEdit({
            sketches: Object.values(proposal.sketch.beforeSketches),
            parameters: proposal.sketch.beforeParameters
        });
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD sketch change undone.' };
    }

    protected async applyTopologyChange(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
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
        if (!acknowledgesRegionChanges(input)) {
            return { ok: false, message: 'Acknowledge the region impact before applying this topology change.' };
        }
        const proposal = this.proposals.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This CAD preview is missing or expired. Preview the change again.' };
        }
        if (!isTopologyProposal(proposal)) {
            return {
                ok: false,
                message: isSketchProposal(proposal)
                    ? 'This proposal is a sketch change; apply it with nuke.cad.applySketchChange.'
                    : 'This proposal is a feature change; apply it with nuke.cad.applyFeatureChange.'
            };
        }
        const firstBlocker = proposal.topology.blockedRegions[0];
        if (firstBlocker) {
            return {
                ok: false,
                message: `This topology change would break a saved OpenMC reference: ${firstBlocker.message}`
            };
        }
        if (context.activeOpenmcProject !== proposal.topology.openmcProjectPath) {
            return { ok: false, message: 'The active OpenMC project changed after this preview. Preview the change again.' };
        }
        const openmc = await readOpenmcRegionReferences(this.fileService, context.activeOpenmcProject);
        if (proposal.topology.openmcProjectPath !== undefined && openmc.status !== 'saved-project') {
            return {
                ok: false,
                message: 'The saved OpenMC project can no longer be re-checked. Restore the project file and preview the change again.'
            };
        }
        const blockers = findOpenmcRegionBlockers(proposal.topology.topology, proposal.topology.afterRegions, openmc);
        if (blockers.length > 0) {
            return {
                ok: false,
                message: `This topology change would break saved OpenMC references: ${blockers.map((blocker) => blocker.message).join(' ')}`
            };
        }
        const stale = this.topologyStaleReason(proposal);
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
        const result = this.store.replaceFeatureParamsBatch(
            Object.entries(proposal.topology.after).map(([id, params]) => ({ id, params }))
        );
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the change.', warnings: formatIssues(result.issues) };
        }
        const appliedRevision = this.store.revision;
        this.proposals.remove(proposal.id);
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        const undoToken = this.undoService.register({
            title: 'CAD topology change',
            undo: () => this.undoTopologyChange(proposal, appliedRevision)
        });
        return {
            ok: true,
            message: 'CAD topology change applied; rebuild scheduled.',
            data: {
                proposalId: proposal.id,
                documentPath: proposal.documentPath,
                revision: appliedRevision,
                backupPath,
                changes: proposal.changes,
                rebuildScheduled: true,
                regionImpact: proposal.topology.topology
            },
            changeSet: {
                id: proposal.id,
                title: 'CAD topology change',
                summary: proposal.summary,
                changes: proposal.changes,
                applyCapability: APPLY_TOPOLOGY_CHANGE_ID
            },
            undoToken
        };
    }

    protected async undoTopologyChange(proposal: NukeCadTopologyProposal, appliedRevision: number): Promise<NukeCapabilityResult> {
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
        for (const [id, after] of Object.entries(proposal.topology.after)) {
            const feature = current.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(after)) {
                return { ok: false, message: `Feature '${id}' changed after apply. Preview the change again.` };
            }
        }
        const result = this.store.replaceFeatureParamsBatch(
            Object.entries(proposal.topology.before).map(([id, params]) => ({ id, params }))
        );
        if (!result.success) {
            return { ok: false, message: result.error || 'The CAD document rejected the undo.', warnings: formatIssues(result.issues) };
        }
        void this.commands.executeCommand(NukeCadCommands.REBUILD_GEOMETRY.id).catch(() => undefined);
        return { ok: true, message: 'CAD topology change undone.' };
    }

    protected topologyStaleReason(proposal: NukeCadTopologyProposal): string | undefined {
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
        for (const [id, before] of Object.entries(proposal.topology.before)) {
            const feature = document.features.find((candidate) => candidate.id === id);
            if (!feature || stableStringify(feature.params) !== stableStringify(before)) {
                return `Feature '${id}' changed after this preview. Preview the change again.`;
            }
        }
        return undefined;
    }

    protected sketchStaleReason(proposal: NukeCadSketchProposal): string | undefined {
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
        for (const [name, before] of Object.entries(proposal.sketch.beforeParameters)) {
            if (document.parameters[name] !== before) {
                return `Parameter '${name}' changed after this preview. Preview the change again.`;
            }
        }
        for (const [id, before] of Object.entries(proposal.sketch.beforeSketches)) {
            const sketch = document.sketches.find((candidate) => candidate.id === id);
            if (!sketchDefinitionsEqual(sketch, before)) {
                return `Sketch '${id}' changed after this preview. Preview the change again.`;
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
        if (
            record.param !== 'length' &&
            record.param !== 'angle' &&
            record.param !== 'radius' &&
            record.param !== 'thickness' &&
            record.param !== 'distance' &&
            record.param !== 'spacing' &&
            record.param !== 'diameter' &&
            record.param !== 'depth'
        ) {
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

function acknowledgesRegionChanges(input: unknown): boolean {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return false;
    }
    return (input as Record<string, unknown>).acknowledgeRegionChanges === true;
}

function summarize(edits: readonly ResolvedFeatureEdit[]): string {
    return edits.map((edit) => `${edit.featureId} ${edit.param}: ${formatNumber(edit.before)} → ${formatNumber(edit.after)}`).join('; ');
}

/** Read and shape-check one sketch preview request list. */
export function readSketchEditRequests(
    input: unknown
): { ok: true; changes: readonly SketchEditRequest[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: `changes must contain 1 to ${CAD_SKETCH_EDIT_LIMIT} sketch edits.` };
    }
    if (raw.length > CAD_SKETCH_EDIT_LIMIT) {
        return { ok: false, message: `changes must contain at most ${CAD_SKETCH_EDIT_LIMIT} sketch edits.` };
    }
    const changes: SketchEditRequest[] = [];
    for (const [index, entry] of raw.entries()) {
        const label = `Edit ${index + 1}`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: `${label} must be an object.` };
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.sketchId !== 'string' || record.sketchId.length === 0) {
            return { ok: false, message: `${label} needs a non-empty sketchId.` };
        }
        const dimensionId = record.dimensionId;
        const parameterName = record.parameterName;
        if (dimensionId !== undefined && (typeof dimensionId !== 'string' || dimensionId.length === 0)) {
            return { ok: false, message: `${label} dimensionId must be a non-empty string.` };
        }
        if (parameterName !== undefined && (typeof parameterName !== 'string' || parameterName.length === 0)) {
            return { ok: false, message: `${label} parameterName must be a non-empty string.` };
        }
        if ((dimensionId === undefined) === (parameterName === undefined)) {
            return { ok: false, message: `${label} must set exactly one of dimensionId or parameterName.` };
        }
        if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
            return { ok: false, message: `${label} needs a finite numeric value.` };
        }
        if (dimensionId !== undefined) {
            changes.push({ sketchId: record.sketchId, dimensionId: dimensionId as string, value: record.value });
        } else {
            changes.push({ sketchId: record.sketchId, parameterName: parameterName as string, value: record.value });
        }
    }
    return { ok: true, changes };
}

/** Strictly shape-check one topology preview request list. */
export function readTopologyActions(
    input: unknown
): { ok: true; actions: readonly FeatureTopologyAction[] } | { ok: false; message: string } {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, message: 'changes is required.' };
    }
    const raw = (input as { changes?: unknown }).changes;
    if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, message: `changes must contain 1 to ${CAD_TOPOLOGY_EDIT_LIMIT} topology edits.` };
    }
    if (raw.length > CAD_TOPOLOGY_EDIT_LIMIT) {
        return { ok: false, message: `changes must contain at most ${CAD_TOPOLOGY_EDIT_LIMIT} topology edits.` };
    }
    const actions: FeatureTopologyAction[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of raw.entries()) {
        const label = `Edit ${index + 1}`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: `${label} must be an object.` };
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.featureId !== 'string' || record.featureId.length === 0) {
            return { ok: false, message: `${label} needs a non-empty featureId.` };
        }
        if (seen.has(record.featureId)) {
            return { ok: false, message: `Duplicate topology edit for feature '${record.featureId}'.` };
        }
        seen.add(record.featureId);
        if (record.action === 'holeDepthMode') {
            const mode = record.mode;
            if (mode !== 'blind' && mode !== 'through') {
                return { ok: false, message: `${label} needs mode 'blind' or 'through'.` };
            }
            if ('count' in record) {
                return { ok: false, message: `${label} cannot set count for a hole depth change.` };
            }
            if (mode === 'through') {
                if ('depth' in record) {
                    return { ok: false, message: `${label} cannot set depth for a through hole.` };
                }
                actions.push({ featureId: record.featureId, action: 'holeDepthMode', mode: 'through' });
                continue;
            }
            if (typeof record.depth !== 'number' || !Number.isFinite(record.depth) || record.depth <= 0) {
                return { ok: false, message: `${label} needs a positive finite depth for a blind hole.` };
            }
            actions.push({ featureId: record.featureId, action: 'holeDepthMode', mode: 'blind', depth: record.depth });
            continue;
        }
        if (record.action === 'patternCount') {
            const count = record.count;
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
                return { ok: false, message: `${label} needs a safe integer count of at least 1.` };
            }
            if (count > CAD_TOPOLOGY_PATTERN_COUNT_LIMIT) {
                return { ok: false, message: `${label} count must be at most ${CAD_TOPOLOGY_PATTERN_COUNT_LIMIT}.` };
            }
            if ('mode' in record || 'depth' in record) {
                return { ok: false, message: `${label} cannot set mode or depth for a pattern count change.` };
            }
            actions.push({ featureId: record.featureId, action: 'patternCount', count });
            continue;
        }
        return { ok: false, message: `${label} has an unknown action '${String(record.action)}'.` };
    }
    return { ok: true, actions };
}

/** One short human summary for the review panel and capability response. */
function summarizeSketchEdit(prepared: PreparedSketchEdit): string {
    const edits = prepared.edits;
    if (edits.length > 1) {
        const changes = edits.map((edit) => {
            const target = edit.dimensionId ?? edit.parameterName ?? 'dimension';
            return `${target} ${formatNumber(edit.before)} → ${formatNumber(edit.after)}`;
        });
        return `Change ${edits.length} sketch dimensions in ${prepared.targetSketchName}: ${changes.join('; ')}`;
    }
    if (edits.length === 0) {
        return `Change sketch ${prepared.targetSketchName}`;
    }
    const edit = edits[0];
    const affectedDimensions = edit.affectedDimensionIds.length;
    if (edit.kind === 'parameter' && affectedDimensions > 1) {
        return `${describeSketchEdit(edit)} (${affectedDimensions} dimensions in ${prepared.affectedSketchIds.length} sketches)`;
    }
    return describeSketchEdit(edit);
}

/** One short human summary for a prepared topology edit. */
function summarizeTopologyEdit(document: NukeCadDocument, edits: readonly ResolvedTopologyEdit[]): string {
    const names = new Map(document.features.map((feature) => [feature.id, feature.name] as const));
    return edits
        .map((edit) => {
            const name = names.get(edit.featureId) ?? edit.featureId;
            if (edit.action === 'holeDepthMode') {
                const depth = featureParamNumber(edit.after, 'depth');
                return depth === undefined ? `Open hole ${name} through` : `Change hole ${name} blind depth ${formatNumber(depth)}`;
            }
            const before = featureParamNumber(edit.before, 'count');
            const after = featureParamNumber(edit.after, 'count');
            return `Change pattern ${name} count ${formatCount(before)} → ${formatCount(after)}`;
        })
        .join('; ');
}

function featureParamNumber(params: FeatureParams, key: string): number | undefined {
    const value = (params as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatCount(value: number | undefined): string {
    return value === undefined ? '?' : formatNumber(value);
}

function describeSketchEdit(edit: PreparedSketchEdit['edits'][number]): string {
    const before = formatNumber(edit.before);
    const after = formatNumber(edit.after);
    if (edit.kind === 'parameter') {
        return `Change parameter ${edit.parameterName} ${before} → ${after}`;
    }
    const kind = edit.dimensionKind !== undefined ? ` ${edit.dimensionKind}` : '';
    return `Change sketch ${edit.sketchName}: ${edit.dimensionId}${kind} ${before} → ${after}`;
}

function formatNumber(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function buildSummary(build: GeometryBuildResult): NukeCadProposalBuild {
    return {
        success: build.success,
        solidCount: build.solidCount ?? 0,
        faceCount: build.faceCount ?? 0,
        triangleCount: build.triangleCount ?? 0
    };
}

function buildImpact(before: GeometryBuildResult, after: GeometryBuildResult): NukeCadProposalImpact {
    return {
        solids: { before: before.solidCount ?? 0, after: after.solidCount ?? 0 },
        faces: { before: before.faceCount ?? 0, after: after.faceCount ?? 0 },
        triangles: { before: before.triangleCount ?? 0, after: after.triangleCount ?? 0 },
        boundingBox: { before: before.boundingBox, after: after.boundingBox }
    };
}

/** Validate a topology candidate build without requiring unchanged topology. */
export function validateTopologyCandidateBuild(build: GeometryBuildResult): string | undefined {
    if (!build.success) {
        return build.error || 'The preview build failed.';
    }
    const failed = (build.featureResults ?? []).filter((feature: FeatureResult) => feature.status === 'failed');
    if (failed.length > 0) {
        return `The preview build failed for feature(s): ${failed.map((feature) => feature.featureId).join(', ')}.`;
    }
    if ((build.solidCount ?? 0) <= 0) {
        return 'The preview build produced no solids; the topology change is not a usable geometry change.';
    }
    if ((build.triangleCount ?? 0) <= 0) {
        return 'The preview build produced no tessellation; the topology change is not a usable geometry change.';
    }
    if (!validBoundingBox(build.boundingBox)) {
        return 'The preview build produced an invalid bounding box; the topology change is not a usable geometry change.';
    }
    return undefined;
}

/** Region-manifest sidecar path for a `.nuke-cad` document; non-document paths have none. */
function regionSidecarPath(documentPath: string): string | undefined {
    return documentPath.endsWith('.nuke-cad') ? `${documentPath.slice(0, -'.nuke-cad'.length)}.regions.json` : undefined;
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

/**
 * Compare sketches by their persisted shape. The document store merges
 * sketch-local parameters into `doc.parameters` and clears the field on
 * commit, while solver snapshots still carry the local table.
 */
function persistedSketch(sketch: SketchDef | undefined): SketchDef | undefined {
    return sketch === undefined ? undefined : { ...sketch, parameters: undefined };
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
