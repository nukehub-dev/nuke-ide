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
 * Tests the OpenMC source summary, preview, apply, and undo capabilities
 * against fake state and undo services: no Theia boot, no OpenMC process, and
 * no AI runtime.
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
import type { OpenMCIndependentSource, OpenMCSettings, OpenMCSource, OpenMCState } from '../../common/openmc-state-schema';
import type { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCChangeProposalService } from './openmc-change-proposal-service';
import { OpenMCSourceCapabilities } from './openmc-source-capabilities';

const WORKSPACE = '/workspace';

/** Build one independent source with overridable distributions. */
function buildSource(overrides: Record<string, unknown> = {}): OpenMCIndependentSource {
    return {
        spatial: { type: 'point', origin: [0, 0, 0] },
        energy: { type: 'discrete', energies: [14.1e6], probabilities: [1] },
        angle: { type: 'isotropic' },
        time: { type: 'delta', time: 0 },
        particle: { name: 'neutron', pdg: 2112 },
        ...overrides
    } as unknown as OpenMCIndependentSource;
}

/** Clone a JSON-like fixture. */
function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function buildSources(): OpenMCIndependentSource[] {
    return [buildSource()];
}

function buildState(sources: OpenMCSource[] = buildSources(), mode: 'fixed source' | 'eigenvalue' = 'fixed source'): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: '1.1.0', name: 'Pincell', description: 'Demo project', created: now, modified: now },
        geometry: { surfaces: [], cells: [], universes: [], lattices: [], rootUniverseId: 0 },
        materials: [],
        settings: {
            run: mode === 'eigenvalue' ? { mode, particles: 1000, inactive: 10, batches: 50 } : { mode, particles: 1000, batches: 10 },
            sources
        },
        tallies: [],
        meshes: []
    };
}

class FakeStateManager {
    readonly updates: Array<Partial<OpenMCSettings>> = [];

    constructor(public state: OpenMCState) {}

    getState(): OpenMCState {
        return JSON.parse(JSON.stringify(this.state));
    }

