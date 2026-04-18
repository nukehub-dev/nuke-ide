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
 * View Commands
 * 
 * Commands for opening various OpenMC Studio views and widgets.
 * 
 * @module openmc-studio/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { SimulationDashboardWidget, DashboardTab } from '../widgets/simulation-dashboard/simulation-dashboard-widget';
import { CSGBuilderWidget } from '../widgets/csg-builder/csg-builder-widget';
import { DAGMCEditorWidget } from '../widgets/dagmc-editor/dagmc-editor-widget';
import { TallyConfiguratorWidget } from '../widgets/tally-configurator/tally-configurator-widget';
import { SimulationComparisonWidget } from '../widgets/simulation-comparison/comparison-widget';
import { OptimizationWidget } from '../widgets/optimization/optimization-widget';
import { OpenMCPythonExporter } from '../script-generator/python-exporter';

export namespace OpenMCViewCommands {
    export const CATEGORY = 'OpenMC/View';

    export const OPEN_SIMULATION_DASHBOARD: Command = {
        id: 'openmc.openSimulationDashboard',
        category: CATEGORY,
        label: 'Open Simulation Dashboard'
    };

    export const OPEN_CSG_BUILDER: Command = {
        id: 'openmc.openCSGBuilder',
        category: CATEGORY,
        label: 'Open CSG Builder'
    };

    export const OPEN_DAGMC_EDITOR: Command = {
        id: 'openmc.openDAGMCEditor',
        category: CATEGORY,
        label: 'Open DAGMC Editor'
    };

    export const OPEN_TALLY_CONFIGURATOR: Command = {
        id: 'openmc.openTallyConfigurator',
        category: CATEGORY,
        label: 'Open Tally Configurator'
    };

    export const OPEN_DEPLETION: Command = {
        id: 'openmc.openDepletion',
        category: CATEGORY,
        label: 'Open Depletion Dashboard'
    };

    export const OPEN_VARIANCE_REDUCTION: Command = {
        id: 'openmc.openVarianceReduction',
        category: CATEGORY,
        label: 'Open Variance Reduction'
    };

    export const OPEN_SCRIPT_GENERATOR: Command = {
        id: 'openmc.openScriptGenerator',
        category: CATEGORY,
        label: 'Generate Python Script'
    };

    export const OPEN_SIMULATION_COMPARISON: Command = {
        id: 'openmc.openSimulationComparison',
        category: CATEGORY,
        label: 'Compare Simulations'
    };

    export const OPEN_OPTIMIZATION: Command = {
        id: 'openmc.openOptimization',
        category: CATEGORY,
        label: 'Optimization Study'
    };
}

@injectable()
export class ViewCommands {
    
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    
    @inject(OpenMCPythonExporter)
    protected readonly pythonExporter: OpenMCPythonExporter;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCViewCommands.OPEN_SIMULATION_DASHBOARD, {
            execute: () => this.openWidget(SimulationDashboardWidget.ID)
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_CSG_BUILDER, {
            execute: () => this.openWidget(CSGBuilderWidget.ID)
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_DAGMC_EDITOR, {
            execute: (filePath?: string) => this.openDAGMCEditor(filePath)
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_TALLY_CONFIGURATOR, {
            execute: () => this.openWidget(TallyConfiguratorWidget.ID)
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_DEPLETION, {
            execute: () => this.openDashboardTab('depletion')
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_VARIANCE_REDUCTION, {
            execute: () => this.openDashboardTab('variance-reduction')
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_SCRIPT_GENERATOR, {
            execute: () => this.pythonExporter.exportToPython()
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_SIMULATION_COMPARISON, {
            execute: () => this.openWidget(SimulationComparisonWidget.ID)
        });
        
        registry.registerCommand(OpenMCViewCommands.OPEN_OPTIMIZATION, {
            execute: () => this.openWidget(OptimizationWidget.ID)
        });
    }

    private async openWidget(widgetId: string): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(widgetId);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    private async openDAGMCEditor(filePath?: string): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<DAGMCEditorWidget>(DAGMCEditorWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
        
        if (filePath && typeof (widget as any).loadFile === 'function') {
            await (widget as any).loadFile(filePath);
        }
    }

    private async openDashboardTab(tabId: DashboardTab): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<SimulationDashboardWidget>(SimulationDashboardWidget.ID);
        widget.setActiveTab(tabId);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }
}
