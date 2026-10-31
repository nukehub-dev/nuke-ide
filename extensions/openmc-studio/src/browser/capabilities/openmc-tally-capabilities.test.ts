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
 * Tests the tally preview, apply, and undo capabilities against fake state and
 * undo services: no Theia boot, no OpenMC process, and no AI runtime.
 */

import { describe, expect, it, vi } from 'vitest';
import { Event } from '@theia/core/lib/common/event';

// Keep the suite in the Node environment: the state manager pulls in browser DOM modules.
vi.mock('../openmc-state-manager', () => ({ OpenMCStateManager: class OpenMCStateManager {} }));

import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type { OpenMCState, OpenMCTally } from '../../common/openmc-state-schema';
import type { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposalService } from './openmc-change-proposal-service';
import { cloneTallies, tallyEquals } from './openmc-tally-edit';
import { OpenMCTallyCapabilities } from './openmc-tally-capabilities';

const WORKSPACE = '/workspace';

function buildTallies(): OpenMCTally[] {
    return [
        {
            id: 1,
            name: 'flux-cube',
            scores: ['flux'],
            nuclides: ['total'],
            filters: [{ type: 'cell', bins: [1, 2] }],
            estimator: 'tracklength',
            multiplyDensity: false,
            triggers: [{ type: 'rel_err', threshold: 0.05 }],
            derivative: { id: 7, variable: 'density', materialId: 1 }
        },
        {
            id: 4,
            scores: ['fission'],
            nuclides: ['U235'],
            filters: [{ type: 'energy', bins: [0, 20_000_000] }]
        }
    ];
}

function buildState(tallies: OpenMCTally[] = buildTallies()): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: '1.1.0', name: 'Pincell', description: 'Demo project', created: now, modified: now },
        geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
        materials: [],
        settings: { run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 }, sources: [] },
        tallies,
        meshes: []
    };
}

class FakeStateManager {
    readonly updates: Array<{ id: number; updates: Partial<OpenMCTally> }> = [];
    readonly added: OpenMCTally[] = [];
    readonly removed: number[] = [];

    constructor(public state: OpenMCState) {}

    getState(): OpenMCState {
        return JSON.parse(JSON.stringify(this.state));
    }

    getNextTallyId(): number {
        const ids = this.state.tallies.map((tally) => tally.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    addTally(tally: OpenMCTally): void {
        this.added.push(tally);
        this.state.tallies.push(tally);
    }

    updateTally(id: number, updates: Partial<OpenMCTally>): void {
        this.updates.push({ id, updates });
        const index = this.state.tallies.findIndex((tally) => tally.id === id);
        if (index >= 0) {
            this.state.tallies[index] = { ...this.state.tallies[index], ...updates };
        }
    }

    removeTally(id: number): void {
        this.removed.push(id);
        const index = this.state.tallies.findIndex((tally) => tally.id === id);
        if (index >= 0) {
            this.state.tallies.splice(index, 1);
        }
    }
}

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

interface TallyChangeData {
    proposalId: string;
    summary: string;
    changes: Array<{ path: string; label: string; kind: string; before?: unknown; after?: unknown }>;
}

interface Harness {
    stateManager: FakeStateManager;
    proposalService: TestProposalService;
    undoService: FakeUndoService;
    registry: FakeRegistry;
    invoke(id: string, input: unknown): Promise<NukeCapabilityResult>;
}

function createHarness(tallies: OpenMCTally[] = buildTallies()): Harness {
    const stateManager = new FakeStateManager(buildState(tallies));
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCTallyCapabilities(stateManager as unknown as OpenMCStateManager, proposalService, undoService);
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
            return capability.invoke(input, { workspaceRoots: [WORKSPACE] });
        }
    };
}

