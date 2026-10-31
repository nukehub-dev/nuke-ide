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
 * OpenMC Capabilities
 *
 * Exposes the core OpenMC Studio project workflow to the nuke-core capability
 * registry: summarize, validate, import a nuke-cad DAGMC model, start a run,
 * and poll its status. Every handler orchestrates the existing state manager,
 * XML generator, environment service, backend service, and simulation runner;
 * XML, validation, and run logic stay in their owning services.
 *
 * @module openmc-studio/browser/capabilities
 */

import * as path from 'path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { Event } from '@theia/core/lib/common/event';
import { NukeCoreService } from 'nuke-core/lib/common';
import {
    NukeCapabilityContext,
    NukeCapabilityContextContribution,
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { OpenMCMaterial } from '../../common/openmc-state-schema';
import { OpenMCStudioBackendService, SimulationRunRequest, ValidationRequest } from '../../common/openmc-studio-protocol';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCEnvironmentService } from '../services/openmc-environment-service';
import { OpenMCSimulationRunner } from '../widgets/simulation-dashboard/simulation-runner';
import { OpenMCXMLGenerationService } from '../xml-generator/xml-generation-service';

/** Read the last `lines` lines of a log, capped at 16 KiB. */
const MAX_LOG_TAIL_LENGTH = 16 * 1024;

/** Safely read a structured capability input as a plain object. */
function readRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Read an optional string field from a capability input object. */
function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}

/** Read an optional positive integer field from a capability input object. */
function readPositiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Read the optional validation check selection, keeping only known boolean flags. */
function readChecks(value: unknown): ValidationRequest['checks'] | undefined {
    const record = readRecord(value);
    const checks: NonNullable<ValidationRequest['checks']> = {};
    let found = false;
    for (const key of ['geometry', 'materials', 'settings', 'tallies', 'overlaps'] as const) {
        if (typeof record[key] === 'boolean') {
            checks[key] = record[key];
            found = true;
        }
    }
    return found ? checks : undefined;
}

/** Read the optional MPI launch request. */
function readMpi(value: unknown): SimulationRunRequest['mpi'] | undefined {
    const record = readRecord(value);
    if (typeof record.enabled !== 'boolean') {
        return undefined;
    }
    const mpi: NonNullable<SimulationRunRequest['mpi']> = { enabled: record.enabled };
    const processes = readPositiveInteger(record.processes);
    if (processes !== undefined) {
        mpi.processes = processes;
    }
    if (Array.isArray(record.hosts)) {
        const hosts = record.hosts.filter((host): host is string => typeof host === 'string');
        if (hosts.length > 0) {
            mpi.hosts = hosts;
        }
    }
    return mpi;
}

/** Return the trailing log lines, dropping partial content beyond the 16 KiB cap. */
function tailLog(content: string, lineCount: number): string {
    const selected = content.split(/\r?\n/).slice(-lineCount).join('\n');
    if (selected.length <= MAX_LOG_TAIL_LENGTH) {
        return selected;
    }
    const truncated = selected.slice(selected.length - MAX_LOG_TAIL_LENGTH);
    const firstLineBreak = truncated.indexOf('\n');
    return firstLineBreak >= 0 ? truncated.slice(firstLineBreak + 1) : truncated;
}

/** Verify an optional path is absolute and inside one of the workspace roots. */
function isWorkspacePath(value: string | undefined, roots: readonly string[]): value is string {
    return typeof value === 'string' && path.isAbsolute(value) && isWithinWorkspace(value, roots);
}

/**
 * Registers the OpenMC Studio capabilities with the nuke-core registry.
 */
