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
import { XSPlotData, XSReaction, COMMON_XS_REACTIONS } from '../../common/visualizer-protocol';
import { PlotlyComponent } from '../plotly/plotly-component';
import { OpenMCService } from './openmc-service';
import { VisualizerPreferences } from '../visualizer-preferences';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { MessageService } from '@theia/core/lib/common/message-service';
import { CommonCommands } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common/command';

@injectable()
export class XSPlotWidget extends ReactWidget {
    static readonly ID = 'xs-plot-widget';
    static readonly LABEL = 'Cross-Section Plot';

    private data: XSPlotData | null = null;
    private titleText: string = 'Cross-Section Plot';
    private selectedNuclides: string[] = ['U235'];
    private nuclidesInput: string = 'U235'; // Raw input for textarea
    private selectedReactions: XSReaction[] = COMMON_XS_REACTIONS.map(r => ({ ...r }));
    private temperature: number = 294;
    private energyRange: [number, number] = [1e-5, 2e7]; // 0.01 meV to 20 MeV
    private isLoading: boolean = false;
    private errorMessage: string | null = null;
    private crossSectionsPath: string = '';
    private showSetupDialog: boolean = false;

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
                this.update();
            }
        });

        // Listen for theme changes to re-render the plot
        this.themeService.onDidColorThemeChange(() => this.update());

        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setData(data: XSPlotData, title: string): void {
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
                    width: '300px',
                    minWidth: '300px',
                    backgroundColor: panelBg,
                    borderRight: `1px solid ${borderColor}`,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden'
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

        return (
            <>
                <div style={{
                    padding: '15px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
                }}>
                    <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                        <span className={codicon('symbol-misc')} style={{ marginRight: '6px' }} />
                        Nuclides
                    </h4>
                    <textarea
                        value={this.nuclidesInput}
                        onChange={(e) => this.handleNuclidesChange(e.target.value)}
                        placeholder="Enter nuclides (e.g., U235, U238, H1)"
                        style={{
                            width: '100%',
                            height: '60px',
                            backgroundColor: checkboxBg,
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '3px',
                            padding: '6px',
                            fontSize: '12px',
                            fontFamily: 'monospace',
                            resize: 'none'
                        }}
                    />
                    <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                        Comma-separated list (e.g., U235, Pu239, H1)
                    </div>
                </div>

                <div style={{
                    padding: '15px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`,
                    flex: 1,
                    overflow: 'auto'
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

                <div style={{
                    padding: '15px',
                    borderBottom: `1px solid ${theme === 'dark' ? '#3c3c3c' : '#e0e0e0'}`
                }}>
                    <h4 style={{ margin: '0 0 12px 0', color: theme === 'dark' ? '#fff' : '#000' }}>
                        <span className={codicon('settings')} style={{ marginRight: '6px' }} />
                        Settings
                    </h4>
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
                                fontSize: '12px'
                            }}
                        />
                    </div>
                    <div>
                        <label style={{ display: 'block', fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                            Energy Range (eV)
                        </label>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <input
                                type="text"
                                value={this.energyRange[0].toExponential(1)}
                                readOnly
                                title="Min Energy"
                                style={{
                                    flex: 1,
                                    minWidth: 0,
                                    padding: '4px 6px',
                                    backgroundColor: theme === 'dark' ? '#2a2a2a' : '#e8e8e8',
                                    color: textColor,
                                    border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                    borderRadius: '3px',
                                    fontSize: '10px',
                                    textAlign: 'center'
                                }}
                            />
                            <span style={{ color: '#888', fontSize: '11px', whiteSpace: 'nowrap' }}>to</span>
                            <input
                                type="text"
                                value={this.energyRange[1].toExponential(1)}
                                readOnly
                                title="Max Energy"
                                style={{
                                    flex: 1,
                                    minWidth: 0,
                                    padding: '4px 6px',
                                    backgroundColor: theme === 'dark' ? '#2a2a2a' : '#e8e8e8',
                                    color: textColor,
                                    border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                                    borderRadius: '3px',
                                    fontSize: '10px',
                                    textAlign: 'center'
                                }}
                            />
                        </div>
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
                            opacity: this.isLoading ? 0.7 : 1
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

        const traces: Partial<Plotly.Data>[] = this.data.curves.map(curve => ({
            x: curve.energy,
            y: curve.xs,
            type: 'scatter',
            mode: 'lines',
            name: curve.label,
            line: { width: 1.5 }
        }));

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
        
        if (this.selectedNuclides.length === 0) {
            this.errorMessage = 'Please enter at least one nuclide';
            this.update();
            return;
        }
        if (selectedReactions.length === 0) {
            this.errorMessage = 'Please select at least one reaction';
            this.update();
            return;
        }

        this.isLoading = true;
        this.errorMessage = null;
        this.update();

        try {
            const request = {
                nuclides: this.selectedNuclides,
                reactions: selectedReactions.map(r => r.mt),
                temperature: this.temperature,
                energyRange: this.energyRange
            };

            const data = await this.openmcService.getXSData(request);
            
            // Always ensure loading is reset even if data is null/undefined
            this.isLoading = false;
            
            if (data) {
                if (data.error) {
                    this.errorMessage = data.error;
                    this.data = null;
                } else if (data.curves && data.curves.length > 0) {
                    const nuclidesStr = this.selectedNuclides.join(', ');
                    this.setData(data, `Cross-Sections: ${nuclidesStr}`);
                    return; // setData already resets isLoading and calls update
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
                            padding: '10px 12px',
                            fontSize: '13px',
                            backgroundColor: theme === 'dark' ? '#3c3c3c' : '#fff',
                            color: textColor,
                            border: `1px solid ${theme === 'dark' ? '#555' : '#ccc'}`,
                            borderRadius: '4px'
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
}
