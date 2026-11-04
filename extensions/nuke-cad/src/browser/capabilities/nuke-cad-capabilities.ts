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
 * CAD capabilities exposed through the nuke-core capability registry.
 *
 * The handlers read the active {@link NukeCadStateManager} model and delegate
 * builds and DAGMC export to {@link NukeCadFrontendService}; they never
 * reimplement geometry or export logic.
 *
 * @module nuke-cad/browser/capabilities
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import type { Event } from '@theia/core/lib/common/event';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { URI } from '@theia/core/lib/common/uri';
import * as path from 'path';
import {
    NukeArtifact,
    NukeCapability,
    NukeCapabilityContribution,
    NukeCapabilityContext,
    NukeCapabilityContextContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { deriveAnnotations, isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { BuildDocumentRequest, GeometryBuildRequest, GeometryBuildResult, RegionManifestData } from '../../common/nuke-cad-protocol';
import { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import { CadSelection, NukeCadStateManager, SolidSummary } from '../state/nuke-cad-state-manager';

const SUMMARIZE_DOCUMENT_ID = 'nuke.cad.summarizeDocument';
const INSPECT_SELECTION_ID = 'nuke.cad.inspectSelection';
const DIAGNOSE_MODEL_ID = 'nuke.cad.diagnoseModel';
const EXPORT_DAGMC_ID = 'nuke.cad.exportDagmc';

/** Maximum number of issues returned, including the truncation marker. */
const MAX_DIAGNOSTIC_ISSUES = 20;

const CATEGORY = ['CAD'] as const;

const SUMMARIZE_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        includeSolids: { type: 'boolean', default: false, description: 'Include per-solid summaries.' }
    },
    additionalProperties: false
};

const SUMMARIZE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Absolute path to the active CAD source.' },
        success: { type: 'boolean', description: 'Whether the active build succeeded.' },
        solidCount: { type: 'integer', description: 'Number of solid volumes in the model.' },
        faceCount: { type: 'integer', description: 'Total number of faces across all solids.' },
        triangleCount: { type: 'integer', description: 'Total number of tessellation triangles.' },
        boundingBox: {
            type: 'object',
            description: 'Model bounding box in model units.',
            properties: {
                min: { type: 'array', items: { type: 'number' } },
                max: { type: 'array', items: { type: 'number' } }
            }
        },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Build diagnostics.' },
        selection: {
            type: 'object',
            description: 'Current viewport selection.',
            properties: {
                solidId: { type: 'integer', description: 'Primary selected solid.' },
                faceId: { type: 'integer', description: 'Precise face of the primary solid.' },
                solidIds: { type: 'array', items: { type: 'integer' }, description: 'All highlighted solids.' }
            },
            additionalProperties: false
        },
        manifest: {
            type: 'object',
            description: 'Region manifest loaded for the active build.',
            properties: {
                volumes: { type: 'array', items: { type: 'object' } },
                surfaces: { type: 'array', items: { type: 'object' } }
            }
        },
        solids: {
            type: 'array',
            description: 'Per-solid summaries; present only when includeSolids is true.',
            items: {
                type: 'object',
                properties: {
                    solidId: { type: 'integer' },
                    bodyId: { type: 'string' },
                    faceCount: { type: 'integer' },
                    edgeCount: { type: 'integer' },
                    triangleCount: { type: 'integer' },
                    properties: { type: 'object', description: 'Volume, area, bounding box, and center of mass when available.' }
                },
                required: ['solidId', 'faceCount', 'edgeCount', 'triangleCount'],
                additionalProperties: false
            }
        }
    },
    required: ['documentPath', 'success', 'selection'],
    additionalProperties: false
};

