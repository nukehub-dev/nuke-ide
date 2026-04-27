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

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import { OpenMCHeatmapData, OpenMCHeatmapPlane } from '../../../../../common/openmc-protocol';
import { PlotlyComponent } from '../../../../plotly/plotly-component';
import { OpenMCService } from '../../openmc-service';
import URI from '@theia/core/lib/common/uri';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import 'nuke-essentials/lib/theme/browser/components/tooltip.css';
import './openmc-heatmap-widget.css';
import { LoadingAnimations, FancyLoadingSpinner } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { WIDGET_IDS } from '../widget-ids';

@injectable()
export class OpenMCHeatmapWidget extends ReactWidget {
    static readonly ID = WIDGET_IDS.OPENMC_HEATMAP;
    static readonly LABEL = 'OpenMC 2D Heatmap';

    private data: OpenMCHeatmapData | null = null;
    private statepointUri: URI | null = null;
    private tallyId: number = 0;
    private scoreIndex: number = 0;
    private nuclideIndex: number = 0;
    private scoreName: string = '';
    private nuclideName: string = '';
    private titleText: string = '2D Heatmap';

    // Interactive controls
    private currentPlane: OpenMCHeatmapPlane = 'xy';
    private pendingSliceIndex: number = 0;  // Track user's selection during loading
    private isLoading: boolean = false;
    private isLoadingAllSlices: boolean = false;  // Loading all slices for animation
    private errorMessage: string | null = null;
    private loadSliceTimeout: number | null = null;  // Debounce timer
    private colormap: string = 'Jet';  // Default colormap
    private useLogScale: boolean = false;  // Toggle for log/linear scale
    private isAutoPlaying: boolean = false;  // Animation state
    private autoPlayInterval: number | null = null;  // Animation timer
    private autoPlaySpeed: number = 200;  // Speed in milliseconds (default faster for smooth animation)
    private cachedSlices: OpenMCHeatmapData[] | null = null;  // All slices cached for animation
    private hasLoadedAllSlices: boolean = false;  // Whether all slices are loaded

    // Difference view mode
    private isDifferenceMode: boolean = false;  // Show difference between slices
    private referenceSliceIndex: number = 0;  // Reference slice for comparison
    private differenceData: OpenMCHeatmapData | null = null;  // Computed difference data

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCHeatmapWidget.ID;
        this.title.label = OpenMCHeatmapWidget.LABEL;
        this.title.caption = OpenMCHeatmapWidget.LABEL;
        this.title.iconClass = codicon('type-hierarchy-sub');
        this.title.closable = true;

        // Ensure the widget can be focused
        this.node.tabIndex = 0;

        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setData(
        data: OpenMCHeatmapData,
        statepointUri: URI,
        tallyId: number,
        scoreIndex: number,
        nuclideIndex: number,
        scoreName: string,
        nuclideName: string,
        title: string
    ): void {
        this.data = data;
        this.statepointUri = statepointUri;
        this.tallyId = tallyId;
        this.scoreIndex = scoreIndex;
        this.nuclideIndex = nuclideIndex;
        this.scoreName = scoreName;
        this.nuclideName = nuclideName;
        this.titleText = title;
        this.title.label = title;
        this.currentPlane = data.plane;
        this.pendingSliceIndex = data.slice_index;
        this.errorMessage = null;
        // Reset cache when new data is set
        this.cachedSlices = null;
        this.hasLoadedAllSlices = false;
        this.isAutoPlaying = false;
        if (this.autoPlayInterval) {
            window.clearInterval(this.autoPlayInterval);
            this.autoPlayInterval = null;
        }
        this.update();
    }

    private async loadAllSlices(): Promise<void> {
        if (!this.statepointUri || this.hasLoadedAllSlices) return;
        
        this.isLoadingAllSlices = true;
        this.errorMessage = null;
        this.update();

        try {
            const slices = await this.openmcService.getAllHeatmapSlices(
                this.statepointUri,
                this.tallyId,
                this.currentPlane,
                this.scoreIndex,
                this.nuclideIndex
            );

            if (slices && slices.length > 0) {
                this.cachedSlices = slices;
                this.hasLoadedAllSlices = true;
                // Update current data to first slice
                this.data = slices[0];
                this.pendingSliceIndex = 0;
            } else {
                this.errorMessage = 'No slices loaded';
            }
        } catch (error) {
            this.errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
            this.isLoadingAllSlices = false;
            this.update();
        }
    }

