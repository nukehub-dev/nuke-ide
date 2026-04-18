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
 * OpenMC OpenHandler Contribution
 * 
 * Handles opening .nuke-openmc project files and widget tracking.
 * 
 * @module openmc-studio/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    OpenHandler,
    FrontendApplicationContribution,
    WidgetOpenerOptions,
    Widget,
    WidgetManager,
    ApplicationShell
} from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { Emitter } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';

import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { OpenMCStateManager } from '../openmc-state-manager';
import { SimulationDashboardWidget } from '../widgets/simulation-dashboard/simulation-dashboard-widget';

@injectable()
export class OpenMCOpenHandlerContribution implements OpenHandler, FrontendApplicationContribution {
    readonly id = 'openmc-studio';
    readonly label = 'OpenMC Project';
    readonly priority = 200;
    
    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;
    
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    
    @inject(FileService)
    protected readonly fileService: FileService;

    private currentWidget?: SimulationDashboardWidget;
    private _onDidChangeCurrentWidget = new Emitter<void>();
    readonly onDidChangeCurrentWidget = this._onDidChangeCurrentWidget.event;

    /**
     * Check if this handler can open the given URI.
     */
    canHandle(uri: URI, options?: WidgetOpenerOptions): number {
        if (uri.path.ext === '.nuke-openmc') {
            return 200; // High priority for .nuke-openmc files
        }
        return 0;
    }
    
    /**
     * Open a .nuke-openmc project file.
     */
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
    
    /**
     * Initialize widget tracking.
     */
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

    /**
     * Get the current dashboard widget (if active).
     */
    getCurrentWidget(): SimulationDashboardWidget | undefined {
        return this.currentWidget;
    }
}
