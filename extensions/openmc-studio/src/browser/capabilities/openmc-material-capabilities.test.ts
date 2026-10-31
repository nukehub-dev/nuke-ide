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
 * Tests the OpenMC material preview/apply/undo capabilities against fake
 * services: no Theia boot, no OpenMC process, and no AI runtime.
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
import { validateCapability, validateCapabilityInput } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import type { OpenMCMaterial, OpenMCState } from '../../common/openmc-state-schema';
import type { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposalService } from './openmc-change-proposal-service';
import {
    APPLY_MATERIAL_CAPABILITY_ID,
    DIAGNOSE_PROJECT_CAPABILITY_ID,
    OpenMCMaterialCapabilities,
    PREVIEW_MATERIAL_CAPABILITY_ID
} from './openmc-material-capabilities';

const WORKSPACE = '/workspace';

function buildMaterials(): OpenMCMaterial[] {
    return [
        {
            id: 1,
            name: 'Water',
            density: 1,
            densityUnit: 'g/cm3',
            nuclides: [
                { name: 'H1', fraction: 2, fractionType: 'ao' },
                { name: 'O16', fraction: 1, fractionType: 'ao' }
            ],
            thermalScattering: [],
            color: '#4488ff'
        },
        {
            id: 2,
            name: 'Fuel',
            density: 10.4,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'U235', fraction: 0.04, fractionType: 'wo' }],
            thermalScattering: [{ name: 'c_Graphite', fraction: 1 }]
        },
        {
            id: 3,
            name: 'Graphite',
            density: 1.6,
            densityUnit: 'macro',
            nuclides: [],
            thermalScattering: [],
            macroscopic: { name: 'graphite' }
        }
    ];
}

