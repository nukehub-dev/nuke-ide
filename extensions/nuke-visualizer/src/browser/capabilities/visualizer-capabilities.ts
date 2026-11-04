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
 * Visualizer capabilities
 *
 * Registers the visualizer's AI-facing actions with the neutral nuke-core
 * capability registry: statepoint summaries, metadata-only statepoint
 * diagnosis, statepoint opening, and truthful DAGMC viewport captures. The
 * capability surface stays independent of the AI bridge, so any capability
 * consumer can invoke it.
 *
 * Diagnosis triages only the metadata of the currently loaded statepoint; raw
 * tally values and uncertainties are never read and no file is loaded or
 * replaced.
 *
 * @module nuke-visualizer/browser/capabilities
 */

import type { Event } from '@theia/core/lib/common/event';
import URI from '@theia/core/lib/common/uri';
import * as path from 'path';
import {
    NukeCapability,
    NukeCapabilityContribution,
    NukeCapabilityContext,
    NukeCapabilityContextContribution,
    NukeCapabilityRegistry,
    NukeCapabilityResult
} from 'nuke-core/lib/common/nuke-capability-protocol';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import type { ApplicationShell, Widget } from '@theia/core/lib/browser';
import type { OpenMCContribution } from '../plugins/openmc/openmc-contribution';
import type { OpenMCService } from '../plugins/openmc/openmc-service';
import type { OpenMCStatepointInfo, OpenMCTallyInfo } from '../../common/openmc-protocol';
import type { ScreenshotFormat, ScreenshotOptions, ScreenshotScale } from '../viewer-core/canvas-screenshot';
import { capDiagnosticIssues, formatRelativeUncertainty } from './visualizer-diagnostics';
import type { NukeDiagnosticIssue } from './visualizer-diagnostics';

export type { NukeDiagnosticIssue } from './visualizer-diagnostics';

const SUMMARIZE_STATEPOINT = 'nuke.viz.summarizeStatepoint';
const DIAGNOSE_STATEPOINT = 'nuke.viz.diagnoseStatepoint';
const OPEN_STATEPOINT = 'nuke.viz.openStatepoint';
const CAPTURE_VIEW = 'nuke.viz.captureView';

const HIGH_KEFF_RELATIVE_UNCERTAINTY = 0.005;
const NOTABLE_KEFF_RELATIVE_UNCERTAINTY = 0.001;
const MIN_BATCHES = 50;
const MIN_GENERATIONS_PER_BATCH = 10;
const MANY_TALLIES_THRESHOLD = 20;

/** Statepoint summary payload returned by {@link VisualizerCapabilities}. */
export interface StatepointSummary {
    readonly file: string;
    readonly batches: number;
    readonly generationsPerBatch: number;
    readonly kEff?: number;
    readonly kEffStd?: number;
    readonly nTallies: number;
    readonly tallyIds: readonly number[];
    readonly tallies: readonly Pick<OpenMCTallyInfo, 'id' | 'name' | 'scores' | 'nuclides' | 'hasMesh'>[];
}

/** Tally metadata included in a statepoint diagnosis. */
export interface StatepointTallyDiagnostic {
    readonly id: number;
    readonly name: string;
    readonly scores: readonly string[];
    readonly nuclides: readonly string[];
    readonly hasMesh: boolean;
}

/** Statepoint diagnosis payload returned by {@link VisualizerCapabilities}. */
export interface StatepointDiagnosis {
    readonly file: string;
    readonly batches: number;
    readonly generationsPerBatch: number;
    readonly kEff?: number;
    readonly kEffStd?: number;
    readonly relativeKeffUncertainty?: number;
    readonly nTallies: number;
    readonly tallies: readonly StatepointTallyDiagnostic[];
    readonly issues: readonly NukeDiagnosticIssue[];
    readonly warnings: readonly string[];
}

/** Capture preview returned by {@link VisualizerCapabilities}. */
export interface CapturedView {
    readonly dataUrl: string;
    readonly mimeType: string;
}

