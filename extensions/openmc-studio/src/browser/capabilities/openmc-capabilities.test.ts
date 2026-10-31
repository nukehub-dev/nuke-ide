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

// Keep the suite in the Node environment: these services pull in browser DOM modules.
vi.mock('../openmc-state-manager', () => ({ OpenMCStateManager: class OpenMCStateManager {} }));
vi.mock('../services/openmc-environment-service', () => ({ OpenMCEnvironmentService: class OpenMCEnvironmentService {} }));
vi.mock('../widgets/simulation-dashboard/simulation-runner', () => ({ OpenMCSimulationRunner: class OpenMCSimulationRunner {} }));
vi.mock('../xml-generator/xml-generation-service', () => ({ OpenMCXMLGenerationService: class OpenMCXMLGenerationService {} }));

import type { NukeCoreService } from 'nuke-core/lib/common';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { DAGMCInfo, OpenMCMaterial, OpenMCSettings, OpenMCState } from '../../common/openmc-state-schema';
import type {
    ActiveSimulationInfo,
    NukeCADImportRequest,
    NukeCADImportResult,
    OpenMCStudioBackendService,
    SimulationLogResult,
    SimulationRunRequest,
    StartSimulationResponse,
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

    validateState = vi.fn(async (_request: ValidationRequest): Promise<ValidationResult> => this.validation);
    importNukeCAD = vi.fn(async (_request: NukeCADImportRequest): Promise<NukeCADImportResult> => this.importResult);
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
    const registry = new FakeRegistry();
    const capabilities = new OpenMCCapabilities(
        stateManager as unknown as OpenMCStateManager,
        backend as unknown as OpenMCStudioBackendService,
        xmlService as unknown as OpenMCXMLGenerationService,
        environment as unknown as OpenMCEnvironmentService,
        runner as unknown as OpenMCSimulationRunner,
        nukeCore as unknown as NukeCoreService
    );
    capabilities.registerCapabilities(registry);
    return {
        stateManager,
        backend,
        xmlService,
        environment,
        runner,
        nukeCore,
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
