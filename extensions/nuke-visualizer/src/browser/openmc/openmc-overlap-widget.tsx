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

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import { OpenMCService } from './openmc-service';
import { OpenMCOverlap } from '../../common/visualizer-protocol';
import { OpenMCGeometry3DWidget } from './openmc-geometry-3d-widget';

@injectable()
export class OpenMCOverlapWidget extends ReactWidget {
    static readonly ID = 'openmc-overlap-widget';
    static readonly LABEL = '🔍 Geometry Overlap Checker';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    // State
    protected geometryUri: URI | null = null;
    protected isRunning = false;
    protected progress = { checked: 0, total: 100000, percentage: 0 };
    protected samplePoints = 100000;
    protected tolerance = 1e-6;
    protected useParallel = false;
    protected overlaps: OpenMCOverlap[] = [];
    protected selectedOverlap: OpenMCOverlap | null = null;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCOverlapWidget.ID;
        this.title.label = OpenMCOverlapWidget.LABEL;
        this.title.caption = OpenMCOverlapWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-search';
        
        this.update();
    }

    protected async browseForFile(): Promise<void> {
        try {
            const fileUri = await this.fileDialogService.showOpenDialog({
                title: 'Select OpenMC Geometry File',
                openLabel: 'Select',
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                filters: {
                    'XML Files': ['xml'],
                    'Python Files': ['py'],
                    'All Files': ['*']
                }
            });
            
            if (fileUri) {
                const uri = Array.isArray(fileUri) ? fileUri[0] : fileUri;
                this.geometryUri = uri;
                this.update();
            }
        } catch (error) {
            console.error('[OpenMCOverlap] Error browsing for file:', error);
            this.messageService.error('Failed to open file browser');
        }
    }

    protected async discoverGeometryFiles(): Promise<void> {
        // This method is no longer used but kept for potential future use
        // The browse button provides a more reliable way to select files
    }

    protected render(): React.ReactNode {
        return (
            <div style={{ 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column',
                background: 'var(--theia-editor-background)',
                color: 'var(--theia-foreground)',
                padding: '16px',
                overflow: 'auto'
            }}>
                {this.renderHeader()}
                {this.renderSettings()}
                {this.isRunning && this.renderProgress()}
                {this.overlaps.length > 0 && this.renderResults()}
            </div>
        );
    }

    protected renderHeader(): React.ReactNode {
        return (
            <div style={{ marginBottom: '16px' }}>
                <h2 style={{ margin: '0 0 8px 0', fontSize: '18px' }}>
                    🔍 Geometry Overlap Checker
                </h2>
                <p style={{ margin: 0, color: 'var(--theia-descriptionForeground)', fontSize: '13px' }}>
                    Detect overlapping cells in OpenMC geometry using stochastic sampling.
                </p>
            </div>
        );
    }

    protected renderSettings(): React.ReactNode {
        return (
            <div style={{ 
                background: 'var(--theia-editorWidget-background)',
                borderRadius: '6px',
                padding: '16px',
                marginBottom: '16px'
            }}>
                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 500 }}>
                        Geometry File
                    </label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                            type="text"
                            readOnly
                            value={this.geometryUri ? this.geometryUri.path.base : 'No file selected'}
                            placeholder="Select a geometry file..."
                            style={{
                                flex: 1,
                                padding: '8px',
                                borderRadius: '4px',
                                border: '1px solid var(--theia-input-border)',
                                background: 'var(--theia-input-background)',
                                color: this.geometryUri ? 'var(--theia-input-foreground)' : 'var(--theia-descriptionForeground)',
                                fontSize: '13px'
                            }}
                        />
                        <button
                            onClick={() => this.browseForFile()}
                            disabled={this.isRunning}
                            style={{
                                padding: '8px 16px',
                                background: 'var(--theia-button-secondary-background)',
                                color: 'var(--theia-button-secondary-foreground)',
                                border: 'none',
                                borderRadius: '4px',
                                fontSize: '13px',
                                cursor: this.isRunning ? 'not-allowed' : 'pointer',
                                opacity: this.isRunning ? 0.6 : 1
                            }}
                        >
                            📁 Browse...
                        </button>
                    </div>
                    {this.geometryUri && (
                        <div style={{ 
                            marginTop: '4px', 
                            fontSize: '11px', 
                            color: 'var(--theia-descriptionForeground)',
                            wordBreak: 'break-all'
                        }}>
                            {this.geometryUri.path.toString()}
                        </div>
                    )}
                </div>

                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 500 }}>
                        Sample Points: {this.samplePoints.toLocaleString()}
                    </label>
                    <input
                        type="range"
                        min="10000"
                        max="1000000"
                        step="10000"
                        value={this.samplePoints}
                        onChange={(e) => {
                            this.samplePoints = parseInt(e.target.value);
                            this.update();
                        }}
                        style={{ width: '100%' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--theia-descriptionForeground)' }}>
                        <span>10K (fast)</span>
                        <span>100K (balanced)</span>
                        <span>1M (thorough)</span>
                    </div>
                </div>

                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '12px', marginBottom: '4px', fontWeight: 500 }}>
                        Tolerance: {this.tolerance.toExponential(0)}
                    </label>
                    <input
                        type="range"
                        min="1e-9"
                        max="1e-3"
                        step="1e-9"
                        value={this.tolerance}
                        onChange={(e) => {
                            this.tolerance = parseFloat(e.target.value);
                            this.update();
                        }}
                        style={{ width: '100%' }}
                    />
                </div>

                <div style={{ marginBottom: '16px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: '13px', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={this.useParallel}
                            onChange={(e) => {
                                this.useParallel = e.target.checked;
                                this.update();
                            }}
                            style={{ marginRight: '8px' }}
                        />
                        Use parallel processing
                    </label>
                </div>

                <button
                    onClick={() => this.runOverlapCheck()}
                    disabled={!this.geometryUri || this.isRunning}
                    style={{
                        width: '100%',
                        padding: '10px 16px',
                        background: this.geometryUri && !this.isRunning 
                            ? 'var(--theia-button-background)' 
                            : 'var(--theia-button-disabledBackground)',
                        color: this.geometryUri && !this.isRunning 
                            ? 'var(--theia-button-foreground)' 
                            : 'var(--theia-button-disabledForeground)',
                        border: 'none',
                        borderRadius: '4px',
                        fontSize: '14px',
                        fontWeight: 500,
                        cursor: this.geometryUri && !this.isRunning ? 'pointer' : 'not-allowed'
                    }}
                >
                    {this.isRunning ? '⏳ Running...' : '▶ Run Overlap Check'}
                </button>
            </div>
        );
    }

    protected renderProgress(): React.ReactNode {
        return (
            <div style={{ 
                background: 'var(--theia-editorWidget-background)',
                borderRadius: '6px',
                padding: '16px',
                marginBottom: '16px'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '13px' }}>Progress: {this.progress.percentage.toFixed(1)}%</span>
                    <span style={{ fontSize: '13px', color: 'var(--theia-descriptionForeground)' }}>
                        {this.progress.checked.toLocaleString()} / {this.progress.total.toLocaleString()} points
                    </span>
                </div>
                <div style={{ 
                    width: '100%', 
                    height: '8px', 
                    background: 'var(--theia-progressBar-background)',
                    borderRadius: '4px',
                    overflow: 'hidden'
                }}>
                    <div style={{
                        width: `${this.progress.percentage}%`,
                        height: '100%',
                        background: 'var(--theia-progressBar-foreground)',
                        transition: 'width 0.3s ease'
                    }} />
                </div>
            </div>
        );
    }

    protected renderResults(): React.ReactNode {
        return (
            <div style={{ 
                background: 'var(--theia-editorWidget-background)',
                borderRadius: '6px',
                padding: '16px',
                flex: 1,
                overflow: 'auto'
            }}>
                <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    marginBottom: '12px',
                    paddingBottom: '12px',
                    borderBottom: '1px solid var(--theia-panel-border)'
                }}>
                    <h3 style={{ margin: 0, fontSize: '14px' }}>
                        Results: {this.overlaps.length} overlap(s) found
                    </h3>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={() => this.exportResults('json')}
                            style={{
                                padding: '4px 12px',
                                fontSize: '12px',
                                background: 'var(--theia-button-secondary-background)',
                                color: 'var(--theia-button-secondary-foreground)',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer'
                            }}
                        >
                            💾 Export JSON
                        </button>
                        <button
                            onClick={() => this.exportResults('csv')}
                            style={{
                                padding: '4px 12px',
                                fontSize: '12px',
                                background: 'var(--theia-button-secondary-background)',
                                color: 'var(--theia-button-secondary-foreground)',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer'
                            }}
                        >
                            📊 Export CSV
                        </button>
                        <button
                            onClick={() => this.clearResults()}
                            style={{
                                padding: '4px 12px',
                                fontSize: '12px',
                                background: 'transparent',
                                color: 'var(--theia-foreground)',
                                border: '1px solid var(--theia-button-border)',
                                borderRadius: '3px',
                                cursor: 'pointer'
                            }}
                        >
                            🧹 Clear
                        </button>
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {this.overlaps.map((overlap, index) => this.renderOverlapItem(overlap, index))}
                </div>
            </div>
        );
    }

    protected renderOverlapItem(overlap: OpenMCOverlap, index: number): React.ReactNode {
        const [x, y, z] = overlap.coordinates;
        const isSelected = this.selectedOverlap === overlap;

        return (
            <div
                key={index}
                style={{
                    padding: '12px',
                    background: isSelected 
                        ? 'var(--theia-list-activeSelectionBackground)' 
                        : 'var(--theia-list-hoverBackground)',
                    border: `1px solid ${isSelected ? 'var(--theia-list-activeSelectionBackground)' : 'transparent'}`,
                    borderRadius: '4px',
                    cursor: 'pointer'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#ff4444', fontSize: '14px' }}>🔴</span>
                        <span style={{ fontWeight: 500, fontSize: '13px' }}>
                            {overlap.cellIds.length > 2 
                                ? `Multi-cell overlap (${overlap.cellIds.length} cells)` 
                                : `Cell ${overlap.cellIds[0]} ⟷ Cell ${overlap.cellIds[1]}`}
                        </span>
                    </div>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            this.viewOverlapIn3D(overlap);
                        }}
                        disabled={!this.geometryUri}
                        style={{
                            padding: '4px 10px',
                            fontSize: '11px',
                            background: this.geometryUri ? 'var(--theia-button-secondary-background)' : 'var(--theia-button-disabledBackground)',
                            color: this.geometryUri ? 'var(--theia-button-secondary-foreground)' : 'var(--theia-button-disabledForeground)',
                            border: 'none',
                            borderRadius: '3px',
                            cursor: this.geometryUri ? 'pointer' : 'not-allowed'
                        }}
                        title="Open 3D view centered on this overlap"
                    >
                        👁 View in 3D
                    </button>
                </div>
                
                <div 
                    onClick={() => this.selectOverlap(overlap)}
                    style={{
                        padding: '8px',
                        background: 'rgba(255, 68, 68, 0.1)',
                        borderRadius: '4px',
                        border: '1px solid rgba(255, 68, 68, 0.3)',
                        marginBottom: '8px'
                    }}
                >
                    <div style={{ fontSize: '10px', color: '#ff4444', marginBottom: '2px', textTransform: 'uppercase' }}>
                        Overlap Location
                    </div>
                    <div style={{ 
                        fontSize: '14px', 
                        color: '#ff4444',
                        fontFamily: 'monospace',
                        fontWeight: 500
                    }}>
                        ({x.toFixed(4)}, {y.toFixed(4)}, {z.toFixed(4)}) cm
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {overlap.cellIds.map(cellId => (
                        <span
                            key={cellId}
                            style={{
                                fontSize: '11px',
                                padding: '2px 8px',
                                background: 'var(--theia-badge-background)',
                                color: 'var(--theia-badge-foreground)',
                                borderRadius: '3px'
                            }}
                        >
                            Cell {cellId}
                        </span>
                    ))}
                </div>
            </div>
        );
    }

    protected async runOverlapCheck(): Promise<void> {
        if (!this.geometryUri) {
            return;
        }

        this.isRunning = true;
        this.overlaps = [];
        this.progress = { checked: 0, total: this.samplePoints, percentage: 0 };
        this.update();

        try {
            // Simulate progress updates
            const progressInterval = setInterval(() => {
                if (!this.isRunning) {
                    clearInterval(progressInterval);
                    return;
                }
                const increment = Math.random() * 5;
                this.progress.percentage = Math.min(99, this.progress.percentage + increment);
                this.progress.checked = Math.floor(this.progress.percentage / 100 * this.samplePoints);
                this.update();
            }, 200);

            const result = await this.openmcService.checkOverlaps(this.geometryUri, {
                samplePoints: this.samplePoints,
                tolerance: this.tolerance,
                parallel: this.useParallel
            });

            clearInterval(progressInterval);
            this.progress.percentage = 100;
            this.progress.checked = this.samplePoints;

            if (result.error) {
                this.messageService.error(`Overlap check failed: ${result.error}`);
            } else {
                this.overlaps = result.overlaps;
            }
        } catch (error) {
            this.messageService.error(`Error running overlap check: ${error}`);
        } finally {
            this.isRunning = false;
            this.update();
        }
    }

    protected selectOverlap(overlap: OpenMCOverlap): void {
        this.selectedOverlap = overlap;
        this.update();
    }

    protected async viewOverlapIn3D(overlap: OpenMCOverlap): Promise<void> {
        if (!this.geometryUri) {
            this.messageService.warn('No geometry file selected');
            return;
        }

        const [x, y, z] = overlap.coordinates;
        this.messageService.info(`Opening 3D view at overlap location (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})...`);

        try {
            // Get or create the 3D widget
            const widget = await this.widgetManager.getOrCreateWidget<OpenMCGeometry3DWidget>(
                OpenMCGeometry3DWidget.ID,
                { id: `${OpenMCGeometry3DWidget.ID}:${this.geometryUri.toString()}` }
            );

            widget.setGeometry(this.geometryUri);
            widget.setLoading(true);

            if (!widget.isAttached) {
                await this.shell.addWidget(widget, { area: 'main' });
            }
            await this.shell.activateWidget(widget.id);

            // Call the backend to visualize geometry
            const result = await this.openmcService.visualizeGeometry(
                this.geometryUri,
                overlap.cellIds[0] // Highlight the first overlapping cell
            );

            if (result.success && result.url && result.port) {
                widget.setServerInfo(result.url, result.port);
                widget.setHighlightedCell(overlap.cellIds[0]);
                this.messageService.info(`3D view loaded. Overlap at: (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) cm`);
            } else {
                widget.setError(result.error || 'Failed to load 3D view');
                this.messageService.error(`Failed to load 3D view: ${result.error}`);
            }
        } catch (error) {
            this.messageService.error(`Error opening 3D view: ${error}`);
        }
    }

    protected exportResults(format: 'json' | 'csv'): void {
        if (this.overlaps.length === 0) {
            return;
        }

        let content: string;
        let filename: string;
        let mimeType: string;

        if (format === 'json') {
            content = JSON.stringify({
                geometryPath: this.geometryUri?.path.toString(),
                totalOverlaps: this.overlaps.length,
                overlaps: this.overlaps
            }, null, 2);
            filename = 'overlaps.json';
            mimeType = 'application/json';
        } else {
            const lines = ['x,y,z,cell_ids,cell_names,overlap_count'];
            for (const o of this.overlaps) {
                const [x, y, z] = o.coordinates;
                const cellIds = o.cellIds.join(';');
                const cellNames = o.cellNames.join(';');
                lines.push(`${x},${y},${z},"${cellIds}","${cellNames}",${o.overlapCount}`);
            }
            content = lines.join('\n');
            filename = 'overlaps.csv';
            mimeType = 'text/csv';
        }

        // Download the file
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.messageService.info(`Exported overlap results to ${filename}`);
    }

    protected clearResults(): void {
        this.overlaps = [];
        this.selectedOverlap = null;
        this.progress = { checked: 0, total: 100000, percentage: 0 };
        this.update();
    }

    setGeometryUri(uri: URI): void {
        this.geometryUri = uri;
        this.update();
    }
}
