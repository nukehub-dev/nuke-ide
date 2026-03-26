// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { SysmonWidget } from './sysmon-widget';

export const SYSMON_OPEN_DASHBOARD_COMMAND = {
    id: 'sysmon.openDashboard',
    label: 'Open System Monitor'
};

@injectable()
export class SysmonCommandContribution implements CommandContribution {
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(SYSMON_OPEN_DASHBOARD_COMMAND, {
            execute: async () => {
                const widget = await this.widgetManager.getOrCreateWidget(SysmonWidget.ID);
                // Add to left sidebar like Explorer
                this.shell.addWidget(widget, { area: 'main' });
                this.shell.activateWidget(widget.id);
            }
        });
    }
}
