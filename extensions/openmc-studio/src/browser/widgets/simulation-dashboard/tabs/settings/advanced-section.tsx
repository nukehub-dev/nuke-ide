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

import * as React from '@theia/core/shared/react';
import { OpenMCState, OpenMCSettings } from '../../../../../common/openmc-state-schema';
import type { SimulationDashboardWidget } from '../../simulation-dashboard-widget';

/**
 * Render a boolean advanced setting as a checkbox. Booleans that default to
 * true in OpenMC show checked until explicitly disabled; all are emitted only
 * once set (undefined = OpenMC default).
 * @param host - Simulation dashboard widget host.
 * @param settings - Current settings.
 * @param key - The settings key (boolean-valued).
 * @param label - Checkbox label.
 * @param hint - One-line hint shown under the checkbox.
 * @param defaultValue - OpenMC's default for the setting.
 * @returns Checkbox form group React node.
 */
function boolField(
    host: SimulationDashboardWidget,
    settings: OpenMCSettings,
    key: keyof OpenMCSettings & string,
    label: string,
    hint: string,
    defaultValue: boolean
): React.ReactNode {
    return (
        <div className="form-group checkbox" key={key}>
            <label>
                <input
                    type="checkbox"
                    checked={(settings[key] as boolean | undefined) ?? defaultValue}
                    onChange={(e) => host.updateSetting(key, e.target.checked as never)}
                />
                {label}
            </label>
            <span className="form-hint">{hint}</span>
        </div>
    );
}

/**
 * Render the Advanced section: rarely-changed scalar settings (event-based
 * mode, fission neutron creation, photon options, grid/search tuning, and
 * multi-group options). All fields are optional; unset means the OpenMC
 * default applies.
 * @param host - Simulation dashboard widget host.
 * @param state - Current OpenMC simulation state.
 * @returns Advanced section React node.
 */
export function renderAdvancedSection(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
    const settings = state.settings;

    return (
        <div className="advanced-section">
            <h4>
                <i className="codicon codicon-settings"></i> Particle Creation &amp; Physics
            </h4>
            <div className="checkbox-grid">
                {boolField(
                    host,
                    settings,
                    'createFissionNeutrons',
                    'Create fission neutrons',
                    'Off: suppress fission sites (e.g. pure photon/electron problems)',
                    true
                )}
                {boolField(host, settings, 'createDelayedNeutrons', 'Create delayed neutrons', 'Include delayed neutrons in fission', true)}
                {boolField(
                    host,
                    settings,
                    'delayedPhotonScaling',
                    'Delayed photon scaling',
                    'Scale fission photon yield for delayed photon energy',
                    true
                )}
                {boolField(
                    host,
                    settings,
                    'useDecayPhotons',
                    'Use decay photons',
                    'Produce decay photons from neutron reactions (not just prompt)',
                    false
                )}
                {boolField(host, settings, 'survivalBiasing', 'Survival biasing', 'Use survival biasing (implicit capture)', true)}
                {boolField(host, settings, 'probabilityTables', 'Probability tables', 'Unresolved-resonance probability tables', true)}
            </div>

            <h4>
                <i className="codicon codicon-run"></i> Run Behavior
            </h4>
            <div className="checkbox-grid">
                {boolField(
                    host,
                    settings,
                    'eventBased',
                    'Event-based parallelism',
                    'Event-based instead of history-based parallelism',
                    false
                )}
                {boolField(
                    host,
                    settings,
                    'uniformSourceSampling',
                    'Uniform source sampling',
                    'Sample sources uniformly with strengths as weights',
                    false
                )}
                {boolField(
                    host,
                    settings,
                    'writeInitialSource',
                    'Write initial source',
                    'Write the initial source distribution to file',
                    false
                )}
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Generations per Batch</label>
                    <input
                        type="number"
                        min={1}
                        value={settings.generationsPerBatch ?? ''}
                        placeholder="Default (1)"
                        onChange={(e) => host.updateSetting('generationsPerBatch', e.target.value ? parseInt(e.target.value) : undefined)}
                    />
                </div>
                <div className="form-group">
                    <label>Max Lost Particles</label>
                    <input
                        type="number"
                        min={1}
                        value={settings.maxLostParticles ?? ''}
                        placeholder="Default"
                        onChange={(e) => host.updateSetting('maxLostParticles', e.target.value ? parseInt(e.target.value) : undefined)}
                    />
                </div>
                <div className="form-group">
                    <label>Rel. Lost Particle Rate</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={settings.relLostParticleRate ?? ''}
                        placeholder="Default"
                        onChange={(e) => host.updateSetting('relLostParticleRate', e.target.value ? parseFloat(e.target.value) : undefined)}
                    />
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Log Grid Bins</label>
                    <input
                        type="number"
                        min={1}
                        value={settings.logGridBins ?? ''}
                        placeholder="Default"
                        onChange={(e) => host.updateSetting('logGridBins', e.target.value ? parseInt(e.target.value) : undefined)}
                    />
                    <span className="form-hint">Bins for the logarithmic energy grid search</span>
                </div>
                <div className="form-group">
                    <label>Max Scattering Order</label>
                    <input
                        type="number"
                        min={0}
                        value={settings.maxOrder ?? ''}
                        placeholder="Default (multi-group only)"
                        onChange={(e) => host.updateSetting('maxOrder', e.target.value ? parseInt(e.target.value) : undefined)}
                    />
                    <span className="form-hint">Multi-group mode only</span>
                </div>
            </div>

            <h4>
                <i className="codicon codicon-symbol-numeric"></i> Multi-group Scattering
            </h4>
            <div className="form-row">
                <div className="form-group checkbox stacked">
                    <label aria-hidden="true">&nbsp;</label>
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.tabularLegendre?.enable ?? false}
                            onChange={(e) =>
                                host.updateSetting('tabularLegendre', { ...settings.tabularLegendre, enable: e.target.checked })
                            }
                        />
                        Tabular Legendre conversion
                    </label>
                    <span className="form-hint">Convert multi-group scattering moment kernels to tabular distributions</span>
                </div>
                <div className="form-group">
                    <label>Tabular Points</label>
                    <input
                        type="number"
                        min={1}
                        value={settings.tabularLegendre?.numPoints ?? ''}
                        placeholder="Default"
                        disabled={!settings.tabularLegendre?.enable}
                        onChange={(e) =>
                            host.updateSetting('tabularLegendre', {
                                ...settings.tabularLegendre,
                                numPoints: e.target.value ? parseInt(e.target.value) : undefined
                            })
                        }
                    />
                </div>
            </div>
        </div>
    );
}