@injectable()
export class OpenMCCapabilities implements NukeCapabilityContribution {
    constructor(
        @inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager,
        @inject(OpenMCStudioBackendService) protected readonly backendService: OpenMCStudioBackendService,
        @inject(OpenMCXMLGenerationService) protected readonly xmlService: OpenMCXMLGenerationService,
        @inject(OpenMCEnvironmentService) protected readonly environmentService: OpenMCEnvironmentService,
        @inject(OpenMCSimulationRunner) protected readonly simulationRunner: OpenMCSimulationRunner,
        @inject(NukeCoreService) protected readonly nukeCoreService: NukeCoreService
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register({
            id: 'nuke.openmc.summarizeProject',
            title: 'Summarize OpenMC project',
            description: 'Return the active OpenMC project name, counts, and run settings without contacting the backend.',
            category: ['OpenMC', 'Project'],
            inputSchema: {
                type: 'object',
                properties: {}
            },
            risk: 'read',
            when: () => true,
            invoke: async () => this.summarizeProject()
        });

        registry.register({
            id: 'nuke.openmc.validateProject',
            title: 'Validate OpenMC project',
            description: 'Validate the active OpenMC model geometry, materials, settings, and tallies.',
            category: ['OpenMC', 'Project'],
            inputSchema: {
                type: 'object',
                properties: {
                    level: { type: 'string', enum: ['basic', 'standard', 'strict'], default: 'standard' },
                    checks: {
                        type: 'object',
                        properties: {
                            geometry: { type: 'boolean' },
                            materials: { type: 'boolean' },
                            settings: { type: 'boolean' },
                            tallies: { type: 'boolean' },
                            overlaps: { type: 'boolean' }
                        },
                        additionalProperties: false
                    }
                },
                additionalProperties: false
            },
            risk: 'read',
            invoke: async (input) => this.validateProject(input)
        });

        registry.register({
            id: 'nuke.openmc.importCad',
            title: 'Import nuke-cad DAGMC model',
            description:
                'Import a nuke-cad .h5m model with its optional .regions.json manifest, create placeholder materials, and point settings at the DAGMC geometry.',
            category: ['OpenMC', 'Geometry'],
            inputSchema: {
                type: 'object',
                properties: {
                    h5mPath: { type: 'string', description: 'Absolute DAGMC .h5m path.' },
                    manifestPath: { type: 'string', description: 'Optional absolute .regions.json path.' }
                },
                required: ['h5mPath'],
                additionalProperties: false
            },
            risk: 'write',
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
            requiresConfirmation: true,
            invoke: async (input, context) => this.importCad(input, context)
        });

        registry.register({
            id: 'nuke.openmc.runSimulation',
            title: 'Run OpenMC simulation',
            description: 'Validate the active project, generate XML unless disabled, and start an OpenMC run in a workspace directory.',
            category: ['OpenMC', 'Simulation'],
            inputSchema: {
                type: 'object',
                properties: {
                    workingDirectory: { type: 'string', description: 'Absolute run directory. Defaults to the project directory.' },
                    generateXml: { type: 'boolean', default: true },
                    threads: { type: 'integer', minimum: 1 },
                    restartFile: { type: 'string' },
                    mpi: {
                        type: 'object',
                        properties: {
                            enabled: { type: 'boolean' },
                            processes: { type: 'integer', minimum: 1 },
                            hosts: { type: 'array', items: { type: 'string' } }
                        },
                        required: ['enabled'],
                        additionalProperties: false
                    }
                },
                additionalProperties: false
            },
            risk: 'execute',
            requiresConfirmation: true,
            when: () => true,
            invoke: async (input, context) => this.runSimulation(input, context)
        });

        registry.register({
            id: 'nuke.openmc.getRunStatus',
            title: 'Get OpenMC run status',
            description: 'Report whether a run is active for a workspace directory and return the tail of its log.',
            category: ['OpenMC', 'Simulation'],
            inputSchema: {
                type: 'object',
                properties: {
                    workingDirectory: { type: 'string' },
                    logLines: { type: 'integer', minimum: 1, maximum: 200, default: 40 }
                },
                additionalProperties: false
            },
            risk: 'read',
            invoke: async (input) => this.getRunStatus(input)
        });
    }

