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
 * Tests the OpenMC capability handlers against fake services: no Theia boot,
 * no OpenMC process, and no AI runtime.
 */

import { describe, expect, it, vi } from 'vitest';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { URI } from '@theia/core/lib/common/uri';

// Keep the suite in the Node environment: these services pull in browser DOM modules.
vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('../openmc-state-manager', () => ({ OpenMCStateManager: class OpenMCStateManager {} }));
vi.mock('../services/openmc-environment-service', () => ({ OpenMCEnvironmentService: class OpenMCEnvironmentService {} }));
vi.mock('../widgets/simulation-dashboard/simulation-runner', () => ({ OpenMCSimulationRunner: class OpenMCSimulationRunner {} }));
vi.mock('../xml-generator/xml-generation-service', () => ({ OpenMCXMLGenerationService: class OpenMCXMLGenerationService {} }));

import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { NukeCoreService } from 'nuke-core/lib/common';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type { DAGMCInfo, OpenMCMaterial, OpenMCSettings, OpenMCState } from '../../common/openmc-state-schema';
import { IFP_SCORES } from '../../common/kinetics-ifp';
import type {
    ActiveSimulationInfo,
    NukeCADImportRequest,
    NukeCADImportResult,
    OpenMCStudioBackendService,
    SimulationLogResult,
    SimulationRunRequest,
    StartSimulationResponse,
    ValidationIssue,
    ValidationRequest,
    ValidationResult,
    XMLGenerationRequest,
    XMLGenerationResult
} from '../../common/openmc-studio-protocol';
import type { OpenMCStateManager } from '../openmc-state-manager';
import type { OpenMCEnvironmentService, OpenMCEnvironmentStatus } from '../services/openmc-environment-service';
import type { OpenMCSimulationRunner } from '../widgets/simulation-dashboard/simulation-runner';
import type { OpenMCXMLGenerationService } from '../xml-generator/xml-generation-service';
import { OpenMCCapabilities, OpenMCContextContribution } from './openmc-capabilities';
import { OpenMCChangeProposalService } from './openmc-change-proposal-service';
import { SUPPORTED_SETTINGS_PATHS } from './openmc-settings-edit';

const WORKSPACE = '/workspace';

function buildState(): OpenMCState {
    const now = '2026-01-01T00:00:00.000Z';
    return {
        metadata: { version: '1.1.0', name: 'Pincell', description: 'Demo project', created: now, modified: now },
        geometry: {
            surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 5 }, boundary: 'vacuum' }],
            cells: [{ id: 1, fillType: 'material', fillId: 1, regionString: '-1' }],
            universes: [{ id: 0, name: 'root', cellIds: [1] }],
            lattices: [],
            rootUniverseId: 0
        },
        materials: [
            {
                id: 1,
                name: 'Water',
                density: 1.0,
                densityUnit: 'g/cm3',
                nuclides: [{ name: 'H1', fraction: 2.0, fractionType: 'ao' }],
                thermalScattering: []
            }
        ],
        settings: {
            run: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 },
            sources: []
        },
        tallies: [],
        meshes: []
    };
}

function buildAdvancedState(): OpenMCState {
    const state = buildState();
    state.settings.output = { summary: false, tallies: true, path: 'runs/out' };
    state.settings.cutoff = { energyNeutron: 1e-5, time: 1 };
    state.settings.kinetics = { enabled: true, ifpNGenerations: 4, numPrecursorGroups: 6, computeBetaEff: true };
    state.tallies = [
        { id: 1, scores: [IFP_SCORES.timeNumerator], nuclides: [], filters: [] },
        { id: 2, scores: [IFP_SCORES.betaNumerator], nuclides: [], filters: [] },
        { id: 3, scores: [IFP_SCORES.denominator], nuclides: [], filters: [] }
    ];
    return state;
}

function buildDagmcInfo(): DAGMCInfo {
    return {
        filePath: '/workspace/model.h5m',
        fileName: 'model.h5m',
        volumeCount: 2,
        surfaceCount: 3,
        vertices: 4,
        materials: {},
        volumes: [],
        boundingBox: { min: [0, 0, 0], max: [1, 1, 1] }
    };
}

class FakeStateManager {
    dirty = false;
    addedMaterials: OpenMCMaterial[] = [];
    settingsUpdates: Array<Partial<OpenMCSettings>> = [];
    protected readonly projectPathEmitter = new Emitter<string | undefined>();

    readonly onProjectPathChange = this.projectPathEmitter.event;

    constructor(
        public state: OpenMCState,
        protected projectPathValue?: string
    ) {}

    getState(): OpenMCState {
        return JSON.parse(JSON.stringify(this.state));
    }

    get isDirty(): boolean {
        return this.dirty;
    }

    get projectPath(): string | undefined {
        return this.projectPathValue;
    }

    setProjectPath(value: string | undefined): void {
        this.projectPathValue = value;
        this.projectPathEmitter.fire(value);
    }

    getNextMaterialId(): number {
        const ids = this.state.materials.map((material) => material.id);
        return ids.length > 0 ? Math.max(...ids) + 1 : 1;
    }

    addMaterial(material: OpenMCMaterial): void {
        this.state.materials.push(material);
        this.addedMaterials.push(material);
    }

    updateSettings(updates: Partial<OpenMCSettings>): void {
        this.settingsUpdates.push(updates);
        this.state.settings = { ...this.state.settings, ...updates };
    }
}

class FakeBackend {
    validation: ValidationResult = { valid: true, issues: [], summary: { errors: 0, warnings: 0, info: 0 } };
    importResult: NukeCADImportResult = { success: true };
    active: ActiveSimulationInfo[] = [];
    log: SimulationLogResult = { success: true, logPath: '/workspace/logs/openmc.log', logContent: '' };
    fileCheck: { exists: boolean; size?: number; error?: string } = { exists: true };

    validateState = vi.fn(async (_request: ValidationRequest): Promise<ValidationResult> => this.validation);
    importNukeCAD = vi.fn(async (_request: NukeCADImportRequest): Promise<NukeCADImportResult> => this.importResult);
    checkFileExists = vi.fn(async (_filePath: string): Promise<{ exists: boolean; size?: number; error?: string }> => this.fileCheck);
    getActiveSimulations = vi.fn(async (): Promise<ActiveSimulationInfo[]> => this.active);
    getSimulationLog = vi.fn(async (_processId: string): Promise<SimulationLogResult> => this.log);
}

class FakeXmlService {
    result: XMLGenerationResult = {
        success: true,
        generatedFiles: ['/workspace/materials.xml', '/workspace/settings.xml', '/workspace/geometry.xml'],
        warnings: ['xml warning']
    };

    generateXML = vi.fn(async (_request: XMLGenerationRequest): Promise<XMLGenerationResult> => this.result);
}

class FakeEnvironmentService {
    status: OpenMCEnvironmentStatus = { ready: true };

    refreshStatus = vi.fn(async (): Promise<OpenMCEnvironmentStatus> => this.status);
    isReady = vi.fn((): boolean => this.status.ready);
    getStatus = vi.fn((): OpenMCEnvironmentStatus => this.status);
}

class FakeRunner {
    response: StartSimulationResponse = { success: true, processId: 'p1' };
    runSimulation = vi.fn(async (_request: SimulationRunRequest): Promise<StartSimulationResponse> => this.response);
}