const INSPECT_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const DIAGNOSE_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const DIAGNOSE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: { type: 'string', description: 'Absolute path to the active CAD source.' },
        success: { type: 'boolean', description: 'Whether the active build succeeded.' },
        valid: { type: 'boolean', description: 'True only when no error issue was found.' },
        counts: {
            type: 'object',
            description: 'Build counts for the active model.',
            properties: {
                solids: { type: 'integer' },
                faces: { type: 'integer' },
                triangles: { type: 'integer' }
            },
            required: ['solids', 'faces', 'triangles'],
            additionalProperties: false
        },
        manifest: {
            type: 'object',
            description: 'Region manifest coverage; present is false for a missing or empty manifest.',
            properties: {
                present: { type: 'boolean' },
                volumes: { type: 'integer', description: 'Number of manifest volumes.' },
                surfaces: { type: 'integer', description: 'Number of manifest surfaces.' }
            },
            required: ['present', 'volumes', 'surfaces'],
            additionalProperties: false
        },
        selection: {
            type: 'object',
            description: 'Current viewport selection; valid is false when it references missing geometry.',
            properties: {
                solidId: { type: 'integer', description: 'Primary selected solid.' },
                faceId: { type: 'integer', description: 'Precise face of the primary solid.' },
                solidIds: { type: 'array', items: { type: 'integer' }, description: 'All highlighted solids.' },
                valid: { type: 'boolean', description: 'Whether every selected solid and face exists in the active build.' }
            },
            required: ['valid'],
            additionalProperties: false
        },
        hiddenSolidIds: { type: 'array', items: { type: 'integer' }, description: 'Solids hidden in the viewport.' },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Build warnings copied from the active result.' },
        issues: {
            type: 'array',
            description: 'Severity-tagged findings; at most 20 issues including a truncation marker.',
            items: {
                type: 'object',
                properties: {
                    severity: { type: 'string', enum: ['error', 'warning', 'info'] },
                    code: { type: 'string' },
                    category: { type: 'string' },
                    message: { type: 'string' },
                    suggestion: { type: 'string' }
                },
                required: ['severity', 'code', 'message'],
                additionalProperties: false
            }
        }
    },
    required: ['documentPath', 'success', 'valid', 'counts', 'manifest', 'selection', 'hiddenSolidIds', 'warnings', 'issues'],
    additionalProperties: false
};

const EXPORT_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        documentPath: {
            type: 'string',
            description: 'Absolute .nuke-cad, .py, .step, .stp, or .brep path. Defaults to the active document.'
        },
        outputDirectory: { type: 'string', description: 'Absolute output directory. Defaults to the source directory.' },
        meshEngine: { type: 'string', enum: ['gmsh', 'netgen'] },
        meshSize: { type: 'number', minimum: 0 },
        lengthScale: { type: 'number', minimum: 0, description: '1.0 keeps model units; 0.01 converts cm to m.' }
    },
    additionalProperties: false
};

/** Selection shape shared by the summarize and inspect result data. */
interface SelectionData {
    solidId?: number;
    faceId?: number;
    solidIds?: number[];
}

/** Serialized solid summary returned by the read capabilities. */
interface SolidSummaryData {
    solidId: number;
    bodyId?: string;
    faceCount: number;
    edgeCount: number;
    triangleCount: number;
    properties?: unknown;
}

/** Optional meshing settings forwarded verbatim from the export input. */
interface MeshingOptions {
    meshEngine?: 'gmsh' | 'netgen';
    meshSize?: number;
    lengthScale?: number;
}

/** Severity-tagged diagnostic finding returned by `nuke.cad.diagnoseModel`. */
export interface NukeDiagnosticIssue {
    severity: 'error' | 'warning' | 'info';
    code: string;
    category?: string;
    message: string;
    suggestion?: string;
}

/** Selection payload with an explicit validity verdict. */
interface DiagnosticSelectionData {
    solidId?: number;
    faceId?: number;
    solidIds?: number[];
    valid: boolean;
}

