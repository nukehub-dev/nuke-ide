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

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));

import { URI } from '@theia/core/lib/common/uri';
import type { CommandService } from '@theia/core/lib/common/command';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeCadDocument, SketchDef } from '../../common/cad-document';
import type { GeometryBuildResult, RegionManifestData } from '../../common/nuke-cad-protocol';
import type { CadDocumentStore } from '../document/cad-document-store';
import type { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import type { NukeCadPreferences } from '../nuke-cad-preferences';
import type { CadModel, NukeCadStateManager } from '../state/nuke-cad-state-manager';
import {
    APPLY_FEATURE_CHANGE_ID,
    APPLY_SKETCH_CHANGE_ID,
    LIST_SKETCH_DIMENSIONS_ID,
    NukeCadAuthoringCapabilities,
    PREVIEW_FEATURE_CHANGE_ID,
    PREVIEW_SKETCH_CHANGE_ID,
    readFeatureParamChanges,
    readSketchEditRequests
} from './nuke-cad-authoring-capabilities';
import { isSketchProposal, NukeCadProposalService } from './nuke-cad-proposal-service';
import type { NukeCadGhostPreviewService } from '../preview/nuke-cad-ghost-preview-service';
import type { NukeCadSketchEditService } from '../sketch/sketch-edit-service';
import type { PreparedSketchEdit, SketchEditPrepareResult, SketchEditRequest } from '../sketch/sketch-edit-types';

const WORKSPACE = '/workspace/project';
const DOCUMENT_PATH = `${WORKSPACE}/pincell.nuke-cad`;
const CONTEXT: NukeCapabilityContext = { workspaceRoots: [WORKSPACE], activeCadDocument: DOCUMENT_PATH };

const MANIFEST: RegionManifestData = {
    version: 1,
    volumes: [{ selector: 'fuel' }, { selector: 'clad' }],
    surfaces: []
};

const BUILD_RESULT: GeometryBuildResult = {
    success: true,
    solidCount: 2,
    faceCount: 12,
    triangleCount: 100,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    selectorMap: { fuel: [1], clad: [2] },
    regionManifest: MANIFEST,
    featureResults: [
        { featureId: 'pad-1', status: 'built' },
        { featureId: 'fillet-1', status: 'built' }
    ]
};

/** Minimal parsed tessellation used to exercise ghost publication. */
const PARSED_TESS = {
    version: 1,
    tolerance: 0,
    boundingBox: { min: [0, 0, 0], max: [10, 10, 10] },
    solids: [],
    faces: [],
    edges: [],
    curves: []
};

const SKETCH: SketchDef = {
    id: 'sketch-1',
    name: 'fuel-sketch',
    datumId: 'datum-xy',
    primitives: [],
    constraints: [{ id: 'constraint-1', type: 'radius' }],
    dimensions: [{ id: 'dim-1', constraintId: 'constraint-1', kind: 'radius', targetIds: ['circle-1'], driving: true, value: 0.4 }]
};

function createDocument(): NukeCadDocument {
    return {
        version: 3,
        name: 'pincell',
        units: 'mm',
        bodies: [{ id: 'body-1', name: 'Body 1', label: 'fuel' }],
        features: [
            {
                id: 'pad-1',
                name: 'Pad',
                type: 'pad',
                body: 'body-1',
                sketchId: 'sketch-1',
                params: { length: 100, end: 'blind' },
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'fillet-1',
                name: 'Fillet',
                type: 'fillet',
                body: 'body-1',
                params: { radius: 1, edges: [{ kind: 'edge', solidId: 1, edgeId: 1 }] },
                suppressed: false,
                dependsOn: ['pad-1']
            }
        ],
        sketches: [JSON.parse(JSON.stringify(SKETCH)) as SketchDef],
        curves: [],
        datums: [],
        parameters: { fuelRadius: 0.4 },
        drawings: undefined
    } as unknown as NukeCadDocument;
}

function createPreparedSketchEdit(document: NukeCadDocument): PreparedSketchEdit {
    const beforeSketch = document.sketches[0];
    const afterSketch: SketchDef = {
        ...beforeSketch,
        parameters: {},
        dimensions: (beforeSketch.dimensions ?? []).map((dimension) =>
            dimension.id === 'dim-1' ? { ...dimension, value: 0.44 } : dimension
        )
    };
    return {
        targetSketchId: 'sketch-1',
        targetSketchName: 'fuel-sketch',
        afterDocument: { ...document, sketches: [afterSketch] },
        beforeSketches: { 'sketch-1': beforeSketch },
        afterSketches: { 'sketch-1': afterSketch },
        beforeParameters: {},
        afterParameters: {},
        edits: [
            {
                kind: 'dimension',
                sketchId: 'sketch-1',
                sketchName: 'fuel-sketch',
                dimensionId: 'dim-1',
                dimensionKind: 'radius',
                before: 0.4,
                after: 0.44,
                affectedDimensionIds: ['dim-1']
            }
        ],
        changes: [
            {
                path: 'sketches.sketch-1.dimensions.dim-1',
                label: 'fuel-sketch: Radius dim-1',
                kind: 'update',
                before: 0.4,
                after: 0.44
            }
        ],
        solver: {
            status: 'converged',
            dof: 0,
            fullyConstrained: true,
            conflicting: [],
            redundant: [],
            errorCount: 0,
            warningCount: 0,
            sketches: [
                {
                    sketchId: 'sketch-1',
                    sketchName: 'fuel-sketch',
                    status: 'converged',
                    dof: 0,
                    fullyConstrained: true,
                    conflicting: [],
                    redundant: [],
                    errorCount: 0,
                    warningCount: 0
                }
            ]
        },
        affectedSketchIds: ['sketch-1'],
        affectedFeatureIds: ['pad-1']
    };
}

interface Harness {
    capabilities: NukeCadAuthoringCapabilities;
    registered: Map<string, NukeCapability>;
    proposals: NukeCadProposalService;
    edits: { id: string; params: Record<string, unknown> }[][];
    sketchEdits: { sketches: SketchDef[]; parameters: Record<string, number> }[];
    commands: string[];
    undoEntries: NukeUndoEntry[];
    fileService: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    service: { buildDocument: ReturnType<typeof vi.fn>; cancelJob: ReturnType<typeof vi.fn> };
    store: CadDocumentStore;
    preferences: { get: ReturnType<typeof vi.fn> };
    ghostPreview: { show: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
    sketchPrepare: ReturnType<typeof vi.fn>;
    bumpRevision: () => void;
    currentDocument: () => NukeCadDocument;
}

interface HarnessOptions {
    enabled?: boolean;
    build?: GeometryBuildResult;
    hasModel?: boolean;
    saved?: boolean;
    prepare?: (document: NukeCadDocument, requests: readonly SketchEditRequest[]) => Promise<SketchEditPrepareResult>;
}

function createHarness(overrides: HarnessOptions = {}): Harness {
    let document = createDocument();
    let revision = 3;
    const edits: { id: string; params: Record<string, unknown> }[][] = [];
    const sketchEdits: { sketches: SketchDef[]; parameters: Record<string, number> }[] = [];
    const undoEntries: NukeUndoEntry[] = [];
    const store = {
        get document(): NukeCadDocument {
            return document;
        },
        get uri(): string | undefined {
            return overrides.saved === false ? undefined : new URI(DOCUMENT_PATH).toString();
        },
        get documentEpoch(): number {
            return 7;
        },
        get revision(): number {
            return revision;
        },
        toJson(): string {
            return JSON.stringify(document);
        },
        updateFeatureParamsBatch(batch: readonly { id: string; params: Record<string, unknown> }[]): { success: boolean } {
            edits.push(batch.map((entry) => ({ id: entry.id, params: { ...entry.params } })));
            document = {
                ...document,
                features: document.features.map((feature) => {
                    const edit = batch.find((entry) => entry.id === feature.id);
                    return edit ? { ...feature, params: { ...feature.params, ...edit.params } } : feature;
                })
            };
            revision += 1;
            return { success: true };
        },
        applySketchAuthoringEdit(edit: { sketches: readonly SketchDef[]; parameters?: Readonly<Record<string, number>> }): {
            success: boolean;
        } {
            const sketches = edit.sketches.map((sketch) => JSON.parse(JSON.stringify(sketch)) as SketchDef);
            const parameters = { ...(edit.parameters ?? {}) };
            for (const sketch of sketches) {
                Object.assign(parameters, sketch.parameters ?? {});
            }
            sketchEdits.push({ sketches, parameters });
            document = {
                ...document,
                sketches: document.sketches.map((sketch) => {
                    const replacement = sketches.find((entry) => entry.id === sketch.id);
                    return replacement ? { ...replacement, parameters: undefined } : sketch;
                }),
                parameters: { ...document.parameters, ...parameters }
            };
            revision += 1;
            return { success: true };
        }
    } as unknown as CadDocumentStore;
    const model =
        overrides.hasModel === false
            ? undefined
            : ({
                  scriptPath: DOCUMENT_PATH,
                  result: BUILD_RESULT,
                  manifest: MANIFEST
              } as CadModel);
    const stateManager = { model, scriptPath: DOCUMENT_PATH, solidSummaries: [] } as unknown as NukeCadStateManager;
    const service = {
        buildDocument: vi.fn(async () => overrides.build ?? BUILD_RESULT),
        cancelJob: vi.fn(async () => true)
    };
    const fileService = {
        create: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined)
    };
    const preferences = { get: vi.fn(() => overrides.enabled ?? true) };
    const commands: string[] = [];
    const commandService = {
        executeCommand: vi.fn(async (id: string) => {
            commands.push(id);
        })
    } as unknown as Pick<CommandService, 'executeCommand'>;
    const undoService = {
        register: vi.fn((entry: NukeUndoEntry) => {
            undoEntries.push(entry);
            return 'undo-token-1';
        }),
        has: vi.fn(() => true),
        undo: vi.fn(async () => ({ ok: true }))
    } as unknown as NukeUndoService;
    const ghostPreview = {
        show: vi.fn(),
        clear: vi.fn(),
        state: undefined,
        onDidChange: vi.fn()
    };
    const proposals = new NukeCadProposalService();
    const sketchPrepare = vi.fn(
        overrides.prepare ??
            (async (doc: NukeCadDocument): Promise<SketchEditPrepareResult> => ({ ok: true, result: createPreparedSketchEdit(doc) }))
    );
    const sketchEditService = { prepare: sketchPrepare } as unknown as NukeCadSketchEditService;
    const capabilities = new NukeCadAuthoringCapabilities(
        stateManager,
        service as unknown as NukeCadFrontendService,
        store,
        proposals,
        fileService as unknown as FileService,
        preferences as unknown as NukeCadPreferences,
        commandService as unknown as CommandService,
        undoService,
        ghostPreview as unknown as NukeCadGhostPreviewService,
        sketchEditService
    );
    const registered = new Map<string, NukeCapability>();
    capabilities.registerCapabilities({
        register: (capability: NukeCapability) => registered.set(capability.id, capability)
    } as unknown as NukeCapabilityRegistry);
    return {
        capabilities,
        registered,
        proposals,
        edits,
        sketchEdits,
        commands,
        undoEntries,
        fileService,
        service,
        store,
        preferences,
        ghostPreview,
        sketchPrepare,
        bumpRevision: () => {
            revision += 1;
        },
        currentDocument: () => document
    };
}

async function preview(harness: Harness): Promise<NukeCapabilityResult> {
    return harness.registered
        .get(PREVIEW_FEATURE_CHANGE_ID)!
        .invoke({ changes: [{ featureId: 'pad-1', param: 'length', value: 120 }] }, CONTEXT);
}

function apply(harness: Harness, proposalId: string): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_FEATURE_CHANGE_ID)!.invoke({ proposalId }, CONTEXT);
}

