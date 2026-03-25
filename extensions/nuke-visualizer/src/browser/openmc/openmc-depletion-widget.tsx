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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import 'nuke-essentials/lib/theme/browser/components/tooltip.css';
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
    private activityData: any = null;
    private isLoading: boolean = false;
    private errorMessage: string | null = null;
    
    // Plot settings
    private plotType: DepletionPlotType = 'concentration';
    private scaleType: DepletionScaleType = 'log';
    private xAxisType: DepletionXAxis = 'burnup';
    private selectedNuclides: Set<string> = new Set();
    private showActivityNuclides: boolean = false;  // Toggle for showing individual activity curves
    
    // UI state
    private showAllNuclides: boolean = false;
    private searchFilter: string = '';

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
                this.activityData = response.materialData.activity || null;
                
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

        return (
            <div style={{ 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column',
                backgroundColor: 'var(--theia-editor-background)'
            }}>
                {/* Header */}
                {this.renderHeader()}
                
                {/* Main Content */}
                <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                    {/* Sidebar */}
                    {this.renderSidebar()}
                    
                    {/* Plot Area */}
                    <div style={{ flex: 1, padding: '10px', overflow: 'auto' }}>
                        {this.isLoading ? (
                            <div style={{
                                height: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'var(--theia-descriptionForeground)'
                            }}>
                                Loading depletion data...
                            </div>
                        ) : (
                            this.renderPlot()
                        )}
                    </div>
                </div>
            </div>
        );
    }

    private renderHeader(): React.ReactNode {
        const bgColor = 'var(--theia-sideBar-background)';
        const textColor = 'var(--theia-foreground)';
        
        return (
            <div style={{
                padding: '10px 20px',
                backgroundColor: bgColor,
                borderBottom: '1px solid var(--theia-panel-border)',
                display: 'flex',
                alignItems: 'center',
                gap: '20px'
            }}>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: textColor }}>
                    🔥 Depletion: {this.fileName}
                </div>
                
                {this.summary && (
                    <div style={{ fontSize: '12px', color: 'var(--theia-descriptionForeground)', display: 'flex', gap: '15px' }}>
                        <span>{this.summary.nMaterials} materials</span>
                        <span>{this.summary.nSteps} time steps</span>
                        <span>{this.summary.nNuclides} nuclides</span>
                    </div>
                )}
            </div>
        );
    }

    private renderSidebar(): React.ReactNode {
        const bgColor = 'var(--theia-sideBar-background)';
        const borderColor = 'var(--theia-panel-border)';
        const textColor = 'var(--theia-foreground)';

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
                            backgroundColor: 'var(--theia-input-background)',
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
                            backgroundColor: 'var(--theia-input-background)',
                            color: textColor,
                            marginBottom: '10px'
                        }}
                    >
                        <option value="concentration">Concentration (atoms/b-cm)</option>
                        <option value="mass">Mass (grams)</option>
                        <option value="normalized">Normalized (% of initial)</option>
                        <option value="stacked">Stacked Composition (%)</option>
                        <option value="activity" disabled={!this.activityData}>Activity (Ci)</option>
                        <option value="decay_heat" disabled={!this.activityData}>Decay Heat (Watts)</option>
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
                            backgroundColor: 'var(--theia-input-background)',
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
                        <div style={{ fontSize: '10px', color: 'var(--theia-warningForeground)', marginBottom: '10px' }}>
                            ⚠️ No burnup data - showing Time instead
                        </div>
                    )}

                    <label style={{ 
                        fontSize: '12px', 
                        color: this.plotType === 'stacked' ? 'var(--theia-descriptionForeground)' : textColor, 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '8px', 
                        cursor: this.plotType === 'stacked' ? 'not-allowed' : 'pointer' 
                    }}>
                        <input
                            type="checkbox"
                            checked={this.scaleType === 'log'}
                            disabled={this.plotType === 'stacked'}
                            onChange={(e) => { this.scaleType = e.target.checked ? 'log' : 'linear'; this.update(); }}
                        />
                        Log Scale {this.plotType === 'stacked' && '(N/A for Stacked)'}
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
                                <Tooltip key={preset.id} content={preset.description} position="top">
                                    <button
                                        onClick={() => this.applyPreset(preset)}
                                        style={{
                                            padding: '4px 8px',
                                            fontSize: '10px',
                                            borderRadius: '4px',
                                            border: `1px solid ${isActive ? 'var(--theia-successBackground, #4caf50)' : borderColor}`,
                                            backgroundColor: isActive ? 'var(--theia-successBackground, #4caf50)' : 'var(--theia-button-secondaryBackground)',
                                            color: isActive ? 'var(--theia-button-foreground)' : textColor,
                                            cursor: 'pointer',
                                            fontWeight: isActive ? 'bold' : 'normal'
                                        }}
                                    >
                                        {isActive ? '✓ ' : ''}{preset.label}
                                    </button>
                                </Tooltip>
                            );
                        })}
                    </div>
                </div>

                {/* Nuclide Selector - Hidden for Activity/Decay Heat plots */}
                {(this.plotType !== 'activity' && this.plotType !== 'decay_heat') ? (
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
                                    backgroundColor: 'var(--theia-input-background)',
                                    color: textColor
                                }}
                            />
                        </div>
                        
                        <div style={{ flex: 1, overflow: 'auto', padding: '0 15px 15px' }}>
                            {this.renderNuclideList()}
                        </div>
                    </div>
                ) : (
                    /* Activity/Decay Heat Info Panel */
                    <div style={{ flex: 1, padding: '15px', overflow: 'auto' }}>
                        <div style={{
                            padding: '12px',
                            backgroundColor: 'var(--theia-warningBackground)',
                            borderRadius: '6px',
                            border: '1px solid var(--theia-warningForeground)',
                            marginBottom: '15px'
                        }}>
                            <div style={{ fontSize: '12px', color: 'var(--theia-warningForeground)', fontWeight: 'bold', marginBottom: '6px' }}>
                                ℹ️ Total Radioactivity
                            </div>
                            <div style={{ fontSize: '11px', color: textColor, lineHeight: '1.4' }}>
                                {this.plotType === 'activity' 
                                    ? 'Activity shows the total radioactivity from ALL nuclides in the material. Individual nuclide selection does not affect the total.' 
                                    : 'Decay Heat shows the total heat generation from radioactive decay of ALL nuclides. Individual nuclide selection does not affect the total.'}
                            </div>
                        </div>
                        
                        <label style={{ 
                            fontSize: '12px', 
                            color: textColor, 
                            display: 'flex', 
                            alignItems: 'center', 
                            gap: '8px', 
                            cursor: 'pointer',
                            padding: '10px',
                            backgroundColor: 'var(--theia-input-background)',
                            borderRadius: '4px'
                        }}>
                            <input
                                type="checkbox"
                                checked={this.showActivityNuclides}
                                onChange={(e) => { this.showActivityNuclides = e.target.checked; this.update(); }}
                            />
                            <span>
                                Show Individual Nuclide Contributions<br/>
                                <span style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)' }}>
                                    Display breakdown curves for top contributors
                                </span>
                            </span>
                        </label>
                        
                        {this.showActivityNuclides && this.activityData && (
                            <div style={{ marginTop: '15px' }}>
                                <div style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '8px' }}>
                                    Top contributors by final {this.plotType === 'activity' ? 'activity' : 'decay heat'}:
                                </div>
                                {this.renderActivityNuclideList()}
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    private renderNuclideList(): React.ReactNode {
        const textColor = 'var(--theia-foreground)';
        
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
                            color: 'var(--theia-textLink-foreground)',
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

    private renderActivityNuclideList(): React.ReactNode {
        const textColor = 'var(--theia-foreground)';
        
        if (!this.activityData || !this.activityData.nuclides) {
            return <div style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)' }}>No activity data available</div>;
        }
        
        // Sort nuclides by final activity/decay heat
        const sortedNuclides = [...this.activityData.nuclides].sort((a: any, b: any) => {
            const aVal = this.plotType === 'activity' 
                ? (a.activityCi?.[a.activityCi.length - 1] || 0)
                : (a.decayHeat?.[a.decayHeat.length - 1] || 0);
            const bVal = this.plotType === 'activity'
                ? (b.activityCi?.[b.activityCi.length - 1] || 0)
                : (b.decayHeat?.[b.decayHeat.length - 1] || 0);
            return bVal - aVal;
        });
        
        // Show top 15 contributors
        const topNuclides = sortedNuclides.slice(0, 15);
        
        return (
            <div>
                {topNuclides.map((nuc: any, idx: number) => {
                    const value = this.plotType === 'activity'
                        ? (nuc.activityCi?.[nuc.activityCi.length - 1] || 0)
                        : (nuc.decayHeat?.[nuc.decayHeat.length - 1] || 0);
                    const unit = this.plotType === 'activity' ? 'Ci' : 'W';
                    
                    return (
                        <div
                            key={nuc.nuclide}
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '4px 8px',
                                fontSize: '11px',
                                color: textColor,
                                backgroundColor: idx % 2 === 0 ? 'var(--theia-input-background)' : 'transparent',
                                borderRadius: '3px'
                            }}
                        >
                            <span>{idx + 1}. {nuc.nuclide}</span>
                            <span style={{ color: 'var(--theia-descriptionForeground)' }}>
                                {value < 0.01 ? value.toExponential(2) : value.toFixed(2)} {unit}
                            </span>
                        </div>
                    );
                })}
                {sortedNuclides.length > 15 && (
                    <div style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)', textAlign: 'center', marginTop: '8px' }}>
                        ... and {sortedNuclides.length - 15} more nuclides
                    </div>
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

    private renderPlot(): React.ReactNode {
        if (!this.summary || this.selectedNuclides.size === 0) {
            return (
                <div style={{
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--theia-descriptionForeground)'
                }}>
                    {this.selectedNuclides.size === 0 ? 'Select nuclides to plot' : 'No data available'}
                </div>
            );
        }

        // Get computed colors for Plotly (CSS variables don't work in Canvas/SVG)
        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#3c3c3c');

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
        
        // Handle activity/decay heat plots differently
        if ((this.plotType === 'activity' || this.plotType === 'decay_heat') && this.activityData) {
            // Plot total activity/decay heat as a thick line
            const totalValues = this.plotType === 'activity' 
                ? this.activityData.totalActivityCi 
                : this.activityData.totalDecayHeat;
            
            traces.push({
                x: xValues,
                y: totalValues,
                type: 'scatter',
                mode: 'lines+markers',
                name: this.plotType === 'activity' ? 'Total Activity' : 'Total Decay Heat',
                line: { color: '#d62728', width: 3 },
                marker: { size: 8 }
            });
            
            // Optionally show individual nuclide contributions
            if (this.showActivityNuclides && this.activityData.nuclides) {
                for (const nucActivity of this.activityData.nuclides) {
                    const values = this.plotType === 'activity' 
                        ? nucActivity.activityCi 
                        : nucActivity.decayHeat;
                    
                    traces.push({
                        x: xValues,
                        y: values,
                        type: 'scatter',
                        mode: 'lines',
                        name: nucActivity.nuclide,
                        line: { color: colors[colorIndex % colors.length], width: 1 },
                        opacity: 0.7
                    });
                    colorIndex++;
                }
            }
        } else if (this.plotType === 'stacked') {
            // Stacked area chart showing composition evolution
            // Calculate percentage contribution of each nuclide to total at each timestep
            const selectedNuclideData: { name: string; values: number[]; percentages: number[] }[] = [];
            let totalPerStep: number[] = new Array(this.summary.nSteps).fill(0);
            
            // First pass: collect data and calculate totals
            for (const nuclideName of this.selectedNuclides) {
                const nuclide = this.nuclideData.find(n => n.nuclide === nuclideName);
                if (!nuclide) continue;
                
                const values = nuclide.concentrations;
                selectedNuclideData.push({
                    name: nuclideName,
                    values: values,
                    percentages: []  // Will calculate after getting total
                });
                
                // Add to total per step
                for (let i = 0; i < this.summary.nSteps; i++) {
                    totalPerStep[i] += values[i];
                }
            }
            
            // Second pass: calculate percentages
            for (const nucData of selectedNuclideData) {
                nucData.percentages = nucData.values.map((v, i) => {
                    const total = totalPerStep[i];
                    return total > 0 ? (v / total) * 100 : 0;
                });
            }
            
            // Sort by final percentage (largest on bottom)
            selectedNuclideData.sort((a, b) => b.percentages[b.percentages.length - 1] - a.percentages[a.percentages.length - 1]);
            
            // Create stacked traces
            // Use a larger color palette for stacked charts
            const stackedColors = [
                '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
                '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf',
                '#aec7e8', '#ffbb78', '#98df8a', '#ff9896', '#c5b0d5',
                '#c49c94', '#f7b6d2', '#c7c7c7', '#dbdb8d', '#9edae5',
                '#393b79', '#637939', '#8c6d31', '#843c39', '#7b4173'
            ];
            
            selectedNuclideData.forEach((nucData, index) => {
                traces.push({
                    x: xValues,
                    y: nucData.percentages,
                    type: 'scatter',
                    mode: 'lines',
                    name: nucData.name,
                    fill: index === 0 ? 'tozeroy' : 'tonexty',
                    fillcolor: stackedColors[index % stackedColors.length],
                    line: { color: stackedColors[index % stackedColors.length], width: 0.5 },
                    stackgroup: 'one',
                    hovertemplate: `<b>${nucData.name}</b><br>Time: %{x:.1f}<br>Fraction: %{y:.2f}%<extra></extra>`
                });
            });
            
        } else {
            // Standard nuclide concentration plots
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
        }

        const layout: any = {
            xaxis: {
                title: { text: xLabel, font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                type: 'linear'
            },
            yaxis: {
                title: { text: this.getYAxisLabel(), font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                type: this.plotType === 'stacked' ? 'linear' : this.scaleType,
                range: this.plotType === 'stacked' ? [0, 100] : undefined
            },
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { t: 30, r: 30, b: 50, l: 70 },
            legend: {
                font: { color: fgColor },
                bgcolor: bgColor
            },
            hovermode: 'closest'
        };

        const config: any = {
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['lasso2d', 'select2d']
        };

        return <PlotlyComponent data={traces} layout={layout} config={config} />;
    }

    private getYAxisLabel(): string {
        switch (this.plotType) {
            case 'mass':
                return 'Mass (grams)';
            case 'normalized':
                return 'Relative to Initial (%)';
            case 'stacked':
                return 'Composition (%)';
            case 'activity':
                return 'Activity (Ci)';
            case 'decay_heat':
                return 'Decay Heat (Watts)';
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
                color: 'var(--theia-descriptionForeground)',
                padding: '20px'
            }}>
                <div>No depletion file selected</div>
            </div>
        );
    }

    private renderError(): React.ReactNode {
        return (
            <div style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--theia-errorForeground)',
                padding: '20px',
                textAlign: 'center'
            }}>
                <div style={{ fontSize: '18px', marginBottom: '10px' }}>Error</div>
                <div>{this.errorMessage}</div>
            </div>
        );
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
