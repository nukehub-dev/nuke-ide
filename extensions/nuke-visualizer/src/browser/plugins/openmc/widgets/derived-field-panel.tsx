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
import { formatRangeValue, tupleScalar } from '../../../viewer-core/scalar-mapping';
import {
    ArrayStats,
    MAX_HISTOGRAM_BINS,
    computeArrayStats,
    computeHistogram,
    normalizeHistogramBinCount
} from '../../../viewer-core/derived-fields';
import { parseColorBy } from './native-vtk/native-vtk-data';
import { StatisticsPanel, type StatisticsArray } from './statistics-panel';

/**
 * Shared Calculator + Histogram section for the native output viewers'
 * data half (tracks, collision-track, weight-windows).
 *
 * State lives in the hosting widget (expression text, committed field,
 * bin count, log-y); this component is a stateless render over props plus
 * the pure `viewer-core/derived-fields` helpers. The histogram always
 * covers the viewer's active color-by array (derived or parsed) resolved
 * through {@link resolveHistogramSource} — never Plotly, just an SVG
 * stats readout with a log-y toggle.
 */

/** Minimal array shape the histogram resolver reads (satisfied by the parsed VTK arrays). */
export interface HistogramSourceArray {
    readonly name: string;
    readonly association: 'point' | 'cell';
    readonly components: number;
    readonly values: ArrayLike<number>;
}

/** Minimal model shape the histogram resolver reads. */
export interface HistogramSourceModel {
    readonly pointArrays: readonly HistogramSourceArray[];
    readonly cellArrays: readonly HistogramSourceArray[];
}

/** Active color-by array resolved to per-tuple scalars (or undefined for Solid Color / no dataset). */
export interface ActiveHistogramSource {
    readonly label: string;
    readonly values: Float64Array;
}

/**
 * Resolve the viewer's active color-by selection to per-tuple scalars using
 * the current vector component (magnitude default, same rule as the 3D
 * mapping). Returns undefined for Solid Color, missing datasets, or arrays
 * that are no longer in the file.
 */
export function resolveHistogramSource(
    model: HistogramSourceModel | undefined,
    colorBy: string,
    component: number
): ActiveHistogramSource | undefined {
    if (!model) {
        return undefined;
    }
    const selection = parseColorBy(colorBy);
    if (!selection || selection.kind === 'solid') {
        return undefined;
    }
    const list = selection.kind === 'point' ? model.pointArrays : model.cellArrays;
    const array = list.find((entry) => entry.name === selection.name);
    if (!array) {
        return undefined;
    }
    const tuples = Math.floor(array.values.length / Math.max(1, array.components));
    const values = new Float64Array(tuples);
    for (let t = 0; t < tuples; t++) {
        values[t] = tupleScalar(array.values, array.components, t, component);
    }
    return { label: `${selection.kind === 'point' ? 'Point' : 'Cell'}: ${array.name}`, values };
}

/**
 * Scalar series for the Statistics card: every point/cell array reduced to
 * one value per tuple with the active component. Capped to the first eight
 * arrays so a statepoint with hundreds of tallies cannot build a huge
 * parallel-coordinates table. Pure; hosts pass the stable model identity so
 * the panel can memoize on it.
 */
export function resolveStatisticsArrays(model: HistogramSourceModel | undefined, component: number, maxArrays = 8): StatisticsArray[] {
    if (!model) {
        return [];
    }
    const arrays: StatisticsArray[] = [];
    for (const array of [...model.pointArrays, ...model.cellArrays]) {
        const components = Math.max(1, array.components);
        const tuples = Math.floor(array.values.length / components);
        if (tuples < 2) {
            continue;
        }
        const values = new Float64Array(tuples);
        for (let t = 0; t < tuples; t++) {
            values[t] = tupleScalar(array.values, components, t, component);
        }
        arrays.push({ name: `${array.association}:${array.name}`, values });
        if (arrays.length >= maxArrays) {
            break;
        }
    }
    return arrays;
}

