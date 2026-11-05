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
 * Tests the OpenMC project metadata preview/apply capabilities against a real
 * state manager and in-memory proposal/undo services: no Theia boot, no AI
 * runtime, and no backend.
 */

import { describe, expect, it, vi } from 'vitest';

// The state manager only needs the event primitives and DI tokens; mock the
// browser-only Theia imports so vitest runs in node.
vi.mock('@theia/core/lib/common', () => {
    class Emitter<T> {
        private readonly listeners: ((value: T) => void)[] = [];
        readonly event = (listener: (value: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => undefined };
        };
        fire(value: T): void {
            for (const listener of this.listeners) {
                listener(value);
            }
        }
    }
    return { Emitter, Event: class {} };
});
vi.mock('@theia/core/lib/common/message-service', () => ({ MessageService: class {} }));
vi.mock('@theia/core/lib/common/preferences', () => ({ PreferenceScope: {}, PreferenceService: class {} }));
vi.mock('@theia/workspace/lib/browser/workspace-service', () => ({ WorkspaceService: class {} }));
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));

import { Event } from '@theia/core/lib/common/event';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { OpenMCProjectMetadata } from '../../common/openmc-state-schema';
import type { OpenMCStudioBackendService } from '../../common/openmc-studio-protocol';
import { createDefaultState, OpenMCStateManager } from '../openmc-state-manager';
import { OPENMC_CHANGE_PROPOSAL_TTL_MS, OpenMCChangeProposalService } from './openmc-change-proposal-service';
import {
    APPLY_PROJECT_METADATA_CAPABILITY_ID,
    CREATE_PROJECT_CAPABILITY_ID,
    OpenMCProjectCapabilities,
    PREVIEW_PROJECT_METADATA_CAPABILITY_ID
} from './openmc-project-capabilities';

const PREVIEW = PREVIEW_PROJECT_METADATA_CAPABILITY_ID;
const APPLY = APPLY_PROJECT_METADATA_CAPABILITY_ID;

const ORIGINAL_METADATA: Partial<OpenMCProjectMetadata> = {
    name: 'Pincell',
    description: 'Demo project',
    author: 'Ada'
};

class TestProposalService extends OpenMCChangeProposalService {
    readonly clock = { now: 1_000_000 };
    protected counter = 0;

    protected override now(): number {
        return this.clock.now;
    }

    protected override createId(): string {
        this.counter += 1;
        return `proposal-${this.counter}`;
    }
}

class FakeUndoService implements NukeUndoService {
    readonly entries = new Map<string, NukeUndoEntry>();
    readonly onDidChange = Event.None;
    protected counter = 0;

    register(entry: NukeUndoEntry): string {
        this.counter += 1;
        const token = `undo-${this.counter}`;
        this.entries.set(token, entry);
        return token;
    }

    has(token: string): boolean {
        return this.entries.has(token);
    }

    async undo(token: string): Promise<NukeCapabilityResult> {
        const entry = this.entries.get(token);
        if (!entry) {
            return { ok: false, message: 'This change can no longer be undone.' };
        }
        const result = await entry.undo();
        if (result.ok) {
            this.entries.delete(token);
        }
        return result;
    }
}

class FakeBackend {
    readonly saveProject = vi.fn(async () => ({ success: true }));
}

class FakeRegistry implements NukeCapabilityRegistry {
    readonly capabilities = new Map<string, NukeCapability>();
    readonly onDidChange = Event.None;
    readonly ready = Promise.resolve();

    register(capability: NukeCapability): void {
        this.capabilities.set(capability.id, capability);
    }

    get(id: string): NukeCapability | undefined {
        return this.capabilities.get(id);
    }

    getAll(): readonly NukeCapability[] {
        return [...this.capabilities.values()];
    }

    getEnabled(context: NukeCapabilityContext): readonly NukeCapability[] {
        return this.getAll().filter((capability) => !capability.when || capability.when(context));
    }
}

interface Harness {
    stateManager: OpenMCStateManager;
    proposalService: TestProposalService;
    undoService: FakeUndoService;
    registry: FakeRegistry;
    invoke(id: string, input: unknown): Promise<NukeCapabilityResult>;
}

