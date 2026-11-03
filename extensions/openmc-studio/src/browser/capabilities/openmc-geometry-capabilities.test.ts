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
 * Tests the OpenMC CSG geometry preview/apply/undo capabilities against fake
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
import type { OpenMCGeometry, OpenMCState } from '../../common/openmc-state-schema';
import type { OpenMCStudioBackendService, ValidationIssue, ValidationRequest, ValidationResult } from '../../common/openmc-studio-protocol';
import type { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposalService } from './openmc-change-proposal-service';
import { APPLY_GEOMETRY_CAPABILITY_ID, OpenMCGeometryCapabilities, PREVIEW_GEOMETRY_CAPABILITY_ID } from './openmc-geometry-capabilities';

const WORKSPACE = '/workspace';
const DAGMC_MESSAGE = 'This project uses DAGMC geometry. Clear the DAGMC file before authoring CSG geometry.';
const STALE_MESSAGE = 'Geometry changed since the preview. Preview again.';

function buildGeometry(): OpenMCGeometry {
    return {
        surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 1 }, name: 'Core' }],
        cells: [
            {
                id: 1,
                name: 'Fuel',
                region: { type: 'surface', surfaceId: 1 },
                regionString: '-1',
                fillType: 'material',
                fillId: 1
            },
            { id: 2, name: 'Outside', fillType: 'void' }
        ],
        universes: [{ id: 0, name: 'root', cellIds: [1, 2] }],
        lattices: [],
        rootUniverseId: 0
    };
}

function buildState(): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: '1.1.0', name: 'Pincell', description: 'Demo project', created: now, modified: now },
        geometry: buildGeometry(),
        materials: [
            {
                id: 1,
                name: 'Fuel',
                density: 10.4,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'U235', fraction: 1, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: { run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 }, sources: [] },
        tallies: [],
        meshes: []
    };
}

class FakeStateManager {
    setStateCalls = 0;

    constructor(public state: OpenMCState) {}

    getState(): OpenMCState {
        return JSON.parse(JSON.stringify(this.state)) as OpenMCState;
    }

    setState(state: OpenMCState): void {
        this.state = JSON.parse(JSON.stringify(state)) as OpenMCState;
        this.setStateCalls += 1;
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

class FakeBackend {
    validation: ValidationResult = { valid: true, issues: [], summary: { errors: 0, warnings: 0, info: 0 } };
    readonly validateState = vi.fn(async (_request: ValidationRequest): Promise<ValidationResult> => this.validation);
}

interface GeometryChangeData {
    proposalId: string;
    summary: string;
    changes: Array<{ path: string; label: string; kind: string; before?: unknown; after?: unknown }>;
    counts: { add: number; update: number; remove: number };
}

interface Harness {
    stateManager: FakeStateManager;
    proposalService: TestProposalService;
    undoService: FakeUndoService;
    backend: FakeBackend;
    registry: FakeRegistry;
    invoke(id: string, input: unknown): Promise<NukeCapabilityResult>;
}

function createHarness(state: OpenMCState = buildState()): Harness {
    const stateManager = new FakeStateManager(state);
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const backend = new FakeBackend();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCGeometryCapabilities(
        stateManager as unknown as OpenMCStateManager,
        proposalService,
        undoService,
        backend as unknown as OpenMCStudioBackendService
    );
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        proposalService,
        undoService,
        backend,
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

function geometryActionError(message: string): ValidationIssue {
    return { severity: 'error', category: 'geometry', message };
}

describe('OpenMC geometry capabilities', () => {
    it('rejects invalid action lists before storing a proposal', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; message: string }> = [
            { input: { actions: 'nope' }, message: 'actions array' },
            { input: { actions: [] }, message: 'between 1 and 48' },
            { input: { actions: [{ action: 'rename', kind: 'cell', id: 1 }] }, message: 'must be add, update, or remove' },
            { input: { actions: [{ action: 'add', kind: 'mesh', value: {} }] }, message: 'kind of surface, cell, universe, or lattice' },
            { input: { actions: [{ action: 'add', kind: 'cell' }] }, message: 'needs a value object' },
            {
                input: { actions: [{ action: 'update', kind: 'cell', id: 1 }] },
                message: 'needs a non-negative integer id and an updates object'
            },
            { input: { actions: [{ action: 'remove', kind: 'cell', id: -1 }] }, message: 'needs a non-negative integer id' },
            { input: { actions: [{ action: 'update', kind: 'cell', id: 1, updates: {} }] }, message: 'at least one field' }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.proposalService.get('proposal-1')).toBeUndefined();
        expect(harness.stateManager.setStateCalls).toBe(0);
    });

    it('rejects changes that the shared geometry validator rejects', async () => {
        const harness = createHarness();

        const result = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'add', kind: 'cell', value: { fillType: 'material' } }]
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain('material ID');
        expect(harness.proposalService.get('proposal-1')).toBeUndefined();
        expect(harness.stateManager.setStateCalls).toBe(0);
    });

