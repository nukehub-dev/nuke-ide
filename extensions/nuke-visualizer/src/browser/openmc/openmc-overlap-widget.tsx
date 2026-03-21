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

@injectable()
export class OpenMCOverlapWidget extends ReactWidget {
    static readonly ID = 'openmc-overlap-widget';
    static readonly LABEL = 'Geometry Overlap Checker';

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
                padding: '12px',
                overflow: 'auto',
                fontSize: '12px'
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
            <div style={{ marginBottom: '12px', paddingBottom: '10px', borderBottom: '1px solid var(--theia-panel-border)' }}>
                <h2 style={{ margin: '0 0 4px 0', fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ color: 'var(--theia-charts-orange)' }}>●</span>
                    Geometry Overlap Checker
                </h2>
                <p style={{ margin: 0, color: 'var(--theia-descriptionForeground)', fontSize: '11px', lineHeight: '1.4' }}>
                    Detect overlapping cells in OpenMC geometry using stochastic sampling.
                </p>
            </div>
        );
    }

    protected renderSettings(): React.ReactNode {
        return (
            <div style={{ 
                background: 'var(--theia-editorWidget-background)',
                borderRadius: '4px',
                padding: '10px',
                marginBottom: '10px',
                border: '1px solid var(--theia-panel-border)'
            }}>
                <div style={{ marginBottom: '10px' }}>
                    <label style={{ display: 'block', fontSize: '11px', marginBottom: '3px', fontWeight: 500, color: 'var(--theia-foreground)' }}>
                        Geometry File
                    </label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <input
                            type="text"
                            readOnly
                            value={this.geometryUri ? this.geometryUri.path.base : 'No file selected'}
                            placeholder="Select a geometry file..."
                            style={{
                                flex: 1,
                                padding: '5px 8px',
                                borderRadius: '3px',
                                border: '1px solid var(--theia-input-border)',
                                background: 'var(--theia-input-background)',
                                color: this.geometryUri ? 'var(--theia-input-foreground)' : 'var(--theia-descriptionForeground)',
                                fontSize: '12px'
                            }}
                        />
                        <button
                            onClick={() => this.browseForFile()}
                            disabled={this.isRunning}
                            style={{
                                padding: '5px 12px',
                                background: 'var(--theia-button-secondaryBackground)',
                                color: 'var(--theia-button-secondaryForeground)',
                                border: 'none',
                                borderRadius: '3px',
                                fontSize: '11px',
                                cursor: this.isRunning ? 'not-allowed' : 'pointer',
                                opacity: this.isRunning ? 0.6 : 1,
                                whiteSpace: 'nowrap'
                            }}
                        >
                            Browse...
                        </button>
                    </div>
                    {this.geometryUri && (
                        <div style={{ 
                            marginTop: '3px', 
                            fontSize: '10px', 
                            color: 'var(--theia-descriptionForeground)',
                            wordBreak: 'break-all',
                            lineHeight: '1.3'
                        }}>
                            {this.geometryUri.path.toString()}
                        </div>
                    )}
                </div>

                <div style={{ marginBottom: '10px' }}>
                    <label style={{ display: 'block', fontSize: '11px', marginBottom: '3px', fontWeight: 500 }}>
                        Sample Points: <span style={{ color: 'var(--theia-charts-blue)' }}>{this.samplePoints.toLocaleString()}</span>
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
                        style={{ width: '100%', height: '4px', margin: '4px 0' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--theia-descriptionForeground)' }}>
                        <span>10K</span>
                        <span>100K</span>
                        <span>1M</span>
                    </div>
                </div>

                <div style={{ marginBottom: '10px' }}>
                    <label style={{ display: 'block', fontSize: '11px', marginBottom: '3px', fontWeight: 500 }}>
                        Tolerance: <span style={{ color: 'var(--theia-charts-blue)' }}>{this.tolerance.toExponential(0)}</span>
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
                        style={{ width: '100%', height: '4px', margin: '4px 0' }}
                    />
                </div>

                <div style={{ marginBottom: '10px', padding: '6px 8px', background: 'var(--theia-editor-background)', borderRadius: '3px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: '11px', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={this.useParallel}
                            onChange={(e) => {
                                this.useParallel = e.target.checked;
                                this.update();
                            }}
                            style={{ marginRight: '6px' }}
                        />
                        <span>Use parallel processing</span>
                    </label>
                </div>

                <button
                    onClick={() => this.runOverlapCheck()}
                    disabled={!this.geometryUri || this.isRunning}
                    style={{
                        width: '100%',
                        padding: '7px 12px',
                        background: this.geometryUri && !this.isRunning 
                            ? 'var(--theia-button-background)' 
                            : 'var(--theia-button-disabledBackground)',
                        color: this.geometryUri && !this.isRunning 
                            ? 'var(--theia-button-foreground)' 
                            : 'var(--theia-button-disabledForeground)',
                        border: 'none',
                        borderRadius: '3px',
                        fontSize: '12px',
                        fontWeight: 500,
                        cursor: this.geometryUri && !this.isRunning ? 'pointer' : 'not-allowed',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '5px'
                    }}
                >
                    {this.isRunning ? (
                        <><span className="codicon codicon-loading" style={{ animation: 'spin 1s linear infinite' }}>⟳</span> Running...</>
                    ) : (
                        <><span>▶</span> Run Overlap Check</>
                    )}
                </button>
            </div>
        );
    }

    protected renderProgress(): React.ReactNode {
        return (
            <div style={{ 
                background: 'var(--theia-editorWidget-background)',
                borderRadius: '4px',
                padding: '10px',
                marginBottom: '10px',
                border: '1px solid var(--theia-panel-border)'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 500 }}>Progress: {this.progress.percentage.toFixed(1)}%</span>
                    <span style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)' }}>
                        {this.progress.checked.toLocaleString()} / {this.progress.total.toLocaleString()}
                    </span>
                </div>
                <div style={{ 
                    width: '100%', 
                    height: '5px', 
                    background: 'var(--theia-progressBar-background)',
                    borderRadius: '3px',
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
                borderRadius: '4px',
                padding: '10px',
                flex: 1,
                overflow: 'auto',
                border: '1px solid var(--theia-panel-border)'
            }}>
                <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    marginBottom: '8px',
                    paddingBottom: '8px',
                    borderBottom: '1px solid var(--theia-panel-border)'
                }}>
                    <h3 style={{ margin: 0, fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span style={{ 
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'var(--theia-charts-red)',
                            color: 'white',
                            borderRadius: '10px',
                            padding: '1px 6px',
                            fontSize: '10px',
                            fontWeight: 700
                        }}>{this.overlaps.length}</span>
                        Overlap{this.overlaps.length !== 1 ? 's' : ''} Found
                    </h3>
                    <div style={{ display: 'flex', gap: '5px' }}>
                        <button
                            onClick={() => this.visualizeAllIn3D()}
                            title="Visualize all overlaps in 3D"
                            style={{
                                padding: '3px 8px',
                                fontSize: '11px',
                                background: 'var(--theia-button-background)',
                                color: 'var(--theia-button-foreground)',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer'
                            }}
                        >
                            View 3D
                        </button>
                        <button
                            onClick={() => this.exportResults('json')}
                            style={{
                                padding: '3px 8px',
                                fontSize: '11px',
                                background: 'var(--theia-button-secondaryBackground)',
                                color: 'var(--theia-button-secondaryForeground)',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer'
                            }}
                        >
                            Export
                        </button>
                        <button
                            onClick={() => this.clearResults()}
                            style={{
                                padding: '3px 8px',
                                fontSize: '11px',
                                background: 'transparent',
                                color: 'var(--theia-foreground)',
                                border: '1px solid var(--theia-button-border)',
                                borderRadius: '3px',
                                cursor: 'pointer'
                            }}
                        >
                            Clear
                        </button>
                    </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
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
                onClick={() => this.selectOverlap(overlap)}
                style={{
                    padding: '8px',
                    background: isSelected 
                        ? 'var(--theia-list-activeSelectionBackground)' 
                        : 'var(--theia-list-hoverBackground)',
                    border: `1px solid ${isSelected ? 'var(--theia-list-activeSelectionBackground)' : 'transparent'}`,
                    borderRadius: '3px',
                    cursor: 'pointer'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ 
                            width: '8px', 
                            height: '8px', 
                            borderRadius: '50%', 
                            background: 'var(--theia-charts-red)',
                            display: 'inline-block'
                        }}></span>
                        <span style={{ fontWeight: 500, fontSize: '11px' }}>
                            {overlap.cellIds.length > 2 
                                ? `Multi-cell (${overlap.cellIds.length})` 
                                : `Cells ${overlap.cellIds[0]} & ${overlap.cellIds[1]}`}
                        </span>
                    </div>
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            this.viewOverlapIn3D(overlap);
                        }}
                        disabled={!this.geometryUri}
                        style={{
                            padding: '2px 6px',
                            fontSize: '10px',
                            background: this.geometryUri ? 'var(--theia-button-secondaryBackground)' : 'var(--theia-button-disabledBackground)',
                            color: this.geometryUri ? 'var(--theia-button-secondaryForeground)' : 'var(--theia-button-disabledForeground)',
                            border: 'none',
                            borderRadius: '2px',
                            cursor: this.geometryUri ? 'pointer' : 'not-allowed'
                        }}
                        title="View in 3D"
                    >
                        3D
                    </button>
                </div>
                
                <div style={{
                    padding: '5px 8px',
                    background: 'var(--theia-inputValidation-errorBackground)',
                    borderRadius: '3px',
                    borderLeft: '2px solid var(--theia-charts-red)',
                    marginBottom: '6px'
                }}>
                    <div style={{ fontSize: '9px', color: 'var(--theia-charts-red)', marginBottom: '1px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                        Location
                    </div>
                    <div style={{ 
                        fontSize: '12px', 
                        color: 'var(--theia-foreground)',
                        fontFamily: 'var(--theia-code-font-family)',
                        fontWeight: 500
                    }}>
                        ({x.toFixed(4)}, {y.toFixed(4)}, {z.toFixed(4)}) cm
                    </div>
                </div>

                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {overlap.cellIds.map(cellId => (
                        <span
                            key={cellId}
                            style={{
                                fontSize: '10px',
                                padding: '1px 5px',
                                background: 'var(--theia-badge-background)',
                                color: 'var(--theia-badge-foreground)',
                                borderRadius: '2px'
                            }}
                        >
                            #{cellId}
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

    protected async visualizeAllIn3D(): Promise<void> {
        if (!this.geometryUri || this.overlaps.length === 0) {
            return;
        }

        try {
            // Open the geometry viewer with the overlaps array directly
            // The backend will handle creating a temporary file for the Python server
            await this.openmcService.openGeometryViewer(this.geometryUri, undefined, this.overlaps);
            
            this.messageService.info(`Loaded 3D view with ${this.overlaps.length} overlap markers`);
        } catch (error) {
            this.messageService.error(`Failed to visualize overlaps: ${error}`);
        }
    }

    protected async viewOverlapIn3D(overlap: OpenMCOverlap): Promise<void> {
        if (!this.geometryUri) {
            this.messageService.warn('No geometry file selected');
            return;
        }

        try {
            // Just use the first overlapping cell as highlight
            await this.openmcService.openGeometryViewer(this.geometryUri, overlap.cellIds[0]);
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