class FakeNukeCoreService {
    getCrossSectionsPath = vi.fn((): string | undefined => '/data/cross_sections.xml');
}

class FakeFileService {
    readonly existingPaths = new Set<string>(['/data/cross_sections.xml']);

    exists = vi.fn(async (uri: URI): Promise<boolean> => this.existingPaths.has(uri.path.toString()));
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

interface Harness {
    stateManager: FakeStateManager;
    backend: FakeBackend;
    xmlService: FakeXmlService;
    environment: FakeEnvironmentService;
    runner: FakeRunner;
    nukeCore: FakeNukeCoreService;
    fileService: FakeFileService;
    proposalService: TestProposalService;
    undoService: FakeUndoService;
    registry: FakeRegistry;
    invoke(id: string, input: unknown, workspaceRoots?: readonly string[]): Promise<NukeCapabilityResult>;
}

function createHarness(options: { state?: OpenMCState; projectPath?: string } = {}): Harness {
    const stateManager = new FakeStateManager(options.state ?? buildState(), options.projectPath);
    const backend = new FakeBackend();
    const xmlService = new FakeXmlService();
    const environment = new FakeEnvironmentService();
    const runner = new FakeRunner();
    const nukeCore = new FakeNukeCoreService();
    const fileService = new FakeFileService();
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const registry = new FakeRegistry();
    const capabilities = new OpenMCCapabilities(
        stateManager as unknown as OpenMCStateManager,
        backend as unknown as OpenMCStudioBackendService,
        xmlService as unknown as OpenMCXMLGenerationService,
        environment as unknown as OpenMCEnvironmentService,
        runner as unknown as OpenMCSimulationRunner,
        nukeCore as unknown as NukeCoreService,
        fileService as unknown as FileService,
        proposalService,
        undoService
    );
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        backend,
        xmlService,
        environment,
        runner,
        nukeCore,
        fileService,
        proposalService,
        undoService,
        registry,
        invoke: (id, input, workspaceRoots = [WORKSPACE]) => {
            const capability = registry.get(id);
            if (!capability) {
                throw new Error(`Missing capability ${id}`);
            }
            return capability.invoke(input, { workspaceRoots });
        }
    };
}

function activeRun(processId: string, workingDirectory: string): ActiveSimulationInfo {
    return {
        processId,
        workingDirectory,
        logFilePath: `${workingDirectory}/openmc.log`,
        startTime: `start-${processId}`
    };
}