/** Widget surface used by the capture capability (the real widget also renders). */
interface CaptureViewer extends Widget {
    captureScreenshot(options?: ScreenshotOptions): Promise<CapturedView>;
}

/** Locate a DAGMC viewer among the shell's widgets. */
export type DagmcViewerMatcher = (widget: Widget | undefined) => widget is CaptureViewer;

/**
 * Fallback matcher for contexts that do not supply the concrete viewer class
 * (tests and other capability consumers): any widget exposing the capture
 * method is treated as capture-capable. The app passes an `instanceof
 * DagmcViewerWidget` matcher so production stays strictly DAGMC-only.
 */
const defaultDagmcViewerMatcher: DagmcViewerMatcher = (widget): widget is CaptureViewer =>
    !!widget && typeof (widget as unknown as Partial<CaptureViewer>).captureScreenshot === 'function';

/**
 * Register the visualizer capabilities with the nuke-core registry.
 *
 * Dependencies are passed explicitly (instead of using decorated property
 * injection) so the capability module stays free of the three.js widget chain
 * and can be exercised with fakes in a node test environment.
 */
export class VisualizerCapabilities implements NukeCapabilityContribution {
    constructor(
        protected readonly openmcService: OpenMCService,
        protected readonly openmcContribution: OpenMCContribution,
        protected readonly shell: ApplicationShell,
        protected readonly isDagmcViewer: DagmcViewerMatcher = defaultDagmcViewerMatcher
    ) {}

    registerCapabilities(registry: NukeCapabilityRegistry): void {
        registry.register(this.summarizeStatepointCapability());
        registry.register(this.diagnoseStatepointCapability());
        registry.register(this.openStatepointCapability());
        registry.register(this.captureViewCapability());
    }