    private async loadSlice(plane: OpenMCHeatmapPlane, sliceIndex: number): Promise<void> {
        if (!this.statepointUri) return;

        this.isLoading = true;
        this.errorMessage = null;
        this.update();

        try {
            const newData = await this.openmcService.getHeatmapSlice(
                this.statepointUri,
                this.tallyId,
                plane,
                sliceIndex,
                this.scoreIndex,
                this.nuclideIndex
            );

            if (newData.error) {
                this.errorMessage = newData.error;
            } else {
                this.data = newData;
                this.currentPlane = plane;
                this.pendingSliceIndex = newData.slice_index;
            }
        } catch (error) {
            this.errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
            this.isLoading = false;
            this.loadSliceTimeout = null;
            this.update();
        }
    }

    private handlePlaneChange = (plane: OpenMCHeatmapPlane): void => {
        // Stop any ongoing animation
        if (this.isAutoPlaying) {
            this.stopAutoPlay();
        }
        // Clear cached slices from previous plane
        this.cachedSlices = null;
        this.hasLoadedAllSlices = false;
        // Reset difference mode when changing planes
        this.isDifferenceMode = false;
        this.differenceData = null;
        // Reset slice index and load first slice of new plane
        this.loadSlice(plane, 0);
    };

    private handleSliceChange = (sliceIndex: number): void => {
        // If we have cached slices, use them immediately
        if (this.cachedSlices && sliceIndex < this.cachedSlices.length) {
            this.pendingSliceIndex = sliceIndex;
            this.data = this.cachedSlices[sliceIndex];
            // Recalculate difference if in difference mode
            if (this.isDifferenceMode) {
                this.calculateDifference();
            }
            this.update();
            return;
        }
        
        // Otherwise, load from server
        // Update immediately for responsive UI
        this.pendingSliceIndex = sliceIndex;
        this.update();  // Re-render to show the new slider position immediately
        
        // Debounce the actual data loading to avoid rapid-fire requests while dragging
        if (this.loadSliceTimeout) {
            window.clearTimeout(this.loadSliceTimeout);
        }
        this.loadSliceTimeout = window.setTimeout(() => {
            this.loadSlice(this.currentPlane, sliceIndex);
        }, 100);  // 100ms debounce
    };

    private async toggleAutoPlay(): Promise<void> {
        if (this.isAutoPlaying) {
            this.stopAutoPlay();
        } else {
            // Load all slices first if not cached
            if (!this.hasLoadedAllSlices) {
                await this.loadAllSlices();
            }
            if (this.hasLoadedAllSlices) {
                this.startAutoPlay();
            }
        }
    }

    private startAutoPlay(): void {
        if (!this.data || !this.cachedSlices) return;
        
        this.isAutoPlaying = true;
        this.update();
        
        // Start animation loop using cached slices
        this.autoPlayInterval = window.setInterval(() => {
            if (!this.cachedSlices) return;
            
            const nextIndex = (this.pendingSliceIndex + 1) % this.cachedSlices.length;
            this.pendingSliceIndex = nextIndex;
            this.data = this.cachedSlices[nextIndex];
            // Recalculate difference if in difference mode
            if (this.isDifferenceMode) {
                this.calculateDifference();
            }
            this.update();
        }, this.autoPlaySpeed);
    }

    private stopAutoPlay(): void {
        this.isAutoPlaying = false;
        if (this.autoPlayInterval) {
            window.clearInterval(this.autoPlayInterval);
            this.autoPlayInterval = null;
        }
        this.update();
    }

    private toggleDifferenceMode(): void {
        this.isDifferenceMode = !this.isDifferenceMode;
        if (this.isDifferenceMode) {
            // Enable difference mode - calculate initial difference
            this.calculateDifference();
        } else {
            // Disable difference mode - clear difference data
            this.differenceData = null;
        }
        this.update();
    }

    private calculateDifference(): void {
        if (!this.data || !this.cachedSlices) return;
        
        const currentSlice = this.cachedSlices[this.pendingSliceIndex];
        const referenceSlice = this.cachedSlices[this.referenceSliceIndex];
        
        if (!currentSlice || !referenceSlice) return;
        
        // Calculate difference: current - reference
        const diffValues: number[][] = [];
        for (let i = 0; i < currentSlice.values.length; i++) {
            const row: number[] = [];
            for (let j = 0; j < currentSlice.values[i].length; j++) {
                row.push(currentSlice.values[i][j] - referenceSlice.values[i][j]);
            }
            diffValues.push(row);
        }
        
        this.differenceData = {
            ...currentSlice,
            values: diffValues,
            slice_index: this.pendingSliceIndex
        };
    }

    private handleReferenceSliceChange = (refIndex: number): void => {
        this.referenceSliceIndex = refIndex;
        if (this.isDifferenceMode) {
            this.calculateDifference();
        }
        this.update();
    };



