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
 * Pure time-series animation-export model for the native Exodus viewer.
 *
 * The Exodus time-slider widget records its own viewer canvas through the
 * browser-built-in `MediaRecorder` (VP9/WebM, no encoder dependency),
 * stepping through the loaded steps at the slider's decimated resolution.
 * This module owns everything around that flow that does not need the DOM:
 * capability probing, MIME-type selection, export-step enumeration,
 * the export-state machine (step progress, cancel), and the download
 * filename builder.
 *
 * Pure functions + types only; no Theia, no DOM, no three.js. The widget
 * owns the `MediaRecorder` lifecycle and the per-step canvas painting; it
 * drives an `AnimationExportController` here so progress and cancel stay
 * testable without a browser.
 */

/** MIME-type candidates in preference order (VP9 first, plain WebM last). */
export const ANIMATION_EXPORT_MIME_CANDIDATES: readonly string[] = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** How long each step stays on screen while recording (ms). */
export const ANIMATION_EXPORT_STEP_MS = 500;

/** Recording bitrate passed to `MediaRecorder` (bits per second). */
export const ANIMATION_EXPORT_BITS_PER_SECOND = 8000000;

/** Capture frame rate requested from the canvas stream (frames per second). */
export const ANIMATION_EXPORT_FRAME_RATE = 30;

/**
 * Error shown when the `MediaRecorder` API is unavailable (headless
 * shells). Thrown, messaged, and rendered — never a silent no-op.
 */
export const MEDIA_RECORDER_ABSENT_MESSAGE =
    'Animation export needs the MediaRecorder API, which this shell does not provide. ' +
    'Headless shells cannot record video — open the series in a full browser build to export it.';

/** Error shown when the viewer canvas has no capturable stream. */
export function canvasStreamAbsentMessage(reason: string): string {
    return `Animation export cannot capture the viewer canvas (${reason}). Reload the series and try again.`;
}

/**
 * True when animation export can run: a `MediaRecorder` implementation is
 * present. The constructor is injectable so tests and headless shells can
 * probe without touching the global.
 */
export function isAnimationExportSupported(mediaRecorder?: unknown): boolean {
    const candidate =
        mediaRecorder !== undefined
            ? mediaRecorder
            : typeof globalThis !== 'undefined'
              ? (globalThis as Record<string, unknown>)['MediaRecorder']
              : undefined;
    return typeof candidate === 'function';
}

/**
 * Throw `MEDIA_RECORDER_ABSENT_MESSAGE` when export cannot run. Widget
 * entry points call this first so an unavailable recorder always surfaces
 * as a clear error instead of silently doing nothing.
 */
export function requireAnimationExportSupport(mediaRecorder?: unknown): void {
    if (!isAnimationExportSupported(mediaRecorder)) {
        throw new Error(MEDIA_RECORDER_ABSENT_MESSAGE);
    }
}

/**
 * Pick the first MIME type the recorder supports, probing in
 * `ANIMATION_EXPORT_MIME_CANDIDATES` order. Returns `undefined` when no
 * probe is available or nothing matches — the widget then constructs the
 * recorder without a `mimeType` and takes the browser default.
 */
export function selectAnimationMimeType(isTypeSupported?: (mimeType: string) => boolean): string | undefined {
    if (!isTypeSupported) {
        return undefined;
    }
    for (const candidate of ANIMATION_EXPORT_MIME_CANDIDATES) {
        try {
            if (isTypeSupported(candidate)) {
                return candidate;
            }
        } catch {
            continue;
        }
    }
    return undefined;
}

/**
 * Enumerate the step indices an export walks: every loaded step in order,
 * at the slider's decimated resolution. Empty for an empty series.
 */
export function planAnimationExportSteps(nSteps: number): number[] {
    if (!Number.isFinite(nSteps) || nSteps <= 0) {
        return [];
    }
    const count = Math.floor(nSteps);
    const steps: number[] = [];
    for (let index = 0; index < count; index++) {
        steps.push(index);
    }
    return steps;
}

