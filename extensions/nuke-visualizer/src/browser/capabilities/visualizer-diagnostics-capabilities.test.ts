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
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { validateCapability } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import type {
    OpenMCBackendService,
    OpenMCTallyInfo,
    OpenMCTallySeries,
    OpenMCTallySeriesOptions,
    OpenMCStatepointInfo
} from '../../common/openmc-protocol';
import type { OpenMCService } from '../plugins/openmc/openmc-service';
import { MAX_TALLY_SERIES_FILES, VisualizerDiagnosticsCapabilities } from './visualizer-diagnostics-capabilities';

const context: NukeCapabilityContext = { workspaceRoots: ['/workspace'] };
const FILE_A = '/workspace/run-a/statepoint.100.h5';
const FILE_B = '/workspace/run-b/statepoint.100.h5';

interface FakeBackend {
    readonly service: OpenMCBackendService;
    readonly loadStatepoint: ReturnType<typeof vi.fn>;
    readonly listTallies: ReturnType<typeof vi.fn>;
    readonly getTallySeries: ReturnType<typeof vi.fn>;
}

interface FakeBackendOptions {
    readonly loadStatepoint?: (filePath: string) => Promise<OpenMCStatepointInfo>;
    readonly listTallies?: (filePath: string) => Promise<OpenMCTallyInfo[]>;
    readonly getTallySeries?: (files: string[], options: OpenMCTallySeriesOptions) => Promise<OpenMCTallySeries>;
}

function statepoint(overrides: Partial<OpenMCStatepointInfo> = {}): OpenMCStatepointInfo {
    return {
        file: FILE_A,
        batches: 50,
        generationsPerBatch: 1000,
        kEff: 1,
        kEffStd: 0.0005,
        nTallies: 2,
        tallyIds: [1, 2],
        ...overrides
    };
}

function tally(overrides: Partial<OpenMCTallyInfo> = {}): OpenMCTallyInfo {
    return { id: 1, name: 'Flux tally', scores: ['flux'], nuclides: ['total'], filters: [], hasMesh: false, ...overrides };
}

function seriesStep(index: number, overrides: Partial<OpenMCTallySeries['steps'][number]> = {}): OpenMCTallySeries['steps'][number] {
    return {
        index,
        time: (index + 1) * 100,
        file: `/workspace/run/statepoint.${(index + 1) * 100}.h5`,
        fileName: `statepoint.${(index + 1) * 100}.h5`,
        value: 1,
        std: 0.01,
        nBins: 4,
        ...overrides
    };
}

function series(overrides: Partial<OpenMCTallySeries> = {}): OpenMCTallySeries {
    return {
        files: [FILE_A],
        tallyId: 1,
        tallyName: 'Flux tally',
        score: 'flux',
        nuclide: 'total',
        statistic: 'total',
        timeLabel: 'Batch',
        steps: [seriesStep(0)],
        range: [1, 1],
        hasMesh: false,
        volumeWeighted: false,
        ...overrides
    };
}

function createBackend(options: FakeBackendOptions = {}): FakeBackend {
    const loadStatepoint = vi.fn(options.loadStatepoint ?? (async (filePath: string) => statepoint({ file: filePath })));
    const listTallies = vi.fn(options.listTallies ?? (async () => [tally()]));
    const getTallySeries = vi.fn(options.getTallySeries ?? (async () => series()));
    const service = {
        loadStatepoint,
        listTallies,
        getTallySeries
    } as unknown as OpenMCBackendService;
    return { service, loadStatepoint, listTallies, getTallySeries };
}

function capabilitiesById(capabilities: VisualizerDiagnosticsCapabilities): Map<string, NukeCapability> {
    const registered = new Map<string, NukeCapability>();
    capabilities.registerCapabilities({
        register: (capability: NukeCapability) => registered.set(capability.id, capability)
    } as unknown as NukeCapabilityRegistry);
    return registered;
}

function createCapabilities(backend: OpenMCBackendService = createBackend().service): Map<string, NukeCapability> {
    return capabilitiesById(new VisualizerDiagnosticsCapabilities(backend));
}

function issueSummaries(result: NukeCapabilityResult): Array<{ severity: string; code: string }> {
    const data = result.data as { issues: Array<{ severity: string; code: string }> };
    return data.issues.map(({ severity, code }) => ({ severity, code }));
}