/** Structured result data for `nuke.cad.diagnoseModel`. */
interface CadDiagnosisData {
    documentPath: string;
    success: boolean;
    valid: boolean;
    counts: { solids: number; faces: number; triangles: number };
    manifest: { present: boolean; volumes: number; surfaces: number };
    selection: DiagnosticSelectionData;
    hiddenSolidIds: number[];
    warnings: string[];
    issues: NukeDiagnosticIssue[];
}

/**
 * Register the CAD read and export capabilities and publish the active CAD
 * document to the capability context.
 */
@injectable()
export class NukeCadCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(NukeCadStateManager) protected readonly stateManager: NukeCadStateManager,
        @inject(NukeCadFrontendService) protected readonly service: NukeCadFrontendService,
        @inject(FileService) protected readonly fileService: FileService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register(this.summarizeDocumentCapability());
        registry.register(this.inspectSelectionCapability());
        registry.register(this.diagnoseModelCapability());
        registry.register(this.exportDagmcCapability());
    }

    protected summarizeDocumentCapability(): NukeCapability {
        return {
            id: SUMMARIZE_DOCUMENT_ID,
            title: 'Summarize CAD document',
            description: 'Return build counts, selection, region manifest, and optional per-solid summaries for the active CAD document.',
            category: CATEGORY,
            inputSchema: SUMMARIZE_INPUT_SCHEMA,
            outputSchema: SUMMARIZE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => this.stateManager.model !== undefined,
            invoke: async (input) => this.summarizeDocument(input)
        };
    }

    protected inspectSelectionCapability(): NukeCapability {
        return {
            id: INSPECT_SELECTION_ID,
            title: 'Inspect CAD selection',
            description: 'Return the primary solid, all selected solids, and the hidden solid ids for the active CAD document.',
            category: CATEGORY,
            inputSchema: INSPECT_INPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => this.stateManager.model !== undefined,
            invoke: async () => this.inspectSelection()
        };
    }

    protected diagnoseModelCapability(): NukeCapability {
        return {
            id: DIAGNOSE_MODEL_ID,
            title: 'Diagnose CAD model',
            description:
                'Report build state, counts, manifest coverage, selection validity, hidden solids, and per-solid geometry problems.',
            category: CATEGORY,
            inputSchema: DIAGNOSE_INPUT_SCHEMA,
            outputSchema: DIAGNOSE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => this.stateManager.model !== undefined,
            invoke: async () => this.diagnoseModel()
        };
    }

    protected exportDagmcCapability(): NukeCapability {
        return {
            id: EXPORT_DAGMC_ID,
            title: 'Export CAD to DAGMC',
            description: 'Build a .nuke-cad document, Python script, STEP, or BREP file and export its DAGMC model plus region manifest.',
            category: CATEGORY,
            inputSchema: EXPORT_INPUT_SCHEMA,
            risk: 'execute',
            annotations: deriveAnnotations('execute'),
            requiresConfirmation: true,
            when: () => true,
            invoke: async (input, context) => this.exportDagmc(input, context)
        };
    }

    protected summarizeDocument(input: unknown): NukeCapabilityResult {
        const model = this.stateManager.model;
        if (!model) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        const includeSolids = readRecord(input).includeSolids === true;
        const result = model.result;
        return {
            ok: true,
            data: withoutUndefined({
                documentPath: model.scriptPath,
                success: result.success,
                solidCount: result.solidCount,
                faceCount: result.faceCount,
                triangleCount: result.triangleCount,
                boundingBox: result.boundingBox,
                warnings: result.warnings,
                selection: toSelectionData(this.stateManager.selection),
                manifest: toManifestData(model.manifest),
                solids: includeSolids ? this.stateManager.solidSummaries.map(toSolidSummaryData) : undefined
            })
        };
    }

    protected inspectSelection(): NukeCapabilityResult {
        const model = this.stateManager.model;
        if (!model) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        const selection = this.stateManager.selection;
        const summaries = this.stateManager.solidSummaries;
        const findSolid = (solidId: number | undefined): SolidSummary | undefined =>
            solidId === undefined ? undefined : summaries.find((summary) => summary.solidId === solidId);
        const selectedIds = selection.solidIds ?? (selection.solidId !== undefined ? [selection.solidId] : []);
        const selectedSolids = selectedIds
            .map((solidId) => findSolid(solidId))
            .filter((summary): summary is SolidSummary => summary !== undefined)
            .map(toSolidSummaryData);
        const primarySolid = findSolid(selection.solidId);
        return {
            ok: true,
            data: withoutUndefined({
                documentPath: model.scriptPath,
                selection: toSelectionData(selection),
                primarySolid: primarySolid ? toSolidSummaryData(primarySolid) : undefined,
                selectedSolids,
                hiddenSolidIds: [...this.stateManager.hiddenSolidIds]
            })
        };
    }

    protected diagnoseModel(): NukeCapabilityResult {
        const model = this.stateManager.model;
        if (!model) {
            return { ok: false, message: 'No CAD document is active.' };
        }
        const result = model.result;
        const summaries = this.stateManager.solidSummaries;
        const selection = this.stateManager.selection;
        const hiddenSolidIds = this.stateManager.hiddenSolidIds;
        const solidCount = result.solidCount ?? 0;
        const faceCount = result.faceCount ?? 0;
        const triangleCount = result.triangleCount ?? 0;
        const warnings = [...(result.warnings ?? [])];
        const manifest = model.manifest;
        const manifestVolumes = manifest?.volumes.length ?? 0;
        const manifestSurfaces = manifest?.surfaces.length ?? 0;
        const manifestPresent = manifest !== undefined && (manifestVolumes > 0 || manifestSurfaces > 0);
        const summariesById = new Map(summaries.map((summary) => [summary.solidId, summary]));
        const selectionData = toDiagnosticSelectionData(selection, summariesById);

        const issues: NukeDiagnosticIssue[] = [];
        if (!result.success) {
            issues.push({
                severity: 'error',
                code: 'build-failed',
                category: 'build',
                message: `The active build failed: ${result.error || 'unknown error'}`,
                suggestion: 'Fix the reported build error and rebuild the document.'
            });
        }
        if (solidCount === 0) {
            issues.push({
                severity: 'error',
                code: 'no-solids',
                category: 'geometry',
                message: 'The active build produced no solid volumes.',
                suggestion: 'Check for empty bodies, suppressed features, or a failed boolean operation and rebuild.'
            });
        }
        if (solidCount > 0 && triangleCount === 0) {
            issues.push({
                severity: 'warning',
                code: 'no-triangles',
                category: 'tessellation',
                message: `The model has ${solidCount} solid(s) but no tessellation triangles.`,
                suggestion: 'Rebuild the document to regenerate its display tessellation.'
            });
        }
        for (const warning of warnings) {
            issues.push({
                severity: 'warning',
                code: 'build-warning',
                category: 'build',
                message: warning,
                suggestion: 'Review the build warning and rebuild after fixing its cause.'
            });
        }
        if (!manifestPresent) {
            issues.push({
                severity: 'warning',
                code: 'manifest-missing',
                category: 'manifest',
                message: 'No region manifest is loaded for the active build.',
                suggestion: 'Rebuild the document so material regions are written to its .regions.json sidecar.'
            });
        } else if (manifestVolumes !== solidCount) {
            issues.push({
                severity: 'warning',
                code: 'manifest-count-mismatch',
                category: 'manifest',
                message: `The region manifest lists ${manifestVolumes} volume(s) but the build has ${solidCount} solid(s).`,
                suggestion: 'Rebuild the document so the manifest matches the active solids.'
            });
        }
        if (!selectionData.valid) {
            issues.push({
                severity: 'warning',
                code: 'selection-stale',
                category: 'selection',
                message: 'The current selection references a solid or face that is not part of the active build.',
                suggestion: 'Reselect geometry in the viewport or clear the stale selection.'
            });
        }
        if (hiddenSolidIds.length > 0) {
            issues.push({
                severity: 'info',
                code: 'hidden-solids',
                category: 'viewport',
                message: `${hiddenSolidIds.length} solid(s) are hidden in the viewport; hidden solids are still exported.`,
                suggestion: 'Reveal hidden solids in the Model Outline to inspect all geometry.'
            });
        }
        for (const summary of summaries) {
            if (summary.triangleCount === 0) {
                issues.push({
                    severity: 'warning',
                    code: 'solid-no-triangles',
                    category: 'tessellation',
                    message: `Solid ${summary.solidId} has no tessellation triangles.`,
                    suggestion: 'Rebuild to regenerate the display tessellation for this solid.'
                });
            }
            const volume = summary.properties?.volume;
            if (volume !== undefined && volume <= 0) {
                issues.push({
                    severity: 'warning',
                    code: 'solid-zero-volume',
                    category: 'geometry',
                    message: `Solid ${summary.solidId} has non-positive volume (${volume}).`,
                    suggestion: 'Check the body dimensions and boolean operations; zero-volume solids cannot be exported reliably.'
                });
            }
        }

        const valid = !issues.some((issue) => issue.severity === 'error');

        const data: CadDiagnosisData = {
            documentPath: model.scriptPath,
            success: result.success,
            valid,
            counts: { solids: solidCount, faces: faceCount, triangles: triangleCount },
            manifest: { present: manifestPresent, volumes: manifestVolumes, surfaces: manifestSurfaces },
            selection: selectionData,
            hiddenSolidIds: [...hiddenSolidIds],
            warnings,
            issues: capDiagnosticIssues(issues)
        };
        return { ok: true, data };
    }

    protected async exportDagmc(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const requestedDocumentPath = record.documentPath;
        if (requestedDocumentPath !== undefined && typeof requestedDocumentPath !== 'string') {
            return { ok: false, message: 'documentPath must be a string.' };
        }
        const documentPath = requestedDocumentPath ?? this.stateManager.scriptPath;
        if (!documentPath) {
            return { ok: false, message: 'No CAD document is active and no documentPath was provided.' };
        }
        const documentPathError = this.scopeError(documentPath, 'CAD document path', context.workspaceRoots);
        if (documentPathError) {
            return { ok: false, message: documentPathError };
        }

        const requestedOutputDirectory = record.outputDirectory;
        if (requestedOutputDirectory !== undefined && typeof requestedOutputDirectory !== 'string') {
            return { ok: false, message: 'outputDirectory must be a string.' };
        }
        if (requestedOutputDirectory !== undefined) {
            const outputDirectoryError = this.scopeError(requestedOutputDirectory, 'CAD output directory', context.workspaceRoots);
            if (outputDirectoryError) {
                return { ok: false, message: outputDirectoryError };
            }
        }

        const resolvedDocumentPath = path.resolve(documentPath);
        const resolvedOutputDirectory = requestedOutputDirectory !== undefined ? path.resolve(requestedOutputDirectory) : undefined;
        const extension = path.extname(resolvedDocumentPath).toLowerCase();
        if (extension === '.py' && this.stateManager.model?.sandboxed === true) {
            return {
                ok: false,
                message:
                    'Export is disabled for a sandboxed AI-authored script. Disable script authoring/reopen as a trusted script to export.'
            };
        }
        const request = {
            scriptPath: resolvedDocumentPath,
            exportDagmc: true,
            exportMesh: false,
            ...(resolvedOutputDirectory !== undefined ? { outputDirectory: resolvedOutputDirectory } : {}),
            ...readMeshingOptions(record)
        };
        let result: GeometryBuildResult;
        if (extension === '.nuke-cad') {
            result = await this.service.buildDocument(request as BuildDocumentRequest);
        } else if (extension === '.py') {
            result = await this.service.buildGeometry({ ...request, sourceType: 'script' } as GeometryBuildRequest);
        } else if (extension === '.step' || extension === '.stp' || extension === '.brep') {
            result = await this.service.buildGeometry({ ...request, sourceType: 'step' } as GeometryBuildRequest);
        } else {
            return {
                ok: false,
                message: `Unsupported CAD source "${extension || resolvedDocumentPath}". Use .nuke-cad, .py, .step, .stp, or .brep.`
            };
        }

        if (!result.success) {
            return { ok: false, message: result.error ?? 'CAD export failed.', data: { warnings: result.warnings } };
        }
        if (result.dagmcSuccess === false) {
            return {
                ok: false,
                message: result.dagmcError ?? 'DAGMC export failed.',
                data: withoutUndefined({
                    documentPath: resolvedDocumentPath,
                    stepPath: result.stepPath,
                    warnings: result.warnings,
                    dagmcWarnings: result.dagmcWarnings,
                    outputDirectory: result.outputDirectory
                })
            };
        }

        const manifestPath = await this.findManifestSidecar(resolvedDocumentPath, resolvedOutputDirectory);
        const artifacts: NukeArtifact[] = [];
        if (result.dagmcPath) {
            artifacts.push({ kind: 'file', label: 'DAGMC model', path: result.dagmcPath });
        }
        if (manifestPath) {
            artifacts.push({ kind: 'file', label: 'Region manifest', path: manifestPath });
        }
        if (result.stepPath) {
            artifacts.push({ kind: 'file', label: 'STEP model', path: result.stepPath });
        }
        return {
            ok: true,
            data: withoutUndefined({
                documentPath: resolvedDocumentPath,
                dagmcPath: result.dagmcPath,
                stepPath: result.stepPath,
                regionManifestPath: manifestPath,
                regionManifest: manifestPath ? result.regionManifest : undefined,
                selectorMap: result.selectorMap,
                warnings: result.warnings,
                dagmcWarnings: result.dagmcWarnings,
                outputDirectory: result.outputDirectory
            }),
            artifacts,
            nextActions: [
                {
                    capability: 'nuke.openmc.importCad',
                    reason: 'Import the DAGMC model and region manifest into OpenMC Studio.'
                }
            ]
        };
    }

    /** Reject relative paths and paths outside every workspace root. */
    protected scopeError(candidate: string, label: string, roots: readonly string[]): string | undefined {
        if (!path.isAbsolute(candidate)) {
            return `${label} must be an absolute path: ${candidate}`;
        }
        if (!isWithinWorkspace(candidate, roots)) {
            return `${label} is outside the workspace: ${candidate}`;
        }
        return undefined;
    }

    /**
     * Locate `<stem>.regions.json` in the source directory first, then in an
     * explicit output directory. Only an existing file is returned.
     */
    protected async findManifestSidecar(documentPath: string, outputDirectory?: string): Promise<string | undefined> {
        const stem = path.basename(documentPath, path.extname(documentPath));
        const sourceDirectory = path.dirname(documentPath);
        const directories = [sourceDirectory];
        if (outputDirectory !== undefined && path.resolve(outputDirectory) !== path.resolve(sourceDirectory)) {
            directories.push(outputDirectory);
        }
        for (const directory of directories) {
            const candidate = path.join(directory, `${stem}.regions.json`);
            if (await this.fileService.exists(new URI(candidate))) {
                return candidate;
            }
        }
        return undefined;
    }
}

