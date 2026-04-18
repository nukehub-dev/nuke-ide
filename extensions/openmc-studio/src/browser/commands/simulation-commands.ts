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
import { OpenMCHealthService } from '../services/openmc-health-service';

export namespace OpenMCSimulationCommands {
    export const CATEGORY = 'OpenMC/Simulation';

    export const RUN_SIMULATION: Command = {
        id: 'openmc.simulation.run',
        category: CATEGORY,
        label: 'Run Simulation',
        iconClass: 'codicon codicon-play'
    };

    export const STOP_SIMULATION: Command = {
        id: 'openmc.simulation.stop',
        category: CATEGORY,
        label: 'Stop Simulation',
        iconClass: 'codicon codicon-stop'
    };

    export const VALIDATE_MODEL: Command = {
        id: 'openmc.simulation.validate',
        category: CATEGORY,
        label: 'Validate Model',
        iconClass: 'codicon codicon-check'
    };

    export const GENERATE_XML: Command = {
        id: 'openmc.simulation.generateXML',
        category: CATEGORY,
        label: 'Generate XML Files'
    };

    export const IMPORT_XML: Command = {
        id: 'openmc.simulation.importXML',
        category: CATEGORY,
        label: 'Import from XML...'
    };
}

@injectable()
export class SimulationCommands {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    
    @inject(OpenMCHealthService)
    protected readonly healthService: OpenMCHealthService;

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

    private async runSimulation(): Promise<void> {
        // Pre-flight health check
        const isReady = await this.healthService.isReady();
        if (!isReady) {
            const result = await this.healthService.runHealthCheck();
            const errors = result.issues.filter(i => i.severity === 'error');
            this.messageService.error(
                `Cannot run simulation: ${errors[0]?.message || 'Environment not ready'}`
            );
            return;
        }

        await this.openDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            widget.runSimulation();
        }
    }

    private async stopSimulation(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            widget.stopSimulation();
        }
    }

    private async validateModel(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            // Trigger validation through the widget
            await (widget as any).validateModel?.();
        }
    }

    private async generateXML(): Promise<void> {
        await this.openDashboard();
        // TODO: Trigger XML generation
    }

    private async importXML(): Promise<void> {
        await this.openDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).importXML();
        }
    }

    private async openDashboard(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    private isSimulationRunning(): boolean {
        const widget = this.widgetManager.tryGetWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            return widget.isSimulationRunning;
        }
        return false;
    }
}
