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
import { Command, CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common';
import { 
    QuickInputService, 
    QuickPickValue
} from '@theia/core/lib/browser';
import { 
    LabelProvider, 
    ApplicationShell,
    FrontendApplicationContribution,
    OpenHandler,
    WidgetOpenerOptions,
    Widget
} from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WidgetManager } from '@theia/core/lib/browser';
import { OpenMCService, TallyVisualizationOptions } from './openmc-service';
import { OpenMCTallySelector } from './tally-selector';
import { OpenMCTallyTreeWidget } from './openmc-tally-tree';

export namespace OpenMCCommands {
    export const OPENMC_CATEGORY = 'OpenMC';
    
    export const LOAD_STATEPOINT: Command = {
        id: 'openmc.load-statepoint',
        category: OPENMC_CATEGORY,
        label: 'Load Statepoint File...',
        iconClass: 'codicon codicon-database'
    };
    
    export const VISUALIZE_TALLY: Command = {
        id: 'openmc.visualize-tally',
        category: OPENMC_CATEGORY,
        label: 'Visualize Tally...',
        iconClass: 'codicon codicon-graph'
    };
    
    export const VISUALIZE_SOURCE: Command = {
        id: 'openmc.visualize-source',
        category: OPENMC_CATEGORY,
        label: 'Visualize Source Distribution...',
        iconClass: 'codicon codicon-debug-breakpoint-log'
    };
    
    export const OVERLAY_TALLY_ON_GEOMETRY: Command = {
        id: 'openmc.overlay-tally',
        category: OPENMC_CATEGORY,
        label: 'Overlay Tally on Geometry...',
        iconClass: 'codicon codicon-layers'
    };
    
    export const SHOW_TALLY_INFO: Command = {
        id: 'openmc.show-tally-info',
        category: OPENMC_CATEGORY,
        label: 'Show Tally Information',
        iconClass: 'codicon codicon-info'
    };
    
    export const DISCOVER_OPENMC_FILES: Command = {
        id: 'openmc.discover-files',
        category: OPENMC_CATEGORY,
        label: 'Discover OpenMC Files in Directory...',
        iconClass: 'codicon codicon-search'
    };
}

@injectable()
export class OpenMCContribution implements FrontendApplicationContribution, OpenHandler {
    readonly id = 'openmc';
    readonly label = 'OpenMC Files';
    readonly priority = 100;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(MessageService)
    protected readonly messageService: MessageService;
    
    private tallyTreeWidget: OpenMCTallyTreeWidget | undefined;

    canHandle(uri: URI, options?: WidgetOpenerOptions): number {
        const name = uri.path.base.toLowerCase();
        
        // Handle statepoint files
        if (name.startsWith('statepoint') && name.endsWith('.h5')) {
            return 200;
        }
        
        // Handle source files
        if (name === 'source.h5') {
            return 200;
        }
        
        // Handle DAGMC geometry files
        if (name.endsWith('.h5m')) {
            return 150;
        }
        
        return 0;
    }

    async open(uri: URI, options?: WidgetOpenerOptions): Promise<Widget> {
        const name = uri.path.base.toLowerCase();
        
        if (name.startsWith('statepoint') && name.endsWith('.h5')) {
            // Load statepoint and show tally tree in sidebar
            const progress = await this.messageService.showProgress({
                text: 'Loading statepoint file...',
                options: { cancelable: false }
            });

            try {
                const info = await this.openmcService.loadStatepoint(uri);
                if (info && info.nTallies > 0) {
                    progress.report({ message: 'Opening tally tree...' });
                    await this.showTallyTree(uri);
                }
            } finally {
                progress.cancel();
            }
        } else if (name === 'source.h5') {
            // Visualize source distribution
            await this.openmcService.visualizeSource(uri);
        } else if (name.endsWith('.h5m')) {
            // Check for statepoint in same directory
            const files = await this.openmcService.discoverFilesInDirectory(uri.parent);
            if (files.statepoint) {
                // Ask user if they want to overlay tally
                const choice = await this.quickInput.showQuickPick([
                    { label: '$(graph) Visualize Geometry Only', value: 'geometry' },
                    { label: '$(layers) Overlay Tally Results', value: 'overlay' },
                ], {
                    title: 'OpenMC Geometry',
                    placeholder: 'Choose visualization option'
                });
                
                if (choice?.value === 'overlay') {
                    await this.showTallySelectorForOverlay(uri, files.statepoint);
                } else {
                    // Fall back to standard DAGMC visualization
                    // This will be handled by the existing visualizer contribution
                    throw new Error('Use standard visualizer for geometry-only view');
                }
            } else {
                // No statepoint, use standard visualization
                throw new Error('Use standard visualizer for geometry-only view');
            }
        }
        
        // Return a dummy widget - actual visualization is handled by VisualizerWidget
        return new Widget();
    }

