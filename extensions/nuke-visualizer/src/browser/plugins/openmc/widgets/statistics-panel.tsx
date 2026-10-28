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
 * Props-only statistical plot panel: 2D histogram, scatter, box/quartile,
 * and parallel coordinates over the arrays handed in by the host.
 *
 * No Theia DI, no store, no global state. Large inputs are decimated through
 * `viewer-core/statistics.ts` (20k scatter/parallel budget); 2D histogram
 * bins are capped at 128×128. The panel only renders Plotly figures; the
 * hosting widget owns dataset selection and lifecycle.
 */

import * as React from 'react';
import * as Plotly from 'plotly.js-dist-min';
import { NukeEmptyState, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { PlotlyComponent } from '../../../plotly/plotly-component';
import { usePlotlyTheme } from '../../../plotly/plotly-theme';
import {
    DEFAULT_HISTOGRAM_2D_BINS,
    DEFAULT_SCATTER_MAX_POINTS,
    MAX_HISTOGRAM_2D_BINS,
    computeHistogram2D,
    computeQuantiles,
    parallelCoordinates,
    sampleScatter
} from '../../../viewer-core/statistics';
import './statistics-panel.css';

/** One named scalar series the panel can plot (often one dataset array). */
export interface StatisticsArray {
    readonly name: string;
    readonly values: ArrayLike<number>;
}

/** Panel tabs; exported so hosts can persist the last-used tab if desired. */
export type StatisticsTab = 'histogram2d' | 'scatter' | 'box' | 'parallel';

/** Host contract: dataset arrays plus an optional default/active array. */
export interface StatisticsPanelProps {
    readonly arrays: readonly StatisticsArray[];
    /** Index of the array to select first (clamped; defaults to 0). */
    readonly activeIndex?: number;
    /** Optional close affordance rendered in the panel header. */
    readonly onClose?: () => void;
}

interface StatisticsFigure {
    readonly data: Partial<Plotly.Data>[];
    readonly layout: Partial<Plotly.Layout>;
    readonly summary: string;
}

const TABS: readonly { readonly id: StatisticsTab; readonly label: string }[] = [
    { id: 'histogram2d', label: '2D Histogram' },
    { id: 'scatter', label: 'Scatter' },
    { id: 'box', label: 'Box' },
    { id: 'parallel', label: 'Parallel Coordinates' }
];

const EMPTY_FIGURE: StatisticsFigure = { data: [], layout: {}, summary: '' };

const PLOT_CONFIG: Partial<Plotly.Config> = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    toImageButtonOptions: {
        format: 'png',
        filename: 'statistics',
        height: 600,
        width: 900,
        scale: 2
    }
};

/** Array label for selects (1-based, matching the axis order). */
function selectLabel(array: StatisticsArray, index: number): string {
    return array.name ? `${index + 1}. ${array.name}` : `Array ${index + 1}`;
}

/** Array label for axes/legends (raw name, with a fallback for unnamed arrays). */
function axisLabel(array: StatisticsArray, index: number): string {
    return array.name || `Array ${index + 1}`;
}

/** Escape target-derived names before they are interpolated into Plotly HTML. */
function escapeText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatStat(value: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude >= 1e5 || magnitude < 1e-3)) {
        return value.toExponential(3);
    }
    return Number(value.toFixed(4)).toString();
}

function binCenters(edges: Float64Array): number[] {
    const centers = new Array<number>(Math.max(0, edges.length - 1));
    for (let i = 0; i < centers.length; i++) {
        centers[i] = (edges[i] + edges[i + 1]) / 2;
    }
    return centers;
}

function normalizeActiveIndex(activeIndex: number | undefined, arrayCount: number): number {
    if (arrayCount === 0 || activeIndex === undefined || !Number.isFinite(activeIndex)) {
        return 0;
    }
    return Math.min(Math.max(Math.floor(activeIndex), 0), arrayCount - 1);
}

