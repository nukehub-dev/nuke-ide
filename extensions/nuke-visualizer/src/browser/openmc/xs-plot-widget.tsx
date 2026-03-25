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
    XSGroupStructure,
    XSGroupStructureInfo,
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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import 'nuke-essentials/lib/theme/browser/components/tooltip.css';

/** Mode for XS plotting */
type XSPlotMode = 'nuclides' | 'materials' | 'temp-comparison' | 'library-comparison' | 'thermal-scattering' | 'chain-decay';

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
    
    // Group structures
    private availableGroupStructures: XSGroupStructureInfo[] = [];
    private groupStructuresMetadata: { openmc_available: boolean; sources: string[] } = { openmc_available: true, sources: [] };
    
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
    
    // Thermal scattering (S(alpha,beta)) mode
    // Materials are dynamically fetched from cross_sections.xml
    private thermalMaterial: string = 'c_Graphite';
    private thermalTemperatures: number[] = [294, 600, 800, 1000];
    private availableThermalMaterials: string[] = [];
    
    // Chain decay/buildup mode
    private chainDecayParent: string = 'U235';
    private chainDecayTime: number = 0; // seconds
    private chainDecayFlux: number = 1e14; // n/cm²/s
    private chainDecayMaxDepth: number = 3;
    private chainDecayIncludeDaughters: boolean = true;
    private chainDecayTrackDaughters: string[] = [];
    
    // Common settings
    private selectedReactions: XSReaction[] = COMMON_XS_REACTIONS.map(r => ({ ...r }));
    private temperature: number = 294;
    private energyRegion: XSEnergyRegion = 'full';
    private showResonanceRegions: boolean = true;
    private showResonances: boolean = true;
    private showUncertainty: boolean = false;
    private showIntegrals: boolean = true;
    private showDerivative: boolean = false;
    private groupStructure: string = 'continuous';
    private integralsPanelHeight: number = 180; // Default height in pixels
    private isDraggingIntegrals: boolean = false;
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
        this.loadAvailableThermalMaterials();
        this.loadGroupStructures();

        this.update();
    }

    private async loadGroupStructures(): Promise<void> {
        try {
            const response = await this.openmcService.getGroupStructures();
            this.availableGroupStructures = response.structures;
            this.groupStructuresMetadata = response.metadata;
            
            // If current group structure is not in the list (and not continuous), reset to continuous
            if (this.groupStructure !== 'continuous' && 
                !this.availableGroupStructures.some(gs => gs.name === this.groupStructure)) {
                this.groupStructure = 'continuous';
            }
            
            this.update();
        } catch (e) {
            console.error('[XSPlotWidget] Failed to load group structures:', e);
        }
    }

    private async loadAvailableNuclides(): Promise<void> {        try {
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

    private async loadAvailableThermalMaterials(): Promise<void> {
        try {
            this.availableThermalMaterials = await this.openmcService.getAvailableThermalMaterials(this.crossSectionsPath);
            if (this.availableThermalMaterials.length === 0) {
                // Fallback to common thermal materials
                this.availableThermalMaterials = [
                    'c_Graphite',
                    'c_H_in_H2O',
                    'c_D_in_D2O',
                    'c_Be',
                    'c_Be_in_BeO',
                ];
            } else {
                // Set default selection to first available if current not in list
                if (!this.availableThermalMaterials.includes(this.thermalMaterial)) {
                    this.thermalMaterial = this.availableThermalMaterials[0];
                }
            }
            this.update();
        } catch (error) {
            console.error('[XSPlotWidget] Failed to load thermal materials:', error);
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
        
        // Display warnings for unavailable reactions
        if (data.warnings && data.warnings.length > 0) {
            console.log(`[XSPlotWidget] ${data.warnings.length} warnings:`, data.warnings);
            // Show first warning as notification
            const firstWarning = data.warnings[0];
            const moreCount = data.warnings.length - 1;
            if (moreCount > 0) {
                this.messageService.warn(`${firstWarning} (+${moreCount} more unavailable)`, 
                    'View All').then(action => {
                    if (action === 'View All') {
                        // Log all warnings to console for detailed view
                        console.log('All unavailable reactions:', data.warnings);
                        this.messageService.info(`Check browser console for full list of ${data.warnings?.length} unavailable reactions`);
                    }
                });
            } else {
                this.messageService.warn(firstWarning);
            }
        }
        
        // Display notification for Chain Decay mode
        if (this.plotMode === 'chain-decay') {
            const hasChainData = data.curves.some(c => c.chainDecay);
            if (hasChainData) {
                const cd = data.curves.find(c => c.chainDecay)?.chainDecay;
                if (cd) {
                    const daughterCount = cd.daughterNuclides?.length || 0;
                    const timeStr = cd.decayTime === 0 ? 'fresh' : 
                        cd.decayTime < 3600 ? `${cd.decayTime}s` :
                        cd.decayTime < 86400 ? `${(cd.decayTime/3600).toFixed(1)}h` :
                        cd.decayTime < 31536000 ? `${(cd.decayTime/86400).toFixed(1)}d` :
                        `${(cd.decayTime/31536000).toFixed(1)}y`;
                    this.messageService.info(
                        `Chain Decay: ${cd.parentNuclide} at ${timeStr} with ${daughterCount} daughter(s) included`
                    );
                }
            } else {
                this.messageService.warn(`Chain decay data not available. Check that decay chain data exists for ${this.chainDecayParent}.`);
            }
        }
        
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

    protected render(): React.ReactNode {
        return (
            <div className="xs-plot" style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'row',
                backgroundColor: 'var(--theia-editor-background)',
                color: 'var(--theia-foreground)',
                fontFamily: 'var(--theia-ui-font-family)',
                overflow: 'hidden'
            }}>
                {/* Sidebar with controls */}
                <div style={{
                    width: '320px',
                    minWidth: '320px',
                    maxWidth: '320px',
                    backgroundColor: 'var(--theia-sideBar-background)',
                    borderRight: '1px solid var(--theia-panel-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'auto'
                }}>
                    {this.renderControls()}
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
                        borderBottom: '1px solid var(--theia-panel-border)'
                    }}>
                        <h3 style={{ margin: 0, color: 'var(--theia-foreground)' }}>{this.titleText}</h3>
                        <div style={{ fontSize: '12px', color: 'var(--theia-descriptionForeground)' }}>
                            {this.data ? `${this.data.curves.length} curves` : 'No data'}
                        </div>
                    </div>
                    <div style={{ flex: 1, position: 'relative', minHeight: '350px', overflow: 'hidden' }}>
                        {this.isLoading ? (
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                height: '100%',
                                animation: 'xs-fadeIn 0.3s ease-out'
                            }}>
                                <style>{`
                                    @keyframes xs-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                                    @keyframes xs-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                                    @keyframes xs-fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
                                `}</style>
                                {/* Animated dual-ring spinner */}
                                <div style={{ 
                                    width: '56px', 
                                    height: '56px', 
                                    position: 'relative',
                                    marginBottom: '20px'
                                }}>
                                    <div style={{
                                        position: 'absolute',
                                        inset: '0',
                                        borderRadius: '50%',
                                        border: '3px solid transparent',
                                        borderTopColor: 'var(--theia-focusBorder, #007fd4)',
                                        borderRightColor: 'var(--theia-focusBorder, #007fd4)',
                                        animation: 'xs-spin 1s linear infinite'
                                    }}></div>
                                    <div style={{
                                        position: 'absolute',
                                        inset: '6px',
                                        borderRadius: '50%',
                                        border: '3px solid transparent',
                                        borderBottomColor: 'var(--theia-charts-blue, #3794ff)',
                                        borderLeftColor: 'var(--theia-charts-blue, #3794ff)',
                                        animation: 'xs-spin 1.5s linear infinite reverse'
                                    }}></div>
                                </div>
                                <div style={{ 
                                    fontSize: '15px', 
                                    fontWeight: 500,
                                    color: 'var(--theia-foreground, #cccccc)',
                                    marginBottom: '8px'
                                }}>
                                    Loading cross-section data...
                                </div>
                                <div style={{
                                    fontSize: '12px',
                                    color: 'var(--theia-descriptionForeground, #888)',
                                    animation: 'xs-pulse 2s ease-in-out infinite'
                                }}>
                                    Please wait
                                </div>
                            </div>
                        ) : this.errorMessage ? (
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                height: '100%',
                                color: 'var(--theia-errorForeground)',
                                padding: '20px',
                                textAlign: 'center'
                            }}>
                                <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }}>
                                    <span className={codicon('error')} />
                                </div>
                                <p style={{ fontWeight: 'bold', marginBottom: '8px' }}>Error Loading Cross-Sections</p>
                                <p style={{ fontSize: '12px', color: 'var(--theia-errorForeground)', maxWidth: '400px' }}>
                                    {this.errorMessage}
                                </p>
                                <div style={{ marginTop: '16px', display: 'flex', gap: '10px', flexDirection: 'column', alignItems: 'center' }}>
                                    <button
                                        onClick={() => this.openSettings()}
                                        style={{
                                            padding: '8px 16px',
                                            backgroundColor: 'var(--theia-button-background)',
                                            color: 'var(--theia-button-foreground)',
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
                                    <p style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)' }}>
                                        Or set OPENMC_CROSS_SECTIONS environment variable
                                    </p>
                                </div>
                            </div>
                        ) : this.showSetupDialog ? (
                            this.renderSetupDialog()
                        ) : this.data ? (
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                height: '100%',
                                overflow: 'hidden'
                            }}>
                                <div style={{ 
                                    flex: 1, 
                                    minHeight: this.showIntegrals ? '150px' : '100%',
                                    overflow: 'hidden' 
                                }}>
                                    {this.renderPlot()}
                                </div>
                                {this.showIntegrals && (
                                    <>
                                        {this.renderResizeHandle()}
                                        {this.renderIntegralsPanel()}
                                    </>
                                )}
                            </div>
                        ) : (
                            <div style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'center',
                                height: '100%',
                                color: 'var(--theia-descriptionForeground)',
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
                                            backgroundColor: 'var(--theia-button-background)',
                                            color: 'var(--theia-button-foreground)',
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

    private renderControls(): React.ReactNode {
        const textColor = 'var(--theia-foreground)';
        const accentColor = 'var(--theia-button-background)';
        const checkboxBg = 'var(--theia-input-background)';
        const panelBg = 'var(--theia-sideBar-background)';

        return (
            <>
                {/* Mode Selection */}
                <div style={{
                    padding: '10px 15px',
                    borderBottom: '1px solid var(--theia-panel-border)',
                    backgroundColor: panelBg
                }}>
                    <h4 style={{ margin: '0 0 8px 0', color: 'var(--theia-foreground)', fontSize: '12px' }}>
                        <span className={codicon('symbol-misc')} style={{ marginRight: '6px' }} />
                        Plot Mode
                    </h4>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        {this.renderModeButton('nuclides', 'Nuclides')}
                        {this.renderModeButton('materials', 'Materials')}
                        {this.renderModeButton('temp-comparison', 'Temp')}
                        {this.renderModeButton('library-comparison', 'Libraries')}
                        {this.renderModeButton('thermal-scattering', 'S(α,β)')}
                        {this.renderModeButton('chain-decay', 'Chain')}
                    </div>
                </div>

                {/* Plot Mode Specific Controls */}
                {this.plotMode === 'nuclides' && this.renderNuclideControls(textColor, checkboxBg)}
                {this.plotMode === 'materials' && this.renderMaterialControls(textColor, checkboxBg)}
                {this.plotMode === 'temp-comparison' && this.renderTempComparisonControls(textColor, checkboxBg)}
                {this.plotMode === 'library-comparison' && this.renderLibraryComparisonControls(textColor, checkboxBg)}
                {this.plotMode === 'thermal-scattering' && this.renderThermalScatteringControls(textColor, checkboxBg)}
                {this.plotMode === 'chain-decay' && this.renderChainDecayControls(textColor, checkboxBg)}

                {/* Reactions Section */}
                <div style={{
                    padding: '15px',
                    borderBottom: '1px solid var(--theia-panel-border)',
                    flex: 1,
                    overflow: 'auto',
                    minHeight: '150px'
                }}>
                    <h4 style={{ margin: '0 0 12px 0', color: 'var(--theia-foreground)' }}>
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
                                        ? 'var(--theia-button-background)'
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
                                        ? 'var(--theia-button-foreground)'
                                        : 'var(--theia-foreground)'
                                }}>
                                    {reaction.label}
                                </span>
                                <span style={{ 
                                    fontSize: '10px', 
                                    color: reaction.selected
                                        ? 'var(--theia-button-foreground)'
                                        : 'var(--theia-descriptionForeground)',
                                    marginLeft: '4px',
                                    opacity: reaction.selected ? 0.9 : 1
                                }}>
                                    MT={reaction.mt}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>

                {/* Energy Region Presets */}
                <div style={{
                    padding: '15px',
                    borderBottom: '1px solid var(--theia-panel-border)'
                }}>
                    <h4 style={{ margin: '0 0 10px 0', color: 'var(--theia-foreground)' }}>
                        <span className={codicon('globe')} style={{ marginRight: '6px' }} />
                        Energy Region
                    </h4>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                        {(Object.keys(XS_ENERGY_REGIONS) as XSEnergyRegion[]).map(region => (
                            <Tooltip key={region} content={XS_ENERGY_REGIONS[region].description} position="top">
                                <button
                                    onClick={() => this.setEnergyRegion(region)}
                                    style={{
                                        padding: '6px 8px',
                                        fontSize: '11px',
                                        backgroundColor: this.energyRegion === region
                                            ? accentColor
                                            : 'var(--theia-button-secondaryBackground)',
                                        color: this.energyRegion === region
                                            ? 'var(--theia-button-foreground)'
                                            : textColor,
                                        border: 'none',
                                        borderRadius: '3px',
                                        cursor: 'pointer',
                                        textAlign: 'center'
                                    }}
                                >
                                    {XS_ENERGY_REGIONS[region].label}
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                    <div style={{ 
                        fontSize: '10px', 
                        color: 'var(--theia-descriptionForeground)', 
                        marginTop: '8px',
                        textAlign: 'center'
                    }}>
                        {XS_ENERGY_REGIONS[this.energyRegion].range[0].toExponential(0)} - {XS_ENERGY_REGIONS[this.energyRegion].range[1].toExponential(0)} eV
                    </div>
                </div>

                {/* Settings */}
                <div style={{
                    padding: '15px',
                    borderBottom: '1px solid var(--theia-panel-border)'
                }}>
                    <h4 style={{ margin: '0 0 12px 0', color: 'var(--theia-foreground)' }}>
                        <span className={codicon('settings')} style={{ marginRight: '6px' }} />
                        Settings
                    </h4>
                    {this.plotMode !== 'temp-comparison' && (
                        <div style={{ marginBottom: '10px' }}>
                            <label style={{ display: 'block', fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '4px' }}>
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
                                    border: '1px solid var(--theia-input-border)',
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
                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={this.showUncertainty}
                                onChange={() => { this.showUncertainty = !this.showUncertainty; this.update(); }}
                                style={{ marginRight: '8px' }}
                            />
                            Show Uncertainty Bands
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={this.showIntegrals}
                                onChange={() => { this.showIntegrals = !this.showIntegrals; this.update(); }}
                                style={{ marginRight: '8px' }}
                            />
                            Calculate Integral Quantities
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={this.showDerivative}
                                onChange={() => { this.showDerivative = !this.showDerivative; this.update(); }}
                                style={{ marginRight: '8px' }}
                            />
                            Show Derivative/Slopes (dXS/dE)
                        </label>
                    </div>
                    
                    {/* Group Structure Selector */}
                    <div style={{ marginTop: '12px' }}>
                        <label style={{ display: 'block', fontSize: '12px', color: 'var(--theia-descriptionForeground)', marginBottom: '4px' }}>
                            Group Structure (Multigroup)
                        </label>
                        <select
                            value={this.groupStructure}
                            onChange={(e) => { this.groupStructure = e.target.value as XSGroupStructure; this.update(); }}
                            style={{
                                width: '100%',
                                padding: '4px 8px',
                                backgroundColor: checkboxBg,
                                color: textColor,
                                border: '1px solid var(--theia-input-border)',
                                borderRadius: '3px',
                                fontSize: '12px',
                                boxSizing: 'border-box'
                            }}
                        >
                            <option value="continuous">Continuous Energy</option>
                            {this.availableGroupStructures.length > 0 ? (
                                this.availableGroupStructures.map(gs => (
                                    <option key={gs.name} value={gs.name}>
                                        {gs.name} ({gs.groups} groups)
                                    </option>
                                ))
                            ) : (
                                <option value="" disabled>No structures available</option>
                            )}
                        </select>
                        {this.groupStructure !== 'continuous' && (
                            <div style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginTop: '4px', fontStyle: 'italic' }}>
                                {`Collapse to ${this.groupStructure} structure using flux-weighting`}
                            </div>
                        )}
                        {!this.groupStructuresMetadata.openmc_available && this.availableGroupStructures.length === 0 && (
                            <div style={{ fontSize: '10px', color: 'var(--theia-warningForeground)', marginTop: '4px' }}>
                                <i className={codicon('warning')} style={{ marginRight: '4px', verticalAlign: 'middle' }}></i>
                                OpenMC built-ins not available. Add a group_structures.yaml to your project.
                            </div>
                        )}
                        {this.groupStructuresMetadata.sources.length > 0 && (
                            <div style={{ fontSize: '9px', color: 'var(--theia-descriptionForeground)', marginTop: '2px' }}>
                                Sources: {this.groupStructuresMetadata.sources.join(', ')}
                            </div>
                        )}
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
                            color: 'var(--theia-button-foreground)',
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

    /**
     * Helper to get computed color from CSS variable
     */
    private getCssColor(variable: string, fallback: string): string {
        if (typeof window === 'undefined') return fallback;
        const computed = getComputedStyle(document.body).getPropertyValue(variable.replace('var(', '').replace(')', '')).trim();
        return computed || fallback;
    }

    private renderPlot(): React.ReactNode {
        if (!this.data || !this.data.curves || this.data.curves.length === 0) {
            return null;
        }

        console.log('[XSPlotWidget] Rendering plot. Toggles:', { 
            showResonanceRegions: this.showResonanceRegions, 
            showResonances: this.showResonances 
        });

        // Get computed colors for Plotly (CSS variables don't work in Canvas/SVG)
        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#3c3c3c');

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
            
            // Check if we should show multigroup data
            const showMultigroup = this.groupStructure !== 'continuous' && curve.multigroup && 
                                   curve.multigroup.groupXS && curve.multigroup.groupXS.length > 0;
            
            if (showMultigroup) {
                // Render multigroup data as histogram bars
                const mg = curve.multigroup!;
                const boundaries = mg.groupBoundaries || [];
                const groupXS = mg.groupXS || [];
                
                // Create bar chart for multigroup XS
                // Use group midpoints for x positions, group widths for bar widths
                const barX: number[] = [];
                const barY: number[] = [];
                const barWidths: number[] = [];
                
                for (let i = 0; i < groupXS.length; i++) {
                    if (boundaries.length >= i + 2) {
                        const eHigh = boundaries[i];
                        const eLow = boundaries[i + 1];
                        const eMid = Math.sqrt(eHigh * eLow);  // Log-average
                        const width = eHigh - eLow;
                        
                        barX.push(eMid);
                        barY.push(groupXS[i]);
                        barWidths.push(width);
                    }
                }
                
                if (barX.length > 0) {
                    // Add multigroup histogram bars
                    traces.push({
                        x: barX,
                        y: barY,
                        type: 'bar',
                        name: `${curve.label} (${this.groupStructure})`,
                        marker: {
                            color: 'rgba(100, 150, 200, 0.6)',
                            line: {
                                color: 'rgba(50, 100, 150, 0.8)',
                                width: 1
                            }
                        },
                        width: barWidths.map(w => w * 0.95),  // 95% width for visual separation
                        hovertemplate: `<b>${curve.label}</b><br>Group: %{x:.3e} eV<br>XS: %{y:.4e} b<extra></extra>`,
                        showlegend: true
                    } as Partial<Plotly.Data>);
                }
                
                // Also show continuous curve as thin background line for reference
                traces.push({
                    x: curve.energy,
                    y: curve.xs,
                    type: 'scatter',
                    mode: 'lines',
                    name: `${curve.label} (continuous)`,
                    line: { 
                        width: 1,
                        dash: 'dot',
                        color: 'rgba(150, 150, 150, 0.5)'
                    },
                    hovertemplate: `<b>${curve.label} (continuous)</b><br>Energy: %{x:.4e} eV<br>XS: %{y:.4e} b<extra></extra>`,
                    showlegend: true
                });
            } else {
                // Main XS curve (continuous)
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
            }

            // Add uncertainty/error bands if available and enabled
            if (this.showUncertainty && curve.uncertainty) {
                const hasBounds = curve.uncertainty.lower && curve.uncertainty.upper && 
                                  curve.uncertainty.lower.length > 0 && curve.uncertainty.upper.length > 0;
                const hasStdDev = curve.uncertainty.stdDev && curve.uncertainty.stdDev.length > 0;
                
                if (hasBounds) {
                    // Create filled area between lower and upper bounds
                    // Plotly needs: upper bound line + lower bound line (reversed) for fill
                    const xCombined = [...curve.energy, ...curve.energy.slice().reverse()];
                    const yCombined = [...(curve.uncertainty.upper as number[]), ...(curve.uncertainty.lower as number[]).slice().reverse()];
                    
                    traces.push({
                        x: xCombined,
                        y: yCombined,
                        type: 'scatter',
                        mode: 'lines',
                        fill: 'toself',
                        fillcolor: 'rgba(255, 100, 100, 0.2)',
                        line: { width: 0 },
                        name: `${curve.label} ±σ`,
                        showlegend: false,
                        hoverinfo: 'skip'
                    });
                } else if (hasStdDev) {
                    // Use error bars
                    traces.push({
                        x: curve.energy,
                        y: curve.xs,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${curve.label} ±σ`,
                        line: { width: 0 },
                        showlegend: false,
                        error_y: {
                            type: 'data',
                            array: curve.uncertainty.stdDev as number[],
                            visible: true,
                            color: 'rgba(255, 100, 100, 0.5)',
                            thickness: 1
                        },
                        hoverinfo: 'skip'
                    });
                }
            }

            // Add derivative/slope trace if available and enabled
            if (this.showDerivative && curve.derivative) {
                const d = curve.derivative;
                if (d.dXdE && d.dXdE.length > 0) {
                    // Use the log-log derivative for better visualization across energy ranges
                    const yValues = d.logLogDerivative && d.logLogDerivative.length > 0 
                        ? d.logLogDerivative 
                        : d.dXdE;
                    
                    // Find the corresponding energy values
                    const energyValues = d.energy && d.energy.length > 0 
                        ? d.energy 
                        : curve.energy;
                    
                    traces.push({
                        x: energyValues,
                        y: yValues,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${curve.label} (slope)`,
                        line: { 
                            width: 1,
                            dash: 'dot',
                            color: 'rgba(255, 140, 0, 0.7)'  // Orange for derivative
                        },
                        yaxis: 'y2',  // Use secondary y-axis
                        hovertemplate: `<b>${curve.label} (Slope)</b><br>Energy: %{x:.4e} eV<br>dXS/dE: %{y:.4e}<extra></extra>`,
                        showlegend: true
                    });
                }
            }

            // Add chain decay cumulative cross-section if available
            if (curve.chainDecay) {
                const cd = curve.chainDecay;
                if (cd.cumulativeXS && cd.cumulativeXS.length > 0) {
                    traces.push({
                        x: curve.energy,
                        y: cd.cumulativeXS,
                        type: 'scatter',
                        mode: 'lines',
                        name: `${curve.label} (cumulative)`,
                        line: { 
                            width: 2,
                            dash: 'dash',
                            color: 'rgba(0, 150, 0, 0.8)'  // Green for cumulative
                        },
                        hovertemplate: `<b>${curve.label} (Cumulative)</b><br>Energy: %{x:.4e} eV<br>XS: %{y:.4e} b<br>Daughters: ${cd.daughterNuclides.join(', ') || 'None'}<extra></extra>`,
                        showlegend: true
                    });
                    
                    // Also add individual daughter contributions as thin lines
                    if (cd.contributions) {
                        Object.entries(cd.contributions).forEach(([nuc, xs], idx) => {
                            if (nuc !== cd.parentNuclide && Array.isArray(xs)) {
                                const colors = ['rgba(100, 100, 255, 0.5)', 'rgba(255, 100, 100, 0.5)', 'rgba(100, 255, 100, 0.5)'];
                                traces.push({
                                    x: curve.energy,
                                    y: xs,
                                    type: 'scatter',
                                    mode: 'lines',
                                    name: `${nuc} contribution`,
                                    line: { 
                                        width: 1,
                                        color: colors[idx % colors.length]
                                    },
                                    hovertemplate: `<b>${nuc}</b><br>Energy: %{x:.4e} eV<br>XS: %{y:.4e} b<extra></extra>`,
                                    showlegend: true
                                });
                            }
                        });
                    }
                    
                    // Add derivative for chain decay cumulative XS if available and enabled
                    if (this.showDerivative && cd.derivative) {
                        const d = cd.derivative;
                        if (d.dXdE && d.dXdE.length > 0) {
                            const yValues = d.logLogDerivative && d.logLogDerivative.length > 0 
                                ? d.logLogDerivative 
                                : d.dXdE;
                            const energyValues = d.energy && d.energy.length > 0 
                                ? d.energy 
                                : curve.energy;
                            
                            traces.push({
                                x: energyValues,
                                y: yValues,
                                type: 'scatter',
                                mode: 'lines',
                                name: `${curve.label} (Chain Slope)`,
                                line: { 
                                    width: 1,
                                    dash: 'dot',
                                    color: 'rgba(0, 150, 0, 0.7)'  // Green for chain decay derivative
                                },
                                yaxis: 'y2',
                                hovertemplate: `<b>${curve.label} (Chain Slope)</b><br>Energy: %{x:.4e} eV<br>dXS/dE: %{y:.4e}<extra></extra>`,
                                showlegend: true
                            });
                        }
                    }
                }
            }

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
                            symbol: 'diamond',
                            size: 10,
                            color: 'rgba(255, 0, 0, 0.6)',
                            line: {
                                color: 'rgba(255, 0, 0, 0.8)',
                                width: 1
                            }
                        },
                        text: resHover,
                        hoverinfo: 'text',
                        showlegend: false
                    });
                }
            }
        });

        // Check if any curve has derivative data (including chain decay) and derivative view is enabled
        const hasDerivativeData = this.showDerivative && this.data.curves.some(c => 
            c.derivative || (c.chainDecay?.derivative)
        );
        
        const layout: Partial<Plotly.Layout> = {
            xaxis: {
                title: { text: 'Energy [eV]', font: { color: fgColor } },
                type: 'log',
                showgrid: true,
                gridcolor: gridColor,
                tickfont: { color: fgColor }
            },
            yaxis: {
                title: { text: 'Cross-Section [barns]', font: { color: fgColor } },
                type: 'log',
                showgrid: true,
                gridcolor: gridColor,
                tickfont: { color: fgColor },
                // Make room for secondary y-axis if needed
                domain: hasDerivativeData ? [0, 0.85] : [0, 1]
            },
            // Add secondary y-axis for derivative when enabled
            ...(hasDerivativeData && {
                yaxis2: {
                    title: { text: 'dXS/dE (slope)', font: { color: 'rgba(255, 140, 0, 0.9)' } },
                    type: 'linear',
                    overlaying: 'y',
                    side: 'right',
                    showgrid: false,
                    position: 1,
                    tickfont: { color: 'rgba(255, 140, 0, 0.9)' }
                }
            }),
            hovermode: 'closest',
            showlegend: true,
            legend: {
                x: 1,
                y: 1,
                bgcolor: bgColor,
                bordercolor: gridColor,
                borderwidth: 1,
                font: { color: fgColor }
            },
            shapes: shapes,
            annotations: annotations,
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            font: { color: fgColor }
        };

        return (
            <PlotlyComponent
                data={traces}
                layout={layout}
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
                    },
                    includeUncertainty: this.showUncertainty,
                    includeIntegrals: this.showIntegrals,
                    includeDerivative: this.showDerivative,
                    groupStructure: this.groupStructure
                };
                title = `Library Comparison: ${this.libraryComparisonNuclide} ${COMMON_XS_REACTIONS.find(r => r.mt === this.libraryComparisonReaction)?.label.split(' ')[0] || 'MT=' + this.libraryComparisonReaction}`;
            } else if (this.plotMode === 'thermal-scattering') {
                // S(alpha, beta) thermal scattering mode
                request = {
                    nuclides: [],
                    reactions: [2],  // Elastic scattering
                    temperature: this.temperature,
                    energyRegion: this.energyRegion,
                    thermalScattering: {
                        material: this.thermalMaterial,
                        temperatures: this.thermalTemperatures
                    },
                    includeUncertainty: false,
                    includeDerivative: this.showDerivative,
                    groupStructure: this.groupStructure
                };
                title = `S(α,β) Thermal Scattering: ${this.thermalMaterial}`;
            } else if (this.plotMode === 'chain-decay') {
                // Chain decay/buildup mode
                request = {
                    nuclides: [this.chainDecayParent],
                    reactions: selectedReactions.map(r => r.mt),
                    temperature: this.temperature,
                    energyRegion: this.energyRegion,
                    chainDecay: {
                        parentNuclide: this.chainDecayParent,
                        decayTime: this.chainDecayTime,
                        flux: this.chainDecayFlux,
                        includeDaughters: this.chainDecayIncludeDaughters,
                        maxDepth: this.chainDecayMaxDepth,
                        trackDaughters: this.chainDecayTrackDaughters
                    },
                    includeUncertainty: false,
                    includeIntegrals: this.showIntegrals,
                    includeDerivative: this.showDerivative,
                    groupStructure: this.groupStructure
                };
                const timeStr = this.chainDecayTime === 0 ? 't=0' : 
                    this.chainDecayTime < 3600 ? `t=${this.chainDecayTime}s` :
                    this.chainDecayTime < 86400 ? `t=${(this.chainDecayTime/3600).toFixed(1)}h` :
                    this.chainDecayTime < 31536000 ? `t=${(this.chainDecayTime/86400).toFixed(1)}d` :
                    `t=${(this.chainDecayTime/31536000).toFixed(1)}y`;
                title = `Chain Decay: ${this.chainDecayParent} (${timeStr})`;
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
                    energyRegion: this.energyRegion,
                    includeUncertainty: this.showUncertainty,
                    includeDerivative: this.showDerivative
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
                    })),
                    includeUncertainty: this.showUncertainty,
                    includeIntegrals: this.showIntegrals,
                    includeDerivative: this.showDerivative,
                    groupStructure: this.groupStructure
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
                    energyRegion: this.energyRegion,
                    includeUncertainty: this.showUncertainty,
                    includeIntegrals: this.showIntegrals,
                    includeDerivative: this.showDerivative,
                    groupStructure: this.groupStructure
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
                    // Check if uncertainty was requested but not available
                    if (this.showUncertainty) {
                        const hasUncertainty = data.curves.some((c: any) => c.uncertainty);
                        if (!hasUncertainty) {
                            this.messageService.info('Uncertainty data not available in this cross-section library. Libraries with covariance data (MF=30-35) are required.');
                        }
                    }
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
        const textColor = 'var(--theia-foreground)';
        const bgColor = 'var(--theia-editor-background)';
        const panelBg = 'var(--theia-sideBar-background)';

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
                <h2 style={{ marginBottom: '16px', color: 'var(--theia-foreground)' }}>
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
                    <h4 style={{ margin: '0 0 12px 0', color: 'var(--theia-foreground)' }}>
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
                            backgroundColor: 'var(--theia-input-background)',
                            color: textColor,
                            border: '1px solid var(--theia-input-border)',
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
                                backgroundColor: this.crossSectionsPath ? 'var(--theia-button-background)' : 'var(--theia-button-disabledBackground)',
                                color: 'var(--theia-button-foreground)',
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
                                border: '1px solid var(--theia-input-border)',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '13px'
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>

                <p style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginTop: '16px' }}>
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

    private renderModeButton(mode: XSPlotMode, label: string): React.ReactNode {
        const isActive = this.plotMode === mode;
        return (
            <button
                onClick={() => this.setPlotMode(mode)}
                style={{
                    flex: 1,
                    padding: '6px 4px',
                    fontSize: '11px',
                    backgroundColor: isActive
                        ? 'var(--theia-button-background)'
                        : 'var(--theia-button-secondaryBackground)',
                    color: isActive ? 'var(--theia-button-foreground)' : 'var(--theia-foreground)',
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

    private renderNuclideControls(textColor: string, checkboxBg: string): React.ReactNode {
        const searchLower = this.nuclideSearchFilter.toLowerCase();
        const filteredNuclides = this.availableNuclides.filter(n => 
            n.toLowerCase().includes(searchLower)
        ).slice(0, 100);

        return (
            <div style={{
                padding: '15px',
                borderBottom: '1px solid var(--theia-panel-border)'
            }}>
                <h4 style={{ margin: '0 0 12px 0', color: 'var(--theia-foreground)' }}>
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
                            border: '1px solid var(--theia-input-border)',
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
                            backgroundColor: 'var(--theia-editor-background)',
                            border: '1px solid var(--theia-input-border)',
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
                    <div style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '4px' }}>
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
                                    backgroundColor: 'var(--theia-button-background)',
                                    color: 'var(--theia-button-foreground)',
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
                        border: '1px solid var(--theia-input-border)',
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

    private renderMaterialControls(textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '15px',
                borderBottom: '1px solid var(--theia-panel-border)'
            }}>
                <h4 style={{ margin: '0 0 12px 0', color: 'var(--theia-foreground)' }}>
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
                                    backgroundColor: 'var(--theia-input-background)',
                                    borderRadius: '3px',
                                    marginBottom: '6px',
                                    fontSize: '12px'
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <strong>{mat.name}</strong>
                                    <span onClick={() => this.removeMaterial(idx)} style={{ cursor: 'pointer', color: 'var(--theia-errorForeground)' }}>
                                        ×
                                    </span>
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)' }}>
                                    {mat.components.map(c => `${c.nuclide} (${(c.fraction * 100).toFixed(1)}%)`).join(', ')}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <div style={{
                    padding: '10px',
                    backgroundColor: 'var(--theia-input-background)',
                    borderRadius: '3px',
                    border: '1px solid var(--theia-input-border)'
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
                            border: '1px solid var(--theia-input-border)',
                            borderRadius: '3px',
                            fontSize: '12px',
                            boxSizing: 'border-box'
                        }}
                    />

                    <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '4px' }}>Components:</div>
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
                                        border: '1px solid var(--theia-input-border)',
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
                                        border: '1px solid var(--theia-input-border)',
                                        borderRadius: '3px',
                                        boxSizing: 'border-box'
                                    }}
                                />
                                <button
                                    onClick={() => this.removeComponent(idx)}
                                    style={{
                                        padding: '4px 8px',
                                        backgroundColor: 'var(--theia-errorForeground)',
                                        color: 'var(--theia-button-foreground)',
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
                                backgroundColor: 'var(--theia-button-secondaryBackground)',
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
                                ? 'var(--theia-button-background)'
                                : 'var(--theia-button-disabledBackground)',
                            color: 'var(--theia-button-foreground)',
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

    private renderTempComparisonControls(textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '15px',
                borderBottom: '1px solid var(--theia-panel-border)'
            }}>
                <h4 style={{ margin: '0 0 12px 0', color: 'var(--theia-foreground)' }}>
                    <span className={codicon('flame')} style={{ marginRight: '6px' }} />
                    Temperature Comparison
                </h4>
                <div style={{ fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '12px' }}>
                    Visualize Doppler broadening effects.
                </div>

                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '4px' }}>
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
                            border: '1px solid var(--theia-input-border)',
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
                    <label style={{ display: 'block', fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '4px' }}>
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
                            border: '1px solid var(--theia-input-border)',
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
                    <label style={{ display: 'block', fontSize: '11px', color: 'var(--theia-descriptionForeground)', marginBottom: '4px' }}>
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
                            border: '1px solid var(--theia-input-border)',
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
                                backgroundColor: 'var(--theia-button-secondaryBackground)',
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

    // ===== Thermal Scattering Setters =====

    private setThermalMaterial(material: string): void {
        this.thermalMaterial = material;
        this.update();
    }

    private setThermalTemperatures(value: string): void {
        this.thermalTemperatures = value.split(/[,\s]+/)
            .map(t => parseFloat(t.trim()))
            .filter(t => !isNaN(t) && t > 0);
        if (this.thermalTemperatures.length === 0) {
            this.thermalTemperatures = [294];
        }
        this.update();
    }

    // ===== Chain Decay Controls =====

    private setChainDecayParent(nuclide: string): void {
        this.chainDecayParent = nuclide;
        this.update();
    }

    // ===== Library Comparison Controls =====

    private renderLibraryComparisonControls(textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '10px',
                borderBottom: '1px solid var(--theia-panel-border)',
                boxSizing: 'border-box',
                width: '100%'
            }}>
                <h4 style={{ margin: '0 0 6px 0', color: 'var(--theia-foreground)', fontSize: '12px' }}>
                    <span className={codicon('book')} style={{ marginRight: '6px' }} />
                    Library Comparison
                </h4>
                <div style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '6px' }}>
                    Compare nuclide data across different libraries.
                </div>

                <div style={{ marginBottom: '6px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
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
                            border: '1px solid var(--theia-input-border)',
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
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
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
                            border: '1px solid var(--theia-input-border)',
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
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
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
                            border: '1px solid var(--theia-input-border)',
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    />
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
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
                                        backgroundColor: 'var(--theia-input-background)',
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
                                        style={{ cursor: 'pointer', color: 'var(--theia-errorForeground)', marginLeft: '6px', flexShrink: 0 }}
                                    >
                                        ×
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    <div style={{
                        padding: '8px',
                        backgroundColor: 'var(--theia-input-background)',
                        borderRadius: '3px',
                        border: '1px solid var(--theia-input-border)',
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
                                border: '1px solid var(--theia-input-border)',
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
                                border: '1px solid var(--theia-input-border)',
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
                                    ? 'var(--theia-button-background)'
                                    : 'var(--theia-button-disabledBackground)',
                                color: 'var(--theia-button-foreground)',
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

                <div style={{ fontSize: '9px', color: 'var(--theia-descriptionForeground)', fontStyle: 'italic' }}>
                    Tip: Add libraries with cross_sections.xml paths.
                </div>
            </div>
        );
    }

    private renderThermalScatteringControls(textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '10px',
                borderBottom: '1px solid var(--theia-panel-border)',
                boxSizing: 'border-box',
                width: '100%'
            }}>
                <h4 style={{ margin: '0 0 6px 0', color: 'var(--theia-foreground)', fontSize: '12px' }}>
                    <span className={codicon('flame')} style={{ marginRight: '6px' }} />
                    S(α,β) Thermal Scattering
                </h4>
                <div style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '8px' }}>
                    Plot thermal neutron scattering cross-sections.
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
                        Thermal Scattering Material
                    </label>
                    <select
                        value={this.thermalMaterial}
                        onChange={(e) => this.setThermalMaterial(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '4px 6px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: '1px solid var(--theia-input-border)',
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    >
                        {this.availableThermalMaterials.map(mat => (
                            <option key={mat} value={mat}>{mat}</option>
                        ))}
                    </select>
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
                        Temperatures (K)
                    </label>
                    <input
                        type="text"
                        value={this.thermalTemperatures.join(', ')}
                        onChange={(e) => this.setThermalTemperatures(e.target.value)}
                        placeholder="e.g., 294, 600, 800"
                        style={{
                            width: '100%',
                            padding: '4px 6px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: '1px solid var(--theia-input-border)',
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    />
                </div>

                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {[[294], [294, 600], [294, 600, 800, 1000]].map((temps, idx) => (
                        <button
                            key={idx}
                            onClick={() => { this.thermalTemperatures = temps; this.update(); }}
                            style={{
                                padding: '3px 6px',
                                fontSize: '10px',
                                backgroundColor: 'var(--theia-button-secondaryBackground)',
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

                <div style={{ fontSize: '9px', color: 'var(--theia-descriptionForeground)', fontStyle: 'italic', marginTop: '8px' }}>
                    {this.availableThermalMaterials.length} thermal scattering material(s) available in your library.
                    {this.availableThermalMaterials.length === 0 && ' Check cross-section path.'}
                </div>
            </div>
        );
    }

    private renderChainDecayControls(textColor: string, checkboxBg: string): React.ReactNode {
        return (
            <div style={{
                padding: '10px',
                borderBottom: '1px solid var(--theia-panel-border)',
                boxSizing: 'border-box',
                width: '100%'
            }}>
                <h4 style={{ margin: '0 0 6px 0', color: 'var(--theia-foreground)', fontSize: '12px' }}>
                    <span className={codicon('git-branch')} style={{ marginRight: '6px' }} />
                    Chain Decay/Buildup
                </h4>
                <div style={{ fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '8px' }}>
                    Calculate cumulative cross-sections for decay chains.
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
                        Parent Nuclide
                    </label>
                    <select
                        value={this.chainDecayParent}
                        onChange={(e) => this.setChainDecayParent(e.target.value)}
                        style={{
                            width: '100%',
                            padding: '4px 6px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: '1px solid var(--theia-input-border)',
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    >
                        {this.availableNuclides.filter(n => ['U235', 'U238', 'Pu239', 'Pu240', 'Pu241', 'Pu242', 'Th232', 'Th230', 'Ra226', 'Cs137', 'Cs135', 'Sr90', 'Kr85', 'Am241', 'Am243', 'Np237', 'Cm244'].includes(n) || /^U2[0-9]{2}$/.test(n) || /^U2[0-9]{2}_m1$/.test(n) || /^Pu2[0-9]{2}$/.test(n) || /^Pu2[0-9]{2}_m1$/.test(n) || /^Th2[0-9]{2}$/.test(n) || /^Am2[0-9]{2}$/.test(n) || /^Am2[0-9]{2}_m1$/.test(n) || /^Np2[0-9]{2}$/.test(n) || /^Cm2[0-9]{2}$/.test(n) || /^Cm2[0-9]{2}_m1$/.test(n)).map(n => (
                            <option key={n} value={n}>{n}</option>
                        ))}
                    </select>
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
                        Decay Time (seconds)
                    </label>
                    <input
                        type="number"
                        value={this.chainDecayTime}
                        onChange={(e) => this.chainDecayTime = parseFloat(e.target.value) || 0}
                        min="0"
                        step="1"
                        style={{
                            width: '100%',
                            padding: '4px 6px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: '1px solid var(--theia-input-border)',
                            borderRadius: '3px',
                            fontSize: '11px',
                            boxSizing: 'border-box'
                        }}
                    />
                    <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap' }}>
                        {[0, 3600, 86400, 604800, 2592000, 31536000].map((t, idx) => {
                            const labels = ['0s', '1h', '1d', '1w', '1mo', '1y'];
                            return (
                                <button
                                    key={t}
                                    onClick={() => { this.chainDecayTime = t; this.update(); }}
                                    style={{
                                        padding: '2px 6px',
                                        fontSize: '9px',
                                        backgroundColor: this.chainDecayTime === t ? 'var(--theia-button-background)' : 'var(--theia-button-secondaryBackground)',
                                        color: this.chainDecayTime === t ? 'var(--theia-button-foreground)' : textColor,
                                        border: 'none',
                                        borderRadius: '3px',
                                        cursor: 'pointer'
                                    }}
                                >
                                    {labels[idx]}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: '11px', cursor: 'pointer' }}>
                        <input
                            type="checkbox"
                            checked={this.chainDecayIncludeDaughters}
                            onChange={() => { this.chainDecayIncludeDaughters = !this.chainDecayIncludeDaughters; this.update(); }}
                            style={{ marginRight: '6px' }}
                        />
                        Include Daughter Products
                    </label>
                </div>

                <div style={{ marginBottom: '8px' }}>
                    <label style={{ display: 'block', fontSize: '10px', color: 'var(--theia-descriptionForeground)', marginBottom: '2px' }}>
                        Max Chain Depth: {this.chainDecayMaxDepth}
                    </label>
                    <input
                        type="range"
                        min="1"
                        max="5"
                        value={this.chainDecayMaxDepth}
                        onChange={(e) => { this.chainDecayMaxDepth = parseInt(e.target.value); this.update(); }}
                        style={{ width: '100%' }}
                    />
                </div>

                <div style={{ fontSize: '9px', color: 'var(--theia-descriptionForeground)', fontStyle: 'italic', marginTop: '8px' }}>
                    Shows cumulative XS including daughter contributions weighted by decay abundance.
                </div>
            </div>
        );
    }

    private renderResizeHandle(): React.ReactNode {
        const handleColor = 'var(--theia-panel-border)';
        const handleHoverColor = 'var(--theia-input-border)';
        
        return (
            <Tooltip content="Drag to resize" position="top">
                <div
                    style={{
                        height: '6px',
                        backgroundColor: this.isDraggingIntegrals ? handleHoverColor : handleColor,
                        cursor: 'row-resize',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'background-color 0.2s'
                    }}
                    onMouseDown={(e) => this.startResizeIntegrals(e)}
                >
                    <div style={{
                        width: '30px',
                        height: '2px',
                        backgroundColor: 'var(--theia-descriptionForeground)',
                        borderRadius: '1px'
                    }} />
                </div>
            </Tooltip>
        );
    }

    private startResizeIntegrals(e: React.MouseEvent): void {
        this.isDraggingIntegrals = true;
        const startY = e.clientY;
        const startHeight = this.integralsPanelHeight;
        
        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (!this.isDraggingIntegrals) return;
            
            const deltaY = startY - moveEvent.clientY; // Negative when dragging down
            const newHeight = Math.max(100, Math.min(400, startHeight + deltaY));
            this.integralsPanelHeight = newHeight;
            this.update();
        };
        
        const handleMouseUp = () => {
            this.isDraggingIntegrals = false;
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            this.update();
        };
        
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }

    private renderIntegralsPanel(): React.ReactNode {
        if (!this.data || !this.data.curves || this.data.curves.length === 0) {
            return null;
        }

        const panelBg = 'var(--theia-sideBar-background)';
        const borderColor = 'var(--theia-panel-border)';
        const textColor = 'var(--theia-foreground)';
        const headerColor = 'var(--theia-foreground)';

        return (
            <div style={{
                height: `${this.integralsPanelHeight}px`,
                overflow: 'auto',
                backgroundColor: panelBg,
                borderTop: `1px solid ${borderColor}`,
                padding: '10px 15px',
                flexShrink: 0
            }}>
                <h4 style={{ margin: '0 0 10px 0', color: headerColor, fontSize: '13px' }}>
                    <span className={codicon('symbol-constant')} style={{ marginRight: '6px' }} />
                    Integral Quantities
                    <Tooltip content="Hide panel" position="left">
                        <span 
                            onClick={() => { this.showIntegrals = false; this.update(); }}
                            style={{ 
                                float: 'right', 
                                cursor: 'pointer', 
                                fontSize: '12px',
                                color: textColor,
                                marginLeft: '10px'
                            }}
                        >
                            ×
                        </span>
                    </Tooltip>
                </h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {this.data.curves.map((curve, idx) => {
                        if (!curve.integrals) return null;
                        const integrals = curve.integrals;
                        
                        return (
                            <div key={idx} style={{
                                padding: '8px',
                                backgroundColor: 'var(--theia-editor-background)',
                                borderRadius: '3px',
                                border: `1px solid ${borderColor}`,
                                fontSize: '11px'
                            }}>
                                <div style={{ fontWeight: 'bold', marginBottom: '4px', color: headerColor }}>
                                    {curve.label}
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', color: textColor }}>
                                    {integrals.resonanceIntegral !== undefined && (
                                        <>
                                            <span>Resonance Integral:</span>
                                            <span style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                                                {integrals.resonanceIntegral.toExponential(4)} b
                                            </span>
                                        </>
                                    )}
                                    {integrals.thermalXS !== undefined && (
                                        <>
                                            <span>Thermal (2200 m/s):</span>
                                            <span style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                                                {integrals.thermalXS.toFixed(3)} b
                                            </span>
                                        </>
                                    )}
                                    {integrals.maxwellianAverage !== undefined && (
                                        <>
                                            <span>Maxwellian Avg:</span>
                                            <span style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                                                {integrals.maxwellianAverage.toFixed(3)} b
                                            </span>
                                        </>
                                    )}
                                    {integrals.averageXS !== undefined && (
                                        <>
                                            <span>Average XS:</span>
                                            <span style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                                                {integrals.averageXS.toExponential(4)} b
                                            </span>
                                        </>
                                    )}
                                    {integrals.integratedXS !== undefined && (
                                        <>
                                            <span>Integrated XS:</span>
                                            <span style={{ textAlign: 'right', fontFamily: 'monospace' }}>
                                                {integrals.integratedXS.toExponential(4)} b·eV
                                            </span>
                                        </>
                                    )}
                                </div>
                            </div>
                        );
                    })}
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