describe('OpenMC tally capabilities', () => {
    it('previews update, add, and remove diffs without mutating state', async () => {
        const harness = createHarness();
        const original = cloneTallies(harness.stateManager.state.tallies);

        const result = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [
                { action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'] } },
                { action: 'add', tally: { name: 'fission-rate', scores: ['fission'], filters: [{ type: 'cell', bins: [1] }] } },
                { action: 'remove', tallyId: 4 }
            ],
            summary: 'Refine tallies'
        });

        expect(result.ok).toBe(true);
        const data = result.data as TallyChangeData;
        expect(data.summary).toBe('Refine tallies');
        expect(data.changes.map((change) => [change.path, change.kind])).toEqual([
            ['tallies.1.scores', 'update'],
            ['tallies.5', 'add'],
            ['tallies.4', 'remove']
        ]);
        expect(data.changes[0]).toMatchObject({ before: ['flux'], after: ['flux', 'heating'] });
        expect(data.changes[1].after).toMatchObject({ id: 5, name: 'fission-rate', scores: ['fission'] });
        expect(data.changes[2].before).toEqual(original[1]);
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC tally change',
            summary: 'Refine tallies',
            changes: data.changes,
            applyCapability: 'nuke.openmc.applyTallyChange'
        });
        expect(result.nextActions).toEqual([
            { capability: 'nuke.openmc.applyTallyChange', reason: 'Apply the previewed tally change after confirmation.' }
        ]);

        const proposal = harness.proposalService.get(data.proposalId)!;
        expect(proposal.scope).toBe('tallies');
        expect(proposal.before).toEqual(original);
        expect((proposal.after as OpenMCTally[]).map((tally) => tally.id)).toEqual([1, 5]);
        expect((proposal.after as OpenMCTally[])[0]).toMatchObject({
            filters: [{ type: 'cell', bins: [1, 2] }],
            triggers: [{ type: 'rel_err', threshold: 0.05 }],
            derivative: { id: 7, variable: 'density', materialId: 1 }
        });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.stateManager.added).toEqual([]);
        expect(harness.stateManager.removed).toEqual([]);
        expect(harness.stateManager.state.tallies).toEqual(original);
    });

    it('assigns add ids from getNextTallyId and applies add defaults', async () => {
        const harness = createHarness();
        const nextId = vi.spyOn(harness.stateManager, 'getNextTallyId').mockReturnValue(10);

        const result = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [
                { action: 'add', tally: { scores: ['flux'] } },
                { action: 'add', tally: { scores: ['heating'], higherMoments: true } }
            ]
        });

        expect(result.ok).toBe(true);
        expect(nextId).toHaveBeenCalledTimes(1);
        const data = result.data as TallyChangeData;
        expect(data.summary).toBe('Apply 2 OpenMC tally edits (2 add).');
        expect(data.changes.map((change) => change.path)).toEqual(['tallies.10', 'tallies.11']);
        const proposal = harness.proposalService.get(data.proposalId)!;
        expect((proposal.after as OpenMCTally[]).slice(2)).toEqual([
            { id: 10, scores: ['flux'], nuclides: ['total'], filters: [] },
            { id: 11, scores: ['heating'], nuclides: ['total'], filters: [], higherMoments: true }
        ]);
    });

    it('applies a preview with grouped updates, one add, and one remove', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [
                { action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'], estimator: 'analog' } },
                { action: 'add', tally: { name: 'fission-rate', scores: ['fission'] } },
                { action: 'remove', tallyId: 4 }
            ],
            summary: 'Refine tallies'
        });
        const data = preview.data as TallyChangeData;

        const result = await harness.invoke('nuke.openmc.applyTallyChange', { proposalId: data.proposalId });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ proposalId: data.proposalId, summary: 'Refine tallies', changes: data.changes });
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC tally change',
            summary: 'Refine tallies',
            changes: data.changes
        });
        expect('applyCapability' in result.changeSet!).toBe(false);
        expect(result.undoToken).toBe('undo-1');
        expect(harness.undoService.has('undo-1')).toBe(true);
        expect(result.nextActions).toEqual([
            { capability: 'nuke.openmc.diagnoseProject', reason: 'Check the project after applying the tally change.' }
        ]);
        expect(harness.stateManager.updates).toHaveLength(1);
        expect(harness.stateManager.updates[0]).toEqual({
            id: 1,
            updates: { scores: ['flux', 'heating'], estimator: 'analog' }
        });
        expect(harness.stateManager.added.map((tally) => tally.id)).toEqual([5]);
        expect(harness.stateManager.removed).toEqual([4]);
        expect(harness.stateManager.state.tallies.map((tally) => tally.id)).toEqual([1, 5]);
        expect(harness.proposalService.get(data.proposalId)).toBeUndefined();
    });

    it('preserves filters, triggers, and derivatives when updating a tally', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'update', tallyId: 1, updates: { multiplyDensity: true, higherMoments: true } }]
        });
        const data = preview.data as TallyChangeData;

        const result = await harness.invoke('nuke.openmc.applyTallyChange', { proposalId: data.proposalId });

        expect(result.ok).toBe(true);
        const tally = harness.stateManager.state.tallies[0];
        expect(tally.multiplyDensity).toBe(true);
        expect(tally.higherMoments).toBe(true);
        expect(tally.filters).toEqual([{ type: 'cell', bins: [1, 2] }]);
        expect(tally.triggers).toEqual([{ type: 'rel_err', threshold: 0.05 }]);
        expect(tally.derivative).toEqual({ id: 7, variable: 'density', materialId: 1 });
    });

    it('preserves an unrelated tally added after the preview', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'] } }]
        });
        const proposalId = (preview.data as TallyChangeData).proposalId;
        harness.stateManager.addTally({ id: 9, scores: ['absorption'], nuclides: ['total'], filters: [] });

        const result = await harness.invoke('nuke.openmc.applyTallyChange', { proposalId });

        expect(result.ok).toBe(true);
        expect(harness.stateManager.state.tallies.map((tally) => tally.id)).toEqual([1, 4, 9]);
        expect(harness.stateManager.state.tallies[0].scores).toEqual(['flux', 'heating']);
        expect(harness.stateManager.state.tallies[2].scores).toEqual(['absorption']);
    });

    it('rejects a stale update without writing or consuming the proposal', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'] } }]
        });
        const proposalId = (preview.data as TallyChangeData).proposalId;
        harness.stateManager.state.tallies[0].scores = ['fission'];

        const result = await harness.invoke('nuke.openmc.applyTallyChange', { proposalId });

        expect(result).toEqual({ ok: false, message: 'Tally 1 changed since the preview. Preview again.' });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.stateManager.state.tallies[0].scores).toEqual(['fission']);
        expect(harness.proposalService.get(proposalId)).toBeDefined();
    });

    it('rejects an add whose assigned id or name is now used', async () => {
        const idHarness = createHarness();
        const idPreview = await idHarness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'add', tally: { name: 'new-tally', scores: ['flux'] } }]
        });
        idHarness.stateManager.addTally({ id: 5, name: 'other', scores: ['flux'], nuclides: ['total'], filters: [] });
        const idResult = await idHarness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (idPreview.data as TallyChangeData).proposalId
        });
        expect(idResult.ok).toBe(false);
        expect(idResult.message).toContain('Tally 5 already exists');
        expect(idHarness.stateManager.added).toHaveLength(1);
        expect(idHarness.stateManager.updates).toEqual([]);

        const nameHarness = createHarness();
        const namePreview = await nameHarness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'add', tally: { name: 'new-tally', scores: ['flux'] } }]
        });
        nameHarness.stateManager.addTally({ id: 9, name: 'new-tally', scores: ['flux'], nuclides: ['total'], filters: [] });
        const nameResult = await nameHarness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (namePreview.data as TallyChangeData).proposalId
        });
        expect(nameResult.ok).toBe(false);
        expect(nameResult.message).toContain('A tally named "new-tally" already exists');
        expect(nameHarness.stateManager.added).toHaveLength(1);
    });

    it('rejects a remove whose tally is missing or changed', async () => {
        const missingHarness = createHarness();
        const missingPreview = await missingHarness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'remove', tallyId: 4 }]
        });
        missingHarness.stateManager.removeTally(4);
        const missing = await missingHarness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (missingPreview.data as TallyChangeData).proposalId
        });
        expect(missing).toEqual({ ok: false, message: 'Tally 4 no longer exists. Preview again.' });
        expect(missingHarness.stateManager.removed).toEqual([4]);

        const staleHarness = createHarness();
        const stalePreview = await staleHarness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'remove', tallyId: 4 }]
        });
        staleHarness.stateManager.state.tallies[1].scores = ['absorption'];
        const stale = await staleHarness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (stalePreview.data as TallyChangeData).proposalId
        });
        expect(stale).toEqual({ ok: false, message: 'Tally 4 changed since the preview. Preview again.' });
        expect(staleHarness.stateManager.removed).toEqual([]);
    });

    it('rejects missing, malformed, expired, and wrong-scope proposals', async () => {
        const harness = createHarness();

        expect(await harness.invoke('nuke.openmc.applyTallyChange', { proposalId: 'missing' })).toEqual({
            ok: false,
            message: 'This tally preview is missing or has expired. Preview again.'
        });
        expect((await harness.invoke('nuke.openmc.applyTallyChange', {})).message).toContain('proposalId');

        const expiredPreview = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'remove', tallyId: 4 }]
        });
        harness.proposalService.clock.now += 10 * 60 * 1000;
        const expired = await harness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (expiredPreview.data as TallyChangeData).proposalId
        });
        expect(expired.message).toContain('missing or has expired');

        const foreign = harness.proposalService.create({
            scope: 'materials',
            summary: 'Swap materials',
            changes: [{ path: 'materials', label: 'Materials', kind: 'update', before: [], after: [] }],
            before: [],
            after: []
        });
        const wrongScope = await harness.invoke('nuke.openmc.applyTallyChange', { proposalId: foreign.id });

        expect(wrongScope).toEqual({ ok: false, message: `Proposal ${foreign.id} is for materials, not tallies.` });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.proposalService.get(foreign.id)).toBeDefined();
    });

    it('undo reverses update, add, and remove actions in reverse order', async () => {
        const harness = createHarness();
        const original = cloneTallies(harness.stateManager.state.tallies);
        const preview = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [
                { action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'] } },
                { action: 'add', tally: { name: 'fission-rate', scores: ['fission'] } },
                { action: 'remove', tallyId: 4 }
            ]
        });
        const applied = await harness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (preview.data as TallyChangeData).proposalId
        });
        const token = applied.undoToken!;

        const result = await harness.undoService.undo(token);

        expect(result).toEqual({ ok: true, message: 'Tally change undone.' });
        expect(harness.undoService.has(token)).toBe(false);
        expect(harness.stateManager.state.tallies.map((tally) => tally.id)).toEqual([1, 4]);
        expect(tallyEquals(harness.stateManager.state.tallies[0], original[0])).toBe(true);
        expect(tallyEquals(harness.stateManager.state.tallies[1], original[1])).toBe(true);
    });

    it('rejects a stale undo and keeps the token', async () => {
        const updateHarness = createHarness();
        const updatePreview = await updateHarness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'] } }]
        });
        const updateApplied = await updateHarness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (updatePreview.data as TallyChangeData).proposalId
        });
        updateHarness.stateManager.state.tallies[0].scores = ['absorption'];
        const updateUndo = await updateHarness.undoService.undo(updateApplied.undoToken!);
        expect(updateUndo.ok).toBe(false);
        expect(updateUndo.message).toContain('can no longer be undone');
        expect(updateHarness.stateManager.state.tallies[0].scores).toEqual(['absorption']);
        expect(updateHarness.undoService.has(updateApplied.undoToken!)).toBe(true);

        const addHarness = createHarness();
        const addPreview = await addHarness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'add', tally: { name: 'fission-rate', scores: ['fission'] } }]
        });
        const addApplied = await addHarness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (addPreview.data as TallyChangeData).proposalId
        });
        addHarness.stateManager.state.tallies[2].scores = ['absorption'];
        const addUndo = await addHarness.undoService.undo(addApplied.undoToken!);
        expect(addUndo.ok).toBe(false);
        expect(addUndo.message).toContain('can no longer be undone');
        expect(addHarness.stateManager.state.tallies).toHaveLength(3);
        expect(addHarness.undoService.has(addApplied.undoToken!)).toBe(true);

        const removeHarness = createHarness();
        const removePreview = await removeHarness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'remove', tallyId: 4 }]
        });
        const removeApplied = await removeHarness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (removePreview.data as TallyChangeData).proposalId
        });
        removeHarness.stateManager.addTally({ id: 4, scores: ['absorption'], nuclides: ['total'], filters: [] });
        const removeUndo = await removeHarness.undoService.undo(removeApplied.undoToken!);
        expect(removeUndo.ok).toBe(false);
        expect(removeUndo.message).toContain('is in use; the change can no longer be undone');
        expect(removeHarness.undoService.has(removeApplied.undoToken!)).toBe(true);
    });

    it('undo preserves unrelated tallies and unrelated fields', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewTallyChange', {
            actions: [{ action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'] } }]
        });
        const applied = await harness.invoke('nuke.openmc.applyTallyChange', {
            proposalId: (preview.data as TallyChangeData).proposalId
        });
        harness.stateManager.addTally({ id: 9, scores: ['absorption'], nuclides: ['total'], filters: [] });
        harness.stateManager.state.tallies[0].triggers = [{ type: 'variance', threshold: 0.1 }];

        const result = await harness.undoService.undo(applied.undoToken!);

        expect(result).toEqual({ ok: true, message: 'Tally change undone.' });
        expect(harness.stateManager.state.tallies.map((tally) => tally.id)).toEqual([1, 4, 9]);
        expect(harness.stateManager.state.tallies[0].scores).toEqual(['flux']);
        expect(harness.stateManager.state.tallies[0].triggers).toEqual([{ type: 'variance', threshold: 0.1 }]);
        expect(harness.stateManager.state.tallies[2].scores).toEqual(['absorption']);
    });

    it('declares read/write risk, confirmation, undo, annotations, and schemas', () => {
        const harness = createHarness();
        const preview = harness.registry.capabilities.get('nuke.openmc.previewTallyChange')!;
        const apply = harness.registry.capabilities.get('nuke.openmc.applyTallyChange')!;

        expect(preview.id).toBe('nuke.openmc.previewTallyChange');
        expect(preview.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(preview.risk).toBe('read');
        expect(preview.requiresConfirmation).toBeUndefined();
        expect(preview.undoable).toBeUndefined();
        expect(preview.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(preview.inputSchema).toMatchObject({
            type: 'object',
            required: ['actions'],
            additionalProperties: false
        });
        expect(preview.inputSchema.properties.actions.items!.oneOf).toHaveLength(3);
        expect(preview.inputSchema.properties.actions.maxItems).toBe(20);
        expect(preview.outputSchema?.required).toEqual(['proposalId', 'summary', 'changes']);

        expect(apply.id).toBe('nuke.openmc.applyTallyChange');
        expect(apply.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(apply.risk).toBe('write');
        expect(apply.requiresConfirmation).toBe(true);
        expect(apply.undoable).toBe(true);
        expect(apply.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        expect(apply.inputSchema).toEqual({
            type: 'object',
            properties: {
                proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewTallyChange.' }
            },
            required: ['proposalId'],
            additionalProperties: false
        });
        expect(apply.outputSchema?.type).toBe('object');
    });

    it('rejects invalid preview requests without mutating state', async () => {
        const harness = createHarness();
        const original = cloneTallies(harness.stateManager.state.tallies);
        const cases: Array<{ input: unknown; message: string }> = [
            { input: { actions: [] }, message: 'between 1 and 20' },
            { input: { actions: 'nope' }, message: 'Provide an actions array' },
            {
                input: {
                    actions: Array.from({ length: 21 }, (_, index) => ({
                        action: 'add',
                        tally: { scores: ['flux'], name: `tally-${index}` }
                    }))
                },
                message: 'between 1 and 20'
            },
            {
                input: { actions: [{ action: 'update', tallyId: 1, updates: { scores: ['not-a-score'] } }] },
                message: 'not an OpenMC catalog score'
            },
            {
                input: { actions: [{ action: 'add', tally: { scores: ['flux'], filters: [{ type: 'bogus', bins: [1] }] } }] },
                message: 'unknown tally filter type'
            },
            {
                input: { actions: [{ action: 'add', tally: { scores: ['flux'], name: 'flux-cube' } }] },
                message: 'already used by another tally'
            },
            {
                input: { actions: [{ action: 'add', tally: { id: 9, scores: ['flux'] } }] },
                message: 'cannot set an id'
            },
            {
                input: { actions: [{ action: 'update', tallyId: 1, updates: { scores: ['flux'] } }] },
                message: 'already has the requested values'
            },
            {
                input: { actions: [{ action: 'update', tallyId: 1, updates: { filters: [] } }] },
                message: 'filters, triggers, and derivatives are preserved'
            },
            { input: { actions: [{ action: 'remove' }] }, message: 'needs a positive integer tallyId' }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke('nuke.openmc.previewTallyChange', testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.stateManager.added).toEqual([]);
        expect(harness.stateManager.removed).toEqual([]);
        expect(harness.stateManager.state.tallies).toEqual(original);
    });
});
