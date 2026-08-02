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
import { AbstractViewContribution } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { NukeToolsSidebarWidget } from './nuke-tools-sidebar-widget';

export namespace NukeToolsSidebarCommands {
    export const FOCUS = {
        id: 'nuke.tools.focus',
        label: 'Nuke: Focus Tools Sidebar'
    };
}

@injectable()
export class NukeToolsSidebarContribution extends AbstractViewContribution<NukeToolsSidebarWidget> {
    constructor() {
        super({
            widgetId: NukeToolsSidebarWidget.ID,
            widgetName: NukeToolsSidebarWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 200
            },
            toggleCommandId: NukeToolsSidebarCommands.FOCUS.id
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand(NukeToolsSidebarCommands.FOCUS, {
            execute: () => this.openView({ activate: true })
        });
    }
}
