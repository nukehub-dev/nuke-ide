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
import type { NukeCadDocument } from '../../common/cad-document';
import type { GeometryBuildResult, RegionManifestData } from '../../common/nuke-cad-protocol';
import type { CadDocumentStore } from '../document/cad-document-store';
import type { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import type { NukeCadPreferences } from '../nuke-cad-preferences';
import type { CadModel, NukeCadStateManager } from '../state/nuke-cad-state-manager';
import {
    APPLY_FEATURE_CHANGE_ID,
    NukeCadAuthoringCapabilities,
    PREVIEW_FEATURE_CHANGE_ID,
    readFeatureParamChanges
} from './nuke-cad-authoring-capabilities';
import { NukeCadProposalService } from './nuke-cad-proposal-service';

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
        sketches: [],
        curves: [],
        datums: [],
        parameters: {},
        drawings: undefined
    } as unknown as NukeCadDocument;
}

interface Harness {
    capabilities: NukeCadAuthoringCapabilities;
    registered: Map<string, NukeCapability>;
    proposals: NukeCadProposalService;
    edits: { id: string; params: Record<string, unknown> }[][];
    commands: string[];
    undoEntries: NukeUndoEntry[];
    fileService: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    service: { buildDocument: ReturnType<typeof vi.fn>; cancelJob: ReturnType<typeof vi.fn> };
    store: CadDocumentStore;
    preferences: { get: ReturnType<typeof vi.fn> };
    bumpRevision: () => void;
    currentDocument: () => NukeCadDocument;
}

function createHarness(overrides: { enabled?: boolean; build?: GeometryBuildResult } = {}): Harness {
    let document = createDocument();
    let revision = 3;
    const edits: { id: string; params: Record<string, unknown> }[][] = [];
    const undoEntries: NukeUndoEntry[] = [];
    const store = {
        get document(): NukeCadDocument {
            return document;
        },
        get uri(): string {
            return new URI(DOCUMENT_PATH).toString();
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
        }
    } as unknown as CadDocumentStore;
    const model = {
        scriptPath: DOCUMENT_PATH,
        result: BUILD_RESULT,
        manifest: MANIFEST
    } as CadModel;
    const stateManager = { model, scriptPath: DOCUMENT_PATH } as unknown as NukeCadStateManager;
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
    const proposals = new NukeCadProposalService();
    const capabilities = new NukeCadAuthoringCapabilities(
        stateManager,
        service as unknown as NukeCadFrontendService,
        store,
        proposals,
        fileService as unknown as FileService,
        preferences as unknown as NukeCadPreferences,
        commandService as unknown as CommandService,
        undoService
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
        commands,
        undoEntries,
        fileService,
        service,
        store,
        preferences,
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
        expect(harness.commands).toEqual(['nuke.cad.rebuild']);
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
        expect(harness.commands).toEqual(['nuke.cad.rebuild', 'nuke.cad.rebuild']);
    });

    it('rejects a missing proposal', async () => {
        const harness = createHarness();
        expect(await apply(harness, 'missing')).toMatchObject({ ok: false, message: expect.stringContaining('expired') });
        expect(harness.edits).toHaveLength(0);
    });
});
