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

import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '@theia/core/lib/common/event';
import URI from '@theia/core/lib/common/uri';
import type { ApplicationShell, Widget } from '@theia/core/lib/browser';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { validateCapability } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import type { OpenMCStatepointInfo, OpenMCTallyInfo } from '../../common/openmc-protocol';
import type { OpenMCContribution } from '../plugins/openmc/openmc-contribution';
import type { OpenMCService } from '../plugins/openmc/openmc-service';
import { VisualizerCapabilities, VisualizerContextContribution } from './visualizer-capabilities';

const context: NukeCapabilityContext = { workspaceRoots: ['/workspace'] };

interface FakeStatepointService {
    readonly service: OpenMCService;
    readonly loadStatepoint: ReturnType<typeof vi.fn>;
    readonly statepointLoaded: Emitter<OpenMCStatepointInfo>;
}

interface FakeDagmcWidget {
    readonly id: string;
    readonly captureScreenshot: ReturnType<typeof vi.fn>;
}

function statepoint(overrides: Partial<OpenMCStatepointInfo> = {}): OpenMCStatepointInfo {
    return {
        file: '/workspace/statepoint.100.h5',
        batches: 50,
        generationsPerBatch: 1000,
        kEff: 1.0042,
        kEffStd: 0.0004,
        nTallies: 2,
        tallyIds: [1, 2],
        ...overrides
    };
}

function tallies(): OpenMCTallyInfo[] {
    return [
        { id: 1, name: 'Flux tally', scores: ['flux'], nuclides: ['total'], filters: [], hasMesh: true },
        { id: 2, name: 'Heating tally', scores: ['heating'], nuclides: ['U235'], filters: [], hasMesh: false }
    ];
}

function healthyTallies(): OpenMCTallyInfo[] {
    return [
        { id: 1, name: 'Flux tally', scores: ['flux'], nuclides: ['total'], filters: [], hasMesh: false },
        { id: 2, name: 'Heating tally', scores: ['heating'], nuclides: ['U235'], filters: [], hasMesh: false }
    ];
}

function issueSummaries(result: NukeCapabilityResult): Array<{ severity: string; code: string }> {
    const data = result.data as { issues: Array<{ severity: string; code: string }> };
    return data.issues.map(({ severity, code }) => ({ severity, code }));
}

function createStatepointService(
    options: { current?: OpenMCStatepointInfo | null; loaded?: OpenMCStatepointInfo | null; currentTallies?: OpenMCTallyInfo[] } = {}
): FakeStatepointService {
    const statepointLoaded = new Emitter<OpenMCStatepointInfo>();
    const loadStatepoint = vi.fn(async () => options.loaded ?? null);
    const service = {
        loadStatepoint,
        getCurrentStatepoint: vi.fn(() => options.current ?? null),
        getCurrentTallies: vi.fn(() => options.currentTallies ?? []),
        onStatepointLoaded: statepointLoaded.event
    } as unknown as OpenMCService;
    return { service, loadStatepoint, statepointLoaded };
}

function createContribution(): { contribution: OpenMCContribution; open: ReturnType<typeof vi.fn> } {
    const open = vi.fn(async () => ({}) as Widget);
    return { contribution: { open } as unknown as OpenMCContribution, open };
}

function createShell(activeWidget?: Widget, mainWidgets: Widget[] = []): ApplicationShell {
    return {
        activeWidget,
        getWidgets: vi.fn(() => mainWidgets)
    } as unknown as ApplicationShell;
}

function createDagmcWidget(
    captureScreenshot: ReturnType<typeof vi.fn> = vi.fn(async () => ({
        dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==',
        mimeType: 'image/png'
    }))
): FakeDagmcWidget {
    return { id: 'dagmc-viewer-widget', captureScreenshot };
}

function otherWidget(id: string): Widget {
    return { id } as Widget;
}

function capabilitiesById(capabilities: VisualizerCapabilities): Map<string, NukeCapability> {
    const registered = new Map<string, NukeCapability>();
    capabilities.registerCapabilities({
        register: (capability: NukeCapability) => registered.set(capability.id, capability)
    } as unknown as NukeCapabilityRegistry);
    return registered;
}

function createCapabilities(
    service: OpenMCService = createStatepointService().service,
    contribution: OpenMCContribution = createContribution().contribution,
    shell: ApplicationShell = createShell()
): VisualizerCapabilities {
    return new VisualizerCapabilities(service, contribution, shell);
}

