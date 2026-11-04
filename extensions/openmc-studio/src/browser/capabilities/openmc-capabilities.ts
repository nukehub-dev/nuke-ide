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
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { NukeCoreService } from 'nuke-core/lib/common';
import {
    NukeCapabilityContext,
    NukeCapabilityContextContribution,
    NukeCapabilityContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeChange,
    NukeChangeSet,
    NukeJsonSchema,
    NukeJsonSchemaProperty
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { deriveAnnotations, isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import { NukeUndoEntry, NukeUndoService } from 'nuke-core/lib/browser/capabilities/nuke-undo-service';
import { OpenMCMaterial, OpenMCSettings } from '../../common/openmc-state-schema';
import {
    ActiveSimulationInfo,
    OpenMCStudioBackendService,
    SimulationLogResult,
    SimulationRunRequest,
    ValidationIssue,
    ValidationRequest,
    ValidationResult
} from '../../common/openmc-studio-protocol';
import { OpenMCStateManager } from '../openmc-state-manager';
import { OpenMCEnvironmentService, OpenMCEnvironmentStatus } from '../services/openmc-environment-service';
import { OpenMCSimulationRunner } from '../widgets/simulation-dashboard/simulation-runner';
import { OpenMCXMLGenerationService } from '../xml-generator/xml-generation-service';
import {
    applySettingsChanges,
    OpenMCSettingsEdit,
    settingsChanges,
    settingsEqual,
    settingsUpdatePatch,
    settingsValue,
    SUPPORTED_SETTINGS_PATHS,
    validateSettingsChanges
} from './openmc-settings-edit';
import { OpenMCChangeProposal, OpenMCChangeProposalService, scopeError } from './openmc-change-proposal-service';

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

/** Maximum number of findings returned by a diagnosis. */
const DIAGNOSTIC_ISSUE_LIMIT = 20;
/** Default number of run log lines returned by the run diagnosis. */
const DEFAULT_RUN_LOG_LINES = 80;
/** Hard cap for the run log line window. */
const MAX_RUN_LOG_LINES = 200;
/** Longest log line snippet embedded in a finding message. */
const MAX_LOG_SNIPPET_LENGTH = 240;

/** Shared diagnostic finding shape rendered by capability consumers. */
export interface NukeDiagnosticIssue {
    readonly severity: 'error' | 'warning' | 'info';
    readonly code: string;
    readonly category?: string;
    readonly message: string;
    readonly suggestion?: string;
}

/** One log-line classifier used by the run diagnosis. */
interface LogFindingPattern {
    readonly code: string;
    readonly severity: 'error' | 'warning';
    readonly category: string;
    readonly label: string;
    readonly suggestion: string;
    readonly matches: (line: string) => boolean;
}

/**
 * Log classifiers in priority order: a line produces the first matching
 * finding so a single failure is not reported as both a specific problem and a
 * generic error/warning line.
 */
const LOG_FINDING_PATTERNS: readonly LogFindingPattern[] = [
    {
        code: 'lost-particles',
        severity: 'error',
        category: 'geometry',
        label: 'Lost particles reported',
        suggestion: 'Check the geometry for gaps or thin regions, then re-run with particle tracking to locate the escaping particles.',
        matches: (line) => /\blost\s+particles?\b/i.test(line) || /\bparticles?\s+outside\b/i.test(line)
    },
    {
        code: 'cross-sections',
        severity: 'error',
        category: 'environment',
        label: 'Cross sections could not be loaded',
        suggestion: 'Set the OpenMC cross-sections preference or OPENMC_CROSS_SECTIONS to a valid cross_sections.xml file.',
        matches: (line) =>
            /cross[ _-]?sections?[^\n]*(?:missing|not found|could not|unable|no such file)/i.test(line) ||
            /(?:missing|not found|could not find|unable to find|no such file)[^\n]*cross[ _-]?sections?/i.test(line)
    },
    {
        code: 'overlap',
        severity: 'warning',
        category: 'geometry',
        label: 'Overlapping cells reported',
        suggestion: 'Find the overlapping cell pair and adjust the geometry so every region has a single owner.',
        matches: (line) => /\boverlap(?:ping|ped)?\b/i.test(line)
    },
    {
        code: 'convergence',
        severity: 'warning',
        category: 'convergence',
        label: 'Convergence problem reported',
        suggestion: 'Increase inactive or active batches, check the source distribution, and review the model before trusting the result.',
        matches: (line) =>
            /\binactive\b/i.test(line) ||
            /\b(?:did not|does not|not)\s+converg(?:e|ed)\b/i.test(line) ||
            /\bfail(?:ed|s)? to converge\b/i.test(line)
    },
    {
        code: 'mpi',
        severity: 'warning',
        category: 'environment',
        label: 'MPI failure reported',
        suggestion: 'Check the MPI runtime, host list, and rank count, then restart the run.',
        matches: (line) =>
            /\bmpi(?:run)?\b/i.test(line) && /\b(?:fail(?:ed|ure|s)?|error|abort(?:ed)?|unable|cannot|refused|not found)\b/i.test(line)
    },
    {
        code: 'error-line',
        severity: 'error',
        category: 'log',
        label: 'Error line in the OpenMC log',
        suggestion: 'Inspect the log around this line and fix the reported error before re-running.',
        matches: (line) =>
            /\bERROR\b/.test(line) ||
            /\bFatal\b/i.test(line) ||
            /Traceback \(most recent call last\)/i.test(line) ||
            /segmentation fault/i.test(line) ||
            /\bkilled\b/i.test(line) ||
            /\baborted\b/i.test(line)
    },
    {
        code: 'warning-line',
        severity: 'warning',
        category: 'log',
        label: 'Warning in the OpenMC log',
        suggestion: 'Review the warning; it may affect results even when the run completes.',
        matches: (line) => /\bWARNING\b/.test(line)
    }
];

const DIAGNOSTIC_ISSUE_SCHEMA: NukeJsonSchemaProperty = {
    type: 'object',
    properties: {
        severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        code: { type: 'string', description: 'Stable finding code.' },
        category: { type: 'string', description: 'Domain area for the finding.' },
        message: { type: 'string', description: 'Human-readable finding with the relevant log or validation snippet.' },
        suggestion: { type: 'string', description: 'Safe next step for the user.' }
    },
    required: ['severity', 'code', 'message'],
    additionalProperties: false
};

const DIAGNOSE_PROJECT_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false
};

const DIAGNOSE_PROJECT_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        projectPath: { type: 'string', description: 'Saved project file, when the project has one.' },
        name: { type: 'string' },
        counts: {
            type: 'object',
            properties: {
                surfaces: { type: 'integer' },
                cells: { type: 'integer' },
                universes: { type: 'integer' },
                lattices: { type: 'integer' },
                materials: { type: 'integer' },
                tallies: { type: 'integer' },
                meshes: { type: 'integer' }
            }
        },
        valid: { type: 'boolean', description: 'Whether validation passed and the diagnosis found no error findings.' },
        readyToRun: { type: 'boolean', description: 'Whether the project can run with the current environment and assets.' },
        validation: { type: 'object', description: 'Backend validation result (valid flag, issues, summary).' },
        environment: {
            type: 'object',
            properties: {
                ready: { type: 'boolean' },
                openmcVersion: { type: 'string' },
                error: { type: 'string' },
                warning: { type: 'string' }
            }
        },
        crossSectionsPath: { type: 'string', description: 'Configured cross-sections path, when one is set.' },
        crossSectionsExists: { type: 'boolean', description: 'Whether the configured cross-sections path exists.' },
        issues: { type: 'array', items: DIAGNOSTIC_ISSUE_SCHEMA },
        warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['name', 'counts', 'valid', 'readyToRun', 'validation', 'environment', 'issues', 'warnings'],
    additionalProperties: false
};

