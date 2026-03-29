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
 * DAGMC Editor Contribution
 * 
 * Registers the DAGMC Editor widget and menu commands.
 * 
 * @module openmc-studio/browser
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { WidgetManager, ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { OpenMCStudioMenus } from '../openmc-studio-contribution';
import { DAGMCEditorWidget } from './dagmc-editor-widget';

export const OpenDAGMCEditorCommand = {
    id: 'openmc.openDagmcEditor',
    label: 'DAGMC Editor'
};

@injectable()
export class DAGMCEditorContribution implements CommandContribution, MenuContribution, FrontendApplicationContribution {

    @inject(WidgetManager)
    protected readonly widgetManager!: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell!: ApplicationShell;

    onStart(): void {
        // Contribution started
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(OpenDAGMCEditorCommand, {
            execute: () => this.openDAGMCEditor()
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        // Add to OpenMC Geometry menu
        menus.registerMenuAction(
            OpenMCStudioMenus.OPENMC_GEOMETRY,
            {
                commandId: OpenDAGMCEditorCommand.id,
                label: 'DAGMC Editor',
                order: 'b'
            }
        );
    }

    async openDAGMCEditor(filePath?: string): Promise<DAGMCEditorWidget> {
        const widget = await this.widgetManager.getOrCreateWidget<DAGMCEditorWidget>(DAGMCEditorWidget.ID);
        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);
        
        // If file path provided, load it
        if (filePath) {
            await widget.loadFile(filePath);
        }
        
        return widget;
    }
}