function buildHistogram2DFigure(x: StatisticsArray, y: StatisticsArray, bins: number, xIndex: number, yIndex: number): StatisticsFigure {
    const histogram = computeHistogram2D(x.values, y.values, bins, bins);
    const z: number[][] = [];
    for (let row = 0; row < histogram.yBinCount; row++) {
        const start = row * histogram.xBinCount;
        z.push(Array.from(histogram.counts.subarray(start, start + histogram.xBinCount)));
    }
    const xName = escapeText(axisLabel(x, xIndex));
    const yName = escapeText(axisLabel(y, yIndex));
    const trace = {
        type: 'heatmap',
        x: binCenters(histogram.xEdges),
        y: binCenters(histogram.yEdges),
        z,
        colorscale: 'Viridis',
        colorbar: { title: { text: 'count' }, thickness: 10 },
        hovertemplate: `${xName}: %{x:.4g}<br>${yName}: %{y:.4g}<br>count: %{z}<extra></extra>`
    } as Partial<Plotly.Data>;
    const skipped = Math.min(x.values.length, y.values.length) - histogram.validCount;
    const skippedNote = skipped > 0 ? ` · ${skipped.toLocaleString()} non-finite pairs skipped` : '';
    return {
        data: [trace],
        layout: {
            xaxis: { title: { text: escapeText(axisLabel(x, xIndex)) } },
            yaxis: { title: { text: escapeText(axisLabel(y, yIndex)) } },
            margin: { l: 70, r: 20, t: 20, b: 55 },
            showlegend: false
        },
        summary: `${histogram.validCount.toLocaleString()} finite pairs${skippedNote} · ${histogram.xBinCount}×${histogram.yBinCount} bins · max bin ${histogram.max.toLocaleString()}`
    };
}

function buildScatterFigure(x: StatisticsArray, y: StatisticsArray, xIndex: number, yIndex: number): StatisticsFigure {
    const sample = sampleScatter(x.values, y.values);
    const xName = escapeText(axisLabel(x, xIndex));
    const yName = escapeText(axisLabel(y, yIndex));
    const trace = {
        type: 'scattergl',
        mode: 'markers',
        x: sample.x,
        y: sample.y,
        name: `${axisLabel(x, xIndex)} vs ${axisLabel(y, yIndex)}`,
        marker: { size: 3, opacity: 0.55, color: '#4a9eff' },
        hovertemplate: `${xName}: %{x:.6g}<br>${yName}: %{y:.6g}<extra></extra>`
    } as Partial<Plotly.Data>;
    const sampled = sample.decimated
        ? `${sample.x.length.toLocaleString()} of ${sample.sourceCount.toLocaleString()} finite pairs (evenly decimated)`
        : `${sample.sourceCount.toLocaleString()} finite pairs`;
    const skippedNote = sample.skippedCount > 0 ? ` · ${sample.skippedCount.toLocaleString()} non-finite pairs skipped` : '';
    return {
        data: [trace],
        layout: {
            xaxis: { title: { text: escapeText(axisLabel(x, xIndex)) } },
            yaxis: { title: { text: escapeText(axisLabel(y, yIndex)) } },
            margin: { l: 70, r: 20, t: 20, b: 55 },
            showlegend: false
        },
        summary: `${sampled}${skippedNote}`
    };
}

function buildBoxFigure(arrays: readonly StatisticsArray[], activeIndex: number): StatisticsFigure {
    const summaries = arrays.map((array) => computeQuantiles(array.values));
    const trace = {
        type: 'box',
        name: 'Arrays',
        x: arrays.map((array, index) => escapeText(`${index + 1}. ${axisLabel(array, index)}`)),
        q1: summaries.map((stats) => stats.q1),
        median: summaries.map((stats) => stats.median),
        q3: summaries.map((stats) => stats.q3),
        lowerfence: summaries.map((stats) => stats.min),
        upperfence: summaries.map((stats) => stats.max),
        mean: summaries.map((stats) => stats.mean),
        boxmean: true,
        boxpoints: false,
        showlegend: false
    } as unknown as Partial<Plotly.Data>;
    const activeStats = summaries[activeIndex] ?? summaries[0];
    const activeName = arrays[activeIndex] ? axisLabel(arrays[activeIndex], activeIndex) : 'No array';
    const summary = activeStats
        ? `${activeName}: min ${formatStat(activeStats.min)} · q1 ${formatStat(activeStats.q1)} · median ${formatStat(
              activeStats.median
          )} · q3 ${formatStat(activeStats.q3)} · max ${formatStat(activeStats.max)} · mean ${formatStat(
              activeStats.mean
          )} · std ${formatStat(activeStats.std)} · ${activeStats.count.toLocaleString()} values`
        : '';
    return {
        data: [trace],
        layout: {
            xaxis: { type: 'category', title: { text: 'array' } },
            yaxis: { title: { text: 'value' } },
            margin: { l: 70, r: 20, t: 20, b: 70 },
            showlegend: false
        },
        summary
    };
}

