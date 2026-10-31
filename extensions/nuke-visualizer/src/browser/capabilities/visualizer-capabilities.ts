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
 * capability registry: statepoint summaries, statepoint opening, and truthful
 * DAGMC viewport captures. The capability surface stays independent of the AI
 * bridge, so any capability consumer can invoke it.
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

const SUMMARIZE_STATEPOINT = 'nuke.viz.summarizeStatepoint';
const OPEN_STATEPOINT = 'nuke.viz.openStatepoint';
const CAPTURE_VIEW = 'nuke.viz.captureView';

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