describe('OpenMC capabilities', () => {
    it('summarizes project counts, settings, and dirty state', async () => {
        const harness = createHarness({ projectPath: '/workspace/pincell.nuke-openmc' });
        harness.stateManager.dirty = true;

        const result = await harness.invoke('nuke.openmc.summarizeProject', {});

        expect(result).toEqual({
            ok: true,
            data: {
                projectPath: '/workspace/pincell.nuke-openmc',
                name: 'Pincell',
                description: 'Demo project',
                dirty: true,
                counts: { surfaces: 1, cells: 1, universes: 1, lattices: 0, materials: 1, tallies: 0, meshes: 0 },
                settings: { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 }
            }
        });
        expect(harness.registry.capabilities.get('nuke.openmc.summarizeProject')?.risk).toBe('read');
    });

    it('passes validation through and mirrors valid into ok', async () => {
        const harness = createHarness();
        const invalid: ValidationResult = {
            valid: false,
            issues: [{ severity: 'error', category: 'geometry', message: 'Cell 1 is empty.' }],
            summary: { errors: 1, warnings: 2, info: 0 }
        };
        harness.backend.validation = invalid;

        const result = await harness.invoke('nuke.openmc.validateProject', {
            level: 'strict',
            checks: { geometry: true, tallies: false, unknown: true }
        });

        expect(result.ok).toBe(false);
        expect(result.data).toEqual(invalid);
        expect(result.message).toContain('1 error');
        expect(result.message).toContain('2 warning');
        expect(harness.backend.validateState).toHaveBeenCalledWith({
            state: harness.stateManager.getState(),
            level: 'strict',
            checks: { geometry: true, tallies: false }
        });

        harness.backend.validation = { valid: true, issues: [], summary: { errors: 0, warnings: 0, info: 0 } };
        const validResult = await harness.invoke('nuke.openmc.validateProject', {});
        expect(validResult.ok).toBe(true);
        expect(harness.backend.validateState).toHaveBeenLastCalledWith({
            state: harness.stateManager.getState(),
            level: 'standard'
        });
    });

    it('imports DAGMC models and creates placeholders only for missing materials', async () => {
        const harness = createHarness();
        const dagmcInfo = buildDagmcInfo();
        harness.backend.importResult = {
            success: true,
            dagmcFile: '/workspace/model.h5m',
            dagmcInfo,
            materialNames: ['Water', 'Steel'],
            materialLinks: [
                { selector: 'vol:1', material: 'Steel', materialId: 'uuid-steel', parentId: 'uuid-parent' },
                { selector: 'vol:2', material: 'Water' }
            ],
            warnings: ['manifest warning'],
            manifest: { version: 1, volumes: [], surfaces: [] }
        };

        const result = await harness.invoke('nuke.openmc.importCad', {
            h5mPath: '/workspace/model.h5m',
            manifestPath: '/workspace/model.regions.json'
        });

        expect(result.ok).toBe(true);
        expect(harness.backend.importNukeCAD).toHaveBeenCalledWith({
            h5mPath: '/workspace/model.h5m',
            manifestPath: '/workspace/model.regions.json'
        });
        expect(harness.stateManager.addedMaterials).toEqual([
            {
                id: 2,
                name: 'Steel',
                density: 1.0,
                densityUnit: 'g/cm3',
                nuclides: [],
                thermalScattering: [],
                nukeCadMaterialId: 'uuid-steel',
                nukeCadParentId: 'uuid-parent'
            }
        ]);
        expect(harness.stateManager.settingsUpdates).toEqual([{ dagmcFile: '/workspace/model.h5m', dagmcInfo }]);
        expect(result.data).toMatchObject({
            dagmcFile: '/workspace/model.h5m',
            materialNames: ['Water', 'Steel'],
            createdMaterials: ['Steel'],
            warnings: ['manifest warning']
        });
        expect(result.nextActions?.map((action) => action.capability)).toEqual([
            'nuke.openmc.validateProject',
            'nuke.openmc.runSimulation'
        ]);
        expect(harness.registry.capabilities.get('nuke.openmc.importCad')?.requiresConfirmation).toBe(true);
    });

    it('rejects relative and outside-workspace CAD paths before importing', async () => {
        const harness = createHarness();

        const relative = await harness.invoke('nuke.openmc.importCad', { h5mPath: 'model.h5m' });
        expect(relative.ok).toBe(false);
        expect(relative.message).toContain('absolute path inside the workspace');

        const outside = await harness.invoke('nuke.openmc.importCad', { h5mPath: '/other/model.h5m' });
        expect(outside.ok).toBe(false);

        const outsideManifest = await harness.invoke('nuke.openmc.importCad', {
            h5mPath: '/workspace/model.h5m',
            manifestPath: '/other/model.regions.json'
        });
        expect(outsideManifest.ok).toBe(false);
        expect(outsideManifest.message).toContain('manifestPath');

        expect(harness.backend.importNukeCAD).not.toHaveBeenCalled();
    });

    it('reports backend CAD import failures', async () => {
        const harness = createHarness();
        harness.backend.importResult = { success: false, error: 'pydagmc missing' };

        const result = await harness.invoke('nuke.openmc.importCad', { h5mPath: '/workspace/model.h5m' });

        expect(result).toEqual({ ok: false, message: 'pydagmc missing' });
        expect(harness.stateManager.addedMaterials).toEqual([]);
        expect(harness.stateManager.settingsUpdates).toEqual([]);
    });

    it('validates before starting a run and returns the process id', async () => {
        const harness = createHarness({ projectPath: '/workspace/pincell.nuke-openmc' });

        const result = await harness.invoke('nuke.openmc.runSimulation', {});

        expect(result.ok).toBe(true);
        expect(harness.backend.validateState).toHaveBeenCalledWith({
            state: harness.stateManager.getState(),
            level: 'standard'
        });
        expect(harness.backend.validateState.mock.invocationCallOrder[0]).toBeLessThan(
            harness.xmlService.generateXML.mock.invocationCallOrder[0]
        );
        expect(harness.xmlService.generateXML.mock.invocationCallOrder[0]).toBeLessThan(
            harness.runner.runSimulation.mock.invocationCallOrder[0]
        );
        const xmlRequest = harness.xmlService.generateXML.mock.calls[0][0];
        expect(xmlRequest.outputDirectory).toBe('/workspace');
        expect(xmlRequest.projectDirectory).toBe('/workspace');
        expect(xmlRequest.files).toEqual({ materials: true, settings: true, geometry: true, tallies: false, plots: false });
        expect(xmlRequest.crossSectionsPath).toBe('/data/cross_sections.xml');
        expect(harness.runner.runSimulation).toHaveBeenCalledWith({ workingDirectory: '/workspace' });
        expect(result.data).toEqual({
            workingDirectory: '/workspace',
            processId: 'p1',
            generatedFiles: ['/workspace/materials.xml', '/workspace/settings.xml', '/workspace/geometry.xml'],
            warnings: ['xml warning']
        });
        expect(result.nextActions).toEqual([{ capability: 'nuke.openmc.getRunStatus', reason: 'Poll the run until it completes.' }]);
    });

    it('refuses invalid models before generating XML', async () => {
        const harness = createHarness({ projectPath: '/workspace/pincell.nuke-openmc' });
        harness.backend.validation = {
            valid: false,
            issues: [{ severity: 'error', category: 'materials', message: 'Material 1 has no nuclides.' }],
            summary: { errors: 1, warnings: 0, info: 0 }
        };

        const result = await harness.invoke('nuke.openmc.runSimulation', {});

        expect(result.ok).toBe(false);
        expect(result.message).toBe('Validation failed.');
        expect(result.data).toEqual({ issues: harness.backend.validation.issues });
        expect(harness.xmlService.generateXML).not.toHaveBeenCalled();
        expect(harness.runner.runSimulation).not.toHaveBeenCalled();
    });

    it('refuses to run when the environment is not ready', async () => {
        const harness = createHarness({ projectPath: '/workspace/pincell.nuke-openmc' });
        harness.environment.status = { ready: false, error: 'OpenMC not installed in ide' };

        const result = await harness.invoke('nuke.openmc.runSimulation', {});

        expect(result).toEqual({ ok: false, message: 'OpenMC not installed in ide' });
        expect(harness.backend.validateState).not.toHaveBeenCalled();
        expect(harness.runner.runSimulation).not.toHaveBeenCalled();
    });

    it('skips XML generation when requested and still starts the runner', async () => {
        const harness = createHarness({ projectPath: '/workspace/pincell.nuke-openmc' });

        const result = await harness.invoke('nuke.openmc.runSimulation', { generateXml: false });

        expect(result.ok).toBe(true);
        expect(harness.xmlService.generateXML).not.toHaveBeenCalled();
        expect(harness.runner.runSimulation).toHaveBeenCalledWith({ workingDirectory: '/workspace' });
        expect((result.data as { generatedFiles: string[] }).generatedFiles).toEqual([]);
    });

    it('enables geometry XML when a DAGMC file is set without CSG cells', async () => {
        const state = buildState();
        state.geometry.cells = [];
        state.geometry.universes = [{ id: 0, name: 'root', cellIds: [] }];
        state.settings.dagmcFile = 'model.h5m';
        const harness = createHarness({ state, projectPath: '/workspace/pincell.nuke-openmc' });

        const result = await harness.invoke('nuke.openmc.runSimulation', {});

        expect(result.ok).toBe(true);
        const xmlRequest = harness.xmlService.generateXML.mock.calls[0][0];
        expect(xmlRequest.files.geometry).toBe(true);
    });

    it('defaults the run directory to the project parent', async () => {
        const harness = createHarness({ projectPath: '/workspace/demo/pincell.nuke-openmc' });

        const result = await harness.invoke('nuke.openmc.runSimulation', {});

        expect(result.ok).toBe(true);
        expect(harness.runner.runSimulation).toHaveBeenCalledWith({ workingDirectory: '/workspace/demo' });
    });

    it('rejects a run without a project or working directory', async () => {
        const harness = createHarness();

        const result = await harness.invoke('nuke.openmc.runSimulation', {});

        expect(result).toEqual({ ok: false, message: 'Save the project or provide a workingDirectory.' });
        expect(harness.runner.runSimulation).not.toHaveBeenCalled();
    });

    it('rejects relative and outside-workspace run directories', async () => {
        const harness = createHarness();
        const relative = await harness.invoke('nuke.openmc.runSimulation', { workingDirectory: 'runs/pincell' });
        expect(relative.ok).toBe(false);
        const outside = await harness.invoke('nuke.openmc.runSimulation', { workingDirectory: '/other/runs' });
        expect(outside.ok).toBe(false);
        expect(harness.runner.runSimulation).not.toHaveBeenCalled();
    });

    it('returns running false when no simulation is active', async () => {
        const harness = createHarness();

        const result = await harness.invoke('nuke.openmc.getRunStatus', {});

        expect(result).toEqual({ ok: true, data: { running: false } });
    });

    it('returns running false without a directory when multiple runs are active', async () => {
        const harness = createHarness();
        harness.backend.active = [
            { processId: 'p1', workingDirectory: '/workspace/a', logFilePath: '/workspace/a/log', startTime: 't1' },
            { processId: 'p2', workingDirectory: '/workspace/b', logFilePath: '/workspace/b/log', startTime: 't2' }
        ];

        const result = await harness.invoke('nuke.openmc.getRunStatus', {});

        expect(result).toEqual({ ok: true, data: { running: false } });
    });

    it('matches an active run by exact directory and tails its log', async () => {
        const harness = createHarness();
        harness.backend.active = [
            { processId: 'p1', workingDirectory: '/workspace/a', logFilePath: '/workspace/a/log', startTime: 't1' },
            { processId: 'p2', workingDirectory: '/workspace/b', logFilePath: '/workspace/b/log', startTime: 't2' }
        ];
        harness.backend.log = {
            success: true,
            logPath: '/workspace/a/logs/openmc.log',
            logContent: 'one\ntwo\nthree\nfour'
        };

        const result = await harness.invoke('nuke.openmc.getRunStatus', {
            workingDirectory: '/workspace/a',
            logLines: 2
        });

        expect(result).toEqual({
            ok: true,
            data: {
                running: true,
                processId: 'p1',
                workingDirectory: '/workspace/a',
                startTime: 't1',
                logFilePath: '/workspace/a/logs/openmc.log',
                logTail: 'three\nfour'
            }
        });
        expect(harness.backend.getSimulationLog).toHaveBeenCalledWith('p1');
    });

    it('uses the only active run when no directory is provided and caps the log tail at 16 KiB', async () => {
        const harness = createHarness();
        harness.backend.active = [
            { processId: 'only', workingDirectory: '/workspace/a', logFilePath: '/workspace/a/log', startTime: 't1' }
        ];
        harness.backend.log = { success: true, logPath: '/workspace/a/log', logContent: `${'x'.repeat(20000)}\nlast` };

        const result = await harness.invoke('nuke.openmc.getRunStatus', { logLines: 200 });

        expect(result.ok).toBe(true);
        const data = result.data as { running: boolean; processId: string; logTail: string };
        expect(data.running).toBe(true);
        expect(data.processId).toBe('only');
        expect(data.logTail.length).toBeLessThanOrEqual(16 * 1024);
        expect(data.logTail).toBe('last');
    });
});