const SKETCH_REQUEST: readonly SketchEditRequest[] = [{ sketchId: 'sketch-1', dimensionId: 'dim-1', value: 0.44 }];

function previewSketch(harness: Harness, input: unknown = { changes: SKETCH_REQUEST }): Promise<NukeCapabilityResult> {
    return harness.registered.get(PREVIEW_SKETCH_CHANGE_ID)!.invoke(input, CONTEXT);
}

function applySketch(harness: Harness, proposalId: string): Promise<NukeCapabilityResult> {
    return harness.registered.get(APPLY_SKETCH_CHANGE_ID)!.invoke({ proposalId }, CONTEXT);
}

async function previewedSketchProposal(harness: Harness): Promise<string> {
    const result = await previewSketch(harness);
    expect(result.ok).toBe(true);
    return (result.data as { proposalId: string }).proposalId;
}

describe('readFeatureParamChanges', () => {
    it('accepts the expanded topology-preserving parameter set', () => {
        const result = readFeatureParamChanges({
            changes: [
                { featureId: 'chamfer1', param: 'distance', value: 1.5 },
                { featureId: 'draft1', param: 'angle', value: 5 },
                { featureId: 'pattern1', param: 'spacing', value: -4 },
                { featureId: 'pattern2', param: 'angle', value: 180 },
                { featureId: 'hole1', param: 'diameter', value: 2.5 },
                { featureId: 'hole1', param: 'depth', value: 3 }
            ]
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.changes).toHaveLength(6);
        }
    });

    it('rejects an unknown parameter', () => {
        const result = readFeatureParamChanges({ changes: [{ featureId: 'pad1', param: 'width', value: 2 }] });
        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Unsupported') });
    });
});

