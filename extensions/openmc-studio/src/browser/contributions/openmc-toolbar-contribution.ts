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

/**
 * OpenMC Toolbar Contribution
 *
 * Registers toolbar items for the simulation dashboard.
 *
 * @module openmc-studio/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { TabBarToolbarContribution, TabBarToolbarRegistry } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { WidgetManager } from '@theia/core/lib/browser';
import { Emitter, Event } from '@theia/core/lib/common';
import { OpenMCSimulationCommands } from '../commands/simulation-commands';
import { SimulationDashboardWidget } from '../widgets/simulation-dashboard/simulation-dashboard-widget';

/**
 * Registers toolbar items for the OpenMC simulation dashboard.
 *
 * Binds to {@link TabBarToolbarContribution} in the frontend module to activate toolbar registration.
 * Items are visible only when a {@link SimulationDashboardWidget} is active and refresh every second.
 *
 * @see {@link OpenMCSimulationCommands} for the underlying command definitions
 * @see {@link SimulationDashboardWidget} for the target widget
 */
@injectable()
export class OpenMCToolbarContribution implements TabBarToolbarContribution {
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    private readonly _onDidChange = new Emitter<void>();
    /** Event fired when toolbar item visibility or state may have changed. */
    readonly onDidChange: Event<void> = this._onDidChange.event;

    /**
     * Register Run, Stop, and Validate toolbar items scoped to the simulation dashboard.
     * @param registry - The Theia tab-bar toolbar registry
     * @see {@link OpenMCSimulationCommands}
     */
    registerToolbarItems(registry: TabBarToolbarRegistry): void {
        const isVisible = (widget?: any) => widget instanceof SimulationDashboardWidget;

        // Run simulation
        registry.registerItem({
            id: OpenMCSimulationCommands.RUN_SIMULATION.id,
            command: OpenMCSimulationCommands.RUN_SIMULATION.id,
            tooltip: 'Run Simulation',
            priority: 100,
            onDidChange: this.onDidChange,
            isVisible
        });

        // Stop simulation
        registry.registerItem({
            id: OpenMCSimulationCommands.STOP_SIMULATION.id,
            command: OpenMCSimulationCommands.STOP_SIMULATION.id,
            tooltip: 'Stop Simulation',
            priority: 99,
            onDidChange: this.onDidChange,
            isVisible
        });

        // Validate model
        registry.registerItem({
            id: OpenMCSimulationCommands.VALIDATE_MODEL.id,
            command: OpenMCSimulationCommands.VALIDATE_MODEL.id,
            tooltip: 'Validate Model',
            priority: 98,
            onDidChange: this.onDidChange,
            isVisible
        });

        // Refresh toolbar periodically
        setInterval(() => this._onDidChange.fire(), 1000);
    }
}