    initialize(): void {
        // Register keyboard shortcuts or other initialization
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.LOAD_STATEPOINT, {
            execute: () => this.loadStatepointCommand()
        });

        registry.registerCommand(OpenMCCommands.VISUALIZE_TALLY, {
            execute: () => this.visualizeTallyCommand(),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });

        registry.registerCommand(OpenMCCommands.VISUALIZE_SOURCE, {
            execute: () => this.visualizeSourceCommand()
        });

        registry.registerCommand(OpenMCCommands.OVERLAY_TALLY_ON_GEOMETRY, {
            execute: () => this.overlayTallyCommand()
        });

        registry.registerCommand(OpenMCCommands.SHOW_TALLY_INFO, {
            execute: () => this.showTallyInfoCommand(),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });

        registry.registerCommand(OpenMCCommands.DISCOVER_OPENMC_FILES, {
            execute: () => this.discoverFilesCommand()
        });
    }

    registerMenus(registry: MenuModelRegistry): void {
        // Register OpenMC menu in the menubar
        registry.registerMenuAction(['menubar', 'openmc'], {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            label: 'OpenMC',
            order: '10'
        });

        // Add items to OpenMC menu
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            order: '1'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.VISUALIZE_TALLY.id,
            order: '2'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.VISUALIZE_SOURCE.id,
            order: '3'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.OVERLAY_TALLY_ON_GEOMETRY.id,
            order: '4'
        });

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.SHOW_TALLY_INFO.id,
            order: '5'
        });

        // Add context menu for OpenMC files
        registry.registerMenuAction(['explorer-context-menu', 'openmc'], {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            when: 'resourceExtname == .h5',
            order: '1'
        });
    }

    private async loadStatepointCommand(): Promise<void> {
        const uri = await this.quickInput.showQuickPick(
            await this.getH5Files(),
            {
                title: 'Select OpenMC Statepoint File',
                placeholder: 'Choose a statepoint.h5 file'
            }
        );

        if (uri) {
            // Show loading progress
            const progress = await this.messageService.showProgress({
                text: 'Loading statepoint file...',
                options: { cancelable: false }
            });

            try {
                await this.openmcService.loadStatepoint(new URI(uri.value));
                
                // Show tally tree directly
                const tallies = this.openmcService.getCurrentTallies();
                if (tallies.length > 0) {
                    progress.report({ message: 'Opening tally tree...' });
                    await this.showTallyTree(new URI(uri.value));
                }
            } finally {
                progress.cancel();
            }
        }
    }

    private async visualizeTallyCommand(): Promise<void> {
        const statepoint = this.openmcService.getCurrentStatepoint();
        if (!statepoint) {
            return;
        }

        await this.showTallyTree(new URI(statepoint.file));
    }

    private async visualizeSourceCommand(): Promise<void> {
        const uri = await this.quickInput.showQuickPick(
            await this.getSourceFiles(),
            {
                title: 'Select Source File',
                placeholder: 'Choose a source.h5 file'
            }
        );

        if (uri) {
            await this.openmcService.visualizeSource(new URI(uri.value));
        }
    }

    private async overlayTallyCommand(): Promise<void> {
        // Select geometry file
        const geometryUri = await this.quickInput.showQuickPick(
            await this.getGeometryFiles(),
            {
                title: 'Select Geometry File',
                placeholder: 'Choose a DAGMC .h5m file'
            }
        );

        if (!geometryUri) return;

        // Select statepoint file
        const statepointUri = await this.quickInput.showQuickPick(
            await this.getStatepointFiles(),
            {
                title: 'Select Statepoint File',
                placeholder: 'Choose a statepoint.h5 file'
            }
        );

        if (!statepointUri) return;

        await this.showTallySelectorForOverlay(
            new URI(geometryUri.value),
            new URI(statepointUri.value)
        );
    }

    private async showTallyInfoCommand(): Promise<void> {
        const statepoint = this.openmcService.getCurrentStatepoint();
        const tallies = this.openmcService.getCurrentTallies();

        if (!statepoint || tallies.length === 0) {
            return;
        }

        const lines: string[] = [
            `OpenMC Statepoint: ${statepoint.file}`,
            `Batches: ${statepoint.batches}`,
            statepoint.kEff !== undefined ? `k-effective: ${statepoint.kEff.toFixed(6)} ± ${statepoint.kEffStd?.toFixed(6)}` : '',
            ``,
            `Tallies (${tallies.length}):`,
            ...tallies.map(t => {
                const desc = this.openmcService.getTallyDescription(t);
                return `  Tally ${t.id}: ${t.name}\n    ${desc}`;
            })
        ];

        // Show info in a message or output channel
        // For now, use a simple notification
        console.log(lines.join('\n'));
    }

    private async discoverFilesCommand(): Promise<void> {
        const workspaceRoots = this.workspaceService.tryGetRoots();
        if (workspaceRoots.length === 0) {
            return;
        }

        for (const root of workspaceRoots) {
            const rootUri = new URI((root as any).resource || root);
            const files = await this.openmcService.discoverFilesInDirectory(rootUri);
            
            const parts: string[] = [`Directory: ${rootUri.toString()}`];
            if (files.geometry) parts.push(`  Geometry: ${files.geometry.path.base}`);
            if (files.statepoint) parts.push(`  Statepoint: ${files.statepoint.path.base}`);
            if (files.source) parts.push(`  Source: ${files.source.path.base}`);

            if (parts.length > 1) {
                console.log(parts.join('\n'));
            }
        }
    }

    private async showTallyTree(statepointUri: URI): Promise<void> {
        const info = this.openmcService.getCurrentStatepoint();
        const tallies = this.openmcService.getCurrentTallies();
        
        if (tallies.length === 0 || !info) {
            return;
        }

        // Get or create the tally tree widget
        let widget = this.tallyTreeWidget;
        if (!widget || widget.isDisposed) {
            widget = await this.widgetManager.getOrCreateWidget<OpenMCTallyTreeWidget>(OpenMCTallyTreeWidget.ID);
            this.tallyTreeWidget = widget;
        }
        
        // Update the widget state
        widget.setStatepoint(statepointUri, info, tallies);
        
        // Add to left sidebar if not already there
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'left' });
        }
        
        // Activate the widget
        await this.shell.activateWidget(widget.id);
        
        // Listen for tally selection from tree (only once)
        if (!(widget as any)._selectionHandlerSet) {
            (widget as any)._selectionHandlerSet = true;
            widget.onTallySelected(async selection => {
                const options: TallyVisualizationOptions = {
                    tallyId: selection.tallyId,
                    score: selection.score,
                    nuclide: selection.nuclide
                };
                // visualizeMeshTally handles activation internally
                await this.openmcService.visualizeMeshTally(statepointUri, options);
            });
        }
    }

    private async showTallySelectorForOverlay(geometryUri: URI, statepointUri: URI): Promise<void> {
        // Load tallies from statepoint
        await this.openmcService.loadTallyList(statepointUri);
        const tallies = this.openmcService.getCurrentTallies();
        
        if (tallies.length === 0) {
            return;
        }

        const selector = new OpenMCTallySelector(this.quickInput);
        const selection = await selector.show(tallies);

        if (selection) {
            const options: TallyVisualizationOptions = {
                tallyId: selection.tallyId,
                score: selection.score,
                nuclide: selection.nuclide,
                colorMap: selection.colorMap
            };

            await this.openmcService.visualizeTallyOnGeometry(geometryUri, statepointUri, options);
        }
    }

    private async getH5Files(): Promise<QuickPickValue<string>[]> {
        // Return empty - user will input path manually
        // In a full implementation, this would walk the workspace directories
        return [];
    }

    private async getStatepointFiles(): Promise<QuickPickValue<string>[]> {
        return [];
    }

    private async getSourceFiles(): Promise<QuickPickValue<string>[]> {
        return [];
    }

    private async getGeometryFiles(): Promise<QuickPickValue<string>[]> {
        return [];
    }
}