describe('OpenMC project diagnostics', () => {
    it('reports a healthy project as valid and ready to run', async () => {
        const harness = createHarness({ projectPath: '/workspace/pincell.nuke-openmc' });
        harness.environment.status = { ready: true, openmcVersion: '0.15.3' };

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        expect(result.ok).toBe(true);
        const data = result.data as {
            projectPath?: string;
            name: string;
            counts: Record<string, number>;
            valid: boolean;
            readyToRun: boolean;
            validation: ValidationResult;
            environment: Record<string, unknown>;
            crossSectionsPath?: string;
            crossSectionsExists?: boolean;
            issues: Array<{ severity: string; code: string }>;
            warnings: string[];
        };
        expect(data.projectPath).toBe('/workspace/pincell.nuke-openmc');
        expect(data.name).toBe('Pincell');
        expect(data.counts).toEqual({ surfaces: 1, cells: 1, universes: 1, lattices: 0, materials: 1, tallies: 0, meshes: 0 });
        expect(data.valid).toBe(true);
        expect(data.readyToRun).toBe(true);
        expect(data.validation).toEqual(harness.backend.validation);
        expect(data.environment).toEqual({ ready: true, openmcVersion: '0.15.3' });
        expect(data.crossSectionsPath).toBe('/data/cross_sections.xml');
        expect(data.crossSectionsExists).toBe(true);
        expect(data.issues).toEqual([
            {
                severity: 'info',
                code: 'no-tallies',
                category: 'tallies',
                message: 'No tallies are defined; the run will only produce global results such as k-eff.',
                suggestion: 'Add tallies to score fluxes, reaction rates, or other quantities of interest.'
            }
        ]);
        expect(data.warnings).toEqual([]);
        expect(harness.backend.validateState).toHaveBeenCalledWith({ state: harness.stateManager.getState(), level: 'standard' });
        expect(harness.fileService.exists).toHaveBeenCalledWith(expect.objectContaining({ path: expect.anything() }));
    });

    it('maps backend validation issues, preserving severity, category, code, and suggestion', async () => {
        const harness = createHarness();
        const state = buildState();
        state.materials = [];
        state.geometry.cells = [];
        harness.stateManager.state = state;
        harness.backend.validation = {
            valid: false,
            issues: [
                {
                    severity: 'error',
                    category: 'geometry',
                    message: 'Cell 1 is empty.',
                    path: 'geometry.cells[0]',
                    suggestion: 'Fill cell 1.'
                },
                { severity: 'warning', category: 'materials', message: 'Material 1 has no nuclides.' },
                { severity: 'info', category: 'settings', code: 'settings-note', message: 'Run mode is fixed source.' }
            ],
            summary: { errors: 1, warnings: 1, info: 1 }
        };

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        expect(result.ok).toBe(true);
        const data = result.data as { valid: boolean; readyToRun: boolean; issues: Array<{ code: string }> };
        expect(data.valid).toBe(false);
        expect(data.readyToRun).toBe(false);
        expect(data.issues.slice(0, 3)).toEqual([
            {
                severity: 'error',
                code: 'validation-geometry',
                category: 'geometry',
                message: 'Cell 1 is empty.',
                suggestion: 'Fill cell 1.'
            },
            {
                severity: 'warning',
                code: 'validation-materials',
                category: 'materials',
                message: 'Material 1 has no nuclides.'
            },
            {
                severity: 'info',
                code: 'settings-note',
                category: 'settings',
                message: 'Run mode is fixed source.'
            }
        ]);
        const codes = data.issues.map((issue) => issue.code);
        expect(codes).toContain('no-tallies');
        expect(codes).not.toContain('no-materials');
        expect(codes).not.toContain('no-geometry');
    });

    it('warns when the environment is not ready', async () => {
        const harness = createHarness();
        harness.environment.status = { ready: false, error: 'OpenMC not installed in ide' };

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        expect(result.ok).toBe(true);
        const data = result.data as {
            valid: boolean;
            readyToRun: boolean;
            environment: Record<string, unknown>;
            issues: Array<{ severity: string; code: string; message: string }>;
            warnings: string[];
        };
        expect(data.valid).toBe(true);
        expect(data.readyToRun).toBe(false);
        expect(data.environment).toEqual({ ready: false, error: 'OpenMC not installed in ide' });
        expect(data.warnings).toEqual(['OpenMC not installed in ide']);
        expect(data.issues).toContainEqual(
            expect.objectContaining({
                severity: 'warning',
                code: 'environment-not-ready',
                message: 'OpenMC not installed in ide'
            })
        );
    });

    it('reports an environment warning as info without blocking readiness', async () => {
        const harness = createHarness();
        harness.environment.status = { ready: true, warning: 'Missing optional DAGMC packages' };

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        const data = result.data as { readyToRun: boolean; warnings: string[]; issues: Array<{ severity: string; code: string }> };
        expect(data.readyToRun).toBe(true);
        expect(data.warnings).toEqual(['Missing optional DAGMC packages']);
        expect(data.issues).toContainEqual(
            expect.objectContaining({ severity: 'info', code: 'environment-warning', message: 'Missing optional DAGMC packages' })
        );
    });

    it('warns when cross sections are unset', async () => {
        const harness = createHarness();
        harness.nukeCore.getCrossSectionsPath.mockReturnValue(undefined);

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        const data = result.data as {
            readyToRun: boolean;
            crossSectionsPath?: string;
            crossSectionsExists?: boolean;
            issues: Array<{ code: string }>;
        };
        expect(data.readyToRun).toBe(true);
        expect('crossSectionsPath' in data).toBe(false);
        expect('crossSectionsExists' in data).toBe(false);
        expect(data.issues.map((issue) => issue.code)).toContain('cross-sections-unset');
        expect(harness.fileService.exists).not.toHaveBeenCalled();
    });

    it('warns and blocks readiness when the configured cross sections are missing', async () => {
        const harness = createHarness();
        harness.fileService.existingPaths.delete('/data/cross_sections.xml');

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        const data = result.data as {
            valid: boolean;
            readyToRun: boolean;
            crossSectionsExists?: boolean;
            issues: Array<{ code: string; severity: string }>;
        };
        expect(data.valid).toBe(true);
        expect(data.readyToRun).toBe(false);
        expect(data.crossSectionsExists).toBe(false);
        expect(data.issues).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'cross-sections-missing' }));
    });

    it('reports a missing DAGMC file as an error and resolves project-relative paths', async () => {
        const state = buildState();
        state.settings.dagmcFile = 'model.h5m';
        const harness = createHarness({ state, projectPath: '/workspace/pincell.nuke-openmc' });
        harness.backend.fileCheck = { exists: false, error: 'not found' };

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        const data = result.data as { valid: boolean; readyToRun: boolean; issues: Array<{ code: string; severity: string }> };
        expect(harness.backend.checkFileExists).toHaveBeenCalledWith('/workspace/model.h5m');
        expect(data.valid).toBe(false);
        expect(data.readyToRun).toBe(false);
        expect(data.issues).toContainEqual(expect.objectContaining({ severity: 'error', code: 'dagmc-missing' }));
    });

    it('reports empty materials, missing geometry, and missing tallies', async () => {
        const state = buildState();
        state.materials = [];
        state.geometry.cells = [];
        state.geometry.universes = [{ id: 0, name: 'root', cellIds: [] }];
        state.tallies = [];
        const harness = createHarness({ state });

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        const data = result.data as { valid: boolean; readyToRun: boolean; issues: Array<{ code: string; severity: string }> };
        expect(data.valid).toBe(true);
        expect(data.readyToRun).toBe(true);
        expect(data.issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ severity: 'warning', code: 'no-materials' }),
                expect.objectContaining({ severity: 'warning', code: 'no-geometry' }),
                expect.objectContaining({ severity: 'info', code: 'no-tallies' })
            ])
        );
    });

    it('returns ok false without throwing when backend validation fails', async () => {
        const harness = createHarness();
        harness.backend.validateState.mockRejectedValueOnce(new Error('backend offline'));

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        expect(result).toEqual({ ok: false, message: 'OpenMC project diagnosis failed: backend offline' });
    });

    it('caps project findings at 20 and appends a truncation notice', async () => {
        const issues: ValidationIssue[] = Array.from({ length: 25 }, (_, index) => ({
            severity: 'warning',
            category: 'general',
            message: `Validation warning ${index + 1}`
        }));
        const harness = createHarness();
        harness.backend.validation = { valid: true, issues, summary: { errors: 0, warnings: 25, info: 0 } };

        const result = await harness.invoke('nuke.openmc.diagnoseProject', {});

        const data = result.data as { issues: Array<{ severity: string; code: string }> };
        expect(data.issues).toHaveLength(20);
        expect(data.issues[19].code).toBe('findings-truncated');
        expect(data.issues[19].severity).toBe('info');
    });

    it('is read-only, always available, and declares object schemas', async () => {
        const harness = createHarness();
        const capability = harness.registry.capabilities.get('nuke.openmc.diagnoseProject')!;

        expect(capability.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(capability.risk).toBe('read');
        expect(capability.requiresConfirmation).toBeUndefined();
        expect(capability.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(capability.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
        expect(capability.outputSchema?.type).toBe('object');
    });
});

describe('OpenMC run diagnostics', () => {
    it('reports running false when no simulation is active', async () => {
        const harness = createHarness();

        const result = await harness.invoke('nuke.openmc.diagnoseRun', {});

        expect(result).toEqual({ ok: true, data: { running: false } });
        expect(harness.backend.getSimulationLog).not.toHaveBeenCalled();
    });

    it('diagnoses the only active run and returns its log tail', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a')];
        harness.backend.log = {
            success: true,
            logPath: '/workspace/a/logs/openmc.log',
            logContent: 'Starting run\nSimulating 50 batches'
        };

        const result = await harness.invoke('nuke.openmc.diagnoseRun', {});

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({
            running: true,
            processId: 'p1',
            workingDirectory: '/workspace/a',
            startTime: 'start-p1',
            logFilePath: '/workspace/a/logs/openmc.log',
            logTail: 'Starting run\nSimulating 50 batches',
            errorCount: 0,
            warningCount: 0,
            findings: []
        });
        expect(harness.backend.getSimulationLog).toHaveBeenCalledWith('p1');
    });

    it('asks for a directory when multiple runs are active', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a'), activeRun('p2', '/workspace/b')];

        const result = await harness.invoke('nuke.openmc.diagnoseRun', {});

        expect(result.ok).toBe(false);
        expect(result.message).toContain('workingDirectory');
        expect(harness.backend.getSimulationLog).not.toHaveBeenCalled();
    });

    it('matches a run by exact working directory', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a'), activeRun('p2', '/workspace/b')];
        harness.backend.log = { success: true, logPath: '/workspace/b/logs/openmc.log', logContent: 'p2 log' };

        const result = await harness.invoke('nuke.openmc.diagnoseRun', { workingDirectory: '/workspace/b' });

        const data = result.data as { running: boolean; processId: string };
        expect(data.running).toBe(true);
        expect(data.processId).toBe('p2');
        expect(harness.backend.getSimulationLog).toHaveBeenCalledWith('p2');
    });

    it('reports running false when the requested directory has no active run', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a')];

        const result = await harness.invoke('nuke.openmc.diagnoseRun', { workingDirectory: '/workspace/b' });

        expect(result).toEqual({ ok: true, data: { running: false } });
    });

    it('rejects relative and outside-workspace directories', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a')];

        const relative = await harness.invoke('nuke.openmc.diagnoseRun', { workingDirectory: 'runs/a' });
        expect(relative.ok).toBe(false);
        expect(relative.message).toContain('absolute path inside the workspace');

        const outside = await harness.invoke('nuke.openmc.diagnoseRun', { workingDirectory: '/other/runs' });
        expect(outside.ok).toBe(false);
    });

    it('returns ok false when the log cannot be read', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a')];
        harness.backend.log = { success: false, error: 'log unavailable' };

        const result = await harness.invoke('nuke.openmc.diagnoseRun', {});

        expect(result).toEqual({ ok: false, message: 'log unavailable' });
    });

    it('returns ok false without throwing when reading the log rejects', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a')];
        harness.backend.getSimulationLog.mockRejectedValueOnce(new Error('disk error'));

        const result = await harness.invoke('nuke.openmc.diagnoseRun', {});

        expect(result).toEqual({ ok: false, message: 'Could not read the OpenMC run log: disk error' });
    });

    it('classifies the supported log patterns with snippets and suggestions', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a')];
        harness.backend.log = {
            success: true,
            logPath: '/workspace/a/logs/openmc.log',
            logContent: [
                'Lost particle 42 was outside the geometry',
                'WARNING: Overlapping cells detected',
                'ERROR: Could not find cross_sections.xml',
                'ERROR: unknown fatal condition',
                'WARNING: tally bin is empty',
                'The simulation did not converge',
                'mpirun failed to start: no such file'
            ].join('\n')
        };

        const result = await harness.invoke('nuke.openmc.diagnoseRun', {});

        const data = result.data as {
            findings: Array<{ severity: string; code: string; message: string; suggestion: string }>;
            errorCount: number;
            warningCount: number;
        };
        expect(data.findings.map((finding) => finding.code)).toEqual([
            'lost-particles',
            'overlap',
            'cross-sections',
            'error-line',
            'warning-line',
            'convergence',
            'mpi'
        ]);
        expect(data.findings.map((finding) => finding.severity)).toEqual([
            'error',
            'warning',
            'error',
            'error',
            'warning',
            'warning',
            'warning'
        ]);
        expect(data.findings[0].message).toContain('Lost particle 42');
        expect(data.findings[2].message).toContain('cross_sections.xml');
        expect(data.findings.every((finding) => finding.suggestion.length > 0)).toBe(true);
        expect(data.errorCount).toBe(3);
        expect(data.warningCount).toBe(4);
    });

    it('caps run findings at 20 and appends a truncation notice', async () => {
        const harness = createHarness();
        harness.backend.active = [activeRun('p1', '/workspace/a')];
        harness.backend.log = {
            success: true,
            logPath: '/workspace/a/logs/openmc.log',
            logContent: Array.from({ length: 30 }, (_, index) => `ERROR failure ${index + 1}`).join('\n')
        };

        const result = await harness.invoke('nuke.openmc.diagnoseRun', {});

        const data = result.data as {
            findings: Array<{ severity: string; code: string }>;
            errorCount: number;
            warningCount: number;
        };
        expect(data.findings).toHaveLength(20);
        expect(data.findings[19].code).toBe('findings-truncated');
        expect(data.findings[19].severity).toBe('info');
        expect(data.errorCount).toBe(19);
        expect(data.warningCount).toBe(0);
    });

    it('is read-only, always available, and declares the log input window', async () => {
        const harness = createHarness();
        const capability = harness.registry.capabilities.get('nuke.openmc.diagnoseRun')!;

        expect(capability.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(capability.risk).toBe('read');
        expect(capability.requiresConfirmation).toBeUndefined();
        expect(capability.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(capability.inputSchema).toEqual({
            type: 'object',
            properties: {
                workingDirectory: { type: 'string', description: 'Exact active run directory; disambiguates multiple runs.' },
                logLines: { type: 'integer', minimum: 1, maximum: 200, default: 80 }
            },
            additionalProperties: false
        });
        expect(capability.outputSchema?.type).toBe('object');
    });
});