export interface DerivedFieldPanelProps {
    /** Uncommitted expression text (widget-owned). */
    readonly expression: string;
    readonly onExpressionChange: (value: string) => void;
    readonly onApply: () => void;
    readonly onClear: () => void;
    /** False until a dataset is loaded. */
    readonly canApply: boolean;
    /** Normalized committed expression, if any. */
    readonly appliedExpression: string | undefined;
    readonly derivedActive: boolean;
    /** Panel error from the last rejected expression (never committed). */
    readonly error: string | undefined;
    readonly availableNames: readonly string[];
    /** Active color-by array resolved by the host (undefined = histogram empty state). */
    readonly histogram: ActiveHistogramSource | undefined;
    readonly binCount: number;
    readonly onBinCountChange: (value: number) => void;
    readonly logY: boolean;
    readonly onLogYChange: (value: boolean) => void;
    /** Model for the optional Statistics card (point/cell arrays). */
    readonly statisticsModel?: HistogramSourceModel;
    /** Active vector component used to reduce multi-component arrays. */
    readonly statisticsComponent?: number;
}

/** Format a stats scalar: integers stay short, the rest match the legend precision. */
function formatStats(value: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    return Number.isInteger(value) && Math.abs(value) < 1e6 ? String(value) : formatRangeValue(value);
}

function statsLine(stats: ArrayStats): string {
    const parts = [
        `min ${formatStats(stats.min)}`,
        `max ${formatStats(stats.max)}`,
        `mean ${formatStats(stats.mean)}`,
        `std ${formatStats(stats.std)}`,
        `${stats.finiteCount.toLocaleString()} values`
    ];
    if (stats.nonFiniteCount > 0) {
        parts.push(`${stats.nonFiniteCount.toLocaleString()} NaN/non-finite skipped`);
    }
    return parts.join(' · ');
}

/**
 * Calculator input + histogram readout. The histogram values travel on the
 * `histogram` prop (resolved by the host); this component only bins them.
 */