function buildParallelFigure(arrays: readonly StatisticsArray[], activeIndex: number): StatisticsFigure {
    const result = parallelCoordinates(arrays, DEFAULT_SCATTER_MAX_POINTS);
    const activeDimension = result.dimensions[activeIndex] ?? result.dimensions[0];
    const line = activeDimension ? { color: activeDimension.values, colorscale: 'Viridis', showscale: false } : { color: '#4a9eff' };
    const trace = {
        type: 'parcoords',
        line,
        dimensions: result.dimensions.map((dimension) => ({
            label: escapeText(dimension.name),
            values: dimension.values
        }))
    } as unknown as Partial<Plotly.Data>;
    const skippedNote = result.skippedRows > 0 ? ` · ${result.skippedRows.toLocaleString()} non-finite rows skipped` : '';
    const sampledNote = result.decimated
        ? ` · ${result.rowCount.toLocaleString()} of ${(result.sourceRowCount - result.skippedRows).toLocaleString()} rows sampled`
        : '';
    return {
        data: [trace],
        layout: {
            margin: { l: 70, r: 30, t: 30, b: 40 }
        },
        summary: `${result.rowCount.toLocaleString()} rows × ${result.dimensions.length} dimensions${skippedNote}${sampledNote}`
    };
}

/**
 * Stateless-over-props panel with local tab/axis selection state. The host
 * passes the arrays; nothing here reads the active viewer or global stores.
 */
