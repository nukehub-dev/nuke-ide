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
vi.mock('@theia/filesystem/lib/browser/file-dialog', () => ({ FileDialogService: Symbol('FileDialogService') }));

import { URI } from '@theia/core/lib/common/uri';
import type { CommandService } from '@theia/core/lib/common/command';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type { NukeCapability, NukeCapabilityContext, NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeCadDocument } from '../../common/cad-document';
import type { ResolvedComponentParameter } from '../../common/component-templates';
import type { GeometryBuildResult } from '../../common/nuke-cad-protocol';
import { CadDocumentStore } from '../document/cad-document-store';
import type { CadDocumentSaveOptions, CadDocumentSaveResult } from '../document/cad-document-save-service';
import type { NukeCadPreferences } from '../nuke-cad-preferences';
import type { NukeCadFrontendService } from '../nuke-cad-frontend-service';
import type { NukeCadSketchEditService } from '../sketch/sketch-edit-service';
import type { SketchEditRequest } from '../sketch/sketch-edit-types';
import { AI_AUTHORING_PREFERENCE } from './nuke-cad-authoring-constants';
import { NukeCadCreationProposalService } from './nuke-cad-creation-proposals';
import {
    CREATE_DOCUMENT_FROM_TEMPLATE_ID,
    LIST_DOCUMENT_TEMPLATES_ID,
    NukeCadCreationCapabilities,
    PREPARE_DOCUMENT_CREATION_ID
} from './nuke-cad-creation-capabilities';
import * as path from 'path';

const WORKSPACE = '/workspace/project';
const TARGET = `${WORKSPACE}/pincells/pwr.nuke-cad`;

interface HarnessOptions {
    enabled?: boolean;
    solidCount?: number;
    solveFails?: boolean;
    saveFails?: boolean;
}

