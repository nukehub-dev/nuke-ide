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
 * Visualizer diagnostics capabilities
 *
 * Read-only statepoint comparison and tally-series analysis. Both capabilities
 * read files through {@link OpenMCBackendService} directly, never through
 * `OpenMCService.loadStatepoint`, so the loaded viewer, active widget, and
 * current statepoint stay untouched. No file is written and no backend RPC is
 * added.
 *
 * @module nuke-visualizer/browser/capabilities
 */

import * as path from 'path';
import type {
    NukeCapability,
    NukeCapabilityContribution,
    NukeCapabilityContext,
    NukeCapabilityRegistry,
    NukeCapabilityResult,
    NukeJsonSchema
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import type {
    OpenMCBackendService,
    OpenMCTallyInfo,
    OpenMCTallySeries,
    OpenMCTallySeriesOptions,
    OpenMCTallySeriesStatistic,
    OpenMCStatepointInfo
} from '../../common/openmc-protocol';
import { analyzeTallySeries, compareStatepointMetadata } from './visualizer-diagnostics';
import type { TallyNameLookup } from './visualizer-diagnostics';

const COMPARE_STATEPOINTS = 'nuke.viz.compareStatepoints';
const ANALYZE_TALLY_SERIES = 'nuke.viz.analyzeTallySeries';

/** Maximum number of statepoint files a tally series may read. */
export const MAX_TALLY_SERIES_FILES = 50;

const DIAGNOSTIC_ISSUE_SCHEMA = {
    type: 'object',
    properties: {
        severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        code: { type: 'string' },
        category: { type: 'string' },
        message: { type: 'string' },
        suggestion: { type: 'string' }
    },
    required: ['severity', 'code', 'message'],
    additionalProperties: false
} as const;

const ISSUES_SCHEMA = {
    type: 'array',
    items: DIAGNOSTIC_ISSUE_SCHEMA
} as const;

const WARNINGS_SCHEMA = {
    type: 'array',
    items: { type: 'string' }
} as const;

const STATEPOINT_SIDE_SCHEMA = {
    type: 'object',
    properties: {
        batches: { type: 'number' },
        generationsPerBatch: { type: 'number' },
        kEff: { type: 'number' },
        kEffStd: { type: 'number' },
        nTallies: { type: 'number' },
        tallyIds: { type: 'array', items: { type: 'number' } }
    },
    required: ['batches', 'generationsPerBatch', 'nTallies', 'tallyIds'],
    additionalProperties: false
} as const;

const COMPARE_STATEPOINTS_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        fileA: { type: 'string', description: 'Absolute workspace statepoint path.' },
        fileB: { type: 'string', description: 'Absolute workspace statepoint path.' }
    },
    required: ['fileA', 'fileB'],
    additionalProperties: false
};

const COMPARE_STATEPOINTS_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        fileA: { type: 'string' },
        fileB: { type: 'string' },
        a: STATEPOINT_SIDE_SCHEMA,
        b: STATEPOINT_SIDE_SCHEMA,
        delta: {
            type: 'object',
            properties: {
                batches: { type: 'number' },
                kEff: { type: 'number' },
                kEffStd: { type: 'number' },
                tallyIdsAdded: { type: 'array', items: { type: 'number' } },
                tallyIdsRemoved: { type: 'array', items: { type: 'number' } }
            },
            required: ['tallyIdsAdded', 'tallyIdsRemoved'],
            additionalProperties: false
        },
        issues: ISSUES_SCHEMA,
        warnings: WARNINGS_SCHEMA
    },
    required: ['fileA', 'fileB', 'a', 'b', 'delta', 'issues', 'warnings'],
    additionalProperties: false
};

const ANALYZE_TALLY_SERIES_INPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        files: {
            type: 'array',
            description: 'One to fifty absolute workspace statepoint paths.',
            minItems: 1,
            maxItems: MAX_TALLY_SERIES_FILES,
            items: { type: 'string' }
        },
        tallyId: { type: 'integer' },
        score: { type: 'string' },
        nuclide: { type: 'string' },
        statistic: { type: 'string', enum: ['total', 'mean', 'max'], default: 'total' }
    },
    required: ['files', 'tallyId'],
    additionalProperties: false
};

