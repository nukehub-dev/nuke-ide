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
 * Tests the OpenMC DAGMC preview/apply/undo capabilities against a fake
 * backend and the real state manager: no Theia boot, no OpenMC process, and
 * no .h5m writes.
 */

import { describe, expect, it, vi } from 'vitest';
import { Event } from '@theia/core/lib/common/event';

// The state manager pulls in browser DOM modules; keep the suite in Node.
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

import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import { validateCapability, validateCapabilityInput } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import type { DAGMCInfo, DAGMCVolume, OpenMCMaterial, OpenMCState } from '../../common/openmc-state-schema';
import type { OpenMCStudioBackendService } from '../../common/openmc-studio-protocol';
import { createDefaultState, OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposalService } from './openmc-change-proposal-service';
import {
    APPLY_DAGMC_CAPABILITY_ID,
    MAX_DAGMC_ACTIONS,
    OpenMCDagmcCapabilities,
    PREVIEW_DAGMC_CAPABILITY_ID
} from './openmc-dagmc-capabilities';

const WORKSPACE = '/workspace';
const DAGMC_FILE = '/workspace/model.h5m';

function buildMaterials(): OpenMCMaterial[] {
    return [
        {
            id: 1,
            name: 'Water',
            density: 1,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
            thermalScattering: []
        },
        {
            id: 2,
            name: 'Fuel',
            density: 10.4,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'U235', fraction: 1, fractionType: 'ao' }],
            thermalScattering: []
        },
        {
            id: 3,
            name: 'Graphite',
            density: 1.6,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'C0', fraction: 1, fractionType: 'ao' }],
            thermalScattering: []
        }
    ];
}

function buildVolume(id: number, material: string): DAGMCVolume {
    return {
        id,
        material,
        numTriangles: 12 * id,
        boundingBox: { min: [0, 0, 0], max: [id, id, id] }
    };
}

function buildInfo(): DAGMCInfo {
    return {
        filePath: DAGMC_FILE,
        fileName: 'model.h5m',
        volumeCount: 3,
        surfaceCount: 4,
        vertices: 8,
        materials: {},
        volumes: [buildVolume(1, 'Water'), buildVolume(2, 'Fuel'), buildVolume(3, 'mat:graveyard')],
        boundingBox: { min: [0, 0, 0], max: [3, 3, 3] },
        autoGeomIds: false,
        autoMatIds: false
    };
}

function buildState(): OpenMCState {
    const state = createDefaultState();
    state.materials = buildMaterials();
    state.settings.dagmcFile = DAGMC_FILE;
    state.settings.dagmcInfo = buildInfo();
    return state;
}

class FakeBackend {
    readonly calls: Array<{ filePath: string; volumeId: number; material: string }> = [];
    readonly failures = new Map<number, string>();

