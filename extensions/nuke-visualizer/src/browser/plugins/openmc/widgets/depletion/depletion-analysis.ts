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

import {
    DepletionDoseQuantity,
    DepletionPlotType,
    DepletionXAxis,
    OpenMCDepletionContactDoseResult,
    OpenMCDepletionDecaySpectrumResult,
    OpenMCDepletionSummary
} from '../../../../../common/openmc-protocol';

export const CONTACT_DOSE_PLOTS: DepletionPlotType[] = ['contact_dose_air', 'contact_dose_effective'];
export const SPECTRUM_PLOT: DepletionPlotType = 'decay_spectrum';

export const DEPLETION_PLOT_OPTIONS: Array<{ value: DepletionPlotType; label: string }> = [
    { value: 'concentration', label: 'Concentration (atoms/barn-cm)' },
    { value: 'mass', label: 'Mass (g)' },
    { value: 'normalized', label: 'Normalized (% of initial)' },
    { value: 'stacked', label: 'Stacked composition (%)' },
    { value: 'activity', label: 'Activity (Ci)' },
    { value: 'decay_heat', label: 'Decay heat (W)' },
    { value: 'contact_dose_air', label: 'Contact dose rate (absorbed-air, Gy/h)' },
    { value: 'contact_dose_effective', label: 'Contact dose rate (effective, Sv/h)' },
    { value: 'decay_spectrum', label: 'Decay photon spectrum' }
];

export function isContactDosePlot(plotType: DepletionPlotType): boolean {
    return CONTACT_DOSE_PLOTS.includes(plotType);
}

export function isSpectrumPlot(plotType: DepletionPlotType): boolean {
    return plotType === SPECTRUM_PLOT;
}

export function doseQuantityForPlot(plotType: DepletionPlotType): DepletionDoseQuantity {
    return plotType === 'contact_dose_effective' ? 'effective' : 'absorbed-air';
}

/** Default y-scale: spectra use log; every other chart starts linear. */
export function defaultScaleForPlot(plotType: DepletionPlotType): 'linear' | 'log' {
    return isSpectrumPlot(plotType) ? 'log' : 'linear';
}

/** Human-readable label for one depletion time step (units in the label). */
export function stepLabel(timeDays: number | undefined, index: number): string {
    if (timeDays === undefined || !Number.isFinite(timeDays)) {
        return `Step ${index}`;
    }
    return `Step ${index} · ${formatCompact(timeDays)} d`;
}

export function formatCompact(value: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const abs = Math.abs(value);
    if (abs !== 0 && (abs < 0.01 || abs >= 1e5)) {
        return value.toExponential(2);
    }
    return value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}

/** Dose rate with unit, suitable for tables and summary cards. */
export function formatDoseRate(value: number, unit: string): string {
    return `${formatCompact(value)} ${unit}`;
}

const ACTIVITY_UNITS = ['Bq', 'kBq', 'MBq', 'GBq', 'TBq', 'PBq', 'EBq'];

/** Activity with an SI prefix (Bq by default). */
export function formatActivityBq(value: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    let scaled = Math.abs(value);
    let unit = 0;
    while (scaled >= 1000 && unit < ACTIVITY_UNITS.length - 1) {
        scaled /= 1000;
        unit += 1;
    }
    const sign = value < 0 ? '-' : '';
    return `${sign}${scaled.toLocaleString(undefined, { maximumSignificantDigits: 4 })} ${ACTIVITY_UNITS[unit]}`;
}

/** Chart x-axis values for a contact-dose series. */
export function contactDoseX(
    result: OpenMCDepletionContactDoseResult,
    summary: OpenMCDepletionSummary | null,
    axis: DepletionXAxis
): { values: number[]; label: string } {
    if (axis === 'step') {
        return { values: result.total.map((_, index) => index), label: 'Time step' };
    }
    if (axis === 'burnup' && summary?.burnup?.length) {
        return { values: summary.burnup.slice(0, result.total.length), label: 'Burnup (MWd/kg)' };
    }
    return { values: result.timeDays, label: 'Time (days)' };
}

export interface ContactDoseChart {
    traces: Array<Record<string, unknown>>;
    xLabel: string;
    yLabel: string;
}

/** Plotly trace for the total contact dose rate (unit in the y-axis label). */
export function buildContactDoseChart(
    result: OpenMCDepletionContactDoseResult,
    summary: OpenMCDepletionSummary | null,
    axis: DepletionXAxis
): ContactDoseChart {
    const x = contactDoseX(result, summary, axis);
    return {
        traces: [
            {
                x: x.values,
                y: result.total,
                type: 'scatter',
                mode: 'lines+markers',
                name: `Contact dose rate (${result.unit})`,
                line: { color: '#d96a4a', width: 2 },
                marker: { size: 5 },
                hovertemplate: `%{x}<br>%{y:.6g} ${result.unit}<extra></extra>`
            }
        ],
        xLabel: x.label,
        yLabel: `Contact dose rate (${result.unit})`
    };
}