/** Lifecycle status of one animation export. */
export type AnimationExportStatus = 'idle' | 'recording' | 'done' | 'cancelled' | 'error';

/** Immutable progress snapshot of one animation export. */
export interface AnimationExportSnapshot {
    readonly status: AnimationExportStatus;
    readonly completedStepCount: number;
    readonly totalStepCount: number;
    readonly currentStep: number | undefined;
    readonly error: string | undefined;
}

/**
 * Small state machine tracking one animation export: step enumeration,
 * per-step progress, cancel, and terminal states. The widget advances it
 * as it paints each step; cancel sticks (late step completions are
 * ignored) and terminal states are final.
 */
export class AnimationExportController {
    private status: AnimationExportStatus = 'idle';
    private completedStepCount = 0;
    private currentStep: number | undefined;
    private error: string | undefined;
    private readonly steps: readonly number[];

    constructor(nSteps: number) {
        this.steps = planAnimationExportSteps(nSteps);
    }

    /** Step indices this export walks, in order. */
    get plannedSteps(): readonly number[] {
        return this.steps;
    }

    /** True while the recorder should keep stepping. */
    get isActive(): boolean {
        return this.status === 'recording';
    }

    /** Begin stepping. No-ops unless idle. */
    start(): void {
        if (this.status !== 'idle') {
            return;
        }
        this.status = 'recording';
        this.currentStep = this.steps[0];
    }

    /** Record one painted step as captured. Ignored unless recording. */
    completeStep(step: number): void {
        if (this.status !== 'recording') {
            return;
        }
        this.completedStepCount += 1;
        const at = this.steps.indexOf(step);
        this.currentStep = at >= 0 && at + 1 < this.steps.length ? this.steps[at + 1] : undefined;
    }

    /** Cancel the export. Sticks: later completions are ignored. */
    cancel(): void {
        if (this.status !== 'recording' && this.status !== 'idle') {
            return;
        }
        this.status = 'cancelled';
        this.currentStep = undefined;
    }

    /** Mark the export recorded. Ignored unless recording. */
    finish(): void {
        if (this.status !== 'recording') {
            return;
        }
        this.status = 'done';
        this.currentStep = undefined;
    }

    /** Mark the export failed with a message. Recording or idle only. */
    fail(message: string): void {
        if (this.status !== 'recording' && this.status !== 'idle') {
            return;
        }
        this.status = 'error';
        this.error = message;
        this.currentStep = undefined;
    }

    /** Fraction of planned steps captured, in `[0, 1]`. */
    progressFraction(): number {
        if (this.steps.length === 0) {
            return 0;
        }
        return Math.min(1, this.completedStepCount / this.steps.length);
    }

    /** Current immutable snapshot for rendering. */
    snapshot(): AnimationExportSnapshot {
        return {
            status: this.status,
            completedStepCount: this.completedStepCount,
            totalStepCount: this.steps.length,
            currentStep: this.currentStep,
            error: this.error
        };
    }
}

/**
 * Slider-style label for export progress
 * (`Step 2 of 5`, or `No steps` for an empty series).
 */
export function formatExportProgressLabel(completedStepCount: number, totalStepCount: number): string {
    if (!(totalStepCount > 0)) {
        return 'No steps';
    }
    return `Step ${Math.min(totalStepCount, completedStepCount + 1)} of ${totalStepCount}`;
}

function pad2(value: number): string {
    return value.toString().padStart(2, '0');
}

/**
 * Build a timestamped animation filename (`<prefix>-YYYYMMDD-HHmmss.webm`).
 * Pure for testability; pass `now` explicitly in tests.
 */
export function buildAnimationFilename(prefix = 'exodus-animation', now: Date = new Date()): string {
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(
        now.getMinutes()
    )}${pad2(now.getSeconds())}`;
    return `${prefix}-${stamp}.webm`;
}
