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
import { 
    XSPlotData, 
    XSReaction, 
    COMMON_XS_REACTIONS,
    XS_ENERGY_REGIONS,
    XSEnergyRegion
} from '../../common/visualizer-protocol';
import { PlotlyComponent } from '../plotly/plotly-component';
import { OpenMCService } from './openmc-service';
import { VisualizerPreferences } from '../visualizer-preferences';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommonCommands } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common/command';

/** Mode for XS plotting */
type XSPlotMode = 'nuclides' | 'materials' | 'temp-comparison' | 'library-comparison';

/** Material component definition */
interface MaterialComponent {
    nuclide: string;
    fraction: number;
}

/** Material definition */
interface Material {
    name: string;
    components: MaterialComponent[];
    density: number;
}

@injectable()
export class XSPlotWidget extends ReactWidget {
    static readonly ID = 'xs-plot-widget';
    static readonly LABEL = 'Cross-Section Plot';

    private data: XSPlotData | null = null;
    private titleText: string = 'Cross-Section Plot';
    
    // Plot mode
    private plotMode: XSPlotMode = 'nuclides';
    
    // Nuclide mode
    private selectedNuclides: string[] = ['U235'];
    private nuclidesInput: string = 'U235';
    private availableNuclides: string[] = [];
    private showNuclideDropdown: boolean = false;
    private nuclideSearchFilter: string = '';
    
    // Material mode
    private materials: Material[] = [];
    private currentMaterial: Material = { name: 'New Material', components: [], density: 1.0 };
    
    // Temperature comparison mode
    private tempComparisonNuclide: string = 'U235';
    private tempComparisonReaction: number = 18;  // fission
    private tempComparisonTemps: number[] = [294, 600, 900, 1200];
    
    // Library comparison mode
    private libraryComparisonNuclide: string = 'U235';
    private libraryComparisonReaction: number = 18;  // fission
    private libraryComparisonTemperature: number = 294;
    private libraryComparisonLibraries: { name: string; path: string }[] = [];
    private currentLibrary: { name: string; path: string } = { name: '', path: '' };
    
    // Common settings
    private selectedReactions: XSReaction[] = COMMON_XS_REACTIONS.map(r => ({ ...r }));
    private temperature: number = 294;
    private energyRegion: XSEnergyRegion = 'full';
    private showResonanceRegions: boolean = true;
    private showResonances: boolean = true;
    // Note: Energy range is managed by energyRegion preset
    private isLoading: boolean = false;
    private errorMessage: string | null = null;
    private crossSectionsPath: string = '';
    private showSetupDialog: boolean = false;
    
    // Note: Reaction rates can be extended in future for displaying calculated rates

    @inject(ThemeService)
    protected readonly themeService: ThemeService;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    @inject(VisualizerPreferences)
    protected readonly preferences: VisualizerPreferences;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @postConstruct()
    protected init(): void {
        this.id = XSPlotWidget.ID;
        this.title.label = XSPlotWidget.LABEL;
        this.title.caption = XSPlotWidget.LABEL;
        this.title.iconClass = codicon('graph-line');
        this.title.closable = true;
        this.node.tabIndex = 0;

        // Load cross-section path preference
        this.crossSectionsPath = this.preferences['nukeVisualizer.openmcCrossSectionsPath'];
        
        // Initialize nuclides input from selected nuclides
        this.nuclidesInput = this.selectedNuclides.join(', ');
        
        // Subscribe to preference changes
        this.preferenceService.onPreferenceChanged(e => {
            if (e.preferenceName === 'nukeVisualizer.openmcCrossSectionsPath') {
                // Re-read the preference value
                this.crossSectionsPath = this.preferences['nukeVisualizer.openmcCrossSectionsPath'];
                this.loadAvailableNuclides();
                this.update();
            }
        });

        // Listen for theme changes to re-render the plot
        this.themeService.onDidColorThemeChange(() => this.update());
        
        // Load available nuclides
        this.loadAvailableNuclides();

        this.update();
    }
    
    private async loadAvailableNuclides(): Promise<void> {
        try {
            this.availableNuclides = await this.openmcService.getAvailableNuclides(this.crossSectionsPath);
            if (this.availableNuclides.length === 0) {
                // Fallback to common nuclides
                this.availableNuclides = [
                    'H1', 'H2', 'He3', 'He4', 'B10', 'B11', 'C0', 'N14', 'O16',
                    'Na23', 'Al27', 'Si28', 'K39', 'Fe54', 'Fe56', 'Ni58', 'Ni60',
                    'Zr90', 'Zr91', 'Zr92', 'Nb93', 'Mo95', 'Mo98',
                    'U234', 'U235', 'U238', 'Pu238', 'Pu239', 'Pu240', 'Pu241'
                ];
            }
            this.update();
        } catch (error) {
            console.error('[XSPlotWidget] Failed to load nuclides:', error);
        }
    }

    focus(): void {
        this.node.focus();
    }

    setData(data: XSPlotData, title: string): void {
        console.log('[XSPlotWidget] Setting data:', data);
        this.data = data;
        this.titleText = title;
        this.isLoading = false;
        this.update();
    }

    setSelectedNuclides(nuclides: string[]): void {
        this.selectedNuclides = [...nuclides];
        this.update();
    }

    setSelectedReactions(reactions: XSReaction[]): void {
        this.selectedReactions = reactions.map(r => ({ ...r }));
        this.update();
    }

    protected getCurrentTheme(): 'dark' | 'light' {
        const themeId = this.themeService.getCurrentTheme().id;
        return themeId.indexOf('light') !== -1 ? 'light' : 'dark';
    }

    protected render(): React.ReactNode {
        const theme = this.getCurrentTheme();
        const bgColor = theme === 'dark' ? '#1e1e1e' : '#ffffff';
        const textColor = theme === 'dark' ? '#cccccc' : '#333333';
        const panelBg = theme === 'dark' ? '#252526' : '#f3f3f3';
        const borderColor = theme === 'dark' ? '#3c3c3c' : '#e0e0e0';

        return (
            <div className="xs-plot" style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'row',
                backgroundColor: bgColor,
                color: textColor,
                fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif',
                overflow: 'hidden'
            }}>
                {/* Sidebar with controls */}
                <div style={{
                    width: '320px',
                    minWidth: '320px',
                    maxWidth: '320px',
                    backgroundColor: panelBg,
                    borderRight: `1px solid ${borderColor}`,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'auto'
                }}>
                    {this.renderControls(theme)}
                </div>

