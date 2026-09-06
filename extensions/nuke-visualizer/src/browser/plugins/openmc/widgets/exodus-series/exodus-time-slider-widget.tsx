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
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    colormapToCssGradient,
    getColormap,
    isShortColormapName,
    SHORT_COLORMAP_NAMES,
    ShortColormapName
} from '../../../../viewer-core/colormaps';
import {
    createDefaultToolbarState,
    parseColorBy,
    SOLID_COLOR,
    updateToolbarState,
    ViewerToolbarState
} from '../../../../viewer-core/viewer-toolbar-model';
import {
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
    stepValueRange
} from './exodus-series-model';
import '../output-viewer.css';

/**
 * Native Exodus time-slider widget (P5, unwired).
 *
 * Renders a `base.exodus-series` payload — the headless replacement for the
 * trame `reader.TimestepValues` -> `view.ViewTime` slider in
 * `python/plugins/base/commands/serve.py` — as a client-side time index:
 * first/prev/slider/next/last stepping plus an instant per-step array
 * switch (no server restart; the P1 color-by win applied to time). Coloring
 * state lives in the viewer-core toolbar model and the legend gradient
 * samples the viewer-core LUT pack, so the wiring wave only has to push the
 * current step's decimated mesh (`stepPositions`) into three.js scene
 * building (native-vtk rendering path) and bind this widget in a
 * contribution — nothing here is registered yet.
 */
@injectable()
export class ExodusTimeSliderWidget extends ReactWidget {
    static readonly ID: string = 'exodus-time-slider-widget';
    static readonly LABEL: string = 'Exodus Time Slider';

    @inject(FileService)
    protected readonly fileService!: FileService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected fileUri: URI | undefined;
    protected series: ExodusSeriesPayload | undefined;
    protected stepIndex = 0;
    protected toolbar: ViewerToolbarState = createDefaultToolbarState();
    protected isLoading = false;
    protected error: string | undefined;
    private loadToken = 0;

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
            const content = await this.fileService.read(uri);
            if (token !== this.loadToken) {
                return;
            }
            this.setSeriesText(content.value.toString());
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
    setSeriesText(text: string): void {
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
        this.update();
    }

    /** Switch the color-by array for the current step; instant, no reload. */
    setColorBy(colorBy: string): void {
        if (this.series && !hasColorByArray(this.series, colorBy)) {
            return;
        }
        this.toolbar = updateToolbarState(this.toolbar, { colorBy });
        this.update();
    }

    /** Switch the LUT used by the legend; instant, no reload. */
    setColormap(colormap: string): void {
        if (!isShortColormapName(colormap)) {
            return;
        }
        const name: ShortColormapName = colormap;
        this.toolbar = updateToolbarState(this.toolbar, { colormap: name });
        this.update();
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
                <button
                    className="theia-button secondary"
                    onClick={() => this.fileUri && this.setSeriesFile(this.fileUri)}
                    disabled={this.isLoading || !this.fileUri}
                    title="Reload series"
                >
                    <i className={codicon('refresh')}></i>
                </button>
            </div>
        );
    }

    protected renderColorBySelect(): React.ReactNode {
        if (!this.series) {
            return undefined;
        }
        return (
            <label className="openmc-output-viewer-control" title="Color-by array for the current step (applies instantly)">
                Color by
                <select value={this.toolbar.colorBy} onChange={(e) => this.setColorBy(e.target.value)} disabled={this.isLoading}>
                    {colorByOptions(this.series).map((option) => (
                        <option key={option} value={option}>
                            {option}
                        </option>
                    ))}
                </select>
            </label>
        );
    }

    protected renderColormapSelect(): React.ReactNode {
        if (!this.series) {
            return undefined;
        }
        return (
            <label className="openmc-output-viewer-control" title="Colormap for the legend (applies instantly)">
                Map
                <select value={this.toolbar.colormap} onChange={(e) => this.setColormap(e.target.value)} disabled={this.isLoading}>
                    {SHORT_COLORMAP_NAMES.map((name) => (
                        <option key={name} value={name}>
                            {name}
                        </option>
                    ))}
                </select>
            </label>
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
                {this.renderStepSummary()}
            </>
        );
    }

    protected renderSlider(): React.ReactNode {
        const series = this.series;
        if (!series) {
            return undefined;
        }
        return (
            <div className="openmc-output-viewer-header" title="Time step (client-side index over the extracted series)">
                <button
                    className="theia-button secondary"
                    onClick={() => this.setStepIndex(0)}
                    disabled={this.isLoading}
                    title="First step"
                >
                    <i className={codicon('chevron-left-all')}></i>
                </button>
                <button
                    className="theia-button secondary"
                    onClick={() => this.setStepIndex(previousStepIndex(this.stepIndex, series.nSteps))}
                    disabled={this.isLoading}
                    title="Previous step"
                >
                    <i className={codicon('chevron-left')}></i>
                </button>
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
                <button
                    className="theia-button secondary"
                    onClick={() => this.setStepIndex(nextStepIndex(this.stepIndex, series.nSteps))}
                    disabled={this.isLoading}
                    title="Next step"
                >
                    <i className={codicon('chevron-right')}></i>
                </button>
                <button
                    className="theia-button secondary"
                    onClick={() => this.setStepIndex(series.nSteps - 1)}
                    disabled={this.isLoading}
                    title="Last step"
                >
                    <i className={codicon('chevron-right-all')}></i>
                </button>
                <span className="openmc-output-viewer-file">{formatStepLabel(series, this.stepIndex)}</span>
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
        const gradient = definition ? colormapToCssGradient(definition) : undefined;
        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 8px', fontSize: '11px' }}>
                <span>
                    Mesh — {step.mesh.nNodes.toLocaleString()} nodes ({step.mesh.nodes.length.toLocaleString()} stored),{' '}
                    {step.mesh.nElements.toLocaleString()} elements in {step.mesh.blocks.length} block(s)
                </span>
                {summary && range ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }} title={`${arrayName} at this step`}>
                        <span>{range[0].toPrecision(3)}</span>
                        {gradient ? <div style={{ flex: '1', height: '10px', background: gradient }} /> : undefined}
                        <span>{range[1].toPrecision(3)}</span>
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
}