const ANALYZE_TALLY_SERIES_OUTPUT_SCHEMA: NukeJsonSchema = {
    type: 'object',
    properties: {
        files: { type: 'array', items: { type: 'string' } },
        tallyId: { type: 'integer' },
        tallyName: { type: 'string' },
        score: { type: 'string' },
        nuclide: { type: 'string' },
        statistic: { type: 'string', enum: ['total', 'mean', 'max'] },
        timeLabel: { type: 'string' },
        steps: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    index: { type: 'integer' },
                    time: { type: 'number' },
                    file: { type: 'string' },
                    fileName: { type: 'string' },
                    value: { type: 'number' },
                    std: { type: 'number' },
                    nBins: { type: 'number' }
                },
                required: ['index', 'time', 'file', 'fileName', 'value', 'std', 'nBins'],
                additionalProperties: false
            }
        },
        range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        hasMesh: { type: 'boolean' },
        issues: ISSUES_SCHEMA,
        warnings: WARNINGS_SCHEMA
    },
    required: [
        'files',
        'tallyId',
        'tallyName',
        'score',
        'nuclide',
        'statistic',
        'timeLabel',
        'steps',
        'range',
        'hasMesh',
        'issues',
        'warnings'
    ],
    additionalProperties: false
};

/**
 * Register the read-only statepoint comparison and tally-series capabilities.
 *
 * The backend is passed explicitly so the module can be exercised with a fake
 * backend in a node test environment and so no viewer service is reachable from
 * either capability.
 */
