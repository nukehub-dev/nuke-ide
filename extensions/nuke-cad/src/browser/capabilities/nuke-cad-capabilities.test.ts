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

import { describe, it, expect, vi } from 'vitest';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));

import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { BuildDocumentRequest, GeometryBuildRequest, GeometryBuildResult, RegionManifestData } from '../../common/nuke-cad-protocol';
import type { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import type { CadModel, CadSelection, NukeCadStateManager, SolidSummary } from '../state/nuke-cad-state-manager';
import type { NukeDiagnosticIssue } from './nuke-cad-capabilities';
import { NukeCadCapabilities, NukeCadContextContribution } from './nuke-cad-capabilities';

const WORKSPACE = '/workspace/project';
const DOCUMENT_PATH = `${WORKSPACE}/pincell.nuke-cad`;
const OUTPUT_DIRECTORY = `${WORKSPACE}/out`;

const MANIFEST: RegionManifestData = {
    version: 1,
    volumes: [{ selector: 'fuel', material: 'uo2' }],
    surfaces: [{ selector: 'outer', role: 'boundary' }]
};

const SUMMARIES: SolidSummary[] = [
    {
        solidId: 1,
        bodyId: 'body-1',
        faceCount: 6,
        edgeCount: 12,
        triangleCount: 60,
        properties: { volume: 12.5, area: 30 }
    },
    {
        solidId: 2,
        bodyId: 'body-2',
        faceCount: 8,
        edgeCount: 14,
        triangleCount: 80
    },
    {
        solidId: 3,
        faceCount: 4,
        edgeCount: 6,
        triangleCount: 40
    }
];

const CONTEXT: NukeCapabilityContext = { workspaceRoots: [WORKSPACE], activeCadDocument: DOCUMENT_PATH };

interface DiagnosisData {
    documentPath: string;
    success: boolean;
    valid: boolean;
    counts: { solids: number; faces: number; triangles: number };
    manifest: { present: boolean; volumes: number; surfaces: number };
    selection: { solidId?: number; faceId?: number; solidIds?: number[]; valid: boolean };
    hiddenSolidIds: number[];
    warnings: string[];
    issues: NukeDiagnosticIssue[];
}

function manifestFor(solidCount: number): RegionManifestData {
    return {
        version: 1,
        volumes: Array.from({ length: solidCount }, (_, index) => ({ selector: `region-${index + 1}` })),
        surfaces: MANIFEST.surfaces
    };
}

function diagnosisData(result: NukeCapabilityResult): DiagnosisData {
    return result.data as DiagnosisData;
}

function issueCodes(data: DiagnosisData): string[] {
    return data.issues.map((issue) => issue.code);
}

interface StateFixture {
    stateManager: NukeCadStateManager;
    setModel: (model: CadModel | undefined) => void;
}

function createStateManager(
    initial: {
        model?: CadModel;
        selection?: CadSelection;
        solidSummaries?: readonly SolidSummary[];
        hiddenSolidIds?: readonly number[];
    } = {}
): StateFixture {
    let model = initial.model;
    const fake = {
        get model(): CadModel | undefined {
            return model;
        },
        get scriptPath(): string | undefined {
            return model?.scriptPath;
        },
        selection: initial.selection ?? {},
        solidSummaries: initial.solidSummaries ?? [],
        hiddenSolidIds: initial.hiddenSolidIds ?? [],
        onModelChange: () => ({ dispose: () => undefined }),
        onSelectionChange: () => ({ dispose: () => undefined }),
        onSolidSummariesChange: () => ({ dispose: () => undefined })
    };
    return {
        stateManager: fake as unknown as NukeCadStateManager,
        setModel: (next) => {
            model = next;
        }
    };
}

interface ServiceCapture {
    documents: BuildDocumentRequest[];
    geometries: GeometryBuildRequest[];
}

function createService(overrides: Partial<GeometryBuildResult> = {}): {
    service: NukeCadFrontendService;
    capture: ServiceCapture;
} {
    const capture: ServiceCapture = { documents: [], geometries: [] };
    const result: GeometryBuildResult = {
        success: true,
        dagmcSuccess: true,
        dagmcPath: `${WORKSPACE}/pincell.h5m`,
        stepPath: `${WORKSPACE}/pincell.step`,
        outputDirectory: WORKSPACE,
        regionManifest: MANIFEST,
        selectorMap: { fuel: [1], shield: [2] },
        warnings: ['build warning'],
        dagmcWarnings: ['dagmc warning'],
        ...overrides
    };
    const service = {
        buildDocument: async (request: BuildDocumentRequest) => {
            capture.documents.push(request);
            return result;
        },
        buildGeometry: async (request: GeometryBuildRequest) => {
            capture.geometries.push(request);
            return result;
        }
    } as unknown as NukeCadFrontendService;
    return { service, capture };
}

type FakeFileService = FileService & { exists: ReturnType<typeof vi.fn> };

function createFileService(existing: readonly string[] = []): FakeFileService {
    const paths = new Set(existing);
    return {
        exists: vi.fn(async (uri: URI) => paths.has(uri.path.toString()))
    } as unknown as FakeFileService;
}

function register(capabilities: NukeCadCapabilities): Map<string, NukeCapability> {
    const registered = new Map<string, NukeCapability>();
    const registry = {
        register: (capability: NukeCapability) => {
            registered.set(capability.id, capability);
        }
    } as unknown as NukeCapabilityRegistry;
    capabilities.registerCapabilities(registry);
    return registered;
}

function checkedManifestPaths(fileService: FakeFileService): string[] {
    return fileService.exists.mock.calls.map((call) => (call[0] as URI).path.toString());
}

function cadModel(overrides: Partial<GeometryBuildResult> = {}): CadModel {
    return {
        scriptPath: DOCUMENT_PATH,
        manifest: MANIFEST,
        result: {
            success: true,
            scriptPath: DOCUMENT_PATH,
            solidCount: 3,
            faceCount: 18,
            triangleCount: 180,
            boundingBox: { min: [0, 0, 0], max: [10, 20, 30] },
            warnings: ['display build warning'],
            ...overrides
        }
    };
}

describe('NukeCadCapabilities', () => {
    it('summarizes the active model with counts, manifest, selection, and solids', async () => {
        const { stateManager } = createStateManager({
            model: cadModel(),
            selection: { solidId: 1, faceId: 2, solidIds: [1, 2] },
            solidSummaries: SUMMARIES,
            hiddenSolidIds: [3]
        });
        const { service, capture } = createService();
        const capabilities = register(new NukeCadCapabilities(stateManager, service, createFileService()));
        const capability = capabilities.get('nuke.cad.summarizeDocument')!;

        const result = await capability.invoke({ includeSolids: true }, CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            success: true,
            solidCount: 3,
            faceCount: 18,
            triangleCount: 180,
            boundingBox: { min: [0, 0, 0], max: [10, 20, 30] },
            warnings: ['display build warning'],
            selection: { solidId: 1, faceId: 2, solidIds: [1, 2] },
            manifest: { volumes: MANIFEST.volumes, surfaces: MANIFEST.surfaces },
            solids: [
                { solidId: 1, bodyId: 'body-1', faceCount: 6, edgeCount: 12, triangleCount: 60, properties: { volume: 12.5, area: 30 } },
                { solidId: 2, bodyId: 'body-2', faceCount: 8, edgeCount: 14, triangleCount: 80 },
                { solidId: 3, faceCount: 4, edgeCount: 6, triangleCount: 40 }
            ]
        });
        expect(capture.documents).toHaveLength(0);
        expect(capture.geometries).toHaveLength(0);
        expect(capability.risk).toBe('read');
        expect(capability.annotations?.readOnlyHint).toBe(true);
        expect(capability.outputSchema?.properties.documentPath.type).toBe('string');
        expect(capability.outputSchema?.properties.selection.type).toBe('object');
        expect(capability.outputSchema?.properties.solids.type).toBe('array');
    });

    it('omits per-solid summaries unless includeSolids is true', async () => {
        const { stateManager } = createStateManager({ model: cadModel(), solidSummaries: SUMMARIES });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.summarizeDocument')!;

        const result = await capability.invoke({}, CONTEXT);

        expect(result.ok).toBe(true);
        expect((result.data as { solids?: unknown }).solids).toBeUndefined();
    });

    it('returns ok: false when no CAD document is active', async () => {
        const { stateManager } = createStateManager();
        const { service } = createService();
        const capabilities = register(new NukeCadCapabilities(stateManager, service, createFileService()));
        const expected = { ok: false, message: 'No CAD document is active.' };

        expect(await capabilities.get('nuke.cad.summarizeDocument')!.invoke({}, CONTEXT)).toEqual(expected);
        expect(await capabilities.get('nuke.cad.inspectSelection')!.invoke({}, CONTEXT)).toEqual(expected);
    });

    it('inspects the primary solid, multi-selected solids, and hidden ids', async () => {
        const { stateManager } = createStateManager({
            model: cadModel(),
            selection: { solidId: 2, faceId: 7, solidIds: [1, 2] },
            solidSummaries: SUMMARIES,
            hiddenSolidIds: [3]
        });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.inspectSelection')!;

        const result = await capability.invoke({}, CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            documentPath: DOCUMENT_PATH,
            selection: { solidId: 2, faceId: 7, solidIds: [1, 2] },
            primarySolid: { solidId: 2, bodyId: 'body-2', faceCount: 8, edgeCount: 14, triangleCount: 80 },
            selectedSolids: [
                { solidId: 1, bodyId: 'body-1', faceCount: 6, edgeCount: 12, triangleCount: 60, properties: { volume: 12.5, area: 30 } },
                { solidId: 2, bodyId: 'body-2', faceCount: 8, edgeCount: 14, triangleCount: 80 }
            ],
            hiddenSolidIds: [3]
        });
    });

    it('falls back to the primary solid when only one solid is selected', async () => {
        const { stateManager } = createStateManager({
            model: cadModel(),
            selection: { solidId: 1 },
            solidSummaries: SUMMARIES
        });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.inspectSelection')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = result.data as { selectedSolids: SolidSummary[]; hiddenSolidIds: number[] };

        expect(data.selectedSolids.map((solid) => solid.solidId)).toEqual([1]);
        expect(data.hiddenSolidIds).toEqual([]);
    });

    it('exports a .nuke-cad document with DAGMC on, mesh off, and only the provided meshing options', async () => {
        const { stateManager } = createStateManager({ model: cadModel() });
        const { service, capture } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke(
            {
                documentPath: DOCUMENT_PATH,
                outputDirectory: OUTPUT_DIRECTORY,
                meshEngine: 'netgen',
                meshSize: 0.5,
                lengthScale: 0.01
            },
            CONTEXT
        );

        expect(result.ok).toBe(true);
        expect(capture.documents).toEqual([
            {
                scriptPath: DOCUMENT_PATH,
                outputDirectory: OUTPUT_DIRECTORY,
                exportDagmc: true,
                exportMesh: false,
                meshEngine: 'netgen',
                meshSize: 0.5,
                lengthScale: 0.01
            }
        ]);
        expect(capture.geometries).toHaveLength(0);
        expect(result.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            dagmcPath: `${WORKSPACE}/pincell.h5m`,
            stepPath: `${WORKSPACE}/pincell.step`,
            selectorMap: { fuel: [1], shield: [2] },
            warnings: ['build warning'],
            dagmcWarnings: ['dagmc warning'],
            outputDirectory: WORKSPACE
        });
        expect((result.data as { regionManifestPath?: string }).regionManifestPath).toBeUndefined();
        expect(result.artifacts).toEqual([
            { kind: 'file', label: 'DAGMC model', path: `${WORKSPACE}/pincell.h5m` },
            { kind: 'file', label: 'STEP model', path: `${WORKSPACE}/pincell.step` }
        ]);
        expect(result.nextActions).toEqual([
            {
                capability: 'nuke.openmc.importCad',
                reason: 'Import the DAGMC model and region manifest into OpenMC Studio.'
            }
        ]);
    });

    it('rejects DAGMC export for a sandboxed AI-authored script', async () => {
        const { stateManager } = createStateManager({ model: { ...cadModel(), sandboxed: true } });
        const { service, capture } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({ documentPath: `${WORKSPACE}/pincell.py` }, CONTEXT);

        expect(result).toEqual({
            ok: false,
            message: 'Export is disabled for a sandboxed AI-authored script. Disable script authoring/reopen as a trusted script to export.'
        });
        expect(capture.documents).toHaveLength(0);
        expect(capture.geometries).toHaveLength(0);
    });

    it('uses buildGeometry with the right source type for scripts and exchange files', async () => {
        const sources: Array<[string, 'script' | 'step']> = [
            ['pincell.py', 'script'],
            ['pincell.step', 'step'],
            ['pincell.stp', 'step'],
            ['pincell.brep', 'step']
        ];
        for (const [fileName, sourceType] of sources) {
            const { stateManager } = createStateManager();
            const { service, capture } = createService();
            const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;
            const sourcePath = `${WORKSPACE}/${fileName}`;

            const result = await capability.invoke({ documentPath: sourcePath }, CONTEXT);

            expect(result.ok).toBe(true);
            expect(capture.documents).toHaveLength(0);
            expect(capture.geometries).toEqual([{ scriptPath: sourcePath, exportDagmc: true, exportMesh: false, sourceType }]);
        }
    });

    it('rejects unsupported source extensions before building', async () => {
        const { stateManager } = createStateManager();
        const { service, capture } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({ documentPath: `${WORKSPACE}/pincell.igs` }, CONTEXT);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('Unsupported CAD source');
        expect(capture.documents).toHaveLength(0);
        expect(capture.geometries).toHaveLength(0);
    });

    it('rejects relative paths and paths outside the workspace before building', async () => {
        const { stateManager } = createStateManager();
        const { service, capture } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;

        const relative = await capability.invoke({ documentPath: 'pincell.nuke-cad' }, CONTEXT);
        expect(relative.ok).toBe(false);
        expect(relative.message).toContain('must be an absolute path');

        const outside = await capability.invoke({ documentPath: '/outside/pincell.nuke-cad' }, CONTEXT);
        expect(outside.ok).toBe(false);
        expect(outside.message).toContain('outside the workspace');

        const outputOutside = await capability.invoke({ documentPath: DOCUMENT_PATH, outputDirectory: '/outside/output' }, CONTEXT);
        expect(outputOutside.ok).toBe(false);
        expect(outputOutside.message).toContain('CAD output directory is outside the workspace');

        expect(capture.documents).toHaveLength(0);
        expect(capture.geometries).toHaveLength(0);
    });

    it('requires a document path when no model is active', async () => {
        const { stateManager } = createStateManager();
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({}, CONTEXT);

        expect(result).toEqual({
            ok: false,
            message: 'No CAD document is active and no documentPath was provided.'
        });
    });

    it('propagates build failures', async () => {
        const { stateManager } = createStateManager();
        const { service } = createService({ success: false, error: 'Build failed in the geometry service.' });
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({ documentPath: DOCUMENT_PATH }, CONTEXT);

        expect(result).toEqual({
            ok: false,
            message: 'Build failed in the geometry service.',
            data: { warnings: ['build warning'] }
        });
    });

    it('propagates DAGMC export failures', async () => {
        const { stateManager } = createStateManager();
        const { service } = createService({ dagmcSuccess: false, dagmcError: 'DAGMC sense error.' });
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({ documentPath: DOCUMENT_PATH }, CONTEXT);

        expect(result.ok).toBe(false);
        expect(result.message).toBe('DAGMC sense error.');
        expect(result.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            stepPath: `${WORKSPACE}/pincell.step`,
            warnings: ['build warning'],
            dagmcWarnings: ['dagmc warning'],
            outputDirectory: WORKSPACE
        });
    });

    it('returns the source-side manifest sidecar when it exists', async () => {
        const manifestPath = `${WORKSPACE}/pincell.regions.json`;
        const { stateManager } = createStateManager();
        const { service } = createService();
        const fileService = createFileService([manifestPath]);
        const capability = register(new NukeCadCapabilities(stateManager, service, fileService)).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({ documentPath: DOCUMENT_PATH }, CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({ regionManifestPath: manifestPath, regionManifest: MANIFEST });
        expect(result.artifacts).toContainEqual({ kind: 'file', label: 'Region manifest', path: manifestPath });
        expect(checkedManifestPaths(fileService)).toContain(manifestPath);
    });

    it('checks an explicit output directory for the manifest sidecar', async () => {
        const documentPath = `${WORKSPACE}/parts/part.nuke-cad`;
        const manifestPath = `${OUTPUT_DIRECTORY}/part.regions.json`;
        const { stateManager } = createStateManager();
        const { service } = createService();
        const fileService = createFileService([manifestPath]);
        const capability = register(new NukeCadCapabilities(stateManager, service, fileService)).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({ documentPath, outputDirectory: OUTPUT_DIRECTORY }, CONTEXT);

        expect(result.ok).toBe(true);
        expect((result.data as { regionManifestPath?: string }).regionManifestPath).toBe(manifestPath);
        expect(checkedManifestPaths(fileService)).toContain(manifestPath);
    });

    it('omits the manifest when no sidecar exists', async () => {
        const { stateManager } = createStateManager();
        const { service } = createService();
        const fileService = createFileService();
        const capability = register(new NukeCadCapabilities(stateManager, service, fileService)).get('nuke.cad.exportDagmc')!;

        const result = await capability.invoke({ documentPath: DOCUMENT_PATH }, CONTEXT);
        const data = result.data as { regionManifestPath?: string; regionManifest?: unknown };

        expect(result.ok).toBe(true);
        expect(data.regionManifestPath).toBeUndefined();
        expect(data.regionManifest).toBeUndefined();
        expect(result.artifacts?.some((artifact) => artifact.label === 'Region manifest')).toBe(false);
        expect(fileService.exists).toHaveBeenCalledTimes(1);
    });

    it('enables the read capabilities only while a model is active and always enables export', async () => {
        const { stateManager, setModel } = createStateManager();
        const { service } = createService();
        const capabilities = register(new NukeCadCapabilities(stateManager, service, createFileService()));
        const summarize = capabilities.get('nuke.cad.summarizeDocument')!;
        const inspect = capabilities.get('nuke.cad.inspectSelection')!;
        const exportDagmc = capabilities.get('nuke.cad.exportDagmc')!;

        expect(summarize.when!(CONTEXT)).toBe(false);
        expect(inspect.when!(CONTEXT)).toBe(false);
        expect(exportDagmc.when!(CONTEXT)).toBe(true);
        expect(exportDagmc.risk).toBe('execute');
        expect(exportDagmc.requiresConfirmation).toBe(true);

        setModel(cadModel());
        expect(summarize.when!(CONTEXT)).toBe(true);
        expect(inspect.when!(CONTEXT)).toBe(true);
    });

    it('diagnoses a healthy model with no findings', async () => {
        const model: CadModel = {
            ...cadModel({ solidCount: 1, faceCount: 6, triangleCount: 60, warnings: [] }),
            manifest: manifestFor(1)
        };
        const { stateManager } = createStateManager({
            model,
            selection: { solidId: 1, faceId: 2 },
            solidSummaries: [SUMMARIES[0]]
        });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);

        expect(result.ok).toBe(true);
        expect(diagnosisData(result)).toEqual({
            documentPath: DOCUMENT_PATH,
            success: true,
            valid: true,
            counts: { solids: 1, faces: 6, triangles: 60 },
            manifest: { present: true, volumes: 1, surfaces: 1 },
            selection: { solidId: 1, faceId: 2, valid: true },
            hiddenSolidIds: [],
            warnings: [],
            issues: []
        });
        expect(capability.title).toBe('Diagnose CAD model');
        expect(capability.risk).toBe('read');
        expect(capability.annotations?.readOnlyHint).toBe(true);
        expect(capability.requiresConfirmation).toBeUndefined();
        expect(capability.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
        expect(capability.outputSchema?.properties.counts.type).toBe('object');
        expect(capability.outputSchema?.properties.manifest.type).toBe('object');
        expect(capability.outputSchema?.properties.selection.type).toBe('object');
        expect(capability.outputSchema?.properties.issues.type).toBe('array');
    });

    it('reports a failed build as an error issue', async () => {
        const model: CadModel = {
            ...cadModel({
                success: false,
                error: 'OpenCASCADE failed',
                solidCount: 0,
                faceCount: 0,
                triangleCount: 0,
                warnings: []
            }),
            manifest: manifestFor(0)
        };
        const { stateManager } = createStateManager({ model, solidSummaries: [] });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = diagnosisData(result);

        expect(result.ok).toBe(true);
        expect(data.success).toBe(false);
        expect(data.valid).toBe(false);
        expect(data.issues).toContainEqual({
            severity: 'error',
            code: 'build-failed',
            category: 'build',
            message: 'The active build failed: OpenCASCADE failed',
            suggestion: 'Fix the reported build error and rebuild the document.'
        });
        expect(issueCodes(data)).toContain('no-solids');
    });

    it('reports a build that produced no solids', async () => {
        const model: CadModel = {
            ...cadModel({ solidCount: 0, faceCount: 0, triangleCount: 0, warnings: [] }),
            manifest: manifestFor(0)
        };
        const { stateManager } = createStateManager({ model, solidSummaries: [] });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = diagnosisData(result);

        expect(result.ok).toBe(true);
        expect(data.counts).toEqual({ solids: 0, faces: 0, triangles: 0 });
        expect(data.valid).toBe(false);
        expect(data.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'no-solids', category: 'geometry' }));
        expect(issueCodes(data)).not.toContain('no-triangles');
    });

    it('maps each build warning to a build-warning finding', async () => {
        const model: CadModel = {
            ...cadModel({
                solidCount: 1,
                faceCount: 6,
                triangleCount: 60,
                warnings: ['first warning', 'second warning']
            }),
            manifest: manifestFor(1)
        };
        const { stateManager } = createStateManager({ model, solidSummaries: [SUMMARIES[0]] });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = diagnosisData(result);

        expect(data.warnings).toEqual(['first warning', 'second warning']);
        expect(data.issues.filter((issue) => issue.code === 'build-warning')).toEqual([
            expect.objectContaining({ severity: 'warning', category: 'build', message: 'first warning' }),
            expect.objectContaining({ severity: 'warning', category: 'build', message: 'second warning' })
        ]);
        expect(data.valid).toBe(true);
    });

    it('reports a missing or empty manifest', async () => {
        const base = cadModel({ solidCount: 1, faceCount: 6, triangleCount: 60, warnings: [] });
        const manifests: Array<RegionManifestData | undefined> = [undefined, { version: 1, volumes: [], surfaces: [] }];
        for (const manifest of manifests) {
            const { stateManager } = createStateManager({
                model: { ...base, manifest },
                solidSummaries: [SUMMARIES[0]]
            });
            const { service } = createService();
            const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

            const result = await capability.invoke({}, CONTEXT);
            const data = diagnosisData(result);

            expect(result.ok).toBe(true);
            expect(data.manifest).toEqual({ present: false, volumes: 0, surfaces: 0 });
            expect(issueCodes(data)).toContain('manifest-missing');
            expect(issueCodes(data)).not.toContain('manifest-count-mismatch');
        }
    });

    it('reports a manifest volume count that does not match the solids', async () => {
        const model: CadModel = {
            ...cadModel({ solidCount: 3, faceCount: 18, triangleCount: 180, warnings: [] }),
            manifest: MANIFEST
        };
        const { stateManager } = createStateManager({ model, solidSummaries: SUMMARIES });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = diagnosisData(result);

        expect(result.ok).toBe(true);
        expect(data.manifest).toEqual({ present: true, volumes: 1, surfaces: 1 });
        expect(data.issues).toContainEqual(
            expect.objectContaining({
                severity: 'warning',
                code: 'manifest-count-mismatch',
                category: 'manifest',
                message: 'The region manifest lists 1 volume(s) but the build has 3 solid(s).'
            })
        );
        expect(issueCodes(data)).not.toContain('manifest-missing');
    });

    it('reports a stale selection that no longer matches the solid summaries', async () => {
        const model: CadModel = {
            ...cadModel({ solidCount: 3, faceCount: 18, triangleCount: 180, warnings: [] }),
            manifest: manifestFor(3)
        };
        const selections: CadSelection[] = [
            { solidId: 9, solidIds: [1, 9] },
            { solidId: 1, faceId: 99 }
        ];
        for (const selection of selections) {
            const { stateManager } = createStateManager({ model, selection, solidSummaries: SUMMARIES });
            const { service } = createService();
            const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

            const result = await capability.invoke({}, CONTEXT);
            const data = diagnosisData(result);

            expect(data.selection.valid).toBe(false);
            expect(issueCodes(data)).toContain('selection-stale');
            expect(data.valid).toBe(true);
        }
    });

    it('reports hidden solids as viewport-only info', async () => {
        const model: CadModel = {
            ...cadModel({ solidCount: 1, faceCount: 6, triangleCount: 60, warnings: [] }),
            manifest: manifestFor(1)
        };
        const { stateManager } = createStateManager({
            model,
            solidSummaries: [SUMMARIES[0]],
            hiddenSolidIds: [1]
        });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = diagnosisData(result);

        expect(data.hiddenSolidIds).toEqual([1]);
        expect(data.issues).toContainEqual(
            expect.objectContaining({
                severity: 'info',
                code: 'hidden-solids',
                category: 'viewport',
                message: '1 solid(s) are hidden in the viewport; hidden solids are still exported.'
            })
        );
        expect(data.valid).toBe(true);
    });

    it('reports solids without triangles and solids with non-positive volume', async () => {
        const summaries: SolidSummary[] = [
            { solidId: 1, faceCount: 6, edgeCount: 12, triangleCount: 0, properties: { volume: 2 } },
            { solidId: 2, faceCount: 4, edgeCount: 4, triangleCount: 20, properties: { volume: 0 } },
            { solidId: 3, faceCount: 4, edgeCount: 4, triangleCount: 10, properties: { volume: -1 } }
        ];
        const model: CadModel = {
            ...cadModel({ solidCount: 3, faceCount: 14, triangleCount: 30, warnings: [] }),
            manifest: manifestFor(3)
        };
        const { stateManager } = createStateManager({ model, solidSummaries: summaries });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = diagnosisData(result);

        expect(issueCodes(data)).not.toContain('no-triangles');
        expect(data.issues).toContainEqual(
            expect.objectContaining({
                severity: 'warning',
                code: 'solid-no-triangles',
                category: 'tessellation',
                message: 'Solid 1 has no tessellation triangles.'
            })
        );
        expect(data.issues.filter((issue) => issue.code === 'solid-zero-volume').map((issue) => issue.message)).toEqual([
            'Solid 2 has non-positive volume (0).',
            'Solid 3 has non-positive volume (-1).'
        ]);
        expect(data.valid).toBe(true);
    });

    it('caps findings at 20 issues and replaces the tail with a truncation marker', async () => {
        const warnings = Array.from({ length: 25 }, (_, index) => `warning ${index + 1}`);
        const model: CadModel = {
            ...cadModel({ solidCount: 1, faceCount: 6, triangleCount: 60, warnings }),
            manifest: manifestFor(1)
        };
        const { stateManager } = createStateManager({ model, solidSummaries: [SUMMARIES[0]] });
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        const result = await capability.invoke({}, CONTEXT);
        const data = diagnosisData(result);

        expect(data.issues).toHaveLength(20);
        expect(data.issues.slice(0, 19).every((issue) => issue.code === 'build-warning')).toBe(true);
        expect(data.issues[19]).toEqual({
            severity: 'info',
            code: 'findings-truncated',
            category: 'diagnostics',
            message: '6 additional finding(s) were omitted from this diagnosis.',
            suggestion: 'Fix the highest-severity findings and run the diagnosis again.'
        });
        expect(data.valid).toBe(true);
    });

    it('returns ok: false when diagnosing without an active model', async () => {
        const { stateManager } = createStateManager();
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        expect(await capability.invoke({}, CONTEXT)).toEqual({
            ok: false,
            message: 'No CAD document is active.'
        });
    });

    it('enables diagnoseModel only while a model is active', () => {
        const { stateManager, setModel } = createStateManager();
        const { service } = createService();
        const capability = register(new NukeCadCapabilities(stateManager, service, createFileService())).get('nuke.cad.diagnoseModel')!;

        expect(capability.when!(CONTEXT)).toBe(false);

        setModel(cadModel());
        expect(capability.when!(CONTEXT)).toBe(true);

        setModel(undefined);
        expect(capability.when!(CONTEXT)).toBe(false);
    });

    it('publishes the active CAD document as capability context', async () => {
        const { stateManager } = createStateManager({ model: cadModel() });
        const contribution = new NukeCadContextContribution(stateManager);

        expect(await contribution.getContext()).toEqual({ activeCadDocument: DOCUMENT_PATH });
        expect(contribution.onDidChangeContext).toBe(stateManager.onModelChange);
    });
});
