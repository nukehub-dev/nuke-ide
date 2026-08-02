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
 * Nuke Tools Sidebar View Contribution
 *
 * Registers the Nuke Tools sidebar as a first-class Theia view and exposes a
 * command to focus it from the command palette.
 *
 * @module nuke-core/browser/tools-sidebar
 */

import { injectable } from '@theia/core/shared/inversify';
import { AbstractViewContribution, FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { NukeToolsSidebarWidget } from './nuke-tools-sidebar-widget';

export namespace NukeToolsSidebarCommands {
    export const FOCUS = {
        id: 'nuke.tools.focus',
        label: 'Nuke: Focus Tools Sidebar'
    };
}

/** Storage key tracking that the sidebar has been added to the layout once. */
const SIDEBAR_ADDED_KEY = 'nuke-tools-sidebar:added';

@injectable()
export class NukeToolsSidebarContribution
    extends AbstractViewContribution<NukeToolsSidebarWidget>
    implements FrontendApplicationContribution
{
    constructor() {
        super({
            widgetId: NukeToolsSidebarWidget.ID,
            widgetName: NukeToolsSidebarWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                // Place the Nuke Tools icon between Source Control (Theia rank 300) and Extensions (Theia rank 500).
                rank: 400
            }
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(NukeToolsSidebarCommands.FOCUS, {
            execute: () => this.openView({ activate: true })
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        const widget = await this.widget;
        if (!widget.isAttached) {
            app.shell.addWidget(widget, this.defaultViewOptions);
            this.markSidebarAdded();
        }
    }

    async onDidInitializeLayout(app: FrontendApplication): Promise<void> {
        const widget = await this.widget;
        if (!widget.isAttached && !this.hasSidebarBeenAdded()) {
            app.shell.addWidget(widget, this.defaultViewOptions);
            this.markSidebarAdded();
        }
    }

    protected markSidebarAdded(): void {
        try {
            localStorage.setItem(SIDEBAR_ADDED_KEY, 'true');
        } catch {
            // Ignore storage errors (e.g. private browsing).
        }
    }

    protected hasSidebarBeenAdded(): boolean {
        try {
            return localStorage.getItem(SIDEBAR_ADDED_KEY) === 'true';
        } catch {
            return false;
        }
    }
}