    protected render(): React.ReactNode {
        if (this.errorMessage) {
            return this.renderError();
        }

        if (!this.data) {
            return this.renderEmpty();
        }

        return (
            <div className="openmc-heatmap-container">
                {/* Header */}
                <div className="openmc-heatmap-header">
                    <h3>{this.titleText}</h3>
                    <div className="openmc-heatmap-header-meta">
                        {this.scoreName && this.nuclideName ? `${this.scoreName} (${this.nuclideName})` : ''}
                    </div>
                </div>

                {/* Controls */}
                {this.renderControls()}

                {/* Plot Area */}
                <div className="openmc-heatmap-plot-area">
                    {this.isLoading ? (
                        <div className="openmc-heatmap-loading">
                            Loading...
                        </div>
                    ) : (
                        this.renderHeatmap(
                            this.isDifferenceMode && this.differenceData ? this.differenceData : this.data
                        )
                    )}
                </div>
            </div>
        );
    }

    private renderEmpty(): React.ReactNode {
        return (
            <div className="openmc-heatmap-empty">
                <LoadingAnimations />
                <FancyLoadingSpinner
                    message="Loading heatmap data..."
                    subMessage="Fetching slice from statepoint"
                />
            </div>
        );
    }

    private renderError(): React.ReactNode {
        return (
            <div className="openmc-heatmap-error">
                <div className="openmc-heatmap-error-title">Error</div>
                <div>{this.errorMessage}</div>
            </div>
        );
    }