                {/* Main plot area */}
                <div style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden'
                }}>
                    <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 20px',
                        borderBottom: `1px solid ${borderColor}`
                    }}>
                        <h3 style={{ margin: 0, color: theme === 'dark' ? '#fff' : '#000' }}>{this.titleText}</h3>
                        <div style={{ fontSize: '12px', color: '#888' }}>
                            {this.data ? `${this.data.curves.length} curves` : 'No data'}
                        </div>
                    </div>
                    <div style={{ flex: 1, position: 'relative', minHeight: '350px', overflow: 'hidden' }}>
                        {this.isLoading ? (
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                height: '100%',
                                color: '#888'
                            }}>
                                <span className={codicon('loading')} style={{ marginRight: '8px' }} />
                                Loading cross-section data...
                            </div>
                        ) : this.errorMessage ? (
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                height: '100%',
                                color: '#ff6b6b',
                                padding: '20px',
                                textAlign: 'center'
                            }}>
                                <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }}>
                                    <span className={codicon('error')} />
                                </div>
                                <p style={{ fontWeight: 'bold', marginBottom: '8px' }}>Error Loading Cross-Sections</p>
                                <p style={{ fontSize: '12px', color: '#cc5252', maxWidth: '400px' }}>
                                    {this.errorMessage}
                                </p>
                                <div style={{ marginTop: '16px', display: 'flex', gap: '10px', flexDirection: 'column', alignItems: 'center' }}>
                                    <button
                                        onClick={() => this.openSettings()}
                                        style={{
                                            padding: '8px 16px',
                                            backgroundColor: '#0e639c',
                                            color: 'white',
                                            border: 'none',
                                            borderRadius: '3px',
                                            cursor: 'pointer',
                                            fontSize: '12px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px'
                                        }}
                                    >
                                        <span className={codicon('settings-gear')} />
                                        Configure Cross-Section Path
                                    </button>
                                    <p style={{ fontSize: '11px', color: '#888' }}>
                                        Or set OPENMC_CROSS_SECTIONS environment variable
                                    </p>
                                </div>
                            </div>
                        ) : this.showSetupDialog ? (
                            this.renderSetupDialog()
                        ) : this.data ? (
                            this.renderPlot(theme)
                        ) : (
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                height: '100%',
                                color: '#888',
                                padding: '20px',
                                textAlign: 'center'
                            }}>
                                <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }}>
                                    <span className={codicon('graph-line')} />
                                </div>
                                <p>No cross-section data loaded</p>
                                <p style={{ fontSize: '12px', marginBottom: '16px' }}>
                                    Select nuclides and reactions from the sidebar,
                                    then click "Plot Cross-Sections"
                                </p>
                                {!this.crossSectionsPath && (
                                    <button
                                        onClick={() => this.openSettings()}
                                        style={{
                                            padding: '8px 16px',
                                            backgroundColor: '#0e639c',
                                            color: 'white',
                                            border: 'none',
                                            borderRadius: '3px',
                                            cursor: 'pointer',
                                            fontSize: '12px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px'
                                        }}
                                    >
                                        <span className={codicon('settings-gear')} />
                                        Setup Cross-Section Library
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    private renderControls(theme: 'dark' | 'light'): React.ReactNode {
        const textColor = theme === 'dark' ? '#cccccc' : '#333333';
        const accentColor = '#0e639c';
        const checkboxBg = theme === 'dark' ? '#3c3c3c' : '#ffffff';
        const panelBg = theme === 'dark' ? '#252526' : '#f3f3f3';

        return (
            <>
                {/* Mode Selection */}
                <div style={{
                    padding: '10px 15px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`,
                    backgroundColor: panelBg
                }}>
                    <h4 style={{ margin: '0 0 8px 0', color: theme === 'dark' ? '#fff' : '#000', fontSize: '12px' }}>
                        <span className={codicon('symbol-misc')} style={{ marginRight: '6px' }} />
                        Plot Mode
                    </h4>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {this.renderModeButton('nuclides', 'Nuclides', theme)}
                        {this.renderModeButton('materials', 'Materials', theme)}
                        {this.renderModeButton('temp-comparison', 'Temp', theme)}
                        {this.renderModeButton('library-comparison', 'Libraries', theme)}
                    </div>
                </div>

                {/* Plot Mode Specific Controls */}
                {this.plotMode === 'nuclides' && this.renderNuclideControls(theme, textColor, checkboxBg)}
                {this.plotMode === 'materials' && this.renderMaterialControls(theme, textColor, checkboxBg)}
                {this.plotMode === 'temp-comparison' && this.renderTempComparisonControls(theme, textColor, checkboxBg)}
                {this.plotMode === 'library-comparison' && this.renderLibraryComparisonControls(theme, textColor, checkboxBg)}

                {/* Reactions Section */}
                <div style={{
                    padding: '15px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`,
                    flex: 1,
                    overflow: 'auto',
                    minHeight: '150px'
                }}>
                    <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                        <span className={codicon('list-flat')} style={{ marginRight: '6px' }} />
                        Reactions
                    </h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {this.selectedReactions.map((reaction, index) => (
                            <label
                                key={reaction.mt}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    padding: '4px 8px',
                                    borderRadius: '3px',
                                    cursor: 'pointer',
                                    backgroundColor: reaction.selected
                                        ? (theme === 'dark' ? 'rgba(14, 99, 156, 0.2)' : 'rgba(14, 99, 156, 0.1)')
                                        : 'transparent',
                                    fontSize: '12px'
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={reaction.selected}
                                    onChange={() => this.handleReactionToggle(index)}
                                    style={{ marginRight: '8px' }}
                                />
                                <span style={{
                                    flex: 1,
                                    color: reaction.selected
                                        ? (theme === 'dark' ? '#4fc1ff' : '#007acc')
                                        : textColor
                                }}>
                                    {reaction.label}
                                </span>
                                <span style={{ fontSize: '10px', color: '#888', marginLeft: '4px' }}>
                                    MT={reaction.mt}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>

                {/* Energy Region Presets */}
                <div style={{
                    padding: '15px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
                }}>
                    <h4 style={{ margin: '0 0 10px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                        <span className={codicon('globe')} style={{ marginRight: '6px' }} />
                        Energy Region
                    </h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        {(Object.keys(XS_ENERGY_REGIONS) as XSEnergyRegion[]).map(region => (
                            <button
                                key={region}
                                onClick={() => this.setEnergyRegion(region)}
                                style={{
                                    padding: '6px 8px',
                                    fontSize: '11px',
                                    backgroundColor: this.energyRegion === region
                                        ? accentColor
                                        : (theme === 'dark' ? '#3c3c3c' : '#e0e0e0'),
                                    color: this.energyRegion === region
                                        ? 'white'
                                        : textColor,
                                    border: 'none',
                                    borderRadius: '3px',
                                    cursor: 'pointer',
                                    textAlign: 'center'
                                }}
                                title={XS_ENERGY_REGIONS[region].description}
                            >
                                {XS_ENERGY_REGIONS[region].label}
                            </button>
                        ))}
                    </div>
                    <div style={{ 
                        fontSize: '10px', 
                        color: '#888', 
                        marginTop: '8px',
                        textAlign: 'center'
                    }}>
                        {XS_ENERGY_REGIONS[this.energyRegion].range[0].toExponential(0)} - {XS_ENERGY_REGIONS[this.energyRegion].range[1].toExponential(0)} eV
                    </div>
                </div>

                {/* Settings */}
                <div style={{
                    padding: '15px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
                }}>
                    <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                        <span className={codicon('settings')} style={{ marginRight: '6px' }} />
                        Settings
                    </h4>
                    {this.plotMode !== 'temp-comparison' && (
                        <div style={{ marginBottom: '10px' }}>
                            <label style={{ display: 'block', fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                                Temperature (K)
                            </label>
                            <input
                                type="number"
                                value={this.temperature}
                                onChange={(e) => this.setState({ temperature: parseFloat(e.target.value) || 294 })}
                                style={{
                                    width: '100%',
                                    padding: '4px 8px',
                                    backgroundColor: checkboxBg,
                                    color: textColor,
                                    border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                    borderRadius: '3px',
                                    fontSize: '12px',
                                    boxSizing: 'border-box'
                                }}
                            />
                        </div>
                    )}
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={this.showResonanceRegions}
                                onChange={() => { this.showResonanceRegions = !this.showResonanceRegions; this.update(); }}
                                style={{ marginRight: '8px' }}
                            />
                            Show Resonance Regions
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={this.showResonances}
                                onChange={() => { this.showResonances = !this.showResonances; this.update(); }}
                                style={{ marginRight: '8px' }}
                            />
                            Show Resonance Markers
                        </label>
                    </div>
                </div>

                <div style={{ padding: '15px' }}>
                    <button
                        onClick={() => this.handlePlot()}
                        disabled={this.isLoading}
                        style={{
                            width: '100%',
                            padding: '8px 16px',
                            backgroundColor: accentColor,
                            color: 'white',
                            border: 'none',
                            borderRadius: '3px',
                            cursor: this.isLoading ? 'wait' : 'pointer',
                            fontSize: '13px',
                            fontWeight: 500,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '6px',
                            opacity: this.isLoading ? 0.7 : 1,
                            boxSizing: 'border-box'
                        }}
                    >
                        <span className={this.isLoading ? codicon('loading') : codicon('play')} />
                        {this.isLoading ? 'Loading...' : 'Plot Cross-Sections'}
                    </button>
                </div>
            </>
        );
    }

    private renderPlot(theme: 'dark' | 'light'): React.ReactNode {
        if (!this.data || !this.data.curves || this.data.curves.length === 0) {
            return null;
        }

        console.log('[XSPlotWidget] Rendering plot. Toggles:', { 
            showResonanceRegions: this.showResonanceRegions, 
            showResonances: this.showResonances 
        });

        const traces: Partial<Plotly.Data>[] = [];
        const shapes: Partial<Plotly.Shape>[] = [];
        const annotations: Partial<Plotly.Annotations>[] = [];

        // Track seen resonance regions to avoid duplicates if multiple reactions for same nuclide
        const seenRegions = new Set<string>();
        const seenResonances = new Set<string>();

        // Track libraries for styling
        const libraries = [...new Set(this.data.curves.map(c => c.library).filter(Boolean))];
        const libraryStyles: Record<string, { dash?: string; width?: number; color?: string }> = {};
        
        // Define line styles for different libraries
        const lineStyles = [
            { width: 2 },
            { dash: 'dash', width: 2 },
            { dash: 'dot', width: 2 },
            { dash: 'dashdot', width: 2 },
            { width: 2.5 },
            { dash: 'longdash', width: 2 },
        ];
        
        libraries.forEach((lib, idx) => {
            libraryStyles[lib!] = lineStyles[idx % lineStyles.length];
        });

        this.data.curves.forEach((curve, curveIdx) => {
            // Determine line style based on library
            const lineStyle = curve.library ? libraryStyles[curve.library] : { width: 1.5 };
            
            // Main XS curve
            traces.push({
                x: curve.energy,
                y: curve.xs,
                type: 'scatter',
                mode: 'lines',
                name: curve.label,
                line: { 
                    width: lineStyle?.width || 1.5,
                    dash: lineStyle?.dash as any
                },
                hovertemplate: `<b>${curve.label}</b><br>Energy: %{x:.4e} eV<br>XS: %{y:.4e} b<extra></extra>`
            });

            // Add resonance regions
            if (this.showResonanceRegions && curve.resonanceRegions) {
                console.log(`[XSPlotWidget] Adding ${curve.resonanceRegions.length} resonance regions for ${curve.nuclide}`);
                curve.resonanceRegions.forEach(region => {
                    const regionKey = `${curve.nuclide}-${region.type}-${region.energyMin}-${region.energyMax}`;
                    if (!seenRegions.has(regionKey)) {
                        seenRegions.add(regionKey);
                        
                        const isResolved = region.type === 'resolved';
                        shapes.push({
                            type: 'rect',
                            xref: 'x',
                            yref: 'paper',
                            x0: region.energyMin,
                            x1: region.energyMax,
                            y0: 0,
                            y1: 1,
                            fillcolor: isResolved ? 'rgba(0, 255, 0, 0.15)' : 'rgba(255, 165, 0, 0.15)',
                            line: { width: 0 },
                            layer: 'below'
                        });

                        // Add invisible hover points for region tooltip
                        const centerX = (region.energyMin + region.energyMax) / 2;
                        const hoverX = [region.energyMin, centerX, region.energyMax];
                        // Find corresponding Y values from curve for each hover point
                        const hoverY: number[] = [];
                        const hoverTexts: string[] = [];
                        
                        hoverX.forEach(x => {
                            // Find closest energy in curve
                            let closestIdx = 0;
                            let minDiff = Math.abs(curve.energy[0] - x);
                            for (let i = 1; i < curve.energy.length; i++) {
                                const diff = Math.abs(curve.energy[i] - x);
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    closestIdx = i;
                                } else if (diff > minDiff) {
                                    break; // Assuming energy is sorted
                                }
                            }
                            hoverY.push(curve.xs[closestIdx]);
                            hoverTexts.push(`<b>${isResolved ? 'Resolved' : 'Unresolved'} Resonance Region</b><br>Nuclide: ${curve.nuclide}<br>Energy: ${region.energyMin.toExponential(3)} - ${region.energyMax.toExponential(3)} eV<br>Type: ${region.type}${isResolved ? '' : ' (URR)'}`);
                        });
                        
                        traces.push({
                            x: hoverX,
                            y: hoverY,
                            type: 'scatter',
                            mode: 'markers',
                            marker: { size: 0, opacity: 0 },
                            text: hoverTexts,
                            hoverinfo: 'text',
                            showlegend: false,
                            hoverlabel: { bgcolor: isResolved ? 'rgba(0, 150, 0, 0.8)' : 'rgba(150, 100, 0, 0.8)' }
                        });

                        // Add label for the region
                        annotations.push({
                            x: centerX,
                            y: 1,
                            xref: 'x',
                            yref: 'paper',
                            text: isResolved ? 'Resolved' : 'Unresolved',
                            showarrow: false,
                            font: { 
                                size: 10, 
                                color: isResolved ? 'rgba(0, 150, 0, 0.5)' : 'rgba(150, 100, 0, 0.5)' 
                            },
                            textangle: '-90',
                            xanchor: 'center',
                            yanchor: 'top'
                        });
                    }
                });
            }

            // Add individual resonance markers (transparent but with hover info)
            if (this.showResonances && curve.resonances && curve.resonances.length > 0) {
                console.log(`[XSPlotWidget] Adding ${curve.resonances.length} resonance markers for ${curve.nuclide}`);
                const resX: number[] = [];
                const resY: number[] = [];
                const resHover: string[] = [];

                curve.resonances.forEach(res => {
                    const resKey = `${curve.nuclide}-${res.energy}`;
                    if (!seenResonances.has(resKey)) {
                        seenResonances.add(resKey);

                        // Find closest energy in curve to get Y value for better hover positioning
                        // Simple binary search would be better but let's just find the closest
                        let closestIdx = 0;
                        let minDiff = Math.abs(curve.energy[0] - res.energy);
                        for (let i = 1; i < curve.energy.length; i++) {
                            const diff = Math.abs(curve.energy[i] - res.energy);
                            if (diff < minDiff) {
                                minDiff = diff;
                                closestIdx = i;
                            } else if (diff > minDiff) {
                                break; // Assuming energy is sorted
                            }
                        }

                        resX.push(res.energy);
                        resY.push(curve.xs[closestIdx]);
                        
                        let hoverText = `<b>${curve.nuclide} Resonance</b><br>`;
                        hoverText += `E₀: ${res.energy.toFixed(3)} eV<br>`;
                        if (res.totalWidth) hoverText += `Γ: ${res.totalWidth.toExponential(3)} eV<br>`;
                        if (res.neutronWidth) hoverText += `Γₙ: ${res.neutronWidth.toExponential(3)} eV<br>`;
                        if (res.gammaWidth) hoverText += `Γᵧ: ${res.gammaWidth.toExponential(3)} eV<br>`;
                        if (res.fissionWidth) hoverText += `Γ_f: ${res.fissionWidth.toExponential(3)} eV<br>`;
                        resHover.push(hoverText);
                    }
                });

                if (resX.length > 0) {
                    traces.push({
                        x: resX,
                        y: resY,
                        type: 'scatter',
                        mode: 'markers',
                        name: `${curve.nuclide} Resonances`,
                        marker: {
                            symbol: 'diamond-open',
                            size: 8,
                            color: 'rgba(255, 0, 0, 0.5)'
                        },
                        text: resHover,
                        hoverinfo: 'text',
                        showlegend: false
                    });
                }
            }
        });

        const layout: Partial<Plotly.Layout> = {
            xaxis: {
                title: { text: 'Energy [eV]' },
                type: 'log',
                showgrid: true,
                gridcolor: theme === 'dark' ? '#333' : '#eee'
            },
            yaxis: {
                title: { text: 'Cross-Section [barns]' },
                type: 'log',
                showgrid: true,
                gridcolor: theme === 'dark' ? '#333' : '#eee'
            },
            hovermode: 'closest',
            showlegend: true,
            legend: {
                x: 1,
                y: 1,
                bgcolor: theme === 'dark' ? 'rgba(30,30,30,0.8)' : 'rgba(255,255,255,0.8)',
                font: { color: theme === 'dark' ? '#ccc' : '#333' }
            },
            shapes: shapes,
            annotations: annotations,
            paper_bgcolor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
            plot_bgcolor: theme === 'dark' ? '#1e1e1e' : '#ffffff',
            font: { color: theme === 'dark' ? '#ccc' : '#333' }
        };

        return (
            <PlotlyComponent
                data={traces}
                layout={layout}
                theme={theme}
            />
        );
    }

    private handleNuclidesChange(value: string): void {
        this.nuclidesInput = value;
        // Parse nuclides allowing commas, spaces, or both as separators
        this.selectedNuclides = value.split(/[,\s]+/).map(n => n.trim()).filter(n => n);
        this.update();
    }

    private handleReactionToggle(index: number): void {
        this.selectedReactions[index].selected = !this.selectedReactions[index].selected;
        this.update();
    }

    private setState(state: { temperature?: number }): void {
        if (state.temperature !== undefined) {
            this.temperature = state.temperature;
        }
        this.update();
    }

    private async handlePlot(): Promise<void> {
        const selectedReactions = this.selectedReactions.filter(r => r.selected);
        
        if (selectedReactions.length === 0) {
            this.errorMessage = 'Please select at least one reaction';
            this.update();
            return;
        }

        this.isLoading = true;
        this.errorMessage = null;
        // Reaction rates would be stored here for display
        this.update();

        try {
            let request: any;
            let title: string;

            if (this.plotMode === 'library-comparison') {
                // Library comparison mode
                if (!this.libraryComparisonNuclide) {
                    this.errorMessage = 'Please select a nuclide for library comparison';
                    this.isLoading = false;
                    this.update();
                    return;
                }

                if (this.libraryComparisonLibraries.length === 0) {
                    this.errorMessage = 'Please add at least one library for comparison';
                    this.isLoading = false;
                    this.update();
                    return;
                }

                request = {
                    nuclides: [this.libraryComparisonNuclide],
                    reactions: [this.libraryComparisonReaction],
                    energyRegion: this.energyRegion,
                    libraryComparison: {
                        libraries: this.libraryComparisonLibraries.map(lib => ({
                            name: lib.name,
                            path: lib.path
                        })),
                        nuclide: this.libraryComparisonNuclide,
                        reaction: this.libraryComparisonReaction,
                        temperature: this.libraryComparisonTemperature
                    }
                };
                title = `Library Comparison: ${this.libraryComparisonNuclide} ${COMMON_XS_REACTIONS.find(r => r.mt === this.libraryComparisonReaction)?.label.split(' ')[0] || 'MT=' + this.libraryComparisonReaction}`;
            } else if (this.plotMode === 'temp-comparison') {
                // Temperature comparison mode
                if (!this.tempComparisonNuclide) {
                    this.errorMessage = 'Please select a nuclide for temperature comparison';
                    this.isLoading = false;
                    this.update();
                    return;
                }

                request = {
                    nuclides: [this.tempComparisonNuclide],
                    reactions: [this.tempComparisonReaction],
                    temperatureComparison: {
                        nuclide: this.tempComparisonNuclide,
                        reaction: this.tempComparisonReaction,
                        temperatures: this.tempComparisonTemps
                    },
                    energyRegion: this.energyRegion
                };
                title = `Temperature Comparison: ${this.tempComparisonNuclide} MT=${this.tempComparisonReaction}`;
            } else if (this.plotMode === 'materials') {
                // Material mixing mode
                if (this.materials.length === 0) {
                    this.errorMessage = 'Please define at least one material';
                    this.isLoading = false;
                    this.update();
                    return;
                }

                request = {
                    nuclides: [],
                    reactions: selectedReactions.map(r => r.mt),
                    temperature: this.temperature,
                    energyRegion: this.energyRegion,
                    materials: this.materials.map(m => ({
                        name: m.name,
                        components: m.components,
                        density: m.density
                    }))
                };
                title = `Material Cross-Sections: ${this.materials.map(m => m.name).join(', ')}`;
            } else {
                // Standard nuclide mode
                if (this.selectedNuclides.length === 0) {
                    this.errorMessage = 'Please enter at least one nuclide';
                    this.isLoading = false;
                    this.update();
                    return;
                }

                request = {
                    nuclides: this.selectedNuclides,
                    reactions: selectedReactions.map(r => r.mt),
                    temperature: this.temperature,
                    energyRegion: this.energyRegion
                };
                title = `Cross-Sections: ${this.selectedNuclides.join(', ')}`;
            }

            const data = await this.openmcService.getXSData(request);
            
            this.isLoading = false;
            
            if (data) {
                if (data.error) {
                    this.errorMessage = data.error;
                    this.data = null;
                } else if (data.curves && data.curves.length > 0) {
                    // Reaction rates from data: data.reactionRates
                    this.setData(data, title);
                    return;
                } else {
                    this.errorMessage = 'No cross-section data returned. The nuclide(s) may not be available in the cross-section library.';
                    this.data = null;
                }
            } else {
                this.errorMessage = 'Failed to load cross-section data. Check that OpenMC is properly installed and OPENMC_CROSS_SECTIONS is set.';
                this.data = null;
            }
            this.update();
        } catch (error) {
            this.isLoading = false;
            this.errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
            this.data = null;
            this.update();
        }
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
        window.dispatchEvent(new Event('resize'));
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    private openSettings(): void {
        // Open the preferences view
        this.commandRegistry.executeCommand(CommonCommands.OPEN_PREFERENCES.id);
        this.messageService.info('Settings opened. Search for "openmcCrossSectionsPath" in the settings search box.');
    }

    private renderSetupDialog(): React.ReactNode {
        const theme = this.getCurrentTheme();
        const textColor = theme === 'dark' ? '#cccccc' : '#333333';
        const bgColor = theme === 'dark' ? '#1e1e1e' : '#ffffff';
        const panelBg = theme === 'dark' ? '#252526' : '#f3f3f3';

        return (
            <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: textColor,
                padding: '40px',
                textAlign: 'center',
                backgroundColor: bgColor
            }}>
                <div style={{ fontSize: '64px', marginBottom: '24px' }}>
                    <span className={codicon('database')} />
                </div>
                <h2 style={{ marginBottom: '16px', color: theme === 'dark' ? '#fff' : '#000' }}>
                    Setup Cross-Section Library
                </h2>
                <p style={{ fontSize: '14px', marginBottom: '24px', maxWidth: '500px' }}>
                    To plot cross-sections, you need to configure the path to your OpenMC cross_sections.xml file.
                    This file contains nuclear data for isotopes and their reaction cross-sections.
                </p>
                
                <div style={{
                    backgroundColor: panelBg,
                    padding: '20px',
                    borderRadius: '6px',
                    marginBottom: '24px',
                    maxWidth: '500px',
                    textAlign: 'left'
                }}>
                    <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                        Where to get cross-section data:
                    </h4>
                    <ul style={{ fontSize: '12px', lineHeight: '1.8', margin: 0, paddingLeft: '20px' }}>
                        <li>Download from <a href="https://openmc.org/" target="_blank" rel="noopener">OpenMC website</a></li>
                        <li>Convert ENDF/B, JEFF, or JENDL data using OpenMC's data conversion scripts</li>
                        <li>Use pre-converted libraries from <a href="https://www.nndc.bnl.gov/" target="_blank" rel="noopener">NNDC</a></li>
                        <li>Set the path to your cross_sections.xml file below</li>
                    </ul>
                </div>

                <div style={{
                    display: 'flex',
                    gap: '12px',
                    flexDirection: 'column',
                    width: '100%',
                    maxWidth: '400px'
                }}>
                    <input
                        type="text"
                        placeholder="/path/to/cross_sections.xml"
                        value={this.crossSectionsPath}
                        onChange={(e) => {
                            this.crossSectionsPath = e.target.value;
                            this.update();
                        }}
                        style={{
                            width: '100%',
                            padding: '10px 12px',
                            fontSize: '13px',
                            backgroundColor: theme === 'dark' ? '#3c3c3c' : '#fff',
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '4px',
                            boxSizing: 'border-box'
                        }}
                    />
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                            onClick={() => this.saveCrossSectionsPath()}
                            disabled={!this.crossSectionsPath}
                            style={{
                                flex: 1,
                                padding: '10px 16px',
                                backgroundColor: this.crossSectionsPath ? '#0e639c' : '#555',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: this.crossSectionsPath ? 'pointer' : 'not-allowed',
                                fontSize: '13px'
                            }}
                        >
                            Save Path
                        </button>
                        <button
                            onClick={() => {
                                this.showSetupDialog = false;
                                this.update();
                            }}
                            style={{
                                flex: 1,
                                padding: '10px 16px',
                                backgroundColor: 'transparent',
                                color: textColor,
                                border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '13px'
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>

                <p style={{ fontSize: '11px', color: '#888', marginTop: '16px' }}>
                    You can also set this later in Preferences → Nuke Visualizer
                </p>
            </div>
        );
    }

    private async saveCrossSectionsPath(): Promise<void> {
        if (!this.crossSectionsPath) {
            return;
        }

        try {
            await this.preferenceService.set('nukeVisualizer.openmcCrossSectionsPath', this.crossSectionsPath);
            this.showSetupDialog = false;
            this.messageService.info(`Cross-section path saved: ${this.crossSectionsPath}`);
            this.update();
        } catch (error) {
            this.messageService.error(`Failed to save path: ${error}`);
        }
    }

    // ===== Mode Selection UI =====

    private renderModeButton(mode: XSPlotMode, label: string, theme: 'dark' | 'light'): React.ReactNode {
        const isActive = this.plotMode === mode;
        return (
            <button
                onClick={() => this.setPlotMode(mode)}
                style={{
                    flex: 1,
                    padding: '6px 4px',
                    fontSize: '11px',
                    backgroundColor: isActive
                        ? '#0e639c'
                        : (theme === 'dark' ? '#3c3c3c' : '#e0e0e0'),
                    color: isActive ? 'white' : (theme === 'dark' ? '#ccc' : '#333'),
                    border: 'none',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    fontWeight: isActive ? '500' : 'normal'
                }}
            >
                {label}
            </button>
        );
    }

    private setPlotMode(mode: XSPlotMode): void {
        this.plotMode = mode;
        this.update();
    }

    // ===== Energy Region =====

    private setEnergyRegion(region: XSEnergyRegion): void {
        this.energyRegion = region;
        // Custom energy range can be derived from XS_ENERGY_REGIONS[region].range
        this.update();
    }

    // ===== Nuclide Controls =====

    private renderNuclideControls(theme: 'dark' | 'light', textColor: string, checkboxBg: string): React.ReactNode {
        const searchLower = this.nuclideSearchFilter.toLowerCase();
        const filteredNuclides = this.availableNuclides.filter(n => 
            n.toLowerCase().includes(searchLower)
        ).slice(0, 100);

        return (
            <div style={{
                padding: '15px',
                borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
            }}>
                <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                    <span className={codicon('symbol-misc')} style={{ marginRight: '6px' }} />
                    Nuclides
                </h4>
                
                <div style={{ position: 'relative', marginBottom: '8px' }}>
                    <input
                        type="text"
                        value={this.nuclideSearchFilter}
                        onChange={(e) => this.setNuclideSearchFilter(e.target.value)}
                        placeholder="Search nuclides..."
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '12px',
                            boxSizing: 'border-box'
                        }}
                    />
                    {this.showNuclideDropdown && this.nuclideSearchFilter && (
                        <div style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            maxHeight: '150px',
                            overflow: 'auto',
                            backgroundColor: theme === 'dark' ? '#2d2d30' : '#ffffff',
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            zIndex: 100,
                            marginTop: '2px'
                        }}>
                            {filteredNuclides.map(nuclide => (
                                <div
                                    key={nuclide}
                                    onClick={() => this.addNuclide(nuclide)}
                                    style={{
                                        padding: '6px 8px',
                                        cursor: 'pointer',
                                        fontSize: '12px',
                                        color: textColor
                                    }}
                                >
                                    {nuclide}
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                        Selected ({this.selectedNuclides.length}):
                    </div>
                    <div style={{ 
                        display: 'flex', 
                        flexWrap: 'wrap', 
                        gap: '4px',
                        maxHeight: '80px',
                        overflow: 'auto'
                    }}>
                        {this.selectedNuclides.map(nuclide => (
                            <span
                                key={nuclide}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    padding: '2px 6px',
                                    backgroundColor: theme === 'dark' ? '#094771' : '#e5f3ff',
                                    color: theme === 'dark' ? '#fff' : '#0066bf',
                                    borderRadius: '3px',
                                    fontSize: '11px',
                                    gap: '4px'
                                }}
                            >
                                {nuclide}
                                <span
                                    onClick={() => this.removeNuclide(nuclide)}
                                    style={{ cursor: 'pointer', fontWeight: 'bold' }}
                                >
                                    ×
                                </span>
                            </span>
                        ))}
                    </div>
                </div>

                <textarea
                    value={this.nuclidesInput}
                    onChange={(e) => this.handleNuclidesChange(e.target.value)}
                    placeholder="Or enter manually (e.g., U235, U238, H1)"
                    style={{
                        width: '100%',
                        height: '50px',
                        backgroundColor: checkboxBg,
                        color: textColor,
                        border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                        borderRadius: '3px',
                        padding: '6px',
                        fontSize: '12px',
                        fontFamily: 'monospace',
                        boxSizing: 'border-box',
                        resize: 'none'
                    }}
                />
            </div>
        );
    }

    private setNuclideSearchFilter(filter: string): void {
        this.nuclideSearchFilter = filter;
        this.showNuclideDropdown = true;
        this.update();
    }

    private addNuclide(nuclide: string): void {
        if (!this.selectedNuclides.includes(nuclide)) {
            this.selectedNuclides.push(nuclide);
            this.nuclidesInput = this.selectedNuclides.join(', ');
        }
        this.nuclideSearchFilter = '';
        this.showNuclideDropdown = false;
        this.update();
    }

    private removeNuclide(nuclide: string): void {
        this.selectedNuclides = this.selectedNuclides.filter(n => n !== nuclide);
        this.nuclidesInput = this.selectedNuclides.join(', ');
        this.update();
    }

    // ===== Material Controls =====

    private renderMaterialControls(theme: 'dark' | 'light', textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '15px',
                borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
            }}>
                <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                    <span className={codicon('symbol-struct')} style={{ marginRight: '6px' }} />
                    Materials
                </h4>

                {this.materials.length > 0 && (
                    <div style={{ marginBottom: '12px' }}>
                        {this.materials.map((mat, idx) => (
                            <div
                                key={idx}
                                style={{
                                    padding: '8px',
                                    backgroundColor: theme === 'dark' ? '#2d2d30' : '#f5f5f5',
                                    borderRadius: '3px',
                                    marginBottom: '6px',
                                    fontSize: '12px'
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <strong>{mat.name}</strong>
                                    <span onClick={() => this.removeMaterial(idx)} style={{ cursor: 'pointer', color: '#ff6b6b' }}>
                                        ×
                                    </span>
                                </div>
                                <div style={{ fontSize: '10px', color: '#888' }}>
                                    {mat.components.map(c => `${c.nuclide} (${(c.fraction * 100).toFixed(1)}%)`).join(', ')}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <div style={{
                    padding: '10px',
                    backgroundColor: theme === 'dark' ? '#1e1e1e' : '#fafafa',
                    borderRadius: '3px',
                    border: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
                }}>
                    <input
                        type="text"
                        placeholder="Material name"
                        value={this.currentMaterial.name}
                        onChange={(e) => this.updateCurrentMaterial({ name: e.target.value })}
                        style={{
                            width: '100%',
                            padding: '4px 8px',
                            marginBottom: '8px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '12px',
                            boxSizing: 'border-box'
                        }}
                    />

                    <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>Components:</div>
                        {this.currentMaterial.components.map((comp, idx) => (
                            <div key={idx} style={{ display: 'flex', gap: '4px', marginBottom: '4px' }}>
                                <select
                                    value={comp.nuclide}
                                    onChange={(e) => this.updateComponent(idx, { nuclide: e.target.value })}
                                    style={{
                                        flex: 1,
                                        padding: '4px',
                                        fontSize: '11px',
                                        backgroundColor: checkboxBg,
                                        color: textColor,
                                        border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                        borderRadius: '3px',
                                        boxSizing: 'border-box'
                                    }}
                                >
                                    <option value="">Select nuclide...</option>
                                    {this.availableNuclides.map(n => (
                                        <option key={n} value={n}>{n}</option>
                                    ))}
                                </select>
                                <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    max="1"
                                    placeholder="Fraction"
                                    value={comp.fraction}
                                    onChange={(e) => this.updateComponent(idx, { fraction: parseFloat(e.target.value) || 0 })}
                                    style={{
                                        width: '70px',
                                        padding: '4px',
                                        fontSize: '11px',
                                        backgroundColor: checkboxBg,
                                        color: textColor,
                                        border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                        borderRadius: '3px',
                                        boxSizing: 'border-box'
                                    }}
                                />
                                <button
                                    onClick={() => this.removeComponent(idx)}
                                    style={{
                                        padding: '4px 8px',
                                        backgroundColor: '#ff6b6b',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '3px',
                                        cursor: 'pointer',
                                        fontSize: '11px'
                                    }}
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                        <button
                            onClick={() => this.addComponent()}
                            style={{
                                padding: '4px 8px',
                                backgroundColor: theme === 'dark' ? '#3c3c3c' : '#e0e0e0',
                                color: textColor,
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer',
                                fontSize: '11px'
                            }}
                        >
                            + Add Component
                        </button>
                    </div>

                    <button
                        onClick={() => this.addMaterial()}
                        disabled={this.currentMaterial.components.length === 0 || !this.currentMaterial.name}
                        style={{
                            width: '100%',
                            padding: '6px',
                            backgroundColor: this.currentMaterial.components.length > 0 && this.currentMaterial.name
                                ? '#0e639c'
                                : '#666',
                            color: 'white',
                            border: 'none',
                            borderRadius: '3px',
                            cursor: this.currentMaterial.components.length > 0 && this.currentMaterial.name
                                ? 'pointer'
                                : 'not-allowed',
                            fontSize: '12px'
                        }}
                    >
                        Add Material
                    </button>
                </div>
            </div>
        );
    }

    private updateCurrentMaterial(updates: Partial<Material>): void {
        this.currentMaterial = { ...this.currentMaterial, ...updates };
        this.update();
    }

    private addComponent(): void {
        this.currentMaterial.components.push({ nuclide: '', fraction: 1.0 });
        this.update();
    }

    private updateComponent(idx: number, updates: Partial<MaterialComponent>): void {
        this.currentMaterial.components[idx] = { 
            ...this.currentMaterial.components[idx], 
            ...updates 
        };
        this.update();
    }

    private removeComponent(idx: number): void {
        this.currentMaterial.components.splice(idx, 1);
        this.update();
    }

    private addMaterial(): void {
        const total = this.currentMaterial.components.reduce((sum, c) => sum + c.fraction, 0);
        if (total > 0) {
            this.currentMaterial.components.forEach(c => c.fraction /= total);
        }
        this.materials.push({ ...this.currentMaterial });
        this.currentMaterial = { name: 'New Material', components: [], density: 1.0 };
        this.update();
    }

    private removeMaterial(idx: number): void {
        this.materials.splice(idx, 1);
        this.update();
    }

    // ===== Temperature Comparison Controls =====

    private renderTempComparisonControls(theme: 'dark' | 'light', textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '15px',
                borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
            }}>
                <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                    <span className={codicon('flame')} style={{ marginRight: '6px' }} />
                    Temperature Comparison
                </h4>
                <div style={{ fontSize: '11px', color: '#888', marginBottom: '12px' }}>
                    Visualize Doppler broadening effects.
                </div>

                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                        Nuclide
                    </label>
                    <select
                        value={this.tempComparisonNuclide}
                        onChange={(e) => this.setTempComparisonNuclide(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '12px',
                            boxSizing: 'border-box'
                        }}
                    >
                        {this.availableNuclides.map(n => (
                            <option key={n} value={n}>{n}</option>
                        ))}
                    </select>
                </div>

                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                        Reaction
                    </label>
                    <select
                        value={this.tempComparisonReaction}
                        onChange={(e) => this.setTempComparisonReaction(parseInt(e.target.value))}
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '12px',
                            boxSizing: 'border-box'
                        }}
                    >
                        {COMMON_XS_REACTIONS.map(r => (
                            <option key={r.mt} value={r.mt}>{r.label}</option>
                        ))}
                    </select>
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                        Temperatures (K)
                    </label>
                    <input
                        type="text"
                        value={this.tempComparisonTemps.join(', ')}
                        onChange={(e) => this.setTempComparisonTemps(e.target.value)}
                        placeholder="e.g., 294, 600, 900, 1200"
                        style={{
                            width: '100%',
                            padding: '6px 8px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '12px',
                            boxSizing: 'border-box'
                        }}
                    />
                </div>

                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {[[294, 600, 900], [300, 600, 1200], [293, 500, 1000, 1500]].map((temps, idx) => (
                        <button
                            key={idx}
                            onClick={() => { this.tempComparisonTemps = temps; this.update(); }}
                            style={{
                                padding: '4px 8px',
                                fontSize: '10px',
                                backgroundColor: theme === 'dark' ? '#3c3c3c' : '#e0e0e0',
                                color: textColor,
                                border: 'none',
                                borderRadius: '3px',
                                cursor: 'pointer'
                            }}
                        >
                            {temps.join('/')}
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    private setTempComparisonNuclide(nuclide: string): void {
        this.tempComparisonNuclide = nuclide;
        this.update();
    }

    private setTempComparisonReaction(reaction: number): void {
        this.tempComparisonReaction = reaction;
        this.update();
    }

    private setTempComparisonTemps(value: string): void {
        this.tempComparisonTemps = value.split(/[,\s]+/)
            .map(t => parseFloat(t.trim()))
            .filter(t => !isNaN(t) && t > 0);
        this.update();
    }

    // ===== Library Comparison Controls =====

    private renderLibraryComparisonControls(theme: 'dark' | 'light', textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '10px',
                borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`,
                boxSizing: 'border-box',
                width: '100%'
            }}>
                <h4 style={{ margin: '0 0 6px 0', color: theme === 'dark' ? '#fff' : '#000', fontSize: '12px' }}>
                    <span className={codicon('book')} style={{ marginRight: '6px' }} />
                    Library Comparison
                </h4>
                <div style={{ fontSize: '10px', color: '#888', marginBottom: '6px' }}>
                    Compare nuclide data across different libraries.
                </div>

                <div style={{ marginBottom: '6px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#888', marginBottom: '2px' }}>
                        Nuclide
                    </label>
                    <select
                        value={this.libraryComparisonNuclide}
                        onChange={(e) => this.setLibraryComparisonNuclide(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '4px 6px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    >
                        {this.availableNuclides.map(n => (
                            <option key={n} value={n}>{n}</option>
                        ))}
                    </select>
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#888', marginBottom: '2px' }}>
                        Reaction
                    </label>
                    <select
                        value={this.libraryComparisonReaction}
                        onChange={(e) => this.setLibraryComparisonReaction(parseInt(e.target.value))}
                        style={{
                            width: '100%',
                            padding: '4px 6px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    >
                        {COMMON_XS_REACTIONS.map(r => (
                            <option key={r.mt} value={r.mt}>{r.label}</option>
                        ))}
                    </select>
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#888', marginBottom: '2px' }}>
                        Temperature (K)
                    </label>
                    <input
                        type="number"
                        value={this.libraryComparisonTemperature}
                        onChange={(e) => this.setLibraryComparisonTemperature(parseFloat(e.target.value) || 294)}
                        style={{
                            width: '100%',
                            padding: '4px 6px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    />
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: '#888', marginBottom: '2px' }}>
                        Libraries ({this.libraryComparisonLibraries.length}):
                    </label>
                    
                    {this.libraryComparisonLibraries.length > 0 && (
                        <div style={{ 
                            marginBottom: '6px',
                            maxHeight: '100px',
                            overflow: 'auto'
                        }}>
                            {this.libraryComparisonLibraries.map((lib, idx) => (
                                <div
                                    key={idx}
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '4px 6px',
                                        backgroundColor: theme === 'dark' ? '#2d2d30' : '#f5f5f5',
                                        borderRadius: '3px',
                                        marginBottom: '3px',
                                        fontSize: '10px'
                                    }}
                                >
                                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        <strong>{lib.name}</strong>
                                    </div>
                                    <span 
                                        onClick={() => this.removeLibrary(idx)} 
                                        style={{ cursor: 'pointer', color: '#ff6b6b', marginLeft: '6px', flexShrink: 0 }}
                                    >
                                        ×
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    <div style={{
                        padding: '8px',
                        backgroundColor: theme === 'dark' ? '#1e1e1e' : '#fafafa',
                        borderRadius: '3px',
                        border: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`,
                        boxSizing: 'border-box'
                    }}>
                        <input
                            type="text"
                            placeholder="Library name (e.g., ENDF/B-VIII.0)"
                            value={this.currentLibrary.name}
                            onChange={(e) => this.updateCurrentLibrary({ name: e.target.value })}
                            style={{
                                width: '100%',
                                padding: '3px 6px',
                                marginBottom: '4px',
                                backgroundColor: checkboxBg,
                                color: textColor,
                                border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                borderRadius: '3px',
                                fontSize: '11px',
                                boxSizing: 'border-box'
                            }}
                        />
                        <input
                            type="text"
                            placeholder="Path to cross_sections.xml"
                            value={this.currentLibrary.path}
                            onChange={(e) => this.updateCurrentLibrary({ path: e.target.value })}
                            style={{
                                width: '100%',
                                padding: '3px 6px',
                                marginBottom: '4px',
                                backgroundColor: checkboxBg,
                                color: textColor,
                                border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                borderRadius: '3px',
                                fontSize: '10px',
                                boxSizing: 'border-box'
                            }}
                        />
                        <button
                            onClick={() => this.addLibrary()}
                            disabled={!this.currentLibrary.name || !this.currentLibrary.path}
                            style={{
                                width: '100%',
                                padding: '4px',
                                backgroundColor: this.currentLibrary.name && this.currentLibrary.path
                                    ? '#0e639c'
                                    : '#666',
                                color: 'white',
                                border: 'none',
                                borderRadius: '3px',
                                cursor: this.currentLibrary.name && this.currentLibrary.path
                                    ? 'pointer'
                                    : 'not-allowed',
                                fontSize: '10px'
                            }}
                        >
                            + Add
                        </button>
                    </div>
                </div>

                <div style={{ fontSize: '9px', color: '#666', fontStyle: 'italic' }}>
                    Tip: Add libraries with cross_sections.xml paths.
                </div>
            </div>
        );
    }

    private setLibraryComparisonNuclide(nuclide: string): void {
        this.libraryComparisonNuclide = nuclide;
        this.update();
    }

    private setLibraryComparisonReaction(reaction: number): void {
        this.libraryComparisonReaction = reaction;
        this.update();
    }

    private setLibraryComparisonTemperature(temp: number): void {
        this.libraryComparisonTemperature = temp;
        this.update();
    }

    private updateCurrentLibrary(updates: Partial<{ name: string; path: string }>): void {
        this.currentLibrary = { ...this.currentLibrary, ...updates };
        this.update();
    }

    private addLibrary(): void {
        if (this.currentLibrary.name && this.currentLibrary.path) {
            this.libraryComparisonLibraries.push({ ...this.currentLibrary });
            this.currentLibrary = { name: '', path: '' };
            this.update();
        }
    }

    private removeLibrary(idx: number): void {
        this.libraryComparisonLibraries.splice(idx, 1);
        this.update();
    }
}