describe('OpenMC settings capabilities', () => {
    interface SettingsChangeData {
        proposalId: string;
        summary: string;
        changes: Array<{ path: string; label: string; kind: string; before?: unknown; after?: unknown }>;
    }

    it('summarizes every supported path and the run mode', async () => {
        const harness = createHarness();

        const result = await harness.invoke('nuke.openmc.summarizeSettings', {});

        expect(result.ok).toBe(true);
        const data = result.data as { runMode: string; settings: Record<string, unknown> };
        expect(data.runMode).toBe('eigenvalue');
        expect(Object.keys(data.settings).sort()).toEqual([...SUPPORTED_SETTINGS_PATHS].sort());
        expect(data.settings['run.particles']).toBe(1000);
        expect(data.settings['run.inactive']).toBe(10);
        expect(data.settings['output.summary']).toBeNull();
        expect(data.settings['output.path']).toBeNull();
        expect(data.settings['cutoff.energyNeutron']).toBeNull();
        expect(data.settings['kinetics.enabled']).toBeNull();
        expect(harness.stateManager.settingsUpdates).toEqual([]);
    });

    it('reports every advanced path from the current state', async () => {
        const harness = createHarness({ state: buildAdvancedState() });

        const result = await harness.invoke('nuke.openmc.summarizeSettings', {});

        const data = result.data as { runMode: string; settings: Record<string, unknown> };
        expect(data.runMode).toBe('eigenvalue');
        expect(data.settings).toMatchObject({
            'output.summary': false,
            'output.tallies': true,
            'output.path': 'runs/out',
            'cutoff.energyNeutron': 1e-5,
            'cutoff.time': 1,
            'cutoff.weight': null,
            'kinetics.enabled': true,
            'kinetics.ifpNGenerations': 4,
            'kinetics.numPrecursorGroups': 6,
            'kinetics.computeBetaEff': true
        });
    });

    it('declares the read summary with an empty input and read annotations', () => {
        const harness = createHarness();
        const capability = harness.registry.capabilities.get('nuke.openmc.summarizeSettings')!;

        expect(capability.risk).toBe('read');
        expect(capability.requiresConfirmation).toBeUndefined();
        expect(capability.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(capability.inputSchema).toEqual({ type: 'object', properties: {} });
        expect(capability.outputSchema?.type).toBe('object');
        expect(capability.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
    });

    it('previews, applies, and undoes nested settings without clobbering unrelated keys', async () => {
        const harness = createHarness({ state: buildAdvancedState() });
        const preview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [
                { path: 'output.summary', value: true },
                { path: 'cutoff.energyNeutron', value: 1e-4 },
                { path: 'kinetics.enabled', value: false }
            ]
        });
        const data = preview.data as SettingsChangeData;

        expect(preview.ok).toBe(true);
        expect(data.changes).toEqual([
            { path: 'output.summary', label: 'Write summary.h5', kind: 'update', before: false, after: true },
            { path: 'cutoff.energyNeutron', label: 'Neutron energy cutoff', kind: 'update', before: 1e-5, after: 1e-4 },
            { path: 'kinetics.enabled', label: 'Kinetics (IFP)', kind: 'update', before: true, after: false }
        ]);

        const applied = await harness.invoke('nuke.openmc.applySettings', { proposalId: data.proposalId });
        expect(applied.ok).toBe(true);
        expect(harness.stateManager.state.settings.output).toEqual({ summary: true, tallies: true, path: 'runs/out' });
        expect(harness.stateManager.state.settings.cutoff).toEqual({ energyNeutron: 1e-4, time: 1 });
        expect(harness.stateManager.state.settings.kinetics).toEqual({
            enabled: false,
            ifpNGenerations: 4,
            numPrecursorGroups: 6,
            computeBetaEff: true
        });
        expect(harness.stateManager.state.settings.run).toEqual({ mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 });

        const undo = await harness.undoService.undo(applied.undoToken!);

        expect(undo).toEqual({ ok: true, message: 'Settings change undone.' });
        expect(harness.stateManager.state.settings.output).toEqual({ summary: false, tallies: true, path: 'runs/out' });
        expect(harness.stateManager.state.settings.cutoff).toEqual({ energyNeutron: 1e-5, time: 1 });
        expect(harness.stateManager.state.settings.kinetics).toEqual({
            enabled: true,
            ifpNGenerations: 4,
            numPrecursorGroups: 6,
            computeBetaEff: true
        });
    });

    it('undo preserves unrelated nested edits made after apply', async () => {
        const harness = createHarness({ state: buildAdvancedState() });
        const preview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'output.summary', value: true }]
        });
        const proposalId = (preview.data as SettingsChangeData).proposalId;
        const applied = await harness.invoke('nuke.openmc.applySettings', { proposalId });
        harness.stateManager.updateSettings({
            output: { summary: true, tallies: false, path: 'runs/later' },
            cutoff: { energyNeutron: 1e-5, time: 1, weight: 1e-30 }
        });

        const undo = await harness.undoService.undo(applied.undoToken!);

        expect(undo.ok).toBe(true);
        expect(harness.stateManager.state.settings.output).toEqual({ summary: false, tallies: false, path: 'runs/later' });
        expect(harness.stateManager.state.settings.cutoff).toEqual({ energyNeutron: 1e-5, time: 1, weight: 1e-30 });
        const undoUpdate = harness.stateManager.settingsUpdates[harness.stateManager.settingsUpdates.length - 1];
        expect(Object.keys(undoUpdate).sort()).toEqual(['output']);
    });

    it('rejects an output path outside the workspace roots', async () => {
        const harness = createHarness();

        const outside = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'output.path', value: '/etc/openmc' }]
        });
        expect(outside.ok).toBe(false);
        expect(outside.message).toContain('output.path must be project-relative or an absolute path inside the workspace');

        const inside = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'output.path', value: `${WORKSPACE}/runs/out` }]
        });
        expect(inside.ok).toBe(true);

        const relative = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'output.path', value: 'runs/out' }]
        });
        expect(relative.ok).toBe(true);
    });

    it('requires IFP tallies before enabling kinetics', async () => {
        const harness = createHarness();
        const missing = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'kinetics.enabled', value: true }]
        });
        expect(missing.ok).toBe(false);
        expect(missing.message).toContain('requires the IFP tallies');

        const withTallies = createHarness({ state: buildAdvancedState() });
        withTallies.stateManager.state.settings.kinetics = undefined;
        const result = await withTallies.invoke('nuke.openmc.previewSettings', {
            changes: [
                { path: 'kinetics.enabled', value: true },
                { path: 'kinetics.ifpNGenerations', value: 4 }
            ]
        });
        expect(result.ok).toBe(true);
    });

    it('rejects a later run.inactive change below ifpNGenerations', async () => {
        const harness = createHarness({ state: buildAdvancedState() });

        const result = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'run.inactive', value: 3 }]
        });

        expect(result.ok).toBe(false);
        expect(result.message).toContain('kinetics.ifpNGenerations (4) must not exceed run.inactive (3)');
    });

    it('re-runs the cross-field check when applying', async () => {
        const harness = createHarness({ state: buildAdvancedState() });
        const preview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'kinetics.ifpNGenerations', value: 6 }]
        });
        const proposalId = (preview.data as SettingsChangeData).proposalId;
        harness.stateManager.state.settings.run = { mode: 'eigenvalue', particles: 1000, inactive: 3, batches: 50 };

        const applied = await harness.invoke('nuke.openmc.applySettings', { proposalId });

        expect(applied.ok).toBe(false);
        expect(applied.message).toContain('must not exceed run.inactive');
        expect(harness.stateManager.settingsUpdates).toEqual([]);
        expect(harness.stateManager.state.settings.kinetics?.ifpNGenerations).toBe(4);
    });

    it('rejects duplicate paths across old and new paths and no-op nested edits', async () => {
        const harness = createHarness({ state: buildAdvancedState() });

        const duplicate = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [
                { path: 'run.batches', value: 80 },
                { path: 'output.summary', value: true },
                { path: 'output.summary', value: false }
            ]
        });
        expect(duplicate.ok).toBe(false);
        expect(duplicate.message).toContain('only be changed once');

        const noop = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'output.summary', value: false }]
        });
        expect(noop.ok).toBe(false);
        expect(noop.message).toContain('already set to the requested value');
    });

    it('previews a diff and stores a proposal without mutating state', async () => {
        const harness = createHarness();

        const result = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [
                { path: 'run.particles', value: 2000 },
                { path: 'verbosity', value: 3 }
            ],
            summary: 'Tune run'
        });

        expect(result.ok).toBe(true);
        const data = result.data as SettingsChangeData;
        expect(data.summary).toBe('Tune run');
        expect(data.changes).toEqual([
            { path: 'run.particles', label: 'Particles per batch', kind: 'update', before: 1000, after: 2000 },
            { path: 'verbosity', label: 'Verbosity', kind: 'update', before: undefined, after: 3 }
        ]);
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC settings change',
            summary: 'Tune run',
            changes: data.changes,
            applyCapability: 'nuke.openmc.applySettings'
        });
        expect(result.nextActions).toEqual([
            { capability: 'nuke.openmc.applySettings', reason: 'Apply the previewed settings change after confirmation.' }
        ]);
        expect(harness.proposalService.get(data.proposalId)).toBeDefined();
        const proposal = harness.proposalService.get(data.proposalId)!;
        expect(proposal.scope).toBe('settings');
        expect(proposal.before).toMatchObject({ run: { particles: 1000 } });
        expect(proposal.after).toMatchObject({ run: { particles: 2000 }, verbosity: 3 });
        expect(harness.stateManager.settingsUpdates).toEqual([]);
        expect(harness.stateManager.state.settings.run).toEqual({ mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 });
    });

    it('generates a summary when the request omits one', async () => {
        const harness = createHarness();

        const result = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [
                { path: 'run.batches', value: 80 },
                { path: 'threads', value: 8 }
            ]
        });

        expect((result.data as SettingsChangeData).summary).toBe('Update 2 OpenMC run settings.');
    });

    it('rejects invalid, out-of-scope, duplicate, and no-op requests without changing state', async () => {
        const harness = createHarness();
        const cases: Array<{ input: unknown; message: string }> = [
            { input: { changes: [] }, message: 'between 1 and 20' },
            {
                input: { changes: Array.from({ length: 21 }, (_, index) => ({ path: 'run.particles', value: index + 1 })) },
                message: 'between 1 and 20'
            },
            { input: { changes: [{ path: 'run.particles', value: 0 }] }, message: 'greater than or equal to 1' },
            { input: { changes: [{ path: 'sources', value: [] }] }, message: 'not a supported OpenMC settings path' },
            { input: { changes: [{ path: 'run.particles', value: 1000 }] }, message: 'already set to the requested value' },
            {
                input: {
                    changes: [
                        { path: 'run.particles', value: 2000 },
                        { path: 'run.particles', value: 3000 }
                    ]
                },
                message: 'only be changed once'
            },
            { input: { changes: [{ path: 'seed' }] }, message: 'needs a value' },
            { input: { changes: 'nope' }, message: 'changes array' }
        ];

        for (const testCase of cases) {
            const result = await harness.invoke('nuke.openmc.previewSettings', testCase.input);
            expect(result.ok).toBe(false);
            expect(result.message).toContain(testCase.message);
        }
        expect(harness.stateManager.settingsUpdates).toEqual([]);
    });

    it('applies a live proposal, removes it, and registers an undo', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [
                { path: 'run.particles', value: 2000 },
                { path: 'verbosity', value: 3 }
            ],
            summary: 'Tune run'
        });
        const data = preview.data as SettingsChangeData;

        const result = await harness.invoke('nuke.openmc.applySettings', { proposalId: data.proposalId });

        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ proposalId: data.proposalId, summary: 'Tune run', changes: data.changes });
        expect(result.changeSet).toEqual({
            id: data.proposalId,
            title: 'OpenMC settings change',
            summary: 'Tune run',
            changes: data.changes
        });
        expect('applyCapability' in result.changeSet!).toBe(false);
        expect(result.undoToken).toBe('undo-1');
        expect(harness.undoService.has('undo-1')).toBe(true);
        expect(result.nextActions).toEqual([
            { capability: 'nuke.openmc.diagnoseProject', reason: 'Check the project after applying the settings change.' }
        ]);
        expect(harness.stateManager.settingsUpdates).toHaveLength(1);
        expect(harness.stateManager.settingsUpdates[0]).toMatchObject({ run: { particles: 2000 }, verbosity: 3 });
        expect(harness.stateManager.state.settings.run).toMatchObject({ particles: 2000 });
        expect(harness.stateManager.state.settings.verbosity).toBe(3);
        expect(harness.proposalService.get(data.proposalId)).toBeUndefined();
    });

    it('preserves an unrelated settings edit made after the preview', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'run.particles', value: 2000 }]
        });
        const proposalId = (preview.data as SettingsChangeData).proposalId;
        harness.stateManager.updateSettings({ seed: 7 });

        const result = await harness.invoke('nuke.openmc.applySettings', { proposalId });

        expect(result.ok).toBe(true);
        expect(harness.stateManager.state.settings.run).toMatchObject({ particles: 2000 });
        expect(harness.stateManager.state.settings.seed).toBe(7);
    });

    it('rejects a proposal from another scope without mutating state or consuming it', async () => {
        const harness = createHarness();
        const foreign = harness.proposalService.create({
            scope: 'materials',
            summary: 'Swap materials',
            changes: [{ path: 'materials', label: 'Materials', kind: 'update', before: [], after: [] }],
            before: [],
            after: []
        });

        const result = await harness.invoke('nuke.openmc.applySettings', { proposalId: foreign.id });

        expect(result).toEqual({ ok: false, message: `Proposal ${foreign.id} is for materials, not settings.` });
        expect(harness.stateManager.settingsUpdates).toEqual([]);
        expect(harness.proposalService.get(foreign.id)).toBeDefined();
    });

    it('rejects missing, expired, and stale proposals', async () => {
        const harness = createHarness();

        const missing = await harness.invoke('nuke.openmc.applySettings', { proposalId: 'missing' });
        expect(missing.ok).toBe(false);
        expect(missing.message).toContain('missing or has expired');

        const missingId = await harness.invoke('nuke.openmc.applySettings', {});
        expect(missingId.ok).toBe(false);
        expect(missingId.message).toContain('proposalId');

        const expiredPreview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'run.batches', value: 80 }]
        });
        const expiredId = (expiredPreview.data as SettingsChangeData).proposalId;
        harness.proposalService.clock.now += 10 * 60 * 1000;
        const expired = await harness.invoke('nuke.openmc.applySettings', { proposalId: expiredId });
        expect(expired.ok).toBe(false);
        expect(expired.message).toContain('missing or has expired');

        const stalePreview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'run.particles', value: 2000 }]
        });
        const staleId = (stalePreview.data as SettingsChangeData).proposalId;
        (harness.stateManager.state.settings.run as { particles: number }).particles = 1500;
        const stale = await harness.invoke('nuke.openmc.applySettings', { proposalId: staleId });
        expect(stale).toEqual({ ok: false, message: 'Settings changed since the preview. Preview again.' });
        expect(harness.stateManager.state.settings.run).toMatchObject({ particles: 1500 });
        expect(harness.stateManager.settingsUpdates).toHaveLength(0);
    });

    it('undo restores only the changed paths and keeps unrelated edits', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [
                { path: 'run.particles', value: 2000 },
                { path: 'verbosity', value: 3 }
            ]
        });
        const proposalId = (preview.data as SettingsChangeData).proposalId;
        const applied = await harness.invoke('nuke.openmc.applySettings', { proposalId });
        const token = applied.undoToken!;
        harness.stateManager.updateSettings({ seed: 7 });

        const result = await harness.undoService.undo(token);

        expect(result).toEqual({ ok: true, message: 'Settings change undone.' });
        expect(harness.stateManager.state.settings.run).toMatchObject({ particles: 1000, batches: 50 });
        expect(harness.stateManager.state.settings.verbosity).toBeUndefined();
        expect(harness.stateManager.state.settings.seed).toBe(7);
        const undoUpdate = harness.stateManager.settingsUpdates[2];
        expect(undoUpdate).not.toHaveProperty('sources');
        expect(undoUpdate).not.toHaveProperty('seed');
        expect(undoUpdate.verbosity).toBeUndefined();
        expect(undoUpdate.run).toMatchObject({ particles: 1000, batches: 50 });
        expect(harness.undoService.has(token)).toBe(false);
    });

    it('rejects undo when a changed path was edited again', async () => {
        const harness = createHarness();
        const preview = await harness.invoke('nuke.openmc.previewSettings', {
            changes: [{ path: 'run.particles', value: 2000 }]
        });
        const proposalId = (preview.data as SettingsChangeData).proposalId;
        const applied = await harness.invoke('nuke.openmc.applySettings', { proposalId });
        const token = applied.undoToken!;
        (harness.stateManager.state.settings.run as { particles: number }).particles = 1500;

        const result = await harness.undoService.undo(token);

        expect(result.ok).toBe(false);
        expect(result.message).toContain('can no longer be undone');
        expect(harness.stateManager.state.settings.run).toMatchObject({ particles: 1500 });
        expect(harness.undoService.has(token)).toBe(true);
    });

    it('declares read/write risk, confirmation, annotations, and availability', () => {
        const harness = createHarness();
        const preview = harness.registry.capabilities.get('nuke.openmc.previewSettings')!;
        const apply = harness.registry.capabilities.get('nuke.openmc.applySettings')!;

        expect(preview.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(preview.risk).toBe('read');
        expect(preview.requiresConfirmation).toBeUndefined();
        expect(preview.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
        expect(preview.inputSchema).toEqual({
            type: 'object',
            properties: {
                changes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { path: { type: 'string' }, value: {} },
                        required: ['path', 'value'],
                        additionalProperties: false
                    }
                },
                summary: { type: 'string' }
            },
            required: ['changes'],
            additionalProperties: false
        });
        expect(preview.outputSchema?.type).toBe('object');

        expect(apply.when!({ workspaceRoots: [WORKSPACE] })).toBe(true);
        expect(apply.risk).toBe('write');
        expect(apply.requiresConfirmation).toBe(true);
        expect(apply.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        expect(apply.inputSchema).toEqual({
            type: 'object',
            properties: { proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewSettings.' } },
            required: ['proposalId'],
            additionalProperties: false
        });
        expect(apply.outputSchema?.type).toBe('object');
    });
});

describe('OpenMC context contribution', () => {
    it('publishes the project path and fires on project changes', () => {
        const stateManager = new FakeStateManager(buildState(), '/workspace/pincell.nuke-openmc');
        const contribution = new OpenMCContextContribution(stateManager as unknown as OpenMCStateManager);

        expect(contribution.getContext()).toEqual({ activeOpenmcProject: '/workspace/pincell.nuke-openmc' });

        const changes: Array<string | undefined> = [];
        const listener = contribution.onDidChangeContext(() => changes.push(stateManager.projectPath));
        stateManager.setProjectPath('/workspace/other.nuke-openmc');
        listener.dispose();

        expect(changes).toEqual(['/workspace/other.nuke-openmc']);
    });
});