const DIAGNOSE_RUN_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        workingDirectory: { type: 'string', description: 'Exact active run directory; disambiguates multiple runs.' },
        logLines: { type: 'integer', minimum: 1, maximum: 200, default: 80 }
    },
    additionalProperties: false
};

const DIAGNOSE_RUN_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        running: { type: 'boolean' },
        processId: { type: 'string' },
        workingDirectory: { type: 'string' },
        startTime: { type: 'string' },
        logFilePath: { type: 'string' },
        logTail: { type: 'string', description: 'Last log lines, capped at 16 KiB.' },
        errorCount: { type: 'integer' },
        warningCount: { type: 'integer' },
        findings: { type: 'array', items: DIAGNOSTIC_ISSUE_SCHEMA }
    },
    required: ['running', 'errorCount', 'warningCount', 'findings'],
    additionalProperties: false
};

/** Maximum number of settings edits in one preview request. */
const MAX_SETTINGS_CHANGES = 20;

const PREVIEW_SETTINGS_INPUT_SCHEMA: NukeJsonSchema = {
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
};

const APPLY_SETTINGS_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string', description: 'Proposal id returned by nuke.openmc.previewSettings.' }
    },
    required: ['proposalId'],
    additionalProperties: false
};

const SETTINGS_CHANGE_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        proposalId: { type: 'string' },
        summary: { type: 'string' },
        changes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string' },
                    label: { type: 'string' },
                    kind: { type: 'string', enum: ['add', 'update', 'remove'] },
                    before: {},
                    after: {}
                },
                required: ['path', 'label', 'kind'],
                additionalProperties: false
            }
        }
    },
    required: ['proposalId', 'summary', 'changes'],
    additionalProperties: false
};

