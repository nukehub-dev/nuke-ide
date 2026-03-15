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
    private errorMessage: string | null = null;
    private loadSliceTimeout: number | null = null;  // Debounce timer
    private colormap: string = 'Jet';  // Default colormap
    private useLogScale: boolean = false;  // Toggle for log/linear scale

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
        this.update();
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
        // Reset slice index when changing planes
        this.loadSlice(plane, 0);
    };

    private handleSliceChange = (sliceIndex: number): void => {
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
                        this.renderHeatmap(this.data, theme)
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

                {/* Min/Max Statistics */}
                {this.data && (() => {
                    const allValues = this.data.values.flat();
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
                            backgroundColor: theme === 'dark' ? '#252525' : '#e8e8e8',
                            borderRadius: '4px'
                        }}>
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
            </div>
        );
    }

    private renderHeatmap(data: OpenMCHeatmapData, theme: 'dark' | 'light'): React.ReactNode {
        const { values, x_coords, y_coords, x_label, y_label, slice_position, slice_label } = data;

        // Calculate value range for color scale
        const allValues = values.flat();
        const minValue = Math.min(...allValues.filter(v => v > 0)) || 1e-10;
        const maxValue = Math.max(...allValues) || 1;

        // Apply log scale transformation if enabled
        let displayValues = values;
        let zMin = minValue;
        let zMax = maxValue;
        let colorbarTitle = 'Tally Value';
        let hoverTemplate = `<b>${x_label.split(' ')[0]}:</b> %{x:.3f} cm<br><b>${y_label.split(' ')[0]}:</b> %{y:.3f} cm<br><b>Value:</b> %{z:.6e}<extra></extra>`;

        if (this.useLogScale) {
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
            colorscale: this.colormap as Plotly.ColorScale,
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
                y: 1.06,
                xref: 'paper',
                yref: 'paper',
                text: `${slice_label} = ${slice_position.toFixed(3)} cm`,
                showarrow: false,
                font: {
                    size: 14,
                    color: theme === 'dark' ? '#ccc' : '#333'
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
        super.onCloseRequest(msg);
    }
}
