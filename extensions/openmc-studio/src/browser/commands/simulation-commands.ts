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
 * Simulation Commands
 * 
 * Commands for running and managing simulations.
 * 
 * @module openmc-studio/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { SimulationDashboardWidget } from '../widgets/simulation-dashboard/simulation-dashboard-widget';


export namespace OpenMCSimulationCommands {
    /** Command category for all simulation control commands. */
    export const CATEGORY = 'OpenMC/Simulation';

    /** Start running the current OpenMC simulation. */
    export const RUN_SIMULATION: Command = {
        id: 'openmc.simulation.run',
        category: CATEGORY,
        label: 'Run Simulation',
        iconClass: 'codicon codicon-play'
    };

    /** Stop an actively running OpenMC simulation. */
    export const STOP_SIMULATION: Command = {
        id: 'openmc.simulation.stop',
        category: CATEGORY,
        label: 'Stop Simulation',
        iconClass: 'codicon codicon-stop'
    };

    /** Validate the current model configuration for errors. */
    export const VALIDATE_MODEL: Command = {
        id: 'openmc.simulation.validate',
        category: CATEGORY,
        label: 'Validate Model',
        iconClass: 'codicon codicon-check'
    };

    /** Generate OpenMC XML input files from the current model. */
    export const GENERATE_XML: Command = {
        id: 'openmc.simulation.generateXML',
        category: CATEGORY,
        label: 'Generate XML Files'
    };

    /** Import an existing OpenMC model from XML files. */
    export const IMPORT_XML: Command = {
        id: 'openmc.simulation.importXML',
        category: CATEGORY,
        label: 'Import from XML...'
    };
}

/**
 * Simulation command handler for OpenMC Studio.
 *
 * Registers and executes commands for running, stopping, and managing
 * OpenMC simulations, as well as model validation and XML I/O.
 *
 * @see {@link OpenMCSimulationCommands} for available command identifiers
 * @see {@link SimulationDashboardWidget} for the widget that executes simulations
 */
@injectable()
export class SimulationCommands {

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    /**
     * Register simulation commands with the command registry.
     * @param registry - The Theia command registry
     */
    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCSimulationCommands.RUN_SIMULATION, {
            execute: () => this.runSimulation(),
            isEnabled: () => !this.isSimulationRunning()
        });
        
        registry.registerCommand(OpenMCSimulationCommands.STOP_SIMULATION, {
            execute: () => this.stopSimulation(),
            isEnabled: () => this.isSimulationRunning()
        });
        
        registry.registerCommand(OpenMCSimulationCommands.VALIDATE_MODEL, {
            execute: () => this.validateModel()
        });
        
        registry.registerCommand(OpenMCSimulationCommands.GENERATE_XML, {
            execute: () => this.generateXML()
        });
        
        registry.registerCommand(OpenMCSimulationCommands.IMPORT_XML, {
            execute: () => this.importXML()
        });
    }

    /**
     * Open the dashboard and start the simulation.
     */
    private async runSimulation(): Promise<void> {
        await this.openDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            widget.runSimulation();
        }
    }

    /**
     * Stop the currently running simulation via the dashboard widget.
     */
    private async stopSimulation(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            widget.stopSimulation();
        }
    }

    /**
     * Trigger model validation through the simulation dashboard widget.
     */
    private async validateModel(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            // Trigger validation through the widget
            await (widget as any).validateModel?.();
        }
    }

    /**
     * Open the dashboard to prepare for XML generation.
     * @todo Implement XML generation trigger
     */
    private async generateXML(): Promise<void> {
        await this.openDashboard();
        // TODO: Trigger XML generation
    }

    /**
     * Open the dashboard and trigger XML import through the simulation dashboard widget.
     */
    private async importXML(): Promise<void> {
        await this.openDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).importXML();
        }
    }

    /**
     * Open or focus the simulation dashboard widget in the main area.
     */
    private async openDashboard(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    /**
     * Determine whether a simulation is currently running.
     * @returns `true` if the simulation dashboard reports an active run
     */
    private isSimulationRunning(): boolean {
        const widget = this.widgetManager.tryGetWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            return widget.isSimulationRunning;
        }
        return false;
    }
}