    it('rejects changes that the backend validator rejects', async () => {
        const harness = createHarness();
        harness.backend.validation = {
            valid: false,
            issues: [geometryActionError('Backend rejected the model.')],
            summary: { errors: 1, warnings: 0, info: 0 }
        };

        const result = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } }]
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain('Backend rejected the model.');
        expect(harness.proposalService.get('proposal-1')).toBeUndefined();
    });

    it('previews without backend validation errors when the backend is unavailable', async () => {
        const harness = createHarness();
        harness.backend.validateState.mockRejectedValueOnce(new Error('backend offline'));

        const result = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } }]
        });

        expect(result.ok).toBe(true);
    });

    it('rejects CSG edits while a DAGMC file is set', async () => {
        const state = buildState();
        state.settings.dagmcFile = 'model.h5m';
        const harness = createHarness(state);

        const result = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } }]
        });

        expect(result).toEqual({ ok: false, message: DAGMC_MESSAGE });
        expect(harness.proposalService.get('proposal-1')).toBeUndefined();
        expect(harness.stateManager.setStateCalls).toBe(0);
    });

    it('stores a proposal without changing state', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState().geometry;

        const result = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [
                { action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } },
                { action: 'add', kind: 'surface', value: { id: 2, type: 'z-plane', coefficients: { z0: 5 } } }
            ],
            summary: 'Shape the shield'
        });

        expect(result.ok).toBe(true);
        const data = result.data as GeometryChangeData;
        expect(data.summary).toBe('Shape the shield');
        expect(data.counts).toEqual({ add: 1, update: 1, remove: 0 });
        expect(data.changes).toEqual([
            {
                path: 'geometry.cells.2',
                label: 'Update cell #2',
                kind: 'update',
                before: { id: 2, name: 'Outside', fillType: 'void' },
                after: { id: 2, name: 'Shield', fillType: 'void' }
            },
            {
                path: 'geometry.surfaces.2',
                label: 'Add surface #2',
                kind: 'add',
                after: { id: 2, type: 'z-plane', coefficients: { z0: 5 } }
            }
        ]);
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC geometry change',
            summary: 'Shape the shield',
            changes: data.changes,
            applyCapability: APPLY_GEOMETRY_CAPABILITY_ID
        });
        expect(result.nextActions).toEqual([
            { capability: APPLY_GEOMETRY_CAPABILITY_ID, reason: 'Apply the previewed geometry change after confirmation.' }
        ]);

        const proposal = harness.proposalService.get(data.proposalId)!;
        expect(proposal.scope).toBe('geometry');
        expect(proposal.before).toEqual(before);
        expect((proposal.after as OpenMCGeometry).surfaces).toHaveLength(2);
        expect(harness.stateManager.getState().geometry).toEqual(before);
        expect(harness.stateManager.setStateCalls).toBe(0);
    });

    it('generates a default summary', async () => {
        const harness = createHarness();
        const result = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } }]
        });

        expect(result.ok).toBe(true);
        expect((result.data as GeometryChangeData).summary).toBe('Update cell #2.');
    });

    it('rejects a stale apply', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } }]
        });
        const data = preview.data as GeometryChangeData;
        harness.stateManager.state.geometry.cells[1].name = 'Edited elsewhere';

        const result = await harness.invoke(APPLY_GEOMETRY_CAPABILITY_ID, { proposalId: data.proposalId });

        expect(result).toEqual({ ok: false, message: STALE_MESSAGE });
        expect(harness.stateManager.setStateCalls).toBe(0);
        expect(harness.proposalService.get(data.proposalId)).toBeDefined();
    });

    it('applies a proposal and registers an undo that restores the model', async () => {
        const harness = createHarness();
        const before = harness.stateManager.getState().geometry;
        const preview = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } }]
        });
        const data = preview.data as GeometryChangeData;

        const result = await harness.invoke(APPLY_GEOMETRY_CAPABILITY_ID, { proposalId: data.proposalId });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            proposalId: data.proposalId,
            summary: data.summary,
            changes: data.changes,
            counts: { add: 0, update: 1, remove: 0 }
        });
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC geometry change',
            summary: data.summary,
            changes: data.changes
        });
        expect('applyCapability' in result.changeSet!).toBe(false);
        expect(result.undoToken).toBe('undo-1');
        expect(harness.undoService.has('undo-1')).toBe(true);
        expect(harness.stateManager.setStateCalls).toBe(1);
        expect(harness.stateManager.state.geometry.cells[1].name).toBe('Shield');
        expect(harness.stateManager.state.geometry.cells[0].name).toBe('Fuel');
        expect(harness.proposalService.get(data.proposalId)).toBeUndefined();

        const undone = await harness.undoService.undo('undo-1');
        expect(undone.ok).toBe(true);
        expect(harness.stateManager.state.geometry).toEqual(before);
        expect(harness.stateManager.setStateCalls).toBe(2);
        expect(harness.undoService.has('undo-1')).toBe(false);
    });

    it('rejects an undo after the applied geometry changed again', async () => {
        const harness = createHarness();
        const preview = await harness.invoke(PREVIEW_GEOMETRY_CAPABILITY_ID, {
            actions: [{ action: 'update', kind: 'cell', id: 2, updates: { name: 'Shield' } }]
        });
        const data = preview.data as GeometryChangeData;
        const applied = await harness.invoke(APPLY_GEOMETRY_CAPABILITY_ID, { proposalId: data.proposalId });
        harness.stateManager.state.geometry.cells[1].name = 'Edited again';

        const undone = await harness.undoService.undo(applied.undoToken!);

        expect(undone).toEqual({ ok: false, message: 'Geometry changed since the edit; the change can no longer be undone.' });
        expect(harness.stateManager.state.geometry.cells[1].name).toBe('Edited again');
    });

    it('rejects cross-domain and missing proposals', async () => {
        const harness = createHarness();
        const proposal = harness.proposalService.create({
            scope: 'materials',
            summary: 'Not geometry',
            changes: [],
            before: harness.stateManager.getState().geometry,
            after: harness.stateManager.getState().geometry
        });

        const wrongScope = await harness.invoke(APPLY_GEOMETRY_CAPABILITY_ID, { proposalId: proposal.id });
        expect(wrongScope.ok).toBe(false);
        expect(wrongScope.message).toBe(`Proposal ${proposal.id} is for materials, not CSG geometry.`);

        const missing = await harness.invoke(APPLY_GEOMETRY_CAPABILITY_ID, { proposalId: 'missing' });
        expect(missing).toEqual({ ok: false, message: 'This geometry preview is missing or has expired. Preview again.' });
        expect(harness.stateManager.setStateCalls).toBe(0);
    });
});