export function StatisticsPanel(props: StatisticsPanelProps): React.ReactElement {
    const arrays = props.arrays;
    const arrayCount = arrays.length;
    const active = normalizeActiveIndex(props.activeIndex, arrayCount);
    const [tab, setTab] = React.useState<StatisticsTab>('histogram2d');
    const [xSelection, setXSelection] = React.useState(active);
    const [ySelection, setYSelection] = React.useState(active === 0 ? 1 : 0);
    const [bins, setBins] = React.useState(DEFAULT_HISTOGRAM_2D_BINS);
    const theme = usePlotlyTheme();

    React.useEffect(() => {
        if (props.activeIndex === undefined || arrayCount === 0) {
            return;
        }
        const next = normalizeActiveIndex(props.activeIndex, arrayCount);
        setXSelection(next);
        setYSelection(next === 0 ? Math.min(1, arrayCount - 1) : 0);
    }, [props.activeIndex, arrayCount]);

    const xIndex = arrayCount === 0 ? 0 : Math.min(xSelection, arrayCount - 1);
    const candidateY = arrayCount < 2 ? 0 : Math.min(ySelection, arrayCount - 1);
    const yIndex = arrayCount < 2 ? 0 : candidateY === xIndex ? (xIndex + 1) % arrayCount : candidateY;

    const figure = React.useMemo<StatisticsFigure>(() => {
        if (arrayCount < 2) {
            return EMPTY_FIGURE;
        }
        if (tab === 'box') {
            return buildBoxFigure(arrays, active);
        }
        if (tab === 'parallel') {
            return buildParallelFigure(arrays, active);
        }
        const x = arrays[xIndex];
        const y = arrays[yIndex];
        if (!x || !y) {
            return EMPTY_FIGURE;
        }
        return tab === 'histogram2d' ? buildHistogram2DFigure(x, y, bins, xIndex, yIndex) : buildScatterFigure(x, y, xIndex, yIndex);
    }, [arrays, arrayCount, tab, active, xIndex, yIndex, bins]);

    const header = (
        <div className="nuke-statistics-panel-header">
            <span className="codicon codicon-graph" aria-hidden="true" />
            <span className="nuke-statistics-panel-title">Statistics</span>
            {props.onClose && (
                <button
                    type="button"
                    className="theia-button secondary nuke-statistics-panel-close"
                    onClick={props.onClose}
                    title="Close"
                    aria-label="Close statistics"
                >
                    <span className="codicon codicon-close" aria-hidden="true" />
                </button>
            )}
        </div>
    );

    if (arrayCount < 2) {
        return (
            <div className="nuke-statistics-panel">
                {header}
                <NukeEmptyState
                    className="nuke-statistics-panel-empty"
                    icon="graph"
                    title="No statistical comparison"
                    message="Open a dataset with at least two arrays to compare distributions."
                />
            </div>
        );
    }

    const selectOptions = arrays.map((array, index) => ({
        value: String(index),
        label: selectLabel(array, index)
    }));
    const selectIndex = (value: string): number => {
        const parsed = Number.parseInt(value, 10);
        return Number.isInteger(parsed) && parsed >= 0 && parsed < arrayCount ? parsed : 0;
    };
    const chooseX = (value: string): void => {
        const next = selectIndex(value);
        if (next === yIndex) {
            setYSelection(xIndex);
        }
        setXSelection(next);
    };
    const chooseY = (value: string): void => {
        const next = selectIndex(value);
        if (next === xIndex) {
            setXSelection(yIndex);
        }
        setYSelection(next);
    };

    return (
        <div className="nuke-statistics-panel">
            {header}
            <div className="nuke-statistics-panel-tabs" role="tablist" aria-label="Statistical plot">
                {TABS.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === entry.id}
                        className="nuke-statistics-panel-tab"
                        onClick={() => setTab(entry.id)}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>
            <div className="nuke-statistics-panel-controls">
                {(tab === 'histogram2d' || tab === 'scatter') && (
                    <>
                        <label className="nuke-statistics-panel-control">
                            X
                            <NukeSelect
                                value={String(xIndex)}
                                options={selectOptions}
                                onChange={chooseX}
                                ariaLabel="X array"
                                style={{ width: '160px' }}
                            />
                        </label>
                        <label className="nuke-statistics-panel-control">
                            Y
                            <NukeSelect
                                value={String(yIndex)}
                                options={selectOptions}
                                onChange={chooseY}
                                ariaLabel="Y array"
                                style={{ width: '160px' }}
                            />
                        </label>
                    </>
                )}
                {tab === 'histogram2d' && (
                    <label className="nuke-statistics-panel-control">
                        Bins
                        <input
                            type="number"
                            min={1}
                            max={MAX_HISTOGRAM_2D_BINS}
                            value={bins}
                            aria-label="Histogram bins per axis"
                            onChange={(event) => {
                                const next = Number.parseInt(event.target.value, 10);
                                if (Number.isInteger(next)) {
                                    setBins(Math.min(MAX_HISTOGRAM_2D_BINS, Math.max(1, next)));
                                }
                            }}
                        />
                    </label>
                )}
                {tab === 'scatter' && (
                    <span className="nuke-statistics-panel-note">
                        Scatter is evenly decimated to {DEFAULT_SCATTER_MAX_POINTS.toLocaleString()} points.
                    </span>
                )}
                {tab === 'box' && <span className="nuke-statistics-panel-note">One box per array; whiskers span min–max.</span>}
                {tab === 'parallel' && (
                    <span className="nuke-statistics-panel-note">
                        Rows are aligned by tuple index and evenly decimated to {DEFAULT_SCATTER_MAX_POINTS.toLocaleString()}.
                    </span>
                )}
            </div>
            <div className="nuke-statistics-panel-chart">
                <PlotlyComponent data={figure.data} layout={figure.layout} config={PLOT_CONFIG} theme={theme} />
            </div>
            {figure.summary && <div className="nuke-statistics-panel-summary">{figure.summary}</div>}
        </div>
    );
}