const SUMMARIZE_SETTINGS_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        runMode: { type: 'string', description: 'Active run mode, or unknown when the settings do not declare one.' },
        settings: {
            type: 'object',
            description: 'Current value for every supported settings path; null when the path is unset.',
            additionalProperties: {}
        }
    },
    required: ['runMode', 'settings'],
    additionalProperties: false
};

/** Result of reading the preview `changes` input. */
type SettingsChangesReadResult = { ok: true; changes: OpenMCSettingsEdit[] } | { ok: false; message: string };

/** Read and shape-check the preview `changes` array. */
function readSettingsChanges(value: unknown): SettingsChangesReadResult {
    if (!Array.isArray(value)) {
        return { ok: false, message: 'Provide a changes array with 1 to 20 settings edits.' };
    }
    if (value.length < 1 || value.length > MAX_SETTINGS_CHANGES) {
        return { ok: false, message: `Provide between 1 and ${MAX_SETTINGS_CHANGES} settings changes.` };
    }
    const changes: OpenMCSettingsEdit[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            return { ok: false, message: 'Each settings change must be an object with path and value.' };
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.path !== 'string' || record.path.length === 0) {
            return { ok: false, message: 'Each settings change needs a non-empty path.' };
        }
        if (!('value' in record)) {
            return { ok: false, message: `${record.path} needs a value.` };
        }
        if (seen.has(record.path)) {
            return { ok: false, message: `Each settings path can only be changed once: ${record.path}.` };
        }
        seen.add(record.path);
        changes.push({ path: record.path, value: record.value });
    }
    return { ok: true, changes };
}

/** Reject an absolute output path outside every workspace root. */
function outputPathError(changes: readonly OpenMCSettingsEdit[], roots: readonly string[]): string | undefined {
    for (const change of changes) {
        if (change.path !== 'output.path' || typeof change.value !== 'string') {
            continue;
        }
        if (path.isAbsolute(change.value) && !isWithinWorkspace(change.value, roots)) {
            return 'output.path must be project-relative or an absolute path inside the workspace.';
        }
    }
    return undefined;
}

