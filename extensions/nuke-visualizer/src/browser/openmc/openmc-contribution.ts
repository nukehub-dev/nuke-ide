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
    QuickPickValue,
    AbstractViewContribution
} from '@theia/core/lib/browser';
import { 
    LabelProvider, 
    ApplicationShell,
    FrontendApplicationContribution,
    OpenHandler,
    WidgetOpenerOptions,
    Widget,
    FrontendApplication
} from '@theia/core/lib/browser';
import { SelectionService } from '@theia/core/lib/common';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WidgetManager } from '@theia/core/lib/browser';
import { NavigatorDiff } from '@theia/navigator/lib/browser/navigator-diff';
import { DiffUris } from '@theia/core/lib/browser/diff-uris';
import { OpenMCService, TallyVisualizationOptions } from './openmc-service';
import { OpenMCTallySelector } from './tally-selector';
import { OpenMCTallyTreeWidget, TallySelection } from './openmc-tally-tree';
import { OpenMCPlotWidget } from './openmc-plot-widget';
import { OpenMCHeatmapWidget } from './openmc-heatmap-widget';
import { XSPlotWidget } from './xs-plot-widget';
import { OpenMCDepletionWidget } from './openmc-depletion-widget';
import { OpenMCDepletionCompareWidget } from './openmc-depletion-compare-widget';
import { OpenMCGeometryTreeWidget, GeometryView3DRequest } from './openmc-geometry-tree';
import { OpenMCGeometry3DWidget } from './openmc-geometry-3d-widget';
import { OpenMCMaterialExplorerWidget } from './openmc-material-explorer';
import { OpenMCOverlapWidget } from './openmc-overlap-widget';
import { PlotlyService } from '../plotly/plotly-service';
import { PlotlyUtils } from '../plotly/plotly-utils';
import { PlotlyFigure } from '../../common/visualizer-protocol';

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
    
    export const PLOT_CROSS_SECTIONS: Command = {
        id: 'openmc.plot-xs',
        category: OPENMC_CATEGORY,
        label: 'Plot Cross-Sections...',
        iconClass: 'codicon codicon-graph-line'
    };
    
    export const OPEN_DEPLETION_VIEWER: Command = {
        id: 'openmc.open-depletion',
        category: OPENMC_CATEGORY,
        label: 'View Depletion Results...',
        iconClass: 'codicon codicon-flame'
    };
    
    export const COMPARE_DEPLETION: Command = {
        id: 'openmc.compare-depletion',
        category: OPENMC_CATEGORY,
        label: 'Compare Depletion Results...',
        iconClass: 'codicon codicon-git-compare'
    };
    
    export const COMPARE_DEPLETION_WITH: Command = {
        id: 'openmc.compare-depletion-with',
        category: OPENMC_CATEGORY,
        label: 'Compare Depletion Results',
        iconClass: 'codicon codicon-git-compare'
    };
    
    export const VIEW_GEOMETRY_HIERARCHY: Command = {
        id: 'openmc.view-geometry-hierarchy',
        category: OPENMC_CATEGORY,
        label: 'View Geometry Hierarchy...',
        iconClass: 'codicon codicon-repo'
    };
    
    export const VIEW_MATERIALS: Command = {
        id: 'openmc.view-materials',
        category: OPENMC_CATEGORY,
        label: 'View Materials...',
        iconClass: 'codicon codicon-flask'
    };
    
    export const CHECK_OVERLAPS: Command = {
        id: 'openmc.check-overlaps',
        category: OPENMC_CATEGORY,
        label: 'Check Geometry Overlaps...',
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

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(SelectionService)
    protected readonly selectionService: SelectionService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(PlotlyService)
    protected readonly plotlyService: PlotlyService;

    @inject(NavigatorDiff)
    protected readonly navigatorDiff: NavigatorDiff;
    
    private tallyTreeWidget: OpenMCTallyTreeWidget | undefined;

    private async getPlotWidget(tallyId: number, type: string): Promise<OpenMCPlotWidget> {
        const widgetId = `${OpenMCPlotWidget.ID}:${tallyId}:${type}`;
        return this.widgetManager.getOrCreateWidget<OpenMCPlotWidget>(OpenMCPlotWidget.ID, {
            id: widgetId
        } as any);
    }

    private async getHeatmapWidget(tallyId: number, score?: string): Promise<OpenMCHeatmapWidget> {
        const widgetId = `${OpenMCHeatmapWidget.ID}:${tallyId}:${score || 'default'}`;
        return this.widgetManager.getOrCreateWidget<OpenMCHeatmapWidget>(OpenMCHeatmapWidget.ID, {
            id: widgetId
        } as any);
    }

    private async getOrCreateXSPlotWidget(): Promise<XSPlotWidget> {
        return this.widgetManager.getOrCreateWidget<XSPlotWidget>(XSPlotWidget.ID, {
            id: XSPlotWidget.ID
        } as any);
    }

    canHandle(uri: URI, options?: WidgetOpenerOptions): number {
        // Handle diff URIs (comparison between files)
        if (DiffUris.isDiffUri(uri)) {
            const [uriA, uriB] = DiffUris.decode(uri);
            const isDepletionA = uriA?.path.base.includes('depletion') && uriA?.path.base.endsWith('.h5');
            const isDepletionB = uriB?.path.base.includes('depletion') && uriB?.path.base.endsWith('.h5');
            
            if (isDepletionA && isDepletionB) {
                return 1000; // Very high priority to catch and override default text diff
            }
        }

        const name = uri.path.base.toLowerCase();
        
        // Handle statepoint files
        if (name.startsWith('statepoint') && name.endsWith('.h5')) {
            return 200;
        }
        
        // Handle source files
        if (name === 'source.h5') {
            return 200;
        }
        
        // Handle depletion results files
        if (name.includes('depletion') && name.endsWith('.h5')) {
            return 200;
        }
        
        // Handle DAGMC geometry files
        if (name.endsWith('.h5m')) {
            return 150;
        }
        
        // Handle OpenMC geometry.xml files
        if (name === 'geometry.xml') {
            return 200;
        }
        
        // Handle OpenMC materials.xml files
        if (name === 'materials.xml') {
            return 200;
        }
        
        return 0;
    }

    async open(uri: URI, options?: WidgetOpenerOptions): Promise<Widget> {
        // Handle comparison URIs (e.g., diff://...)
        if (DiffUris.isDiffUri(uri)) {
            const [uriA, uriB] = DiffUris.decode(uri);
            if (uriA && uriB) {
                try {
                    const progress = await this.messageService.showProgress({
                        text: 'Loading comparison data...',
                        options: { cancelable: false }
                    });
                    try {
                        const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionCompareWidget>(
                            OpenMCDepletionCompareWidget.ID,
                            { id: `${OpenMCDepletionCompareWidget.ID}:${uriA.toString()}:${uriB.toString()}` } as any
                        );
                        await widget.setComparisonFiles(uriA, uriA.path.base, uriB, uriB.path.base);
                        if (!widget.isAttached) {
                            this.shell.addWidget(widget, { area: 'main' });
                        }
                        this.shell.activateWidget(widget.id);
                        return widget;
                    } finally {
                        progress.cancel();
                    }
                } catch (error) {
                    this.messageService.error(`Failed to open comparison: ${error}`);
                }
            }
        }

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
        } else if (name.includes('depletion') && name.endsWith('.h5')) {
            // Open depletion viewer
            await this.openDepletionFile(uri.toString(), uri.path.base);
        } else if (name === 'geometry.xml') {
            // Open geometry hierarchy viewer
            await this.openGeometryHierarchy(uri);
        } else if (name === 'materials.xml') {
            // Open materials explorer
            await this.openMaterialsExplorer(uri);
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

        registry.registerCommand(OpenMCCommands.PLOT_CROSS_SECTIONS, {
            execute: () => this.plotXSCommand()
        });
        
        registry.registerCommand(OpenMCCommands.OPEN_DEPLETION_VIEWER, {
            execute: () => this.openDepletionViewerCommand()
        });
        
        registry.registerCommand(OpenMCCommands.COMPARE_DEPLETION, {
            execute: () => this.compareDepletionCommand()
        });
        
        registry.registerCommand(OpenMCCommands.COMPARE_DEPLETION_WITH, {
            execute: async () => {
                const selection = this.selectionService.selection;
                
                // Handle multiple selection (exactly 2 files)
                if (Array.isArray(selection) && selection.length === 2) {
                    const uriA = selection[0] instanceof URI ? selection[0] : (selection[0] as any).uri;
                    const uriB = selection[1] instanceof URI ? selection[1] : (selection[1] as any).uri;
                    
                    if (uriA && uriB) {
                        const isDepletionA = uriA.path.base.includes('depletion') && uriA.path.base.endsWith('.h5');
                        const isDepletionB = uriB.path.base.includes('depletion') && uriB.path.base.endsWith('.h5');
                        
                        if (isDepletionA && isDepletionB) {
                            try {
                                const progress = await this.messageService.showProgress({
                                    text: 'Loading comparison data...',
                                    options: { cancelable: false }
                                });
                                try {
                                    const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionCompareWidget>(
                                        OpenMCDepletionCompareWidget.ID,
                                        { id: `${OpenMCDepletionCompareWidget.ID}:${uriA.toString()}:${uriB.toString()}` } as any
                                    );
                                    await widget.setComparisonFiles(uriA, uriA.path.base, uriB, uriB.path.base);
                                    if (!widget.isAttached) {
                                        this.shell.addWidget(widget, { area: 'main' });
                                    }
                                    this.shell.activateWidget(widget.id);
                                    return;
                                } finally {
                                    progress.cancel();
                                }
                            } catch (error) {
                                this.messageService.error(`Failed to open comparison: ${error}`);
                            }
                        }
                    }
                }
                
                // Fallback to single selection behavior
                let uri: URI | undefined;
                if (Array.isArray(selection) && selection.length > 0) {
                    uri = selection[0] instanceof URI ? selection[0] : (selection[0] as any).uri;
                } else if (selection instanceof URI) {
                    uri = selection;
                } else if (selection && 'uri' in selection) {
                    uri = (selection as any).uri;
                }
                
                if (uri) {
                    this.compareDepletionWithCommand(uri);
                } else {
                    this.messageService.error('No file selected');
                }
            }
        });
        
        registry.registerCommand(OpenMCCommands.VIEW_GEOMETRY_HIERARCHY, {
            execute: () => this.viewGeometryHierarchyCommand()
        });
        
        registry.registerCommand(OpenMCCommands.VIEW_MATERIALS, {
            execute: () => this.viewMaterialsCommand()
        });
        
        registry.registerCommand(OpenMCCommands.CHECK_OVERLAPS, {
            execute: () => this.checkOverlapsCommand()
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

        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.PLOT_CROSS_SECTIONS.id,
            order: '6'
        });
        
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.OPEN_DEPLETION_VIEWER.id,
            order: '7'
        });
        
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.COMPARE_DEPLETION.id,
            order: '8'
        });
        
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.VIEW_GEOMETRY_HIERARCHY.id,
            order: '9'
        });
        
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.VIEW_MATERIALS.id,
            order: '10'
        });
        
        registry.registerMenuAction(['openmc'], {
            commandId: OpenMCCommands.CHECK_OVERLAPS.id,
            order: '11'
        });

        // Add context menu for OpenMC files
        registry.registerMenuAction(['explorer-context-menu', 'openmc'], {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            when: 'resourceExtname == .h5',
            order: '1'
        });
        
        // Add context menu for depletion files (top level for better visibility)
        registry.registerMenuAction(['explorer-context-menu'], {
            commandId: OpenMCCommands.OPEN_DEPLETION_VIEWER.id,
            when: 'resourceFilename =~ /depletion.*\\.h5/',
            order: '2_openmc_depletion'
        });
        
        // Add compare option to context menu for depletion files (top level)
        registry.registerMenuAction(["explorer-context-menu"], {
            commandId: OpenMCCommands.COMPARE_DEPLETION_WITH.id,
            when: "resourceFilename =~ /depletion.*\\.h5/",
            order: "3_openmc_compare"
        });
        
        // Add context menu for materials.xml files
        registry.registerMenuAction(['explorer-context-menu'], {
            commandId: OpenMCCommands.VIEW_MATERIALS.id,
            when: "resourceFilename == materials.xml",
            order: '4_openmc_materials'
        });
        
        // Add context menu for geometry.xml files
        registry.registerMenuAction(['explorer-context-menu'], {
            commandId: OpenMCCommands.CHECK_OVERLAPS.id,
            when: "resourceFilename == geometry.xml",
            order: '5_openmc_overlaps'
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
        // Get source files from workspace
        const files = await this.getSourceFiles();
        
        // Add "Browse..." option
        const options: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse for file...', description: 'Select source.h5 file from any location' }
        ];
        
        if (files.length > 0) {
            options.push({ type: 'separator', label: 'Workspace Files' } as any, ...files);
        }

        const selection = await this.quickInput.showQuickPick(options, {
            title: 'Select Source File',
            placeholder: files.length > 0 ? 'Choose a file or browse...' : 'Browse for source.h5 file...'
        });

        if (!selection) return;

        if (selection.value === '__browse__') {
            // Open file dialog
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Source File',
                openLabel: 'Open',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'HDF5 Files': ['h5'],
                    'All Files': ['*']
                }
            });
            
            if (fileUri) {
                const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                await this.openmcService.visualizeSource(uri);
            }
        } else {
            await this.openmcService.visualizeSource(new URI(selection.value));
        }
    }

    private async overlayTallyCommand(): Promise<void> {
        // Get geometry files from workspace
        const geometryFiles = await this.getGeometryFiles();
        
        // Build geometry options with browse
        const geometryOptions: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse for geometry file...', description: 'Select DAGMC .h5m file from any location' }
        ];
        
        if (geometryFiles.length > 0) {
            geometryOptions.push({ type: 'separator', label: 'Workspace Files' } as any, ...geometryFiles);
        }

        // Select geometry file
        const geometrySelection = await this.quickInput.showQuickPick(geometryOptions, {
            title: 'Select Geometry File',
            placeholder: geometryFiles.length > 0 ? 'Choose a file or browse...' : 'Browse for DAGMC .h5m file...'
        });

        if (!geometrySelection) return;

        let geometryUri: URI;
        if (geometrySelection.value === '__browse__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Geometry File',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'DAGMC Files': ['h5m'],
                    'All Files': ['*']
                }
            });
            if (!fileUri) return;
            geometryUri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        } else {
            geometryUri = new URI(geometrySelection.value);
        }

        // Get statepoint files from workspace
        const statepointFiles = await this.getStatepointFiles();
        
        // Build statepoint options with browse
        const statepointOptions: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse for statepoint file...', description: 'Select statepoint.h5 file from any location' }
        ];
        
        if (statepointFiles.length > 0) {
            statepointOptions.push({ type: 'separator', label: 'Workspace Files' } as any, ...statepointFiles);
        }

        // Select statepoint file
        const statepointSelection = await this.quickInput.showQuickPick(statepointOptions, {
            title: 'Select Statepoint File',
            placeholder: statepointFiles.length > 0 ? 'Choose a file or browse...' : 'Browse for statepoint.h5 file...'
        });

        if (!statepointSelection) return;

        let statepointUri: URI;
        if (statepointSelection.value === '__browse__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Statepoint File',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'HDF5 Files': ['h5'],
                    'All Files': ['*']
                }
            });
            if (!fileUri) return;
            statepointUri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        } else {
            statepointUri = new URI(statepointSelection.value);
        }

        await this.showTallySelectorForOverlay(geometryUri, statepointUri);
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
        
        // Add to right sidebar if not already there
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'right' });
        }
        
        // Activate the widget
        await this.shell.activateWidget(widget.id);
        
        // Listen for tally selection from tree (only once)
        if (!(widget as any)._handlerSet) {
            (widget as any)._handlerSet = true;
            
            // Handle tally selection
            widget.onTallySelected(async (selection: TallySelection) => {
                console.log(`[OpenMC] Tally selected: id=${selection.tallyId}, action=${selection.action}`);
                const options: TallyVisualizationOptions = {
                    tallyId: selection.tallyId,
                    score: selection.score,
                    nuclide: selection.nuclide
                };
                
                try {
                    const currentTallies = this.openmcService.getCurrentTallies();
                    const tallyInfo = currentTallies.find(t => t.id === selection.tallyId);
                    
                    if (selection.action === 'visualize') {
                        console.log(`[OpenMC] Visualizing mesh tally ${selection.tallyId}`);
                        await this.openmcService.visualizeMeshTally(statepointUri, options);
                    } else if (selection.action === 'overlay-geometry') {
                        console.log(`[OpenMC] Overlaying tally ${selection.tallyId} on geometry`);
                        await this.handleOverlayOnGeometry(selection, statepointUri);
                    } else if (selection.action === 'spectrum') {
                        console.log(`[OpenMC] Plotting energy spectrum for tally ${selection.tallyId}`);
                        
                        // Resolve indices for spectrum plot
                        let scoreIdx = 0;
                        let nuclideIdx = 0;
                        if (tallyInfo) {
                            if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                scoreIdx = tallyInfo.scores.indexOf(selection.score);
                            }
                            if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                            }
                        }

                        const data = await this.openmcService.getEnergySpectrum(
                            statepointUri, 
                            selection.tallyId, 
                            scoreIdx,
                            nuclideIdx
                        );
                        console.log(`[OpenMC] Spectrum data received:`, data);
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spectrum');
                        plotWidget.setData(data, 'spectrum', `Tally ${selection.tallyId} Energy Spectrum`);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'spatial') {
                        console.log(`[OpenMC] Plotting spatial distribution for tally ${selection.tallyId}`);
                        
                        // Resolve indices for spatial plot
                        let scoreIdx = 0;
                        let nuclideIdx = 0;
                        if (tallyInfo) {
                            if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                scoreIdx = tallyInfo.scores.indexOf(selection.score);
                            }
                            if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                            }
                        }

                        const data = await this.openmcService.getSpatialPlot(
                            statepointUri, 
                            selection.tallyId, 
                            'z',
                            scoreIdx,
                            nuclideIdx
                        );
                        console.log(`[OpenMC] Spatial data received:`, data);
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spatial');
                        plotWidget.setData(data, 'spatial', `Tally ${selection.tallyId} Spatial Plot (Z-axis)`);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'heatmap') {
                        console.log(`[OpenMC] Creating 2D heatmap for tally ${selection.tallyId}`);
                        
                        // Resolve indices for heatmap
                        let scoreIdx = 0;
                        let nuclideIdx = 0;
                        let scoreName = 'total';
                        let nuclideName = 'total';
                        if (tallyInfo) {
                            if (selection.score && tallyInfo.scores.includes(selection.score)) {
                                scoreIdx = tallyInfo.scores.indexOf(selection.score);
                                scoreName = selection.score;
                            }
                            if (selection.nuclide && tallyInfo.nuclides.includes(selection.nuclide)) {
                                nuclideIdx = tallyInfo.nuclides.indexOf(selection.nuclide);
                                nuclideName = selection.nuclide;
                            }
                        }

                        const data = await this.openmcService.getHeatmapSlice(
                            statepointUri, 
                            selection.tallyId, 
                            'xy',
                            0,  // Start with first slice
                            scoreIdx,
                            nuclideIdx
                        );
                        console.log(`[OpenMC] Heatmap data received:`, data);
                        
                        if (data.error) {
                            this.messageService.error(`Heatmap error: ${data.error}`);
                            return;
                        }
                        
                        const heatmapWidget = await this.getHeatmapWidget(selection.tallyId, selection.score);
                        heatmapWidget.setData(
                            data,
                            statepointUri,
                            selection.tallyId,
                            scoreIdx,
                            nuclideIdx,
                            scoreName,
                            nuclideName,
                            `Tally ${selection.tallyId} 2D Heatmap`
                        );
                        if (!heatmapWidget.isAttached) {
                            this.shell.addWidget(heatmapWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(heatmapWidget.id);
                    } else if (selection.action === 'spectrum-all-scores' && tallyInfo) {
                        const data = await this.openmcService.getMultiScoreSpectrum(statepointUri, selection.tallyId, tallyInfo.scores);
                        const traces = PlotlyUtils.createMultiScoreTraces(data, 'spectrum');
                        const figure: PlotlyFigure = {
                            data: traces,
                            layout: {
                                xaxis: { title: { text: 'Energy [eV]' }, type: 'log' },
                                yaxis: { title: { text: 'Tally Value' }, type: 'log' }
                            },
                            title: `Tally ${selection.tallyId} All Scores Spectrum`
                        };
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spectrum-multi');
                        plotWidget.setFigure(figure);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'spatial-all-scores' && tallyInfo) {
                        const data = await this.openmcService.getMultiScoreSpatialPlot(statepointUri, selection.tallyId, 'z', tallyInfo.scores);
                        const traces = PlotlyUtils.createMultiScoreTraces(data, 'spatial');
                        const figure: PlotlyFigure = {
                            data: traces,
                            layout: {
                                xaxis: { title: { text: 'Position [cm]' } },
                                yaxis: { title: { text: 'Tally Value' } }
                            },
                            title: `Tally ${selection.tallyId} All Scores Spatial Plot`
                        };
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spatial-multi');
                        plotWidget.setFigure(figure);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    } else if (selection.action === 'spectrum-all-nuclides' && tallyInfo) {
                        console.log(`[OpenMC] Plotting all nuclides for tally ${selection.tallyId}`);
                        const scoreIdx = selection.score ? tallyInfo.scores.indexOf(selection.score) : 0;
                        const scoreName = selection.score || tallyInfo.scores[0];

                        const nuclideTraces = await Promise.all(tallyInfo.nuclides.map(async nuclide => {
                            const data = await this.openmcService.getEnergySpectrum(statepointUri, selection.tallyId, scoreIdx, tallyInfo.nuclides.indexOf(nuclide));
                            return PlotlyUtils.createSpectrumTrace(data, `${nuclide} (${scoreName})`);
                        }));

                        const figure: PlotlyFigure = {
                            data: nuclideTraces,
                            layout: {
                                xaxis: { title: { text: 'Energy [eV]' }, type: 'log' },
                                yaxis: { title: { text: 'Tally Value' }, type: 'log' }
                            },
                            title: `Tally ${selection.tallyId} All Nuclides - ${scoreName}`
                        };
                        const plotWidget = await this.getPlotWidget(selection.tallyId, 'spectrum-nuclides');
                        plotWidget.setFigure(figure);
                        if (!plotWidget.isAttached) {
                            this.shell.addWidget(plotWidget, { area: 'main' });
                        }
                        this.shell.activateWidget(plotWidget.id);
                    }
                } catch (error) {
                    console.error(`[OpenMC] Action ${selection.action} failed:`, error);
                    this.messageService.error(`Failed to perform action ${selection.action}: ${error}`);
                }
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

    private async handleOverlayOnGeometry(selection: any, statepointUri: URI): Promise<void> {
        // Get DAGMC geometry files from workspace
        const geometryFiles = await this.getDagmcFiles();
        
        // Build geometry options with browse
        const geometryOptions: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse for DAGMC file...', description: 'Select .h5m file from any location' }
        ];
        
        if (geometryFiles.length > 0) {
            geometryOptions.push({ type: 'separator', label: 'Workspace Files' } as any, ...geometryFiles);
        }

        // Select geometry file
        const geometrySelection = await this.quickInput.showQuickPick(geometryOptions, {
            title: 'Select DAGMC Geometry File',
            placeholder: geometryFiles.length > 0 ? 'Choose a file or browse...' : 'Browse for DAGMC .h5m file...'
        });

        if (!geometrySelection) return;

        let geometryUri: URI;
        if (geometrySelection.value === '__browse__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select DAGMC Geometry File',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'DAGMC Files': ['h5m'],
                    'All Files': ['*']
                }
            });
            if (!fileUri) return;
            geometryUri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        } else {
            geometryUri = new URI(geometrySelection.value);
        }

        // Confirm the overlay
        const confirm = await this.quickInput.showQuickPick([
            { value: 'yes', label: '$(check) Overlay Tally on Geometry' },
            { value: 'no', label: '$(x) Cancel' }
        ], {
            title: `Overlay Tally ${selection.tallyId} on ${geometryUri.path.base}?`,
            placeholder: 'Confirm overlay action'
        });

        if (confirm?.value !== 'yes') return;

        // Perform the overlay
        const options: TallyVisualizationOptions = {
            tallyId: selection.tallyId,
            score: selection.score,
            nuclide: selection.nuclide
        };

        try {
            await this.openmcService.visualizeTallyOnGeometry(geometryUri, statepointUri, options);
        } catch (error) {
            this.messageService.error(`Failed to overlay tally: ${error}`);
        }
    }

    private async getDagmcFiles(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];
        
        try {
            const rootUri = workspace.resource;
            
            const collectDagmcFiles = async (uri: URI): Promise<void> => {
                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && child.name.endsWith('.h5m')) {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                            } else if (child.isDirectory && !child.name.startsWith('.') && files.length < 20) {
                                await collectDagmcFiles(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectDagmcFiles(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for DAGMC files:', e);
        }

        return files;
    }

    private async getH5Files(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];
        
        try {
            const rootUri = workspace.resource;
            
            const collectH5Files = async (uri: URI): Promise<void> => {
                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && child.name.endsWith('.h5')) {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                            } else if (child.isDirectory && !child.name.startsWith('.') && files.length < 20) {
                                await collectH5Files(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectH5Files(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for H5 files:', e);
        }

        return files;
    }

    private async getStatepointFiles(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];
        
        try {
            const rootUri = workspace.resource;
            
            const collectStatepointFiles = async (uri: URI): Promise<void> => {
                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && child.name.startsWith('statepoint') && child.name.endsWith('.h5')) {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                            } else if (child.isDirectory && !child.name.startsWith('.') && files.length < 20) {
                                await collectStatepointFiles(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectStatepointFiles(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for statepoint files:', e);
        }

        return files;
    }

    private async getSourceFiles(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];
        
        try {
            const rootUri = workspace.resource;
            
            const collectSourceFiles = async (uri: URI): Promise<void> => {
                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && child.name === 'source.h5') {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                            } else if (child.isDirectory && !child.name.startsWith('.') && files.length < 20) {
                                await collectSourceFiles(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectSourceFiles(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for source files:', e);
        }

        return files;
    }

    private async getGeometryFiles(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];
        
        try {
            const rootUri = workspace.resource;
            
            const collectGeometryFiles = async (uri: URI): Promise<void> => {
                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && child.name.endsWith('.h5m')) {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                            } else if (child.isDirectory && !child.name.startsWith('.') && files.length < 20) {
                                await collectGeometryFiles(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectGeometryFiles(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for geometry files:', e);
        }

        return files;
    }

    private async openDepletionViewerCommand(): Promise<void> {
        // Find depletion results files in workspace
        const files = await this.getDepletionFiles();
        
        // Add "Browse..." option to select file from anywhere
        const options: QuickPickValue<string>[] = [
            { value: '__browse__', label: '$(folder-opened) Browse for file...', description: 'Select depletion file from any location' },
            { type: 'separator', label: 'Workspace Files' } as any,
            ...files
        ];
        
        if (files.length === 0) {
            // Remove separator if no files
            options.splice(1, 1);
        }

        const selection = await this.quickInput.showQuickPick(options, {
            title: 'Open Depletion Results',
            placeholder: files.length > 0 ? 'Choose a file or browse...' : 'Browse for depletion file...'
        });

        if (!selection) return;

        if (selection.value === '__browse__') {
            // Open file dialog
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Depletion Results File',
                openLabel: 'Open',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });
            
            if (fileUri) {
                const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                const fileName = uri.path.base;
                await this.openDepletionFile(uri.toString(), fileName);
            }
        } else {
            await this.openDepletionFile(selection.value, selection.label);
        }
    }

    private async openDepletionFile(filePath: string, fileName: string): Promise<void> {
        try {
            const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionWidget>(
                OpenMCDepletionWidget.ID,
                { id: `${OpenMCDepletionWidget.ID}:${filePath}` } as any
            );

            widget.setDepletionFile(new URI(filePath), fileName);

            if (!widget.isAttached) {
                this.shell.addWidget(widget, { area: 'main' });
            }
            this.shell.activateWidget(widget.id);
        } catch (error) {
            this.messageService.error(`Failed to open depletion file: ${error}`);
        }
    }

    private async compareDepletionCommand(): Promise<void> {
        // Get depletion files from workspace
        const workspaceFiles = await this.getDepletionFiles();
        
        // Build options with browse
        const options: QuickPickValue<string>[] = [
            { value: '__browse_a__', label: '$(folder-opened) Browse for Case A...', description: 'Select file from any location' }
        ];
        
        if (workspaceFiles.length > 0) {
            options.push({ type: 'separator', label: 'Workspace Files' } as any, ...workspaceFiles);
        }

        // Select Case A
        const selectionA = await this.quickInput.showQuickPick(options, {
            title: 'Select Case A (Reference)',
            placeholder: 'Choose file or browse...'
        });

        if (!selectionA) return;

        let uriA: URI;
        let labelA: string;
        
        if (selectionA.value === '__browse_a__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Case A (Reference)',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });
            if (!fileUri) return;
            uriA = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            labelA = uriA.path.base;
        } else {
            uriA = new URI(selectionA.value);
            labelA = selectionA.label;
        }

        // Build options for Case B
        const optionsB: QuickPickValue<string>[] = [
            { value: '__browse_b__', label: '$(folder-opened) Browse for Case B...', description: 'Select file from any location' }
        ];
        
        const remainingFiles = workspaceFiles.filter(f => f.value !== uriA.toString());
        if (remainingFiles.length > 0) {
            optionsB.push({ type: 'separator', label: 'Workspace Files' } as any, ...remainingFiles);
        }

        // Select Case B
        const selectionB = await this.quickInput.showQuickPick(optionsB, {
            title: 'Select Case B (Comparison)',
            placeholder: 'Choose file or browse...'
        });

        if (!selectionB) return;

        let uriB: URI;
        let labelB: string;
        
        if (selectionB.value === '__browse_b__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Case B (Comparison)',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });
            if (!fileUri) return;
            uriB = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            labelB = uriB.path.base;
        } else {
            uriB = new URI(selectionB.value);
            labelB = selectionB.label;
        }

        // Open comparison widget
        try {
            const progress = await this.messageService.showProgress({
                text: 'Loading comparison data...',
                options: { cancelable: false }
            });
            try {
                const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionCompareWidget>(
                    OpenMCDepletionCompareWidget.ID,
                    { id: `${OpenMCDepletionCompareWidget.ID}:${uriA.toString()}:${uriB.toString()}` } as any
                );

                await widget.setComparisonFiles(uriA, labelA, uriB, labelB);

                if (!widget.isAttached) {
                    this.shell.addWidget(widget, { area: 'main' });
                }
                this.shell.activateWidget(widget.id);
            } finally {
                progress.cancel();
            }
        } catch (error) {
            this.messageService.error(`Failed to open comparison: ${error}`);
        }
    }

    private async compareDepletionWithCommand(uriA: URI): Promise<void> {
        // Use the provided file as Case A
        const labelA = uriA.path.base;
        
        // Get files for Case B selection
        const workspaceFiles = await this.getDepletionFiles();
        
        // Build options for Case B
        const options: QuickPickValue<string>[] = [
            { value: '__browse_b__', label: '$(folder-opened) Browse for Case B...', description: 'Select file from any location' }
        ];
        
        // Filter out Case A from workspace files
        const remainingFiles = workspaceFiles.filter(f => f.value !== uriA.toString());
        if (remainingFiles.length > 0) {
            options.push({ type: 'separator', label: 'Workspace Files' } as any, ...remainingFiles);
        }

        // Select Case B
        const selectionB = await this.quickInput.showQuickPick(options, {
            title: `Compare "${labelA}" with...`,
            placeholder: 'Choose second depletion file'
        });

        if (!selectionB) return;

        let uriB: URI;
        let labelB: string;
        
        if (selectionB.value === '__browse_b__') {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select Case B (Comparison)',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false
            });
            if (!fileUri) return;
            uriB = Array.isArray(fileUri) ? fileUri[0] : fileUri;
            labelB = uriB.path.base;
        } else {
            uriB = new URI(selectionB.value);
            labelB = selectionB.label;
        }

        // Open comparison widget
        try {
            const progress = await this.messageService.showProgress({
                text: 'Loading comparison data...',
                options: { cancelable: false }
            });
            try {
                const widget = await this.widgetManager.getOrCreateWidget<OpenMCDepletionCompareWidget>(
                    OpenMCDepletionCompareWidget.ID,
                    { id: `${OpenMCDepletionCompareWidget.ID}:${uriA.toString()}:${uriB.toString()}` } as any
                );

                await widget.setComparisonFiles(uriA, labelA, uriB, labelB);

                if (!widget.isAttached) {
                    this.shell.addWidget(widget, { area: 'main' });
                }
                this.shell.activateWidget(widget.id);
            } finally {
                progress.cancel();
            }
        } catch (error) {
            this.messageService.error(`Failed to open comparison: ${error}`);
        }
    }

    private geometry3DWidget: OpenMCGeometry3DWidget | null = null;

    private geometryTreeWidget: OpenMCGeometryTreeWidget | undefined;

    private async getOrCreateGeometryTreeWidget(): Promise<OpenMCGeometryTreeWidget> {
        let widget = this.geometryTreeWidget;
        if (!widget || widget.isDisposed) {
            widget = await this.widgetManager.getOrCreateWidget<OpenMCGeometryTreeWidget>(
                OpenMCGeometryTreeWidget.ID
            );
            this.geometryTreeWidget = widget;
        }
        return widget;
    }

    private async openGeometryHierarchy(uri: URI): Promise<void> {
        const progress = await this.messageService.showProgress({
            text: 'Loading geometry hierarchy...',
            options: { cancelable: false }
        });
        
        try {
            const hierarchy = await this.openmcService.getGeometryHierarchy(uri);
            
            if (hierarchy.error) {
                this.messageService.error(`Failed to load geometry: ${hierarchy.error}`);
                return;
            }
            
            // Get or create the geometry tree widget
            const widget = await this.getOrCreateGeometryTreeWidget();
            
            // Update the widget state
            widget.setGeometry(uri, hierarchy);
            
            // Add to right sidebar if not already there
            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: 'right' });
            }
            
            // Activate the widget
            await this.shell.activateWidget(widget.id);

            // Listen for 3D view requests (only once)
            if (!(widget as any)._handlerSet) {
                (widget as any)._handlerSet = true;
                
                // Handle 3D view requests
                widget.onView3D(async (request: GeometryView3DRequest) => {
                    await this.showGeometry3D(request);
                });
            }
            
            this.messageService.info(
                `Loaded geometry: ${hierarchy.totalCells} cells, ${hierarchy.totalSurfaces} surfaces`
            );
        } catch (error) {
            this.messageService.error(`Failed to load geometry hierarchy: ${error}`);
        } finally {
            progress.cancel();
        }
    }

    private async showGeometry3D(request: GeometryView3DRequest): Promise<void> {
        // Get or create the 3D widget
        let widget = this.geometry3DWidget;
        if (!widget || widget.isDisposed) {
            widget = await this.widgetManager.getOrCreateWidget<OpenMCGeometry3DWidget>(
                OpenMCGeometry3DWidget.ID,
                { id: `${OpenMCGeometry3DWidget.ID}:${request.fileUri.toString()}` } as any
            );
            this.geometry3DWidget = widget;
        }

        widget.setGeometry(request.fileUri);
        widget.setLoading(true);

        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(widget.id);

        try {
            const result = await this.openmcService.visualizeGeometry(
                request.fileUri,
                request.highlightCellId !== undefined ? [request.highlightCellId] : undefined
            );

            if (result.success && result.url && result.port) {
                widget.setServerInfo(result.url, result.port);
                if (request.highlightCellId !== undefined) {
                    widget.setHighlightedCell(request.highlightCellId);
                }
            } else {
                widget.setError(result.error || 'Failed to start 3D visualization server');
            }
        } catch (error) {
            widget.setError(`Error: ${error}`);
        }
    }

    private async viewGeometryHierarchyCommand(): Promise<void> {
        // Open file dialog to select geometry.xml or model directory
        const fileUri = await this.fileDialogService.showOpenDialog({
            title: 'Select OpenMC Geometry File',
            openLabel: 'Open',
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: false
        });
        
        if (!fileUri) return;
        
        const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        await this.openGeometryHierarchy(uri);
    }
    
    private async viewMaterialsCommand(): Promise<void> {
        // Open file dialog to select materials.xml
        const fileUri = await this.fileDialogService.showOpenDialog({
            title: 'Select OpenMC Materials File',
            openLabel: 'Open',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'XML Files': ['xml'],
                'All Files': ['*']
            }
        });
        
        if (!fileUri) return;
        
        const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        await this.openMaterialsExplorer(uri);
    }
    
    private async openMaterialsExplorer(uri: URI): Promise<void> {
        try {
            // Create and open the materials explorer widget
            const widget = await this.widgetManager.getOrCreateWidget<OpenMCMaterialExplorerWidget>(
                OpenMCMaterialExplorerWidget.ID,
                { uri: uri.toString() }
            );
            
            await this.shell.addWidget(widget, { area: 'main' });
            await this.shell.activateWidget(widget.id);
            
            this.messageService.info(`Opened materials from ${uri.path.base}`);
        } catch (error) {
            this.messageService.error(`Failed to open materials: ${error}`);
        }
    }

    private async checkOverlapsCommand(): Promise<void> {
        // Open file dialog to select geometry file
        const fileUri = await this.fileDialogService.showOpenDialog({
            title: 'Select OpenMC Geometry File',
            openLabel: 'Check Overlaps',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'XML Files': ['xml'],
                'Python Files': ['py'],
                'All Files': ['*']
            }
        });
        
        if (!fileUri) return;
        
        const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
        await this.openOverlapChecker(uri);
    }
    
    private async openOverlapChecker(uri: URI): Promise<void> {
        try {
            // Create and open the overlap checker widget
            const widget = await this.widgetManager.getOrCreateWidget<OpenMCOverlapWidget>(
                OpenMCOverlapWidget.ID,
                { geometryUri: uri.toString() }
            );
            
            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: 'main' });
            }
            
            await this.shell.activateWidget(widget.id);
            
            this.messageService.info(`Opened overlap checker for ${uri.path.base}`);
        } catch (error) {
            this.messageService.error(`Failed to open overlap checker: ${error}`);
        }
    }

    private async getDepletionFiles(): Promise<QuickPickValue<string>[]> {
        const workspace = this.workspaceService.workspace;
        if (!workspace) {
            return [];
        }

        const files: QuickPickValue<string>[] = [];
        
        try {
            const rootUri = workspace.resource;
            
            const collectH5Files = async (uri: URI): Promise<void> => {
                try {
                    const dirStat = await this.fileService.resolve(uri);
                    if (dirStat.children) {
                        for (const child of dirStat.children) {
                            if (child.isFile && child.name.includes('depletion') && child.name.endsWith('.h5')) {
                                files.push({
                                    value: child.resource.toString(),
                                    label: child.name,
                                    description: this.labelProvider.getLongName(child.resource)
                                });
                            } else if (child.isDirectory && !child.name.startsWith('.') && files.length < 20) {
                                // Recurse into subdirectories (limit to prevent too many requests)
                                await collectH5Files(child.resource);
                            }
                        }
                    }
                } catch (e) {
                    // Ignore errors for individual directories
                }
            };

            await collectH5Files(rootUri);
        } catch (e) {
            console.error('[OpenMC] Failed to search for depletion files:', e);
        }

        return files;
    }

    private async plotXSCommand(): Promise<void> {
        const widget = await this.getOrCreateXSPlotWidget();
        
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'right' });
        }
        
        await this.shell.activateWidget(widget.id);
    }
}