function createStateManager(metadata: Partial<OpenMCProjectMetadata> = ORIGINAL_METADATA): OpenMCStateManager {
    const manager = new OpenMCStateManager();
    const state = createDefaultState();
    state.metadata = { ...state.metadata, ...metadata };
    manager.setState(state, false);
    // Keep project-path notifications offline: the watcher helper is not under test here.
    const internals = manager as unknown as { workspaceService: { tryGetRoots(): readonly unknown[] } };
    internals.workspaceService = { tryGetRoots: () => [] };
    return manager;
}

function createHarness(): Harness {
    const stateManager = createStateManager();
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCProjectCapabilities(
        stateManager,
        new FakeBackend() as unknown as OpenMCStudioBackendService,
        {} as unknown as FileService,
        proposalService,
        undoService
    );
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        proposalService,
        undoService,
        registry,
        invoke: (id, input) => {
            const capability = registry.get(id);
            if (!capability) {
                throw new Error(`Missing capability ${id}`);
            }
            return capability.invoke(input, { workspaceRoots: [] });
        }
    };
}

/** Preview a metadata change and return its proposal id. */
async function preview(harness: Harness, updates: Record<string, unknown>, summary?: string): Promise<string> {
    const result = await harness.invoke(PREVIEW, summary === undefined ? { updates } : { updates, summary });
    if (!result.ok) {
        throw new Error(`Preview failed: ${result.message}`);
    }
    return (result.data as { proposalId: string }).proposalId;
}

