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
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { OpenMCService } from '../openmc-service';
import { OpenMCGeometryTreeWidget, GeometryView3DRequest, GeometryLoadedEvent } from '../widgets/geometry/openmc-geometry-tree';
import { OpenMCGeometry3DWidget } from '../widgets/geometry/openmc-geometry-3d-widget';
import { OpenMCMaterialExplorerWidget } from '../widgets/materials/openmc-material-explorer';
import { OpenMCOverlapWidget } from '../widgets/geometry/openmc-overlap-widget';

@injectable()
export class OpenMCGeometryContribution {
    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    private geometry3DWidget: OpenMCGeometry3DWidget | null = null;
    private geometryTreeWidget: OpenMCGeometryTreeWidget | undefined;

    initialize(): void {
        // Track widget creation and attach event handlers
        this.widgetManager.onDidCreateWidget(async ({ widget }) => {
            if (widget instanceof OpenMCGeometryTreeWidget) {
                this.geometryTreeWidget = widget;
                
                widget.onView3D(async (request: GeometryView3DRequest) => {
                    await this.showGeometry3D(request);
                });
                
                widget.onGeometryLoaded(async (event: GeometryLoadedEvent) => {
                    console.log('[OpenMC] Geometry loaded:', event.fileUri.path.toString());
                });
            }
        });
    }

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

    async openGeometryHierarchy(uri: URI): Promise<void> {
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
            
            // Get or create the geometry tree widget (handlers attached in getOrCreateGeometryTreeWidget)
            const widget = await this.getOrCreateGeometryTreeWidget();
            
            // Update the widget state
            widget.setGeometry(uri, hierarchy);
            
            // Add to right sidebar if not already there
            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: 'right' });
            }
            
            // Activate the widget
            await this.shell.activateWidget(widget.id);
            
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

        // IMPORTANT: Use the geometry tree widget's CURRENT geometry URI
        // to avoid stale closure issues when loading new files
        const treeWidget = await this.getOrCreateGeometryTreeWidget();
        const currentGeometryUri = treeWidget.getCurrentGeometryUri();
        const currentHierarchy = treeWidget.getCurrentHierarchy();
        
        // Show widget even if no geometry (it will show "No geometry loaded" state)
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        await this.shell.activateWidget(widget.id);
        
        // Check if geometry is loaded and valid
        if (!currentHierarchy) {
            widget.setGeometry(request.fileUri); // Set URI for reference
            // Widget will show "No geometry loaded" empty state
            return;
        }
        if (currentHierarchy.totalCells === 0) {
            this.messageService.warn('Cannot visualize: Geometry has no cells. The file may not be a valid geometry file.');
            return;
        }
        
        const geometryUri = currentGeometryUri || request.fileUri;
        const highlightCellId = request.highlightCellId;

        widget.setGeometry(geometryUri);
        widget.setLoading(true);

        try {
            const result = await this.openmcService.visualizeGeometry(
                geometryUri,
                highlightCellId !== undefined ? [highlightCellId] : undefined
            );

            if (result.success && result.url && result.port) {
                widget.setServerInfo(result.url, result.port);
                if (highlightCellId !== undefined) {
                    widget.setHighlightedCell(highlightCellId);
                }
            } else {
                widget.setError(result.error || 'Failed to start 3D visualization server');
            }
        } catch (error) {
            widget.setError(`Error: ${error}`);
        }
    }

    async viewGeometryHierarchyCommand(): Promise<void> {
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
    
    async viewMaterialsCommand(): Promise<void> {
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
    
    async openMaterialsExplorer(uri: URI): Promise<void> {
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

    async checkOverlapsCommand(): Promise<void> {
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
    
    async openOverlapChecker(uri: URI): Promise<void> {
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
}