    updateSettings(updates: Partial<OpenMCSettings>): void {
        this.updates.push(clone(updates));
        this.state.settings = { ...this.state.settings, ...clone(updates) };
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

interface SourceChangeData {
    proposalId: string;
    summary: string;
    changes: Array<{ path: string; label: string; kind: string; before?: unknown; after?: unknown }>;
}

interface SourceSummaryRow {
    index: number;
    type: string;
    editable: boolean;
    spatial?: string;
    energyType?: string;
    angle?: string;
    time?: string;
    particle?: string;
    detail?: string;
    fixedSource: boolean;
}

interface SourceSummaryData {
    runMode: string;
    fixedSource: boolean;
    sources: SourceSummaryRow[];
    total: number;
    truncated: boolean;
}

interface Harness {
    stateManager: FakeStateManager;
    proposalService: TestProposalService;
    undoService: FakeUndoService;
    registry: FakeRegistry;
    invoke(id: string, input: unknown): Promise<NukeCapabilityResult>;
}

function createHarness(sources: OpenMCSource[] = buildSources(), mode: 'fixed source' | 'eigenvalue' = 'fixed source'): Harness {
    const stateManager = new FakeStateManager(buildState(sources, mode));
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCSourceCapabilities(stateManager as unknown as OpenMCStateManager, proposalService, undoService);
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

describe('OpenMC source capabilities', () => {
    it('summarizes independent and read-only sources with the run mode', async () => {
        const fileSource: OpenMCSource = { type: 'file', path: '/tmp/source.h5' };
        const meshSource: OpenMCSource = { type: 'mesh', meshId: 4, sources: [buildSource()] };
        const harness = createHarness([buildSource(), fileSource, meshSource]);

        const result = await harness.invoke('nuke.openmc.summarizeSources', {});

        expect(result.ok).toBe(true);
        const data = result.data as SourceSummaryData;
        expect(data.runMode).toBe('fixed source');
        expect(data.fixedSource).toBe(true);
        expect(data.total).toBe(3);
        expect(data.truncated).toBe(false);
        expect(data.sources[0]).toEqual({
            index: 0,
            type: 'independent',
            editable: true,
            spatial: 'Point [0, 0, 0]',
            energyType: 'discrete',
            angle: 'Isotropic',
            time: 't = 0 s',
            particle: 'neutron',
            fixedSource: true
        });
        expect(data.sources[1]).toMatchObject({
            index: 1,
            type: 'file',
            editable: false,
            detail: 'File source: /tmp/source.h5',
            fixedSource: true
        });
        expect(data.sources[2]).toMatchObject({
            index: 2,
            type: 'mesh',
            editable: false,
            detail: 'Mesh source for mesh 4 with 1 sub-source',
            fixedSource: true
        });
    });

    it('reports a non-fixed run mode in the summary', async () => {
        const harness = createHarness(buildSources(), 'eigenvalue');

        const result = await harness.invoke('nuke.openmc.summarizeSources', {});
        const data = result.data as SourceSummaryData;

        expect(data.runMode).toBe('eigenvalue');
        expect(data.fixedSource).toBe(false);
        expect(data.sources[0].fixedSource).toBe(false);
    });

    it('caps the summary at 50 rows and reports truncation', async () => {
        const harness = createHarness(Array.from({ length: 51 }, () => buildSource()));

        const result = await harness.invoke('nuke.openmc.summarizeSources', {});
        const data = result.data as SourceSummaryData;

        expect(data.sources).toHaveLength(50);
        expect(data.total).toBe(51);
        expect(data.truncated).toBe(true);
        expect(data.sources[49].index).toBe(49);
    });

    it('previews every independent spatial type with discrete energy, isotropic and monodirectional angles, and delta time', async () => {
        const harness = createHarness();
        const original = clone(harness.stateManager.state.settings.sources);

        const result = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [
                {
                    action: 'add',
                    source: {
                        spatial: { type: 'point', origin: [0, 0, 0] },
                        energy: { type: 'discrete', energies: [14.1e6], probabilities: [1] },
                        angle: { type: 'isotropic' },
                        time: { type: 'delta', time: 0 },
                        particle: 'neutron'
                    }
                },
                {
                    action: 'add',
                    source: {
                        spatial: { type: 'box', lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] },
                        energy: { type: 'discrete', energies: [1e6, 2e6], probabilities: [0.25, 0.75] },
                        angle: { type: 'monodirectional', referenceUvW: [0, 0, 1] }
                    }
                },
                {
                    action: 'add',
                    source: {
                        spatial: { type: 'sphere', center: [0, 0, 0], radius: 2 },
                        energy: { type: 'uniform', min: 0, max: 20e6 },
                        angle: { type: 'isotropic' }
                    }
                },
                {
                    action: 'add',
                    source: {
                        spatial: { type: 'cylinder', center: [0, 0, 0], radius: 1, height: 4, axis: 'z' },
                        energy: { type: 'watt', a: 0.988e6, b: 2.249e-6 }
                    }
                },
                {
                    action: 'add',
                    source: {
                        spatial: {
                            type: 'cartesian',
                            x: { type: 'uniform', min: -1, max: 1 },
                            y: { type: 'uniform', min: -1, max: 1 },
                            z: { type: 'uniform', min: -1, max: 1 }
                        },
                        energy: { type: 'maxwell', temperature: 1.2 }
                    }
                },
                {
                    action: 'add',
                    source: {
                        spatial: {
                            type: 'cylindrical',
                            r: { type: 'uniform', min: 0, max: 1 },
                            phi: { type: 'uniform', min: 0, max: 2 * Math.PI },
                            z: { type: 'uniform', min: -1, max: 1 },
                            origin: [0, 0, 0],
                            rDir: [1, 0, 0],
                            zDir: [0, 0, 1]
                        },
                        energy: { type: 'normal', mean: 14.1e6, stdDev: 0.3e6 }
                    }
                },
                {
                    action: 'add',
                    source: {
                        spatial: {
                            type: 'spherical',
                            r: { type: 'uniform', min: 0, max: 2 },
                            cosTheta: { type: 'uniform', min: -1, max: 1 },
                            phi: { type: 'uniform', min: 0, max: 2 * Math.PI },
                            origin: [0, 0, 0]
                        },
                        energy: { type: 'tabular', energies: [1e6, 2e6], probabilities: [1, 1], interpolation: 'linear-linear' }
                    }
                }
            ],
            summary: 'Add one source per spatial type'
        });

        expect(result.ok).toBe(true);
        const data = result.data as SourceChangeData;
        expect(data.summary).toBe('Add one source per spatial type');
        expect(data.changes.map((change) => [change.path, change.kind])).toEqual([
            ['settings.sources.1', 'add'],
            ['settings.sources.2', 'add'],
            ['settings.sources.3', 'add'],
            ['settings.sources.4', 'add'],
            ['settings.sources.5', 'add'],
            ['settings.sources.6', 'add'],
            ['settings.sources.7', 'add']
        ]);
        const proposal = harness.proposalService.get(data.proposalId)!;
        expect(proposal.scope).toBe('sources');
        expect(proposal.before).toEqual(original);
        const after = proposal.after as OpenMCSource[];
        expect(after.map((source) => (source as { spatial: { type: string } }).spatial.type)).toEqual([
            'point',
            'point',
            'box',
            'sphere',
            'cylinder',
            'cartesian',
            'cylindrical',
            'spherical'
        ]);
        expect((after[2] as { angle: { type: string } }).angle.type).toBe('monodirectional');
        expect((after[1] as { time: { type: string } }).time.type).toBe('delta');
        expect((after[4] as { energy: { type: string } }).energy.type).toBe('watt');
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.stateManager.state.settings.sources).toEqual(original);
    });

