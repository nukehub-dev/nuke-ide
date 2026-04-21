// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { OpenMCSpectrumData, OpenMCSpatialPlotData } from '../../common/openmc-protocol';

/** Container for multiple OpenMC scores to be plotted on same axis */
export interface OpenMCMultiScoreData {
    energy_bins?: number[];
    positions?: number[];
    scores: {
        name: string;
        values: number[];
        std_dev?: number[];
    }[];
}

export namespace PlotlyUtils {
    /**
     * Converts OpenMC spectrum data to a single Plotly trace.
     */
    export function createSpectrumTrace(data: OpenMCSpectrumData, name: string = 'Spectrum'): Partial<Plotly.Data> {
        const { energy_bins, values, std_dev } = data;
        const x: number[] = [];
        const y: number[] = [];
        const errors: number[] = [];
        const customData: string[] = [];

        for (let i = 0; i < values.length; i++) {
            const mid = (energy_bins[i] + energy_bins[i + 1]) / 2;
            x.push(mid);
            y.push(values[i]);
            
            let relErrStr = 'N/A';
            if (std_dev && std_dev[i] !== undefined) {
                errors.push(std_dev[i]);
                if (values[i] !== 0) {
                    relErrStr = (std_dev[i] / values[i] * 100).toFixed(2) + '%';
                }
            }
            customData.push(relErrStr);
        }

        const trace: Partial<Plotly.Data> = {
            x,
            y,
            customdata: customData,
            type: 'scatter',
            mode: 'lines+markers',
            line: { shape: 'hvh', width: 2 },
            name: name,
            hovertemplate: `<b>${name}</b><br>` +
                           `Energy: %{x:.2e} eV<br>` +
                           `Value: %{y:.4e}<br>` +
                           `Rel. Error: %{customdata}<extra></extra>`
        };

        if (errors.length > 0) {
            trace.error_y = {
                type: 'data',
                array: errors,
                visible: true,
                thickness: 1,
                width: 0
            };
        }

        return trace;
    }

    /**
     * Converts OpenMC spectrum data to Plotly traces.
     */
    export function createSpectrumTraces(data: OpenMCSpectrumData): Partial<Plotly.Data>[] {
        return [createSpectrumTrace(data)];
    }

    /**
     * Converts multi-score spectrum data to Plotly traces.
     */
    export function createMultiScoreTraces(data: OpenMCMultiScoreData, type: 'spectrum' | 'spatial'): Partial<Plotly.Data>[] {
        return data.scores.map(score => {
            if (type === 'spectrum' && data.energy_bins) {
                return createSpectrumTrace({
                    energy_bins: data.energy_bins,
                    values: score.values,
                    std_dev: score.std_dev || []
                }, score.name);
            } else if (type === 'spatial' && data.positions) {
                return createSpatialTrace({
                    positions: data.positions,
                    values: score.values,
                    std_dev: score.std_dev || [],
                    axis: 'z' // dummy
                }, score.name);
            }
            return {};
        });
    }

    /**
     * Converts OpenMC spatial plot data to a single Plotly trace.
     */
    export function createSpatialTrace(data: OpenMCSpatialPlotData, name: string = 'Spatial Distribution'): Partial<Plotly.Data> {
        const { positions, values, std_dev } = data;
        const customData: string[] = [];

        if (std_dev) {
            for (let i = 0; i < values.length; i++) {
                if (values[i] !== 0) {
                    customData.push((std_dev[i] / values[i] * 100).toFixed(2) + '%');
                } else {
                    customData.push('0.00%');
                }
            }
        }

        const trace: Partial<Plotly.Data> = {
            x: positions,
            y: values,
            customdata: customData,
            type: 'scatter',
            mode: 'lines+markers',
            name: name,
            line: { width: 2 },
            marker: { size: 6 },
            hovertemplate: `<b>${name}</b><br>` +
                           `Position: %{x:.2f} cm<br>` +
                           `Value: %{y:.4e}<br>` +
                           (std_dev ? `Rel. Error: %{customdata}<extra></extra>` : `<extra></extra>`)
        };

        if (std_dev && std_dev.length > 0) {
            trace.error_y = {
                type: 'data',
                array: std_dev,
                visible: true,
                thickness: 1,
                width: 2
            };
        }

        return trace;
    }

    /**
     * Converts OpenMC spatial plot data to Plotly traces.
     */
    export function createSpatialTraces(data: OpenMCSpatialPlotData): Partial<Plotly.Data>[] {
        return [createSpatialTrace(data)];
    }
}
