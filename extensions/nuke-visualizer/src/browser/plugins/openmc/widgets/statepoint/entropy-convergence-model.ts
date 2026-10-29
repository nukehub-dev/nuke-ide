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

export type EntropyMode = 'entropy' | 'cmfd';

export interface EntropyChartTrace {
    x: number[];
    y: number[];
    type: 'scatter';
    mode: 'lines+markers';
    name: string;
    line: { color: string; width: number };
    marker: { size: number; color: string };
    hovertemplate: string;
}

export interface EntropyChartShape {
    type: 'line';
    x0: number;
    x1: number;
    y0: number;
    y1: number;
    yref: 'paper';
    line: { color: string; width: number; dash: 'dot' };
}

export interface EntropySeriesSummary {
    /** Final entropy value [bits]. */
    finalEntropy: number;
    /** Change over the last `windowSize` active batches [bits]. */
    change: number;
    /** Number of active batches in the comparison window. */
    windowSize: number;
    /** Whether the trend is flat enough to suggest a converged source. */
    stable: boolean;
    /** Human-readable trend hint. */
    hint: string;
}

export interface EntropyChartData {
    traces: EntropyChartTrace[];
    shapes: EntropyChartShape[];
    /** 1-based batch used for the inactive/active boundary marker. */
    markerBatch: number | null;
    summary: EntropySeriesSummary | null;
}

export interface EntropySource {
    entropy?: number[];
    cmfdEntropy?: number[];
    cmfdEntropyStartBatch?: number;
    nInactive: number;
    nBatches: number;
}

const ENTROPY_COLOR = '#4da3ff';
const CMFD_COLOR = '#c586ff';
const WARNING_COLOR = '#d9a441';

/** Active-batch slice; entropy is accumulated over every batch. */
export function activeEntropy(values: number[], nInactive: number): number[] {
    if (!Number.isFinite(nInactive) || nInactive <= 0) {
        return values;
    }
    return values.slice(Math.min(Math.floor(nInactive), values.length));
}

/**
 * Summarize the trend over the last few active batches. Entropy is a
 * qualitative convergence signal, so the UI labels this a trend hint rather
 * than declaring the simulation converged.
 */
export function summarizeEntropy(values: number[], nInactive: number): EntropySeriesSummary | null {
    if (values.length === 0) {
        return null;
    }
    const active = activeEntropy(values, nInactive);
    const series = active.length >= 2 ? active : values;
    const finalEntropy = series[series.length - 1];
    const windowSize = Math.min(20, series.length - 1);
    if (windowSize < 1) {
        return {
            finalEntropy,
            change: 0,
            windowSize: series.length,
            stable: true,
            hint: 'Only one batch is available; extend the run to judge convergence.'
        };
    }
    const start = series[series.length - 1 - windowSize];
    const change = finalEntropy - start;
    const scale = Math.max(Math.abs(finalEntropy), 1);
    const stable = Math.abs(change) <= Math.max(0.01, 0.002 * scale);
    return {
        finalEntropy,
        change,
        windowSize,
        stable,
        hint: stable
            ? `Entropy is stable over the last ${windowSize} active batches; confirm with k-effective and tally statistics.`
            : `Entropy is still changing over the last ${windowSize} active batches; add inactive batches or review the entropy mesh.`
    };
}

/** Build Plotly traces for the selected entropy source. */
export function buildEntropyChart(source: EntropySource, mode: EntropyMode): EntropyChartData {
    const values = mode === 'cmfd' ? (source.cmfdEntropy ?? []) : (source.entropy ?? []);
    const startBatch = mode === 'cmfd' ? Math.max(1, Math.floor(source.cmfdEntropyStartBatch ?? source.nInactive + 1)) : 1;
    const x = values.map((_, index) => startBatch + index);
    const markerBatch = source.nInactive > 0 ? source.nInactive + 0.5 : null;
    const color = mode === 'cmfd' ? CMFD_COLOR : ENTROPY_COLOR;
    const label = mode === 'cmfd' ? 'CMFD entropy' : 'Shannon entropy';

    return {
        traces: values.length
            ? [
                  {
                      x,
                      y: values,
                      type: 'scatter',
                      mode: 'lines+markers',
                      name: label,
                      line: { color, width: 2 },
                      marker: { size: 4, color },
                      hovertemplate: `${label}<br>Batch %{x}<br>%{y:.5f} bits<extra></extra>`
                  }
              ]
            : [],
        shapes:
            markerBatch === null
                ? []
                : [
                      {
                          type: 'line',
                          x0: markerBatch,
                          x1: markerBatch,
                          y0: 0,
                          y1: 1,
                          yref: 'paper',
                          line: { color: WARNING_COLOR, width: 1.5, dash: 'dot' }
                      }
                  ],
        markerBatch,
        summary: summarizeEntropy(values, source.nInactive)
    };
}

/** Chart layout shared by the entropy tab (units in axis labels). */
export function entropyLayout(): Record<string, unknown> {
    return {
        xaxis: {
            title: { text: 'Batch' },
            gridcolor: 'var(--theia-panel-border)',
            zeroline: false
        },
        yaxis: {
            title: { text: 'Shannon entropy (bits)' },
            gridcolor: 'var(--theia-panel-border)',
            zeroline: false
        },
        margin: { t: 24, r: 24, b: 48, l: 64 },
        hovermode: 'closest',
        showlegend: false
    };
}