function createHarness(options: HarnessOptions = {}): {
    capabilities: NukeCadCreationCapabilities;
    store: CadDocumentStore;
    files: Map<string, string>;
    directories: Set<string>;
    proposals: NukeCadCreationProposalService;
    undoEntries: NukeUndoEntry[];
    buildDocument: ReturnType<typeof vi.fn>;
    invoke(id: string, input?: unknown): Promise<NukeCapabilityResult>;
    capability(id: string): NukeCapability;
} {
    const files = new Map<string, string>();
    const directories = new Set<string>([
        WORKSPACE,
        `${WORKSPACE}/pincells`,
        `${WORKSPACE}/.nuke-ide`,
        `${WORKSPACE}/.nuke-ide/ai`,
        `${WORKSPACE}/.nuke-ide/ai/cad-previews`
    ]);
    const store = new CadDocumentStore();
    const undoEntries: NukeUndoEntry[] = [];
    const proposals = new NukeCadCreationProposalService();

    const fileService = {
        create: vi.fn(async (uri: URI, content: string) => {
            files.set(uri.path.toString(), content);
            directories.add(path.dirname(uri.path.toString()));
        }),
        createFolder: vi.fn(async (uri: URI) => {
            directories.add(uri.path.toString());
        }),
        delete: vi.fn(async (uri: URI, deleteOptions?: { recursive?: boolean }) => {
            const target = uri.path.toString();
            for (const key of [...files.keys()]) {
                if (key === target || (deleteOptions?.recursive === true && key.startsWith(`${target}/`))) {
                    files.delete(key);
                }
            }
            for (const key of [...directories]) {
                if (key === target || (deleteOptions?.recursive === true && key.startsWith(`${target}/`))) {
                    directories.delete(key);
                }
            }
        }),
        exists: vi.fn(async (uri: URI) => files.has(uri.path.toString()) || directories.has(uri.path.toString())),
        resolve: vi.fn(async (uri: URI) => {
            const target = uri.path.toString();
            if (files.has(target)) {
                return { resource: uri, name: path.basename(target), isFile: true, isDirectory: false, isSymbolicLink: false } as FileStat;
            }
            if (directories.has(target)) {
                return { resource: uri, name: path.basename(target), isFile: false, isDirectory: true, isSymbolicLink: false } as FileStat;
            }
            throw new Error(`File not found: ${target}`);
        }),
        readFile: vi.fn(async (uri: URI) => {
            const content = files.get(uri.path.toString());
            if (content === undefined) {
                throw new Error(`File not found: ${uri.path.toString()}`);
            }
            return { value: { toString: () => content, buffer: new TextEncoder().encode(content).buffer } };
        })
    };

    const buildDocument = vi.fn(
        async () =>
            ({ success: true, solidCount: options.solidCount ?? 3, faceCount: 60, triangleCount: 120, warnings: [] }) as GeometryBuildResult
    );
    const frontend = { buildDocument, cancelJob: vi.fn(async () => undefined) };

    const preferences = { get: vi.fn((key: string) => (key === AI_AUTHORING_PREFERENCE ? (options.enabled ?? true) : undefined)) };

    const sketchEditService = {
        prepare: vi.fn(async (document: NukeCadDocument, requests: readonly SketchEditRequest[]) => {
            if (options.solveFails === true) {
                return { ok: false as const, code: 'solver-failed' as const, message: 'solver failed' };
            }
            const after = JSON.parse(JSON.stringify(document)) as NukeCadDocument;
            for (const request of requests) {
                if ('parameterName' in request) {
                    after.parameters[request.parameterName] = request.value;
                }
            }
            return { ok: true as const, result: { afterDocument: after } };
        })
    };

    const saveService = {
        async save(saveOptions: CadDocumentSaveOptions = {}): Promise<CadDocumentSaveResult> {
            const target = saveOptions.targetPath;
            const json = store.toJson();
            if (options.saveFails === true) {
                return { ok: false, reason: 'error', message: 'disk full' };
            }
            if (target === undefined || json === undefined) {
                return { ok: false, reason: 'no-document' };
            }
            files.set(target, json);
            directories.add(path.dirname(target));
            store.setUri(new URI(target).toString());
            store.markSaved();
            return { ok: true, uri: new URI(target).toString(), path: target };
        }
    };

    const undoService = {
        register: vi.fn((entry: NukeUndoEntry) => {
            undoEntries.push(entry);
            return `undo-${undoEntries.length}`;
        }),
        has: vi.fn(() => true),
        undo: vi.fn(async () => ({ ok: true })),
        onDidChange: vi.fn()
    } as unknown as NukeUndoService;

    const fileDialog = {
        showSaveDialog: vi.fn(async () => undefined)
    };
    const commands = { executeCommand: vi.fn(async () => undefined) };

    const capabilities = new NukeCadCreationCapabilities(
        preferences as unknown as NukeCadPreferences,
        frontend as unknown as NukeCadFrontendService,
        store,
        saveService as never,
        sketchEditService as unknown as NukeCadSketchEditService,
        proposals,
        undoService,
        fileService as unknown as FileService,
        fileDialog as unknown as FileDialogService,
        commands as unknown as CommandService
    );

    const registered = new Map<string, NukeCapability>();
    capabilities.registerCapabilities({
        register: (capability: NukeCapability) => {
            registered.set(capability.id, capability);
        }
    } as never);

    const context: NukeCapabilityContext = { workspaceRoots: [WORKSPACE] };
    return {
        capabilities,
        store,
        files,
        directories,
        proposals,
        undoEntries,
        buildDocument,
        capability: (id: string) => {
            const capability = registered.get(id);
            if (capability === undefined) {
                throw new Error(`Unknown capability ${id}`);
            }
            return capability;
        },
        invoke: async (id: string, input?: unknown) => {
            const capability = registered.get(id);
            if (capability === undefined) {
                throw new Error(`Unknown capability ${id}`);
            }
            return capability.invoke(input, context);
        }
    };
}