    protected async summarizeProject(): Promise<NukeCapabilityResult> {
        const state = this.stateManager.getState();
        const run = state.settings.run as { mode?: string; particles?: number; inactive?: number; batches?: number };
        const settings: { mode: string; particles: number; inactive: number; batches: number; dagmcFile?: string } = {
            mode: run.mode ?? 'unknown',
            particles: run.particles ?? 0,
            inactive: run.inactive ?? 0,
            batches: run.batches ?? 0
        };
        if (state.settings.dagmcFile) {
            settings.dagmcFile = state.settings.dagmcFile;
        }
        return {
            ok: true,
            data: {
                projectPath: this.stateManager.projectPath,
                name: state.metadata.name,
                description: state.metadata.description,
                dirty: this.stateManager.isDirty,
                counts: {
                    surfaces: state.geometry.surfaces.length,
                    cells: state.geometry.cells.length,
                    universes: state.geometry.universes.length,
                    lattices: state.geometry.lattices.length,
                    materials: state.materials.length,
                    tallies: state.tallies.length,
                    meshes: state.meshes.length
                },
                settings
            }
        };
    }

    protected async validateProject(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const rawLevel = readString(record, 'level');
        const level: ValidationRequest['level'] = rawLevel === 'basic' || rawLevel === 'strict' ? rawLevel : 'standard';
        const checks = readChecks(record.checks);
        const result = await this.backendService.validateState({
            state: this.stateManager.getState(),
            level,
            ...(checks ? { checks } : {})
        });
        if (result.valid) {
            return { ok: true, data: result };
        }
        const { errors, warnings } = result.summary;
        return {
            ok: false,
            data: result,
            message: `Validation failed with ${errors} error(s) and ${warnings} warning(s).`
        };
    }

    protected async importCad(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const h5mPath = readString(record, 'h5mPath');
        const manifestPath = readString(record, 'manifestPath');
        if (!isWorkspacePath(h5mPath, context.workspaceRoots)) {
            return { ok: false, message: 'h5mPath must be an absolute path inside the workspace.' };
        }
        if (manifestPath !== undefined && !isWorkspacePath(manifestPath, context.workspaceRoots)) {
            return { ok: false, message: 'manifestPath must be an absolute path inside the workspace.' };
        }

        const result = await this.backendService.importNukeCAD({ h5mPath, manifestPath });
        if (!result.success || !result.dagmcInfo) {
            return { ok: false, message: result.error ?? 'nuke-cad import failed.' };
        }

        const existing = new Set(this.stateManager.getState().materials.map((material) => material.name));
        const materialNames = result.materialNames ?? [];
        const missingNames = materialNames.filter((name) => !existing.has(name));
        const linkByMaterial = new Map((result.materialLinks ?? []).map((link) => [link.material, link]));
        const createdMaterials: string[] = [];
        for (const name of missingNames) {
            const link = linkByMaterial.get(name);
            const material: OpenMCMaterial = {
                id: this.stateManager.getNextMaterialId(),
                name,
                density: 1.0,
                densityUnit: 'g/cm3',
                nuclides: [],
                thermalScattering: []
            };
            if (link?.materialId) {
                material.nukeCadMaterialId = link.materialId;
            }
            if (link?.parentId) {
                material.nukeCadParentId = link.parentId;
            }
            this.stateManager.addMaterial(material);
            createdMaterials.push(name);
        }

        this.stateManager.updateSettings({
            dagmcFile: result.dagmcFile,
            dagmcInfo: result.dagmcInfo
        });

        const data: Record<string, unknown> = {
            dagmcFile: result.dagmcFile,
            dagmcInfo: result.dagmcInfo,
            materialNames,
            createdMaterials
        };
        if (result.warnings !== undefined) {
            data.warnings = result.warnings;
        }
        if (result.manifest !== undefined) {
            data.manifest = result.manifest;
        }
        return {
            ok: true,
            data,
            nextActions: [
                { capability: 'nuke.openmc.validateProject', reason: 'Check the imported DAGMC model before running.' },
                { capability: 'nuke.openmc.runSimulation', reason: 'Start a run once validation passes.' }
            ]
        };
    }

