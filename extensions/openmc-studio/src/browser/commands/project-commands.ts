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
 * Project Commands
 * 
 * Commands for project management (new, open, save).
 * 
 * @module openmc-studio/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { Command, CommandRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { OpenMCStateManager } from '../openmc-state-manager';
import { SimulationDashboardWidget } from '../widgets/simulation-dashboard/simulation-dashboard-widget';

export namespace OpenMCProjectCommands {
    export const CATEGORY = 'OpenMC/Project';

    export const NEW_PROJECT: Command = {
        id: 'openmc.project.new',
        category: CATEGORY,
        label: 'New Project'
    };

    export const OPEN_PROJECT: Command = {
        id: 'openmc.project.open',
        category: CATEGORY,
        label: 'Open Project...'
    };

    export const SAVE_PROJECT: Command = {
        id: 'openmc.project.save',
        category: CATEGORY,
        label: 'Save Project'
    };

    export const SAVE_PROJECT_AS: Command = {
        id: 'openmc.project.saveAs',
        category: CATEGORY,
        label: 'Save Project As...'
    };
}

@injectable()
export class ProjectCommands {
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    
    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCProjectCommands.NEW_PROJECT, {
            execute: () => this.newProject()
        });
        
        registry.registerCommand(OpenMCProjectCommands.OPEN_PROJECT, {
            execute: () => this.openProject()
        });
        
        registry.registerCommand(OpenMCProjectCommands.SAVE_PROJECT, {
            execute: () => this.saveProject()
        });
        
        registry.registerCommand(OpenMCProjectCommands.SAVE_PROJECT_AS, {
            execute: () => this.saveProjectAs()
        });
    }

    private async newProject(): Promise<void> {
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
        await this.openDashboard();
    }

    private async openProject(): Promise<void> {
        await this.openDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).openProject();
        }
    }

    private async saveProject(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProject();
        }
    }

    private async saveProjectAs(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProjectAs();
        }
    }

    private async openDashboard(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
    }
}
