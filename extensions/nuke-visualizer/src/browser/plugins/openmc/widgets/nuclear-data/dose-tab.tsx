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
import { NukeEmptyState, NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCBackendService, DoseCoefficientsResult } from '../../../../../common/openmc-protocol';
import { PlotlyComponent } from '../../../../plotly/plotly-component';
import {
    buildDoseCoefficientTrace,
    doseCoefficientAxisLabel,
    doseCoefficientRows,
    doseParticleLabel,
    doseQuantityLabel,
    geometryOptions,
    resolveGeometry
} from './dose-coefficients-model';

export interface DoseTabProps {
    backendService: OpenMCBackendService;
}

const CHECKBOX_STYLE: React.CSSProperties = {
    width: '14px',
    height: '14px',
    margin: 0,
    flexShrink: 0,
    accentColor: 'var(--theia-focusBorder)'
};

const FALLBACK_PARTICLES: Record<'icrp74' | 'icrp116', string[]> = {
    icrp74: ['photon', 'neutron'],
    icrp116: ['photon', 'neutron', 'electron', 'positron', 'proton', 'helium', 'photon kerma', 'mu-', 'mu+', 'pi-', 'pi+']
};

/** Read-only ICRP-74 / ICRP-116 dose-coefficient reference view. */
export const DoseTab: React.FC<DoseTabProps> = ({ backendService }) => {
    const [dataSource, setDataSource] = React.useState<'icrp74' | 'icrp116'>('icrp116');
    const [doseQuantity, setDoseQuantity] = React.useState<'effective' | 'ambient'>('effective');
    const [particle, setParticle] = React.useState('photon');
    const [geometry, setGeometry] = React.useState('AP');
    const [logScale, setLogScale] = React.useState(false);
    const [result, setResult] = React.useState<DoseCoefficientsResult | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const availableParticles = result?.availableParticles?.length ? result.availableParticles : FALLBACK_PARTICLES[dataSource];
    const availableGeometries = geometryOptions(doseQuantity, result?.availableGeometries);

    const load = React.useCallback(
        async (next: { dataSource: 'icrp74' | 'icrp116'; doseQuantity: 'effective' | 'ambient'; particle: string; geometry: string }) => {
            setLoading(true);
            setError(null);
            try {
                const data = await backendService.getDoseCoefficients(next);
                setResult(data);
                if (!data.success) {
                    setError(data.error ?? 'Dose coefficients unavailable');
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
                setResult(null);
            } finally {
                setLoading(false);
            }
        },
        [backendService]
    );

    const geometryKey = availableGeometries.join(',');
    React.useEffect(() => {
        const next = resolveGeometry(availableGeometries, geometry);
        if (next !== geometry) {
            setGeometry(next);
        }
    }, [geometryKey, geometry, availableGeometries]);

    React.useEffect(() => {
        void load({ dataSource, doseQuantity, particle, geometry });
    }, [dataSource, doseQuantity, particle, geometry, load]);

    const changeSource = (source: 'icrp74' | 'icrp116'): void => {
        const nextQuantity = source === 'icrp116' && doseQuantity === 'ambient' ? 'effective' : doseQuantity;
        const particles = FALLBACK_PARTICLES[source];
        const nextParticle = particles.includes(particle) ? particle : 'photon';
        setDataSource(source);
        setDoseQuantity(nextQuantity);
        setParticle(nextParticle);
        setGeometry('AP');
    };

    const changeQuantity = (quantity: 'effective' | 'ambient'): void => {
        setDoseQuantity(quantity);
        setGeometry('AP');
    };

    const rows = result?.success ? doseCoefficientRows(result) : [];
    const traces = result?.success ? buildDoseCoefficientTrace(result) : [];
    const backgroundColor = getCssColor('--theia-editor-background', '#1e1e1e');
    const foreground = getCssColor('--theia-foreground', '#cccccc');
    const gridColor = getCssColor('--theia-panel-border', '#3c3c3c');

    return (
        <div className="dose-tab">
            <div className="dose-toolbar">
                <div className="dose-toolbar-group">
                    <span className="dose-toolbar-label">Data source</span>
                    <NukeSelect
                        ariaLabel="Dose data source"
                        value={dataSource}
                        options={[
                            { value: 'icrp116', label: 'ICRP-116' },
                            { value: 'icrp74', label: 'ICRP-74' }
                        ]}
                        onChange={(value) => changeSource(value as 'icrp74' | 'icrp116')}
                        disabled={loading}
                        style={{ minWidth: 120 }}
                    />
                </div>
                <div className="dose-toolbar-group">
                    <Tooltip
                        content="Effective dose applies an irradiation geometry; ambient dose equivalent H*(10) has a single AP table."
                        position="top"
                    >
                        <span className="dose-toolbar-label">Quantity</span>
                    </Tooltip>
                    <NukeSelect
                        ariaLabel="Dose quantity"
                        value={doseQuantity}
                        options={[
                            { value: 'effective', label: 'Effective dose' },
                            { value: 'ambient', label: 'Ambient H*(10)', disabled: dataSource === 'icrp116' }
                        ]}
                        onChange={(value) => changeQuantity(value as 'effective' | 'ambient')}
                        disabled={loading}
                        style={{ minWidth: 150 }}
                    />
                </div>
                <div className="dose-toolbar-group">
                    <span className="dose-toolbar-label">Particle</span>
                    <NukeSelect
                        ariaLabel="Incident particle"
                        value={particle}
                        options={availableParticles.map((value) => ({ value, label: doseParticleLabel(value) }))}
                        onChange={setParticle}
                        disabled={loading}
                        style={{ minWidth: 140 }}
                    />
                </div>
                {doseQuantity === 'effective' && (
                    <div className="dose-toolbar-group">
                        <Tooltip content="Irradiation geometry assumed for the effective-dose coefficients." position="top">
                            <span className="dose-toolbar-label">Geometry</span>
                        </Tooltip>
                        <NukeSelect
                            ariaLabel="Dose geometry"
                            value={resolveGeometry(availableGeometries, geometry)}
                            options={availableGeometries.map((value) => ({ value, label: value }))}
                            onChange={setGeometry}
                            disabled={loading}
                            style={{ minWidth: 100 }}
                        />
                    </div>
                )}
                <div className="dose-toolbar-group dose-scale-toggle">
                    <label className="dose-checkbox">
                        <input type="checkbox" checked={logScale} style={CHECKBOX_STYLE} onChange={(e) => setLogScale(e.target.checked)} />
                        Log scale
                    </label>
                </div>
            </div>

            {loading && (
                <div className="dose-loading">
                    <i className={`${codicon('loading')} codicon-modifier-spin`}></i>
                    Reading {dataSource.toUpperCase()} coefficients…
                </div>
            )}

            {!loading && error && (
                <NukeEmptyState
                    icon="warning"
                    title="Dose coefficients unavailable"
                    message={error}
                    hint="This view reads OpenMC's shipped ICRP tables. Check the active Python environment; ICRP-116 has no ambient H*(10) table."
                />
            )}

            {!loading && !error && result?.success && (
                <>
                    <div className="dose-summary">
                        <div className="dose-summary-card">
                            <span>Source</span>
                            <strong>
                                {result.dataSource === 'icrp116' ? 'ICRP-116' : result.dataSource === 'icrp74' ? 'ICRP-74' : '—'}
                            </strong>
                        </div>
                        <div className="dose-summary-card">
                            <span>Quantity</span>
                            <strong>{doseQuantityLabel(result.doseQuantity ?? doseQuantity)}</strong>
                        </div>
                        <div className="dose-summary-card">
                            <span>Grid points</span>
                            <strong>{rows.length}</strong>
                        </div>
                    </div>

                    <div className="dose-chart">
                        <PlotlyComponent
                            data={traces}
                            layout={{
                                xaxis: {
                                    title: { text: 'Energy (MeV)', font: { color: foreground } },
                                    tickfont: { color: foreground },
                                    gridcolor: gridColor,
                                    type: 'log'
                                },
                                yaxis: {
                                    title: { text: doseCoefficientAxisLabel(result.units), font: { color: foreground } },
                                    tickfont: { color: foreground },
                                    gridcolor: gridColor,
                                    type: logScale ? 'log' : 'linear'
                                },
                                paper_bgcolor: backgroundColor,
                                plot_bgcolor: backgroundColor,
                                margin: { t: 24, r: 24, b: 50, l: 78 },
                                showlegend: false,
                                hovermode: 'closest'
                            }}
                            config={{ responsive: true, displayModeBar: false }}
                        />
                    </div>

                    <div className="dose-table-card">
                        <div className="dose-table-header">
                            <span>
                                {doseParticleLabel(result.particle ?? particle)} · {doseCoefficientAxisLabel(result.units)}
                            </span>
                            {doseQuantity === 'effective' && <span className="dose-muted">Geometry {result.geometry ?? geometry}</span>}
                        </div>
                        <div className="dose-table-scroll">
                            <table className="dose-table">
                                <thead>
                                    <tr>
                                        <th>Energy (MeV)</th>
                                        <th className="numeric">Coefficient ({result.units})</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((row, index) => (
                                        <tr key={`${row.energyMeV}-${index}`}>
                                            <td>{row.energyMeV.toPrecision(6)}</td>
                                            <td className="numeric">{row.coefficient.toPrecision(6)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    <p className="dose-caveat">
                        Reference data only; this view does not modify the model. Contact-dose and shutdown-dose workflows consume the same
                        OpenMC tables.
                    </p>
                </>
            )}
        </div>
    );
};

function getCssColor(variable: string, fallback: string): string {
    if (typeof window === 'undefined') return fallback;
    const computed = getComputedStyle(document.body).getPropertyValue(variable.replace('var(', '').replace(')', '')).trim();
    return computed || fallback;
}
