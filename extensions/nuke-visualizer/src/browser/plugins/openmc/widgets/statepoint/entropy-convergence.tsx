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

import * as React from '@theia/core/shared/react';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { NukeEmptyState } from 'nuke-essentials/lib/theme/browser/components';
import { PlotlyComponent } from '../../../../plotly/plotly-component';
import { DomainStatepointIcon } from '../../../../widgets/domain-icons';
import { EntropyMode, EntropySource, buildEntropyChart, entropyLayout } from './entropy-convergence-model';

export interface EntropyConvergenceProps {
    source: EntropySource;
    onOpenSettings?: () => void;
}

function formatChange(change: number): string {
    const sign = change > 0 ? '+' : '';
    return `${sign}${change.toFixed(5)} bits`;
}

/** Entropy tab: convergence chart, inactive-batch marker, and trend summary. */
export const EntropyConvergence: React.FC<EntropyConvergenceProps> = ({ source, onOpenSettings }) => {
    const hasEntropy = (source.entropy?.length ?? 0) > 0;
    const hasCmfd = (source.cmfdEntropy?.length ?? 0) > 0;
    const [mode, setMode] = React.useState<EntropyMode>(hasEntropy ? 'entropy' : 'cmfd');

    React.useEffect(() => {
        if (mode === 'entropy' && !hasEntropy && hasCmfd) {
            setMode('cmfd');
        } else if (mode === 'cmfd' && !hasCmfd && hasEntropy) {
            setMode('entropy');
        }
    }, [hasEntropy, hasCmfd, mode]);

    if (!hasEntropy && !hasCmfd) {
        return (
            <div className="tab-content">
                <NukeEmptyState
                    iconNode={<DomainStatepointIcon />}
                    title="No entropy mesh in this statepoint"
                    message="Shannon entropy is written only when the simulation has an entropy mesh and runs in eigenvalue mode. This statepoint contains neither the entropy history nor a CMFD entropy history."
                    hint="In OpenMC Studio, open Simulation → Convergence, enable the entropy mesh, and rerun the model."
                >
                    {onOpenSettings && (
                        <button className="theia-button" onClick={onOpenSettings}>
                            <i className={codicon('settings-gear')}></i>
                            Open Simulation Dashboard
                        </button>
                    )}
                </NukeEmptyState>
            </div>
        );
    }

    const chart = buildEntropyChart(source, mode);
    const summary = chart.summary;
    const gridColor = getComputedStyle(document.body).getPropertyValue('--theia-panel-border').trim() || '#3c3c3c';
    const foreground = getComputedStyle(document.body).getPropertyValue('--theia-foreground').trim() || '#cccccc';
    const background = getComputedStyle(document.body).getPropertyValue('--theia-editor-background').trim() || '#1e1e1e';
    const layout: any = {
        ...entropyLayout(),
        paper_bgcolor: background,
        plot_bgcolor: background,
        xaxis: {
            ...(entropyLayout().xaxis as object),
            gridcolor: gridColor,
            tickfont: { color: foreground },
            title: { text: 'Batch', font: { color: foreground } }
        },
        yaxis: {
            ...(entropyLayout().yaxis as object),
            gridcolor: gridColor,
            tickfont: { color: foreground },
            title: { text: 'Shannon entropy (bits)', font: { color: foreground } }
        },
        shapes: chart.shapes,
        annotations:
            chart.markerBatch !== null
                ? [
                      {
                          x: chart.markerBatch,
                          y: 1,
                          yref: 'paper',
                          text: 'Active batches',
                          showarrow: false,
                          xanchor: 'left',
                          yanchor: 'bottom',
                          font: { size: 10, color: foreground }
                      }
                  ]
                : []
    };

    return (
        <div className="tab-content entropy-tab">
            <div className="entropy-toolbar">
                <div className="entropy-mode-toggle" role="group" aria-label="Entropy source">
                    {hasEntropy && (
                        <button
                            className={`entropy-mode ${mode === 'entropy' ? 'active' : ''}`}
                            aria-pressed={mode === 'entropy'}
                            onClick={() => setMode('entropy')}
                        >
                            <i className={codicon('graph-line')}></i>
                            Shannon entropy
                        </button>
                    )}
                    {hasCmfd && (
                        <button
                            className={`entropy-mode ${mode === 'cmfd' ? 'active' : ''}`}
                            aria-pressed={mode === 'cmfd'}
                            onClick={() => setMode('cmfd')}
                        >
                            <i className={codicon('symbol-parameter')}></i>
                            CMFD entropy
                        </button>
                    )}
                </div>
                {chart.markerBatch !== null && (
                    <span className="entropy-marker-note">
                        <i className={codicon('debug-breakpoint-log')}></i>
                        Active batches start after batch {source.nInactive} · {source.nBatches} total
                    </span>
                )}
            </div>

            {summary && (
                <div className="entropy-summary">
                    <div className="entropy-summary-card">
                        <span className="entropy-summary-label">Final entropy</span>
                        <strong>{summary.finalEntropy.toFixed(5)} bits</strong>
                    </div>
                    <div className="entropy-summary-card">
                        <span className="entropy-summary-label">Change over last {summary.windowSize} batches</span>
                        <strong className={summary.stable ? 'stable' : 'changing'}>{formatChange(summary.change)}</strong>
                    </div>
                    <div className={`entropy-summary-card entropy-summary-hint ${summary.stable ? 'stable' : 'changing'}`}>
                        <i className={codicon(summary.stable ? 'pass' : 'warning')}></i>
                        <span>{summary.hint}</span>
                    </div>
                </div>
            )}

            <div className="entropy-chart">
                {chart.traces.length > 0 ? (
                    <PlotlyComponent data={chart.traces} layout={layout} config={{ responsive: true, displayModeBar: false }} />
                ) : (
                    <NukeEmptyState
                        title={`No ${mode === 'cmfd' ? 'CMFD ' : ''}entropy history`}
                        message="The selected convergence source has no batches in this statepoint."
                    />
                )}
            </div>
            <p className="entropy-caveat">
                Shannon entropy is a fission-source convergence diagnostic, not a tally convergence test. Use it with k-effective and tally
                statistics.
            </p>
        </div>
    );
};
