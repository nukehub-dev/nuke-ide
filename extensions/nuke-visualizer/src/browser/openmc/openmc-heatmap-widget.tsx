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

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { OpenMCHeatmapData, OpenMCHeatmapPlane } from '../../common/visualizer-protocol';
import { PlotlyComponent } from '../plotly/plotly-component';
import { OpenMCService } from './openmc-service';
import URI from '@theia/core/lib/common/uri';

@injectable()
export class OpenMCHeatmapWidget extends ReactWidget {
    static readonly ID = 'openmc-heatmap-widget';
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

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

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

        // Listen for theme changes to re-render the plot
        this.themeService.onDidColorThemeChange(() => this.update());

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

    protected getCurrentTheme(): 'dark' | 'light' {
        const themeId = this.themeService.getCurrentTheme().id;
        return themeId.indexOf('light') !== -1 ? 'light' : 'dark';
    }

    protected render(): React.ReactNode {
        if (this.errorMessage) {
            return this.renderError();
        }

        if (!this.data) {
            return this.renderEmpty();
        }

        const theme = this.getCurrentTheme();
        const bgColor = theme === 'dark' ? '#1e1e1e' : '#ffffff';
        const textColor = theme === 'dark' ? '#cccccc' : '#333333';

        return (
            <div className="openmc-heatmap" style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                backgroundColor: bgColor,
                color: textColor,
                fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif',
                overflow: 'hidden'
            }}>
                {/* Header */}
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 20px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#333' : '#eee'}`
                }}>
                    <h3 style={{ margin: 0, color: theme === 'dark' ? '#fff' : '#000' }}>{this.titleText}</h3>
                    <div style={{ fontSize: '12px', color: '#888' }}>
                        {this.scoreName && this.nuclideName ? `${this.scoreName} (${this.nuclideName})` : ''}
                    </div>
                </div>

                {/* Controls */}
                {this.renderControls(theme)}

                {/* Plot Area */}
                <div style={{ flex: 1, position: 'relative', minHeight: '350px', overflow: 'hidden' }}>
                    {this.isLoading ? (
                        <div style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            color: '#888'
                        }}>
                            Loading...
                        </div>
                    ) : (
                        this.renderHeatmap(
                            this.isDifferenceMode && this.differenceData ? this.differenceData : this.data, 
                            theme
                        )
                    )}
                </div>
            </div>
        );
    }

    private renderEmpty(): React.ReactNode {
        return (
            <div style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#888',
                padding: '20px'
            }}>
                <div>No heatmap data to display</div>
            </div>
        );
    }

    private renderError(): React.ReactNode {
        const theme = this.getCurrentTheme();
        return (
            <div style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: theme === 'dark' ? '#ff6b6b' : '#d32f2f',
                padding: '20px',
                textAlign: 'center'
            }}>
                <div style={{ fontSize: '18px', marginBottom: '10px' }}>Error</div>
                <div>{this.errorMessage}</div>
            </div>
        );
    }

    private renderControls(theme: 'dark' | 'light'): React.ReactNode {
        if (!this.data) return null;

        const { plane, total_slices, slice_label } = this.data;
        // Use pendingSliceIndex for responsive slider (updates immediately on user interaction)
        const displaySliceIndex = this.pendingSliceIndex;
        const bgColor = theme === 'dark' ? '#2d2d2d' : '#f5f5f5';
        const borderColor = theme === 'dark' ? '#444' : '#ddd';
        const buttonBg = theme === 'dark' ? '#3c3c3c' : '#e0e0e0';
        const buttonActiveBg = theme === 'dark' ? '#0e639c' : '#007acc';
        const textColor = theme === 'dark' ? '#ccc' : '#333';

        const planes: { key: OpenMCHeatmapPlane; label: string }[] = [
            { key: 'xy', label: 'XY (Z slice)' },
            { key: 'xz', label: 'XZ (Y slice)' },
            { key: 'yz', label: 'YZ (X slice)' }
        ];

        return (
            <div style={{
                padding: '10px 20px',
                backgroundColor: bgColor,
                borderBottom: `1px solid ${borderColor}`,
                display: 'flex',
                gap: '20px',
                alignItems: 'center',
                flexWrap: 'wrap'
            }}>
                {/* Plane Selection */}
                <div style={{ display: 'flex', gap: '5px' }}>
                    {planes.map(({ key, label }) => (
                        <button
                            key={key}
                            onClick={() => this.handlePlaneChange(key)}
                            disabled={this.isLoading}
                            style={{
                                padding: '6px 12px',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: this.isLoading ? 'not-allowed' : 'pointer',
                                backgroundColor: plane === key ? buttonActiveBg : buttonBg,
                                color: plane === key ? '#fff' : textColor,
                                fontSize: '12px',
                                opacity: this.isLoading ? 0.6 : 1
                            }}
                        >
                            {label}
                        </button>
                    ))}
                </div>

                {/* Slice Slider */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '250px' }}>
                    <span style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>
                        {slice_label} Slice:
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={total_slices - 1}
                        value={displaySliceIndex}
                        onInput={(e) => {
                            // Use onInput for immediate response during dragging
                            e.stopPropagation();
                            this.handleSliceChange(parseInt((e.target as HTMLInputElement).value, 10));
                        }}
                        onChange={(e) => {
                            // onChange fires when dragging ends
                            e.stopPropagation();
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onMouseUp={(e) => e.stopPropagation()}
                        disabled={this.isLoading}
                        style={{
                            flex: 1,
                            cursor: this.isLoading ? 'not-allowed' : 'pointer',
                            outline: 'none',
                            WebkitAppearance: 'none',
                            appearance: 'none',
                            background: 'transparent'
                        }}
                    />
                    <span style={{ fontSize: '12px', whiteSpace: 'nowrap', minWidth: '80px' }}>
                        {displaySliceIndex + 1} / {total_slices}
                    </span>
                </div>

                {/* Colormap Selector */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>Colormap:</span>
                    <select
                        value={this.colormap}
                        onChange={(e) => { this.colormap = e.target.value; this.update(); }}
                        disabled={this.isLoading}
                        style={{
                            padding: '4px 8px',
                            fontSize: '12px',
                            borderRadius: '4px',
                            border: `1px solid ${borderColor}`,
                            backgroundColor: buttonBg,
                            color: textColor,
                            cursor: this.isLoading ? 'not-allowed' : 'pointer'
                        }}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <label style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '6px',
                        fontSize: '12px',
                        cursor: this.isLoading ? 'not-allowed' : 'pointer',
                        opacity: this.isLoading ? 0.6 : 1
                    }}>
                        <input
                            type="checkbox"
                            checked={this.useLogScale}
                            onChange={() => { this.useLogScale = !this.useLogScale; this.update(); }}
                            disabled={this.isLoading}
                        />
                        Log Scale
                    </label>
                </div>

                {/* Difference View Toggle - Only show when all slices loaded */}
                {this.hasLoadedAllSlices && (
                    <div style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '8px',
                        padding: '4px 10px',
                        backgroundColor: this.isDifferenceMode ? (theme === 'dark' ? '#3d2818' : '#fff3e0') : 'transparent',
                        borderRadius: '4px',
                        border: this.isDifferenceMode ? `1px solid ${theme === 'dark' ? '#ff9800' : '#ff9800'}` : 'none'
                    }}>
                        <label style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '6px',
                            fontSize: '12px',
                            cursor: this.isAutoPlaying ? 'not-allowed' : 'pointer',
                            opacity: this.isAutoPlaying ? 0.6 : 1,
                            color: this.isDifferenceMode ? '#ff9800' : textColor,
                            fontWeight: this.isDifferenceMode ? 'bold' : 'normal'
                        }}>
                            <input
                                type="checkbox"
                                checked={this.isDifferenceMode}
                                onChange={() => this.toggleDifferenceMode()}
                                disabled={this.isAutoPlaying}
                            />
                            🔍 Difference View
                        </label>
                        {this.isDifferenceMode && (
                            <>
                                <span style={{ fontSize: '11px', color: '#888' }}>Ref:</span>
                                <select
                                    value={this.referenceSliceIndex}
                                    onChange={(e) => this.handleReferenceSliceChange(parseInt(e.target.value))}
                                    disabled={this.isAutoPlaying}
                                    style={{
                                        padding: '2px 6px',
                                        fontSize: '11px',
                                        borderRadius: '4px',
                                        border: `1px solid ${borderColor}`,
                                        backgroundColor: buttonBg,
                                        color: textColor,
                                        cursor: this.isAutoPlaying ? 'not-allowed' : 'pointer'
                                    }}
                                >
                                    {Array.from({ length: this.data?.total_slices || 0 }, (_, i) => (
                                        <option key={i} value={i}>Slice {i + 1}</option>
                                    ))}
                                </select>
                            </>
                        )}
                    </div>
                )}

                {/* Min/Max Statistics */}
                {this.data && (() => {
                    // Use difference data for stats when in difference mode
                    const dataToUse = this.isDifferenceMode && this.differenceData ? this.differenceData : this.data;
                    const allValues = dataToUse.values.flat();
                    const minVal = Math.min(...allValues);
                    const maxVal = Math.max(...allValues);
                    const meanVal = allValues.reduce((a, b) => a + b, 0) / allValues.length;
                    return (
                        <div style={{ 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '12px',
                            fontSize: '11px',
                            padding: '4px 10px',
                            backgroundColor: this.isDifferenceMode 
                                ? (theme === 'dark' ? '#3d2818' : '#fff3e0')
                                : (theme === 'dark' ? '#252525' : '#e8e8e8'),
                            borderRadius: '4px',
                            border: this.isDifferenceMode ? `1px solid ${theme === 'dark' ? '#ff9800' : '#ff9800'}` : 'none'
                        }}>
                            {this.isDifferenceMode && (
                                <span style={{ color: '#ff9800', fontWeight: 'bold' }}>
                                    Δ:
                                </span>
                            )}
                            <span style={{ color: theme === 'dark' ? '#ff6b6b' : '#d32f2f' }}>
                                Min: {minVal.toExponential(3)}
                            </span>
                            <span style={{ color: theme === 'dark' ? '#4caf50' : '#2e7d32' }}>
                                Max: {maxVal.toExponential(3)}
                            </span>
                            <span style={{ color: theme === 'dark' ? '#2196f3' : '#1565c0' }}>
                                Mean: {meanVal.toExponential(3)}
                            </span>
                        </div>
                    );
                })()}

                {/* Auto-play Controls */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {!this.hasLoadedAllSlices && !this.isLoadingAllSlices && (
                        <button
                            onClick={() => this.loadAllSlices()}
                            disabled={this.isLoading}
                            style={{
                                padding: '4px 12px',
                                fontSize: '12px',
                                borderRadius: '4px',
                                border: 'none',
                                backgroundColor: '#2196f3',
                                color: 'white',
                                cursor: this.isLoading ? 'not-allowed' : 'pointer',
                                opacity: this.isLoading ? 0.6 : 1
                            }}
                            title="Load all slices for smooth animation"
                        >
                            📥 Load All
                        </button>
                    )}
                    {this.isLoadingAllSlices && (
                        <span style={{ fontSize: '12px', color: '#888' }}>
                            Loading {this.data?.total_slices} slices...
                        </span>
                    )}
                    {this.hasLoadedAllSlices && (
                        <>
                            <button
                                onClick={() => this.toggleAutoPlay()}
                                disabled={this.isLoading}
                                style={{
                                    padding: '4px 12px',
                                    fontSize: '12px',
                                    borderRadius: '4px',
                                    border: 'none',
                                    backgroundColor: this.isAutoPlaying ? '#ff6b6b' : '#4caf50',
                                    color: 'white',
                                    cursor: this.isLoading ? 'not-allowed' : 'pointer'
                                }}
                            >
                                {this.isAutoPlaying ? '⏸ Stop' : '▶ Play'}
                            </button>
                            <select
                                value={this.autoPlaySpeed}
                                onChange={(e) => { this.autoPlaySpeed = parseInt(e.target.value); this.update(); }}
                                disabled={this.isAutoPlaying}
                                style={{
                                    padding: '4px 8px',
                                    fontSize: '11px',
                                    borderRadius: '4px',
                                    border: `1px solid ${borderColor}`,
                                    backgroundColor: buttonBg,
                                    color: textColor,
                                    cursor: this.isAutoPlaying ? 'not-allowed' : 'pointer'
                                }}
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

    private renderHeatmap(data: OpenMCHeatmapData, theme: 'dark' | 'light'): React.ReactNode {
        const { values, x_coords, y_coords, x_label, y_label, slice_position, slice_label } = data;

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
            colorscale: effectiveColormap as Plotly.ColorScale,
            zmin: zMin,
            zmax: zMax,
            customdata: this.useLogScale ? values : undefined,  // Original values for hover
            colorbar: {
                title: {
                    text: colorbarTitle,
                    font: { color: theme === 'dark' ? '#ccc' : '#333' }
                },
                tickfont: { color: theme === 'dark' ? '#ccc' : '#333' }
            },
            hovertemplate: hoverTemplate
        };

        const layout: Partial<Plotly.Layout> = {
            xaxis: {
                title: { text: x_label, font: { color: theme === 'dark' ? '#ccc' : '#333' } },
                tickfont: { color: theme === 'dark' ? '#ccc' : '#333' },
                gridcolor: theme === 'dark' ? '#444' : '#ddd',
                zerolinecolor: theme === 'dark' ? '#444' : '#ddd'
            },
            yaxis: {
                title: { text: y_label, font: { color: theme === 'dark' ? '#ccc' : '#333' } },
                tickfont: { color: theme === 'dark' ? '#ccc' : '#333' },
                gridcolor: theme === 'dark' ? '#444' : '#ddd',
                zerolinecolor: theme === 'dark' ? '#444' : '#ddd',
                scaleanchor: 'x',  // Keep aspect ratio square
                scaleratio: 1
            },
            paper_bgcolor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
            plot_bgcolor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
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
                    color: this.isDifferenceMode ? '#ff9800' : (theme === 'dark' ? '#ccc' : '#333'),
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

        return <PlotlyComponent data={[trace]} layout={layout} config={config} theme={theme} />;
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
}