export function DerivedFieldPanel(props: DerivedFieldPanelProps): React.ReactElement {
    const [showStatistics, setShowStatistics] = React.useState(false);
    const statisticsArrays = React.useMemo(
        () => resolveStatisticsArrays(props.statisticsModel, props.statisticsComponent ?? -1),
        [props.statisticsModel, props.statisticsComponent]
    );
    const bins = normalizeHistogramBinCount(props.binCount);
    const stats = props.histogram ? computeArrayStats(props.histogram.values) : undefined;
    const histogram = props.histogram ? computeHistogram(props.histogram.values, bins) : undefined;
    const maxBin = histogram ? Math.max(0, ...histogram.bins) : 0;
    const scale = (count: number): number => {
        if (maxBin <= 0) {
            return 0;
        }
        return props.logY ? Math.log10(1 + count) / Math.log10(1 + maxBin) : count / maxBin;
    };
    const width = 280;
    const height = 120;
    const padLeft = 8;
    const padRight = 8;
    const padTop = 8;
    const padBottom = 20;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;
    const slot = histogram && histogram.binCount > 0 ? plotWidth / histogram.binCount : 0;
    return (
        <>
            <div className="openmc-output-viewer-card">
                <div className="openmc-output-viewer-card-title">Derived field (Calculator)</div>
                <div className="openmc-derived-field-note">
                    Grammar: <code>a/b</code>, <code>a-b</code>, <code>mag(v)</code>, <code>log10(a)</code> over dataset array names.
                    Divide-by-zero yields NaN (shown in the NaN color). Applying colors the 3D view by the transient field.
                </div>
                {props.availableNames.length > 0 && (
                    <div className="openmc-derived-field-note">Arrays: {props.availableNames.join(', ')}</div>
                )}
                <div className="openmc-output-viewer-control">
                    <input
                        type="text"
                        aria-label="Derived field expression"
                        placeholder="e.g. upper_g1/lower_g1"
                        value={props.expression}
                        onChange={(e) => props.onExpressionChange(e.target.value)}
                        disabled={!props.canApply}
                        style={{ flex: '1' }}
                    />
                    <button className="theia-button" onClick={props.onApply} disabled={!props.canApply}>
                        Apply
                    </button>
                    <button className="theia-button secondary" onClick={props.onClear} disabled={!props.derivedActive}>
                        Clear
                    </button>
                </div>
                {props.error && <div className="openmc-derived-field-error">{props.error}</div>}
                {props.appliedExpression && !props.error && (
                    <div className="openmc-derived-field-note">Coloring by derived field ‘{props.appliedExpression}’.</div>
                )}
            </div>
            <div className="openmc-output-viewer-card">
                <div className="openmc-output-viewer-card-title">Histogram{props.histogram ? ` — ${props.histogram.label}` : ''}</div>
                {!props.histogram || !stats || !histogram ? (
                    <div className="openmc-derived-field-note">
                        Color by a dataset array (Viewer Settings → Color by) to see its distribution.
                    </div>
                ) : (
                    <>
                        <div className="openmc-derived-field-note">{statsLine(stats)}</div>
                        <svg
                            className="openmc-histogram-svg"
                            viewBox={`0 0 ${width} ${height}`}
                            role="img"
                            aria-label={`Histogram of ${props.histogram.label}`}
                        >
                            {histogram.bins.map((count, index) => {
                                const barHeight = Math.max(count > 0 ? 1 : 0, Math.round(scale(count) * plotHeight));
                                const x = padLeft + index * slot + 0.5;
                                return (
                                    <rect
                                        key={index}
                                        x={x}
                                        y={padTop + plotHeight - barHeight}
                                        width={Math.max(1, slot - 1)}
                                        height={barHeight}
                                        className="openmc-histogram-bar"
                                    >
                                        <title>{`bin ${index + 1}: ${count.toLocaleString()}`}</title>
                                    </rect>
                                );
                            })}
                            <text x={padLeft} y={height - 6} className="openmc-histogram-axis">
                                {formatStats(histogram.min)}
                            </text>
                            <text x={width - padRight} y={height - 6} textAnchor="end" className="openmc-histogram-axis">
                                {formatStats(histogram.max)}
                            </text>
                            <text x={width - padRight} y={padTop + 8} textAnchor="end" className="openmc-histogram-axis">
                                max {maxBin.toLocaleString()}
                            </text>
                        </svg>
                        <div className="openmc-output-viewer-control">
                            <label className="openmc-output-viewer-control">
                                Bins
                                <input
                                    type="number"
                                    aria-label="Histogram bins"
                                    min={1}
                                    max={MAX_HISTOGRAM_BINS}
                                    value={props.binCount}
                                    onChange={(e) => props.onBinCountChange(parseInt(e.target.value, 10))}
                                />
                            </label>
                            <label className="openmc-output-viewer-control">
                                <input
                                    type="checkbox"
                                    aria-label="Logarithmic y axis"
                                    checked={props.logY}
                                    onChange={(e) => props.onLogYChange(e.target.checked)}
                                />
                                Log y
                            </label>
                        </div>
                    </>
                )}
            </div>
            {statisticsArrays.length >= 2 && (
                <div className="openmc-output-viewer-card">
                    <div className="openmc-output-viewer-card-title">Statistics</div>
                    {!showStatistics ? (
                        <div className="openmc-derived-field-note">
                            Compare distributions and correlations across the loaded arrays.
                            <button className="theia-button secondary openmc-statistics-open" onClick={() => setShowStatistics(true)}>
                                Show statistical plots
                            </button>
                        </div>
                    ) : (
                        <>
                            <div className="openmc-output-viewer-control">
                                <button className="theia-button secondary" onClick={() => setShowStatistics(false)}>
                                    Hide statistical plots
                                </button>
                            </div>
                            <div style={{ height: 340, minHeight: 0 }}>
                                <StatisticsPanel arrays={statisticsArrays} />
                            </div>
                        </>
                    )}
                </div>
            )}
        </>
    );
}
