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
import { ThemeService } from '@theia/core/lib/browser/theming';
import { 
    OpenMCDepletionSummary,
    OpenMCDepletionMaterial,
    OpenMCDepletionNuclideData,
    DEPLETION_NUCLIDE_PRESETS,
    DepletionPlotType,
    DepletionScaleType,
    DepletionXAxis,
    DepletionNuclidePreset
} from '../../common/visualizer-protocol';
import { PlotlyComponent } from '../plotly/plotly-component';
import { OpenMCService } from './openmc-service';
import URI from '@theia/core/lib/common/uri';

@injectable()
export class OpenMCDepletionWidget extends ReactWidget {
    static readonly ID = 'openmc-depletion-widget';
    static readonly LABEL = 'Depletion/Burnup Visualization';

    // File data
    private fileUri: URI | null = null;
    private fileName: string = '';
    
    // Depletion data
    private summary: OpenMCDepletionSummary | null = null;
    private materials: OpenMCDepletionMaterial[] = [];
    private selectedMaterialIndex: number = 0;
    private nuclideData: OpenMCDepletionNuclideData[] = [];
    private isLoading: boolean = false;
    private errorMessage: string | null = null;
    
    // Plot settings
    private plotType: DepletionPlotType = 'concentration';
    private scaleType: DepletionScaleType = 'log';
    private xAxisType: DepletionXAxis = 'burnup';
    private selectedNuclides: Set<string> = new Set();
    
