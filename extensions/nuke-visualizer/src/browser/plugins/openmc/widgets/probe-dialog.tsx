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
 * Props-only Probe dialog: point sampling history plus the line/profile
 * builder for file-backed native viewers.
 *
 * No Theia DI, no store, no global state. The host owns canvas picking,
 * dataset mutation, `base.probe` runs, and CSV delivery; this card only edits
 * transient form state and renders the arrays/samples/results handed to it.
 * The point table assumes the host stores samples latest-first (the viewer
 * prepends each click and caps the history at 100).
 */

import * as React from 'react';
import type * as Plotly from 'plotly.js-dist-min';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { NukeSelect, Tooltip, type NukeSelectOption } from 'nuke-essentials/lib/theme/browser/components';
import {
    PROBE_DEFAULT_SAMPLES,
    PROBE_MAX_SAMPLES,
    PROBE_MIN_SAMPLES,
    PROBE_SAMPLE_ROW_CAP,
    clampProbeSamples,
    defaultProbeEndpoints,
    formatProbePoint,
    formatProbeValue,
    parseProbePoint,
    type ProbeArrayOption,
    type ProbeAssociation,
    type ProbeLineResult,
    type ProbeSample
} from '../../../viewer-core/probe-model';
import { PlotlyComponent } from '../../../plotly/plotly-component';
import './probe-dialog.css';

/** Host contract for the Probe dialog. */
export interface ProbeDialogProps {
    /** Point/cell arrays the line profile can sample. */
    readonly arrays: readonly ProbeArrayOption[];
    /** Active viewer array, used to seed the line-tab select. */
    readonly defaultArray?: { association: ProbeAssociation; name: string };
    /** Dataset bounds for the default profile endpoints. */
    readonly bounds?: { min: readonly [number, number, number]; max: readonly [number, number, number] };
    /** Point-probe history, latest first. */
    readonly samples: readonly ProbeSample[];
    /** Point picking is armed on the canvas. */
    readonly picking: boolean;
    /** The viewer has a file URI, so `base.probe` can run. */
    readonly canProfile: boolean;
    readonly profileRunning: boolean;
    readonly profileError?: string;
    readonly profileResult?: ProbeLineResult;
    readonly onTogglePick: () => void;
    readonly onClearSamples: () => void;
    readonly onExportSamples: () => void;
    readonly onRunProfile: (request: { association: ProbeAssociation; name: string; p0: string; p1: string; samples: number }) => void;
    readonly onExportProfile: () => void;
    readonly onClose: () => void;
}

type ProbeTab = 'point' | 'line';

const PROFILE_PLOT_CONFIG: Partial<Plotly.Config> = {
    displayModeBar: false
};

function associationLabel(association: ProbeAssociation): string {
    return association === 'point' ? 'Point' : 'Cell';
}

function arrayOptionLabel(array: ProbeArrayOption): string {
    const base = `${associationLabel(array.association)}: ${array.name}`;
    return array.components > 1 ? `${base} (${array.components} components)` : base;
}