/**
 * Contribute the active CAD source path to the capability context so consumers
 * can resolve documents without importing nuke-cad.
 */
@injectable()
export class NukeCadContextContribution implements NukeCapabilityContextContribution {
    /** Change notifications carry the model payload; capability context consumers ignore it. */
    readonly onDidChangeContext = this.stateManager.onModelChange as unknown as Event<void>;

    constructor(@inject(NukeCadStateManager) protected readonly stateManager: NukeCadStateManager) {}

    getContext(): Partial<NukeCapabilityContext> {
        return { activeCadDocument: this.stateManager.scriptPath };
    }
}

function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Drop undefined optional fields so JSON results do not carry empty keys. */
function withoutUndefined<T extends object>(value: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            result[key] = entry;
        }
    }
    return result as T;
}

function readMeshingOptions(record: Record<string, unknown>): MeshingOptions {
    const options: MeshingOptions = {};
    if (record.meshEngine === 'gmsh' || record.meshEngine === 'netgen') {
        options.meshEngine = record.meshEngine;
    }
    if (typeof record.meshSize === 'number' && Number.isFinite(record.meshSize) && record.meshSize >= 0) {
        options.meshSize = record.meshSize;
    }
    if (typeof record.lengthScale === 'number' && Number.isFinite(record.lengthScale) && record.lengthScale >= 0) {
        options.lengthScale = record.lengthScale;
    }
    return options;
}