/** True when at least one state has a non-zero contact dose rate. */
export function contactDoseHasSignal(result: OpenMCDepletionContactDoseResult | null): boolean {
    return !!result && result.total.some((value) => Number.isFinite(value) && value > 0);
}

export interface ContactDoseNuclideRow {
    nuclide: string;
    final: number;
    max: number;
}

/** Per-nuclide rows sorted by the final-state contribution. */
export function contactDoseNuclideRows(result: OpenMCDepletionContactDoseResult | null, limit = 25): ContactDoseNuclideRow[] {
    if (!result?.byNuclide) {
        return [];
    }
    return result.byNuclide
        .map((row) => ({
            nuclide: row.nuclide,
            final: row.values[row.values.length - 1] ?? 0,
            max: row.values.reduce((max, value) => Math.max(max, value), 0)
        }))
        .filter((row) => row.max > 0)
        .sort((a, b) => b.final - a.final)
        .slice(0, limit);
}

export interface DecaySpectrumChart {
    traces: Array<Record<string, unknown>>;
    yLabel: string;
    /** Total-activity label for the legend/caption. */
    activityLabel: string;
}

/** Plotly traces for decay-photon lines and continuous components (energy in MeV). */
export function buildDecaySpectrumChart(result: OpenMCDepletionDecaySpectrumResult): DecaySpectrumChart {
    const traces: Array<Record<string, unknown>> = [];
    const activityLabel = `Total activity ${formatActivityBq(result.totalActivityBq)}`;
    if (result.lines.length > 0) {
        traces.push({
            x: result.lines.map((line) => line.energyEv / 1e6),
            y: result.lines.map((line) => line.intensity),
            type: 'scatter',
            mode: 'lines+markers',
            name: `Discrete lines — ${activityLabel}`,
            line: { color: '#4da3ff', width: 1 },
            marker: { size: 3 },
            hovertemplate: `%{x:.6f} MeV<br>%{y:.4g} photons/s<extra></extra>`
        });
    }
    result.curves.forEach((curve, index) => {
        traces.push({
            x: curve.energyEv.map((energy) => energy / 1e6),
            y: curve.intensityPerEv,
            type: 'scatter',
            mode: 'lines',
            name: result.curves.length > 1 ? `Continuous component ${index + 1}` : 'Continuous component',
            line: { color: '#c586ff', width: 1.5 },
            hovertemplate: `%{x:.6f} MeV<br>%{y:.4g} photons s⁻¹ eV⁻¹<extra></extra>`
        });
    });
    return {
        traces,
        yLabel: result.curves.length > 0 ? 'Intensity (photons s⁻¹, lines; photons s⁻¹ eV⁻¹, curves)' : 'Intensity (photons s⁻¹)',
        activityLabel
    };
}

/** CSV for the current decay spectrum (units carried per row). */
export function decaySpectrumToCsv(result: OpenMCDepletionDecaySpectrumResult): string {
    const header = ['material', 'time_index', 'time_days', 'energy_MeV', 'value', 'unit', 'component'];
    const rows: string[][] = [];
    const material = result.materialName ?? '';
    for (const line of result.lines) {
        rows.push([
            material,
            String(result.timeIndex),
            String(result.timeDays),
            (line.energyEv / 1e6).toPrecision(8),
            line.intensity.toPrecision(8),
            'photons/s',
            'discrete'
        ]);
    }
    result.curves.forEach((curve, index) => {
        for (let i = 0; i < curve.energyEv.length; i += 1) {
            rows.push([
                material,
                String(result.timeIndex),
                String(result.timeDays),
                (curve.energyEv[i] / 1e6).toPrecision(8),
                curve.intensityPerEv[i].toPrecision(8),
                'photons/s/eV',
                `continuous-${index + 1}`
            ]);
        }
    });
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function csvCell(value: string): string {
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Contact-dose table CSV (final value plus every state). */
export function contactDoseToCsv(result: OpenMCDepletionContactDoseResult): string {
    const header = ['nuclide', ...result.timeDays.map((day) => `t=${day} d`)];
    const rows = (result.byNuclide ?? []).map((row) => [row.nuclide, ...row.values.map((value) => value.toPrecision(8))]);
    return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}
