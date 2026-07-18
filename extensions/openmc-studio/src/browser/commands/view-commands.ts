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
    /** Command category for all view-opening commands. */
    export const CATEGORY = 'OpenMC/View';

    /** Open the main simulation dashboard widget. */
    export const OPEN_SIMULATION_DASHBOARD: Command = {
        id: 'openmc.openSimulationDashboard',
        category: CATEGORY,
        label: 'Open Simulation Dashboard'
    };

    /** Open the Constructive Solid Geometry (CSG) builder widget. */
    export const OPEN_CSG_BUILDER: Command = {
        id: 'openmc.openCSGBuilder',
        category: CATEGORY,
        label: 'Open CSG Builder'
    };

    /** Open the DAGMC geometry editor widget. */
    export const OPEN_DAGMC_EDITOR: Command = {
        id: 'openmc.openDAGMCEditor',
        category: CATEGORY,
        label: 'Open DAGMC Editor'
    };

    /** Open the tally configurator widget. */
    export const OPEN_TALLY_CONFIGURATOR: Command = {
        id: 'openmc.openTallyConfigurator',
        category: CATEGORY,
        label: 'Open Tally Configurator'
    };

    /** Open the depletion analysis dashboard tab. */
    export const OPEN_DEPLETION: Command = {
        id: 'openmc.openDepletion',
        category: CATEGORY,
        label: 'Open Depletion Dashboard'
    };

    /** Open the variance reduction dashboard tab. */
    export const OPEN_VARIANCE_REDUCTION: Command = {
        id: 'openmc.openVarianceReduction',
        category: CATEGORY,
        label: 'Open Variance Reduction'
    };

    /** Generate and open a Python script for the current model. */
    export const OPEN_SCRIPT_GENERATOR: Command = {
        id: 'openmc.openScriptGenerator',
        category: CATEGORY,
        label: 'Generate Python Script'
    };

    /** Open the simulation comparison widget. */
    export const OPEN_SIMULATION_COMPARISON: Command = {
        id: 'openmc.openSimulationComparison',
        category: CATEGORY,
        label: 'Compare Simulations'
    };

    /** Open the optimization study widget. */
    export const OPEN_OPTIMIZATION: Command = {
        id: 'openmc.openOptimization',
        category: CATEGORY,
        label: 'Optimization Study'
    };
}

/**
 * View command handler for OpenMC Studio.
 *
 * Registers and executes commands that open various widgets and dashboards,
 * including the simulation dashboard, geometry editors, and specialized tools.
 *
 * @see {@link OpenMCViewCommands} for available command identifiers
 */
@injectable()
export class ViewCommands {
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(OpenMCPythonExporter)
    protected readonly pythonExporter: OpenMCPythonExporter;

    /**
     * Register view commands with the command registry.
     * @param registry - The Theia command registry
     */
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

    /**
     * Open a widget by its identifier in the main area and focus it.
     * @param widgetId - The unique widget identifier
     */
    private async openWidget(widgetId: string): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(widgetId);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    /**
     * Open the DAGMC editor, optionally loading a file immediately.
     * @param filePath - Optional path to a DAGMC file to load
     */
    private async openDAGMCEditor(filePath?: string): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<DAGMCEditorWidget>(DAGMCEditorWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);

        if (filePath && typeof (widget as any).loadFile === 'function') {
            await (widget as any).loadFile(filePath);
        }
    }

    /**
     * Open the simulation dashboard and switch to a specific tab.
     * @param tabId - The dashboard tab identifier to activate
     */
    private async openDashboardTab(tabId: DashboardTab): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<SimulationDashboardWidget>(SimulationDashboardWidget.ID);
        widget.setActiveTab(tabId);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }
}