    private renderControls(): React.ReactNode {
        if (!this.data) return null;

        const { plane, total_slices, slice_label } = this.data;
        const displaySliceIndex = this.pendingSliceIndex;

        const planes: { key: OpenMCHeatmapPlane; label: string }[] = [
            { key: 'xy', label: 'XY (Z slice)' },
            { key: 'xz', label: 'XZ (Y slice)' },
            { key: 'yz', label: 'YZ (X slice)' }
        ];

        return (
            <div className="openmc-heatmap-controls">
                {/* Plane Selection */}
                <div className="openmc-heatmap-plane-group">
                    {planes.map(({ key, label }) => (
                        <button
                            key={key}
                            onClick={() => this.handlePlaneChange(key)}
                            disabled={this.isLoading}
                            className={`openmc-heatmap-plane-btn ${plane === key ? 'active' : ''}`}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Slice Slider */}
                <div className="openmc-heatmap-slider-group">
                    <span className="openmc-heatmap-slider-label">{slice_label} Slice:</span>
                    <input
                        type="range"
                        min={0}
                        max={total_slices - 1}
                        value={displaySliceIndex}
                        className="openmc-heatmap-slider"
                        onInput={(e) => {
                            e.stopPropagation();
                            this.handleSliceChange(parseInt((e.target as HTMLInputElement).value, 10));
                        }}
                        onChange={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        disabled={this.isLoading}
                    />
                    <span className="openmc-heatmap-slider-value">
                        {displaySliceIndex + 1} / {total_slices}
                    </span>
                </div>

                {/* Colormap Selector */}
                <div className="openmc-heatmap-select-group">
                    <span className="openmc-heatmap-select-label">Colormap:</span>
                    <select
                        value={this.colormap}
                        onChange={(e) => { this.colormap = e.target.value; this.update(); }}
                        disabled={this.isLoading}
                        className="openmc-heatmap-select"
                    >
                        <option value="Jet">Jet</option>
                        <option value="Viridis">Viridis</option>
                        <option value="Plasma">Plasma</option>
                        <option value="Inferno">Inferno</option>
                        <option value="Magma">Magma</option>
                        <option value="Cividis">Cividis</option>
                        <option value="Hot">Hot</option>
                        <option value="Cool">Cool</option>
                        <option value="Rainbow">Rainbow</option>
                        <option value="RdYlBu">RdYlBu</option>
                        <option value="RdBu">RdBu</option>
                        <option value="Spectral">Spectral</option>
                        <option value="Blues">Blues</option>
                        <option value="Greens">Greens</option>
                        <option value="Greys">Greys</option>
                    </select>
                </div>

                {/* Log Scale Toggle */}
                <label className={`openmc-heatmap-checkbox-label ${this.isLoading ? 'disabled' : ''}`}>
                    <input
                        type="checkbox"
                        checked={this.useLogScale}
                        onChange={() => { this.useLogScale = !this.useLogScale; this.update(); }}
                        disabled={this.isLoading}
                    />
                    Log Scale
                </label>

                {/* Difference View Toggle */}
                {this.hasLoadedAllSlices && (
                    <div className={`openmc-heatmap-difference-badge ${this.isDifferenceMode ? 'active' : ''}`}>
                        <label>
                            <input
                                type="checkbox"
                                checked={this.isDifferenceMode}
                                onChange={() => this.toggleDifferenceMode()}
                                disabled={this.isAutoPlaying}
                            />
                            Difference View
                        </label>
                        {this.isDifferenceMode && (
                            <>
                                <span className="openmc-heatmap-select-label">Ref:</span>
                                <select
                                    value={this.referenceSliceIndex}
                                    onChange={(e) => this.handleReferenceSliceChange(parseInt(e.target.value))}
                                    disabled={this.isAutoPlaying}
                                    className="openmc-heatmap-select"
                                >
                                    {Array.from({ length: this.data?.total_slices || 0 }, (_, i) => (
                                        <option key={i} value={i}>Slice {i + 1}</option>
                                    ))}
                                </select>
                            </>
                        )}
                    </div>
                )}

                {/* Statistics */}
                {this.data && (() => {
                    const dataToUse = this.isDifferenceMode && this.differenceData ? this.differenceData : this.data;
                    const allValues = dataToUse.values.flat();
                    const minVal = Math.min(...allValues);
                    const maxVal = Math.max(...allValues);
                    const meanVal = allValues.reduce((a, b) => a + b, 0) / allValues.length;
                    return (
                        <div className={`openmc-heatmap-stats ${this.isDifferenceMode ? 'openmc-heatmap-stats--difference' : ''}`}>
                            {this.isDifferenceMode && (
                                <span className="openmc-heatmap-stat-label">Δ:</span>
                            )}
                            <span className="openmc-heatmap-stat-min">Min: {minVal.toExponential(3)}</span>
                            <span className="openmc-heatmap-stat-max">Max: {maxVal.toExponential(3)}</span>
                            <span className="openmc-heatmap-stat-mean">Mean: {meanVal.toExponential(3)}</span>
                            {this.data?.mesh_dimensions && (
                                <span className="openmc-heatmap-stat-mesh">
                                    Mesh: {this.data.mesh_dimensions.join(' × ')}
                                </span>
                            )}
                        </div>
                    );
                })()}

                {/* Playback Controls */}
                <div className="openmc-heatmap-playback">
                    {!this.hasLoadedAllSlices && !this.isLoadingAllSlices && (
                        <Tooltip content="Load all slices for smooth animation" position="top">
                            <button
                                onClick={() => this.loadAllSlices()}
                                disabled={this.isLoading}
                                className="openmc-heatmap-btn openmc-heatmap-btn--primary"
                            >
                                Load All
                            </button>
                        </Tooltip>
                    )}
                    {this.isLoadingAllSlices && (
                        <span className="openmc-heatmap-loading-text">
                            Loading {this.data?.total_slices} slices...
                        </span>
                    )}
                    {this.hasLoadedAllSlices && (
                        <>
                            <button
                                onClick={() => this.toggleAutoPlay()}
                                disabled={this.isLoading}
                                className={`openmc-heatmap-btn ${this.isAutoPlaying ? 'openmc-heatmap-btn--danger' : 'openmc-heatmap-btn--success'}`}
                            >
                                {this.isAutoPlaying ? 'Stop' : 'Play'}
                            </button>
                            <select
                                value={this.autoPlaySpeed}
                                onChange={(e) => { this.autoPlaySpeed = parseInt(e.target.value); this.update(); }}
                                disabled={this.isAutoPlaying}
                                className="openmc-heatmap-select"
                            >
                                <option value="1000">Slow (1s)</option>
                                <option value="500">Normal (0.5s)</option>
                                <option value="200">Fast (0.2s)</option>
                            </select>
                        </>
                    )}
                </div>
            </div>
        );
    }

    private renderHeatmap(data: OpenMCHeatmapData): React.ReactNode {
        const { values, x_coords, y_coords, x_label, y_label, slice_position, slice_label } = data;

        // Get computed colors for Plotly (CSS variables don't work in Canvas/SVG)
        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#3c3c3c');
        const warningColor = this.getCssColor('--theia-warningForeground', '#cca700');

        // Calculate value range for color scale
        const allValues = values.flat();
        const minValue = Math.min(...allValues.filter(v => v > 0)) || 1e-10;
        const maxValue = Math.max(...allValues) || 1;

        // Determine effective colormap - use diverging for difference mode
        const effectiveColormap = this.isDifferenceMode ? 'RdBu' : this.colormap;

        // Apply log scale transformation if enabled (not in difference mode)
        let displayValues = values;
        let zMin: number | undefined = minValue;
        let zMax: number | undefined = maxValue;
        let colorbarTitle = this.isDifferenceMode ? 'Difference' : 'Tally Value';
        let hoverTemplate = `<b>${x_label.split(' ')[0]}:</b> %{x:.3f} cm<br><b>${y_label.split(' ')[0]}:</b> %{y:.3f} cm<br><b>Value:</b> %{z:.6e}<extra></extra>`;

        if (this.isDifferenceMode) {
            // For difference mode: symmetric scale around zero
            const absMax = Math.max(Math.abs(Math.min(...allValues)), Math.abs(Math.max(...allValues)));
            zMin = -absMax;
            zMax = absMax;
            hoverTemplate = `<b>${x_label.split(' ')[0]}:</b> %{x:.3f} cm<br><b>${y_label.split(' ')[0]}:</b> %{y:.3f} cm<br><b>Diff:</b> %{z:.6e}<extra></extra>`;
        } else if (this.useLogScale) {
            // Transform values to log10, handling zeros/negatives
            displayValues = values.map(row => 
                row.map(v => v > 0 ? Math.log10(v) : Math.log10(minValue))
            );
            zMin = Math.log10(minValue);
            zMax = Math.log10(maxValue);
            colorbarTitle = 'log₁₀(Tally Value)';
            hoverTemplate = `<b>${x_label.split(' ')[0]}:</b> %{x:.3f} cm<br><b>${y_label.split(' ')[0]}:</b> %{y:.3f} cm<br><b>Value:</b> 10^%{z:.2f} = %{customdata:.6e}<extra></extra>`;
        }

        const trace: Partial<Plotly.Data> = {
            z: displayValues,
            x: x_coords,
            y: y_coords,
            type: 'heatmap',
            zsmooth: 'best',
            colorscale: effectiveColormap as Plotly.ColorScale,
            zmin: zMin,
            zmax: zMax,
            customdata: this.useLogScale ? values : undefined,  // Original values for hover
            colorbar: {
                title: {
                    text: colorbarTitle,
                    font: { color: fgColor }
                },
                tickfont: { color: fgColor }
            },
            hovertemplate: hoverTemplate
        };

        const layout: Partial<Plotly.Layout> = {
            xaxis: {
                title: { text: x_label, font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                zerolinecolor: gridColor
            },
            yaxis: {
                title: { text: y_label, font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                zerolinecolor: gridColor,
                scaleanchor: 'x',  // Keep aspect ratio square
                scaleratio: 1
            },
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { t: 50, r: 30, b: 50, l: 60 },
            annotations: [{
                x: 0.5,
                y: 1.08,
                xref: 'paper',
                yref: 'paper',
                text: this.isDifferenceMode 
                    ? `Difference: Slice ${(this.pendingSliceIndex + 1)} − Slice ${(this.referenceSliceIndex + 1)} (${slice_label} = ${slice_position.toFixed(3)} cm)`
                    : `${slice_label} = ${slice_position.toFixed(3)} cm`,
                showarrow: false,
                font: {
                    size: this.isDifferenceMode ? 13 : 14,
                    color: this.isDifferenceMode ? warningColor : fgColor,
                    weight: this.isDifferenceMode ? 700 : 400
                }
            }],
            hovermode: 'closest'
        };

        const config: Partial<Plotly.Config> = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d']
        };

        return <PlotlyComponent data={[trace]} layout={layout} config={config} />;
    }

    protected onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.triggerPlotResize();
    }

    protected onResize(msg: any): void {
        super.onResize(msg);
        this.triggerPlotResize();
    }

    private triggerPlotResize(): void {
        // Many Plotly components rely on window resize events, but Lumino doesn't trigger them
        window.dispatchEvent(new Event('resize'));
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    protected onCloseRequest(msg: Message): void {
        // Clean up any pending timeouts
        if (this.loadSliceTimeout) {
            window.clearTimeout(this.loadSliceTimeout);
            this.loadSliceTimeout = null;
        }
        // Stop auto-play if running
        if (this.autoPlayInterval) {
            window.clearInterval(this.autoPlayInterval);
            this.autoPlayInterval = null;
        }
        super.onCloseRequest(msg);
    }

    /**
     * Helper to get computed color from CSS variable
     */
    private getCssColor(variable: string, fallback: string): string {
        if (typeof window === 'undefined') return fallback;
        const computed = getComputedStyle(document.body).getPropertyValue(variable.replace('var(', '').replace(')', '')).trim();
        return computed || fallback;
    }
}
