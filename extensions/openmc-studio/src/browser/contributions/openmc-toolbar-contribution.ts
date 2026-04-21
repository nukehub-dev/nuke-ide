// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