    // UI state
    private showAllNuclides: boolean = false;
    private searchFilter: string = '';

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCDepletionWidget.ID;
        this.title.label = OpenMCDepletionWidget.LABEL;
        this.title.caption = OpenMCDepletionWidget.LABEL;
        this.title.iconClass = codicon('flame');
        this.title.closable = true;
        this.update();
    }

    /**
     * Set the depletion file to visualize.
     */
    setDepletionFile(fileUri: URI, fileName: string): void {
        this.fileUri = fileUri;
        this.fileName = fileName;
        this.title.label = `Depletion: ${fileName}`;
        this.selectedMaterialIndex = -1;  // Will be set after loading materials
        this.selectedNuclides.clear();
        this.loadData();
    }

    private async loadData(): Promise<void> {
        if (!this.fileUri) return;

        this.isLoading = true;
        this.errorMessage = null;
        this.update();

        try {
            // Load summary
            this.summary = await this.openmcService.getDepletionSummary(this.fileUri);
            
            // Load materials
            this.materials = await this.openmcService.getDepletionMaterials(this.fileUri);
            
            // Load data for first material (use actual material index, not array index)
            if (this.materials.length > 0) {
                this.selectedMaterialIndex = this.materials[0].index;
                await this.loadMaterialData(this.selectedMaterialIndex);
            }
        } catch (error) {
            this.errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
            this.isLoading = false;
            this.update();
        }
    }

    private async loadMaterialData(materialIndex: number): Promise<void> {
        if (!this.fileUri) return;

        this.isLoading = true;
        this.update();

        try {
            const response = await this.openmcService.getDepletionData(
                this.fileUri,
                materialIndex,
                undefined  // Load all nuclides
            );

            if (response.materialData) {
                this.nuclideData = response.materialData.nuclides;
                
                // Auto-select important nuclides if none selected
                if (this.selectedNuclides.size === 0 && this.nuclideData.length > 0) {
                    const importantNuclides = ['U235', 'U238', 'Pu239', 'Pu240', 'Pu241', 'Xe135', 'Sm149'];
                    for (const nuc of importantNuclides) {
                        if (this.nuclideData.some(n => n.nuclide === nuc)) {
                            this.selectedNuclides.add(nuc);
                        }
                    }
                    // If still none selected, pick first 5
                    if (this.selectedNuclides.size === 0) {
                        this.nuclideData.slice(0, 5).forEach(n => this.selectedNuclides.add(n.nuclide));
                    }
                }
            }
        } catch (error) {
            this.errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
            this.isLoading = false;
            this.update();
        }
    }

    protected render(): React.ReactNode {
        if (this.errorMessage) {
            return this.renderError();
        }

        if (!this.fileUri) {
            return this.renderEmpty();
        }

        const theme = this.getCurrentTheme();

        return (
            <div style={{ 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column',
                backgroundColor: theme === 'dark' ? '#1e1e1e' : '#ffffff'
            }}>
                {/* Header */}
                {this.renderHeader(theme)}
                
                {/* Main Content */}
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                    {/* Sidebar */}
                    {this.renderSidebar(theme)}
                    
                    {/* Plot Area */}
                    <div style={{ flex: 1, padding: '10px', overflow: 'auto' }}>
                        {this.isLoading ? (
                            <div style={{
                                height: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: '#888'
                            }}>
                                Loading depletion data...
                            </div>
                        ) : (
                            this.renderPlot(theme)
                        )}
                    </div>
                </div>
            </div>
        );
    }

    private renderHeader(theme: 'dark' | 'light'): React.ReactNode {
        const bgColor = theme === 'dark' ? '#2d2d2d' : '#f5f5f5';
        const textColor = theme === 'dark' ? '#ccc' : '#333';
        
        return (
            <div style={{
                padding: '10px 20px',
                backgroundColor: bgColor,
                borderBottom: `1px solid ${theme === 'dark' ? '#444' : '#ddd'}`,
                display: 'flex',
                alignItems: 'center',
                gap: '20px'
            }}>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: textColor }}>
                    🔥 Depletion: {this.fileName}
                </div>
                
                {this.summary && (
                    <div style={{ fontSize: '12px', color: '#888', display: 'flex', gap: '15px' }}>
                        <span>{this.summary.nMaterials} materials</span>
                        <span>{this.summary.nSteps} time steps</span>
                        <span>{this.summary.nNuclides} nuclides</span>
                    </div>
                )}
            </div>
        );
    }

    private renderSidebar(theme: 'dark' | 'light'): React.ReactNode {
        const bgColor = theme === 'dark' ? '#252526' : '#f3f3f3';
        const borderColor = theme === 'dark' ? '#444' : '#ddd';
        const textColor = theme === 'dark' ? '#ccc' : '#333';

        return (
            <div style={{
                width: '280px',
                backgroundColor: bgColor,
                borderRight: `1px solid ${borderColor}`,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
            }}>
                {/* Material Selector */}
                <div style={{ padding: '15px', borderBottom: `1px solid ${borderColor}` }}>
                    <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                        Material
                    </label>
                    <select
                        value={this.selectedMaterialIndex >= 0 ? this.selectedMaterialIndex : ''}
                        onChange={(e) => {
                            this.selectedMaterialIndex = parseInt(e.target.value);
                            this.loadMaterialData(this.selectedMaterialIndex);
                        }}
                        disabled={this.isLoading}
                        style={{
                            width: '100%',
                            padding: '6px',
                            fontSize: '12px',
                            borderRadius: '4px',
                            border: `1px solid ${borderColor}`,
                            backgroundColor: theme === 'dark' ? '#3c3c3c' : '#fff',
                            color: textColor
                        }}
                    >
                        {this.materials.length === 0 && (
                            <option value="">Loading...</option>
                        )}
                        {this.materials.map((mat) => (
                            <option key={mat.index} value={mat.index}>
                                {mat.name} (Mat {mat.index})
                            </option>
                        ))}
                    </select>
                </div>

                {/* Plot Settings */}
                <div style={{ padding: '15px', borderBottom: `1px solid ${borderColor}` }}>
                    <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                        Plot Type
                    </label>
                    <select
                        value={this.plotType}
                        onChange={(e) => { this.plotType = e.target.value as DepletionPlotType; this.update(); }}
                        style={{
                            width: '100%',
                            padding: '6px',
                            fontSize: '12px',
                            borderRadius: '4px',
                            border: `1px solid ${borderColor}`,
                            backgroundColor: theme === 'dark' ? '#3c3c3c' : '#fff',
                            color: textColor,
                            marginBottom: '10px'
                        }}
                    >
                        <option value="concentration">Concentration (atoms/b-cm)</option>
                        <option value="mass">Mass (grams)</option>
                        <option value="normalized">Normalized (% of initial)</option>
                    </select>

                    <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                        X-Axis
                    </label>
                    <select
                        value={this.xAxisType}
                        onChange={(e) => { this.xAxisType = e.target.value as DepletionXAxis; this.update(); }}
                        style={{
                            width: '100%',
                            padding: '6px',
                            fontSize: '12px',
                            borderRadius: '4px',
                            border: `1px solid ${borderColor}`,
                            backgroundColor: theme === 'dark' ? '#3c3c3c' : '#fff',
                            color: textColor,
                            marginBottom: '5px'
                        }}
                    >
                        <option value="burnup" disabled={!this.summary?.burnup}>
                            Burnup (MWd/kg) {this.summary?.burnup ? '' : '(N/A)'}
                        </option>
                        <option value="time">Time (days)</option>
                        <option value="step">Time Step</option>
                    </select>
                    {!this.summary?.burnup && this.xAxisType === 'burnup' && (
                        <div style={{ fontSize: '10px', color: '#ff9800', marginBottom: '10px' }}>
                            ⚠️ No burnup data - showing Time instead
                        </div>
                    )}

                    <label style={{ fontSize: '12px', color: textColor, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={this.scaleType === 'log'}
                            onChange={(e) => { this.scaleType = e.target.checked ? 'log' : 'linear'; this.update(); }}
                        />
                        Log Scale
                    </label>
                </div>

                {/* Nuclide Presets */}
                <div style={{ padding: '15px', borderBottom: `1px solid ${borderColor}` }}>
                    <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                        Quick Select (click to toggle)
                    </label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                        {DEPLETION_NUCLIDE_PRESETS.map((preset: DepletionNuclidePreset) => {
                            // Check if this preset is active (all available nuclides selected)
                            const availableNucs = preset.nuclides.filter(nuc => 
                                this.nuclideData.some(n => n.nuclide === nuc)
                            );
                            const isActive = availableNucs.length > 0 && availableNucs.every(nuc => this.selectedNuclides.has(nuc));
                            
                            return (
                                <button
                                    key={preset.id}
                                    onClick={() => this.applyPreset(preset)}
                                    title={preset.description}
                                    style={{
                                        padding: '4px 8px',
                                        fontSize: '10px',
                                        borderRadius: '4px',
                                        border: `1px solid ${isActive ? '#4caf50' : borderColor}`,
                                        backgroundColor: isActive ? (theme === 'dark' ? '#2e7d32' : '#4caf50') : (theme === 'dark' ? '#3c3c3c' : '#e0e0e0'),
                                        color: isActive ? '#fff' : textColor,
                                        cursor: 'pointer',
                                        fontWeight: isActive ? 'bold' : 'normal'
                                    }}
                                >
                                    {isActive ? '✓ ' : ''}{preset.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Nuclide Selector */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ padding: '15px 15px 10px' }}>
                        <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                            Nuclides ({this.selectedNuclides.size} selected)
                        </label>
                        <input
                            type="text"
                            placeholder="Search nuclides..."
                            value={this.searchFilter}
                            onChange={(e) => { this.searchFilter = e.target.value; this.update(); }}
                            style={{
                                width: '100%',
                                padding: '6px',
                                fontSize: '11px',
                                borderRadius: '4px',
                                border: `1px solid ${borderColor}`,
                                backgroundColor: theme === 'dark' ? '#3c3c3c' : '#fff',
                                color: textColor
                            }}
                        />
                    </div>
                    
                    <div style={{ flex: 1, overflow: 'auto', padding: '0 15px 15px' }}>
                        {this.renderNuclideList(theme)}
                    </div>
                </div>
            </div>
        );
    }

    private renderNuclideList(theme: 'dark' | 'light'): React.ReactNode {
        const textColor = theme === 'dark' ? '#ccc' : '#333';
        
        // Filter nuclides based on search
        const filteredNuclides = this.nuclideData.filter(n => {
            if (!this.searchFilter) return true;
            return n.nuclide.toLowerCase().includes(this.searchFilter.toLowerCase());
        });

        // Sort: selected first, then by name
        const sortedNuclides = [...filteredNuclides].sort((a, b) => {
            const aSelected = this.selectedNuclides.has(a.nuclide);
            const bSelected = this.selectedNuclides.has(b.nuclide);
            if (aSelected && !bSelected) return -1;
            if (!aSelected && bSelected) return 1;
            return a.nuclide.localeCompare(b.nuclide);
        });

        // Limit shown nuclides if not showing all
        const displayNuclides = this.showAllNuclides 
            ? sortedNuclides 
            : sortedNuclides.slice(0, 20);

        return (
            <div>
                {displayNuclides.map((nuclide) => (
                    <label
                        key={nuclide.nuclide}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '4px 0',
                            fontSize: '12px',
                            color: textColor,
                            cursor: 'pointer'
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={this.selectedNuclides.has(nuclide.nuclide)}
                            onChange={(e) => {
                                if (e.target.checked) {
                                    this.selectedNuclides.add(nuclide.nuclide);
                                } else {
                                    this.selectedNuclides.delete(nuclide.nuclide);
                                }
                                this.update();
                            }}
                        />
                        {nuclide.nuclide}
                    </label>
                ))}
                
                {!this.showAllNuclides && sortedNuclides.length > 20 && (
                    <button
                        onClick={() => { this.showAllNuclides = true; this.update(); }}
                        style={{
                            width: '100%',
                            padding: '6px',
                            fontSize: '11px',
                            borderRadius: '4px',
                            border: 'none',
                            backgroundColor: 'transparent',
                            color: '#2196f3',
                            cursor: 'pointer',
                            marginTop: '5px'
                        }}
                    >
                        Show {sortedNuclides.length - 20} more...
                    </button>
                )}
            </div>
        );
    }

    private applyPreset(preset: DepletionNuclidePreset): void {
        // Get available nuclides from this preset that exist in the data
        const availableNucs = preset.nuclides.filter(nuc => 
            this.nuclideData.some(n => n.nuclide === nuc)
        );
        
        if (availableNucs.length === 0) return;
        
        // Check if all available nuclides are already selected
        const allSelected = availableNucs.every(nuc => this.selectedNuclides.has(nuc));
        
        if (allSelected) {
            // Deselect all nuclides from this preset
            for (const nuc of availableNucs) {
                this.selectedNuclides.delete(nuc);
            }
        } else {
            // Select all nuclides from this preset
            for (const nuc of availableNucs) {
                this.selectedNuclides.add(nuc);
            }
        }
        this.update();
    }

    private renderPlot(theme: 'dark' | 'light'): React.ReactNode {
        if (!this.summary || this.selectedNuclides.size === 0) {
            return (
                <div style={{
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#888'
                }}>
                    {this.selectedNuclides.size === 0 ? 'Select nuclides to plot' : 'No data available'}
                </div>
            );
        }

        // Get x-axis data
        let xValues: number[];
        let xLabel: string;
        
        switch (this.xAxisType) {
            case 'time':
                xValues = this.summary.timeDays;
                xLabel = 'Time (days)';
                break;
            case 'burnup':
                xValues = this.summary.burnup || this.summary.timeDays;
                xLabel = this.summary.burnup ? 'Burnup (MWd/kg)' : 'Time (days)';
                break;
            case 'step':
            default:
                xValues = Array.from({ length: this.summary.nSteps }, (_, i) => i);
                xLabel = 'Time Step';
        }

        // Prepare traces
        const traces: any[] = [];
        const colors = [
            '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
            '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
        ];

        let colorIndex = 0;
        for (const nuclideName of this.selectedNuclides) {
            const nuclide = this.nuclideData.find(n => n.nuclide === nuclideName);
            if (!nuclide) continue;

            let yValues: number[];

            switch (this.plotType) {
                case 'mass':
                    yValues = nuclide.massGrams || nuclide.concentrations;
                    break;
                case 'normalized':
                    const initial = nuclide.concentrations[0] || 1;
                    yValues = nuclide.concentrations.map(c => (c / initial) * 100);
                    break;
                case 'concentration':
                default:
                    yValues = nuclide.concentrations;
            }

            traces.push({
                x: xValues,
                y: yValues,
                type: 'scatter',
                mode: 'lines+markers',
                name: nuclideName,
                line: { color: colors[colorIndex % colors.length], width: 2 },
                marker: { size: 6 }
            });

            colorIndex++;
        }

        const layout: any = {
            xaxis: {
                title: { text: xLabel, font: { color: theme === 'dark' ? '#ccc' : '#333' } },
                tickfont: { color: theme === 'dark' ? '#ccc' : '#333' },
                gridcolor: theme === 'dark' ? '#444' : '#ddd',
                type: 'linear'
            },
            yaxis: {
                title: { text: this.getYAxisLabel(), font: { color: theme === 'dark' ? '#ccc' : '#333' } },
                tickfont: { color: theme === 'dark' ? '#ccc' : '#333' },
                gridcolor: theme === 'dark' ? '#444' : '#ddd',
                type: this.scaleType
            },
            paper_bgcolor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
            plot_bgcolor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
            margin: { t: 30, r: 30, b: 50, l: 70 },
            legend: {
                font: { color: theme === 'dark' ? '#ccc' : '#333' },
                bgcolor: theme === 'dark' ? 'rgba(30,30,30,0.8)' : 'rgba(255,255,255,0.8)'
            },
            hovermode: 'closest'
        };

        const config: any = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d']
        };

        return <PlotlyComponent data={traces} layout={layout} config={config} theme={theme} />;
    }

    private getYAxisLabel(): string {
        switch (this.plotType) {
            case 'mass':
                return 'Mass (grams)';
            case 'normalized':
                return 'Relative to Initial (%)';
            case 'concentration':
            default:
                return 'Concentration (atoms/barn-cm)';
        }
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
                <div>No depletion file selected</div>
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

    private getCurrentTheme(): 'dark' | 'light' {
        const themeId = this.themeService.getCurrentTheme().id;
        return themeId.indexOf('light') !== -1 ? 'light' : 'dark';
    }
}
