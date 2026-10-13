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

import * as React from 'react';
import * as THREE from 'three';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message, Widget } from '@theia/core/lib/browser';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { COLORMAP_NAMES, ColormapName, getColormap, isColormapName } from '../../../../viewer-core/colormaps';
import { getPointSpriteTexture } from '../../../../viewer-core/point-sprite';
import {
    formatRangeValue,
    logScaleAvailable,
    MAGNITUDE_COMPONENT,
    mapScalar,
    mappingToCssGradient,
    ScalarMapping
} from '../../../../viewer-core/scalar-mapping';
import {
    createDefaultToolbarState,
    parseColorBy,
    SOLID_COLOR,
    updateToolbarState,
    ViewerToolbarState
} from '../../../../viewer-core/viewer-toolbar-model';
import { createOrbitControls, type BoundsCorner, type OrbitControlsHandle } from '../../../../viewer-core/orbit-controls';
import {
    ViewerSettingsHost,
    ViewerSettingsPatch,
    ViewerSettingsSnapshot,
    viewerSnapDirection
} from '../../../../viewer-settings/viewer-settings-model';
import {
    arrayRange,
    clampStepIndex,
    colorByOptions,
    ExodusSeriesModelError,
    ExodusSeriesPayload,
    formatStepLabel,
    hasColorByArray,
    nextStepIndex,
    parseExodusSeries,
    previousStepIndex,
    stepAt,
    stepPositions,
    stepValueRange,
    stepValueSamples
} from './exodus-series-model';
import {
    ANIMATION_EXPORT_BITS_PER_SECOND,
    ANIMATION_EXPORT_FRAME_RATE,
    ANIMATION_EXPORT_STEP_MS,
    AnimationExportController,
    buildAnimationFilename,
    canvasStreamAbsentMessage,
    formatExportProgressLabel,
    requireAnimationExportSupport,
    selectAnimationMimeType
} from './animation-export';
import { readVtkText } from '../native-vtk/native-vtk-data';
import { detectMissingDependencies } from '../dependency-hints';
import '../output-viewer.css';

/**
 * Native Exodus time-slider widget (P5, wired).
 *
 * Renders a `base.exodus-series` payload — the headless replacement for the
 * trame `reader.TimestepValues` -> `view.ViewTime` slider in
 * `python/plugins/base/commands/serve.py` — as a client-side time index:
 * first/prev/slider/next/last stepping plus an instant per-step array
 * switch (no server restart; the P1 color-by win applied to time). Coloring
 * state lives in the viewer-core toolbar model and the legend gradient
 * samples the shared viewer-core colormap library. The current step's
 * decimated mesh (`stepPositions`) renders as a three.js point cloud colored
 * per-vertex through the shared scalar-mapping pipeline;
 * `OpenMCExodusViewerContribution` claims `*.e`/`*.exo*` files into this
 * widget via `VisualizerBackendService.getExodusSeries`.
 */
@injectable()
export class ExodusTimeSliderWidget extends ReactWidget implements ViewerSettingsHost {
    static readonly ID: string = 'exodus-time-slider-widget';
    static readonly LABEL: string = 'Exodus Time Slider';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected fileUri: URI | undefined;
    protected series: ExodusSeriesPayload | undefined;
    protected stepIndex = 0;
    protected toolbar: ViewerToolbarState = { ...createDefaultToolbarState(), showScalarBar: true };
    protected invert = false;
    protected logScale = false;
    protected isLoading = false;
    protected error: string | undefined;
    protected exportPhase: 'idle' | 'confirming' | 'recording' = 'idle';
    protected exportController: AnimationExportController | undefined;
    protected exportError: string | undefined;
    protected exportNotice: string | undefined;
    private exportToken = 0;
    private activeRecorder: MediaRecorder | undefined;
    private loadToken = 0;

    private host: HTMLElement | undefined;
    private renderer: THREE.WebGLRenderer | undefined;
    private scene: THREE.Scene | undefined;
    private camera: THREE.PerspectiveCamera | undefined;
    private points: THREE.Points | undefined;
    private orbitControls: OrbitControlsHandle | undefined;
    private resizeObserver: ResizeObserver | undefined;
    private renderedStep = -1;

