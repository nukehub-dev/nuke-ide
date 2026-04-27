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

import { injectable, inject } from '@theia/core/shared/inversify';
import { MessageService } from '@theia/core/lib/common';
import { 
    QuickInputService, 
    LabelProvider, 
    ApplicationShell,
    FrontendApplicationContribution,
    OpenHandler,
    WidgetOpenerOptions,
    Widget,
    FrontendApplication
} from '@theia/core/lib/browser';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WidgetManager } from '@theia/core/lib/browser';
import { DiffUris } from '@theia/core/lib/browser/diff-uris';
import { OpenMCService } from './openmc-service';
import { OpenMCTallyTreeWidget } from './widgets/statepoint/openmc-tally-tree';
import { XSPlotWidget } from './widgets/plotting/xs-plot-widget';
import { OpenMCDepletionCompareWidget } from './widgets/depletion/openmc-depletion-compare-widget';
import { OpenMCStatepointContribution } from './contributions/openmc-statepoint-contribution';
import { OpenMCGeometryContribution } from './contributions/openmc-geometry-contribution';
import { OpenMCDepletionContribution } from './contributions/openmc-depletion-contribution';
import { OpenMCOverlayContribution } from './contributions/openmc-overlay-contribution';
import { OpenMCPlottingContribution } from './contributions/openmc-plotting-contribution';

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

    @inject(OpenMCStatepointContribution)
    protected readonly statepoint: OpenMCStatepointContribution;

    @inject(OpenMCGeometryContribution)
    protected readonly geometry: OpenMCGeometryContribution;

    @inject(OpenMCDepletionContribution)
    protected readonly depletion: OpenMCDepletionContribution;

    @inject(OpenMCOverlayContribution)
    protected readonly overlay: OpenMCOverlayContribution;

    @inject(OpenMCPlottingContribution)
    protected readonly plotting: OpenMCPlottingContribution;

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
            // Load statepoint and open Statepoint Viewer
            const progress = await this.messageService.showProgress({
                text: 'Opening statepoint viewer...',
                options: { cancelable: false }
            });

            try {
                // Load full statepoint info for the viewer
                const fullInfo = await this.openmcService.loadStatepointFull(uri);
                if (fullInfo) {
                    await this.statepoint.openStatepointViewer(uri);
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
                    await this.overlay.showTallySelectorForOverlay(uri, files.statepoint);
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
            await this.depletion.openDepletionFile(uri.toString(), uri.path.base);
        } else if (name === 'geometry.xml') {
            // Open geometry hierarchy viewer
            await this.geometry.openGeometryHierarchy(uri);
        } else if (name === 'materials.xml') {
            // Open materials explorer
            await this.geometry.openMaterialsExplorer(uri);
        }
        
        // Return a dummy widget - actual visualization is handled by VisualizerWidget
        return new Widget();
    }

    initialize(): void {
        this.statepoint.initialize();
        this.geometry.initialize();
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Create sidebar tabs for XS Plot and Tallies without activating them
        const xsPlotWidget = await this.widgetManager.getOrCreateWidget(XSPlotWidget.ID);
        if (!xsPlotWidget.isAttached) {
            app.shell.addWidget(xsPlotWidget, { area: 'main' });
        }

        const talliesWidget = await this.widgetManager.getOrCreateWidget(OpenMCTallyTreeWidget.ID);
        if (!talliesWidget.isAttached) {
            app.shell.addWidget(talliesWidget, { area: 'right' });
        }
    }

    async loadStatepointCommand(): Promise<void> {
        return this.statepoint.loadStatepointCommand();
    }

    async visualizeTallyCommand(): Promise<void> {
        return this.statepoint.visualizeTallyCommand();
    }

    async showTallyInfoCommand(): Promise<void> {
        return this.statepoint.showTallyInfoCommand();
    }

    async openTalliesWidget(): Promise<void> {
        return this.statepoint.openTalliesWidget();
    }

    async visualizeSourceCommand(): Promise<void> {
        return this.plotting.visualizeSourceCommand();
    }

    async overlayTallyCommand(): Promise<void> {
        return this.overlay.overlayTallyCommand();
    }

    async openDepletionViewerCommand(): Promise<void> {
        return this.depletion.openDepletionViewerCommand();
    }

    async compareDepletionCommand(): Promise<void> {
        return this.depletion.compareDepletionCommand();
    }

    async compareDepletionWithCommand(uriA: URI): Promise<void> {
        return this.depletion.compareDepletionWithCommand(uriA);
    }

    async viewGeometryHierarchyCommand(): Promise<void> {
        return this.geometry.viewGeometryHierarchyCommand();
    }

    async checkOverlapsCommand(): Promise<void> {
        return this.geometry.checkOverlapsCommand();
    }

    async viewMaterialsCommand(): Promise<void> {
        return this.geometry.viewMaterialsCommand();
    }

    async plotXSCommand(): Promise<void> {
        return this.plotting.plotXSCommand();
    }
}
