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

import './tally-series.css';
import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { MessageService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { NukeSelect, NukeSwitch, Tooltip, type NukeSelectOption } from 'nuke-essentials/lib/theme/browser/components';
import { LoadingAnimations, SimpleLoadingSpinner } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { OpenMCService } from '../../openmc-service';
import { OpenMCTallySeries, OpenMCTallySeriesOptions, OpenMCTallySeriesStatistic } from '../../../../../common/openmc-protocol';
import {
    buildSeriesChart,
    clampSeriesIndex,
    nextSeriesIndex,
    parseTallySeriesPayload,
    previousSeriesIndex,
    seriesStatisticLabel,
    seriesYRange
} from './tally-series-model';
import { PlotlyComponent } from '../../../../plotly/plotly-component';

const STATISTIC_OPTIONS: readonly NukeSelectOption[] = (['total', 'mean', 'max'] as const).map((statistic) => ({
    value: statistic,
    label: seriesStatisticLabel(statistic)
}));

/** Request that loads one tally series across a set of statepoints. */
export interface TallySeriesWidgetRequest {
    /** Statepoint files, in backend order (explicit times preserve this order). */
    files: string[];
    /** Tally/score/nuclide/statistic selection. */
    options: OpenMCTallySeriesOptions;
    /** Optional tab title supplied by the opening contribution. */
    title?: string;
}

/**
 * Tally series across statepoints.
 *
 * Plots one tally score over every statepoint in the series with `±σ` error
 * bars and a marker on the current step, then hands any mesh-tally step to
 * the native 3D viewer with an optional shared color range. Series parsing
 * and step arithmetic live in `tally-series-model.ts`; this widget owns only
 * the render/step/handoff state.
 */
@injectable()
export class OpenMCTallySeriesWidget extends ReactWidget {
    static readonly ID = 'openmc-tally-series-widget';
    static readonly LABEL = 'Tally Series';

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected request: TallySeriesWidgetRequest | undefined;
    protected series: OpenMCTallySeries | undefined;
    protected stepIndex = 0;
    protected loading = false;
    protected error: string | undefined;
    protected sharedRange = true;

    private loadToken = 0;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCTallySeriesWidget.ID;
        this.title.label = OpenMCTallySeriesWidget.LABEL;
        this.title.caption = OpenMCTallySeriesWidget.LABEL;
        this.title.iconClass = codicon('graph-line');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    /**
     * Load a tally series. Re-requesting supersedes any in-flight load via
     * the token check in `load()`.
     */
    setRequest(request: TallySeriesWidgetRequest): void {
        this.request = request;
        this.loading = true;
        this.error = undefined;
        this.series = undefined;
        this.stepIndex = 0;
        if (request.title) {
            this.title.label = request.title;
            this.title.caption = request.title;
        } else {
            this.title.label = OpenMCTallySeriesWidget.LABEL;
            this.title.caption = OpenMCTallySeriesWidget.LABEL;
        }
        this.update();
        void this.load();
    }

    /**
     * Switch the aggregation statistic and reload in place. Files and the
     * score/nuclide selection stay unchanged; `load()` supersedes any
     * in-flight request through the load token.
     */
    setStatistic(statistic: OpenMCTallySeriesStatistic): void {
        const request = this.request;
        if (!request || (request.options.statistic ?? 'total') === statistic) {
            return;
        }
        this.request = {
            ...request,
            options: { ...request.options, statistic }
        };
        this.loading = true;
        this.error = undefined;
        this.series = undefined;
        this.stepIndex = 0;
        this.update();
        void this.load();
    }

    /** Fetch and parse the request's tally series. */
    protected async load(): Promise<void> {
        const request = this.request;
        if (!request) {
            return;
        }
        const token = ++this.loadToken;
        try {
            const payload = await this.openmcService.getTallySeries(request.files, request.options);
            if (token !== this.loadToken) {
                return;
            }
            const series = parseTallySeriesPayload(payload);
            if ((request.options.statistic ?? 'total') !== series.statistic) {
                // Keep the selector aligned with the backend's effective aggregate.
                this.request = { ...request, options: { ...request.options, statistic: series.statistic } };
            }
            this.series = series;
            this.stepIndex = clampSeriesIndex(0, series.steps.length);
            this.loading = false;
            this.error = undefined;
            this.update();
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.loading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.update();
        }
    }

    /** Move to a step index (clamped); instant chart-marker update. */
    setStepIndex(index: number): void {
        if (!this.series) {
            return;
        }
        this.stepIndex = clampSeriesIndex(index, this.series.steps.length);
        this.update();
    }

    /** Toggle the shared color range used by the 3D handoff. */
    setSharedRange(shared: boolean): void {
        this.sharedRange = shared;
        this.update();
    }

    /** Open the current step's mesh tally in the native 3D viewer. */
    protected async openAtStep(): Promise<void> {
        const series = this.series;
        const step = series?.steps[this.stepIndex];
        if (!series || !step || !series.hasMesh || this.loading) {
            return;
        }
        try {
            await this.openmcService.visualizeMeshTally(new URI(step.file), {
                tallyId: series.tallyId,
                score: series.score,
                nuclide: series.nuclide,
                range: this.sharedRange ? series.viewRange : undefined
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to open tally in 3D: ${message}`);
        }
    }

    override dispose(): void {
        this.loadToken++;
        super.dispose();
    }

    protected render(): React.ReactNode {
        return (
            <div className="tally-series-widget">
                {this.renderHeader()}
                {this.loading ? (
                    <div className="tally-series-loading">
                        <LoadingAnimations />
                        <SimpleLoadingSpinner message="Loading tally series…" />
                    </div>
                ) : this.error ? (
                    this.renderError()
                ) : !this.series || this.series.steps.length === 0 ? (
                    this.renderEmpty()
                ) : (
                    this.renderSeries(this.series)
                )}
            </div>
        );
    }

    protected renderHeader(): React.ReactNode {
        const series = this.series;
        const heading = this.request?.title || series?.tallyName || OpenMCTallySeriesWidget.LABEL;
        return (
            <div className="tally-series-header">
                <i className={codicon('graph-line')}></i>
                <div className="tally-series-heading">
                    <div className="tally-series-name">{heading}</div>
                    <div className="tally-series-meta">
                        {series ? (
                            <>
                                <span>Tally {series.tallyId}</span>
                                {series.tallyName && series.tallyName !== heading ? (
                                    <>
                                        <span className="tally-series-sep">·</span>
                                        <span>{series.tallyName}</span>
                                    </>
                                ) : undefined}
                                <span className="tally-series-sep">·</span>
                                <span>{series.score}</span>
                                <span className="tally-series-sep">·</span>
                                <span>{seriesStatisticLabel(series.statistic)}</span>
                                <span className="tally-series-sep">·</span>
                                <span>
                                    {series.steps.length} step{series.steps.length === 1 ? '' : 's'}
                                </span>
                            </>
                        ) : (
                            <span>{this.loading ? 'Loading…' : 'No series loaded'}</span>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    protected renderSeries(series: OpenMCTallySeries): React.ReactNode {
        return (
            <>
                {this.renderChart(series)}
                {this.renderControls(series)}
                {this.renderActions(series)}
            </>
        );
    }

    protected renderChart(series: OpenMCTallySeries): React.ReactNode {
        const chart = buildSeriesChart(series, this.stepIndex);
        const current = series.steps[this.stepIndex];
        const yRange = seriesYRange(series);
        const traces: Partial<Plotly.Data>[] = [
            {
                type: 'scatter',
                mode: 'lines+markers',
                name: series.score,
                x: chart.x,
                y: chart.y,
                line: { color: '#4fc3f7', width: 2 },
                marker: { color: '#4fc3f7', size: 5 },
                error_y: {
                    type: 'data',
                    array: chart.errorY,
                    visible: true,
                    color: 'rgba(79, 195, 247, 0.55)',
                    thickness: 1,
                    width: 3
                },
                hovertemplate: `${chart.xTitle}: %{x}<br>${chart.yTitle}: %{y:.4g}<extra></extra>`
            }
        ];
        if (current) {
            traces.push({
                type: 'scatter',
                mode: 'markers',
                name: 'Current step',
                x: [chart.x[this.stepIndex]],
                y: [chart.y[this.stepIndex]],
                marker: { color: '#ffffff', size: 11, line: { color: '#4fc3f7', width: 2 } },
                hovertemplate: `${current.fileName}<br>${chart.yTitle}: %{y:.4g}<extra></extra>`,
                showlegend: false
            });
        }
        const layout: Partial<Plotly.Layout> = {
            showlegend: false,
            hovermode: 'closest',
            margin: { l: 64, r: 24, t: 16, b: 48 },
            xaxis: { title: { text: chart.xTitle } },
            yaxis: {
                title: { text: chart.yTitle },
                range: [yRange[0], yRange[1]]
            }
        };
        return (
            <div className="tally-series-chart">
                <PlotlyComponent data={traces} layout={layout} style={{ width: '100%', height: '320px' }} />
            </div>
        );
    }

    protected renderControls(series: OpenMCTallySeries): React.ReactNode {
        const lastIndex = series.steps.length - 1;
        const step = series.steps[this.stepIndex];
        const atFirst = this.stepIndex <= 0;
        const atLast = this.stepIndex >= lastIndex;
        return (
            <>
                <div className="tally-series-controls">
                    <Tooltip content="First step" position="bottom">
                        <button
                            className="theia-button secondary tally-series-step-button"
                            aria-label="First step"
                            onClick={() => this.setStepIndex(0)}
                            disabled={this.loading || atFirst}
                        >
                            <i className={codicon('debug-step-back')}></i>
                        </button>
                    </Tooltip>
                    <Tooltip content="Previous step" position="bottom">
                        <button
                            className="theia-button secondary tally-series-step-button"
                            aria-label="Previous step"
                            onClick={() => this.setStepIndex(previousSeriesIndex(this.stepIndex, series.steps.length))}
                            disabled={this.loading || atFirst}
                        >
                            <i className={codicon('chevron-left')}></i>
                        </button>
                    </Tooltip>
                    <input
                        className="tally-series-slider"
                        type="range"
                        min={0}
                        max={lastIndex}
                        step={1}
                        value={this.stepIndex}
                        aria-label="Tally series step"
                        onChange={(event) => this.setStepIndex(Number(event.target.value))}
                        disabled={this.loading}
                    />
                    <Tooltip content="Next step" position="bottom">
                        <button
                            className="theia-button secondary tally-series-step-button"
                            aria-label="Next step"
                            onClick={() => this.setStepIndex(nextSeriesIndex(this.stepIndex, series.steps.length))}
                            disabled={this.loading || atLast}
                        >
                            <i className={codicon('chevron-right')}></i>
                        </button>
                    </Tooltip>
                    <Tooltip content="Last step" position="bottom">
                        <button
                            className="theia-button secondary tally-series-step-button"
                            aria-label="Last step"
                            onClick={() => this.setStepIndex(lastIndex)}
                            disabled={this.loading || atLast}
                        >
                            <i className={codicon('debug-step-forward')}></i>
                        </button>
                    </Tooltip>
                </div>
                <div className="tally-series-status">
                    <span className="tally-series-step-label">
                        Step {this.stepIndex + 1} of {series.steps.length} · {step.fileName}
                    </span>
                    <span className="tally-series-value" title="Value ± standard deviation">
                        {formatSeriesNumber(step.value)} ± {formatSeriesNumber(step.std)}
                    </span>
                </div>
            </>
        );
    }

    protected renderActions(series: OpenMCTallySeries): React.ReactNode {
        const canOpen3d = series.hasMesh && !this.loading;
        const tooltip = series.hasMesh
            ? 'Open this step in the native 3D tally viewer (shared color range applies when enabled)'
            : 'This tally has no mesh filter — 3D handoff is unavailable.';
        return (
            <div className="tally-series-actions">
                <div className="tally-series-statistic-row">
                    <span className="tally-series-statistic-label">Statistic</span>
                    <NukeSelect
                        className="tally-series-statistic"
                        ariaLabel="Tally series statistic"
                        value={this.request?.options.statistic ?? 'total'}
                        options={STATISTIC_OPTIONS}
                        onChange={(value) => this.setStatistic(value as OpenMCTallySeriesStatistic)}
                        disabled={this.loading}
                    />
                </div>
                <div className="tally-series-shared-range-row">
                    <NukeSwitch
                        className="tally-series-shared-range"
                        ariaLabel="Shared color range"
                        checked={this.sharedRange}
                        onChange={(checked) => this.setSharedRange(checked)}
                    />
                    <span>Shared color range</span>
                </div>
                <Tooltip content={tooltip} position="bottom">
                    <button
                        className="theia-button secondary tally-series-open-3d"
                        aria-label="Open 3D at this step"
                        onClick={() => this.openAtStep()}
                        disabled={!canOpen3d}
                    >
                        <i className={codicon('globe')}></i>
                        Open 3D at this step
                    </button>
                </Tooltip>
                {!series.hasMesh ? (
                    <div className="tally-series-hint">This tally has no mesh filter — 3D handoff is unavailable.</div>
                ) : undefined}
            </div>
        );
    }

    protected renderError(): React.ReactNode {
        return (
            <div className="tally-series-error" role="alert">
                <i className={codicon('error')}></i>
                <span>{this.error}</span>
            </div>
        );
    }

    protected renderEmpty(): React.ReactNode {
        const message = this.request
            ? 'This tally series has no finite steps to chart.'
            : 'No tally series loaded. Choose Series on a tally in the Statepoint Viewer.';
        return (
            <div className="tally-series-empty">
                <i className={codicon('graph-line')}></i>
                <span>{message}</span>
            </div>
        );
    }
}

/** Compact value readout: 4 significant digits, exponential at the extremes. */
export function formatSeriesNumber(value: number): string {
    if (!Number.isFinite(value)) {
        if (Number.isNaN(value)) {
            return '—';
        }
        return value > 0 ? '∞' : '−∞';
    }
    if (value === 0) {
        return '0';
    }
    const magnitude = Math.abs(value);
    if (magnitude < 1e-3 || magnitude >= 1e6) {
        return value.toExponential(3);
    }
    const text = value.toPrecision(4);
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}