    @postConstruct()
    protected init(): void {
        this.id = ExodusTimeSliderWidget.ID;
        this.title.label = ExodusTimeSliderWidget.LABEL;
        this.title.iconClass = codicon('history');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    /** Load a `base.exodus-series` JSON file through Theia's FileService. */
    async setSeriesFile(uri: URI): Promise<void> {
        this.fileUri = uri;
        this.id = `${ExodusTimeSliderWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${ExodusTimeSliderWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${ExodusTimeSliderWidget.LABEL}: ${uri.path.toString()}`;
        const token = ++this.loadToken;
        this.isLoading = true;
        this.error = undefined;
        this.update();
        try {
            const text = await readVtkText(this.fileService, uri);
            if (token !== this.loadToken) {
                return;
            }
            this.setSeriesText(text);
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to load Exodus series: ${this.error}`);
            this.update();
        }
    }

    /** Load an already-read series JSON payload (used after FileService reads). */
    setSeriesText(text: string, sourceUri?: URI): void {
        if (sourceUri) {
            this.fileUri = sourceUri;
            this.id = `${ExodusTimeSliderWidget.ID}:${sourceUri.path.toString()}`;
            this.title.label = `${ExodusTimeSliderWidget.LABEL}: ${sourceUri.path.base}`;
            this.title.caption = `${ExodusTimeSliderWidget.LABEL}: ${sourceUri.path.toString()}`;
        }
        this.isLoading = true;
        this.error = undefined;
        this.update();
        try {
            const series = parseExodusSeries(JSON.parse(text));
            this.series = series;
            this.stepIndex = clampStepIndex(0, series.nSteps);
            const options = colorByOptions(series);
            const colorBy = hasColorByArray(series, this.toolbar.colorBy) ? this.toolbar.colorBy : (options[1] ?? SOLID_COLOR);
            this.toolbar = updateToolbarState(this.toolbar, { colorBy });
            this.isLoading = false;
            this.renderedStep = -1;
            this.refreshScene();
        } catch (error) {
            this.isLoading = false;
            const message =
                error instanceof ExodusSeriesModelError ? error.message : error instanceof Error ? error.message : String(error);
            this.error = message;
            this.messageService.error(`Failed to parse Exodus series: ${message}`);
        }
        this.update();
    }

    /** Move to a step index (clamped); instant, no reload. */
    setStepIndex(index: number): void {
        if (!this.series) {
            return;
        }
        this.stepIndex = clampStepIndex(index, this.series.nSteps);
        this.refreshScene();
        this.update();
    }

    /** Switch the color-by array for the current step; instant, no reload. */
    setColorBy(colorBy: string): void {
        if (this.series && !hasColorByArray(this.series, colorBy)) {
            return;
        }
        this.toolbar = updateToolbarState(this.toolbar, { colorBy });
        this.refreshScene();
        this.update();
    }

    /** Switch the LUT used by the legend; instant, no reload. */
    setColormap(colormap: string): void {
        if (!isColormapName(colormap)) {
            return;
        }
        const name: ColormapName = colormap;
        this.toolbar = updateToolbarState(this.toolbar, { colormap: name });
        this.refreshScene();
        this.update();
    }

    /** Toggle the scalar bar (legend row in the step summary). */
    setScalarBarVisible(visible: boolean): void {
        this.toolbar = updateToolbarState(this.toolbar, { showScalarBar: visible });
        this.update();
    }

    /** Sample the colormap in reverse; instant, no reload. */
    setInvert(invert: boolean): void {
        this.invert = invert;
        this.refreshScene();
        this.update();
    }

    /** Log-scale the scalar mapping; instant, no reload. */
    setLogScale(logScale: boolean): void {
        this.logScale = logScale;
        this.refreshScene();
        this.update();
    }

    /** Canvas background color; applies instantly. */
    setBackground(background: string): void {
        this.toolbar = updateToolbarState(this.toolbar, { background });
        this.applyBackground();
        this.update();
    }

    private applyBackground(): void {
        if (this.scene) {
            this.scene.background = new THREE.Color(this.toolbar.background);
        }
        this.renderScene();
    }

    // ------------------------------------------------------------------
    // Viewer Settings sidebar API (single-direction sync: the panel reads
    // the snapshot and applies edits through these setters — the same calls
    // the header makes, never duplicated state). Exodus has no
    // shading/clip/measure sections, so the snapshot carries color-by,
    // colormap, scalar bar, background, the time step, and the snap handle.
    // ------------------------------------------------------------------

    /** Snap the camera to an orbit-handle direction (sidebar snap group). */
    snapViewerTo(direction: BoundsCorner): void {
        this.orbitControls?.setViewDirection(direction);
    }

    /** Read the current settings for the sidebar panel. */
    getViewerSettingsSnapshot(): ViewerSettingsSnapshot {
        const solid = this.toolbar.colorBy === SOLID_COLOR;
        const colorBy = parseColorBy(this.toolbar.colorBy);
        const arrayName = colorBy.kind === 'solid' ? undefined : colorBy.arrayName;
        const dataRange =
            this.series && arrayName
                ? (arrayRange(this.series, arrayName) ?? stepValueRange(this.series, this.stepIndex, arrayName))
                : undefined;
        return {
            widgetId: this.id,
            title: this.title.label,
            hasDataset: this.series !== undefined && this.series.nSteps > 0,
            colorBy: {
                value: this.toolbar.colorBy,
                options: this.series ? colorByOptions(this.series).map((option) => ({ value: option, label: option })) : []
            },
            colormap: {
                value: this.toolbar.colormap,
                options: [...COLORMAP_NAMES],
                disabled: solid,
                invert: this.invert,
                logScale: { value: this.logScale, disabled: !logScaleAvailable(dataRange ?? [0, 0]) }
            },
            scalarBar: { visible: this.toolbar.showScalarBar },
            background: { value: this.toolbar.background },
            step:
                this.series !== undefined && this.series.nSteps > 0
                    ? { index: this.stepIndex, count: this.series.nSteps, label: formatStepLabel(this.series, this.stepIndex) }
                    : undefined
        };
    }

    /** Apply a sidebar edit through the existing setters. */
    applyViewerSettings(patch: ViewerSettingsPatch): void {
        if (patch.snap !== undefined) {
            this.snapViewerTo(viewerSnapDirection(patch.snap));
        }
        if (patch.colorBy !== undefined) {
            this.setColorBy(patch.colorBy);
        }
        if (patch.colormap !== undefined) {
            this.setColormap(patch.colormap);
        }
        if (patch.stepIndex !== undefined) {
            this.setStepIndex(patch.stepIndex);
        }
        if (patch.scalarBarVisible !== undefined) {
            this.setScalarBarVisible(patch.scalarBarVisible);
        }
        if (patch.invert !== undefined) {
            this.setInvert(patch.invert);
        }
        if (patch.logScale !== undefined) {
            this.setLogScale(patch.logScale);
        }
        if (patch.background !== undefined) {
            this.setBackground(patch.background);
        }
    }

    // ------------------------------------------------------------------
    // Time-series animation export: MediaRecorder on the viewer canvas
    // stream (VP9/WebM, browser-built-in), stepping through the loaded
    // steps at the slider's decimated resolution with the current
    // color-by state (WYSIWYG). Capability failures surface as clear
    // errors — never a silent no-op.
    // ------------------------------------------------------------------

    /** Open the inline export dialog (confirm row in the header pattern). */
    openExportDialog(): void {
        if (!this.series || this.series.nSteps === 0 || this.exportPhase !== 'idle') {
            return;
        }
        this.exportError = undefined;
        this.exportNotice = undefined;
        this.exportPhase = 'confirming';
        this.update();
    }

    /** Close the export dialog without recording. */
    closeExportDialog(): void {
        if (this.exportPhase === 'confirming') {
            this.exportPhase = 'idle';
            this.update();
        }
    }

    /**
     * Cancel an in-flight export: the stepping loop stops at the next
     * slice, the recorder stops, and no file is saved. Settles the UI
     * immediately; the loop exits quietly via its token check.
     */
    cancelAnimationExport(): void {
        if (this.exportPhase === 'confirming') {
            this.closeExportDialog();
            return;
        }
        if (this.exportPhase !== 'recording') {
            return;
        }
        this.exportToken++;
        this.exportController?.cancel();
        this.stopActiveRecorder();
        this.exportPhase = 'idle';
        this.exportNotice = 'Animation export cancelled — no file was saved.';
        this.messageService.info('Animation export cancelled.');
        this.update();
    }

    /**
     * Record every loaded step to a downloaded WebM file. Restores the
     * pre-export step index when done, cancelled, or failed.
     */
    async startAnimationExport(): Promise<void> {
        const series = this.series;
        if (!series || series.nSteps === 0) {
            this.messageService.warn('Animation export needs a loaded series with at least one step.');
            return;
        }
        try {
            requireAnimationExportSupport();
        } catch (error) {
            this.failExportStart(error);
            return;
        }
        const canvas = this.renderer?.domElement;
        if (!canvas || typeof canvas.captureStream !== 'function') {
            this.failExportStart(new Error(canvasStreamAbsentMessage('no capturable canvas stream')));
            return;
        }
        if (typeof document === 'undefined') {
            this.failExportStart(new Error(canvasStreamAbsentMessage('no download surface')));
            return;
        }
        const controller = new AnimationExportController(series.nSteps);
        if (controller.plannedSteps.length === 0) {
            this.messageService.warn('Animation export needs a loaded series with at least one step.');
            return;
        }
        const token = ++this.exportToken;
        this.exportController = controller;
        this.exportError = undefined;
        this.exportNotice = undefined;
        this.exportPhase = 'recording';
        controller.start();
        this.update();

        const savedStep = this.stepIndex;
        const chunks: Blob[] = [];
        let recorder: MediaRecorder;
        try {
            const stream = canvas.captureStream(ANIMATION_EXPORT_FRAME_RATE);
            const recorderCtor = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
            if (!recorderCtor) {
                throw new Error(canvasStreamAbsentMessage('recorder vanished'));
            }
            const isTypeSupported =
                typeof recorderCtor.isTypeSupported === 'function'
                    ? (mimeType: string) => recorderCtor.isTypeSupported(mimeType)
                    : undefined;
            const mimeType = selectAnimationMimeType(isTypeSupported);
            recorder = mimeType
                ? new recorderCtor(stream, { mimeType, videoBitsPerSecond: ANIMATION_EXPORT_BITS_PER_SECOND })
                : new recorderCtor(stream, { videoBitsPerSecond: ANIMATION_EXPORT_BITS_PER_SECOND });
        } catch (error) {
            this.settleExport(controller, token, savedStep, 'error', error instanceof Error ? error.message : String(error));
            return;
        }
        this.activeRecorder = recorder;
        let recorderFailed = false;
        const stopped = new Promise<void>((resolve) => {
            recorder.onstop = () => resolve();
            recorder.onerror = () => {
                recorderFailed = true;
                resolve();
            };
        });
        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data && event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        try {
            recorder.start();
        } catch (error) {
            this.settleExport(controller, token, savedStep, 'error', error instanceof Error ? error.message : String(error));
            return;
        }
        for (const step of controller.plannedSteps) {
            if (token !== this.exportToken || !controller.isActive || recorderFailed) {
                break;
            }
            this.setStepIndex(step);
            const dwelled = await this.sleepExport(ANIMATION_EXPORT_STEP_MS, token);
            if (!dwelled || token !== this.exportToken || !controller.isActive || recorderFailed) {
                break;
            }
            controller.completeStep(step);
            this.update();
        }
        if (token !== this.exportToken) {
            // A cancel settled the UI already; exit quietly.
            return;
        }
        if (this.activeRecorder === recorder && recorder.state !== 'inactive') {
            try {
                recorder.stop();
            } catch {
                // The stop promise still settles via onerror; fall through.
            }
        }
        await stopped;
        if (token !== this.exportToken) {
            return;
        }
        if (controller.snapshot().status === 'cancelled') {
            this.settleExport(controller, token, savedStep, 'cancelled');
            return;
        }
        if (recorderFailed) {
            this.settleExport(controller, token, savedStep, 'error', 'The recorder failed while capturing the canvas.');
            return;
        }
        if (chunks.length === 0) {
            this.settleExport(controller, token, savedStep, 'error', 'The recorder produced no video data.');
            return;
        }
        controller.finish();
        const type = recorder.mimeType || 'video/webm';
        const blob = new Blob(chunks, { type });
        const filename = buildAnimationFilename(this.exportFilenamePrefix());
        this.downloadExport(blob, filename);
        this.settleExport(controller, token, savedStep, 'done', filename);
    }

    /** Settle the widget after an export attempt (done/cancelled/error). */
    private settleExport(
        controller: AnimationExportController,
        token: number,
        savedStep: number,
        outcome: 'done' | 'cancelled' | 'error',
        detail?: string
    ): void {
        this.activeRecorder = undefined;
        if (token !== this.exportToken || this.isDisposed) {
            // Superseded by a cancel (which settled the UI) or disposed.
            return;
        }
        if (this.series) {
            this.setStepIndex(savedStep);
        }
        this.exportPhase = 'idle';
        if (outcome === 'done') {
            this.exportNotice = `Animation saved as ${detail}.`;
            this.messageService.info(`Animation export saved as ${detail}.`);
        } else if (outcome === 'cancelled') {
            controller.cancel();
            this.exportNotice = 'Animation export cancelled — no file was saved.';
            this.messageService.info('Animation export cancelled.');
        } else {
            const message = detail ?? 'Unknown export error.';
            controller.fail(message);
            this.exportError = message;
            this.messageService.error(`Animation export failed: ${message}`);
        }
        this.update();
    }

    /** Surface an export entry failure as an inline + message error. */
    private failExportStart(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.exportPhase = 'idle';
        this.exportError = message;
        this.messageService.error(`Animation export failed: ${message}`);
        this.update();
    }

    /** Stop the active recorder without touching export state. */
    private stopActiveRecorder(): void {
        const recorder = this.activeRecorder;
        this.activeRecorder = undefined;
        if (recorder && recorder.state !== 'inactive') {
            try {
                recorder.stop();
            } catch {
                // The stepping loop still settles via the stop promise.
            }
        }
    }

    /** Sleep in slices so a cancel lands within ~50 ms. False when superseded. */
    private sleepExport(ms: number, token: number): Promise<boolean> {
        return new Promise((resolve) => {
            const end = Date.now() + ms;
            const tick = (): void => {
                if (token !== this.exportToken) {
                    resolve(false);
                    return;
                }
                if (Date.now() >= end) {
                    resolve(true);
                    return;
                }
                window.setTimeout(tick, 50);
            };
            window.setTimeout(tick, 50);
        });
    }

    /** Filename prefix from the series file name, sanitized for downloads. */
    private exportFilenamePrefix(): string {
        const raw = this.fileUri?.path.base.replace(/\.[^.]+$/, '') ?? '';
        const cleaned = raw
            .replace(/[^\w-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        return cleaned || 'exodus-animation';
    }

    /** Save a recorded blob through a download anchor. Requires a DOM. */
    private downloadExport(blob: Blob, filename: string): void {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    protected render(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-container">
                {this.renderHeader()}
                {this.renderExportPanel()}
                {this.error ? this.renderError() : this.renderContent()}
            </div>
        );
    }

    protected renderHeader(): React.ReactNode {
        const fileName = this.fileUri?.path.base ?? 'No series loaded';
        const exporting = this.exportPhase === 'recording';
        return (
            <div className="openmc-output-viewer-header">
                <span className="openmc-output-viewer-file">
                    <i className={codicon('file')}></i>
                    {fileName}
                </span>
                {this.renderColorBySelect()}
                {this.renderColormapSelect()}
                <Tooltip content="Export the time series as a WebM animation (browser MediaRecorder, no extra tools)" position="bottom">
                    <button
                        className="theia-button secondary"
                        aria-label="Export animation as WebM"
                        onClick={() => this.openExportDialog()}
                        disabled={
                            this.isLoading || exporting || this.exportPhase === 'confirming' || !this.series || this.series.nSteps === 0
                        }
                    >
                        <i className={codicon('record')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Reload series" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.fileUri && this.setSeriesFile(this.fileUri)}
                        disabled={this.isLoading || exporting || !this.fileUri}
                    >
                        <i className={codicon('refresh')}></i>
                    </button>
                </Tooltip>
            </div>
        );
    }

    /**
     * Export confirm/progress/error rows in the existing header pattern.
     * The confirm row is the export dialog: scope (step count, WYSIWYG
     * color-by state) plus the documented auto-range flicker limitation.
     */
    protected renderExportPanel(): React.ReactNode {
        if (this.exportPhase === 'confirming' && this.series) {
            const total = this.series.nSteps;
            return (
                <div className="openmc-output-viewer-header">
                    <span className="openmc-output-viewer-file">
                        Export {total} step{total === 1 ? '' : 's'} as WebM — records this canvas at the current color-by state, one step
                        every {ANIMATION_EXPORT_STEP_MS / 1000} s. Colors use the current global range; per-step re-ranging is off, so
                        brightness may flicker between steps.
                    </span>
                    <Tooltip content="Start recording the animation" position="bottom">
                        <button
                            className="theia-button secondary"
                            aria-label="Start animation export"
                            onClick={() => this.startAnimationExport()}
                        >
                            <i className={codicon('record')}></i>
                            Export
                        </button>
                    </Tooltip>
                    <Tooltip content="Close the export dialog" position="bottom">
                        <button
                            className="theia-button secondary"
                            aria-label="Close animation export dialog"
                            onClick={() => this.closeExportDialog()}
                        >
                            <i className={codicon('close')}></i>
                        </button>
                    </Tooltip>
                </div>
            );
        }
        if (this.exportPhase === 'recording' && this.exportController) {
            const snapshot = this.exportController.snapshot();
            const percent = Math.round(this.exportController.progressFraction() * 100);
            return (
                <div className="openmc-output-viewer-header">
                    <span className="openmc-output-viewer-file">
                        Exporting {formatExportProgressLabel(snapshot.completedStepCount, snapshot.totalStepCount)} · {percent}%
                    </span>
                    <div
                        role="progressbar"
                        aria-label="Animation export progress"
                        aria-valuemin={0}
                        aria-valuemax={snapshot.totalStepCount}
                        aria-valuenow={snapshot.completedStepCount}
                        style={{
                            flex: '1',
                            height: '6px',
                            background: 'var(--theia-editor-background)',
                            borderRadius: '3px',
                            overflow: 'hidden'
                        }}
                    >
                        <div style={{ width: `${percent}%`, height: '100%', background: 'var(--theia-progressBar-background)' }} />
                    </div>
                    <Tooltip content="Cancel the animation export (no file is saved)" position="bottom">
                        <button
                            className="theia-button secondary"
                            aria-label="Cancel animation export"
                            onClick={() => this.cancelAnimationExport()}
                        >
                            <i className={codicon('close')}></i>
                            Cancel
                        </button>
                    </Tooltip>
                </div>
            );
        }
        if (this.exportError) {
            return (
                <div className="openmc-output-viewer-header">
                    <span className="openmc-output-viewer-file" role="alert">
                        Animation export failed: {this.exportError}
                    </span>
                    <Tooltip content="Dismiss" position="bottom">
                        <button
                            className="theia-button secondary"
                            aria-label="Dismiss animation export error"
                            onClick={() => {
                                this.exportError = undefined;
                                this.update();
                            }}
                        >
                            <i className={codicon('close')}></i>
                        </button>
                    </Tooltip>
                </div>
            );
        }
        if (this.exportNotice) {
            return (
                <div className="openmc-output-viewer-header">
                    <span className="openmc-output-viewer-file">{this.exportNotice}</span>
                </div>
            );
        }
        return undefined;
    }

    protected renderColorBySelect(): React.ReactNode {
        if (!this.series) {
            return undefined;
        }
        return (
            <Tooltip content="Color-by array for the current step (applies instantly)" position="bottom">
                <div className="openmc-output-viewer-control">
                    Color by
                    <NukeSelect
                        ariaLabel="Color-by array"
                        value={this.toolbar.colorBy}
                        options={colorByOptions(this.series).map((option) => ({ value: option, label: option }))}
                        onChange={(value) => this.setColorBy(value)}
                        disabled={this.isLoading}
                    />
                </div>
            </Tooltip>
        );
    }

    protected renderColormapSelect(): React.ReactNode {
        if (!this.series) {
            return undefined;
        }
        return (
            <Tooltip content="Colormap for the legend (applies instantly)" position="bottom">
                <div className="openmc-output-viewer-control">
                    Map
                    <NukeSelect
                        ariaLabel="Colormap"
                        value={this.toolbar.colormap}
                        options={COLORMAP_NAMES.map((name) => ({ value: name, label: name }))}
                        onChange={(value) => this.setColormap(value)}
                        disabled={this.isLoading}
                    />
                </div>
            </Tooltip>
        );
    }

    protected renderContent(): React.ReactNode {
        if (this.isLoading && !this.series) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-spinner"></div>
                    <span>Loading series…</span>
                </div>
            );
        }
        if (!this.series || this.series.nSteps === 0) {
            return (
                <div className="openmc-output-viewer-status">
                    <span>{this.series ? 'Series has no steps' : 'No series loaded'}</span>
                </div>
            );
        }
        return (
            <>
                {this.renderSlider()}
                {this.renderSceneView()}
                {this.renderStepSummary()}
            </>
        );
    }

    protected renderSceneView(): React.ReactNode {
        if (!this.series || this.series.nSteps === 0) {
            return undefined;
        }
        return (
            <div className="openmc-output-viewer-viewarea">
                <div className="openmc-output-viewer-hint nuke-viewer-status-line">
                    {this.describeScene()} Drag to orbit, wheel to zoom, right-drag to pan.
                </div>
                <div ref={this.attachHost} style={{ flex: '1', minHeight: '240px', position: 'relative' }} />
            </div>
        );
    }

    private describeScene(): string {
        const series = this.series;
        const step = series ? stepAt(series, this.stepIndex) : undefined;
        if (!series || !step) {
            return this.isLoading ? 'Loading…' : 'No series loaded';
        }
        return `Points — ${step.mesh.nodes.length.toLocaleString()} nodes · ${formatStepLabel(series, this.stepIndex)}`;
    }

    protected renderSlider(): React.ReactNode {
        const series = this.series;
        if (!series) {
            return undefined;
        }
        const exporting = this.exportPhase === 'recording';
        const steppingDisabled = this.isLoading || exporting;
        return (
            <div className="openmc-output-viewer-header">
                <Tooltip content="First step" position="bottom">
                    <button className="theia-button secondary" onClick={() => this.setStepIndex(0)} disabled={steppingDisabled}>
                        <i className={codicon('chevron-left-all')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Previous step" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.setStepIndex(previousStepIndex(this.stepIndex, series.nSteps))}
                        disabled={steppingDisabled}
                    >
                        <i className={codicon('chevron-left')}></i>
                    </button>
                </Tooltip>
                <input
                    type="range"
                    min={0}
                    max={series.nSteps - 1}
                    step={1}
                    value={this.stepIndex}
                    onChange={(e) => this.setStepIndex(Number(e.target.value))}
                    disabled={steppingDisabled}
                    style={{ flex: '1' }}
                    aria-label="Time step"
                />
                <Tooltip content="Next step" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.setStepIndex(nextStepIndex(this.stepIndex, series.nSteps))}
                        disabled={steppingDisabled}
                    >
                        <i className={codicon('chevron-right')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Last step" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.setStepIndex(series.nSteps - 1)}
                        disabled={steppingDisabled}
                    >
                        <i className={codicon('chevron-right-all')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Time step (client-side index over the extracted series)" position="bottom">
                    <span className="openmc-output-viewer-file">{formatStepLabel(series, this.stepIndex)}</span>
                </Tooltip>
            </div>
        );
    }

    protected renderStepSummary(): React.ReactNode {
        const series = this.series;
        const step = series ? stepAt(series, this.stepIndex) : undefined;
        if (!series || !step) {
            return undefined;
        }
        const colorBy = parseColorBy(this.toolbar.colorBy);
        const arrayName = colorBy.kind === 'solid' ? undefined : colorBy.arrayName;
        const range = arrayName ? stepValueRange(series, this.stepIndex, arrayName) : undefined;
        const summary = arrayName ? step.values[arrayName] : undefined;
        const definition = getColormap(this.toolbar.colormap);
        const mapping: ScalarMapping | undefined =
            definition && range
                ? { definition, range, logScale: this.logScale, invert: this.invert, component: MAGNITUDE_COMPONENT }
                : undefined;
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 8px', fontSize: '11px' }}>
                <span>
                    Mesh — {step.mesh.nNodes.toLocaleString()} nodes ({step.mesh.nodes.length.toLocaleString()} stored),{' '}
                    {step.mesh.nElements.toLocaleString()} elements in {step.mesh.blocks.length} block(s)
                </span>
                {summary && range ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} title={`${arrayName} at this step`}>
                        {this.toolbar.showScalarBar && mapping ? (
                            <>
                                <span>{formatRangeValue(range[0])}</span>
                                <div style={{ flex: '1', height: '10px', background: mappingToCssGradient(mapping) }} />
                                <span>{formatRangeValue(range[1])}</span>
                            </>
                        ) : undefined}
                        <span style={{ opacity: 0.7 }}>
                            {arrayName} (mean {summary.mean.toPrecision(3)}, n={summary.count})
                        </span>
                    </div>
                ) : (
                    <span style={{ opacity: 0.7 }}>Solid color — pick an array to inspect per-step values</span>
                )}
            </div>
        );
    }

    protected renderError(): React.ReactNode {
        const missingDeps = this.error ? detectMissingDependencies(this.error) : undefined;
        if (missingDeps) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-dep-panel">
                        <div className="dep-title">
                            <i className={codicon('warning')}></i>
                            Missing Python dependencies
                        </div>
                        <p className="dep-summary">
                            This viewer needs <strong>{missingDeps.join(', ')}</strong>, which the configured Python environment does not
                            provide (series extraction reads Exodus-II files via <code>netCDF4</code>, with a single-step{' '}
                            <code>meshio</code> fallback).
                        </p>
                        <ul className="dep-actions">
                            <li>Install the missing packages into the configured environment.</li>
                            <li>
                                Or point NukeIDE at an environment that has them in <strong>Settings → Nuke Utils</strong> (Python
                                environment), then reload this viewer.
                            </li>
                        </ul>
                        <p className="dep-backend-error">
                            <span className="dep-backend-label">Backend error:</span> {this.error}
                        </p>
                        <button className="theia-button secondary" onClick={() => this.fileUri && this.setSeriesFile(this.fileUri)}>
                            <i className={codicon('refresh')}></i>
                            Retry
                        </button>
                    </div>
                </div>
            );
        }
        return (
            <div className="openmc-output-viewer-status error">
                <i className={codicon('error')}></i>
                <span>{this.error}</span>
                {this.fileUri && (
                    <button className="theia-button secondary" onClick={() => this.fileUri && this.setSeriesFile(this.fileUri)}>
                        <i className={codicon('refresh')}></i>
                        Retry
                    </button>
                )}
            </div>
        );
    }

    // ------------------------------------------------------------------
    // three.js scene: current step's decimated mesh as a point cloud,
    // colored per-vertex through the shared scalar-mapping pipeline.
    // ------------------------------------------------------------------

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.ensureRenderer();
    }

    protected onBeforeDetach(msg: Message): void {
        this.teardownRenderer();
        super.onBeforeDetach(msg);
    }

    override dispose(): void {
        this.loadToken++;
        this.exportToken++;
        this.exportController?.cancel();
        this.stopActiveRecorder();
        this.teardownRenderer();
        super.dispose();
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        super.onResize(msg);
        this.resizeRenderer();
    }

    private attachHost = (element: HTMLElement | null): void => {
        this.host = element ?? undefined;
        this.ensureRenderer();
    };

    private ensureRenderer(): void {
        if (this.renderer || !this.host || !this.isAttached) {
            return;
        }
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        this.host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.toolbar.background);
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e9);
        this.attachOrbitControls();
        this.resizeObserver = new ResizeObserver(() => this.resizeRenderer());
        if (this.host) {
            this.resizeObserver.observe(this.host);
        }
        this.resizeRenderer();
        this.renderedStep = -1;
        this.refreshScene();
    }

    private teardownRenderer(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        this.orbitControls?.dispose();
        this.orbitControls = undefined;
        this.clearPoints();
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer.domElement.remove();
            this.renderer = undefined;
        }
        this.scene = undefined;
        this.camera = undefined;
        this.renderedStep = -1;
    }

    private clearPoints(): void {
        if (this.points && this.scene) {
            this.scene.remove(this.points);
            this.points.geometry.dispose();
            (this.points.material as THREE.Material).dispose();
            this.points = undefined;
        }
    }

    private resizeRenderer(): void {
        if (!this.renderer || !this.camera || !this.host) {
            return;
        }
        const width = Math.max(1, this.host.clientWidth);
        const height = Math.max(1, this.host.clientHeight);
        this.renderer.setSize(width, height, false);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderScene();
    }

    private renderScene(): void {
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    /**
     * Rebuild the point cloud for the current step (positions from
     * `stepPositions`, colors from the scalar-mapping pipeline over the
     * color-by array's decimated samples). No-ops until the canvas is
     * attached; `ensureRenderer` replays it on attach.
     */
    private refreshScene(): void {
        const series = this.series;
        if (!series || !this.scene || !this.camera) {
            return;
        }
        this.clearPoints();
        const positions = stepPositions(series, this.stepIndex);
        if (positions.length === 0) {
            this.renderedStep = this.stepIndex;
            this.renderScene();
            return;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(this.vertexColors(series, positions.length / 3), 3));
        const material = new THREE.PointsMaterial({
            size: 3,
            vertexColors: true,
            transparent: true,
            sizeAttenuation: false,
            map: getPointSpriteTexture() ?? null
        });
        this.points = new THREE.Points(geometry, material);
        this.scene.add(this.points);
        if (this.renderedStep === -1) {
            this.fitView();
        }
        this.renderedStep = this.stepIndex;
        this.renderScene();
    }

    /**
     * Per-vertex colors for the current step: the color-by array's decimated
     * samples stride-mapped onto the stored nodes (exact when the extractor
     * kept every node), mapped through the shared scalar-mapping pipeline
     * with the global (across-steps) range so colors stay stable per step.
     */
    private vertexColors(series: ExodusSeriesPayload, count: number): Float32Array {
        const out = new Float32Array(count * 3);
        const solid: [number, number, number] = [0.83, 0.83, 0.83];
        const colorBy = parseColorBy(this.toolbar.colorBy);
        const arrayName = colorBy.kind === 'solid' ? undefined : colorBy.arrayName;
        const samples = arrayName ? stepValueSamples(series, this.stepIndex, arrayName) : [];
        const range = arrayName ? (arrayRange(series, arrayName) ?? stepValueRange(series, this.stepIndex, arrayName)) : undefined;
        const definition = getColormap(this.toolbar.colormap) ?? getColormap('Viridis');
        if (!arrayName || samples.length === 0 || !range || !definition) {
            for (let i = 0; i < count; i++) {
                out[i * 3] = solid[0];
                out[i * 3 + 1] = solid[1];
                out[i * 3 + 2] = solid[2];
            }
            return out;
        }
        const mapping: ScalarMapping = {
            definition,
            range,
            logScale: this.logScale,
            invert: this.invert,
            component: MAGNITUDE_COMPONENT
        };
        for (let i = 0; i < count; i++) {
            const sample = samples[Math.min(samples.length - 1, Math.floor((i * samples.length) / count))];
            const mapped = mapScalar(sample, mapping);
            if (mapped) {
                out[i * 3] = mapped[0];
                out[i * 3 + 1] = mapped[1];
                out[i * 3 + 2] = mapped[2];
            }
        }
        return out;
    }

    /** Frame the current step's points through the orbit controls (target + distance). */
    fitView(): void {
        if (!this.series || !this.camera || !this.orbitControls) {
            return;
        }
        const positions = stepPositions(this.series, this.stepIndex);
        if (positions.length === 0) {
            return;
        }
        const box = new THREE.Box3();
        for (let i = 0; i < positions.length; i += 3) {
            box.expandByPoint(new THREE.Vector3(positions[i], positions[i + 1], positions[i + 2]));
        }
        this.orbitControls.fitBounds([box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]);
    }

    /**
     * Attach OrbitControls to the renderer canvas. The controls class loads
     * asynchronously (same dynamic import style as nuke-cad); a renderer
     * teardown before the import resolves disposes the stale handle. Once
     * attached, the current step is framed through the controls.
     */
    private attachOrbitControls(): void {
        const renderer = this.renderer;
        const camera = this.camera;
        if (!renderer || !camera) {
            return;
        }
        createOrbitControls(camera, renderer.domElement, { onChange: () => this.renderScene() })
            .then((handle) => {
                if (this.renderer !== renderer) {
                    handle.dispose();
                    return;
                }
                this.orbitControls?.dispose();
                this.orbitControls = handle;
                this.fitView();
            })
            .catch((error) => {
                console.warn('[ExodusViewer] Failed to load orbit controls:', error);
            });
    }
}
