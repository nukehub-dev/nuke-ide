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

import * as React from '@theia/core/shared/react';
import { injectable } from '@theia/core/shared/inversify';
import { OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCTransferRate } from '../../../../common/openmc-state-schema';
import { DEPLETION_SOLVERS, resolveDepletionSolver } from '../../../../common/depletion-solvers';
import { ChainBuildResult } from '../../../../common/openmc-studio-protocol';
import { DepletionTimeline } from '../depletion-timeline';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';

/**
 * Depletion tab of the simulation dashboard: burnup configuration and timeline.
 */
@injectable()
export class DepletionTabContribution implements DashboardTabContribution {
    readonly id = 'depletion';
    readonly label = 'Depletion';
    readonly icon = 'openmc-depletion';
    readonly order = 3;

    /**
     * Render the Depletion tab with burnup configuration and timeline.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Depletion tab React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const depletion = state.depletion || { timeSteps: [], power: 0, enabled: false };
        const hasDepletableMaterials = state.materials.some((m) => m.isDepletable);
        const isEnabled = depletion.enabled;

        // Get default chain file from preferences
        const defaultChainFile = host.nukeCoreService.getChainFilePath();
        const chainFile = depletion.chainFile || defaultChainFile || '';

        return (
            <div className="depletion-tab">
                {/* Enable/Disable Card */}
                <div className={`depletion-enable-card ${isEnabled ? 'enabled' : ''}`}>
                    <div className="enable-card-content">
                        <div className="enable-icon">
                            <i className={`codicon ${isEnabled ? 'codicon-check' : 'codicon-history'}`}></i>
                        </div>
                        <div className="enable-text">
                            <h3>Depletion Analysis</h3>
                            <p>
                                {isEnabled
                                    ? 'Track fuel burnup and isotopic evolution over time.'
                                    : 'Enable to track how material composition changes during reactor operation.'}
                            </p>
                        </div>
                        <button
                            className={`theia-button ${isEnabled ? 'secondary' : 'primary'}`}
                            onClick={() => host.stateManager.updateDepletion({ enabled: !isEnabled })}
                        >
                            <i className={`codicon ${isEnabled ? 'codicon-close' : 'codicon-play'}`}></i>
                            {isEnabled ? 'Disable' : 'Enable'}
                        </button>
                    </div>

                    {!isEnabled && (
                        <div className="enable-benefits">
                            <div className="benefit-item">
                                <i className="codicon codicon-flame"></i>
                                <span>Track fuel burnup</span>
                            </div>
                            <div className="benefit-item">
                                <i className="codicon codicon-radioactive"></i>
                                <span>Monitor waste buildup</span>
                            </div>
                            <div className="benefit-item">
                                <i className="codicon codicon-graph-line"></i>
                                <span>Analyze reactivity changes</span>
                            </div>
                        </div>
                    )}
                </div>

                {isEnabled && (
                    <>
                        {/* Physics Configuration */}
                        <div className="settings-section depletion-config">
                            <h3>
                                <i className="codicon codicon-gear"></i> Physics Configuration
                            </h3>

                            <div className="config-grid">
                                <div className="config-item">
                                    <label>
                                        <i className="codicon codicon-file-code"></i>
                                        Chain File
                                        <Tooltip content="XML file with decay constants and fission yields for all isotopes" position="top">
                                            <i className="codicon codicon-info info-icon"></i>
                                        </Tooltip>
                                    </label>
                                    <div className="file-input-group">
                                        <input
                                            type="text"
                                            value={chainFile}
                                            onChange={(e) => host.stateManager.updateDepletion({ chainFile: e.target.value })}
                                            placeholder="Select chain.xml file..."
                                        />
                                        <button className="theia-button secondary" onClick={() => this.browseChainFile(host)}>
                                            <i className="codicon codicon-folder-opened"></i>
                                            Browse
                                        </button>
                                    </div>
                                    <span className="config-hint">Contains nuclide decay and fission yield data</span>
                                </div>

                                <div className="config-item">
                                    <label>
                                        <i className="codicon codicon-symbol-method"></i>
                                        Integration Method
                                    </label>
                                    <NukeSelect
                                        value={resolveDepletionSolver((depletion as any).solver)}
                                        options={[...DEPLETION_SOLVERS.map((s) => ({ value: s.id, label: s.label }))]}
                                        onChange={(value: string) => host.stateManager.updateDepletion({ solver: value as any })}
                                        ariaLabel="Integration method"
                                    />
                                    <span className="config-hint">Algorithm for solving depletion equations</span>
                                </div>
                            </div>

                            <div className="config-grid single">
                                <div className="config-item">
                                    <label>
                                        <i className="codicon codicon-zap"></i>
                                        Power Level
                                    </label>
                                    <div className="power-input-unit">
                                        <input
                                            type="number"
                                            min={0}
                                            step="any"
                                            value={depletion.power || depletion.powerDensity || 0}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                if (depletion.powerDensity !== undefined) {
                                                    host.stateManager.updateDepletion({ powerDensity: val, power: undefined });
                                                } else {
                                                    host.stateManager.updateDepletion({ power: val, powerDensity: undefined });
                                                }
                                            }}
                                        />
                                        <NukeSelect
                                            value={depletion.powerDensity !== undefined ? 'power_density' : 'power'}
                                            options={[
                                                { value: 'power', label: 'Watts (Total)' },
                                                { value: 'power_density', label: 'W/g (Density)' }
                                            ]}
                                            onChange={(value: string) => {
                                                const val = depletion.power || depletion.powerDensity || 0;
                                                if (value === 'power_density') {
                                                    host.stateManager.updateDepletion({ powerDensity: val, power: undefined });
                                                } else {
                                                    host.stateManager.updateDepletion({ power: val, powerDensity: undefined });
                                                }
                                            }}
                                            ariaLabel="Power mode"
                                        />
                                    </div>
                                    <span className="config-hint">Reactor operating power for depletion calculations</span>
                                </div>
                            </div>
                        </div>

                        {this.renderChainBuilder(host)}

                        {this.renderAdvancedSection(host, state)}

                        {/* Materials Section */}
                        <div className="settings-section">
                            <h3>
                                <i className="codicon codicon-layers"></i> Depletable Materials
                            </h3>

                            {!hasDepletableMaterials ? (
                                <div className="openmc-warning-box">
                                    <i className="codicon codicon-warning"></i>
                                    <div className="warning-content">
                                        <strong>No Depletable Materials Configured</strong>
                                        <p>
                                            Go to the <strong>Materials</strong> tab and enable "Depletable" for fuel materials you want to
                                            track.
                                        </p>
                                    </div>
                                    <button
                                        className="theia-button primary"
                                        onClick={() => {
                                            host.setActiveTab('materials');
                                        }}
                                    >
                                        Go to Materials
                                    </button>
                                </div>
                            ) : (
                                <>
                                    {state.materials.some((m) => m.isDepletable && m.macroscopic) && (
                                        <div className="openmc-warning-box">
                                            <i className="codicon codicon-warning"></i>
                                            <div className="warning-content">
                                                <strong>Macroscopic materials cannot deplete</strong>
                                                <p>
                                                    {state.materials
                                                        .filter((m) => m.isDepletable && m.macroscopic)
                                                        .map((m) => m.name)
                                                        .join(', ')}{' '}
                                                    — macroscopic (multigroup) materials carry cross-section sets, not nuclides. Use
                                                    nuclide-decomposed materials for depletion.
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                    <div className="depletion-materials-grid">{this.renderDepletableMaterialsSection(state)}</div>
                                </>
                            )}
                        </div>

                        {/* Timeline Editor */}
                        {hasDepletableMaterials && (
                            <div className="settings-section timeline-section">
                                <DepletionTimeline
                                    depletion={depletion as any}
                                    onChange={(updates) => host.stateManager.updateDepletion(updates)}
                                    onToggleDecayOnly={(idx) => host.stateManager.toggleDecayOnlyStep(idx)}
                                />
                            </div>
                        )}
                    </>
                )}
            </div>
        );
    }

    /**
     * Open a file dialog to select a depletion chain XML file.
     * @param host - Simulation dashboard widget host.
     */
    private async browseChainFile(host: SimulationDashboardWidget): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select OpenMC Depletion Chain File',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'OpenMC Chain': ['xml'],
                'All Files': ['*']
            }
        };

        const uri = await host.fileDialogService.showOpenDialog(props);
        if (uri) {
            host.stateManager.updateDepletion({ chainFile: uri.path.toString() });
        }
    }

    // Chain builder UI state
    private chainBuilderMode: 'subset' | 'endf' = 'subset';
    private chainBuilderSource = '';
    private chainBuilderNuclides = '';
    private chainBuilderOutput = '';
    private chainBuilderBusy = false;
    private chainBuilderResult?: ChainBuildResult;

    /**
     * Render the custom depletion chain builder section.
     * @param host - Simulation dashboard widget host.
     * @returns Chain builder section React node.
     */
    private renderChainBuilder(host: SimulationDashboardWidget): React.ReactNode {
        const result = this.chainBuilderResult;
        const canBuild = !this.chainBuilderBusy && this.chainBuilderSource.trim() !== '' && this.chainBuilderOutput.trim() !== '';

        return (
            <div className="settings-section chain-builder">
                <h3>
                    <i className="codicon codicon-wand"></i> Custom Chain Builder
                </h3>
                <div className="config-grid">
                    <div className="config-item">
                        <label>Mode</label>
                        <NukeSelect
                            value={this.chainBuilderMode}
                            options={[
                                { value: 'subset', label: 'Subset an existing chain' },
                                { value: 'endf', label: 'Build from ENDF directory' }
                            ]}
                            onChange={(value: string) => {
                                this.chainBuilderMode = value as 'subset' | 'endf';
                                host.update();
                            }}
                            ariaLabel="Chain builder mode"
                        />
                        <span className="config-hint">
                            {this.chainBuilderMode === 'subset'
                                ? 'Filter a full chain to a fast subset (FPY borrow parents included automatically)'
                                : 'Build from ENDF text sub-libraries (decay/ nfy/ neutron(s)/ — HDF5 incident data cannot build chains)'}
                        </span>
                    </div>
                    <div className="config-item">
                        <label>{this.chainBuilderMode === 'subset' ? 'Source Chain XML' : 'ENDF Directory'}</label>
                        <div className="file-input-group">
                            <input
                                type="text"
                                value={this.chainBuilderSource}
                                onChange={(e) => {
                                    this.chainBuilderSource = e.target.value;
                                    host.update();
                                }}
                                placeholder={this.chainBuilderMode === 'subset' ? 'chain.xml...' : 'ENDF-B directory...'}
                            />
                            <button className="theia-button secondary" onClick={() => this.browseChainBuilderSource(host)}>
                                <i className="codicon codicon-folder-opened"></i> Browse
                            </button>
                        </div>
                    </div>
                </div>
                <div className="config-grid">
                    <div className="config-item">
                        <label>Nuclides (optional)</label>
                        <input
                            type="text"
                            value={this.chainBuilderNuclides}
                            onChange={(e) => {
                                this.chainBuilderNuclides = e.target.value;
                                host.update();
                            }}
                            placeholder="All from source, or e.g. U235,U238,Pu239"
                        />
                        <span className="config-hint">Comma-separated subset</span>
                    </div>
                    <div className="config-item">
                        <label>Output Chain XML</label>
                        <div className="file-input-group">
                            <input
                                type="text"
                                value={this.chainBuilderOutput}
                                onChange={(e) => {
                                    this.chainBuilderOutput = e.target.value;
                                    host.update();
                                }}
                                placeholder="custom_chain.xml..."
                            />
                            <button className="theia-button secondary" onClick={() => this.browseChainBuilderOutput(host)}>
                                <i className="codicon codicon-folder-opened"></i> Browse
                            </button>
                        </div>
                    </div>
                </div>
                <div className="config-grid single">
                    <div className="config-item">
                        <button className="theia-button primary" disabled={!canBuild} onClick={() => this.runChainBuild(host)}>
                            <i className="codicon codicon-play"></i> {this.chainBuilderBusy ? 'Building…' : 'Build Chain'}
                        </button>
                    </div>
                </div>
                {result &&
                    (result.success ? (
                        <div className="depletion-info-box">
                            <i className="codicon codicon-check"></i>
                            <div className="warning-content">
                                <strong>Chain built: {result.nuclideCount} nuclides</strong>
                                <p>
                                    {result.mode === 'subset' && result.sourceNuclideCount !== undefined
                                        ? `Filtered from ${result.sourceNuclideCount}. `
                                        : ''}
                                    {(result.borrowParentsIncluded?.length ?? 0) > 0 &&
                                        `FPY borrow parents included: ${result.borrowParentsIncluded!.join(', ')}. `}
                                    {result.outputPath}
                                </p>
                                <button
                                    className="theia-button primary"
                                    onClick={() => host.stateManager.updateDepletion({ chainFile: result.outputPath })}
                                >
                                    <i className="codicon codicon-check"></i> Use as Depletion Chain
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="openmc-warning-box">
                            <i className="codicon codicon-error"></i>
                            <div className="warning-content">
                                <strong>Chain build failed</strong>
                                <p>{result.error}</p>
                            </div>
                        </div>
                    ))}
            </div>
        );
    }

    /**
     * Browse for the chain builder source (file in subset mode, folder in ENDF mode).
     * @param host - Simulation dashboard widget host.
     */
    private async browseChainBuilderSource(host: SimulationDashboardWidget): Promise<void> {
        const props: OpenFileDialogProps =
            this.chainBuilderMode === 'subset'
                ? {
                      title: 'Select Source Chain XML',
                      canSelectFiles: true,
                      canSelectFolders: false,
                      filters: { 'OpenMC Chain': ['xml'], 'All Files': ['*'] }
                  }
                : { title: 'Select ENDF Directory', canSelectFiles: false, canSelectFolders: true };
        const uri = await host.fileDialogService.showOpenDialog(props);
        if (uri) {
            this.chainBuilderSource = uri.path.toString();
            host.update();
        }
    }

    /**
     * Browse for the chain builder output path.
     * @param host - Simulation dashboard widget host.
     */
    private async browseChainBuilderOutput(host: SimulationDashboardWidget): Promise<void> {
        const uri = await host.fileDialogService.showSaveDialog({ title: 'Save Custom Chain XML', filters: { 'OpenMC Chain': ['xml'] } });
        if (uri) {
            this.chainBuilderOutput = uri.path.toString();
            host.update();
        }
    }

    /**
     * Run the chain build via the backend and surface the result.
     * @param host - Simulation dashboard widget host.
     */
    private async runChainBuild(host: SimulationDashboardWidget): Promise<void> {
        this.chainBuilderBusy = true;
        this.chainBuilderResult = undefined;
        host.update();
        try {
            const nuclides = this.chainBuilderNuclides
                .split(',')
                .map((n) => n.trim())
                .filter((n) => n.length > 0);
            this.chainBuilderResult = await host.studioService.getBackendService().buildChain({
                fromChain: this.chainBuilderMode === 'subset' ? this.chainBuilderSource : undefined,
                fromEndf: this.chainBuilderMode === 'endf' ? this.chainBuilderSource : undefined,
                nuclides: nuclides.length > 0 ? nuclides : undefined,
                output: this.chainBuilderOutput
            });
        } catch (error) {
            this.chainBuilderResult = { success: false, error: String(error) };
        } finally {
            this.chainBuilderBusy = false;
            host.update();
        }
    }

    /**
     * Open a file dialog and update a path list entry (flux or MicroXS files).
     * @param host - Simulation dashboard widget host.
     * @param key - Which depletion path list to update.
     * @param index - Entry index in the list.
     * @param title - Dialog title.
     */
    private async browseDepletionPath(
        host: SimulationDashboardWidget,
        key: 'fluxFiles' | 'microxsFiles',
        index: number,
        title: string
    ): Promise<void> {
        const props: OpenFileDialogProps = {
            title,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'Data Files': ['csv', 'txt', 'npy'],
                'All Files': ['*']
            }
        };
        const uri = await host.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }
        const depletion = host.stateManager.getState().depletion;
        const list = [...(depletion?.[key] ?? [])];
        list[index] = uri.path.toString();
        host.stateManager.updateDepletion({ [key]: list });
    }

    /**
     * Render the Advanced depletion section: operator type, independent-operator
     * inputs, transfer rates, normalization/fission-Q, and diff burnable mats.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Advanced depletion section React node.
     */
    private renderAdvancedSection(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const depletion = state.depletion;
        if (!depletion) {
            return undefined;
        }
        const depletableMaterials = state.materials.filter((m) => m.isDepletable);
        const isIndependent = depletion.operator === 'independent';
        const isMultiGroup = state.settings.energyMode === 'multigroup';
        const transferRates = depletion.transferRates ?? [];
        const fissionQEntries = Object.entries(depletion.fissionQ ?? {});

        const updateTransferRate = (index: number, updates: Partial<OpenMCTransferRate>): void => {
            const next = transferRates.map((tr, i) => (i === index ? { ...tr, ...updates } : tr));
            host.stateManager.updateDepletion({ transferRates: next });
        };

        const updatePathList = (key: 'fluxFiles' | 'microxsFiles', index: number, value: string): void => {
            const list = [...(depletion[key] ?? [])];
            list[index] = value;
            host.stateManager.updateDepletion({ [key]: list });
        };

        const updateFissionQ = (entries: [string, number][]): void => {
            const fissionQ = Object.fromEntries(entries.filter(([name]) => name.trim().length > 0));
            host.stateManager.updateDepletion({ fissionQ: Object.keys(fissionQ).length > 0 ? fissionQ : undefined });
        };

        const materialOptions = depletableMaterials.map((m) => ({ value: String(m.id), label: `#${m.id} ${m.name}` }));

        return (
            <div className="settings-section depletion-advanced">
                <h3>
                    <i className="codicon codicon-settings-gear"></i> Advanced
                </h3>

                <div className="config-grid">
                    <div className="config-item">
                        <label>
                            <i className="codicon codicon-circuit-board"></i>
                            Operator Type
                        </label>
                        <NukeSelect
                            value={isIndependent ? 'independent' : 'coupled'}
                            options={[
                                { value: 'coupled', label: 'Coupled (transport solve each step)' },
                                { value: 'independent', label: 'Independent (pre-computed flux & XS)' }
                            ]}
                            onChange={(value: string) =>
                                host.stateManager.updateDepletion({ operator: value as 'coupled' | 'independent' })
                            }
                            ariaLabel="Operator type"
                        />
                        <span className="config-hint">Independent uses multigroup flux/cross sections instead of transport solves</span>
                        {isMultiGroup && !isIndependent && (
                            <span className="config-hint">
                                Coupled depletion requires continuous-energy mode — this project is multi-group; use the Independent
                                operator (validation will block the run).
                            </span>
                        )}
                    </div>
                    <div className="config-item">
                        <label>
                            <i className="codicon codicon-symbol-operator"></i>
                            Normalization Mode
                        </label>
                        <NukeSelect
                            value={depletion.normalizationMode ?? 'fission-q'}
                            options={[
                                { value: 'fission-q', label: 'Fission Q (default)' },
                                { value: 'energy-deposition', label: 'Energy Deposition' },
                                { value: 'source-rate', label: 'Source Rate' }
                            ]}
                            onChange={(value: string) =>
                                host.stateManager.updateDepletion({
                                    normalizationMode: value as 'source-rate' | 'fission-q' | 'energy-deposition'
                                })
                            }
                            ariaLabel="Normalization mode"
                        />
                    </div>
                </div>

                {isIndependent && (
                    <div className="config-grid single">
                        <div className="config-item">
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={depletion.generateFromModel ?? false}
                                        onChange={(e) => host.stateManager.updateDepletion({ generateFromModel: e.target.checked })}
                                    />
                                    Generate flux &amp; MicroXS from current model
                                </label>
                                <span className="config-hint">
                                    Runs a full neutron transport solve first (get_microxs_and_flux) — significantly slower, but no input
                                    files needed.
                                </span>
                                {isMultiGroup && depletion.generateFromModel && (
                                    <span className="config-hint">
                                        MicroXS generation requires continuous-energy mode — provide flux/MicroXS files instead on this
                                        multi-group project (validation will block the run).
                                    </span>
                                )}
                            </div>
                        </div>
                        {!depletion.generateFromModel &&
                            (depletableMaterials.length === 0 ? (
                                <div className="openmc-warning-box">
                                    <i className="codicon codicon-warning"></i>
                                    <div className="warning-content">
                                        <strong>No depletable materials</strong>
                                        <p>Mark materials as depletable to configure flux and MicroXS files.</p>
                                    </div>
                                </div>
                            ) : (
                                depletableMaterials.map((mat, index) => (
                                    <div className="config-item" key={mat.id}>
                                        <label>
                                            #{mat.id} {mat.name}: Flux &amp; MicroXS files
                                        </label>
                                        <div className="file-input-group">
                                            <input
                                                type="text"
                                                value={depletion.fluxFiles?.[index] ?? ''}
                                                placeholder="Flux file (.npy/.csv/.txt)"
                                                onChange={(e) => updatePathList('fluxFiles', index, e.target.value)}
                                            />
                                            <button
                                                className="theia-button secondary"
                                                onClick={() =>
                                                    this.browseDepletionPath(host, 'fluxFiles', index, `Select Flux File for ${mat.name}`)
                                                }
                                            >
                                                <i className="codicon codicon-folder-opened"></i>
                                            </button>
                                            <input
                                                type="text"
                                                value={depletion.microxsFiles?.[index] ?? ''}
                                                placeholder="MicroXS file (.csv)"
                                                onChange={(e) => updatePathList('microxsFiles', index, e.target.value)}
                                            />
                                            <button
                                                className="theia-button secondary"
                                                onClick={() =>
                                                    this.browseDepletionPath(
                                                        host,
                                                        'microxsFiles',
                                                        index,
                                                        `Select MicroXS File for ${mat.name}`
                                                    )
                                                }
                                            >
                                                <i className="codicon codicon-folder-opened"></i>
                                            </button>
                                        </div>
                                    </div>
                                ))
                            ))}
                    </div>
                )}

                <h4>
                    <i className="codicon codicon-arrow-swap"></i> Transfer Rates
                </h4>
                {transferRates.map((tr, index) => (
                    <div className="form-row" key={index}>
                        <div className="form-group">
                            <label>From Material</label>
                            <NukeSelect
                                value={String(tr.material)}
                                options={[...materialOptions]}
                                onChange={(value: string) => updateTransferRate(index, { material: parseInt(value) })}
                                ariaLabel="From material"
                            />
                        </div>
                        <div className="form-group">
                            <label>Element / Nuclide</label>
                            <input
                                type="text"
                                value={tr.element}
                                placeholder="e.g. U, Gd155"
                                onChange={(e) => updateTransferRate(index, { element: e.target.value })}
                            />
                        </div>
                        <div className="form-group">
                            <label>Rate</label>
                            <input
                                type="number"
                                step="any"
                                value={tr.rate}
                                onChange={(e) => updateTransferRate(index, { rate: parseFloat(e.target.value) || 0 })}
                            />
                        </div>
                        <div className="form-group">
                            <label>Units</label>
                            <NukeSelect
                                value={tr.units ?? '1/s'}
                                options={[
                                    { value: '1/s', label: '1/s' },
                                    { value: '1/min', label: '1/min' },
                                    { value: '1/h', label: '1/h' },
                                    { value: '1/d', label: '1/d' },
                                    { value: '1/a', label: '1/a' }
                                ]}
                                onChange={(value: string) => updateTransferRate(index, { units: value as OpenMCTransferRate['units'] })}
                                ariaLabel="Transfer rate units"
                            />
                        </div>
                        <div className="form-group">
                            <label>Destination (optional)</label>
                            <NukeSelect
                                value={String(tr.destinationMaterial ?? '')}
                                options={[{ value: '', label: 'None' }, ...materialOptions]}
                                onChange={(value: string) =>
                                    updateTransferRate(index, {
                                        destinationMaterial: value ? parseInt(value) : undefined
                                    })
                                }
                                ariaLabel="Destination material"
                            />
                        </div>
                        <div className="form-group">
                            <label>&nbsp;</label>
                            <Tooltip content="Remove transfer rate" position="top">
                                <button
                                    className="theia-button secondary small"
                                    onClick={() =>
                                        host.stateManager.updateDepletion({
                                            transferRates: transferRates.filter((_, i) => i !== index)
                                        })
                                    }
                                >
                                    <i className="codicon codicon-trash"></i>
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                ))}
                <div className="form-group">
                    <button
                        className="theia-button secondary small"
                        disabled={depletableMaterials.length === 0}
                        onClick={() =>
                            host.stateManager.updateDepletion({
                                transferRates: [...transferRates, { material: depletableMaterials[0]?.id ?? 1, element: 'U', rate: 1e-5 }]
                            })
                        }
                    >
                        <i className="codicon codicon-add"></i> Add Transfer Rate
                    </button>
                </div>

                {(depletion.normalizationMode ?? 'fission-q') === 'fission-q' && (
                    <>
                        <h4>
                            <i className="codicon codicon-zap"></i> Custom Fission Q Values [eV]
                        </h4>
                        {fissionQEntries.map(([nuclide, qValue], index) => (
                            <div className="form-row" key={index}>
                                <div className="form-group">
                                    <label>Nuclide</label>
                                    <input
                                        type="text"
                                        value={nuclide}
                                        placeholder="e.g. U235"
                                        onChange={(e) => {
                                            const next: [string, number][] = fissionQEntries.map(([n, q], i) =>
                                                i === index ? [e.target.value, q] : [n, q]
                                            );
                                            updateFissionQ(next);
                                        }}
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Q Value (eV)</label>
                                    <input
                                        type="number"
                                        step="any"
                                        value={qValue}
                                        onChange={(e) => {
                                            const next: [string, number][] = fissionQEntries.map(([n, q], i) =>
                                                i === index ? [n, parseFloat(e.target.value) || 0] : [n, q]
                                            );
                                            updateFissionQ(next);
                                        }}
                                    />
                                </div>
                                <div className="form-group row-delete">
                                    <label>&nbsp;</label>
                                    <button
                                        className="theia-button secondary small"
                                        onClick={() => updateFissionQ(fissionQEntries.filter((_, i) => i !== index))}
                                    >
                                        <i className="codicon codicon-trash"></i>
                                    </button>
                                </div>
                            </div>
                        ))}
                        <div className="form-group">
                            <button
                                className="theia-button secondary small"
                                onClick={() => updateFissionQ([...fissionQEntries, ['U235', 2.02e8]])}
                            >
                                <i className="codicon codicon-add"></i> Add Fission Q
                            </button>
                            <span className="form-hint">Overrides chain-file fission Q values for normalization</span>
                        </div>
                    </>
                )}

                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={depletion.diffBurnableMats ?? false}
                            onChange={(e) => host.stateManager.updateDepletion({ diffBurnableMats: e.target.checked })}
                        />
                        Distinguish burnable materials with identical compositions (diff_burnable_mats)
                    </label>
                    <div className="openmc-warning-box">
                        <i className="codicon codicon-warning"></i>
                        <div className="warning-content">
                            <strong>Higher memory and runtime cost</strong>
                            <p>Only enable when identical material compositions in different cells must deplete independently.</p>
                        </div>
                    </div>
                </div>
                {depletion.diffBurnableMats && (
                    <div className="form-group">
                        <label>Volume Assignment Method</label>
                        <NukeSelect
                            value={depletion.diffVolumeMethod ?? 'divide equally'}
                            options={[
                                { value: 'divide equally', label: 'Divide Equally (default)' },
                                { value: 'match cell', label: 'Match Cell' }
                            ]}
                            onChange={(value: string) =>
                                host.stateManager.updateDepletion({ diffVolumeMethod: value as 'divide equally' | 'match cell' })
                            }
                            ariaLabel="Volume assignment method"
                        />
                    </div>
                )}
            </div>
        );
    }

    /**
     * Render the list of depletable materials in the depletion tab.
     * @param state - Current OpenMC simulation state.
     * @returns Depletable materials React node.
     */
    private renderDepletableMaterialsSection(state: OpenMCState): React.ReactNode {
        const depletableMaterials = state.materials.filter((m) => m.isDepletable);

        return depletableMaterials.map((mat) => (
            <div key={mat.id} className="material-card" style={{ borderLeft: `4px solid ${mat.color || '#4A90D9'}` }}>
                <div className="material-card-header">
                    <div className="material-info">
                        <span className="material-id">#{mat.id}</span>
                        <span className="material-name">{mat.name}</span>
                    </div>
                    <i className="codicon codicon-check" style={{ color: 'var(--theia-focusBorder)', fontSize: '14px' }}></i>
                </div>
            </div>
        ));
    }
}