/** Default summary when the preview request does not provide one. */
function defaultSettingsSummary(changes: readonly NukeChange[]): string {
    return changes.length === 1 ? `Update ${changes[0].label}.` : `Update ${changes.length} OpenMC run settings.`;
}

/** Title shared by the preview and apply change sets. */
const SETTINGS_CHANGE_TITLE = 'OpenMC settings change';

/** Read a settings snapshot from a generic proposal. */
function readSettingsSnapshot(value: unknown): OpenMCSettings | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    const run = record.run;
    if (run === null || typeof run !== 'object' || Array.isArray(run) || !Array.isArray(record.sources)) {
        return undefined;
    }
    return value as OpenMCSettings;
}

/** Build the change set returned by the preview and apply capabilities. */
function settingsChangeSet(proposal: Pick<OpenMCChangeProposal, 'id' | 'summary' | 'changes'>, applyCapability?: string): NukeChangeSet {
    return {
        id: proposal.id,
        title: SETTINGS_CHANGE_TITLE,
        summary: proposal.summary,
        changes: proposal.changes,
        ...(applyCapability ? { applyCapability } : {})
    };
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Resolve a project-relative asset path against the saved project directory. */
function resolveProjectAsset(filePath: string, projectPath: string | undefined): string | undefined {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    return projectPath ? path.resolve(path.dirname(projectPath), filePath) : undefined;
}

/** Map a backend validation issue to the shared diagnostic shape. */
function toDiagnosticIssue(issue: ValidationIssue): NukeDiagnosticIssue {
    const diagnostic: NukeDiagnosticIssue = {
        severity: issue.severity,
        code: issue.code ?? `validation-${issue.category}`,
        category: issue.category,
        message: issue.message
    };
    return issue.suggestion === undefined ? diagnostic : { ...diagnostic, suggestion: issue.suggestion };
}

/** Read the requested run log line count, clamped to the supported window. */
function readRunLogLines(value: unknown): number {
    return Math.min(readPositiveInteger(value) ?? DEFAULT_RUN_LOG_LINES, MAX_RUN_LOG_LINES);
}

/** Trim a log line to a compact snippet for a finding message. */
function logSnippet(line: string): string {
    const trimmed = line.trim();
    return trimmed.length > MAX_LOG_SNIPPET_LENGTH ? `${trimmed.slice(0, MAX_LOG_SNIPPET_LENGTH - 3)}...` : trimmed;
}

/** Classify a run log tail into findings, emitting at most one finding per line. */
function collectLogFindings(logTail: string): NukeDiagnosticIssue[] {
    const findings: NukeDiagnosticIssue[] = [];
    for (const rawLine of logTail.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }
        const pattern = LOG_FINDING_PATTERNS.find((candidate) => candidate.matches(line));
        if (!pattern) {
            continue;
        }
        findings.push({
            severity: pattern.severity,
            code: pattern.code,
            category: pattern.category,
            message: `${pattern.label}: ${logSnippet(line)}`,
            suggestion: pattern.suggestion
        });
    }
    return findings;
}