export class VisualizerDiagnosticsCapabilities implements NukeCapabilityContribution {
    constructor(protected readonly backend: OpenMCBackendService) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register(this.compareStatepointsCapability());
        registry.register(this.analyzeTallySeriesCapability());
    }

    protected compareStatepointsCapability(): NukeCapability {
        return {
            id: COMPARE_STATEPOINTS,
            title: 'Compare OpenMC statepoints',
            description:
                'Compare two absolute workspace OpenMC statepoints by metadata: batches, generations per batch, k-effective with its ' +
                'standard deviation, and tally ids. Both files are read through the headless OpenMC backend; neither is loaded into ' +
                'the viewer and the active statepoint never changes.',
            category: ['Visualizer', 'Statepoint'],
            tags: ['statepoint', 'diagnostics', 'comparison'],
            inputSchema: COMPARE_STATEPOINTS_INPUT_SCHEMA,
            outputSchema: COMPARE_STATEPOINTS_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            when: () => true,
            examples: [
                {
                    description: 'Compare two statepoints in the workspace',
                    input: { fileA: '/workspace/run-a/statepoint.100.h5', fileB: '/workspace/run-b/statepoint.100.h5' }
                }
            ],
            invoke: (input, context) => this.compareStatepoints(input, context)
        };
    }

    protected analyzeTallySeriesCapability(): NukeCapability {
        return {
            id: ANALYZE_TALLY_SERIES,
            title: 'Analyze OpenMC tally series',
            description:
                'Analyze one tally and score across one to fifty absolute workspace statepoints with the existing tally-series ' +
                'aggregation: per-step values, standard deviations, bin counts, and uncertainty findings. It reports aggregate step ' +
                'statistics only; spatial or per-bin detail stays in the viewer.',
            category: ['Visualizer', 'Tallies'],
            tags: ['tally', 'statepoint', 'diagnostics', 'uncertainty'],
            inputSchema: ANALYZE_TALLY_SERIES_INPUT_SCHEMA,
            outputSchema: ANALYZE_TALLY_SERIES_OUTPUT_SCHEMA,
            risk: 'read',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            when: () => true,
            examples: [
                {
                    description: 'Analyze a flux tally across sibling statepoints',
                    input: { files: ['/workspace/run/statepoint.100.h5', '/workspace/run/statepoint.200.h5'], tallyId: 1, score: 'flux' }
                }
            ],
            invoke: (input, context) => this.analyzeTallySeries(input, context)
        };
    }

    protected async compareStatepoints(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = asRecord(input);
        const fileA = readNonEmptyString(record.fileA);
        const fileB = readNonEmptyString(record.fileB);
        if (fileA === undefined) {
            return { ok: false, message: 'fileA is required.' };
        }
        if (fileB === undefined) {
            return { ok: false, message: 'fileB is required.' };
        }
        for (const [label, filePath] of [
            ['fileA', fileA],
            ['fileB', fileB]
        ] as const) {
            const pathError = validateDiagnosticPath(label, filePath, context);
            if (pathError) {
                return { ok: false, message: pathError };
            }
        }

        const loadedA = await this.loadStatepoint('fileA', fileA);
        if (!loadedA.ok) {
            return loadedA;
        }
        const loadedB = await this.loadStatepoint('fileB', fileB);
        if (!loadedB.ok) {
            return loadedB;
        }

        const warnings: string[] = [];
        const talliesA = await this.listTallies('fileA', fileA, warnings);
        const talliesB = await this.listTallies('fileB', fileB, warnings);
        const analysis = compareStatepointMetadata(fileA, loadedA.info, fileB, loadedB.info, tallyNames(talliesA, talliesB));

        return {
            ok: true,
            data: { ...analysis, warnings: [...analysis.warnings, ...warnings] }
        };
    }

    protected async analyzeTallySeries(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = asRecord(input);
        const files = readStringArray(record.files);
        if (!files || files.length === 0) {
            return { ok: false, message: 'files must contain at least one statepoint path.' };
        }
        if (files.length > MAX_TALLY_SERIES_FILES) {
            return { ok: false, message: `At most ${MAX_TALLY_SERIES_FILES} statepoint files can be analyzed.` };
        }
        for (let index = 0; index < files.length; index++) {
            const pathError = validateDiagnosticPath(`files[${index}]`, files[index], context);
            if (pathError) {
                return { ok: false, message: pathError };
            }
        }

        const tallyId = record.tallyId;
        if (typeof tallyId !== 'number' || !Number.isInteger(tallyId)) {
            return { ok: false, message: 'tallyId must be an integer.' };
        }
        const statistic = readStatistic(record.statistic);
        if (statistic === undefined) {
            return { ok: false, message: 'statistic must be total, mean, or max.' };
        }

        const options: OpenMCTallySeriesOptions = { tallyId, statistic };
        const score = readNonEmptyString(record.score);
        const nuclide = readNonEmptyString(record.nuclide);
        if (score !== undefined) {
            options.score = score;
        }
        if (nuclide !== undefined) {
            options.nuclide = nuclide;
        }

        let series: OpenMCTallySeries;
        try {
            series = await this.backend.getTallySeries(files, options);
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        if (!series) {
            return { ok: false, message: 'Failed to read the tally series.' };
        }

        return { ok: true, data: analyzeTallySeries({ ...series, files }) };
    }

    protected async loadStatepoint(
        label: string,
        filePath: string
    ): Promise<{ readonly ok: true; readonly info: OpenMCStatepointInfo } | { readonly ok: false; readonly message: string }> {
        let info: OpenMCStatepointInfo;
        try {
            info = await this.backend.loadStatepoint(filePath);
        } catch (error) {
            return { ok: false, message: `Failed to load ${label}: ${errorMessage(error)}` };
        }
        if (!info) {
            return { ok: false, message: `Failed to load ${label}.` };
        }
        return { ok: true, info };
    }

    protected async listTallies(label: string, filePath: string, warnings: string[]): Promise<OpenMCTallyInfo[]> {
        try {
            const tallies = await this.backend.listTallies(filePath);
            if (!Array.isArray(tallies)) {
                warnings.push(`Could not list tallies for ${label}: unexpected backend response.`);
                return [];
            }
            return tallies;
        } catch (error) {
            warnings.push(`Could not list tallies for ${label}: ${errorMessage(error)}`);
            return [];
        }
    }
}

function tallyNames(talliesA: readonly OpenMCTallyInfo[], talliesB: readonly OpenMCTallyInfo[]): TallyNameLookup {
    return {
        a: new Map(talliesA.map((tally) => [tally.id, tally.name])),
        b: new Map(talliesB.map((tally) => [tally.id, tally.name]))
    };
}

function validateDiagnosticPath(label: string, filePath: string, context: NukeCapabilityContext): string | undefined {
    if (!path.isAbsolute(filePath)) {
        return `${label} must be an absolute path.`;
    }
    if (!isWithinWorkspace(filePath, context.workspaceRoots)) {
        return `${label} must be inside the workspace.`;
    }
    return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const files: string[] = [];
    for (const entry of value) {
        const file = readNonEmptyString(entry);
        if (file === undefined) {
            return undefined;
        }
        files.push(file);
    }
    return files;
}

function readStatistic(value: unknown): OpenMCTallySeriesStatistic | undefined {
    if (value === undefined) {
        return 'total';
    }
    return value === 'total' || value === 'mean' || value === 'max' ? value : undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
