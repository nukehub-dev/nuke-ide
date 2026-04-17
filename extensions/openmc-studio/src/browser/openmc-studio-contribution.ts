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
 * OpenMC Studio Contribution
 * 
 * Registers commands, menus, and toolbar items for the OpenMC Studio extension.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    Command,
    CommandContribution,
    CommandRegistry,
    MenuContribution,
    MenuModelRegistry
} from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { Emitter } from '@theia/core/lib/common';
import {
    TabBarToolbarContribution,
    TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import {
    OpenHandler,
    FrontendApplicationContribution,
    WidgetOpenerOptions,
    Widget,
    WidgetManager,
    ApplicationShell
} from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';

import { OpenMCPythonExporter } from './script-generator/python-exporter';

import { OpenMCStudioService } from './openmc-studio-service';
import { OpenMCStateManager } from './openmc-state-manager';
import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';
import { SimulationDashboardWidget } from './simulation-dashboard/simulation-dashboard-widget';
import { CSGBuilderWidget } from './csg-builder/csg-builder-widget';
import { DAGMCEditorWidget } from './dagmc-editor/dagmc-editor-widget';
import { TallyConfiguratorWidget } from './tally-configurator/tally-configurator-widget';
import { SimulationComparisonWidget } from './simulation-comparison/comparison-widget';
import { OptimizationWidget } from './optimization/optimization-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';

// ============================================================================
// Command IDs
// ============================================================================

export namespace OpenMCStudioCommands {
    export const CATEGORY = 'OpenMC';
    
    // Project commands
    export const NEW_PROJECT: Command = {
        id: 'openmc.newProject',
        category: CATEGORY,
        label: 'New OpenMC Project'
    };
    
    export const OPEN_PROJECT: Command = {
        id: 'openmc.openProject',
        category: CATEGORY,
        label: 'Open OpenMC Project...'
    };
    
    export const SAVE_PROJECT: Command = {
        id: 'openmc.saveProject',
        category: CATEGORY,
        label: 'Save Project'
    };
    
    export const SAVE_PROJECT_AS: Command = {
        id: 'openmc.saveProjectAs',
        category: CATEGORY,
        label: 'Save Project As...'
    };
    
    // Simulation commands
    export const RUN_SIMULATION: Command = {
        id: 'openmc.runSimulation',
        category: CATEGORY,
        label: 'Run Simulation',
        iconClass: 'codicon codicon-play'
    };
    
    export const STOP_SIMULATION: Command = {
        id: 'openmc.stopSimulation',
        category: CATEGORY,
        label: 'Stop Simulation',
        iconClass: 'codicon codicon-stop'
    };
    
    export const VALIDATE_MODEL: Command = {
        id: 'openmc.validateModel',
        category: CATEGORY,
        label: 'Validate Model',
        iconClass: 'codicon codicon-check'
    };
    
    // XML commands
    export const GENERATE_XML: Command = {
        id: 'openmc.generateXML',
        category: CATEGORY,
        label: 'Generate XML Files'
    };
    
    export const IMPORT_XML: Command = {
        id: 'openmc.importXML',
        category: CATEGORY,
        label: 'Import from XML...'
    };
    
    // View commands
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
    
    export const OPEN_TALLY_CONFIGURATOR: Command = {
        id: 'openmc.openTallyConfigurator',
        category: CATEGORY,
        label: 'Open Tally Configurator'
    };

    export const OPEN_DEPLETION: Command = {
        id: 'openmc.openDepletion',
        category: CATEGORY,
        label: 'Depletion'
    };

    export const OPEN_VARIANCE_REDUCTION: Command = {
        id: 'openmc.openVarianceReduction',
        category: CATEGORY,
        label: 'Variance Reduction'
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

    export const OPEN_DAGMC_EDITOR: Command = {
        id: 'openmc.openDAGMCEditor',
        category: CATEGORY,
        label: 'Open DAGMC Editor'
    };
}

// ============================================================================
// Menu Paths
// ============================================================================

export namespace OpenMCStudioMenus {
    // Main OpenMC menu inside Nuke Tools
    export const OPENMC = [...NukeMenus.TOOLS, '1_openmc'];
    
    // OpenMC Subgroups
    export const OPENMC_PROJECT = [...OPENMC, '1_project'];
    export const OPENMC_SIMULATION = [...OPENMC, '2_simulation'];
    export const OPENMC_GEOMETRY = [...OPENMC, '3_geometry'];
    export const OPENMC_XML = [...OPENMC, '4_xml'];
    export const OPENMC_ADVANCED = [...OPENMC, '5_advanced'];
}

// ============================================================================
// Contribution Implementation
// ============================================================================

@injectable()
export class OpenMCStudioContribution implements CommandContribution, MenuContribution, TabBarToolbarContribution, OpenHandler, FrontendApplicationContribution {
    readonly id = 'openmc-studio';
    readonly label = 'OpenMC Project';
    readonly priority = 200;
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStudioService)
    protected readonly studioService: OpenMCStudioService;
    
    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;
    
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    
    @inject(FileService)
    protected readonly fileService: FileService;
    
    @inject(OpenMCPythonExporter)
    protected readonly pythonExporter: OpenMCPythonExporter;

    private currentWidget?: SimulationDashboardWidget;
    private _onDidChangeCurrentWidget = new Emitter<void>();
    readonly onDidChangeCurrentWidget = this._onDidChangeCurrentWidget.event;

    // ============================================================================
    // Command Registration
    // ============================================================================
    
    registerCommands(commands: CommandRegistry): void {
        // Project commands
        commands.registerCommand(OpenMCStudioCommands.NEW_PROJECT, {
            execute: () => this.newProject()
        });
        
        commands.registerCommand(OpenMCStudioCommands.OPEN_PROJECT, {
            execute: () => this.openProject()
        });
        
        commands.registerCommand(OpenMCStudioCommands.SAVE_PROJECT, {
            execute: () => this.saveProject()
        });
        
        commands.registerCommand(OpenMCStudioCommands.SAVE_PROJECT_AS, {
            execute: () => this.saveProjectAs()
        });
        
        // Simulation commands
        commands.registerCommand(OpenMCStudioCommands.RUN_SIMULATION, {
            execute: () => this.runSimulation(),
            isEnabled: () => {
                const widget = this.widgetManager.tryGetWidget(SimulationDashboardWidget.ID);
                if (widget instanceof SimulationDashboardWidget) {
                    return !widget.isSimulationRunning;
                }
                return true;
            }
        });
        
        commands.registerCommand(OpenMCStudioCommands.STOP_SIMULATION, {
            execute: () => this.stopSimulation(),
            isEnabled: () => {
                const widget = this.widgetManager.tryGetWidget(SimulationDashboardWidget.ID);
                if (widget instanceof SimulationDashboardWidget) {
                    return widget.isSimulationRunning;
                }
                return false;
            }
        });
        
        commands.registerCommand(OpenMCStudioCommands.VALIDATE_MODEL, {
            execute: () => this.validateModel()
        });
        
        // XML commands
        commands.registerCommand(OpenMCStudioCommands.GENERATE_XML, {
            execute: () => this.generateXML()
        });
        
        commands.registerCommand(OpenMCStudioCommands.IMPORT_XML, {
            execute: () => this.importXML()
        });
        
        // View commands (Phase 1+)
        commands.registerCommand(OpenMCStudioCommands.OPEN_SIMULATION_DASHBOARD, {
            execute: () => this.openSimulationDashboard()
        });
        
        commands.registerCommand(OpenMCStudioCommands.OPEN_CSG_BUILDER, {
            execute: () => this.openCSGBuilder()
        });
        
        commands.registerCommand(OpenMCStudioCommands.OPEN_TALLY_CONFIGURATOR, {
            execute: () => this.openTallyConfigurator()
        });

        commands.registerCommand(OpenMCStudioCommands.OPEN_DEPLETION, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget<SimulationDashboardWidget>(SimulationDashboardWidget.ID);
                widget.setActiveTab('depletion');
                await this.shell.addWidget(widget, { area: 'main' });
                await this.shell.activateWidget(widget.id);
            }
        });

        // Phase 4 command placeholders
        commands.registerCommand(OpenMCStudioCommands.OPEN_VARIANCE_REDUCTION, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget<SimulationDashboardWidget>(SimulationDashboardWidget.ID);
                widget.setActiveTab('variance-reduction');
                await this.shell.addWidget(widget, { area: 'main' });
                await this.shell.activateWidget(widget.id);
            }
        });

        commands.registerCommand(OpenMCStudioCommands.OPEN_SCRIPT_GENERATOR, {
            execute: () => this.pythonExporter.exportToPython()
        });

        commands.registerCommand(OpenMCStudioCommands.OPEN_SIMULATION_COMPARISON, {
            execute: () => this.openSimulationComparison()
        });

        commands.registerCommand(OpenMCStudioCommands.OPEN_OPTIMIZATION, {
            execute: () => this.openOptimizationWidget()
        });

        commands.registerCommand(OpenMCStudioCommands.OPEN_DAGMC_EDITOR, {
            execute: (filePath?: string) => this.openDAGMCEditor(filePath)
        });
    }

    // ============================================================================
    // Menu Registration
    // ============================================================================
    
    registerMenus(menus: MenuModelRegistry): void {
        // Register main OpenMC Studio menu inside the central Nuke Tools menu
        menus.registerSubmenu(OpenMCStudioMenus.OPENMC, 'OpenMC Studio');
        
        // Submenus for better organization under OpenMC Studio
        menus.registerSubmenu(OpenMCStudioMenus.OPENMC_PROJECT, 'Project');
        menus.registerSubmenu(OpenMCStudioMenus.OPENMC_SIMULATION, 'Simulation');
        menus.registerSubmenu(OpenMCStudioMenus.OPENMC_GEOMETRY, 'Geometry');
        menus.registerSubmenu(OpenMCStudioMenus.OPENMC_XML, 'XML Configuration');
        menus.registerSubmenu(OpenMCStudioMenus.OPENMC_ADVANCED, 'Advanced');

        // Project menu items
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_PROJECT, {
            commandId: OpenMCStudioCommands.NEW_PROJECT.id,
            label: 'New Project',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_PROJECT, {
            commandId: OpenMCStudioCommands.OPEN_PROJECT.id,
            label: 'Open Project...',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_PROJECT, {
            commandId: OpenMCStudioCommands.SAVE_PROJECT.id,
            label: 'Save Project',
            order: 'c'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_PROJECT, {
            commandId: OpenMCStudioCommands.SAVE_PROJECT_AS.id,
            label: 'Save Project As...',
            order: 'd'
        });
        
        // Simulation menu items
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_SIMULATION, {
            commandId: OpenMCStudioCommands.OPEN_SIMULATION_DASHBOARD.id,
            label: 'Simulation Dashboard',
            order: '0'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_SIMULATION, {
            commandId: OpenMCStudioCommands.RUN_SIMULATION.id,
            label: 'Run Simulation',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_SIMULATION, {
            commandId: OpenMCStudioCommands.STOP_SIMULATION.id,
            label: 'Stop Simulation',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_SIMULATION, {
            commandId: OpenMCStudioCommands.VALIDATE_MODEL.id,
            label: 'Validate Model',
            order: 'c'
        });

        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_SIMULATION, {
            commandId: OpenMCStudioCommands.OPEN_SIMULATION_COMPARISON.id,
            label: 'Compare Simulations',
            order: 'd'
        });
        
        // XML menu items
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_XML, {
            commandId: OpenMCStudioCommands.GENERATE_XML.id,
            label: 'Generate XML Files',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_XML, {
            commandId: OpenMCStudioCommands.IMPORT_XML.id,
            label: 'Import from XML...',
            order: 'b'
        });
        
        // Geometry menu items
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_GEOMETRY, {
            commandId: OpenMCStudioCommands.OPEN_CSG_BUILDER.id,
            label: 'CSG Builder',
            order: 'a'
        });

        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_GEOMETRY, {
            commandId: OpenMCStudioCommands.OPEN_DAGMC_EDITOR.id,
            label: 'DAGMC Editor',
            order: 'b'
        });
        
        // Advanced items
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_ADVANCED, {
            commandId: OpenMCStudioCommands.OPEN_TALLY_CONFIGURATOR.id,
            label: 'Tally Configurator',
            order: 'd'
        });

        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_ADVANCED, {
            commandId: OpenMCStudioCommands.OPEN_DEPLETION.id,
            label: 'Depletion Dashboard',
            order: 'e'
        });

        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_ADVANCED, {
            commandId: OpenMCStudioCommands.OPEN_VARIANCE_REDUCTION.id,
            label: 'Variance Reduction',
            order: 'f'
        });

        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_ADVANCED, {
            commandId: OpenMCStudioCommands.OPEN_SCRIPT_GENERATOR.id,
            label: 'Generate Python Script',
            order: 'g'
        });

        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_ADVANCED, {
            commandId: OpenMCStudioCommands.OPEN_OPTIMIZATION.id,
            label: 'Optimization Study',
            order: 'h'
        });
    }

    // ============================================================================
    // OpenHandler Implementation
    // ============================================================================
    
    canHandle(uri: URI, options?: WidgetOpenerOptions): number {
        if (uri.path.ext === '.nuke-openmc') {
            return 200; // High priority for .nuke-openmc files
        }
        return 0;
    }
    
    async open(uri: URI, options?: WidgetOpenerOptions): Promise<Widget> {
        console.log('[OpenMC Studio] Opening project file:', uri.toString());
        
        try {
            // Read and parse the project file
            const content = await this.fileService.readFile(uri);
            const projectFile = JSON.parse(content.value.toString());
            
            if (projectFile.state) {
                // Load the state into the state manager
                this.stateManager.setState(projectFile.state);
                this.stateManager.setProjectPath(uri.path.toString());
                this.stateManager.markClean();
                
                // Open the dashboard
                const widget = await this.widgetManager.getOrCreateWidget<SimulationDashboardWidget>(SimulationDashboardWidget.ID);
                await this.shell.addWidget(widget, { area: 'main' });
                await this.shell.activateWidget(widget.id);
                
                this.currentWidget = widget;
                this._onDidChangeCurrentWidget.fire();
                
                this.messageService.info(`Opened project: ${projectFile.state.metadata?.name || 'Untitled'}`);
                return widget;
            } else {
                throw new Error('Invalid project file format');
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to open project: ${msg}`);
            throw error;
        }
    }
    
    // ============================================================================
    // FrontendApplicationContribution
    // ============================================================================
    
    initialize(): void {
        // Track when the dashboard widget is activated
        this.shell.onDidChangeCurrentWidget(({ newValue }) => {
            if (newValue instanceof SimulationDashboardWidget) {
                this.currentWidget = newValue;
                this._onDidChangeCurrentWidget.fire();
            } else if (this.currentWidget && !(this.shell.currentWidget instanceof SimulationDashboardWidget)) {
                this.currentWidget = undefined;
                this._onDidChangeCurrentWidget.fire();
            }
        });
    }
    
    // ============================================================================
    // Toolbar Registration
    // ============================================================================
    
    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        // Only show toolbar buttons when the Simulation Dashboard widget is active
        // The isVisible callback receives the widget that the toolbar is for
        const isVisible = (widget?: Widget) => widget instanceof SimulationDashboardWidget;
        
        // Fire onDidChange periodically to update button enabled state
        const refreshToolbar = () => {
            this._onDidChangeCurrentWidget.fire();
        };
        
        toolbar.registerItem({
            id: OpenMCStudioCommands.RUN_SIMULATION.id,
            command: OpenMCStudioCommands.RUN_SIMULATION.id,
            tooltip: 'Run Simulation',
            priority: 100,
            onDidChange: this.onDidChangeCurrentWidget,
            isVisible
        });
        
        toolbar.registerItem({
            id: OpenMCStudioCommands.STOP_SIMULATION.id,
            command: OpenMCStudioCommands.STOP_SIMULATION.id,
            tooltip: 'Stop Simulation',
            priority: 99,
            onDidChange: this.onDidChangeCurrentWidget,
            isVisible
        });
        
        toolbar.registerItem({
            id: OpenMCStudioCommands.VALIDATE_MODEL.id,
            command: OpenMCStudioCommands.VALIDATE_MODEL.id,
            tooltip: 'Validate Model',
            priority: 98,
            onDidChange: this.onDidChangeCurrentWidget,
            isVisible
        });
        
        // Refresh toolbar every second to update enabled state based on simulation running
        setInterval(refreshToolbar, 1000);
    }

    // ============================================================================
    // Command Handlers
    // ============================================================================
    
    protected async newProject(): Promise<void> {
        console.log('[OpenMC Studio] New project command');
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
        // Open the dashboard for the new project
        await this.openSimulationDashboard();
    }
    
    protected async openProject(): Promise<void> {
        console.log('[OpenMC Studio] Open project command');
        await this.openSimulationDashboard();
        // Get the dashboard widget and call its open method
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            // The widget will handle the dialog
            await (widget as any).openProject();
        }
    }
    
    protected async saveProject(): Promise<void> {
        console.log('[OpenMC Studio] Save project command');
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProject();
        }
    }
    
    protected async saveProjectAs(): Promise<void> {
        console.log('[OpenMC Studio] Save project as command');
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProjectAs();
        }
    }
    
    protected async runSimulation(): Promise<void> {
        console.log('[OpenMC Studio] Run simulation command');
        await this.openSimulationDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            widget.runSimulation();
        }
    }
    
    protected async stopSimulation(): Promise<void> {
        console.log('[OpenMC Studio] Stop simulation command');
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            widget.stopSimulation();
        }
    }
    
    protected async validateModel(): Promise<void> {
        console.log('[OpenMC Studio] Validate model command');
        const result = await this.stateManager.validate();
        
        if (result.valid) {
            this.messageService.info('OpenMC model is valid');
        } else {
            const errors = result.issues.filter(i => i.severity === 'error').length;
            const warnings = result.issues.filter(i => i.severity === 'warning').length;
            this.messageService.warn(`Model validation: ${errors} errors, ${warnings} warnings`);
            
            // Log issues to console
            result.issues.forEach(issue => {
                console.log(`[${issue.severity.toUpperCase()}] ${issue.category}: ${issue.message}`);
            });
        }
        
        // Open dashboard to show validation results
        await this.openSimulationDashboard();
    }
    
    protected async generateXML(): Promise<void> {
        console.log('[OpenMC Studio] Generate XML command');
        await this.openSimulationDashboard();
    }
    
    protected async importXML(): Promise<void> {
        console.log('[OpenMC Studio] Import XML command');
        await this.openSimulationDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).importXML();
        }
    }
    
    protected async openSimulationDashboard(): Promise<void> {
        console.log('[OpenMC Studio] Open simulation dashboard command');
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }
    
    protected async openCSGBuilder(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<CSGBuilderWidget>(CSGBuilderWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    protected async openSimulationComparison(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<SimulationComparisonWidget>(SimulationComparisonWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    protected async openDAGMCEditor(filePath?: string): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<DAGMCEditorWidget>(DAGMCEditorWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
        
        // If file path provided, load it
        if (filePath && typeof (widget as any).loadFile === 'function') {
            await (widget as any).loadFile(filePath);
        }
    }

    protected async openTallyConfigurator(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<TallyConfiguratorWidget>(TallyConfiguratorWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }

    protected async openOptimizationWidget(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<OptimizationWidget>(OptimizationWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }
}
