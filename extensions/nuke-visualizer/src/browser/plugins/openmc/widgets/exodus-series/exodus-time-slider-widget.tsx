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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { COLORMAP_NAMES, ColormapName, getColormap, isColormapName } from '../../../../viewer-core/colormaps';
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

    protected render(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-container">
                {this.renderHeader()}
                {this.error ? this.renderError() : this.renderContent()}
            </div>
        );
    }

    protected renderHeader(): React.ReactNode {
        const fileName = this.fileUri?.path.base ?? 'No series loaded';
        return (
            <div className="openmc-output-viewer-header">
                <span className="openmc-output-viewer-file">
                    <i className={codicon('file')}></i>
                    {fileName}
                </span>
                {this.renderColorBySelect()}
                {this.renderColormapSelect()}
                <Tooltip content="Reload series" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.fileUri && this.setSeriesFile(this.fileUri)}
                        disabled={this.isLoading || !this.fileUri}
                    >
                        <i className={codicon('refresh')}></i>
                    </button>
                </Tooltip>
            </div>
        );
    }

    protected renderColorBySelect(): React.ReactNode {
        if (!this.series) {
            return undefined;
        }
        return (
            <Tooltip content="Color-by array for the current step (applies instantly)" position="bottom">
                <label className="openmc-output-viewer-control">
                    Color by
                    <select value={this.toolbar.colorBy} onChange={(e) => this.setColorBy(e.target.value)} disabled={this.isLoading}>
                        {colorByOptions(this.series).map((option) => (
                            <option key={option} value={option}>
                                {option}
                            </option>
                        ))}
                    </select>
                </label>
            </Tooltip>
        );
    }

    protected renderColormapSelect(): React.ReactNode {
        if (!this.series) {
            return undefined;
        }
        return (
            <Tooltip content="Colormap for the legend (applies instantly)" position="bottom">
                <label className="openmc-output-viewer-control">
                    Map
                    <select value={this.toolbar.colormap} onChange={(e) => this.setColormap(e.target.value)} disabled={this.isLoading}>
                        {COLORMAP_NAMES.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
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
        return (
            <div className="openmc-output-viewer-header">
                <Tooltip content="First step" position="bottom">
                    <button className="theia-button secondary" onClick={() => this.setStepIndex(0)} disabled={this.isLoading}>
                        <i className={codicon('chevron-left-all')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Previous step" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.setStepIndex(previousStepIndex(this.stepIndex, series.nSteps))}
                        disabled={this.isLoading}
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
                    disabled={this.isLoading}
                    style={{ flex: '1' }}
                    aria-label="Time step"
                />
                <Tooltip content="Next step" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.setStepIndex(nextStepIndex(this.stepIndex, series.nSteps))}
                        disabled={this.isLoading}
                    >
                        <i className={codicon('chevron-right')}></i>
                    </button>
                </Tooltip>
                <Tooltip content="Last step" position="bottom">
                    <button
                        className="theia-button secondary"
                        onClick={() => this.setStepIndex(series.nSteps - 1)}
                        disabled={this.isLoading}
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
        const material = new THREE.PointsMaterial({ size: 3, vertexColors: true, sizeAttenuation: false });
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
