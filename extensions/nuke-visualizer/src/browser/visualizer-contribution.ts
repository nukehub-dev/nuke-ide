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
import { AbstractViewContribution, OpenHandler, FrontendApplicationContribution, FrontendApplication, WidgetManager } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { VisualizerWidget } from './visualizer-widget';
import { NukeMenus } from 'nuke-core/lib/browser/nuke-core-menus';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { VisualizerBackendService } from '../common/visualizer-protocol';

export const VisualizerCommand = {
    id: VisualizerWidget.ID,
    label: 'Open Visualizer'
};

export namespace NukeVisualizerMenus {
    export const VISUALIZER = [...NukeMenus.TOOLS, '2_visualizer'];

    export const VISUALIZER_STATEPOINT = [...VISUALIZER, '1_statepoint'];
    export const VISUALIZER_TALLY = [...VISUALIZER, '2_tally'];
    export const VISUALIZER_DEPLETION = [...VISUALIZER, '3_depletion'];
    export const VISUALIZER_GEOMETRY = [...VISUALIZER, '4_geometry'];
    export const VISUALIZER_MATERIAL = [...VISUALIZER, '5_material'];
    export const VISUALIZER_PLOT = [...VISUALIZER, '6_plot'];
}

@injectable()
export class VisualizerContribution extends AbstractViewContribution<VisualizerWidget> implements OpenHandler, FrontendApplicationContribution {
    readonly id = 'nuke-visualizer.opener';
    readonly label = 'Open in Nuke Visualizer';

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend: VisualizerBackendService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(FrontendApplication)
    protected readonly app: FrontendApplication;

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
        // Multi-instance support enabled, no longer need to force-close singletons
    }

    override registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(VisualizerCommand, {
            execute: () => this.openView({ reveal: true, activate: true }),
        });
    }

    override registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(NukeVisualizerMenus.VISUALIZER, {
            commandId: VisualizerCommand.id,
            label: VisualizerCommand.label,
            order: '0_main'
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
        const filePath = uri.path.toString();
        
        // Find existing widget for this file
        const widgets = this.app.shell.getWidgets('main');
        const existing = widgets.find(w => w instanceof VisualizerWidget && w.id.endsWith(filePath)) as VisualizerWidget;
        
        if (existing) {
            console.log(`[Visualizer] Found existing widget for ${filePath}, activating: ${existing.id}`);
            this.app.shell.activateWidget(existing.id);
            await existing.loadFile(uri);
            return existing;
        }

        console.log(`[Visualizer] Creating new widget for ${filePath}`);
        
        // Create new widget via factory with options
        const widget = await this.widgetManager.getOrCreateWidget(VisualizerWidget.ID, { 
            uri: uri.toString() 
        }) as VisualizerWidget;
        
        // Ensure ID is unique and set correctly
        widget.setUri(uri);

        // Add to shell if not already there
        if (!widget.isAttached) {
            this.app.shell.addWidget(widget, { area: 'main' });
        }
        
        // Reveal and activate
        this.app.shell.activateWidget(widget.id);

        // Load the file
        await widget.loadFile(uri);
        
        return widget;
    }
}
