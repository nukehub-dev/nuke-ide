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

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { WidgetManager, ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { OpenMCStudioCommands, OpenMCStudioMenus } from '../openmc-studio-contribution';
import { TallyConfiguratorWidget } from './tally-configurator-widget';

@injectable()
export class TallyConfiguratorContribution implements CommandContribution, MenuContribution, FrontendApplicationContribution {

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    onStart(): void {
        // Contribution started
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(OpenMCStudioCommands.OPEN_TALLY_CONFIGURATOR, {
            execute: () => this.openTallyConfigurator()
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        // Add to OpenMC View menu
        menus.registerMenuAction(
            OpenMCStudioMenus.OPENMC_VIEW,
            {
                commandId: OpenMCStudioCommands.OPEN_TALLY_CONFIGURATOR.id,
                label: 'Tally Configurator',
                order: 'c'
            }
        );
    }

    async openTallyConfigurator(): Promise<TallyConfiguratorWidget> {
        const widget = await this.widgetManager.getOrCreateWidget<TallyConfiguratorWidget>(TallyConfiguratorWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
        return widget;
    }
}