    async dagmcAssignMaterial(filePath: string, volumeId: number, material: string): Promise<{ success: boolean; error?: string }> {
        this.calls.push({ filePath, volumeId, material });
        const failure = this.failures.get(volumeId);
        return failure ? { success: false, error: failure } : { success: true };
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

interface DagmcChangeData {
    proposalId: string;
    summary: string;
    changes: Array<{ path: string; label: string; kind: string; before?: unknown; after?: unknown }>;
}

interface Harness {
    stateManager: OpenMCStateManager;
    backend: FakeBackend;
    proposalService: TestProposalService;
    undoService: FakeUndoService;
    registry: FakeRegistry;
    invoke(id: string, input: unknown): Promise<NukeCapabilityResult>;
}

function createHarness(state: OpenMCState = buildState()): Harness {
    const stateManager = new OpenMCStateManager();
    stateManager.setState(state, false);
    const backend = new FakeBackend();
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCDagmcCapabilities(
        stateManager,
        backend as unknown as OpenMCStudioBackendService,
        proposalService,
        undoService
    );
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        backend,
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

describe('OpenMC DAGMC capabilities', () => {
    it('rejects previews and applies when no DAGMC model is loaded', async () => {
        const state = buildState();
        delete state.settings.dagmcFile;
        delete state.settings.dagmcInfo;
        const harness = createHarness(state);

        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'assign', volumeId: 1, material: 'Fuel' }]
        });
        expect(preview).toEqual({ ok: false, message: 'No DAGMC model is loaded. Import a .h5m first.' });

        const proposal = harness.proposalService.create({
            scope: 'dagmc',
            summary: 'Assign',
            changes: [
                {
                    path: 'settings.dagmcInfo.volumes.1.material',
                    label: 'Volume 1 material',
                    kind: 'update',
                    before: 'Water',
                    after: 'Fuel'
                }
            ],
            before: {},
            after: {}
        });
        const applied = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, { proposalId: proposal.id });
        expect(applied).toEqual({ ok: false, message: 'No DAGMC model is loaded. Import a .h5m first.' });
        expect(harness.backend.calls).toEqual([]);
    });

    it('rejects unknown volumes, unknown materials, and duplicate assignments', async () => {
        const harness = createHarness();

        const unknownVolume = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'assign', volumeId: 99, material: 'Water' }]
        });
        expect(unknownVolume).toEqual({
            ok: false,
            message: 'Volume 99 does not exist in the loaded DAGMC model.'
        });

        const unknownMaterial = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'assign', volumeId: 1, material: 'Steel' }]
        });
        expect(unknownMaterial.ok).toBe(false);
        expect(unknownMaterial.message).toContain('Material "Steel" does not exist.');
        expect(unknownMaterial.message).toContain('Water, Fuel, Graphite');

        const duplicate = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [
                { action: 'assign', volumeId: 1, material: 'Fuel' },
                { action: 'assign', volumeId: 1, material: 'Graphite' }
            ]
        });
        expect(duplicate).toEqual({
            ok: false,
            message: 'Volume 1 is assigned more than once in one preview.'
        });
        expect(harness.proposalService.has('proposal-1')).toBe(false);
        expect(harness.backend.calls).toEqual([]);
    });

    it('rejects malformed, oversized, empty, and no-op action lists', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; message: string }> = [
            { input: { actions: 'nope' }, message: 'actions array' },
            { input: { actions: [] }, message: `between 1 and ${MAX_DAGMC_ACTIONS}` },
            {
                input: { actions: Array.from({ length: MAX_DAGMC_ACTIONS + 1 }, () => ({ action: 'setFlags', autoGeomIds: true })) },
                message: `between 1 and ${MAX_DAGMC_ACTIONS}`
            },
            { input: { actions: [{ action: 'rename', volumeId: 1 }] }, message: 'must be assign or setFlags' },
            {
                input: { actions: [{ action: 'assign', volumeId: 1, material: 'Fuel', note: 'extra' }] },
                message: 'do not accept note'
            },
            { input: { actions: [{ action: 'assign', volumeId: '1', material: 'Fuel' }] }, message: 'integer volumeId' },
            { input: { actions: [{ action: 'assign', volumeId: 1 }] }, message: 'material name' },
            { input: { actions: [{ action: 'setFlags' }] }, message: 'needs autoGeomIds' },
            { input: { actions: [{ action: 'setFlags', autoGeomIds: 'yes' }] }, message: 'must be a boolean' },
            { input: { actions: [{ action: 'assign', volumeId: 1, material: 'Water' }] }, message: 'No DAGMC change' },
            { input: { actions: [{ action: 'setFlags', autoGeomIds: false }] }, message: 'No DAGMC change' },
            {
                input: {
                    actions: [
                        { action: 'assign', volumeId: 1, material: 'Water' },
                        { action: 'setFlags', autoMatIds: false }
                    ]
                },
                message: 'No DAGMC change'
            }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.proposalService.has('proposal-1')).toBe(false);
        expect(harness.backend.calls).toEqual([]);
    });

    it('previews material and flag diffs without writing the model or state', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState();

        const result = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [
                { action: 'assign', volumeId: 2, material: 'Water' },
                { action: 'setFlags', autoMatIds: true }
            ],
            summary: 'Refill volume 2'
        });

        expect(result.ok).toBe(true);
        const data = result.data as DagmcChangeData;
        expect(data.summary).toBe('Refill volume 2');
        expect(data.changes).toEqual([
            {
                path: 'settings.dagmcInfo.volumes.2.material',
                label: 'Volume 2 material',
                kind: 'update',
                before: 'Fuel',
                after: 'Water'
            },
            {
                path: 'settings.dagmcInfo.autoMatIds',
                label: 'Auto material IDs',
                kind: 'update',
                before: false,
                after: true
            }
        ]);
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC DAGMC change',
            summary: 'Refill volume 2',
            changes: data.changes,
            applyCapability: APPLY_DAGMC_CAPABILITY_ID
        });
        expect(result.nextActions).toEqual([
            { capability: APPLY_DAGMC_CAPABILITY_ID, reason: 'Apply the previewed DAGMC change after confirmation.' }
        ]);

        const proposal = harness.proposalService.get(data.proposalId)!;
        expect(proposal.scope).toBe('dagmc');
        expect(proposal.before).toEqual({
            volumes: buildInfo().volumes,
            autoGeomIds: false,
            autoMatIds: false
        });
        const after = proposal.after as { volumes: DAGMCVolume[]; autoGeomIds?: boolean; autoMatIds?: boolean };
        expect(after.autoGeomIds).toBe(false);
        expect(after.autoMatIds).toBe(true);
        expect(after.volumes.find((volume) => volume.id === 2)?.material).toBe('Water');
        expect(after.volumes.find((volume) => volume.id === 1)?.material).toBe('Water');

        expect(harness.backend.calls).toEqual([]);
        expect(harness.stateManager.getState()).toEqual(before);
    });

    it('applies backend assignments in order and updates state', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [
                { action: 'assign', volumeId: 1, material: 'Fuel' },
                { action: 'assign', volumeId: 2, material: 'Graphite' },
                { action: 'setFlags', autoGeomIds: true }
            ]
        });
        const data = preview.data as DagmcChangeData;

        const result = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, { proposalId: data.proposalId });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ proposalId: data.proposalId, summary: data.summary, changes: data.changes });
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC DAGMC change',
            summary: data.summary,
            changes: data.changes
        });
        expect('applyCapability' in result.changeSet!).toBe(false);
        expect(result.undoToken).toBe('undo-1');
        expect(harness.undoService.has('undo-1')).toBe(true);
        expect(harness.backend.calls).toEqual([
            { filePath: DAGMC_FILE, volumeId: 1, material: 'Fuel' },
            { filePath: DAGMC_FILE, volumeId: 2, material: 'Graphite' }
        ]);

        const state = harness.stateManager.getState();
        expect(state.settings.dagmcInfo?.autoGeomIds).toBe(true);
        expect(state.settings.dagmcInfo?.autoMatIds).toBe(false);
        expect(state.settings.dagmcInfo?.volumes.find((volume) => volume.id === 1)?.material).toBe('Fuel');
        expect(state.settings.dagmcInfo?.volumes.find((volume) => volume.id === 2)?.material).toBe('Graphite');
        expect(state.settings.dagmcInfo?.volumes.find((volume) => volume.id === 3)?.material).toBe('mat:graveyard');
        expect(state.settings.dagmcInfo?.filePath).toBe(DAGMC_FILE);
        expect(harness.proposalService.get(data.proposalId)).toBeUndefined();
    });

    it('rejects a stale preview without writing the model or state', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'assign', volumeId: 2, material: 'Water' }]
        });
        const proposalId = (preview.data as DagmcChangeData).proposalId;

        const info = harness.stateManager.getState().settings.dagmcInfo!;
        info.volumes.find((volume) => volume.id === 2)!.material = 'Graphite';
        harness.stateManager.updateSettings({ dagmcInfo: info });

        const result = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, { proposalId });

        expect(result).toEqual({
            ok: false,
            message: 'DAGMC assignments changed since the preview. Preview again.'
        });
        expect(harness.backend.calls).toEqual([]);
        expect(harness.stateManager.getState().settings.dagmcInfo?.volumes[1].material).toBe('Graphite');
        expect(harness.proposalService.get(proposalId)).toBeDefined();
    });

    it('rejects a preview when an unrelated volume material changed after it was stored', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'assign', volumeId: 2, material: 'Water' }]
        });
        const proposalId = (preview.data as DagmcChangeData).proposalId;

        const info = harness.stateManager.getState().settings.dagmcInfo!;
        info.volumes.find((volume) => volume.id === 3)!.material = 'Graphite';
        harness.stateManager.updateSettings({ dagmcInfo: info });

        const result = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, { proposalId });

        expect(result).toEqual({
            ok: false,
            message: 'DAGMC assignments changed since the preview. Preview again.'
        });
        expect(harness.backend.calls).toEqual([]);
        expect(harness.stateManager.getState().settings.dagmcInfo?.volumes[1].material).toBe('Fuel');
    });

    it('rejects a preview when only a flag changed after it was stored', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'setFlags', autoGeomIds: true }]
        });
        const proposalId = (preview.data as DagmcChangeData).proposalId;

        const info = harness.stateManager.getState().settings.dagmcInfo!;
        info.autoGeomIds = true;
        harness.stateManager.updateSettings({ dagmcInfo: info });

        const result = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, { proposalId });

        expect(result).toEqual({
            ok: false,
            message: 'DAGMC assignments changed since the preview. Preview again.'
        });
        expect(harness.backend.calls).toEqual([]);
    });

    it('reverts earlier backend writes when a later assignment fails and leaves state unchanged', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [
                { action: 'assign', volumeId: 1, material: 'Fuel' },
                { action: 'assign', volumeId: 2, material: 'Graphite' }
            ]
        });
        const proposalId = (preview.data as DagmcChangeData).proposalId;
        harness.backend.failures.set(2, 'disk full');

        const result = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, { proposalId });

        expect(result).toEqual({ ok: false, message: 'Failed to assign material to volume 2: disk full' });
        expect(harness.backend.calls).toEqual([
            { filePath: DAGMC_FILE, volumeId: 1, material: 'Fuel' },
            { filePath: DAGMC_FILE, volumeId: 2, material: 'Graphite' },
            { filePath: DAGMC_FILE, volumeId: 1, material: 'Water' }
        ]);
        expect(harness.stateManager.getState()).toEqual(before);
        expect(harness.proposalService.get(proposalId)).toBeDefined();
        expect(harness.undoService.entries.size).toBe(0);
    });

    it('undo restores the previous materials through the backend and state', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [
                { action: 'assign', volumeId: 2, material: 'Water' },
                { action: 'setFlags', autoMatIds: true }
            ]
        });
        const applied = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, {
            proposalId: (preview.data as DagmcChangeData).proposalId
        });
        const token = applied.undoToken!;
        harness.backend.calls.length = 0;

        const result = await harness.undoService.undo(token);

        expect(result).toEqual({ ok: true, message: 'DAGMC change undone.' });
        expect(harness.backend.calls).toEqual([{ filePath: DAGMC_FILE, volumeId: 2, material: 'Fuel' }]);
        const state = harness.stateManager.getState();
        expect(state.settings.dagmcInfo?.volumes.find((volume) => volume.id === 2)?.material).toBe('Fuel');
        expect(state.settings.dagmcInfo?.volumes.find((volume) => volume.id === 1)?.material).toBe('Water');
        expect(state.settings.dagmcInfo?.autoMatIds).toBe(false);
        expect(harness.undoService.has(token)).toBe(false);
    });

    it('undo restores an unassigned volume to an empty material', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'assign', volumeId: 3, material: '' }]
        });
        const applied = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, {
            proposalId: (preview.data as DagmcChangeData).proposalId
        });
        expect(harness.stateManager.getState().settings.dagmcInfo?.volumes[2].material).toBe('');

        const result = await harness.undoService.undo(applied.undoToken!);

        expect(result.ok).toBe(true);
        expect(harness.backend.calls.at(-1)).toEqual({ filePath: DAGMC_FILE, volumeId: 3, material: 'mat:graveyard' });
        expect(harness.stateManager.getState().settings.dagmcInfo?.volumes[2].material).toBe('mat:graveyard');
    });

    it('rejects a stale undo and keeps the token available', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_DAGMC_CAPABILITY_ID, {
            actions: [{ action: 'assign', volumeId: 2, material: 'Water' }]
        });
        const applied = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, {
            proposalId: (preview.data as DagmcChangeData).proposalId
        });
        const token = applied.undoToken!;
        const info = harness.stateManager.getState().settings.dagmcInfo!;
        info.volumes.find((volume) => volume.id === 2)!.material = 'Graphite';
        harness.stateManager.updateSettings({ dagmcInfo: info });

        const result = await harness.undoService.undo(token);

        expect(result).toEqual({
            ok: false,
            message: 'DAGMC assignments changed since the edit; the change can no longer be undone.'
        });
        expect(harness.undoService.has(token)).toBe(true);
        expect(harness.stateManager.getState().settings.dagmcInfo?.volumes[1].material).toBe('Graphite');
    });

    it('rejects a proposal from another scope without consuming it', async () => {
        const harness = createHarness();
        const foreign = harness.proposalService.create({
            scope: 'materials',
            summary: 'Material edit',
            changes: [{ path: 'materials.1.density', label: 'Density', kind: 'update', before: 1, after: 2 }],
            before: [],
            after: []
        });

        const result = await harness.invoke(APPLY_DAGMC_CAPABILITY_ID, { proposalId: foreign.id });

        expect(result).toEqual({
            ok: false,
            message: `Proposal ${foreign.id} is for materials, not DAGMC geometry.`
        });
        expect(harness.proposalService.get(foreign.id)).toBeDefined();
        expect(harness.backend.calls).toEqual([]);
    });

    it('declares read/write risk, confirmation, undo, annotations, and availability', () => {
        const harness = createHarness();
        const preview = harness.registry.capabilities.get(PREVIEW_DAGMC_CAPABILITY_ID)!;
        const apply = harness.registry.capabilities.get(APPLY_DAGMC_CAPABILITY_ID)!;

        expect(validateCapability(preview)).toEqual([]);
        expect(validateCapability(apply)).toEqual([]);
        expect(validateCapabilityInput(preview, { actions: [{ action: 'assign', volumeId: 1, material: 'Fuel' }] })).toEqual([]);
        expect(validateCapabilityInput(apply, { proposalId: 'proposal-1' })).toEqual([]);

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
        const actionsSchema = preview.inputSchema.properties.actions;
        expect(actionsSchema).toMatchObject({ type: 'array', minItems: 1, maxItems: MAX_DAGMC_ACTIONS });
        expect(actionsSchema.items?.oneOf).toHaveLength(2);
        expect(preview.outputSchema?.type).toBe('object');

        expect(apply.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(apply.risk).toBe('write');
        expect(apply.requiresConfirmation).toBe(true);
        expect(apply.undoable).toBe(true);
        expect(apply.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        expect(apply.inputSchema).toEqual({
            type: 'object',
            properties: {
                proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewDagmcChange.' }
            },
            required: ['proposalId'],
            additionalProperties: false
        });
        expect(apply.outputSchema?.type).toBe('object');
        expect(apply.outputSchema?.properties.undoToken).toEqual({
            type: 'string',
            description: 'Session undo token for the applied DAGMC change.'
        });
    });
});