describe('readSketchEditRequests', () => {
    it('accepts exactly one dimension or parameter target per edit', () => {
        const result = readSketchEditRequests({
            changes: [
                { sketchId: 'sketch-1', dimensionId: 'dim-1', value: 0.44 },
                { sketchId: 'sketch-1', parameterName: 'fuelRadius', value: 0.5 }
            ]
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.changes).toEqual([
                { sketchId: 'sketch-1', dimensionId: 'dim-1', value: 0.44 },
                { sketchId: 'sketch-1', parameterName: 'fuelRadius', value: 0.5 }
            ]);
        }
    });

    it('rejects ambiguous, empty, and non-finite edits', () => {
        expect(
            readSketchEditRequests({
                changes: [{ sketchId: 'sketch-1', dimensionId: 'dim-1', parameterName: 'fuelRadius', value: 0.44 }]
            })
        ).toMatchObject({ ok: false, message: expect.stringContaining('exactly one') });
        expect(readSketchEditRequests({ changes: [{ sketchId: 'sketch-1', value: 0.44 }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('exactly one')
        });
        expect(readSketchEditRequests({ changes: [{ sketchId: '', dimensionId: 'dim-1', value: 0.44 }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('sketchId')
        });
        expect(readSketchEditRequests({ changes: [{ sketchId: 'sketch-1', dimensionId: 'dim-1', value: Number.NaN }] })).toMatchObject({
            ok: false,
            message: expect.stringContaining('finite')
        });
        const tooMany = Array.from({ length: 9 }, (_, index) => ({ sketchId: 'sketch-1', dimensionId: `dim-${index}`, value: 1 }));
        expect(readSketchEditRequests({ changes: tooMany })).toMatchObject({
            ok: false,
            message: expect.stringContaining('at most 8')
        });
    });
});

describe('NukeCadAuthoringCapabilities', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('hides both tools while the kill switch is off', async () => {
        const harness = createHarness({ enabled: false });
        const previewCapability = harness.registered.get(PREVIEW_FEATURE_CHANGE_ID)!;
        const applyCapability = harness.registered.get(APPLY_FEATURE_CHANGE_ID)!;

        expect(previewCapability.when!(CONTEXT)).toBe(false);
        expect(applyCapability.when!(CONTEXT)).toBe(false);
        expect(await preview(harness)).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
    });

    it('previews a scalar edit with a real build and a temporary candidate', async () => {
        const harness = createHarness();
        const result = await preview(harness);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            title: 'CAD feature change',
            applyCapability: APPLY_FEATURE_CHANGE_ID
        });
        expect(result.data).toMatchObject({
            summary: 'pad-1 length: 100 → 120',
            impact: { solids: { before: 2, after: 2 } }
        });
        const request = harness.service.buildDocument.mock.calls[0][0];
        expect(request).toMatchObject({
            useCache: false,
            timeoutSeconds: 120,
            outputDirectory: expect.stringContaining('.nuke-ide/ai/cad-previews'),
            scriptPath: expect.stringMatching(/\.nuke-ai-preview-.*\.nuke-cad$/)
        });
        expect(request.jobId).toMatch(/^cad-ai-preview-/);
        expect(harness.fileService.create).toHaveBeenCalledTimes(1);
        expect(harness.fileService.delete).toHaveBeenCalledWith(expect.any(URI), { recursive: true, useTrash: false });
        expect(harness.fileService.delete).toHaveBeenCalledTimes(3);
        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        expect(proposal.scope).toBe('features');
        if (proposal.scope !== 'features') {
            throw new Error('expected a feature proposal');
        }
        expect(proposal.before['pad-1']).toMatchObject({ length: 100 });
        expect(proposal.after['pad-1']).toMatchObject({ length: 120 });
        expect(harness.edits).toHaveLength(0);
    });

    it('rejects a change the pure engine does not allow and never builds', async () => {
        const harness = createHarness();
        const result = await harness.registered
            .get(PREVIEW_FEATURE_CHANGE_ID)!
            .invoke({ changes: [{ featureId: 'pad-1', param: 'radius', value: 2 }] }, CONTEXT);
        expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/not 'radius'|Unsupported/) });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.proposals.get('anything')).toBeUndefined();
    });

    it('rejects a failed preview build and cleans up', async () => {
        const harness = createHarness({ build: { ...BUILD_RESULT, success: false, error: 'build failed' } });
        const result = await preview(harness);
        expect(result).toMatchObject({ ok: false, message: 'build failed' });
        expect(harness.proposals.get('anything')).toBeUndefined();
        expect(harness.fileService.delete).toHaveBeenCalledTimes(3);
    });

    it('rejects a document that changed while the preview build was running', async () => {
        const harness = createHarness();
        harness.service.buildDocument.mockImplementation(async () => {
            harness.bumpRevision();
            return BUILD_RESULT;
        });
        expect(await preview(harness)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed while')
        });
        expect(harness.proposals.get('anything')).toBeUndefined();
    });

    it('rejects a topology or selector-map change', async () => {
        const count = createHarness({ build: { ...BUILD_RESULT, solidCount: 3 } });
        expect(await preview(count)).toMatchObject({ ok: false, message: expect.stringContaining('solid count') });
        expect(count.proposals.get('anything')).toBeUndefined();

        const selector = createHarness({ build: { ...BUILD_RESULT, selectorMap: { fuel: [1] } } });
        expect(await preview(selector)).toMatchObject({ ok: false, message: expect.stringContaining('selector map') });

        const noTessellation = createHarness({ build: { ...BUILD_RESULT, triangleCount: 0 } });
        expect(await preview(noTessellation)).toMatchObject({ ok: false, message: expect.stringContaining('no tessellation') });

        const badBox = createHarness({ build: { ...BUILD_RESULT, boundingBox: { min: [1, 1, 1], max: [1, 1, 1] } } });
        expect(await preview(badBox)).toMatchObject({ ok: false, message: expect.stringContaining('bounding box') });
    });

    it('applies a previewed change, schedules the rebuild, and registers undo', async () => {
        const harness = createHarness();
        const previewResult = await preview(harness);
        const proposalId = (previewResult.data as { proposalId: string }).proposalId;

        const result = await apply(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({ id: proposalId, title: 'CAD feature change' });
        expect(result.changeSet).not.toHaveProperty('applyCapability');
        expect(result.undoToken).toBe('undo-token-1');
        expect(harness.edits).toEqual([[{ id: 'pad-1', params: expect.objectContaining({ length: 120 }) }]]);
        expect(harness.commands).toContain('nuke.cad.rebuild');
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
    });

    it('rejects a stale proposal after the document revision changes', async () => {
        const harness = createHarness();
        const previewResult = await preview(harness);
        const proposalId = (previewResult.data as { proposalId: string }).proposalId;
        harness.bumpRevision();
        expect(await apply(harness, proposalId)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(harness.edits).toHaveLength(0);
    });

    it('restores the before params through the undo entry', async () => {
        const harness = createHarness();
        const previewResult = await preview(harness);
        const proposalId = (previewResult.data as { proposalId: string }).proposalId;
        await apply(harness, proposalId);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true, message: 'CAD change undone.' });
        expect(harness.edits).toHaveLength(2);
        expect(harness.edits[1]).toEqual([{ id: 'pad-1', params: expect.objectContaining({ length: 100 }) }]);
        expect(harness.commands.filter((command) => command === 'nuke.cad.rebuild')).toHaveLength(2);
    });

    it('rejects a missing proposal', async () => {
        const harness = createHarness();
        expect(await apply(harness, 'missing')).toMatchObject({ ok: false, message: expect.stringContaining('expired') });
        expect(harness.edits).toHaveLength(0);
    });

    it('lists sketch dimensions without the authoring preference', async () => {
        const harness = createHarness({ enabled: false });
        const capability = harness.registered.get(LIST_SKETCH_DIMENSIONS_ID)!;

        expect(capability.when!(CONTEXT)).toBe(true);
        const result = await capability.invoke({}, CONTEXT);

        expect(result.ok).toBe(true);
        expect(result.data).toMatchObject({
            documentPath: DOCUMENT_PATH,
            parameters: { fuelRadius: 0.4 },
            sketches: [
                {
                    id: 'sketch-1',
                    name: 'fuel-sketch',
                    datumId: 'datum-xy',
                    consumedByFeatureIds: ['pad-1'],
                    dimensions: [{ id: 'dim-1', kind: 'radius', driving: true, value: 0.4 }]
                }
            ]
        });
    });

    it('hides sketch preview while the kill switch is off and rejects unsaved or unbuilt documents', async () => {
        const disabled = createHarness({ enabled: false });
        expect(disabled.registered.get(PREVIEW_SKETCH_CHANGE_ID)!.when!(CONTEXT)).toBe(false);
        expect(await previewSketch(disabled)).toMatchObject({ ok: false, message: expect.stringContaining('disabled') });
        expect(disabled.sketchPrepare).not.toHaveBeenCalled();

        const unsaved = createHarness({ saved: false });
        expect(await previewSketch(unsaved)).toMatchObject({ ok: false, message: expect.stringContaining('Open a saved') });
        expect(unsaved.sketchPrepare).not.toHaveBeenCalled();

        const noModel = createHarness({ hasModel: false });
        expect(await previewSketch(noModel)).toMatchObject({ ok: false, message: expect.stringContaining('Open a saved') });
        expect(noModel.sketchPrepare).not.toHaveBeenCalled();
    });

    it('returns the planner error without building', async () => {
        const harness = createHarness({
            prepare: async () => ({ ok: false, code: 'dimension-not-found', message: "Dimension 'dim-9' not found" })
        });
        expect(await previewSketch(harness)).toMatchObject({ ok: false, message: "Dimension 'dim-9' not found" });
        expect(harness.service.buildDocument).not.toHaveBeenCalled();
        expect(harness.proposals.list()).toHaveLength(0);
    });

    it('previews a sketch edit with a real build and a sketch proposal', async () => {
        const harness = createHarness();
        vi.spyOn(
            harness.capabilities as unknown as { readCandidateTessellation: () => Promise<typeof PARSED_TESS> },
            'readCandidateTessellation'
        ).mockResolvedValue(PARSED_TESS);

        const result = await previewSketch(harness);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            title: 'CAD sketch dimension change',
            applyCapability: APPLY_SKETCH_CHANGE_ID
        });
        expect(result.data).toMatchObject({
            summary: 'Change sketch fuel-sketch: dim-1 radius 0.4 → 0.44',
            impact: { solids: { before: 2, after: 2 } },
            sketch: { targetSketchId: 'sketch-1', affectedFeatureIds: ['pad-1'] }
        });
        expect(harness.sketchPrepare).toHaveBeenCalledTimes(1);
        expect(harness.sketchPrepare.mock.calls[0][1]).toEqual(SKETCH_REQUEST);
        const request = harness.service.buildDocument.mock.calls[0][0];
        expect(request).toMatchObject({
            useCache: false,
            timeoutSeconds: 120,
            outputDirectory: expect.stringContaining('.nuke-ide/ai/cad-previews'),
            scriptPath: expect.stringMatching(/\.nuke-ai-preview-.*\.nuke-cad$/)
        });
        expect(request.jobId).toMatch(/^cad-ai-preview-/);
        expect(harness.fileService.create).toHaveBeenCalledTimes(1);
        expect(harness.fileService.delete).toHaveBeenCalledTimes(3);
        expect(harness.ghostPreview.show).toHaveBeenCalledTimes(1);
        expect(harness.commands).toContain('nuke.cad.openReviewPanel');

        const proposal = harness.proposals.get((result.data as { proposalId: string }).proposalId)!;
        if (!isSketchProposal(proposal)) {
            throw new Error('expected a sketch proposal');
        }
        expect(proposal.scope).toBe('sketch');
        expect(proposal.applyCapability).toBe(APPLY_SKETCH_CHANGE_ID);
        expect(proposal.sketch.targetSketchName).toBe('fuel-sketch');
        expect(proposal.sketch.beforeSketches['sketch-1']?.dimensions?.[0].value).toBe(0.4);
        expect(proposal.sketch.afterSketches['sketch-1']?.dimensions?.[0].value).toBe(0.44);
        expect(proposal.sketch.affectedFeatureIds).toEqual(['pad-1']);
        expect(proposal.sketch.solver.status).toBe('converged');
        expect(harness.sketchEdits).toHaveLength(0);
    });

    it('rejects a sketch preview that changes topology or arrives stale', async () => {
        const count = createHarness({ build: { ...BUILD_RESULT, solidCount: 3 } });
        expect(await previewSketch(count)).toMatchObject({ ok: false, message: expect.stringContaining('solid count') });
        expect(count.proposals.list()).toHaveLength(0);

        const selector = createHarness({ build: { ...BUILD_RESULT, selectorMap: { fuel: [1] } } });
        expect(await previewSketch(selector)).toMatchObject({ ok: false, message: expect.stringContaining('selector map') });
        expect(selector.proposals.list()).toHaveLength(0);

        const drift = createHarness();
        drift.service.buildDocument.mockImplementation(async () => {
            drift.bumpRevision();
            return BUILD_RESULT;
        });
        expect(await previewSketch(drift)).toMatchObject({ ok: false, message: expect.stringContaining('changed while') });
        expect(drift.proposals.list()).toHaveLength(0);
    });

    it('applies a sketch preview, schedules the rebuild, and registers undo', async () => {
        const harness = createHarness();
        const proposalId = await previewedSketchProposal(harness);

        const result = await applySketch(harness, proposalId);

        expect(result.ok).toBe(true);
        expect(result.changeSet).toMatchObject({
            id: proposalId,
            title: 'CAD sketch dimension change',
            applyCapability: APPLY_SKETCH_CHANGE_ID
        });
        expect(result.undoToken).toBe('undo-token-1');
        expect(result.data).toMatchObject({
            proposalId,
            documentPath: DOCUMENT_PATH,
            rebuildScheduled: true,
            affectedFeatureIds: ['pad-1'],
            backupPath: expect.stringContaining('.nuke-ai-backup-')
        });
        expect(harness.sketchEdits).toHaveLength(1);
        expect(harness.sketchEdits[0].sketches[0].dimensions?.[0].value).toBe(0.44);
        expect(harness.commands).toContain('nuke.cad.rebuild');
        expect(harness.undoEntries).toHaveLength(1);
        expect(harness.proposals.get(proposalId)).toBeUndefined();
    });

    it('rejects a stale sketch proposal after the revision, parameter, or sketch changes', async () => {
        const revision = createHarness();
        const revisionProposal = await previewedSketchProposal(revision);
        revision.bumpRevision();
        expect(await applySketch(revision, revisionProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining('changed after this preview')
        });
        expect(revision.sketchEdits).toHaveLength(0);

        const parameter = createHarness({
            prepare: async (doc) => {
                const prepared = createPreparedSketchEdit(doc);
                return { ok: true, result: { ...prepared, beforeParameters: { fuelRadius: 0.4 }, afterParameters: { fuelRadius: 0.5 } } };
            }
        });
        const parameterProposal = await previewedSketchProposal(parameter);
        parameter.currentDocument().parameters.fuelRadius = 0.6;
        expect(await applySketch(parameter, parameterProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining("Parameter 'fuelRadius' changed")
        });
        expect(parameter.sketchEdits).toHaveLength(0);

        const sketch = createHarness();
        const sketchProposal = await previewedSketchProposal(sketch);
        sketch.currentDocument().sketches[0].dimensions![0].value = 0.41;
        expect(await applySketch(sketch, sketchProposal)).toMatchObject({
            ok: false,
            message: expect.stringContaining("Sketch 'sketch-1' changed")
        });
        expect(sketch.sketchEdits).toHaveLength(0);
    });

    it('undoes a sketch change through the undo entry', async () => {
        const harness = createHarness();
        const proposalId = await previewedSketchProposal(harness);
        await applySketch(harness, proposalId);

        const result = await harness.undoEntries[0].undo();

        expect(result).toMatchObject({ ok: true, message: 'CAD sketch change undone.' });
        expect(harness.sketchEdits).toHaveLength(2);
        expect(harness.sketchEdits[1].sketches[0].dimensions?.[0].value).toBe(0.4);
        expect(harness.commands.filter((command) => command === 'nuke.cad.rebuild')).toHaveLength(2);
    });

    it('rejects a sketch proposal through the feature apply capability', async () => {
        const harness = createHarness();
        const proposalId = await previewedSketchProposal(harness);

        expect(await apply(harness, proposalId)).toMatchObject({ ok: false, message: expect.stringContaining('sketch change') });
        expect(harness.edits).toHaveLength(0);
        expect(harness.sketchEdits).toHaveLength(0);
        expect(harness.proposals.get(proposalId)).toBeDefined();
    });
});
