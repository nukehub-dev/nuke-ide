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
 * Fake-service harness for the OpenMC capability contract tests.
 *
 * The harness uses the real `OpenMCStateManager` and real change proposal
 * service, with fake backend, XML, environment, runner, exporter, and file
 * services. Capabilities are registered in a real registry shape and invoked
 * through their public `invoke` method.
 */

import { Event } from '@theia/core/lib/common/event';
import { URI } from '@theia/core/lib/common/uri';
import { vi } from 'vitest';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { NukeCoreService } from 'nuke-core/lib/common';
import type {
    NukeCapability,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import type { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import type {
    DAGMCInfo,
    DAGMCVolume,
    OpenMCMaterial,
    OpenMCState,
    OpenMCTally
} from '../../extensions/openmc-studio/src/common/openmc-state-schema';
import type {
    ActiveSimulationInfo,
    NukeCADImportRequest,
    NukeCADImportResult,
    OpenMCStudioBackendService,
    ProjectSaveRequest,
    SimulationLogResult,
    SimulationRunRequest,
    StartSimulationResponse,
    ValidationRequest,
    ValidationResult,
    XMLGenerationRequest,
    XMLGenerationResult
} from '../../extensions/openmc-studio/src/common/openmc-studio-protocol';
import type {
    OpenMCEnvironmentService,
    OpenMCEnvironmentStatus
} from '../../extensions/openmc-studio/src/browser/services/openmc-environment-service';
import type { OpenMCSimulationRunner } from '../../extensions/openmc-studio/src/browser/widgets/simulation-dashboard/simulation-runner';
import type { OpenMCXMLGenerationService } from '../../extensions/openmc-studio/src/browser/xml-generator/xml-generation-service';
import type {
    OpenMCPythonExporter,
    PythonExportOptions,
    PythonExportResult
} from '../../extensions/openmc-studio/src/browser/script-generator/python-exporter';
import { createDefaultState, OpenMCStateManager } from '../../extensions/openmc-studio/src/browser/openmc-state-manager';
import { OpenMCChangeProposalService } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-change-proposal-service';
import { OpenMCCapabilities } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-capabilities';
import { OpenMCMaterialCapabilities } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-material-capabilities';
import { OpenMCTallyCapabilities } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-tally-capabilities';
import { OpenMCGeometryCapabilities } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-geometry-capabilities';
import { OpenMCDagmcCapabilities } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-dagmc-capabilities';
import { OpenMCProjectCapabilities } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-project-capabilities';
import { OpenMCScriptCapabilities } from '../../extensions/openmc-studio/src/browser/capabilities/openmc-script-capabilities';

export const OPENMC_WORKSPACE = '/workspace';
export const OPENMC_PROJECT_PATH = `${OPENMC_WORKSPACE}/pincell.nuke-openmc`;
export const OPENMC_DAGMC_FILE = `${OPENMC_WORKSPACE}/model.h5m`;

export interface OpenMcContractHarness {
    readonly stateManager: OpenMCStateManager;
    readonly registry: FakeRegistry;
    readonly proposalService: TestProposalService;
    readonly undoService: FakeUndoService;
    readonly backend: FakeBackend;
    readonly exporter: FakeExporter;
    readonly fileService: FakeFileService;
    readonly undoEntries: readonly NukeUndoEntry[];
    readonly invoke: (id: string, input: unknown) => Promise<NukeCapabilityResult>;
}

export class FakeRegistry implements NukeCapabilityRegistry {
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

export class TestProposalService extends OpenMCChangeProposalService {
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

export class FakeUndoService implements NukeUndoService {
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

export class FakeBackend {
    validation: ValidationResult = { valid: true, issues: [], summary: { errors: 0, warnings: 0, info: 0 } };
    importResult: NukeCADImportResult = { success: true };
    active: ActiveSimulationInfo[] = [];
    log: SimulationLogResult = { success: true, logPath: '/workspace/logs/openmc.log', logContent: '' };
    fileCheck: { exists: boolean; size?: number; error?: string } = { exists: true };
    saveResult: { success: boolean; error?: string } = { success: true };
    readonly dagmcCalls: Array<{ filePath: string; volumeId: number; material: string }> = [];

    validateState = vi.fn(async (_request: ValidationRequest): Promise<ValidationResult> => this.validation);
    importNukeCAD = vi.fn(async (_request: NukeCADImportRequest): Promise<NukeCADImportResult> => this.importResult);
    checkFileExists = vi.fn(async (_filePath: string): Promise<{ exists: boolean; size?: number; error?: string }> => this.fileCheck);
    getActiveSimulations = vi.fn(async (): Promise<ActiveSimulationInfo[]> => this.active);
    getSimulationLog = vi.fn(async (_processId: string): Promise<SimulationLogResult> => this.log);
    saveProject = vi.fn(async (_request: ProjectSaveRequest): Promise<{ success: boolean; error?: string }> => this.saveResult);
    async dagmcAssignMaterial(filePath: string, volumeId: number, material: string): Promise<{ success: boolean; error?: string }> {
        this.dagmcCalls.push({ filePath, volumeId, material });
        return { success: true };
    }
}

export class FakeXmlService {
    result: XMLGenerationResult = {
        success: true,
        generatedFiles: ['/workspace/materials.xml', '/workspace/settings.xml', '/workspace/geometry.xml'],
        warnings: []
    };

    generateXML = vi.fn(async (_request: XMLGenerationRequest): Promise<XMLGenerationResult> => this.result);
}

export class FakeEnvironmentService {
    status: OpenMCEnvironmentStatus = { ready: true };

    refreshStatus = vi.fn(async (): Promise<OpenMCEnvironmentStatus> => this.status);
    isReady = vi.fn((): boolean => this.status.ready);
    getStatus = vi.fn((): OpenMCEnvironmentStatus => this.status);
}

export class FakeRunner {
    response: StartSimulationResponse = { success: true, processId: 'p1' };
    runSimulation = vi.fn(async (_request: SimulationRunRequest): Promise<StartSimulationResponse> => this.response);
}

export class FakeNukeCoreService {
    getCrossSectionsPath = vi.fn((): string | undefined => '/data/cross_sections.xml');
}

export class FakeExporter {
    result: PythonExportResult = { success: true, files: [`${OPENMC_WORKSPACE}/model.py`] };

    exportToPython = vi.fn(async (_options?: Partial<PythonExportOptions>): Promise<PythonExportResult> => this.result);
}

interface FakeStat {
    isDirectory: boolean;
    isFile: boolean;
    isSymbolicLink: boolean;
    size?: number;
}

export class FakeFileService {
    readonly directories = new Set<string>([OPENMC_WORKSPACE, `${OPENMC_WORKSPACE}/projects`]);
    readonly files = new Set<string>(['/data/cross_sections.xml']);
    readonly symlinks = new Set<string>();

    readonly resolve = vi.fn(async (uri: URI): Promise<FakeStat> => {
        const path = uri.path.toString();
        if (this.symlinks.has(path)) {
            return { isDirectory: false, isFile: false, isSymbolicLink: true };
        }
        if (this.directories.has(path)) {
            return { isDirectory: true, isFile: false, isSymbolicLink: false };
        }
        if (this.files.has(path)) {
            return { isDirectory: false, isFile: true, isSymbolicLink: false, size: 0 };
        }
        throw new Error(`Not found: ${path}`);
    });

    readonly exists = vi.fn(async (uri: URI): Promise<boolean> => {
        const path = uri.path.toString();
        return this.directories.has(path) || this.files.has(path) || this.symlinks.has(path);
    });
}

export function buildMaterials(): OpenMCMaterial[] {
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
        }
    ];
}

export function buildTallies(): OpenMCTally[] {
    return [
        {
            id: 1,
            name: 'flux-cube',
            scores: ['flux'],
            nuclides: ['total'],
            filters: [{ type: 'cell', bins: [1, 2] }],
            estimator: 'tracklength',
            multiplyDensity: false
        },
        {
            id: 2,
            scores: ['fission'],
            nuclides: ['U235'],
            filters: [{ type: 'energy', bins: [0, 20_000_000] }]
        }
    ];
}

export function buildState(overrides: Partial<OpenMCState> = {}): OpenMCState {
    const state = createDefaultState();
    state.metadata.name = 'Pincell';
    state.materials = buildMaterials();
    state.tallies = buildTallies();
    state.settings.run = { mode: 'eigenvalue', particles: 1000, inactive: 10, batches: 50 };
    return { ...state, ...overrides };
}

export function buildDagmcVolume(id: number, material: string): DAGMCVolume {
    return {
        id,
        material,
        numTriangles: 12 * id,
        boundingBox: { min: [0, 0, 0], max: [id, id, id] }
    };
}

export function buildDagmcInfo(): DAGMCInfo {
    return {
        filePath: OPENMC_DAGMC_FILE,
        fileName: 'model.h5m',
        volumeCount: 3,
        surfaceCount: 4,
        vertices: 8,
        materials: {},
        volumes: [buildDagmcVolume(1, 'Water'), buildDagmcVolume(2, 'Fuel'), buildDagmcVolume(3, 'mat:graveyard')],
        boundingBox: { min: [0, 0, 0], max: [3, 3, 3] },
        autoGeomIds: false,
        autoMatIds: false
    };
}

export function buildDagmcState(): OpenMCState {
    const state = buildState();
    state.settings.dagmcFile = OPENMC_DAGMC_FILE;
    state.settings.dagmcInfo = buildDagmcInfo();
    return state;
}

export function buildGeometryState(): OpenMCState {
    const state = buildState();
    state.geometry = {
        surfaces: [{ id: 1, type: 'sphere', coefficients: { x0: 0, y0: 0, z0: 0, r: 1 }, name: 'Core' }],
        cells: [
            { id: 1, name: 'Fuel', region: { type: 'surface', surfaceId: 1 }, regionString: '-1', fillType: 'material', fillId: 1 },
            { id: 2, name: 'Outside', fillType: 'void' }
        ],
        universes: [{ id: 0, name: 'root', cellIds: [1, 2] }],
        lattices: [],
        rootUniverseId: 0
    };
    return state;
}

export interface CreateOpenMcHarnessOptions {
    readonly state?: OpenMCState;
    readonly projectPath?: string;
}

export function createOpenMcHarness(options: CreateOpenMcHarnessOptions = {}): OpenMcContractHarness {
    const stateManager = new OpenMCStateManager();
    stateManager.setState(options.state ?? buildState(), false);
    // The real manager only needs roots for its best-effort watcher exclusion.
    (stateManager as unknown as { workspaceService: { tryGetRoots(): readonly unknown[] } }).workspaceService = {
        tryGetRoots: () => []
    };
    if (options.projectPath !== undefined) {
        stateManager.setProjectPath(options.projectPath);
    }
    const backend = new FakeBackend();
    const xmlService = new FakeXmlService();
    const environment = new FakeEnvironmentService();
    const runner = new FakeRunner();
    const nukeCore = new FakeNukeCoreService();
    const fileService = new FakeFileService();
    const proposalService = new TestProposalService();
    const undoService = new FakeUndoService();
    const exporter = new FakeExporter();
    const registry = new FakeRegistry();
    const capabilities = [
        new OpenMCCapabilities(
            stateManager,
            backend as unknown as OpenMCStudioBackendService,
            xmlService as unknown as OpenMCXMLGenerationService,
            environment as unknown as OpenMCEnvironmentService,
            runner as unknown as OpenMCSimulationRunner,
            nukeCore as unknown as NukeCoreService,
            fileService as unknown as FileService,
            proposalService,
            undoService
        ),
        new OpenMCMaterialCapabilities(stateManager, proposalService, undoService),
        new OpenMCTallyCapabilities(stateManager, proposalService, undoService),
        new OpenMCGeometryCapabilities(stateManager, proposalService, undoService, backend as unknown as OpenMCStudioBackendService),
        new OpenMCDagmcCapabilities(stateManager, backend as unknown as OpenMCStudioBackendService, proposalService, undoService),
        new OpenMCProjectCapabilities(
            stateManager,
            backend as unknown as OpenMCStudioBackendService,
            fileService as unknown as FileService
        ),
        new OpenMCScriptCapabilities(stateManager, exporter as unknown as OpenMCPythonExporter, fileService as unknown as FileService)
    ];
    for (const contribution of capabilities) {
        contribution.registerCapabilities(registry);
    }
    return {
        stateManager,
        registry,
        proposalService,
        undoService,
        backend,
        exporter,
        fileService,
        get undoEntries(): readonly NukeUndoEntry[] {
            return [...undoService.entries.values()];
        },
        invoke: (id, input) => {
            const capability = registry.get(id);
            if (!capability) {
                throw new Error(`Missing capability ${id}`);
            }
            return capability.invoke(input, { workspaceRoots: [OPENMC_WORKSPACE], activeOpenmcProject: stateManager.projectPath });
        }
    };
}