/** Keep at most {@link MAX_DIAGNOSTIC_ISSUES} issues, replacing the tail with a truncation notice. */
function capDiagnosticIssues(issues: readonly NukeDiagnosticIssue[]): NukeDiagnosticIssue[] {
    if (issues.length <= MAX_DIAGNOSTIC_ISSUES) {
        return [...issues];
    }
    const omitted = issues.length - (MAX_DIAGNOSTIC_ISSUES - 1);
    return [
        ...issues.slice(0, MAX_DIAGNOSTIC_ISSUES - 1),
        {
            severity: 'info',
            code: 'findings-truncated',
            category: 'diagnostics',
            message: `${omitted} additional finding(s) were omitted from this diagnosis.`,
            suggestion: 'Fix the highest-severity findings and run the diagnosis again.'
        }
    ];
}

function toDiagnosticSelectionData(selection: CadSelection, summaries: ReadonlyMap<number, SolidSummary>): DiagnosticSelectionData {
    const referencedSolidIds =
        selection.solidId !== undefined ? [selection.solidId, ...(selection.solidIds ?? [])] : [...(selection.solidIds ?? [])];
    let valid = referencedSolidIds.every((solidId) => summaries.has(solidId));
    if (selection.faceId !== undefined) {
        const primary = selection.solidId !== undefined ? summaries.get(selection.solidId) : undefined;
        valid = valid && primary !== undefined && selection.faceId >= 1 && selection.faceId <= primary.faceCount;
    }
    const data: DiagnosticSelectionData = { valid };
    if (selection.solidId !== undefined) {
        data.solidId = selection.solidId;
    }
    if (selection.faceId !== undefined) {
        data.faceId = selection.faceId;
    }
    if (selection.solidIds !== undefined) {
        data.solidIds = [...selection.solidIds];
    }
    return data;
}

function toSelectionData(selection: CadSelection): SelectionData {
    const data: SelectionData = {};
    if (selection.solidId !== undefined) {
        data.solidId = selection.solidId;
    }
    if (selection.faceId !== undefined) {
        data.faceId = selection.faceId;
    }
    if (selection.solidIds !== undefined) {
        data.solidIds = [...selection.solidIds];
    }
    return data;
}

function toManifestData(manifest: RegionManifestData | undefined): { volumes: unknown[]; surfaces: unknown[] } | undefined {
    return manifest ? { volumes: manifest.volumes, surfaces: manifest.surfaces } : undefined;
}

function toSolidSummaryData(summary: SolidSummary): SolidSummaryData {
    return withoutUndefined({
        solidId: summary.solidId,
        bodyId: summary.bodyId,
        faceCount: summary.faceCount,
        edgeCount: summary.edgeCount,
        triangleCount: summary.triangleCount,
        properties: summary.properties
    });
}