describe('OpenMC project metadata capabilities', () => {
    it('declares a read preview and a confirmed, undoable write apply', () => {
        const harness = createHarness();
        expect(harness.registry.get(CREATE_PROJECT_CAPABILITY_ID)).toBeDefined();

        const previewCapability = harness.registry.get(PREVIEW)!;
        expect(previewCapability.id).toBe('nuke.openmc.previewProjectMetadata');
        expect(previewCapability.title).toBe('Preview OpenMC project metadata change');
        expect(previewCapability.category).toEqual(['OpenMC', 'Project']);
        expect(previewCapability.risk).toBe('read');
        expect(previewCapability.annotations).toEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        });
        expect(previewCapability.inputSchema.required).toEqual(['updates']);
        expect(previewCapability.inputSchema.additionalProperties).toBe(false);
        expect(Object.keys(previewCapability.inputSchema.properties).sort()).toEqual(['summary', 'updates']);
        expect(previewCapability.inputSchema.properties.updates.additionalProperties).toBe(false);
        expect(Object.keys(previewCapability.inputSchema.properties.updates.properties ?? {}).sort()).toEqual([
            'author',
            'description',
            'name'
        ]);

        const applyCapability = harness.registry.get(APPLY)!;
        expect(applyCapability.id).toBe('nuke.openmc.applyProjectMetadata');
        expect(applyCapability.title).toBe('Apply OpenMC project metadata change');
        expect(applyCapability.category).toEqual(['OpenMC', 'Project']);
        expect(applyCapability.risk).toBe('write');
        expect(applyCapability.annotations).toEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false
        });
        expect(applyCapability.requiresConfirmation).toBe(true);
        expect(applyCapability.undoable).toBe(true);
        expect(applyCapability.inputSchema.required).toEqual(['proposalId']);
    });

    it('rejects unknown and read-only metadata fields', async () => {
        const harness = createHarness();

        const readOnly = await harness.invoke(PREVIEW, { updates: { version: '2.0.0' } });
        expect(readOnly.ok).toBe(false);
        expect(readOnly.message).toContain('"version" is read-only');

        const unknown = await harness.invoke(PREVIEW, { updates: { title: 'Pincell' } });
        expect(unknown.ok).toBe(false);
        expect(unknown.message).toContain('Unknown project metadata field "title"');

        expect(harness.proposalService.get('proposal-1')).toBeUndefined();
    });

    it('rejects a missing, empty, or non-object updates map', async () => {
        const harness = createHarness();
        const missing = 'Provide an updates object with name, description, or author.';

        expect(await harness.invoke(PREVIEW, {})).toEqual({ ok: false, message: missing });
        expect(await harness.invoke(PREVIEW, { updates: {} })).toEqual({
            ok: false,
            message: 'Provide at least one project metadata field to change.'
        });
        expect(await harness.invoke(PREVIEW, { updates: [] })).toEqual({ ok: false, message: missing });
        expect(await harness.invoke(PREVIEW, { updates: null })).toEqual({ ok: false, message: missing });
    });

    it('rejects an empty or whitespace-only project name', async () => {
        const harness = createHarness();

        expect(await harness.invoke(PREVIEW, { updates: { name: '   ' } })).toEqual({
            ok: false,
            message: 'Project name must not be empty.'
        });
    });

    it('rejects over-length name, description, and author values', async () => {
        const harness = createHarness();
        const cases: Array<{ updates: Record<string, unknown>; message: string }> = [
            { updates: { name: 'a'.repeat(121) }, message: 'Project name must be 120 characters or fewer.' },
            { updates: { description: 'a'.repeat(501) }, message: 'Project description must be 500 characters or fewer.' },
            { updates: { author: 'a'.repeat(121) }, message: 'Project author must be 120 characters or fewer.' }
        ];

        for (const testCase of cases) {
            expect(await harness.invoke(PREVIEW, { updates: testCase.updates })).toEqual({
                ok: false,
                message: testCase.message
            });
        }
    });

    it('rejects control characters in name, author, and description', async () => {
        const harness = createHarness();
        const cases = [
            { updates: { name: 'Bad\u0001Name' }, message: 'Project name must not contain control characters.' },
            { updates: { author: 'Ada\u0000' }, message: 'Project author must not contain control characters.' },
            { updates: { description: 'Line\u0001Break' }, message: 'Project description must not contain control characters.' }
        ];

        for (const testCase of cases) {
            expect(await harness.invoke(PREVIEW, { updates: testCase.updates })).toEqual({
                ok: false,
                message: testCase.message
            });
        }
    });

    it('keeps line breaks and tabs in a description', async () => {
        const harness = createHarness();

        const result = await harness.invoke(PREVIEW, { updates: { description: 'First line\n\tSecond line' } });

        expect(result.ok).toBe(true);
        expect((result.data as { changes: { after: string }[] }).changes[0].after).toBe('First line\n\tSecond line');
    });

    it('rejects non-string metadata values', async () => {
        const harness = createHarness();

        expect(await harness.invoke(PREVIEW, { updates: { name: 42 } })).toEqual({
            ok: false,
            message: 'Project name must be a string.'
        });
    });

    it('rejects a no-op field even when another field changes', async () => {
        const harness = createHarness();

        expect(await harness.invoke(PREVIEW, { updates: { name: 'Pincell', author: 'Grace' } })).toEqual({
            ok: false,
            message: 'Project name already has that value.'
        });
    });

    it('rejects unknown top-level input keys', async () => {
        const harness = createHarness();

        const result = await harness.invoke(PREVIEW, { updates: { name: 'Assembly' }, force: true });

        expect(result).toEqual({ ok: false, message: 'Unknown input field "force". Provide updates and an optional summary.' });
    });

    it('stores a project-scoped proposal with per-field rows and no state write', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState().metadata;

        const result = await harness.invoke(PREVIEW, {
            updates: { name: '  Assembly  ', description: '', author: 'Grace' },
            summary: '  Retitle project  '
        });

        expect(result.ok).toBe(true);
        const data = result.data as { proposalId: string; summary: string; changes: unknown[] };
        expect(data.summary).toBe('Retitle project');
        expect(data.changes).toEqual([
            { path: 'metadata.name', label: 'Project name', kind: 'update', before: 'Pincell', after: 'Assembly' },
            { path: 'metadata.description', label: 'Project description', kind: 'update', before: 'Demo project', after: '' },
            { path: 'metadata.author', label: 'Project author', kind: 'update', before: 'Ada', after: 'Grace' }
        ]);
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC project metadata change',
            summary: 'Retitle project',
            changes: data.changes,
            applyCapability: APPLY
        });

        const proposal = harness.proposalService.get(data.proposalId)!;
        expect(proposal.scope).toBe('project');
        expect(proposal.before).toEqual(before);
        expect(proposal.after).toEqual({ ...before, name: 'Assembly', description: '', author: 'Grace' });

        expect(harness.stateManager.getState().metadata).toEqual(before);
        expect(harness.stateManager.isDirty).toBe(false);
    });

    it('derives a default summary from the changed field', async () => {
        const harness = createHarness();

        const result = await harness.invoke(PREVIEW, { updates: { author: 'Grace' } });

        expect((result.data as { summary: string }).summary).toBe('Update project author.');
    });

    it('rejects a missing or expired proposal', async () => {
        const harness = createHarness();
        const missing = 'This project metadata preview is missing or has expired. Preview again.';

        expect(await harness.invoke(APPLY, { proposalId: 'missing' })).toEqual({ ok: false, message: missing });

        const proposalId = await preview(harness, { name: 'Assembly' });
        harness.proposalService.clock.now += OPENMC_CHANGE_PROPOSAL_TTL_MS;

        expect(await harness.invoke(APPLY, { proposalId })).toEqual({ ok: false, message: missing });
    });

    it('rejects a proposal from another scope', async () => {
        const harness = createHarness();
        const proposal = harness.proposalService.create({
            scope: 'settings',
            summary: 'Batches',
            changes: [{ path: 'run.batches', label: 'Batches', kind: 'update', before: 10, after: 20 }],
            before: {},
            after: {}
        });

        const result = await harness.invoke(APPLY, { proposalId: proposal.id });

        expect(result.ok).toBe(false);
        expect(result.message).toBe(`Proposal ${proposal.id} is for settings, not project metadata.`);
    });

    it('rejects stale metadata', async () => {
        const harness = createHarness();
        const proposalId = await preview(harness, { name: 'Assembly' });
        harness.stateManager.updateMetadata({ author: 'Grace' });

        expect(await harness.invoke(APPLY, { proposalId })).toEqual({
            ok: false,
            message: 'Project metadata changed since the preview. Preview again.'
        });
        expect(harness.stateManager.getState().metadata.name).toBe('Pincell');
        expect(harness.proposalService.has(proposalId)).toBe(true);
    });

    it('applies only the requested fields with one metadata update', async () => {
        const harness = createHarness();
        const proposalId = await preview(harness, { name: 'Assembly', author: 'Grace' });
        const before = harness.stateManager.getState().metadata;
        const updateMetadata = vi.spyOn(harness.stateManager, 'updateMetadata');

        const result = await harness.invoke(APPLY, { proposalId });

        expect(result.ok).toBe(true);
        expect(updateMetadata).toHaveBeenCalledTimes(1);
        expect(updateMetadata).toHaveBeenCalledWith({ name: 'Assembly', author: 'Grace' });

        const after = harness.stateManager.getState().metadata;
        expect(after.name).toBe('Assembly');
        expect(after.author).toBe('Grace');
        expect(after.description).toBe(before.description);
        expect(after.version).toBe(before.version);
        expect(after.created).toBe(before.created);

        expect(harness.proposalService.has(proposalId)).toBe(false);
        expect(result.undoToken).toBe('undo-1');
        expect(result.changeSet?.applyCapability).toBeUndefined();
        expect(result.changeSet?.changes).toEqual((result.data as { changes: unknown[] }).changes);
    });

    it('undo restores the changed fields and keeps unrelated metadata', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState().metadata;
        const proposalId = await preview(harness, { name: 'Assembly', description: '', author: 'Grace' });
        const applied = await harness.invoke(APPLY, { proposalId });

        const undone = await harness.undoService.undo(applied.undoToken!);

        expect(undone).toEqual({ ok: true, message: 'Project metadata change undone.' });
        const restored = harness.stateManager.getState().metadata;
        expect(restored.name).toBe(before.name);
        expect(restored.description).toBe(before.description);
        expect(restored.author).toBe(before.author);
        expect(restored.version).toBe(before.version);
        expect(restored.created).toBe(before.created);
        expect(harness.undoService.has(applied.undoToken!)).toBe(false);
    });

    it('undo fails after a later manual metadata edit', async () => {
        const harness = createHarness();
        const proposalId = await preview(harness, { name: 'Assembly' });
        const applied = await harness.invoke(APPLY, { proposalId });
        harness.stateManager.updateMetadata({ name: 'Other' });

        const undone = await harness.undoService.undo(applied.undoToken!);

        expect(undone).toEqual({
            ok: false,
            message: 'Project metadata changed since the edit; the change can no longer be undone.'
        });
        expect(harness.stateManager.getState().metadata.name).toBe('Other');
        expect(harness.undoService.has(applied.undoToken!)).toBe(true);
    });
});
