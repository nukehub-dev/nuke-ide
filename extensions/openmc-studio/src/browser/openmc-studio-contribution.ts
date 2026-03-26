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
    MenuModelRegistry,
    MAIN_MENU_BAR
} from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import {
    TabBarToolbarContribution,
    TabBarToolbarRegistry
} from '@theia/core/lib/browser/shell/tab-bar-toolbar';

import { OpenMCStudioService } from './openmc-studio-service';
import { OpenMCStateManager } from './openmc-state-manager';

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
    
    // View commands (Phase 1+)
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
}

// ============================================================================
// Menu Paths
// ============================================================================

export namespace OpenMCStudioMenus {
    // Main OpenMC menu in menu bar (before Help which is typically '8_help')
    export const OPENMC = [...MAIN_MENU_BAR, '7_openmc'];
    export const OPENMC_PROJECT = [...OPENMC, '1_project'];
    export const OPENMC_SIMULATION = [...OPENMC, '2_simulation'];
    export const OPENMC_XML = [...OPENMC, '3_xml'];
    export const OPENMC_VIEW = [...OPENMC, '4_view'];
}

// ============================================================================
// Contribution Implementation
// ============================================================================

@injectable()
export class OpenMCStudioContribution implements CommandContribution, MenuContribution, TabBarToolbarContribution {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStudioService)
    protected readonly studioService: OpenMCStudioService;
    
    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

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
            isEnabled: () => this.studioService.openmcAvailable ?? false
        });
        
        commands.registerCommand(OpenMCStudioCommands.STOP_SIMULATION, {
            execute: () => this.stopSimulation(),
            isEnabled: () => false // TODO: Enable when simulation is running
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
    }

    // ============================================================================
    // Menu Registration
    // ============================================================================
    
    registerMenus(menus: MenuModelRegistry): void {
        // Register main OpenMC menu in menu bar (separate from nuke-visualizer's OpenMC Visualizer menu)
        menus.registerSubmenu(OpenMCStudioMenus.OPENMC, 'OpenMC');
        
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
        
        // View menu items (Phase 1+)
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_VIEW, {
            commandId: OpenMCStudioCommands.OPEN_SIMULATION_DASHBOARD.id,
            label: 'Simulation Dashboard',
            order: 'a'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_VIEW, {
            commandId: OpenMCStudioCommands.OPEN_CSG_BUILDER.id,
            label: 'CSG Builder',
            order: 'b'
        });
        menus.registerMenuAction(OpenMCStudioMenus.OPENMC_VIEW, {
            commandId: OpenMCStudioCommands.OPEN_TALLY_CONFIGURATOR.id,
            label: 'Tally Configurator',
            order: 'c'
        });
    }

    // ============================================================================
    // Toolbar Registration
    // ============================================================================
    
    registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
        // TODO: In Phase 1, restrict toolbar buttons to only show for .nuke-openmc files
        // by implementing isVisible callback
        
        toolbar.registerItem({
            id: OpenMCStudioCommands.RUN_SIMULATION.id,
            command: OpenMCStudioCommands.RUN_SIMULATION.id,
            tooltip: 'Run Simulation',
            priority: 100,
            onDidChange: undefined
        });
        
        toolbar.registerItem({
            id: OpenMCStudioCommands.STOP_SIMULATION.id,
            command: OpenMCStudioCommands.STOP_SIMULATION.id,
            tooltip: 'Stop Simulation',
            priority: 99,
            onDidChange: undefined
        });
        
        toolbar.registerItem({
            id: OpenMCStudioCommands.VALIDATE_MODEL.id,
            command: OpenMCStudioCommands.VALIDATE_MODEL.id,
            tooltip: 'Validate Model',
            priority: 98,
            onDidChange: undefined
        });
    }

    // ============================================================================
    // Command Handlers
    // ============================================================================
    
    protected async newProject(): Promise<void> {
        console.log('[OpenMC Studio] New project command');
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
    }
    
    protected async openProject(): Promise<void> {
        console.log('[OpenMC Studio] Open project command');
        this.messageService.info('Open Project: Not yet implemented (Phase 1)');
    }
    
    protected async saveProject(): Promise<void> {
        console.log('[OpenMC Studio] Save project command');
        this.messageService.info('Save Project: Not yet implemented (Phase 1)');
    }
    
    protected async saveProjectAs(): Promise<void> {
        console.log('[OpenMC Studio] Save project as command');
        this.messageService.info('Save Project As: Not yet implemented (Phase 1)');
    }
    
    protected async runSimulation(): Promise<void> {
        console.log('[OpenMC Studio] Run simulation command');
        this.messageService.info('Run Simulation: Not yet implemented (Phase 1)');
    }
    
    protected async stopSimulation(): Promise<void> {
        console.log('[OpenMC Studio] Stop simulation command');
        this.messageService.info('Stop Simulation: Not yet implemented (Phase 1)');
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
    }
    
    protected async generateXML(): Promise<void> {
        console.log('[OpenMC Studio] Generate XML command');
        this.messageService.info('Generate XML: Not yet implemented (Phase 1)');
    }
    
    protected async importXML(): Promise<void> {
        console.log('[OpenMC Studio] Import XML command');
        this.messageService.info('Import XML: Not yet implemented (Phase 1)');
    }
    
    protected async openSimulationDashboard(): Promise<void> {
        console.log('[OpenMC Studio] Open simulation dashboard command');
        this.messageService.info('Simulation Dashboard: Not yet implemented (Phase 1)');
    }
    
    protected async openCSGBuilder(): Promise<void> {
        console.log('[OpenMC Studio] Open CSG builder command');
        this.messageService.info('CSG Builder: Not yet implemented (Phase 2)');
    }
    
    protected async openTallyConfigurator(): Promise<void> {
        console.log('[OpenMC Studio] Open tally configurator command');
        // TODO: Open TallyConfiguratorWidget (Phase 3)
    }
}