    protected summarizeStatepointCapability(): NukeCapability {
        return {
            id: SUMMARIZE_STATEPOINT,
            title: 'Summarize OpenMC statepoint',
            description:
                'Summarize an OpenMC statepoint: batches, k-effective when present, and the tally ids with their scores, nuclides, and mesh status. Uses the loaded statepoint unless an absolute workspace path is supplied.',
            category: ['Visualizer', 'Statepoint'],
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: {
                        type: 'string',
                        description: 'Absolute statepoint path. Defaults to the loaded statepoint.'
                    }
                },
                additionalProperties: false
            },
            risk: 'read',
            when: () => true,
            examples: [
                { description: 'Summarize the loaded statepoint', input: {} },
                { description: 'Summarize a statepoint by path', input: { filePath: '/workspace/statepoint.100.h5' } }
            ],
            invoke: (input, context) => this.summarizeStatepoint(input, context)
        };
    }

    protected diagnoseStatepointCapability(): NukeCapability {
        return {
            id: DIAGNOSE_STATEPOINT,
            title: 'Diagnose OpenMC statepoint',
            description:
                'Triage the loaded OpenMC statepoint metadata: k-effective uncertainty, batch and generation counts, and tally coverage. Reads loaded metadata only; it never changes the loaded statepoint and does not inspect raw tally values or their uncertainties.',
            category: ['Visualizer', 'Statepoint'],
            inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false
            },
            outputSchema: {
                type: 'object',
                properties: {
                    file: { type: 'string' },
                    batches: { type: 'number' },
                    generationsPerBatch: { type: 'number' },
                    kEff: { type: 'number' },
                    kEffStd: { type: 'number' },
                    relativeKeffUncertainty: { type: 'number' },
                    nTallies: { type: 'number' },
                    tallies: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'number' },
                                name: { type: 'string' },
                                scores: { type: 'array', items: { type: 'string' } },
                                nuclides: { type: 'array', items: { type: 'string' } },
                                hasMesh: { type: 'boolean' }
                            },
                            required: ['id', 'name', 'scores', 'nuclides', 'hasMesh'],
                            additionalProperties: false
                        }
                    },
                    issues: {
                        type: 'array',
                        items: {
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
                        }
                    },
                    warnings: { type: 'array', items: { type: 'string' } }
                },
                required: ['file', 'batches', 'generationsPerBatch', 'nTallies', 'tallies', 'issues', 'warnings'],
                additionalProperties: false
            },
            risk: 'read',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            when: () => true,
            examples: [{ description: 'Diagnose the loaded statepoint', input: {} }],
            invoke: () => this.diagnoseStatepoint()
        };
    }

    protected openStatepointCapability(): NukeCapability {
        return {
            id: OPEN_STATEPOINT,
            title: 'Open OpenMC statepoint',
            description: 'Open an absolute workspace statepoint in the OpenMC statepoint viewer.',
            category: ['Visualizer', 'Statepoint'],
            inputSchema: {
                type: 'object',
                properties: {
                    filePath: {
                        type: 'string',
                        description: 'Absolute statepoint path.'
                    }
                },
                required: ['filePath'],
                additionalProperties: false
            },
            risk: 'write',
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            requiresConfirmation: true,
            examples: [{ description: 'Open a statepoint by path', input: { filePath: '/workspace/statepoint.100.h5' } }],
            invoke: (input, context) => this.openStatepoint(input, context)
        };
    }

    protected captureViewCapability(): NukeCapability {
        return {
            id: CAPTURE_VIEW,
            title: 'Capture DAGMC viewport',
            description:
                'Capture the active DAGMC viewer (or the first DAGMC viewer in the main area) as a truthful image preview at the current camera and visibility state.',
            category: ['Visualizer', 'View'],
            inputSchema: {
                type: 'object',
                properties: {
                    format: {
                        type: 'string',
                        enum: ['png', 'jpeg', 'webp'],
                        default: 'png'
                    },
                    scale: {
                        type: 'integer',
                        enum: [1, 2, 4],
                        default: 1
                    },
                    transparent: {
                        type: 'boolean',
                        default: false
                    },
                    caption: {
                        type: 'string'
                    }
                },
                additionalProperties: false
            },
            risk: 'read',
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
            },
            examples: [{ description: 'Capture the active DAGMC viewport', input: { format: 'png' } }],
            invoke: (input) => this.captureView(input)
        };
    }

    protected async summarizeStatepoint(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = asRecord(input);
        const filePath = readNonEmptyString(record.filePath);
        let info: OpenMCStatepointInfo | null;
        if (filePath !== undefined) {
            const pathError = validateStatepointPath(filePath, context);
            if (pathError) {
                return { ok: false, message: pathError };
            }
            try {
                info = await this.openmcService.loadStatepoint(new URI(filePath));
            } catch (error) {
                return { ok: false, message: errorMessage(error) };
            }
            if (!info) {
                return { ok: false, message: 'Failed to load statepoint.' };
            }
        } else {
            info = this.openmcService.getCurrentStatepoint();
            if (!info) {
                return { ok: false, message: 'No statepoint is loaded.' };
            }
        }
        return { ok: true, data: summarizeStatepoint(info, this.openmcService.getCurrentTallies()) };
    }

    protected async diagnoseStatepoint(): Promise<NukeCapabilityResult> {
        const info = this.openmcService.getCurrentStatepoint();
        if (!info) {
            return { ok: false, message: 'No statepoint is loaded.' };
        }
        return { ok: true, data: diagnoseStatepoint(info, this.openmcService.getCurrentTallies()) };
    }

    protected async openStatepoint(input: unknown, context: NukeCapabilityContext): Promise<NukeCapabilityResult> {
        const record = asRecord(input);
        const filePath = readNonEmptyString(record.filePath);
        if (filePath === undefined) {
            return { ok: false, message: 'filePath is required.' };
        }
        const pathError = validateStatepointPath(filePath, context);
        if (pathError) {
            return { ok: false, message: pathError };
        }
        try {
            await this.openmcContribution.open(new URI(filePath));
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        return {
            ok: true,
            data: { filePath, opened: true },
            nextActions: [
                {
                    capability: CAPTURE_VIEW,
                    reason: 'Capture the active DAGMC viewport as a preview.'
                }
            ]
        };
    }

    protected async captureView(input: unknown): Promise<NukeCapabilityResult> {
        const record = asRecord(input);
        const active = this.shell.activeWidget;
        const viewer = this.isDagmcViewer(active) ? active : this.shell.getWidgets('main').find(this.isDagmcViewer);
        if (!viewer) {
            return { ok: false, message: 'Open a DAGMC viewer before capturing the view.' };
        }
        const format = readScreenshotFormat(record.format) ?? 'png';
        const scale = readScreenshotScale(record.scale) ?? 1;
        const transparent = record.transparent === true;
        const caption = readNonEmptyString(record.caption) ?? 'Active DAGMC viewport';
        let capture: CapturedView;
        try {
            capture = await viewer.captureScreenshot({ format, scale, transparent });
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
        return {
            ok: true,
            message: 'Captured the active DAGMC viewport.',
            preview: {
                kind: 'image',
                data: capture.dataUrl,
                mimeType: capture.mimeType,
                caption,
                truthful: true,
                limitations: ['Captures the visible viewport at the current camera and visibility state.']
            }
        };
    }
}

/** Ambient context contribution: the statepoint currently driving the visualizer. */
export class VisualizerContextContribution implements NukeCapabilityContextContribution {
    constructor(protected readonly openmcService: OpenMCService) {}

    getContext(): Partial<NukeCapabilityContext> {
        return { activeDataset: this.openmcService.getCurrentStatepoint()?.file };
    }

    get onDidChangeContext(): Event<void> {
        return (listener, thisArgs, disposables) => this.openmcService.onStatepointLoaded(() => listener(undefined), thisArgs, disposables);
    }
}

function summarizeStatepoint(info: OpenMCStatepointInfo, tallies: readonly OpenMCTallyInfo[]): StatepointSummary {
    return {
        file: info.file,
        batches: info.batches,
        generationsPerBatch: info.generationsPerBatch,
        kEff: info.kEff,
        kEffStd: info.kEffStd,
        nTallies: info.nTallies,
        tallyIds: [...info.tallyIds],
        tallies: tallies.map((tally) => ({
            id: tally.id,
            name: tally.name,
            scores: [...tally.scores],
            nuclides: [...tally.nuclides],
            hasMesh: tally.hasMesh
        }))
    };
}

/**
 * Triage the metadata of the statepoint already loaded in `OpenMCService`.
 *
 * Only summary values and tally definitions are inspected; raw tally values
 * and their uncertainties are not read. The file is never loaded or replaced.
 */
function diagnoseStatepoint(info: OpenMCStatepointInfo, tallies: readonly OpenMCTallyInfo[]): StatepointDiagnosis {
    const findings: NukeDiagnosticIssue[] = [];
    const kEff = isFiniteNumber(info.kEff) ? info.kEff : undefined;
    const kEffStd = isFiniteNumber(info.kEffStd) ? info.kEffStd : undefined;
    let relativeKeffUncertainty: number | undefined;

    if (kEff === undefined || kEffStd === undefined) {
        findings.push({
            severity: 'warning',
            code: 'missing-keff',
            category: 'convergence',
            message: 'The loaded statepoint does not report both k-effective and its standard deviation.',
            suggestion: 'Fixed-source statepoints may legitimately omit k-effective; confirm eigenvalue mode if it is expected.'
        });
    } else if (kEff !== 0) {
        relativeKeffUncertainty = kEffStd / Math.abs(kEff);
        if (relativeKeffUncertainty > HIGH_KEFF_RELATIVE_UNCERTAINTY) {
            findings.push({
                severity: 'warning',
                code: 'high-keff-uncertainty',
                category: 'convergence',
                message: `Relative k-effective uncertainty is ${formatRelativeUncertainty(relativeKeffUncertainty)}, above the 0.5% warning threshold.`,
                suggestion: 'Run more active batches or generations per batch before relying on the eigenvalue estimate.'
            });
        } else if (relativeKeffUncertainty > NOTABLE_KEFF_RELATIVE_UNCERTAINTY) {
            findings.push({
                severity: 'info',
                code: 'high-keff-uncertainty',
                category: 'convergence',
                message: `Relative k-effective uncertainty is ${formatRelativeUncertainty(relativeKeffUncertainty)}, above 0.1% but below the 0.5% warning threshold.`,
                suggestion: 'Acceptable for scoping; tighten the statistics before reporting a final value.'
            });
        }
    }

    if (info.batches < MIN_BATCHES) {
        findings.push({
            severity: 'warning',
            code: 'few-batches',
            category: 'convergence',
            message: `Only ${info.batches} batches were run; ${MIN_BATCHES} or more are expected.`,
            suggestion: 'Increase the number of batches so the eigenvalue estimate averages enough active cycles.'
        });
    }
    if (info.generationsPerBatch < MIN_GENERATIONS_PER_BATCH) {
        findings.push({
            severity: 'info',
            code: 'few-generations',
            category: 'convergence',
            message: `Each batch has only ${info.generationsPerBatch} generations; ${MIN_GENERATIONS_PER_BATCH} or more are expected.`,
            suggestion: 'Increase generations per batch to reduce correlation between generations.'
        });
    }

    if (info.nTallies === 0) {
        findings.push({
            severity: 'warning',
            code: 'no-tallies',
            category: 'tallies',
            message: 'The loaded statepoint contains no tallies.',
            suggestion: 'Add a tally to the model before running if this simulation should produce results.'
        });
    } else if (info.nTallies > MANY_TALLIES_THRESHOLD) {
        findings.push({
            severity: 'info',
            code: 'many-tallies',
            category: 'tallies',
            message: `The statepoint contains ${info.nTallies} tallies; only tally metadata is triaged here.`,
            suggestion: 'Review the tallies relevant to the question in the statepoint viewer.'
        });
    }

    for (const tally of tallies) {
        if (tally.scores.length === 0) {
            findings.push({
                severity: 'warning',
                code: 'tally-no-scores',
                category: 'tallies',
                message: `Tally ${tally.id} (${tally.name}) has no scores.`,
                suggestion: 'Add at least one score to the tally definition and rerun the model.'
            });
        }
        if (tally.hasMesh) {
            findings.push({
                severity: 'info',
                code: 'mesh-tally',
                category: 'tallies',
                message: `Tally ${tally.id} (${tally.name}) is a mesh tally; its spatial distribution needs the statepoint viewer.`,
                suggestion: 'Open the tally in the statepoint viewer for spatial interpretation.'
            });
        }
    }

    const issues = capDiagnosticIssues(findings);
    return {
        file: info.file,
        batches: info.batches,
        generationsPerBatch: info.generationsPerBatch,
        kEff,
        kEffStd,
        relativeKeffUncertainty,
        nTallies: info.nTallies,
        tallies: tallies.map((tally) => ({
            id: tally.id,
            name: tally.name,
            scores: [...tally.scores],
            nuclides: [...tally.nuclides],
            hasMesh: tally.hasMesh
        })),
        issues,
        warnings: issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message)
    };
}

function isFiniteNumber(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function validateStatepointPath(filePath: string, context: NukeCapabilityContext): string | undefined {
    if (!path.isAbsolute(filePath)) {
        return 'Statepoint path must be absolute.';
    }
    if (!isWithinWorkspace(filePath, context.workspaceRoots)) {
        return 'Statepoint path must be inside the workspace.';
    }
    return undefined;
}

function asRecord(input: unknown): Record<string, unknown> {
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function readNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readScreenshotFormat(value: unknown): ScreenshotFormat | undefined {
    return value === 'png' || value === 'jpeg' || value === 'webp' ? value : undefined;
}

function readScreenshotScale(value: unknown): ScreenshotScale | undefined {
    return value === 1 || value === 2 || value === 4 ? value : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