    it('previews add, update, and remove with one change row per affected field', async () => {
        const harness = createHarness([
            buildSource(),
            buildSource({ spatial: { type: 'sphere', center: [1, 1, 1], radius: 2 } }),
            buildSource({ spatial: { type: 'box', lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] } })
        ]);
        const original = clone(harness.stateManager.state.settings.sources);

        const result = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [
                {
                    action: 'update',
                    index: 0,
                    source: buildSource({ spatial: { type: 'sphere', center: [0, 0, 0], radius: 5 } })
                },
                { action: 'remove', index: 2 },
                {
                    action: 'add',
                    source: buildSource({ spatial: { type: 'cylinder', center: [0, 0, 0], radius: 1, height: 2, axis: 'x' } })
                }
            ]
        });

        expect(result.ok).toBe(true);
        const data = result.data as SourceChangeData;
        expect(data.changes.map((change) => [change.path, change.kind])).toEqual([
            ['settings.sources.0.spatial', 'update'],
            ['settings.sources.2', 'remove'],
            ['settings.sources.2', 'add']
        ]);
        expect(data.changes[0].before).toEqual({ type: 'point', origin: [0, 0, 0] });
        expect(data.changes[0].after).toEqual({ type: 'sphere', center: [0, 0, 0], radius: 5 });
        expect(data.changes[1].before).toEqual(original[2]);
        const proposal = harness.proposalService.get(data.proposalId)!;
        const after = proposal.after as OpenMCSource[];
        expect(after.map((source) => (source as { spatial: { type: string } }).spatial.type)).toEqual(['sphere', 'sphere', 'cylinder']);
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.stateManager.state.settings.sources).toEqual(original);
    });

    it('applies a preview through updateSettings and registers a source undo', async () => {
        const harness = createHarness([buildSource(), buildSource()]);
        const original = clone(harness.stateManager.state.settings.sources);
        const preview = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [
                { action: 'remove', index: 1 },
                { action: 'add', source: buildSource({ spatial: { type: 'sphere', center: [0, 0, 0], radius: 3 } }) }
            ],
            summary: 'Swap the second source'
        });
        const data = preview.data as SourceChangeData;

        const result = await harness.invoke('nuke.openmc.applySourceChange', { proposalId: data.proposalId });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ proposalId: data.proposalId, summary: 'Swap the second source', changes: data.changes });
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC source change',
            summary: 'Swap the second source',
            changes: data.changes
        });
        expect('applyCapability' in result.changeSet!).toBe(false);
        expect(result.undoToken).toBe('undo-1');
        expect(harness.undoService.has('undo-1')).toBe(true);
        expect(result.nextActions).toEqual([
            { capability: 'nuke.openmc.diagnoseProject', reason: 'Check the project after applying the source change.' }
        ]);
        expect(harness.stateManager.updates).toHaveLength(1);
        expect(harness.stateManager.updates[0].sources).toHaveLength(2);
        expect((harness.stateManager.updates[0].sources![1] as unknown as { spatial: { type: string } }).spatial.type).toBe('sphere');
        expect(harness.stateManager.state.settings.sources).toHaveLength(2);
        expect((harness.stateManager.state.settings.sources[1] as { spatial: { type: string } }).spatial.type).toBe('sphere');
        expect(harness.proposalService.get(data.proposalId)).toBeUndefined();

        const undone = await harness.undoService.undo(result.undoToken!);

        expect(undone).toEqual({ ok: true, message: 'Source change undone.' });
        expect(harness.undoService.has(result.undoToken!)).toBe(false);
        expect(harness.stateManager.state.settings.sources).toEqual(original);
    });

    it('rejects out-of-range source indexes', async () => {
        const harness = createHarness();

        const update = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'update', index: 4, source: buildSource() }]
        });
        expect(update.ok).toBe(false);
        expect(update.message).toContain('Source index 4 is out of range');

        const remove = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'remove', index: 4 }]
        });
        expect(remove.ok).toBe(false);
        expect(remove.message).toContain('Source index 4 is out of range');
        expect(harness.stateManager.updates).toEqual([]);
    });

    it('rejects duplicate indexes and malformed actions', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; message: string }> = [
            {
                input: {
                    actions: [
                        { action: 'update', index: 0, source: buildSource() },
                        { action: 'remove', index: 0 }
                    ]
                },
                message: 'Source index 0 is targeted more than once'
            },
            {
                input: {
                    actions: [
                        { action: 'update', index: 0, source: buildSource() },
                        { action: 'update', index: 0, source: buildSource() }
                    ]
                },
                message: 'Source index 0 is targeted more than once'
            },
            { input: { actions: [] }, message: 'between 1 and 16' },
            { input: { actions: 'nope' }, message: 'Provide an actions array' },
            {
                input: { actions: Array.from({ length: 17 }, () => ({ action: 'add', source: buildSource() })) },
                message: 'between 1 and 16'
            },
            { input: { actions: [{ action: 'move', index: 0 }] }, message: 'must use action add, update, or remove' },
            { input: { actions: [{ action: 'remove' }] }, message: 'needs a non-negative integer index' },
            { input: { actions: [{ action: 'add' }] }, message: 'needs a source object' },
            { input: { actions: [{ action: 'add', source: buildSource(), extra: true }] }, message: 'unknown field "extra"' },
            { input: { actions: [{ action: 'add', source: buildSource({ path: '/tmp/source.h5' }) }] }, message: 'not editable' },
            { input: { actions: [{ action: 'add', source: buildSource() }], bogus: 1 }, message: 'Unknown input field "bogus"' }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke('nuke.openmc.previewSourceChange', testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.stateManager.updates).toEqual([]);
    });

    it('rejects invalid angular ranges and negative sizes', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; message: string }> = [
            {
                input: {
                    actions: [
                        {
                            action: 'add',
                            source: buildSource({
                                angle: {
                                    type: 'mu-phi',
                                    mu: { type: 'uniform', min: -2, max: 1 },
                                    phi: { type: 'uniform', min: 0, max: 2 * Math.PI }
                                }
                            })
                        }
                    ]
                },
                message: 'Angle mu values must be within [-1, 1]'
            },
            {
                input: {
                    actions: [
                        {
                            action: 'add',
                            source: buildSource({
                                angle: {
                                    type: 'mu-phi',
                                    mu: { type: 'uniform', min: -1, max: 1 },
                                    phi: { type: 'uniform', min: 0, max: 7 }
                                }
                            })
                        }
                    ]
                },
                message: 'Angle phi values must be within [0, 2π]'
            },
            {
                input: {
                    actions: [
                        {
                            action: 'add',
                            source: buildSource({ spatial: { type: 'sphere', center: [0, 0, 0], radius: -1 } })
                        }
                    ]
                },
                message: 'Sphere radius must be positive'
            },
            {
                input: {
                    actions: [
                        {
                            action: 'add',
                            source: buildSource({ spatial: { type: 'cylinder', center: [0, 0, 0], radius: 1, height: 0, axis: 'z' } })
                        }
                    ]
                },
                message: 'Cylinder height must be positive'
            },
            {
                input: {
                    actions: [
                        {
                            action: 'add',
                            source: buildSource({ energy: { type: 'tabular', energies: [1e6, 2e6], probabilities: [1] } })
                        }
                    ]
                },
                message: 'probabilities'
            }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke('nuke.openmc.previewSourceChange', testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.stateManager.updates).toEqual([]);
    });

    it('rejects file, compiled, mesh, and tokamak source objects', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; message: string }> = [
            {
                input: { actions: [{ action: 'add', source: { type: 'file', path: '/tmp/source.h5' } }] },
                message: 'Only independent sources can be edited'
            },
            {
                input: { actions: [{ action: 'add', source: { type: 'compiled', library: 'source.so' } }] },
                message: 'Only independent sources can be edited'
            },
            {
                input: {
                    actions: [{ action: 'add', source: { type: 'mesh', meshId: 1, sources: [buildSource()] } }]
                },
                message: 'Only independent sources can be edited'
            },
            {
                input: { actions: [{ action: 'add', source: { type: 'tokamak', majorRadius: 500 } }] },
                message: 'Only independent sources can be edited'
            },
            {
                input: {
                    actions: [
                        {
                            action: 'add',
                            source: buildSource({ spatial: { type: 'mesh', meshId: 1, volumeNormalized: true } })
                        }
                    ]
                },
                message: 'Mesh spatial sources are not supported'
            }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke('nuke.openmc.previewSourceChange', testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
    });

    it('rejects updates and removals that target read-only source types', async () => {
        const harness = createHarness([{ type: 'file', path: '/tmp/source.h5' }]);

        const update = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'update', index: 0, source: buildSource() }]
        });
        expect(update.ok).toBe(false);
        expect(update.message).toContain('only independent sources can be updated or removed');

        const remove = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'remove', index: 0 }]
        });
        expect(remove.ok).toBe(false);
        expect(remove.message).toContain('only independent sources can be updated or removed');
    });

    it('rejects previews for non-fixed-source runs', async () => {
        const harness = createHarness(buildSources(), 'eigenvalue');

        const result = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'add', source: buildSource() }]
        });

        expect(result).toEqual({ ok: false, message: 'Sources only apply to fixed-source runs.' });
        expect(harness.stateManager.updates).toEqual([]);
    });

    it('rejects apply when the run stopped being fixed source', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'add', source: buildSource() }]
        });
        const proposalId = (preview.data as SourceChangeData).proposalId;
        harness.stateManager.state.settings.run = { mode: 'eigenvalue', particles: 10, inactive: 1, batches: 2 };

        const result = await harness.invoke('nuke.openmc.applySourceChange', { proposalId });

        expect(result).toEqual({ ok: false, message: 'Sources only apply to fixed-source runs.' });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.proposalService.get(proposalId)).toBeDefined();
    });

    it('rejects a stale apply without writing or consuming the proposal', async () => {
        const harness = createHarness([buildSource(), buildSource()]);
        const preview = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'remove', index: 1 }]
        });
        const proposalId = (preview.data as SourceChangeData).proposalId;
        harness.stateManager.state.settings.sources[0] = buildSource({ energy: { type: 'uniform', min: 1, max: 2 } });

        const result = await harness.invoke('nuke.openmc.applySourceChange', { proposalId });

        expect(result).toEqual({ ok: false, message: 'Sources changed since the preview. Preview again.' });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.proposalService.get(proposalId)).toBeDefined();
    });

    it('rejects a stale undo and keeps the token', async () => {
        const harness = createHarness([buildSource(), buildSource()]);
        const preview = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'remove', index: 1 }]
        });
        const applied = await harness.invoke('nuke.openmc.applySourceChange', {
            proposalId: (preview.data as SourceChangeData).proposalId
        });
        harness.stateManager.state.settings.sources[0] = buildSource({ spatial: { type: 'sphere', center: [0, 0, 0], radius: 1 } });

        const result = await harness.undoService.undo(applied.undoToken!);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('can no longer be undone');
        expect(harness.stateManager.state.settings.sources).toHaveLength(1);
        expect(harness.undoService.has(applied.undoToken!)).toBe(true);
    });

    it('rejects missing, malformed, expired, and wrong-scope proposals', async () => {
        const harness = createHarness();

        expect(await harness.invoke('nuke.openmc.applySourceChange', { proposalId: 'missing' })).toEqual({
            ok: false,
            message: 'This sources preview is missing or has expired. Preview again.'
        });
        expect((await harness.invoke('nuke.openmc.applySourceChange', {})).message).toContain('proposalId');

        const expiredPreview = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'add', source: buildSource() }]
        });
        harness.proposalService.clock.now += 10 * 60 * 1000;
        const expired = await harness.invoke('nuke.openmc.applySourceChange', {
            proposalId: (expiredPreview.data as SourceChangeData).proposalId
        });
        expect(expired.message).toContain('missing or has expired');

        const foreign = harness.proposalService.create({
            scope: 'materials',
            summary: 'Swap materials',
            changes: [{ path: 'materials', label: 'Materials', kind: 'update', before: [], after: [] }],
            before: [],
            after: []
        });
        const wrongScope = await harness.invoke('nuke.openmc.applySourceChange', { proposalId: foreign.id });

        expect(wrongScope).toEqual({ ok: false, message: `Proposal ${foreign.id} is for materials, not sources.` });
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.proposalService.get(foreign.id)).toBeDefined();
    });

    it('rejects a preview where nothing changes', async () => {
        const harness = createHarness([buildSource()]);

        const result = await harness.invoke('nuke.openmc.previewSourceChange', {
            actions: [{ action: 'update', index: 0, source: buildSource() }]
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain('does not change any source');
        expect(harness.stateManager.updates).toEqual([]);
        expect(harness.proposalService.get('proposal-1')).toBeUndefined();
    });

    it('declares risk, confirmation, undo, annotations, and schemas', () => {
        const harness = createHarness();
        const summarize = harness.registry.capabilities.get('nuke.openmc.summarizeSources')!;
        const preview = harness.registry.capabilities.get('nuke.openmc.previewSourceChange')!;
        const apply = harness.registry.capabilities.get('nuke.openmc.applySourceChange')!;

        expect(summarize.id).toBe('nuke.openmc.summarizeSources');
        expect(summarize.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(summarize.risk).toBe('read');
        expect(summarize.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

        expect(preview.id).toBe('nuke.openmc.previewSourceChange');
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
        expect(preview.inputSchema.properties.actions.maxItems).toBe(16);
        expect(preview.outputSchema?.required).toEqual(['proposalId', 'summary', 'changes']);

        expect(apply.id).toBe('nuke.openmc.applySourceChange');
        expect(apply.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(apply.risk).toBe('write');
        expect(apply.requiresConfirmation).toBe(true);
        expect(apply.undoable).toBe(true);
        expect(apply.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        expect(apply.inputSchema).toEqual({
            type: 'object',
            properties: {
                proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewSourceChange.' }
            },
            required: ['proposalId'],
            additionalProperties: false
        });
        expect(apply.outputSchema?.type).toBe('object');
    });
});