describe('visualizer capabilities', () => {
    it('registers contract-valid capabilities', () => {
        const capabilities = capabilitiesById(createCapabilities());

        expect([...capabilities.keys()]).toEqual([
            'nuke.viz.summarizeStatepoint',
            'nuke.viz.diagnoseStatepoint',
            'nuke.viz.openStatepoint',
            'nuke.viz.captureView'
        ]);
        for (const capability of capabilities.values()) {
            expect(validateCapability(capability)).toEqual([]);
        }
    });

    it('summarizes the loaded statepoint with its tallies', async () => {
        const info = statepoint();
        const service = createStatepointService({ current: info, currentTallies: tallies() }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.summarizeStatepoint')!.invoke({}, context);

        expect(result).toEqual({
            ok: true,
            data: {
                file: '/workspace/statepoint.100.h5',
                batches: 50,
                generationsPerBatch: 1000,
                kEff: 1.0042,
                kEffStd: 0.0004,
                nTallies: 2,
                tallyIds: [1, 2],
                tallies: [
                    { id: 1, name: 'Flux tally', scores: ['flux'], nuclides: ['total'], hasMesh: true },
                    { id: 2, name: 'Heating tally', scores: ['heating'], nuclides: ['U235'], hasMesh: false }
                ]
            }
        });
    });

    it('reports when no statepoint is loaded', async () => {
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service));

        const result = await capabilities.get('nuke.viz.summarizeStatepoint')!.invoke({}, context);

        expect(result).toEqual({ ok: false, message: 'No statepoint is loaded.' });
    });

    it('summarizes a statepoint loaded from an absolute workspace path', async () => {
        const info = statepoint({ file: '/workspace/runs/statepoint.200.h5', batches: 20 });
        const { service, loadStatepoint } = createStatepointService({ loaded: info, currentTallies: tallies() });
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities
            .get('nuke.viz.summarizeStatepoint')!
            .invoke({ filePath: '/workspace/runs/statepoint.200.h5' }, context);

        expect(loadStatepoint).toHaveBeenCalledTimes(1);
        expect((loadStatepoint.mock.calls[0][0] as URI).path.toString()).toBe('/workspace/runs/statepoint.200.h5');
        expect(result.ok).toBe(true);
        expect((result.data as { file: string }).file).toBe('/workspace/runs/statepoint.200.h5');
    });

    it('rejects relative and outside-workspace statepoint paths', async () => {
        const { service, loadStatepoint } = createStatepointService({ loaded: statepoint() });
        const capabilities = capabilitiesById(createCapabilities(service));
        const summarize = capabilities.get('nuke.viz.summarizeStatepoint')!;

        const relative = await summarize.invoke({ filePath: 'runs/statepoint.100.h5' }, context);
        const outside = await summarize.invoke({ filePath: '/elsewhere/statepoint.100.h5' }, context);

        expect(relative).toEqual({ ok: false, message: 'Statepoint path must be absolute.' });
        expect(outside).toEqual({ ok: false, message: 'Statepoint path must be inside the workspace.' });
        expect(loadStatepoint).not.toHaveBeenCalled();
    });

    it('fails clearly when a statepoint path cannot be loaded', async () => {
        const { service } = createStatepointService({ loaded: null });
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities
            .get('nuke.viz.summarizeStatepoint')!
            .invoke({ filePath: '/workspace/statepoint.100.h5' }, context);

        expect(result).toEqual({ ok: false, message: 'Failed to load statepoint.' });
    });

    it('reports when no statepoint is loaded for diagnosis', async () => {
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(result).toEqual({ ok: false, message: 'No statepoint is loaded.' });
    });

    it('diagnoses a healthy loaded statepoint without findings', async () => {
        const service = createStatepointService({
            current: statepoint({ kEff: 1, kEffStd: 0.0005 }),
            currentTallies: healthyTallies()
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(result).toEqual({
            ok: true,
            data: {
                file: '/workspace/statepoint.100.h5',
                batches: 50,
                generationsPerBatch: 1000,
                kEff: 1,
                kEffStd: 0.0005,
                relativeKeffUncertainty: 0.0005,
                nTallies: 2,
                tallies: [
                    { id: 1, name: 'Flux tally', scores: ['flux'], nuclides: ['total'], hasMesh: false },
                    { id: 2, name: 'Heating tally', scores: ['heating'], nuclides: ['U235'], hasMesh: false }
                ],
                issues: [],
                warnings: []
            }
        });
    });

    it('warns when the relative k-effective uncertainty exceeds 0.5%', async () => {
        const service = createStatepointService({
            current: statepoint({ kEff: 1, kEffStd: 0.01 }),
            currentTallies: healthyTallies()
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(result.ok).toBe(true);
        expect((result.data as { relativeKeffUncertainty: number }).relativeKeffUncertainty).toBeCloseTo(0.01);
        expect(issueSummaries(result)).toEqual([{ severity: 'warning', code: 'high-keff-uncertainty' }]);
        expect((result.data as { warnings: string[] }).warnings[0]).toContain('Relative k-effective uncertainty');
    });

    it('reports the info band for relative k-effective uncertainty above 0.1%', async () => {
        const service = createStatepointService({
            current: statepoint({ kEff: 1, kEffStd: 0.002 }),
            currentTallies: healthyTallies()
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(result.ok).toBe(true);
        expect(issueSummaries(result)).toEqual([{ severity: 'info', code: 'high-keff-uncertainty' }]);
    });

    it('warns about missing k-effective metadata', async () => {
        const service = createStatepointService({
            current: statepoint({ kEff: undefined, kEffStd: undefined }),
            currentTallies: healthyTallies()
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(issueSummaries(result)).toEqual([{ severity: 'warning', code: 'missing-keff' }]);
        expect((result.data as { relativeKeffUncertainty?: number }).relativeKeffUncertainty).toBeUndefined();
    });

    it('warns about few batches and reports few generations', async () => {
        const service = createStatepointService({
            current: statepoint({ batches: 25, generationsPerBatch: 5 }),
            currentTallies: healthyTallies()
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(issueSummaries(result)).toEqual([
            { severity: 'warning', code: 'few-batches' },
            { severity: 'info', code: 'few-generations' }
        ]);
    });

    it('warns when the statepoint has no tallies', async () => {
        const service = createStatepointService({
            current: statepoint({ nTallies: 0, tallyIds: [] }),
            currentTallies: []
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(issueSummaries(result)).toEqual([{ severity: 'warning', code: 'no-tallies' }]);
    });

    it('warns about a tally without scores', async () => {
        const service = createStatepointService({
            current: statepoint({ nTallies: 1, tallyIds: [7] }),
            currentTallies: [{ id: 7, name: 'Empty tally', scores: [], nuclides: ['total'], filters: [], hasMesh: false }]
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(issueSummaries(result)).toEqual([{ severity: 'warning', code: 'tally-no-scores' }]);
        expect((result.data as { issues: Array<{ message: string }> }).issues[0].message).toContain('Tally 7');
    });

    it('reports mesh tallies as an info finding', async () => {
        const service = createStatepointService({
            current: statepoint({ nTallies: 1, tallyIds: [8] }),
            currentTallies: [{ id: 8, name: 'Mesh flux', scores: ['flux'], nuclides: ['total'], filters: [], hasMesh: true }]
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(issueSummaries(result)).toEqual([{ severity: 'info', code: 'mesh-tally' }]);
    });

    it('reports many tallies as an info finding', async () => {
        const tallyIds = Array.from({ length: 21 }, (_, index) => index + 1);
        const service = createStatepointService({
            current: statepoint({ nTallies: 21, tallyIds }),
            currentTallies: []
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);

        expect(issueSummaries(result)).toEqual([{ severity: 'info', code: 'many-tallies' }]);
    });

    it('caps findings at 20 and reports truncation', async () => {
        const currentTallies: OpenMCTallyInfo[] = Array.from({ length: 21 }, (_, index) => ({
            id: index + 1,
            name: `Tally ${index + 1}`,
            scores: [],
            nuclides: [],
            filters: [],
            hasMesh: false
        }));
        const service = createStatepointService({
            current: statepoint({ nTallies: currentTallies.length, tallyIds: currentTallies.map((tally) => tally.id) }),
            currentTallies
        }).service;
        const capabilities = capabilitiesById(createCapabilities(service));

        const result = await capabilities.get('nuke.viz.diagnoseStatepoint')!.invoke({}, context);
        const issues = (result.data as { issues: Array<{ code: string }> }).issues;

        expect(issues).toHaveLength(20);
        expect(issues[19].code).toBe('findings-truncated');
    });

    it('is read-only, always available, and takes no input', () => {
        const capability = capabilitiesById(createCapabilities()).get('nuke.viz.diagnoseStatepoint')!;

        expect(capability.when!(context)).toBe(true);
        expect(capability.risk).toBe('read');
        expect(capability.requiresConfirmation).toBeUndefined();
        expect(capability.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(capability.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    });

    it('opens a statepoint through the OpenMC contribution', async () => {
        const { contribution, open } = createContribution();
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service, contribution));

        const result = await capabilities.get('nuke.viz.openStatepoint')!.invoke({ filePath: '/workspace/statepoint.100.h5' }, context);

        expect(open).toHaveBeenCalledTimes(1);
        expect((open.mock.calls[0][0] as URI).path.toString()).toBe('/workspace/statepoint.100.h5');
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ filePath: '/workspace/statepoint.100.h5', opened: true });
        expect(result.nextActions?.[0].capability).toBe('nuke.viz.captureView');
    });

    it('rejects opening relative and outside-workspace statepoint paths', async () => {
        const { contribution, open } = createContribution();
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service, contribution));
        const openStatepoint = capabilities.get('nuke.viz.openStatepoint')!;
        expect(openStatepoint.risk).toBe('write');
        expect(openStatepoint.requiresConfirmation).toBe(true);

        const relative = await openStatepoint.invoke({ filePath: 'statepoint.100.h5' }, context);
        const outside = await openStatepoint.invoke({ filePath: '/elsewhere/statepoint.100.h5' }, context);

        expect(relative.ok).toBe(false);
        expect(outside.ok).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });

    it('captures the active DAGMC widget and returns a truthful preview', async () => {
        const active = createDagmcWidget(vi.fn(async () => ({ dataUrl: 'data:image/webp;base64,dmlldw==', mimeType: 'image/webp' })));
        const main = createDagmcWidget();
        const shell = createShell(active as unknown as Widget, [main as unknown as Widget]);
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service, undefined, shell));

        const result = await capabilities
            .get('nuke.viz.captureView')!
            .invoke({ format: 'webp', scale: 2, transparent: true, caption: 'Cutaway view' }, context);

        expect(active.captureScreenshot).toHaveBeenCalledWith({ format: 'webp', scale: 2, transparent: true });
        expect(main.captureScreenshot).not.toHaveBeenCalled();
        expect(result).toEqual({
            ok: true,
            message: 'Captured the active DAGMC viewport.',
            preview: {
                kind: 'image',
                data: 'data:image/webp;base64,dmlldw==',
                mimeType: 'image/webp',
                caption: 'Cutaway view',
                truthful: true,
                limitations: ['Captures the visible viewport at the current camera and visibility state.']
            }
        });
    });

    it('falls back to the first DAGMC widget in the main area', async () => {
        const viewer = createDagmcWidget();
        const shell = createShell(undefined, [otherWidget('text-editor'), viewer as unknown as Widget]);
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service, undefined, shell));

        const result = await capabilities.get('nuke.viz.captureView')!.invoke({}, context);

        expect(viewer.captureScreenshot).toHaveBeenCalledWith({ format: 'png', scale: 1, transparent: false });
        expect(result.ok).toBe(true);
        expect(result.preview?.caption).toBe('Active DAGMC viewport');
    });

    it('reports when no DAGMC widget is open', async () => {
        const shell = createShell(undefined, [otherWidget('text-editor')]);
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service, undefined, shell));

        const result = await capabilities.get('nuke.viz.captureView')!.invoke({}, context);

        expect(result).toEqual({ ok: false, message: 'Open a DAGMC viewer before capturing the view.' });
    });

    it('propagates a widget capture failure', async () => {
        const viewer = createDagmcWidget(
            vi.fn(async () => {
                throw new Error('WebGL context lost');
            })
        );
        const shell = createShell(viewer as unknown as Widget);
        const capabilities = capabilitiesById(createCapabilities(createStatepointService().service, undefined, shell));

        const result = await capabilities.get('nuke.viz.captureView')!.invoke({}, context);

        expect(result).toEqual({ ok: false, message: 'WebGL context lost' });
    });

    it('exposes the current statepoint as ambient context and fires on load', () => {
        const info = statepoint();
        const { service, statepointLoaded } = createStatepointService({ current: info });
        const contribution = new VisualizerContextContribution(service);
        const listener = vi.fn();
        const disposable = contribution.onDidChangeContext!(listener);

        expect(contribution.getContext()).toEqual({ activeDataset: info.file });
        statepointLoaded.fire(info);
        expect(listener).toHaveBeenCalledTimes(1);

        disposable.dispose();
    });

    it('omits the ambient dataset when no statepoint is loaded', () => {
        const contribution = new VisualizerContextContribution(createStatepointService().service);

        expect(contribution.getContext()).toEqual({ activeDataset: undefined });
    });
});