/** Keep at most {@link DIAGNOSTIC_ISSUE_LIMIT} findings, replacing the tail with a truncation notice. */
function capDiagnosticIssues(findings: readonly NukeDiagnosticIssue[]): NukeDiagnosticIssue[] {
    if (findings.length <= DIAGNOSTIC_ISSUE_LIMIT) {
        return [...findings];
    }
    const omitted = findings.length - (DIAGNOSTIC_ISSUE_LIMIT - 1);
    return [
        ...findings.slice(0, DIAGNOSTIC_ISSUE_LIMIT - 1),
        {
            severity: 'info',
            code: 'findings-truncated',
            message: `${omitted} additional finding(s) were omitted from this diagnosis.`,
            suggestion: 'Fix the highest-severity findings and run the diagnosis again.'
        }
    ];
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
        @inject(NukeCoreService) protected readonly nukeCoreService: NukeCoreService,
        @inject(FileService) protected readonly fileService: FileService,
        @inject(OpenMCChangeProposalService) protected readonly proposalService: OpenMCChangeProposalService,
        @inject(NukeUndoService) protected readonly undoService: NukeUndoService
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
            id: 'nuke.openmc.summarizeSettings',
            title: 'Summarize OpenMC settings',
            description:
                'Return every NukeAI-editable OpenMC settings path with its current value and the active run mode without contacting the backend.',
            category: ['OpenMC', 'Settings'],
            inputSchema: {
                type: 'object',
                properties: {}
            },
            outputSchema: SUMMARIZE_SETTINGS_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => true,
            invoke: async () => this.summarizeSettings()
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

        registry.register({
            id: 'nuke.openmc.diagnoseProject',
            title: 'Diagnose OpenMC project',
            description:
                'Run read-only project diagnostics across validation, environment readiness, cross sections, and DAGMC assets without writing files or starting a run.',
            category: ['OpenMC', 'Diagnostics'],
            inputSchema: DIAGNOSE_PROJECT_INPUT_SCHEMA,
            outputSchema: DIAGNOSE_PROJECT_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => true,
            invoke: async () => this.diagnoseProject()
        });

        registry.register({
            id: 'nuke.openmc.diagnoseRun',
            title: 'Diagnose OpenMC run',
            description:
                'Triage an active OpenMC run: return its log tail and classify lost particles, overlaps, cross-section, convergence, and runtime failures.',
            category: ['OpenMC', 'Diagnostics'],
            inputSchema: DIAGNOSE_RUN_INPUT_SCHEMA,
            outputSchema: DIAGNOSE_RUN_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => true,
            invoke: async (input, context) => this.diagnoseRun(input, context)
        });

        registry.register({
            id: 'nuke.openmc.previewSettings',
            title: 'Preview OpenMC settings change',
            description:
                'Validate proposed run/settings edits, including output, cutoff, and kinetics paths, return a before/after diff, and store an in-memory proposal without changing project state.',
            category: ['OpenMC', 'Settings'],
            inputSchema: PREVIEW_SETTINGS_INPUT_SCHEMA,
            outputSchema: SETTINGS_CHANGE_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: deriveAnnotations('read'),
            when: () => true,
            invoke: async (input, context) => this.previewSettings(input, context)
        });

        registry.register({
            id: 'nuke.openmc.applySettings',
            title: 'Apply OpenMC settings change',
            description:
                'Apply a previously previewed run/settings change, reject stale or cross-field-invalid previews, and register an in-memory undo for the changed paths.',
            category: ['OpenMC', 'Settings'],
            inputSchema: APPLY_SETTINGS_INPUT_SCHEMA,
            outputSchema: SETTINGS_CHANGE_OUTPUT_SCHEMA,
            risk: 'write',
            annotations: deriveAnnotations('write'),
            requiresConfirmation: true,
            when: () => true,
            invoke: async (input) => this.applySettings(input)
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
                author: state.metadata.author,
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

    protected async summarizeSettings(): Promise<NukeCapabilityResult> {
        const settings = this.stateManager.getState().settings;
        const values: Record<string, unknown> = {};
        for (const path of SUPPORTED_SETTINGS_PATHS) {
            values[path] = settingsValue(settings, path) ?? null;
        }
        const run = settings.run as unknown as { mode?: string };
        return {
            ok: true,
            data: {
                runMode: run.mode ?? 'unknown',
                settings: values
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

    protected async diagnoseProject(): Promise<NukeCapabilityResult> {
        const state = this.stateManager.getState();
        const projectPath = this.stateManager.projectPath;

        let validation: ValidationResult;
        try {
            validation = await this.backendService.validateState({ state, level: 'standard' });
        } catch (error) {
            return { ok: false, message: `OpenMC project diagnosis failed: ${errorMessage(error)}` };
        }

        let environmentStatus: OpenMCEnvironmentStatus;
        try {
            environmentStatus = await this.environmentService.refreshStatus();
        } catch (error) {
            environmentStatus = { ready: false, error: errorMessage(error) };
        }

        const issues: NukeDiagnosticIssue[] = validation.issues.map(toDiagnosticIssue);
        const environmentWarnings: string[] = [];

        if (!environmentStatus.ready) {
            const message = environmentStatus.error ?? 'The OpenMC environment is not ready.';
            issues.push({
                severity: 'warning',
                code: 'environment-not-ready',
                category: 'environment',
                message,
                suggestion: 'Install OpenMC in the selected Python environment or switch to an environment that has it.'
            });
            environmentWarnings.push(message);
        }
        if (environmentStatus.warning) {
            issues.push({
                severity: 'info',
                code: 'environment-warning',
                category: 'environment',
                message: environmentStatus.warning,
                suggestion: 'Review the environment warning; optional OpenMC features may be unavailable.'
            });
            environmentWarnings.push(environmentStatus.warning);
        }

        const crossSectionsPath = this.nukeCoreService.getCrossSectionsPath();
        let crossSectionsExists: boolean | undefined;
        if (!crossSectionsPath) {
            issues.push({
                severity: 'warning',
                code: 'cross-sections-unset',
                category: 'settings',
                message: 'No cross-sections path is configured.',
                suggestion: 'Set the OpenMC cross-sections preference or OPENMC_CROSS_SECTIONS to a cross_sections.xml file.'
            });
        } else {
            try {
                crossSectionsExists = await this.fileService.exists(new URI(crossSectionsPath));
            } catch {
                crossSectionsExists = false;
            }
            if (!crossSectionsExists) {
                issues.push({
                    severity: 'warning',
                    code: 'cross-sections-missing',
                    category: 'settings',
                    message: `The configured cross-sections file does not exist: ${crossSectionsPath}`,
                    suggestion: 'Point the OpenMC cross-sections preference at an existing cross_sections.xml file.'
                });
            }
        }

        const dagmcFile = state.settings.dagmcFile;
        let dagmcMissing = false;
        if (dagmcFile) {
            const resolvedDagmcPath = resolveProjectAsset(dagmcFile, projectPath);
            let dagmcExists = false;
            if (resolvedDagmcPath) {
                try {
                    dagmcExists = (await this.backendService.checkFileExists(resolvedDagmcPath)).exists;
                } catch {
                    dagmcExists = false;
                }
            }
            if (!dagmcExists) {
                dagmcMissing = true;
                issues.push({
                    severity: 'error',
                    code: 'dagmc-missing',
                    category: 'geometry',
                    message: `The configured DAGMC geometry file does not exist: ${dagmcFile}`,
                    suggestion: 'Import the .h5m model again or update the DAGMC file path in settings.'
                });
            }
        }

        const validationReports = (category: ValidationIssue['category']): boolean =>
            validation.issues.some((issue) => issue.category === category);
        if (state.materials.length === 0 && !validationReports('materials')) {
            issues.push({
                severity: 'warning',
                code: 'no-materials',
                category: 'materials',
                message: 'The project has no materials.',
                suggestion: 'Add at least one material before running the model.'
            });
        }
        if (state.geometry.cells.length === 0 && !dagmcFile && !validationReports('geometry')) {
            issues.push({
                severity: 'warning',
                code: 'no-geometry',
                category: 'geometry',
                message: 'The project has no CSG cells and no DAGMC geometry.',
                suggestion: 'Add cells in the CSG builder or import a DAGMC model.'
            });
        }
        if (state.tallies.length === 0) {
            issues.push({
                severity: 'info',
                code: 'no-tallies',
                category: 'tallies',
                message: 'No tallies are defined; the run will only produce global results such as k-eff.',
                suggestion: 'Add tallies to score fluxes, reaction rates, or other quantities of interest.'
            });
        }

        const valid = validation.valid && !issues.some((issue) => issue.severity === 'error');
        const readyToRun = valid && environmentStatus.ready && crossSectionsExists !== false && !dagmcMissing;
        const warnings = [
            ...new Set([...environmentWarnings, ...issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message)])
        ];

        const environment: Record<string, unknown> = { ready: environmentStatus.ready };
        if (environmentStatus.openmcVersion !== undefined) {
            environment.openmcVersion = environmentStatus.openmcVersion;
        }
        if (environmentStatus.error !== undefined) {
            environment.error = environmentStatus.error;
        }
        if (environmentStatus.warning !== undefined) {
            environment.warning = environmentStatus.warning;
        }

        return {
            ok: true,
            data: {
                ...(projectPath !== undefined ? { projectPath } : {}),
                name: state.metadata.name,
                counts: {
                    surfaces: state.geometry.surfaces.length,
                    cells: state.geometry.cells.length,
                    universes: state.geometry.universes.length,
                    lattices: state.geometry.lattices.length,
                    materials: state.materials.length,
                    tallies: state.tallies.length,
                    meshes: state.meshes.length
                },
                valid,
                readyToRun,
                validation,
                environment,
                ...(crossSectionsPath ? { crossSectionsPath, crossSectionsExists: crossSectionsExists ?? false } : {}),
                issues: capDiagnosticIssues(issues),
                warnings
            }
        };
    }

    protected async diagnoseRun(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const requestedDirectory = readString(record, 'workingDirectory');
        const logLines = readRunLogLines(record.logLines);

        let active: ActiveSimulationInfo[];
        try {
            active = await this.backendService.getActiveSimulations();
        } catch (error) {
            return { ok: false, message: `Could not list active OpenMC runs: ${errorMessage(error)}` };
        }

        let run: ActiveSimulationInfo | undefined;
        if (requestedDirectory !== undefined) {
            if (!isWorkspacePath(requestedDirectory, context.workspaceRoots)) {
                return { ok: false, message: 'workingDirectory must be an absolute path inside the workspace.' };
            }
            run = active.find((candidate) => candidate.workingDirectory === requestedDirectory);
        } else if (active.length === 1) {
            run = active[0];
        } else if (active.length > 1) {
            return {
                ok: false,
                message: `Multiple OpenMC runs are active (${active.length}); provide a workingDirectory to choose one.`
            };
        }

        if (!run) {
            return { ok: true, data: { running: false } };
        }

        let log: SimulationLogResult;
        try {
            log = await this.backendService.getSimulationLog(run.processId);
        } catch (error) {
            return { ok: false, message: `Could not read the OpenMC run log: ${errorMessage(error)}` };
        }
        if (!log.success) {
            return { ok: false, message: log.error ?? 'Could not read the OpenMC run log.' };
        }

        const logTail = tailLog(log.logContent ?? '', logLines);
        const findings = capDiagnosticIssues(collectLogFindings(logTail));
        return {
            ok: true,
            data: {
                running: true,
                processId: run.processId,
                workingDirectory: run.workingDirectory,
                startTime: run.startTime,
                logFilePath: log.logPath ?? run.logFilePath,
                logTail,
                errorCount: findings.filter((finding) => finding.severity === 'error').length,
                warningCount: findings.filter((finding) => finding.severity === 'warning').length,
                findings
            }
        };
    }

    /**
     * Validate and diff a proposed settings edit without touching state.
     * The stored proposal pins the current settings so apply can detect a
     * stale preview.
     */
    protected async previewSettings(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = readRecord(input);
        const parsed = readSettingsChanges(record.changes);
        if (!parsed.ok) {
            return { ok: false, message: parsed.message };
        }
        const pathError = outputPathError(parsed.changes, context.workspaceRoots);
        if (pathError) {
            return { ok: false, message: pathError };
        }

        const state = this.stateManager.getState();
        const settings = state.settings;
        let changes: NukeChange[];
        try {
            changes = settingsChanges(settings, parsed.changes, { tallies: state.tallies });
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        }

        const afterSettings = applySettingsChanges(settings, parsed.changes);
        const summary = readString(record, 'summary')?.trim() || defaultSettingsSummary(changes);
        const proposal = this.proposalService.create({
            scope: 'settings',
            summary,
            changes,
            before: settings,
            after: afterSettings
        });
        return {
            ok: true,
            data: { proposalId: proposal.id, summary, changes },
            changeSet: settingsChangeSet(proposal, 'nuke.openmc.applySettings'),
            nextActions: [{ capability: 'nuke.openmc.applySettings', reason: 'Apply the previewed settings change after confirmation.' }]
        };
    }

    /**
     * Apply a live settings proposal after verifying the preview is not stale,
     * then register a session undo that restores only the changed paths.
     */
    protected async applySettings(input: unknown): Promise<NukeCapabilityResult> {
        const proposalId = readString(readRecord(input), 'proposalId')?.trim();
        if (!proposalId) {
            return { ok: false, message: 'proposalId is required.' };
        }

        const proposal = this.proposalService.get(proposalId);
        if (!proposal) {
            return { ok: false, message: 'This settings preview is missing or has expired. Preview again.' };
        }
        const wrongScope = scopeError(proposal, 'settings');
        if (wrongScope) {
            return { ok: false, message: wrongScope };
        }
        const beforeSettings = readSettingsSnapshot(proposal.before);
        const afterSettings = readSettingsSnapshot(proposal.after);
        if (!beforeSettings || !afterSettings) {
            return { ok: false, message: 'This settings preview is missing its settings snapshot. Preview again.' };
        }

        const current = this.stateManager.getState().settings;
        const stale = proposal.changes.some(
            (change) => !settingsEqual(settingsValue(current, change.path), settingsValue(beforeSettings, change.path))
        );
        if (stale) {
            return { ok: false, message: 'Settings changed since the preview. Preview again.' };
        }

        // Apply only the previewed paths to the current settings so an unrelated
        // edit made after the preview is not overwritten by the snapshot.
        const appliedChanges = proposal.changes.map((change) => ({ path: change.path, value: change.after }));
        const crossFieldError = validateSettingsChanges(current, appliedChanges, {
            tallies: this.stateManager.getState().tallies,
            requireKineticsTallies: false
        });
        if (crossFieldError) {
            return { ok: false, message: crossFieldError };
        }
        const updated = applySettingsChanges(current, appliedChanges);
        this.stateManager.updateSettings(updated);
        this.proposalService.remove(proposal.id);
        const undoToken = this.undoService.register(this.createSettingsUndo(proposal, beforeSettings, afterSettings));
        return {
            ok: true,
            data: { proposalId: proposal.id, summary: proposal.summary, changes: proposal.changes },
            changeSet: settingsChangeSet(proposal),
            undoToken,
            nextActions: [{ capability: 'nuke.openmc.diagnoseProject', reason: 'Check the project after applying the settings change.' }]
        };
    }

    /** Build the undo handler for an applied settings proposal. */
    protected createSettingsUndo(
        proposal: OpenMCChangeProposal,
        beforeSettings: OpenMCSettings,
        afterSettings: OpenMCSettings
    ): NukeUndoEntry {
        return {
            title: `Undo ${proposal.summary}`,
            undo: async () => {
                const current = this.stateManager.getState().settings;
                const changed = proposal.changes.some(
                    (change) => !settingsEqual(settingsValue(current, change.path), settingsValue(afterSettings, change.path))
                );
                if (changed) {
                    return { ok: false, message: 'Settings changed since the edit; the change can no longer be undone.' };
                }

                const beforeChanges = proposal.changes.map((change) => ({ path: change.path, value: change.before }));
                this.stateManager.updateSettings(settingsUpdatePatch(current, beforeChanges));
                return { ok: true, message: 'Settings change undone.' };
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