describe('visualizer diagnostics capabilities', () => {
    it('registers contract-valid read-only capabilities', () => {
        const capabilities = createCapabilities();

        expect([...capabilities.keys()]).toEqual(['nuke.viz.compareStatepoints', 'nuke.viz.analyzeTallySeries']);
        for (const capability of capabilities.values()) {
            expect(validateCapability(capability)).toEqual([]);
            expect(capability.risk).toBe('read');
            expect(capability.requiresConfirmation).toBeUndefined();
            expect(capability.when!(context)).toBe(true);
            expect(capability.annotations).toEqual({
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            });
            expect(capability.outputSchema).toBeDefined();
            expect(capability.examples?.length).toBeGreaterThan(0);
        }
    });

    it('caps tally-series input files at 50', () => {
        const capability = createCapabilities().get('nuke.viz.analyzeTallySeries')!;

        expect((capability.inputSchema.properties.files as { minItems?: number; maxItems?: number }).maxItems).toBe(MAX_TALLY_SERIES_FILES);
        expect(MAX_TALLY_SERIES_FILES).toBe(50);
    });

    it('compares two healthy statepoints without findings', async () => {
        const backend = createBackend();
        const capabilities = createCapabilities(backend.service);

        const result = await capabilities.get('nuke.viz.compareStatepoints')!.invoke({ fileA: FILE_A, fileB: FILE_B }, context);

        expect(backend.loadStatepoint.mock.calls.map((call) => call[0])).toEqual([FILE_A, FILE_B]);
        expect(backend.listTallies).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(true);
        const data = result.data as { a: { file: string }; issues: unknown[]; delta: { tallyIdsAdded: number[] } };
        expect(data.a).toMatchObject({ batches: 50, tallyIds: [1, 2] });
        expect(data.issues).toEqual([]);
        expect(data.delta.tallyIdsAdded).toEqual([]);
    });

    it('warns about a missing k-effective and a small shift', async () => {
        const missing = createBackend({
            loadStatepoint: async (filePath) =>
                filePath === FILE_B ? statepoint({ file: filePath, kEff: undefined, kEffStd: undefined }) : statepoint({ file: filePath })
        });
        const shifted = createBackend({
            loadStatepoint: async (filePath) =>
                filePath === FILE_B ? statepoint({ file: filePath, kEff: 1.02 }) : statepoint({ file: filePath })
        });

        const missingResult = await createCapabilities(missing.service)
            .get('nuke.viz.compareStatepoints')!
            .invoke({ fileA: FILE_A, fileB: FILE_B }, context);
        const shiftedResult = await createCapabilities(shifted.service)
            .get('nuke.viz.compareStatepoints')!
            .invoke({ fileA: FILE_A, fileB: FILE_B }, context);

        expect(issueSummaries(missingResult)).toEqual([{ severity: 'warning', code: 'missing-keff' }]);
        expect(issueSummaries(shiftedResult)).toEqual([{ severity: 'warning', code: 'keff-shift' }]);
    });

    it('reports a large k-effective shift as an error', async () => {
        const backend = createBackend({
            loadStatepoint: async (filePath) =>
                filePath === FILE_B ? statepoint({ file: filePath, kEff: 1.1 }) : statepoint({ file: filePath })
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.compareStatepoints')!
            .invoke({ fileA: FILE_A, fileB: FILE_B }, context);

        expect(result.ok).toBe(true);
        expect(issueSummaries(result)).toEqual([{ severity: 'error', code: 'keff-shift' }]);
        expect((result.data as { warnings: string[] }).warnings).toEqual([]);
    });

    it('reports batch and tally set differences', async () => {
        const backend = createBackend({
            loadStatepoint: async (filePath) =>
                filePath === FILE_B
                    ? statepoint({ file: filePath, batches: 80, tallyIds: [2, 3], nTallies: 2 })
                    : statepoint({ file: filePath }),
            listTallies: async (filePath) =>
                filePath === FILE_B
                    ? [tally({ id: 2, name: 'Heating tally' }), tally({ id: 3, name: 'Fission tally' })]
                    : [tally({ id: 1, name: 'Flux tally' }), tally({ id: 2, name: 'Heating tally' })]
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.compareStatepoints')!
            .invoke({ fileA: FILE_A, fileB: FILE_B }, context);

        expect(issueSummaries(result)).toEqual([
            { severity: 'info', code: 'batch-count-diff' },
            { severity: 'info', code: 'tally-set-diff' }
        ]);
        const data = result.data as { delta: { batches: number; tallyIdsAdded: number[]; tallyIdsRemoved: number[] } };
        expect(data.delta).toEqual({ batches: 30, kEff: 0, kEffStd: 0, tallyIdsAdded: [3], tallyIdsRemoved: [1] });
        const issues = (result.data as { issues: Array<{ message: string }> }).issues;
        expect(issues[1].message).toContain('3 (Fission tally)');
        expect(issues[1].message).toContain('1 (Flux tally)');
    });

    it('fails clearly when the first statepoint cannot be loaded and does not read the second', async () => {
        const backend = createBackend({
            loadStatepoint: async () => {
                throw new Error('unreadable statepoint');
            }
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.compareStatepoints')!
            .invoke({ fileA: FILE_A, fileB: FILE_B }, context);

        expect(result).toEqual({ ok: false, message: 'Failed to load fileA: unreadable statepoint' });
        expect(backend.loadStatepoint).toHaveBeenCalledTimes(1);
        expect(backend.listTallies).not.toHaveBeenCalled();
    });

    it('fails clearly when the second statepoint returns no metadata', async () => {
        const backend = createBackend({
            loadStatepoint: async (filePath) =>
                filePath === FILE_B ? (undefined as unknown as OpenMCStatepointInfo) : statepoint({ file: filePath })
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.compareStatepoints')!
            .invoke({ fileA: FILE_A, fileB: FILE_B }, context);

        expect(result).toEqual({ ok: false, message: 'Failed to load fileB.' });
        expect(backend.listTallies).not.toHaveBeenCalled();
    });

    it('keeps the comparison when tally listing fails and reports the warning', async () => {
        const backend = createBackend({
            listTallies: async () => {
                throw new Error('tally metadata unavailable');
            }
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.compareStatepoints')!
            .invoke({ fileA: FILE_A, fileB: FILE_B }, context);

        expect(result.ok).toBe(true);
        expect((result.data as { warnings: string[] }).warnings).toEqual([
            'Could not list tallies for fileA: tally metadata unavailable',
            'Could not list tallies for fileB: tally metadata unavailable'
        ]);
    });

    it('rejects missing, relative, and outside-workspace comparison paths', async () => {
        const backend = createBackend();
        const compare = createCapabilities(backend.service).get('nuke.viz.compareStatepoints')!;

        const missing = await compare.invoke({ fileB: FILE_B }, context);
        const relative = await compare.invoke({ fileA: 'run-a/statepoint.100.h5', fileB: FILE_B }, context);
        const outside = await compare.invoke({ fileA: FILE_A, fileB: '/elsewhere/statepoint.100.h5' }, context);

        expect(missing).toEqual({ ok: false, message: 'fileA is required.' });
        expect(relative).toEqual({ ok: false, message: 'fileA must be an absolute path.' });
        expect(outside).toEqual({ ok: false, message: 'fileB must be inside the workspace.' });
        expect(backend.loadStatepoint).not.toHaveBeenCalled();
    });

    it('analyzes a single-step tally series and reports the missing trend', async () => {
        const backend = createBackend();

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.analyzeTallySeries')!
            .invoke({ files: [FILE_A], tallyId: 1 }, context);

        expect(backend.getTallySeries).toHaveBeenCalledWith([FILE_A], { tallyId: 1, statistic: 'total' });
        expect(result.ok).toBe(true);
        expect(issueSummaries(result)).toEqual([{ severity: 'info', code: 'single-step' }]);
        const data = result.data as { steps: unknown[]; tallyName: string; timeLabel: string };
        expect(data.steps).toHaveLength(1);
        expect(data.tallyName).toBe('Flux tally');
        expect(data.timeLabel).toBe('Batch');
    });

    it('passes score, nuclide, and statistic through to the backend', async () => {
        const backend = createBackend({
            getTallySeries: async (files, options) => series({ files, ...options, statistic: options.statistic ?? 'total' })
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.analyzeTallySeries')!
            .invoke({ files: [FILE_A, FILE_B], tallyId: 2, score: 'heating', nuclide: 'U235', statistic: 'mean' }, context);

        expect(backend.getTallySeries).toHaveBeenCalledWith([FILE_A, FILE_B], {
            tallyId: 2,
            score: 'heating',
            nuclide: 'U235',
            statistic: 'mean'
        });
        expect((result.data as { statistic: string }).statistic).toBe('mean');
    });

    it('reports empty bins, high uncertainty, and worsening uncertainty', async () => {
        const backend = createBackend({
            getTallySeries: async () =>
                series({
                    steps: [
                        seriesStep(0, { nBins: 0, value: 1, std: 0.05 }),
                        seriesStep(1, { value: 1, std: 0.2 }),
                        seriesStep(2, { value: 1, std: 0.4 })
                    ]
                })
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.analyzeTallySeries')!
            .invoke({ files: [FILE_A, FILE_B], tallyId: 1 }, context);

        expect(issueSummaries(result)).toEqual([
            { severity: 'warning', code: 'empty-bins' },
            { severity: 'warning', code: 'high-uncertainty' },
            { severity: 'error', code: 'high-uncertainty' },
            { severity: 'warning', code: 'worsening-uncertainty' }
        ]);
        expect(result.ok).toBe(true);
        expect((result.data as { warnings: string[] }).warnings).toHaveLength(3);
    });

    it('reports a mesh tally as an info finding', async () => {
        const backend = createBackend({ getTallySeries: async () => series({ hasMesh: true }) });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.analyzeTallySeries')!
            .invoke({ files: [FILE_A], tallyId: 1 }, context);

        expect(issueSummaries(result)).toEqual([
            { severity: 'info', code: 'mesh-tally' },
            { severity: 'info', code: 'single-step' }
        ]);
    });

    it('reports a series with no steps as an error finding but keeps ok', async () => {
        const backend = createBackend({ getTallySeries: async () => series({ steps: [], range: [0, 0] }) });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.analyzeTallySeries')!
            .invoke({ files: [FILE_A], tallyId: 1 }, context);

        expect(result.ok).toBe(true);
        expect(issueSummaries(result)).toEqual([{ severity: 'error', code: 'no-steps' }]);
        expect((result.data as { steps: unknown[] }).steps).toEqual([]);
    });

    it('fails clearly when the tally series backend throws', async () => {
        const backend = createBackend({
            getTallySeries: async () => {
                throw new Error('openmc is not installed');
            }
        });

        const result = await createCapabilities(backend.service)
            .get('nuke.viz.analyzeTallySeries')!
            .invoke({ files: [FILE_A], tallyId: 1 }, context);

        expect(result).toEqual({ ok: false, message: 'openmc is not installed' });
    });

    it('rejects empty, oversized, non-string, relative, and outside-workspace file lists', async () => {
        const backend = createBackend();
        const analyze = createCapabilities(backend.service).get('nuke.viz.analyzeTallySeries')!;
        const manyFiles = Array.from({ length: MAX_TALLY_SERIES_FILES + 1 }, (_, index) => `/workspace/statepoint.${index}.h5`);

        const empty = await analyze.invoke({ files: [], tallyId: 1 }, context);
        const oversized = await analyze.invoke({ files: manyFiles, tallyId: 1 }, context);
        const nonString = await analyze.invoke({ files: [FILE_A, 7], tallyId: 1 }, context);
        const relative = await analyze.invoke({ files: ['statepoint.100.h5'], tallyId: 1 }, context);
        const outside = await analyze.invoke({ files: [FILE_A, '/elsewhere/statepoint.100.h5'], tallyId: 1 }, context);

        expect(empty.ok).toBe(false);
        expect(oversized).toEqual({ ok: false, message: 'At most 50 statepoint files can be analyzed.' });
        expect(nonString.ok).toBe(false);
        expect(relative).toEqual({ ok: false, message: 'files[0] must be an absolute path.' });
        expect(outside).toEqual({ ok: false, message: 'files[1] must be inside the workspace.' });
        expect(backend.getTallySeries).not.toHaveBeenCalled();
    });

    it('rejects a missing tally id and an unsupported statistic', async () => {
        const backend = createBackend();
        const analyze = createCapabilities(backend.service).get('nuke.viz.analyzeTallySeries')!;

        const missing = await analyze.invoke({ files: [FILE_A] }, context);
        const invalid = await analyze.invoke({ files: [FILE_A], tallyId: 1, statistic: 'median' }, context);

        expect(missing).toEqual({ ok: false, message: 'tallyId must be an integer.' });
        expect(invalid).toEqual({ ok: false, message: 'statistic must be total, mean, or max.' });
        expect(backend.getTallySeries).not.toHaveBeenCalled();
    });

    it('never changes the active statepoint through OpenMCService', async () => {
        const loadStatepointSpy = vi.fn(async () => null);
        const openmcService = {
            loadStatepoint: loadStatepointSpy,
            getCurrentStatepoint: vi.fn(() => null),
            getCurrentTallies: vi.fn(() => [])
        } as unknown as OpenMCService;
        const backend = createBackend();
        const capabilities = createCapabilities(backend.service);

        await capabilities.get('nuke.viz.compareStatepoints')!.invoke({ fileA: FILE_A, fileB: FILE_B }, context);
        await capabilities.get('nuke.viz.analyzeTallySeries')!.invoke({ files: [FILE_A], tallyId: 1 }, context);

        expect(openmcService.loadStatepoint).not.toHaveBeenCalled();
        expect(openmcService.getCurrentStatepoint).not.toHaveBeenCalled();
        expect(backend.loadStatepoint).toHaveBeenCalledTimes(2);
        expect(backend.getTallySeries).toHaveBeenCalledTimes(1);
    });
});