    protected async runSimulation(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const projectPath = this.stateManager.projectPath;
        const providedDirectory = readString(record, 'workingDirectory');
        const workingDirectory = providedDirectory ?? (projectPath ? path.dirname(projectPath) : undefined);
        if (!workingDirectory) {
            return { ok: false, message: 'Save the project or provide a workingDirectory.' };
        }
        if (!isWorkspacePath(workingDirectory, context.workspaceRoots)) {
            return { ok: false, message: 'workingDirectory must be an absolute path inside the workspace.' };
        }

        const status = await this.environmentService.refreshStatus();
        if (!this.environmentService.isReady()) {
            const current = this.environmentService.getStatus();
            return { ok: false, message: current.error ?? status?.error ?? 'OpenMC is not available in the selected environment.' };
        }

        const state = this.stateManager.getState();
        const validation = await this.backendService.validateState({ state, level: 'standard' });
        if (!validation.valid) {
            return { ok: false, message: 'Validation failed.', data: { issues: validation.issues } };
        }

        let generatedFiles: string[] = [];
        let warnings: string[] | undefined;
        if (record.generateXml !== false) {
            const xmlResult = await this.xmlService.generateXML({
                state,
                outputDirectory: workingDirectory,
                projectDirectory: projectPath ? path.dirname(projectPath) : undefined,
                files: {
                    materials: true,
                    settings: true,
                    geometry: state.geometry.cells.length > 0 || !!state.settings.dagmcFile,
                    tallies: state.tallies.length > 0,
                    plots: false
                },
                crossSectionsPath: this.nukeCoreService.getCrossSectionsPath()
            });
            if (!xmlResult.success) {
                return {
                    ok: false,
                    message: xmlResult.error ?? 'XML generation failed.',
                    data: { warnings: xmlResult.warnings }
                };
            }
            generatedFiles = xmlResult.generatedFiles;
            warnings = xmlResult.warnings;
        }

        const runRequest: SimulationRunRequest = { workingDirectory };
        const restartFile = readString(record, 'restartFile');
        if (restartFile !== undefined) {
            runRequest.restartFile = restartFile;
        }
        const threads = readPositiveInteger(record.threads);
        if (threads !== undefined) {
            runRequest.threads = threads;
        }
        const mpi = readMpi(record.mpi);
        if (mpi !== undefined) {
            runRequest.mpi = mpi;
        }

        const response = await this.simulationRunner.runSimulation(runRequest);
        if (!response.success) {
            return { ok: false, message: response.error ?? 'OpenMC failed to start.' };
        }
        return {
            ok: true,
            data: {
                workingDirectory,
                processId: response.processId,
                generatedFiles,
                warnings
            },
            nextActions: [{ capability: 'nuke.openmc.getRunStatus', reason: 'Poll the run until it completes.' }]
        };
    }

    protected async getRunStatus(input: unknown): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const requestedDirectory = readString(record, 'workingDirectory');
        const rawLogLines = readPositiveInteger(record.logLines);
        const logLines = rawLogLines === undefined ? 40 : Math.min(rawLogLines, 200);

        const active = await this.backendService.getActiveSimulations();
        const candidates = requestedDirectory ? active.filter((run) => run.workingDirectory === requestedDirectory) : active;
        const run = requestedDirectory ? candidates[0] : active.length === 1 ? active[0] : undefined;
        if (!run) {
            return { ok: true, data: { running: false } };
        }

        const log = await this.backendService.getSimulationLog(run.processId);
        return {
            ok: true,
            data: {
                running: true,
                processId: run.processId,
                workingDirectory: run.workingDirectory,
                startTime: run.startTime,
                logFilePath: log.logPath,
                logTail: tailLog(log.logContent ?? '', logLines)
            }
        };
    }
}

/** Publish the active OpenMC project to the capability context. */
@injectable()
export class OpenMCContextContribution implements NukeCapabilityContextContribution {
    readonly onDidChangeContext: Event<void>;

    constructor(@inject(OpenMCStateManager) protected readonly stateManager: OpenMCStateManager) {
        this.onDidChangeContext = (listener, thisArgs, disposables) =>
            this.stateManager.onProjectPathChange(() => listener(undefined), thisArgs, disposables);
    }

    getContext(): Partial<NukeCapabilityContext> {
        return { activeOpenmcProject: this.stateManager.projectPath };
    }
}
