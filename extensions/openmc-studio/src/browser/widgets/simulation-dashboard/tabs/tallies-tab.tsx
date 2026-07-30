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
import { injectable } from '@theia/core/shared/inversify';
import { OpenMCState } from '../../../../common/openmc-state-schema';
import { isIfpTally } from '../../../../common/kinetics-ifp';
import { TallyConfiguratorWidget } from '../../tally-configurator/tally-configurator-widget';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';

/**
 * Tallies tab of the simulation dashboard: tally summary and configurator link.
 */
@injectable()
export class TalliesTabContribution implements DashboardTabContribution {
    readonly id = 'tallies';
    readonly label = 'Tallies';
    readonly icon = 'graph-line';
    readonly order = 2;

    /**
     * Render the Tallies tab with summary and configurator link.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Tallies tab React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const tallies = state.tallies || [];
        const meshes = state.meshes || [];

        return (
            <div className="tallies-tab">
                <div className="instructions-panel">
                    <h4>
                        <i className="codicon codicon-graph-line"></i> Tally Configuration
                    </h4>
                    <p>Tallies allow you to record physical quantities during the simulation (flux, reaction rates, etc.).</p>
                    <button className="theia-button primary" onClick={() => this.openTallyConfigurator(host)}>
                        <i className="codicon codicon-edit"></i> Open Tally Configurator
                    </button>
                </div>

                <div className="summary-cards">
                    <div className="summary-card">
                        <div className="summary-value">{tallies.length}</div>
                        <div className="summary-label">Tallies Defined</div>
                    </div>
                    <div className="summary-card">
                        <div className="summary-value">{meshes.length}</div>
                        <div className="summary-label">Meshes Defined</div>
                    </div>
                </div>

                {tallies.length > 0 && (
                    <div className="tallies-list-preview">
                        <h4>Active Tallies</h4>
                        {tallies.map((tally) => (
                            <div key={tally.id} className="tally-preview-card">
                                <div className="tally-preview-header">
                                    <strong>{tally.name || `Tally ${tally.id}`}</strong>
                                    {isIfpTally(tally) && <span className="auto-badge">auto</span>}
                                    <span className="tally-id">#{tally.id}</span>
                                </div>
                                <div className="tally-preview-details">
                                    <span>Scores: {tally.scores.join(', ')}</span>
                                    <span>Filters: {tally.filters.length}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    /**
     * Open the Tally Configurator widget.
     * @see {@link TallyConfiguratorWidget}
     * @param host - Simulation dashboard widget host.
     */
    private async openTallyConfigurator(host: SimulationDashboardWidget): Promise<void> {
        const widget = await host.widgetManager.getOrCreateWidget(TallyConfiguratorWidget.ID);
        await host.shell.addWidget(widget, { area: 'main' });
        await host.shell.activateWidget(widget.id);
    }
}
