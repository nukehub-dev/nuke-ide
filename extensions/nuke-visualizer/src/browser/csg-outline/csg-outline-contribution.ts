// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { CsgOutlineWidget } from './csg-outline-widget';

/** Command opening the CSG Outline sidebar (right area). */
export const OpenCsgOutlineCommand = {
    id: 'nuke-visualizer.open-csg-outline',
    label: 'Open CSG Outline',
    category: 'Visualizer'
};

/**
 * Command contribution behind the CSG Outline sidebar: opens the panel in
 * the right area, following the Viewer Settings open pattern (widget manager
 * lookup, add to shell, activate).
 */
@injectable()
export class CsgOutlineContribution implements CommandContribution {
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(OpenCsgOutlineCommand, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget(CsgOutlineWidget.ID);
                await this.shell.addWidget(widget, { area: 'right' });
                await this.shell.activateWidget(widget.id);
            }
        });
    }
}
