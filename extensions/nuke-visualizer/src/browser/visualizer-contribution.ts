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
import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { AbstractViewContribution, OpenHandler, FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { VisualizerWidget } from './visualizer-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { CommonMenus } from '@theia/core/lib/browser';

export const VisualizerCommand = {
    id: VisualizerWidget.ID,
    label: 'Open Nuke Visualizer'
};

@injectable()
export class VisualizerContribution extends AbstractViewContribution<VisualizerWidget> implements OpenHandler, FrontendApplicationContribution {
    readonly id = 'nuke-visualizer.opener';
    readonly label = 'Open in Nuke Visualizer';

    @inject(FileService)
    protected readonly fileService: FileService;

    constructor() {
        super({
            widgetId: VisualizerWidget.ID,
            widgetName: VisualizerWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main',
            }
        });
    }

    async onStart(app: FrontendApplication): Promise<void> {
        // Force closing the widget on refresh to prevent potential restoration hangs
        // This is a safety measure suggested by the user
        const widget = app.shell.getWidgets('main').find(w => w.id === VisualizerWidget.ID);
        if (widget) {
            console.log('[Visualizer] Closing Nuke Visualizer widget on startup to avoid hangs');
            widget.close();
        }
    }

    override registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(VisualizerCommand, {
            execute: () => this.openView({ reveal: true, activate: true }),
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.VIEW, {
            commandId: VisualizerCommand.id,
            label: VisualizerCommand.label,
            order: 'a20'
        });
    }

    canHandle(uri: URI): number {
        const ext = uri.path.ext.toLowerCase();
        // Prioritize nuclear engineering file formats
        if (ext === '.h5m') {
            return 1000; // High priority for DAGMC files
        }
        if (['.vtk', '.vtu', '.vtp', '.vts', '.vtr', '.pvtu', '.pvtp'].includes(ext)) {
            return 500; // Medium priority for VTK files
        }
        if (['.stl', '.ply', '.obj'].includes(ext)) {
            return 100; // Low priority for mesh files
        }
        return 0;
    }

    async open(uri: URI): Promise<VisualizerWidget> {
        // Open or activate visualizer widget using AbstractViewContribution's openView
        const widget = await this.openView({ activate: true });
        
        // Load the file into the visualization
        await widget.loadFile(uri);
        
        return widget;
    }
}
