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
const EXPORT_DAGMC_ID = 'nuke.cad.exportDagmc';

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