describe('CAD creation capabilities', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('lists templates without the authoring switch', async () => {
        const harness = createHarness({ enabled: false });
        const result = await harness.invoke(LIST_DOCUMENT_TEMPLATES_ID, {});
        expect(result.ok).toBe(true);
        const data = result.data as { templates: { id: string; parameters: { name: string }[] }[] };
        expect(data.templates.map((template) => template.id)).toContain('pincell');
        const pincell = data.templates.find((template) => template.id === 'pincell');
        expect(pincell?.parameters.map((parameter) => parameter.name)).toContain('cladDiameter');
    });

    it('rejects an unknown template with the available ids', async () => {
        const harness = createHarness();
        const result = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'nope' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('pincell');
    });

    it('requires the authoring switch for creation', async () => {
        const harness = createHarness({ enabled: false });
        const result = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell' });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('AI Authoring');
    });

    it('prepares a pincell proposal without touching the active document', async () => {
        const harness = createHarness();
        const result = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, {
            templateId: 'pincell',
            parameters: { fuelRadius: 0.41, cladDiameter: 0.95 }
        });
        expect(result.ok).toBe(true);
        const data = result.data as { proposalId: string; parameters: ResolvedComponentParameter[] };
        expect(data.proposalId.length).toBeGreaterThan(0);
        expect(harness.buildDocument).toHaveBeenCalledTimes(1);
        expect(harness.store.document).toBeUndefined();
        const cladRadius = data.parameters.find((parameter) => parameter.name === 'cladRadius');
        expect(cladRadius?.value).toBeCloseTo(0.475);
        const fuelRadius = data.parameters.find((parameter) => parameter.name === 'fuelRadius');
        expect(fuelRadius?.value).toBeCloseTo(0.41);
    });

    it('fails the prepare when the solver rejects a parameter', async () => {
        const harness = createHarness({ solveFails: true });
        const result = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell', parameters: { pitch: 1.4 } });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('pitch');
        expect(harness.buildDocument).not.toHaveBeenCalled();
    });

    it('refuses to prepare without a workspace root', async () => {
        const harness = createHarness();
        const capability = harness.capability(PREPARE_DOCUMENT_CREATION_ID);
        const result = await capability.invoke({ templateId: 'pincell' }, { workspaceRoots: [] });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('workspace root');
    });

    it('rejects an existing target path', async () => {
        const harness = createHarness();
        const prepared = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell' });
        const proposalId = (prepared.data as { proposalId: string }).proposalId;
        harness.files.set(TARGET, 'existing');
        const result = await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, { proposalId, path: TARGET });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('already exists');
    });

    it('refuses to replace a dirty active document', async () => {
        const harness = createHarness();
        harness.store.createDocument('Untitled');
        harness.store.addBody('Body 1');
        const prepared = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell' });
        const proposalId = (prepared.data as { proposalId: string }).proposalId;
        const result = await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, { proposalId, path: TARGET, replaceExisting: true });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('unsaved changes');
    });

    it('requires replaceExisting for a clean active document', async () => {
        const harness = createHarness();
        harness.store.createDocument('Untitled');
        const prepared = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell' });
        const proposalId = (prepared.data as { proposalId: string }).proposalId;
        const result = await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, { proposalId, path: TARGET });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('replaceExisting');
    });

    it('creates, saves, and consumes the proposal exactly once', async () => {
        const harness = createHarness();
        const prepared = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell', parameters: { pitch: 1.4 } });
        const proposalId = (prepared.data as { proposalId: string }).proposalId;
        const result = await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, { proposalId, path: TARGET });
        expect(result.ok).toBe(true);
        expect(harness.files.has(TARGET)).toBe(true);
        expect(harness.store.uri).toBe(new URI(TARGET).toString());
        expect(harness.store.document?.parameters.pitch).toBeCloseTo(1.4);
        expect(harness.store.dirty).toBe(false);
        expect(harness.undoEntries).toHaveLength(1);
        const again = await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, { proposalId, path: `${WORKSPACE}/second.nuke-cad` });
        expect(again.ok).toBe(false);
        expect(again.message).toContain('expired');
    });

    it('undo deletes the created file and restores the previous document', async () => {
        const harness = createHarness();
        harness.store.createDocument('Previous');
        const previousJson = harness.store.toJson();
        const prepared = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell' });
        const proposalId = (prepared.data as { proposalId: string }).proposalId;
        const result = await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, { proposalId, path: TARGET, replaceExisting: true });
        expect(result.ok).toBe(true);
        const undo = harness.undoEntries[0];
        const undone = await undo.undo();
        expect(undone.ok).toBe(true);
        expect(harness.files.has(TARGET)).toBe(false);
        expect(harness.store.document?.name).toBe('Previous');
        expect(previousJson).not.toBeUndefined();
    });

    it('restores the previous document when the save fails', async () => {
        const harness = createHarness({ saveFails: true });
        harness.store.createDocument('Previous');
        const prepared = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell' });
        const proposalId = (prepared.data as { proposalId: string }).proposalId;
        const result = await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, {
            proposalId,
            path: TARGET,
            replaceExisting: true
        });
        expect(result.ok).toBe(false);
        expect(result.message).toContain('disk full');
        expect(harness.store.document?.name).toBe('Previous');
        expect(harness.files.has(TARGET)).toBe(false);
        expect(harness.undoEntries).toHaveLength(0);
    });

    it('undo keeps a file that changed after creation', async () => {
        const harness = createHarness();
        const prepared = await harness.invoke(PREPARE_DOCUMENT_CREATION_ID, { templateId: 'pincell' });
        const proposalId = (prepared.data as { proposalId: string }).proposalId;
        await harness.invoke(CREATE_DOCUMENT_FROM_TEMPLATE_ID, { proposalId, path: TARGET });
        harness.files.set(TARGET, '{"edited":true}');
        const undone = await harness.undoEntries[0].undo();
        expect(undone.ok).toBe(true);
        expect(harness.files.has(TARGET)).toBe(true);
        expect(undone.message).toContain('kept');
    });
});