function buildState(): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: '1.1.0', name: 'Pincell', description: 'Demo project', created: now, modified: now },
        geometry: { surfaces: [], cells: [], universes: [{ id: 0, name: 'root', cellIds: [] }], lattices: [], rootUniverseId: 0 },
        materials: buildMaterials(),
        settings: { run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

class FakeStateManager {
    readonly updates: Array<{ id: number; updates: Partial<OpenMCMaterial> }> = [];
    readonly added: OpenMCMaterial[] = [];
    readonly removed: number[] = [];

    constructor(public state: OpenMCState) {}

    getState(): OpenMCState {
        return JSON.parse(JSON.stringify(this.state)) as OpenMCState;
    }

    getNextMaterialId(): number {
        const ids = this.state.materials.map((material) => material.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    addMaterial(material: OpenMCMaterial): void {
        this.state.materials.push(material);
        this.added.push(material);
    }

    updateMaterial(id: number, updates: Partial<OpenMCMaterial>): void {
        const index = this.state.materials.findIndex((material) => material.id === id);
        if (index < 0) {
            return;
        }
        this.state.materials[index] = { ...this.state.materials[index], ...updates };
        this.updates.push({ id, updates });
    }

    removeMaterial(id: number): void {
        const index = this.state.materials.findIndex((material) => material.id === id);
        if (index < 0) {
            return;
        }
        this.state.materials.splice(index, 1);
        this.removed.push(id);
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

interface MaterialChangeData {
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

function createHarness(state: OpenMCState = buildState()): Harness {
    const stateManager = new FakeStateManager(state);
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCMaterialCapabilities(stateManager as unknown as OpenMCStateManager, proposalService, undoService);
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

describe('OpenMC material capabilities', () => {
    it('previews an update diff, stores a proposal, and leaves state untouched', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState().materials;

        const result = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'update', materialId: 1, updates: { density: 1.5, color: '#00ff00' } }],
            summary: 'Tune water'
        });

        expect(result.ok).toBe(true);
        const data = result.data as MaterialChangeData;
        expect(data.summary).toBe('Tune water');
        expect(data.changes).toEqual([
            { path: 'materials.1.density', label: 'Water Density', kind: 'update', before: 1, after: 1.5 },
            { path: 'materials.1.color', label: 'Water Color', kind: 'update', before: '#4488ff', after: '#00ff00' }
        ]);
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC material change',
            summary: 'Tune water',
            changes: data.changes,
            applyCapability: APPLY_MATERIAL_CAPABILITY_ID
        });
        expect(result.nextActions).toEqual([
            { capability: APPLY_MATERIAL_CAPABILITY_ID, reason: 'Apply the previewed material change after confirmation.' }
        ]);

        const proposal = harness.proposalService.get(data.proposalId)!;
        expect(proposal.scope).toBe('materials');
        expect(proposal.before).toEqual(before);
        expect((proposal.after as OpenMCMaterial[])[0]).toMatchObject({ id: 1, density: 1.5, color: '#00ff00' });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.stateManager.added).toEqual([]);
        expect(harness.stateManager.removed).toEqual([]);
        expect(harness.stateManager.state.materials).toEqual(before);
    });

    it('generates a default summary for each action kind', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; summary: string }> = [
            { input: { actions: [{ action: 'update', materialId: 1, updates: { density: 2 } }] }, summary: 'Update material Water.' },
            { input: { actions: [{ action: 'remove', materialId: 2 }] }, summary: 'Remove material Fuel.' },
            {
                input: { actions: [{ action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }] },
                summary: 'Add material Steel.'
            },
            {
                input: {
                    actions: [
                        { action: 'update', materialId: 1, updates: { density: 2 } },
                        { action: 'remove', materialId: 2 }
                    ]
                },
                summary: 'Apply 2 OpenMC material changes.'
            }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, testCase.input);
            expect(result.ok).toBe(true);
            expect((result.data as MaterialChangeData).summary).toBe(testCase.summary);
        }
    });

    it('assigns an id to an addition without mutating state', async () => {
        const harness = createHarness();

        const result = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }]
        });

        const data = result.data as MaterialChangeData;
        expect(data.changes).toEqual([
            {
                path: 'materials.4',
                label: 'Add material Steel',
                kind: 'add',
                after: {
                    id: 4,
                    name: 'Steel',
                    density: 7.87,
                    densityUnit: 'g/cm3',
                    nuclides: [],
                    thermalScattering: []
                }
            }
        ]);
        const proposal = harness.proposalService.get(data.proposalId)!;
        expect((proposal.after as OpenMCMaterial[]).map((material) => material.id)).toEqual([1, 2, 3, 4]);
        expect(harness.stateManager.state.materials).toHaveLength(3);
        expect(harness.stateManager.added).toEqual([]);
    });

    it('stores the full snapshot for a removal without mutating state', async () => {
        const harness = createHarness();
        const fuel = harness.stateManager.getState().materials[1];

        const result = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'remove', materialId: 2 }]
        });

        const data = result.data as MaterialChangeData;
        expect(data.changes).toEqual([{ path: 'materials.2', label: 'Remove material Fuel', kind: 'remove', before: fuel }]);
        const proposal = harness.proposalService.get(data.proposalId)!;
        expect((proposal.before as OpenMCMaterial[]).map((material) => material.id)).toEqual([1, 2, 3]);
        expect((proposal.after as OpenMCMaterial[]).map((material) => material.id)).toEqual([1, 3]);
        expect(harness.stateManager.state.materials).toHaveLength(3);
        expect(harness.stateManager.removed).toEqual([]);
    });

    it('rejects invalid, duplicate, protected, and no-op requests without storing a proposal', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; message: string }> = [
            { input: { actions: 'nope' }, message: 'actions array' },
            { input: { actions: [] }, message: 'between 1 and 20' },
            { input: { actions: [{ action: 'rename', materialId: 1 }] }, message: 'must be update, add, or remove' },
            { input: { actions: [{ action: 'update', materialId: 1 }] }, message: 'needs an updates object' },
            { input: { actions: [{ action: 'add' }] }, message: 'needs a material object' },
            { input: { actions: [{ action: 'remove', materialId: '1' }] }, message: 'positive integer materialId' },
            {
                input: {
                    actions: [
                        { action: 'update', materialId: 1, updates: { density: 2 } },
                        { action: 'remove', materialId: 1 }
                    ]
                },
                message: 'can only be changed once per preview'
            },
            { input: { actions: [{ action: 'update', materialId: 1, updates: { id: 9 } }] }, message: 'cannot be set' },
            {
                input: { actions: [{ action: 'update', materialId: 1, updates: { density: 2 }, summary: 'extra' }] },
                message: 'do not accept summary'
            },
            {
                input: { actions: [{ action: 'update', materialId: 1, updates: { density: 1 } }] },
                message: 'would not change any material'
            },
            {
                input: { actions: [{ action: 'add', material: { name: 'Water', density: 1, densityUnit: 'g/cm3' } }] },
                message: 'already used by material 1'
            }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.proposalService.get('proposal-1')).toBeUndefined();
        expect(harness.stateManager.state.materials).toEqual(buildMaterials());
        expect(harness.stateManager.updates).toEqual([]);
    });

    it('applies an update once per material and preserves unrelated materials', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'update', materialId: 1, updates: { density: 1.5, color: '#00ff00' } }],
            summary: 'Tune water'
        });
        const data = preview.data as MaterialChangeData;

        const result = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: data.proposalId });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ proposalId: data.proposalId, summary: 'Tune water', changes: data.changes });
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC material change',
            summary: 'Tune water',
            changes: data.changes
        });
        expect('applyCapability' in result.changeSet!).toBe(false);
        expect(result.undoToken).toBe('undo-1');
        expect(harness.undoService.has('undo-1')).toBe(true);
        expect(result.nextActions).toEqual([
            { capability: DIAGNOSE_PROJECT_CAPABILITY_ID, reason: 'Check the project after applying the material change.' }
        ]);
        expect(harness.stateManager.updates).toHaveLength(1);
        expect(harness.stateManager.updates[0]).toEqual({ id: 1, updates: { density: 1.5, color: '#00ff00' } });
        expect(harness.stateManager.state.materials[0]).toMatchObject({ id: 1, density: 1.5, color: '#00ff00' });
        expect(harness.stateManager.state.materials[1]).toEqual(buildMaterials()[1]);
        expect(harness.stateManager.state.materials[2]).toEqual(buildMaterials()[2]);
        expect(harness.proposalService.get(data.proposalId)).toBeUndefined();
    });

    it('applies an addition and a removal', async () => {
        const harness = createHarness();
        const addPreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }]
        });
        const addData = addPreview.data as MaterialChangeData;

        const added = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: addData.proposalId });

        expect(added.ok).toBe(true);
        expect(harness.stateManager.added).toHaveLength(1);
        expect(harness.stateManager.state.materials.map((material) => material.id)).toEqual([1, 2, 3, 4]);
        expect(harness.stateManager.state.materials[3]).toMatchObject({ name: 'Steel', density: 7.87, densityUnit: 'g/cm3' });

        const removePreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'remove', materialId: 2 }]
        });
        const removeData = removePreview.data as MaterialChangeData;

        const removed = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: removeData.proposalId });

        expect(removed.ok).toBe(true);
        expect(harness.stateManager.removed).toEqual([2]);
        expect(harness.stateManager.state.materials.map((material) => material.id)).toEqual([1, 3, 4]);
    });

    it('applies a proposal built only from stored changes', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState().materials;
        const proposal = harness.proposalService.create({
            scope: 'materials',
            summary: 'Raise water density',
            changes: [{ path: 'materials.1.density', label: 'Water Density', kind: 'update', before: 1, after: 1.25 }],
            before,
            after: before.map((material) => (material.id === 1 ? { ...material, density: 1.25 } : material))
        });

        const result = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: proposal.id });

        expect(result.ok).toBe(true);
        expect(harness.stateManager.state.materials[0].density).toBe(1.25);
        expect(harness.stateManager.state.materials[1]).toEqual(before[1]);
    });

    it('rejects a proposal with an unsupported change path', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState().materials;
        const proposal = harness.proposalService.create({
            scope: 'materials',
            summary: 'Tampered',
            changes: [
                { path: 'materials.1.macroscopic', label: 'Macroscopic', kind: 'update', before: undefined, after: { name: 'water' } }
            ],
            before,
            after: before
        });

        const result = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: proposal.id });

        expect(result).toEqual({
            ok: false,
            message: 'The material proposal contains an unsupported update path: materials.1.macroscopic.'
        });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.proposalService.get(proposal.id)).toBeDefined();
    });

    it('rejects stale updates, removals, and missing materials before mutating', async () => {
        const harness = createHarness();
        const updatePreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'update', materialId: 1, updates: { density: 2 } }]
        });
        const updateId = (updatePreview.data as MaterialChangeData).proposalId;
        harness.stateManager.state.materials[0].density = 1.2;

        const staleUpdate = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: updateId });
        expect(staleUpdate).toEqual({ ok: false, message: 'Material 1 changed since the preview. Preview again.' });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.stateManager.state.materials[0].density).toBe(1.2);
        expect(harness.proposalService.get(updateId)).toBeDefined();

        const removePreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'remove', materialId: 2 }]
        });
        const removeId = (removePreview.data as MaterialChangeData).proposalId;
        harness.stateManager.state.materials[1].name = 'Fuel Renamed';

        const staleRemove = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: removeId });
        expect(staleRemove).toEqual({ ok: false, message: 'Material 2 changed since the preview. Preview again.' });
        expect(harness.stateManager.removed).toEqual([]);

        harness.stateManager.removeMaterial(2);
        const missingRemove = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: removeId });
        expect(missingRemove).toEqual({ ok: false, message: 'Material 2 changed since the preview. Preview again.' });
    });

    it('rejects an addition whose id or name was taken after the preview', async () => {
        const harness = createHarness();
        const idPreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }]
        });
        const idProposal = (idPreview.data as MaterialChangeData).proposalId;
        harness.stateManager.addMaterial({
            id: 4,
            name: 'Lead',
            density: 11.34,
            densityUnit: 'g/cm3',
            nuclides: [],
            thermalScattering: []
        });

        const usedId = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: idProposal });
        expect(usedId).toEqual({ ok: false, message: 'Material 4 is already in use. Preview again.' });
        expect(harness.stateManager.added.map((material) => material.name)).toEqual(['Lead']);

        const namePreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'add', material: { name: 'Aluminum', density: 2.7, densityUnit: 'g/cm3' } }]
        });
        const nameProposal = (namePreview.data as MaterialChangeData).proposalId;
        harness.stateManager.addMaterial({
            id: 99,
            name: 'Aluminum',
            density: 2.7,
            densityUnit: 'g/cm3',
            nuclides: [],
            thermalScattering: []
        });

        const usedName = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: nameProposal });
        expect(usedName).toEqual({ ok: false, message: 'Material name "Aluminum" is already in use. Preview again.' });
    });

    it('rejects a proposal from another scope without mutating or consuming it', async () => {
        const harness = createHarness();
        const foreign = harness.proposalService.create({
            scope: 'tallies',
            summary: 'Tally edit',
            changes: [{ path: 'tallies.1.scores', label: 'Scores', kind: 'update', before: [], after: ['flux'] }],
            before: [],
            after: []
        });

        const result = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: foreign.id });

        expect(result).toEqual({ ok: false, message: `Proposal ${foreign.id} is for tallies, not materials.` });
        expect(harness.proposalService.get(foreign.id)).toBeDefined();
        expect(harness.stateManager.updates).toEqual([]);
    });

    it('rejects missing, expired, and incomplete proposals', async () => {
        const harness = createHarness();

        const missing = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: 'missing' });
        expect(missing.ok).toBe(false);
        expect(missing.message).toContain('missing or has expired');

        const missingId = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, {});
        expect(missingId.ok).toBe(false);
        expect(missingId.message).toContain('proposalId');

        const preview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'update', materialId: 1, updates: { density: 2 } }]
        });
        const proposalId = (preview.data as MaterialChangeData).proposalId;
        harness.proposalService.clock.now += 10 * 60 * 1000;
        const expired = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId });
        expect(expired.ok).toBe(false);
        expect(expired.message).toContain('missing or has expired');

        const incomplete = harness.proposalService.create({
            scope: 'materials',
            summary: 'Broken',
            changes: [{ path: 'materials.1.density', label: 'Density', kind: 'update', before: 1, after: 2 }],
            before: 'not materials',
            after: []
        });
        const broken = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId: incomplete.id });
        expect(broken).toEqual({ ok: false, message: 'This materials preview is missing its materials snapshot. Preview again.' });
    });

    it('undoes an update, keeps unrelated material edits, and consumes the token', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'update', materialId: 1, updates: { density: 1.5, color: '#00ff00' } }]
        });
        const proposalId = (preview.data as MaterialChangeData).proposalId;
        const applied = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, { proposalId });
        const token = applied.undoToken!;
        harness.stateManager.updateMaterial(2, { color: '#111111' });

        const result = await harness.undoService.undo(token);

        expect(result).toEqual({ ok: true, message: 'Material change undone.' });
        expect(harness.stateManager.state.materials[0]).toMatchObject({ density: 1, color: '#4488ff' });
        expect(harness.stateManager.state.materials[1].color).toBe('#111111');
        expect(harness.stateManager.state.materials[2]).toEqual(buildMaterials()[2]);
        expect(harness.undoService.has(token)).toBe(false);
    });

    it('undoes an addition and keeps unrelated material edits', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }]
        });
        const applied = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, {
            proposalId: (preview.data as MaterialChangeData).proposalId
        });
        const token = applied.undoToken!;
        harness.stateManager.updateMaterial(1, { density: 0.998 });

        const result = await harness.undoService.undo(token);

        expect(result).toEqual({ ok: true, message: 'Material change undone.' });
        expect(harness.stateManager.state.materials.map((material) => material.id)).toEqual([1, 2, 3]);
        expect(harness.stateManager.state.materials[0].density).toBe(0.998);
        expect(harness.undoService.has(token)).toBe(false);
    });

    it('undoes a removal and keeps unrelated material edits', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'remove', materialId: 2 }]
        });
        const applied = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, {
            proposalId: (preview.data as MaterialChangeData).proposalId
        });
        const token = applied.undoToken!;
        harness.stateManager.updateMaterial(1, { color: '#abcdef' });

        const result = await harness.undoService.undo(token);

        expect(result).toEqual({ ok: true, message: 'Material change undone.' });
        expect(harness.stateManager.state.materials.find((material) => material.id === 2)).toEqual(buildMaterials()[1]);
        expect(harness.stateManager.state.materials[0].color).toBe('#abcdef');
        expect(harness.undoService.has(token)).toBe(false);
    });

    it('rejects a stale undo and keeps the token available', async () => {
        const harness = createHarness();
        const updatePreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'update', materialId: 1, updates: { density: 2 } }]
        });
        const updateApplied = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, {
            proposalId: (updatePreview.data as MaterialChangeData).proposalId
        });
        const updateToken = updateApplied.undoToken!;
        harness.stateManager.updateMaterial(1, { density: 3 });

        const staleUpdate = await harness.undoService.undo(updateToken);
        expect(staleUpdate).toEqual({
            ok: false,
            message: 'Materials changed since the edit; the change can no longer be undone.'
        });
        expect(harness.stateManager.state.materials[0].density).toBe(3);
        expect(harness.undoService.has(updateToken)).toBe(true);

        const addPreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }]
        });
        const addApplied = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, {
            proposalId: (addPreview.data as MaterialChangeData).proposalId
        });
        const addToken = addApplied.undoToken!;
        harness.stateManager.updateMaterial(4, { name: 'Steel Modified' });

        const staleAdd = await harness.undoService.undo(addToken);
        expect(staleAdd.ok).toBe(false);
        expect(harness.stateManager.state.materials.some((material) => material.id === 4)).toBe(true);
        expect(harness.undoService.has(addToken)).toBe(true);

        const removePreview = await harness.invoke(PREVIEW_MATERIAL_CAPABILITY_ID, {
            actions: [{ action: 'remove', materialId: 2 }]
        });
        const removeApplied = await harness.invoke(APPLY_MATERIAL_CAPABILITY_ID, {
            proposalId: (removePreview.data as MaterialChangeData).proposalId
        });
        const removeToken = removeApplied.undoToken!;
        harness.stateManager.addMaterial({ ...buildMaterials()[1], id: 2, name: 'Fuel Copy' });

        const staleRemove = await harness.undoService.undo(removeToken);
        expect(staleRemove.ok).toBe(false);
        expect(harness.undoService.has(removeToken)).toBe(true);
    });

    it('declares read/write risk, confirmation, undo, annotations, and availability', () => {
        const harness = createHarness();
        const preview = harness.registry.capabilities.get(PREVIEW_MATERIAL_CAPABILITY_ID)!;
        const apply = harness.registry.capabilities.get(APPLY_MATERIAL_CAPABILITY_ID)!;

        expect(validateCapability(preview)).toEqual([]);
        expect(validateCapability(apply)).toEqual([]);
        expect(validateCapabilityInput(preview, { actions: [{ action: 'update', materialId: 1, updates: { density: 2 } }] })).toEqual([]);
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
        expect(actionsSchema).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
        expect(actionsSchema.items?.oneOf).toHaveLength(3);
        expect(preview.outputSchema?.type).toBe('object');

        expect(apply.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(apply.risk).toBe('write');
        expect(apply.requiresConfirmation).toBe(true);
        expect(apply.undoable).toBe(true);
        expect(apply.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        expect(apply.inputSchema).toEqual({
            type: 'object',
            properties: {
                proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewMaterialChange.' }
            },
            required: ['proposalId'],
            additionalProperties: false
        });
        expect(apply.outputSchema?.type).toBe('object');
        expect(apply.outputSchema?.properties.undoToken).toEqual({
            type: 'string',
            description: 'Session undo token for the applied material change.'
        });
    });
});