/**
 * View contribution for XS Plot widget - adds icon to sidebar
 */
@injectable()
export class XSPlotViewContribution extends AbstractViewContribution<XSPlotWidget> {
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    constructor() {
        super({
            widgetId: XSPlotWidget.ID,
            widgetName: XSPlotWidget.LABEL,
            defaultWidgetOptions: {
                area: 'right',
                rank: 200
            },
            toggleCommandId: 'xsPlot.toggle',
            toggleKeybinding: 'ctrlcmd+shift+x'
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        
        commands.registerCommand({
            id: 'xsPlot.open',
            label: 'OpenMC: Open Cross-Section Plot'
        }, {
            execute: () => this.openView({ reveal: true, activate: true })
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Don't auto-open by default, but the icon will be available in the sidebar
    }
}

/**
 * View contribution for OpenMC Tallies widget - adds icon to sidebar
 */
@injectable()
export class OpenMCTalliesViewContribution extends AbstractViewContribution<OpenMCTallyTreeWidget> {
    
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    constructor() {
        super({
            widgetId: OpenMCTallyTreeWidget.ID,
            widgetName: OpenMCTallyTreeWidget.LABEL,
            defaultWidgetOptions: {
                area: 'right',
                rank: 100
            },
            toggleCommandId: 'openmcTallies.toggle',
            toggleKeybinding: 'ctrlcmd+shift+t'
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        
        commands.registerCommand({
            id: 'openmcTallies.open',
            label: 'OpenMC: Open Tallies'
        }, {
            execute: () => this.openView({ reveal: true, activate: true }),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Don't auto-open by default, but the icon will be available in the sidebar
    }
}
