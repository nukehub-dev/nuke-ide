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

/**
 * Handles opening `.nuke-openmc` project files and tracks the active simulation dashboard widget.
 *
 * Implements both {@link OpenHandler} (for file-opening priority and logic) and
 * {@link FrontendApplicationContribution} (for lifecycle initialization).
 * Binds to both interfaces in the frontend module to activate file handling and widget tracking.
 *
 * @see {@link openmc-command-contribution.ts} for project commands
 * @see {@link SimulationDashboardWidget} for the target widget
 */
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

    /** Currently active simulation dashboard widget, if any. */
    private currentWidget?: SimulationDashboardWidget;
    private _onDidChangeCurrentWidget = new Emitter<void>();
    readonly onDidChangeCurrentWidget = this._onDidChangeCurrentWidget.event;

    /**
     * Determine whether this handler can open the given URI.
     * Returns a high priority (200) for `.nuke-openmc` project files, otherwise 0.
     * @param uri - The URI to evaluate
     * @param options - Optional widget opener options
     * @returns Priority score; higher values take precedence over other handlers
     */
    canHandle(uri: URI, options?: WidgetOpenerOptions): number {
        if (uri.path.ext === '.nuke-openmc') {
            return 200; // High priority for .nuke-openmc files
        }
        return 0;
    }

    /**
     * Open a `.nuke-openmc` project file, restore its state, and reveal the simulation dashboard.
     * @param uri - URI of the project file to open
     * @param options - Optional widget opener options
     * @returns The activated {@link SimulationDashboardWidget}
     * @throws When the file is unreadable or has an invalid format
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
     * Initialize widget tracking to monitor when the simulation dashboard becomes active or inactive.
     * Fires {@link onDidChangeCurrentWidget} on focus changes.
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
     * Get the currently active simulation dashboard widget, if any.
     * @returns The active dashboard widget, or `undefined` if none is focused
     */
    getCurrentWidget(): SimulationDashboardWidget | undefined {
        return this.currentWidget;
    }
}