/** Numeric cell value or null for missing/non-finite entries. */
function finiteOrNull(value: number | null | undefined): number | null {
    return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function detectPlotlyTheme(): 'dark' | 'light' {
    if (typeof document === 'undefined' || !document.body) {
        return 'dark';
    }
    const classes = document.body.classList;
    return classes.contains('theia-light') || classes.contains('theia-hcLight') ? 'light' : 'dark';
}

/** Follow Theia's body theme class without injecting ThemeService. */
function usePlotlyTheme(): 'dark' | 'light' {
    const [theme, setTheme] = React.useState<'dark' | 'light'>(detectPlotlyTheme);
    React.useEffect(() => {
        if (typeof document === 'undefined' || !document.body) {
            return;
        }
        const observer = new MutationObserver(() => setTheme(detectPlotlyTheme()));
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);
    return theme;
}

export const ProbeDialog: React.FC<ProbeDialogProps> = ({
    arrays,
    defaultArray,
    bounds,
    samples,
    picking,
    canProfile,
    profileRunning,
    profileError,
    profileResult,
    onTogglePick,
    onClearSamples,
    onExportSamples,
    onRunProfile,
    onExportProfile,
    onClose
}) => {
    const [tab, setTab] = React.useState<ProbeTab>('point');
    const [selectedIndex, setSelectedIndex] = React.useState<number | undefined>(undefined);
    const [p0, setP0] = React.useState(() => formatProbePoint(defaultProbeEndpoints(bounds).p0));
    const [p1, setP1] = React.useState(() => formatProbePoint(defaultProbeEndpoints(bounds).p1));
    const [sampleCountText, setSampleCountText] = React.useState(String(PROBE_DEFAULT_SAMPLES));
    const [endpointError, setEndpointError] = React.useState<string | undefined>(undefined);
    const theme = usePlotlyTheme();

    const defaultIndex = defaultArray
        ? arrays.findIndex((array) => array.association === defaultArray.association && array.name === defaultArray.name)
        : -1;
    const activeIndex =
        selectedIndex !== undefined && selectedIndex >= 0 && selectedIndex < arrays.length
            ? selectedIndex
            : defaultIndex >= 0
              ? defaultIndex
              : arrays.length > 0
                ? 0
                : -1;
    const activeArray = activeIndex >= 0 ? arrays[activeIndex] : undefined;

    const arrayOptions = React.useMemo<NukeSelectOption[]>(
        () => arrays.map((array, index) => ({ value: String(index), label: arrayOptionLabel(array) })),
        [arrays]
    );

    // Reset endpoints only when the numeric bounds or the selected array truly
    // change: comparing a signature keeps a fresh-but-equal `bounds` object or
    // an unrelated host re-render from overwriting what the user typed.
    const boundsSignature = bounds === undefined ? 'none' : [...bounds.min, ...bounds.max].join(',');
    const arraySignature = activeArray === undefined ? 'none' : `${activeArray.association}\u0000${activeArray.name}`;
    const endpointKey = `${boundsSignature}|${arraySignature}`;
    const endpointKeyRef = React.useRef(endpointKey);
    React.useEffect(() => {
        if (endpointKeyRef.current === endpointKey) {
            return;
        }
        endpointKeyRef.current = endpointKey;
        const endpoints = defaultProbeEndpoints(bounds);
        setP0(formatProbePoint(endpoints.p0));
        setP1(formatProbePoint(endpoints.p1));
        setEndpointError(undefined);
    }, [endpointKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const visibleSamples = samples.slice(0, PROBE_SAMPLE_ROW_CAP);
    const profileSeries = profileResult?.series ?? [];
    const visibleProfile = profileSeries.slice(0, PROBE_SAMPLE_ROW_CAP);
    const errorText = endpointError ?? profileError;
    const hasError = errorText !== undefined && errorText !== '';

    const chartData = React.useMemo<Partial<Plotly.Data>[]>(() => {
        if (profileResult === undefined) {
            return [];
        }
        return [
            {
                type: 'scatter',
                mode: 'lines',
                name: profileResult.array,
                x: profileResult.series.map((point) => point.distance),
                y: profileResult.series.map((point) => finiteOrNull(point.valid ? point.value : null)),
                connectgaps: false,
                line: { color: '#4fc3f7', width: 2 },
                hovertemplate: 'Distance: %{x:.4g}<br>Value: %{y:.4g}<extra></extra>'
            }
        ];
    }, [profileResult]);

    const chartLayout = React.useMemo<Partial<Plotly.Layout>>(
        () => ({
            showlegend: false,
            hovermode: 'closest',
            margin: { l: 56, r: 16, t: 12, b: 44 },
            xaxis: { title: { text: 'Distance' } },
            yaxis: { title: { text: profileResult?.array ?? 'Value' } }
        }),
        [profileResult]
    );

    const runProfile = (): void => {
        if (!canProfile || profileRunning || activeArray === undefined) {
            return;
        }
        if (parseProbePoint(p0) === undefined || parseProbePoint(p1) === undefined) {
            setEndpointError('Enter endpoints as "x, y, z".');
            return;
        }
        const sampleCount = clampProbeSamples(Number(sampleCountText));
        setSampleCountText(String(sampleCount));
        setEndpointError(undefined);
        onRunProfile({
            association: activeArray.association,
            name: activeArray.name,
            p0,
            p1,
            samples: sampleCount
        });
    };

    return (
        <div className="probe-dialog" role="dialog" aria-label="Probe">
            <div className="probe-dialog-title">
                <span className={codicon('pulse')} aria-hidden="true" />
                <span className="probe-title-text">Probe</span>
                <Tooltip content="Close probe" position="left">
                    <button type="button" className="probe-close" aria-label="Close probe" onClick={onClose}>
                        <span className={codicon('close')} aria-hidden="true" />
                    </button>
                </Tooltip>
            </div>
            <div className="probe-tabs" role="tablist" aria-label="Probe mode">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'point'}
                    className={`probe-tab probe-tab-point${tab === 'point' ? ' active' : ''}`}
                    onClick={() => setTab('point')}
                >
                    Point
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'line'}
                    className={`probe-tab probe-tab-line${tab === 'line' ? ' active' : ''}`}
                    onClick={() => setTab('line')}
                >
                    Line
                </button>
            </div>
            <div className="probe-body">
                {tab === 'point' ? (
                    <div className="probe-section probe-point" role="tabpanel" aria-label="Point probe">
                        <div className="probe-pick-row">
                            <button
                                type="button"
                                className={`theia-button secondary probe-pick-toggle${picking ? ' active' : ''}`}
                                aria-pressed={picking}
                                onClick={onTogglePick}
                            >
                                <span className={codicon('pulse')} aria-hidden="true" />
                                Pick points
                            </button>
                            <span className="probe-hint">Click the canvas to sample the active array</span>
                        </div>
                        {samples.length === 0 ? (
                            <div className="probe-empty">No points sampled yet.</div>
                        ) : (
                            <>
                                <div className="probe-table-wrap">
                                    <table className="probe-sample-table">
                                        <thead>
                                            <tr>
                                                <th>X</th>
                                                <th>Y</th>
                                                <th>Z</th>
                                                <th>Array</th>
                                                <th>Value</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {visibleSamples.map((sample, index) => {
                                                const value = finiteOrNull(sample.value);
                                                return (
                                                    <tr key={index}>
                                                        <td>{formatProbeValue(sample.position[0])}</td>
                                                        <td>{formatProbeValue(sample.position[1])}</td>
                                                        <td>{formatProbeValue(sample.position[2])}</td>
                                                        <td
                                                            className="probe-sample-array"
                                                            title={
                                                                sample.association !== undefined
                                                                    ? `${associationLabel(sample.association)} array`
                                                                    : undefined
                                                            }
                                                        >
                                                            {sample.array ?? '—'}
                                                        </td>
                                                        <td>{value === null ? '' : formatProbeValue(value)}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                                {samples.length > visibleSamples.length && (
                                    <div className="probe-row-note">
                                        Showing {visibleSamples.length} of {samples.length} samples — Export CSV downloads the full history.
                                    </div>
                                )}
                            </>
                        )}
                        <div className="probe-actions">
                            <button
                                type="button"
                                className="theia-button secondary probe-clear"
                                onClick={onClearSamples}
                                disabled={samples.length === 0}
                            >
                                Clear
                            </button>
                            <button
                                type="button"
                                className="theia-button secondary probe-export"
                                onClick={onExportSamples}
                                disabled={samples.length === 0}
                            >
                                Export CSV
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="probe-section probe-line" role="tabpanel" aria-label="Line profile">
                        {!canProfile && (
                            <div className="probe-profile-hint">
                                Line profiles need a file-backed viewer. Converted tally tabs keep the tally line probe.
                            </div>
                        )}
                        <div className="probe-field">
                            <span className="probe-label">Array</span>
                            <NukeSelect
                                className="probe-array"
                                ariaLabel="Probe array"
                                placeholder="No arrays"
                                value={activeIndex >= 0 ? String(activeIndex) : ''}
                                options={arrayOptions}
                                onChange={(value) => setSelectedIndex(Number(value))}
                                disabled={!canProfile || arrayOptions.length === 0}
                            />
                        </div>
                        <div className="probe-field-row">
                            <label className="probe-field">
                                <span className="probe-label">P0</span>
                                <input
                                    type="text"
                                    className="probe-p0"
                                    placeholder="x, y, z"
                                    value={p0}
                                    onChange={(event) => {
                                        setP0(event.target.value);
                                        setEndpointError(undefined);
                                    }}
                                    disabled={!canProfile}
                                    spellCheck={false}
                                    autoComplete="off"
                                />
                            </label>
                            <label className="probe-field">
                                <span className="probe-label">P1</span>
                                <input
                                    type="text"
                                    className="probe-p1"
                                    placeholder="x, y, z"
                                    value={p1}
                                    onChange={(event) => {
                                        setP1(event.target.value);
                                        setEndpointError(undefined);
                                    }}
                                    disabled={!canProfile}
                                    spellCheck={false}
                                    autoComplete="off"
                                />
                            </label>
                        </div>
                        <div className="probe-field-row">
                            <label className="probe-field probe-samples-field">
                                <span className="probe-label">Samples</span>
                                <input
                                    type="number"
                                    className="probe-samples"
                                    min={PROBE_MIN_SAMPLES}
                                    max={PROBE_MAX_SAMPLES}
                                    step={1}
                                    value={sampleCountText}
                                    onChange={(event) => setSampleCountText(event.target.value)}
                                    disabled={!canProfile || profileRunning}
                                />
                            </label>
                            <button
                                type="button"
                                className="theia-button probe-run"
                                onClick={runProfile}
                                disabled={!canProfile || profileRunning || activeArray === undefined}
                            >
                                {profileRunning ? (
                                    <>
                                        <span className={`${codicon('loading')} codicon-modifier-spin`} aria-hidden="true" />
                                        Running…
                                    </>
                                ) : (
                                    'Run profile'
                                )}
                            </button>
                        </div>
                        {hasError && (
                            <div className="probe-profile-error" role="alert">
                                <span className={codicon('warning')} aria-hidden="true" />
                                <span>{errorText}</span>
                            </div>
                        )}
                        {profileResult !== undefined && (
                            <div className="probe-profile-result">
                                <div className="probe-profile-header">
                                    <span className="probe-profile-summary">
                                        {profileSeries.length.toLocaleString()} samples
                                        {profileResult.length !== undefined ? ` · 0–${formatProbeValue(profileResult.length)}` : ''}
                                        {` · ${associationLabel(profileResult.association)}: ${profileResult.array}`}
                                    </span>
                                    <button
                                        type="button"
                                        className="theia-button secondary probe-profile-export"
                                        onClick={onExportProfile}
                                        disabled={!canProfile || profileSeries.length === 0}
                                    >
                                        Export CSV
                                    </button>
                                </div>
                                <div className="probe-profile-chart">
                                    <PlotlyComponent
                                        data={chartData}
                                        layout={chartLayout}
                                        config={PROFILE_PLOT_CONFIG}
                                        theme={theme}
                                        style={{ width: '100%', height: '100%' }}
                                    />
                                </div>
                                <div className="probe-table-wrap">
                                    <table className="probe-profile-table">
                                        <thead>
                                            <tr>
                                                <th>Distance</th>
                                                <th>X</th>
                                                <th>Y</th>
                                                <th>Z</th>
                                                <th>Value</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {visibleProfile.map((point, index) => {
                                                const value = finiteOrNull(point.value);
                                                return (
                                                    <tr key={index}>
                                                        <td>{formatProbeValue(point.distance)}</td>
                                                        <td>{formatProbeValue(point.position[0])}</td>
                                                        <td>{formatProbeValue(point.position[1])}</td>
                                                        <td>{formatProbeValue(point.position[2])}</td>
                                                        <td>{value === null ? '—' : formatProbeValue(value)}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                                {profileSeries.length > visibleProfile.length && (
                                    <div className="probe-row-note">
                                        Showing {visibleProfile.length} of {profileSeries.length} samples — Export CSV downloads the full
                                        profile.
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
