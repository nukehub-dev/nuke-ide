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
    /** Command category for all project management commands. */
    export const CATEGORY = 'OpenMC/Project';

    /** Create a new OpenMC project, resetting the current state. */
    export const NEW_PROJECT: Command = {
        id: 'openmc.project.new',
        category: CATEGORY,
        label: 'New Project'
    };

    /** Open an existing OpenMC project from disk. */
    export const OPEN_PROJECT: Command = {
        id: 'openmc.project.open',
        category: CATEGORY,
        label: 'Open Project...'
    };

    /** Save the current OpenMC project. */
    export const SAVE_PROJECT: Command = {
        id: 'openmc.project.save',
        category: CATEGORY,
        label: 'Save Project'
    };

    /** Save the current OpenMC project under a new name or location. */
    export const SAVE_PROJECT_AS: Command = {
        id: 'openmc.project.saveAs',
        category: CATEGORY,
        label: 'Save Project As...'
    };
}

/**
 * Project command handler for OpenMC Studio.
 *
 * Manages project lifecycle operations including creating new projects,
 * opening existing ones, and saving project state.
 *
 * @see {@link OpenMCProjectCommands} for available command identifiers
 * @see {@link SimulationDashboardWidget} for the widget that handles persistence
 */
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

    /**
     * Register project commands with the command registry.
     * @param registry - The Theia command registry
     */
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

    /**
     * Reset the application state and open a fresh project in the dashboard.
     */
    private async newProject(): Promise<void> {
        this.stateManager.reset();
        this.messageService.info('Created new OpenMC project');
        await this.openDashboard();
    }

    /**
     * Open the dashboard and trigger the project's open file dialog.
     */
    private async openProject(): Promise<void> {
        await this.openDashboard();
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).openProject();
        }
    }

    /**
     * Save the current project through the simulation dashboard widget.
     */
    private async saveProject(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProject();
        }
    }

    /**
     * Save the current project under a new name through the simulation dashboard widget.
     */
    private async saveProjectAs(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(SimulationDashboardWidget.ID);
        if (widget instanceof SimulationDashboardWidget) {
            await (widget as any).saveProjectAs();
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
}
