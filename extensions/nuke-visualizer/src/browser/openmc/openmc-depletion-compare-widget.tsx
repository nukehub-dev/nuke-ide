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
import { PlotlyComponent } from '../plotly/plotly-component';
import { OpenMCService } from './openmc-service';
import URI from '@theia/core/lib/common/uri';

type ComparePlotType = 'concentration' | 'normalized' | 'difference';
type CompareXAxis = 'time' | 'burnup';

interface DepletionCase {
    fileUri: URI;
    fileName: string;
    summary: any | null;
    materials: any[];
    selectedMaterialIndex: number;
    nuclideData: any[];
}

@injectable()
export class OpenMCDepletionCompareWidget extends ReactWidget {
    static readonly ID = 'openmc-depletion-compare-widget';
    static readonly LABEL = 'Depletion Comparison';

    // Two depletion cases to compare
    private caseA: DepletionCase | null = null;
    private caseB: DepletionCase | null = null;
    
    // Plot settings
    private plotType: ComparePlotType = 'concentration';
    private xAxisType: CompareXAxis = 'time';
    private selectedNuclides: Set<string> = new Set();
    
    // UI state
    private isLoading: boolean = false;
    private errorMessage: string | null = null;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCDepletionCompareWidget.ID;
        this.title.label = OpenMCDepletionCompareWidget.LABEL;
        this.title.caption = OpenMCDepletionCompareWidget.LABEL;
        this.title.iconClass = codicon('git-compare');
        this.title.closable = true;
        this.update();
    }

    /**
     * Set the two depletion files to compare.
     */
    async setComparisonFiles(fileUriA: URI, fileNameA: string, fileUriB: URI, fileNameB: string): Promise<void> {
        this.caseA = {
            fileUri: fileUriA,
            fileName: fileNameA,
            summary: null,
            materials: [],
            selectedMaterialIndex: -1,
            nuclideData: []
        };
        this.caseB = {
            fileUri: fileUriB,
            fileName: fileNameB,
            summary: null,
            materials: [],
            selectedMaterialIndex: -1,
            nuclideData: []
        };
        this.title.label = `Compare: ${fileNameA} vs ${fileNameB}`;
        this.selectedNuclides.clear();
        await this.loadData();
    }

    private async loadData(): Promise<void> {
        if (!this.caseA || !this.caseB) return;

        this.isLoading = true;
        this.errorMessage = null;
        this.update();

        try {
            // Load both cases
            await Promise.all([
                this.loadCase(this.caseA),
                this.loadCase(this.caseB)
            ]);

            // Auto-select common important nuclides
            const commonNuclides = this.getCommonNuclides();
            if (this.selectedNuclides.size === 0 && commonNuclides.length > 0) {
                const importantNuclides = ['U235', 'U238', 'Pu239', 'Pu240', 'Pu241', 'Xe135', 'Sm149'];
                for (const nuc of importantNuclides) {
                    if (commonNuclides.includes(nuc)) {
                        this.selectedNuclides.add(nuc);
                    }
                }
                // If still none selected, pick first 5 common
                if (this.selectedNuclides.size === 0) {
                    commonNuclides.slice(0, 5).forEach(n => this.selectedNuclides.add(n));
                }
            }
        } catch (error) {
            this.errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
            this.isLoading = false;
            this.update();
        }
    }

    private async loadCase(depletionCase: DepletionCase): Promise<void> {
        // Load summary
        depletionCase.summary = await this.openmcService.getDepletionSummary(depletionCase.fileUri);
        
        // Load materials
        depletionCase.materials = await this.openmcService.getDepletionMaterials(depletionCase.fileUri);
        
        // Load data for first material
        if (depletionCase.materials.length > 0) {
            depletionCase.selectedMaterialIndex = depletionCase.materials[0].index;
            const response = await this.openmcService.getDepletionData(
                depletionCase.fileUri,
                depletionCase.selectedMaterialIndex
            );
            if (response.materialData) {
                depletionCase.nuclideData = response.materialData.nuclides;
            }
        }
    }

    private getCommonNuclides(): string[] {
        if (!this.caseA?.nuclideData || !this.caseB?.nuclideData) return [];
        
        const nuclidesA = new Set(this.caseA.nuclideData.map(n => n.nuclide));
        const nuclidesB = new Set(this.caseB.nuclideData.map(n => n.nuclide));
        
        return Array.from(nuclidesA).filter(n => nuclidesB.has(n));
    }

    protected render(): React.ReactNode {
        if (this.errorMessage) {
            return this.renderError();
        }

        if (!this.caseA || !this.caseB) {
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
                                Loading comparison data...
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
                    🔄 Depletion Comparison
                </div>
                
                {this.caseA && this.caseB && (
                    <div style={{ fontSize: '12px', color: 'var(--theia-descriptionForeground)', display: 'flex', gap: '15px', alignItems: 'center' }}>
                        <span style={{ color: '#1f77b4', fontWeight: 'bold' }}>Case A: {this.caseA.fileName}</span>
                        <span>vs</span>
                        <span style={{ color: '#ff7f0e', fontWeight: 'bold' }}>Case B: {this.caseB.fileName}</span>
                    </div>
                )}
            </div>
        );
    }

    private renderSidebar(): React.ReactNode {
        const bgColor = 'var(--theia-sideBar-background)';
        const borderColor = 'var(--theia-panel-border)';
        const textColor = 'var(--theia-foreground)';
        const commonNuclides = this.getCommonNuclides();

        return (
            <div style={{
                width: '280px',
                backgroundColor: bgColor,
                borderRight: `1px solid ${borderColor}`,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
            }}>
                {/* Plot Settings */}
                <div style={{ padding: '15px', borderBottom: `1px solid ${borderColor}` }}>
                    <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                        Plot Type
                    </label>
                    <select
                        value={this.plotType}
                        onChange={(e) => { this.plotType = e.target.value as ComparePlotType; this.update(); }}
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
                        <option value="concentration">Concentration</option>
                        <option value="normalized">Normalized (%)</option>
                        <option value="difference">Difference (A - B)</option>
                    </select>

                    <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                        X-Axis
                    </label>
                    <select
                        value={this.xAxisType}
                        onChange={(e) => { this.xAxisType = e.target.value as CompareXAxis; this.update(); }}
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
                        <option value="time">Time (days)</option>
                        <option value="burnup" disabled={!this.caseA?.summary?.burnup || !this.caseB?.summary?.burnup}>
                            Burnup (MWd/kg) {(!this.caseA?.summary?.burnup || !this.caseB?.summary?.burnup) ? '(N/A)' : ''}
                        </option>
                    </select>

                    {/* Debug info for normalized plots */}
                    {this.plotType === 'normalized' && this.selectedNuclides.size > 0 && (
                        <div style={{
                            padding: '10px',
                            backgroundColor: 'var(--theia-infoBackground, #1e3a5f)',
                            borderRadius: '4px',
                            fontSize: '10px',
                            color: 'var(--theia-infoForeground, #90caf9)'
                        }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>ℹ️ Normalized Mode:</div>
                            <div>Each case normalized to its own initial value</div>
                            {Array.from(this.selectedNuclides).slice(0, 3).map(nuc => {
                                const nucA = this.caseA!.nuclideData.find(n => n.nuclide === nuc);
                                const nucB = this.caseB!.nuclideData.find(n => n.nuclide === nuc);
                                const initA = nucA?.concentrations[0] || 0;
                                const initB = nucB?.concentrations[0] || 0;
                                return (
                                    <div key={nuc} style={{ marginTop: '4px' }}>
                                        {nuc}: A₀={initA.toExponential(2)}, B₀={initB.toExponential(2)}
                                        {initA > 0 && initB > 0 && (
                                            <span> ({Math.abs(initA-initB)/((initA+initB)/2)*100 < 1 ? '~same' : Math.abs(initA-initB)/((initA+initB)/2)*100 < 10 ? 'similar' : 'different'})</span>
                                        )}
                                    </div>
                                );
                            })}
                            {this.selectedNuclides.size > 3 && <div>... and {this.selectedNuclides.size - 3} more</div>}
                        </div>
                    )}
                </div>

                {/* Common Nuclides Selector */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{ padding: '15px 15px 10px' }}>
                        <label style={{ fontSize: '12px', color: textColor, fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>
                            Common Nuclides ({this.selectedNuclides.size} / {commonNuclides.length})
                        </label>
                        <div style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '8px' }}>
                            Only nuclides present in both cases are shown
                        </div>
                    </div>
                    
                    <div style={{ flex: 1, overflow: 'auto', padding: '0 15px 15px' }}>
                        {commonNuclides.length === 0 ? (
                            <div style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)', textAlign: 'center', padding: '20px' }}>
                                No common nuclides found
                            </div>
                        ) : (
                            commonNuclides.map((nuclide) => (
                                <label
                                    key={nuclide}
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
                                        checked={this.selectedNuclides.has(nuclide)}
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                this.selectedNuclides.add(nuclide);
                                            } else {
                                                this.selectedNuclides.delete(nuclide);
                                            }
                                            this.update();
                                        }}
                                    />
                                    {nuclide}
                                </label>
                            ))
                        )}
                    </div>
                </div>
            </div>
        );
    }

    private renderPlot(): React.ReactNode {
        if (!this.caseA?.nuclideData || !this.caseB?.nuclideData || this.selectedNuclides.size === 0) {
            return (
                <div style={{
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--theia-descriptionForeground)'
                }}>
                    {this.selectedNuclides.size === 0 ? 'Select nuclides to compare' : 'No data available'}
                </div>
            );
        }

        // Get computed colors for Plotly (CSS variables don't work in Canvas/SVG)
        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#3c3c3c');

        // Get x-axis data for both cases
        let xValuesA: number[], xValuesB: number[];
        let xLabel: string;
        
        switch (this.xAxisType) {
            case 'burnup':
                xValuesA = this.caseA.summary?.burnup || this.caseA.summary?.timeDays || [];
                xValuesB = this.caseB.summary?.burnup || this.caseB.summary?.timeDays || [];
                xLabel = 'Burnup (MWd/kg)';
                break;
            case 'time':
            default:
                xValuesA = this.caseA.summary?.timeDays || [];
                xValuesB = this.caseB.summary?.timeDays || [];
                xLabel = 'Time (days)';
        }

        // Debug logging
        console.log('[DepletionCompare] Rendering plot:', {
            plotType: this.plotType,
            xAxis: this.xAxisType,
            selectedNuclides: Array.from(this.selectedNuclides),
            caseA: { file: this.caseA.fileName, steps: xValuesA.length },
            caseB: { file: this.caseB.fileName, steps: xValuesB.length }
        });

        // Prepare traces
        const traces: any[] = [];
        const colors = [
            '#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd',
            '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'
        ];

        let colorIndex = 0;
        
        for (const nuclideName of this.selectedNuclides) {
            const nucA = this.caseA.nuclideData.find(n => n.nuclide === nuclideName);
            const nucB = this.caseB.nuclideData.find(n => n.nuclide === nuclideName);
            
            if (!nucA || !nucB) continue;

            if (this.plotType === 'difference') {
                // Calculate difference (A - B)
                const minLength = Math.min(nucA.concentrations.length, nucB.concentrations.length);
                const diffValues: number[] = [];
                for (let i = 0; i < minLength; i++) {
                    diffValues.push(nucA.concentrations[i] - nucB.concentrations[i]);
                }
                
                traces.push({
                    x: xValuesA.slice(0, minLength),
                    y: diffValues,
                    type: 'scatter',
                    mode: 'lines+markers',
                    name: `${nuclideName} (A - B)`,
                    line: { color: colors[colorIndex % colors.length], width: 2 },
                    marker: { size: 6 }
                });
            } else {
                // Overlay both cases
                let yValuesA: number[], yValuesB: number[];
                
                switch (this.plotType) {
                    case 'normalized':
                        // Get first non-zero initial value
                        const initA = nucA.concentrations.find((c: number) => c > 0) || 1;
                        const initB = nucB.concentrations.find((c: number) => c > 0) || 1;
                        yValuesA = nucA.concentrations.map((c: number) => (c / initA) * 100);
                        yValuesB = nucB.concentrations.map((c: number) => (c / initB) * 100);
                        // Debug log
                        if (colorIndex === 0) {
                            console.log(`[DepletionCompare] ${nuclideName} normalized:`, {
                                rawConcsA: nucA.concentrations.map((c: number) => c.toExponential(2)),
                                rawConcsB: nucB.concentrations.map((c: number) => c.toExponential(2)),
                                initA: initA.toExponential(3),
                                initB: initB.toExponential(3),
                                finalA: (nucA.concentrations[nucA.concentrations.length-1] / initA * 100).toFixed(1) + '%',
                                finalB: (nucB.concentrations[nucB.concentrations.length-1] / initB * 100).toFixed(1) + '%'
                            });
                        }
                        break;
                    case 'concentration':
                    default:
                        yValuesA = nucA.concentrations;
                        yValuesB = nucB.concentrations;
                }

                // Case A - solid line
                traces.push({
                    x: xValuesA,
                    y: yValuesA,
                    type: 'scatter',
                    mode: 'lines+markers',
                    name: `${nuclideName} (A)`,
                    line: { color: colors[colorIndex % colors.length], width: 2 },
                    marker: { size: 6 }
                });

                // Case B - dashed line
                traces.push({
                    x: xValuesB,
                    y: yValuesB,
                    type: 'scatter',
                    mode: 'lines+markers',
                    name: `${nuclideName} (B)`,
                    line: { color: colors[colorIndex % colors.length], width: 2, dash: 'dash' },
                    marker: { size: 5, symbol: 'diamond' }
                });
            }

            colorIndex++;
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
                type: 'linear'
            },
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { t: 30, r: 30, b: 50, l: 70 },
            legend: {
                font: { color: fgColor },
                bgcolor: bgColor,
                orientation: 'h',
                y: -0.2
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
            case 'normalized':
                return 'Relative to Initial (%)';
            case 'difference':
                return 'Difference (A - B) [atoms/b-cm]';
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
                <div>No comparison files selected</div>
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
