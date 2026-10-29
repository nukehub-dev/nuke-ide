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
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import {
    DepletionDoseQuantity,
    DepletionPlotType,
    DepletionScaleType,
    DepletionXAxis,
    OpenMCDepletionContactDoseResult,
    OpenMCDepletionDecaySpectrumResult,
    OpenMCDepletionMaterial,
    OpenMCDepletionNuclideData,
    OpenMCDepletionSummary,
    DEPLETION_NUCLIDE_PRESETS,
    DepletionNuclidePreset
} from '../../../../../common/openmc-protocol';
import { NukeEmptyState, NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { PlotlyComponent } from '../../../../plotly/plotly-component';
import { OpenMCService } from '../../openmc-service';
import URI from '@theia/core/lib/common/uri';
import {
    DEPLETION_PLOT_OPTIONS,
    buildContactDoseChart,
    buildDecaySpectrumChart,
    contactDoseHasSignal,
    contactDoseNuclideRows,
    contactDoseToCsv,
    decaySpectrumToCsv,
    defaultScaleForPlot,
    doseQuantityForPlot,
    formatActivityBq,
    formatCompact,
    formatDoseRate,
    isContactDosePlot,
    isSpectrumPlot,
    stepLabel
} from './depletion-analysis';
import './openmc-depletion-widget.css';

const CHECKBOX_STYLE: React.CSSProperties = {
    width: '14px',
    height: '14px',
    margin: 0,
    flexShrink: 0,
    accentColor: 'var(--theia-focusBorder)'
};

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
    private scaleType: DepletionScaleType = 'linear';
    private xAxisType: DepletionXAxis = 'burnup';
    private selectedNuclides: Set<string> = new Set();
    private showActivityNuclides: boolean = false;

    // Contact dose / decay spectrum
    private buildUp: number = 2.0;
    private byNuclide: boolean = false;
    private spectrumStepIndex: number = -1;
    private contactDose: OpenMCDepletionContactDoseResult | null = null;
    private spectrum: OpenMCDepletionDecaySpectrumResult | null = null;
    private analysisLoading: boolean = false;
    private analysisError: string | null = null;
    private readonly contactDoseCache = new Map<string, OpenMCDepletionContactDoseResult>();
    private readonly spectrumCache = new Map<string, OpenMCDepletionDecaySpectrumResult>();

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
        this.selectedMaterialIndex = -1; // Will be set after loading materials
        this.selectedNuclides.clear();
        this.contactDoseCache.clear();
        this.spectrumCache.clear();
        this.contactDose = null;
        this.spectrum = null;
        this.analysisError = null;
        this.spectrumStepIndex = -1;
        this.loadData();
    }

    /** Burnup is optional and may be present as an empty array in old results. */
    private hasBurnup(): boolean {
        return Array.isArray(this.summary?.burnup) && this.summary.burnup.length > 0;
    }

    private async loadData(): Promise<void> {
        if (!this.fileUri) return;

        this.isLoading = true;
        this.errorMessage = null;
        this.update();

        try {
            // Load summary
            this.summary = await this.openmcService.getDepletionSummary(this.fileUri);

            // Burnup is optional in depletion results; show the actual plotted axis instead of a disabled selection.
            if (!this.hasBurnup() && this.xAxisType === 'burnup') {
                this.xAxisType = 'time';
            }

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
        this.contactDose = null;
        this.spectrum = null;
        this.analysisError = null;
        this.contactDoseCache.clear();
        this.spectrumCache.clear();
        this.spectrumStepIndex = -1;
        this.update();

        try {
            const response = await this.openmcService.getDepletionData(
                this.fileUri,
                materialIndex,
                undefined // Load all nuclides
            );

            if (response.materialData) {
                this.nuclideData = response.materialData.nuclides;
                this.activityData = response.materialData.activity || null;

                // Auto-select important nuclides if none selected
                if (this.selectedNuclides.size === 0 && this.nuclideData.length > 0) {
                    const importantNuclides = ['U235', 'U238', 'Pu239', 'Pu240', 'Pu241', 'Xe135', 'Sm149'];
                    for (const nuc of importantNuclides) {
                        if (this.nuclideData.some((n) => n.nuclide === nuc)) {
                            this.selectedNuclides.add(nuc);
                        }
                    }
                    // If still none selected, pick first 5
                    if (this.selectedNuclides.size === 0) {
                        this.nuclideData.slice(0, 5).forEach((n) => this.selectedNuclides.add(n.nuclide));
                    }
                }
            }
        } catch (error) {
            this.errorMessage = error instanceof Error ? error.message : String(error);
        } finally {
            this.isLoading = false;
            this.update();
            await this.loadAnalysisForCurrentPlot();
        }
    }

    /** Default step for the decay spectrum: the final depletion state. */
    private defaultSpectrumStep(): number {
        return Math.max(0, (this.summary?.nSteps ?? 1) - 1);
    }

    private selectPlotType(plotType: DepletionPlotType): void {
        this.plotType = plotType;
        this.scaleType = defaultScaleForPlot(plotType);
        if (isSpectrumPlot(plotType) && (this.spectrumStepIndex < 0 || this.spectrumStepIndex >= (this.summary?.nSteps ?? 0))) {
            this.spectrumStepIndex = this.defaultSpectrumStep();
        }
        this.update();
        void this.loadAnalysisForCurrentPlot();
    }

    private currentDoseQuantity(): DepletionDoseQuantity {
        return doseQuantityForPlot(this.plotType);
    }

    private contactDoseCacheKey(): string {
        return `${this.selectedMaterialIndex}|${this.currentDoseQuantity()}|${this.buildUp}|${this.byNuclide}`;
    }

    private spectrumCacheKey(): string {
        return `${this.selectedMaterialIndex}|${this.spectrumStepIndex}`;
    }

    private async loadAnalysisForCurrentPlot(): Promise<void> {
        if (isContactDosePlot(this.plotType)) {
            await this.loadContactDose();
        } else if (isSpectrumPlot(this.plotType)) {
            await this.loadSpectrum();
        }
    }

    private async loadContactDose(): Promise<void> {
        if (!this.fileUri || !isContactDosePlot(this.plotType)) {
            return;
        }
        const key = this.contactDoseCacheKey();
        const cached = this.contactDoseCache.get(key);
        if (cached) {
            this.contactDose = cached;
            this.analysisError = null;
            this.update();
            return;
        }
        this.analysisLoading = true;
        this.analysisError = null;
        this.update();
        try {
            this.contactDose = await this.openmcService.getDepletionContactDose(
                this.fileUri,
                this.selectedMaterialIndex,
                this.currentDoseQuantity(),
                this.buildUp,
                this.byNuclide
            );
            this.contactDoseCache.set(key, this.contactDose);
        } catch (error) {
            this.analysisError = error instanceof Error ? error.message : String(error);
        } finally {
            this.analysisLoading = false;
            this.update();
        }
    }

    private async loadSpectrum(): Promise<void> {
        if (!this.fileUri || !isSpectrumPlot(this.plotType)) {
            return;
        }
        const key = this.spectrumCacheKey();
        const cached = this.spectrumCache.get(key);
        if (cached) {
            this.spectrum = cached;
            this.analysisError = null;
            this.update();
            return;
        }
        this.analysisLoading = true;
        this.analysisError = null;
        this.update();
        try {
            this.spectrum = await this.openmcService.getDepletionDecaySpectrum(
                this.fileUri,
                this.selectedMaterialIndex,
                this.spectrumStepIndex
            );
            this.spectrumCache.set(key, this.spectrum);
        } catch (error) {
            this.analysisError = error instanceof Error ? error.message : String(error);
        } finally {
            this.analysisLoading = false;
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
            <div className="openmc-depletion-viewer">
                {this.renderHeader()}
                <div className="depletion-body">
                    {this.renderSidebar()}
                    <div className="depletion-plot-pane">
                        {this.isLoading ? (
                            <div className="depletion-loading">
                                <i className={`${codicon('loading')} codicon-modifier-spin`}></i>
                                Loading depletion data…
                            </div>
                        ) : (
                            <>
                                {this.renderChartToolbar()}
                                {this.renderPlot()}
                            </>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    private renderHeader(): React.ReactNode {
        return (
            <div className="depletion-header">
                <div className="depletion-title">
                    <i className={codicon('flame')}></i>
                    <span>Depletion: {this.fileName}</span>
                </div>
                {this.summary && (
                    <div className="depletion-summary-line">
                        <span>{this.summary.nMaterials} materials</span>
                        <span>{this.summary.nSteps} time steps</span>
                        <span>{this.summary.nNuclides} nuclides</span>
                    </div>
                )}
            </div>
        );
    }

    private renderSidebar(): React.ReactNode {
        return (
            <div className="depletion-sidebar">
                <div className="depletion-sidebar-section">
                    <label className="depletion-sidebar-label">Material</label>
                    <NukeSelect
                        ariaLabel="Material"
                        value={this.selectedMaterialIndex >= 0 ? String(this.selectedMaterialIndex) : ''}
                        options={
                            this.materials.length === 0
                                ? [{ value: '', label: this.isLoading ? 'Loading materials…' : 'No materials found' }]
                                : this.materials.map((mat) => ({ value: String(mat.index), label: `${mat.name} (Mat ${mat.index})` }))
                        }
                        onChange={(value) => {
                            this.selectedMaterialIndex = parseInt(value, 10);
                            this.selectedNuclides.clear();
                            this.loadMaterialData(this.selectedMaterialIndex);
                        }}
                        disabled={this.isLoading}
                        style={{ width: '100%' }}
                    />
                </div>

                {this.renderSidebarContext()}
            </div>
        );
    }

    private renderSidebarContext(): React.ReactNode {
        if (isContactDosePlot(this.plotType) || isSpectrumPlot(this.plotType)) {
            return (
                <div className="depletion-sidebar-section depletion-analysis-note">
                    <i className={codicon('beaker')}></i>
                    <p>
                        {isContactDosePlot(this.plotType)
                            ? 'Contact dose is computed from the activated material with OpenMC’s decay-photon contact-dose model.'
                            : 'Decay photons are read from the chain file and combined per nuclide at the selected step.'}
                    </p>
                </div>
            );
        }

        if (this.plotType === 'activity' || this.plotType === 'decay_heat') {
            return (
                <div className="depletion-sidebar-section depletion-analysis-note">
                    <i className={codicon('info')}></i>
                    <p>
                        {this.plotType === 'activity'
                            ? 'Activity shows the total radioactivity from all nuclides in the material. Individual nuclide selection does not affect the total.'
                            : 'Decay heat shows the total heat generation from radioactive decay of all nuclides. Individual nuclide selection does not affect the total.'}
                    </p>
                    <label className="depletion-checkbox-row">
                        <input
                            type="checkbox"
                            checked={this.showActivityNuclides}
                            style={CHECKBOX_STYLE}
                            onChange={(e) => {
                                this.showActivityNuclides = e.target.checked;
                                this.update();
                            }}
                        />
                        <span>Show individual nuclide contributions</span>
                    </label>
                    {this.showActivityNuclides && this.activityData && (
                        <div style={{ marginTop: 12 }}>{this.renderActivityNuclideList()}</div>
                    )}
                </div>
            );
        }

        return (
            <>
                <div className="depletion-sidebar-section">
                    <label className="depletion-sidebar-label">Quick select (click to toggle)</label>
                    <div className="depletion-preset-grid">
                        {DEPLETION_NUCLIDE_PRESETS.map((preset: DepletionNuclidePreset) => {
                            const availableNucs = preset.nuclides.filter((nuc) => this.nuclideData.some((n) => n.nuclide === nuc));
                            const isActive = availableNucs.length > 0 && availableNucs.every((nuc) => this.selectedNuclides.has(nuc));
                            return (
                                <Tooltip key={preset.id} content={preset.description} position="top">
                                    <button
                                        className={`depletion-preset ${isActive ? 'active' : ''}`}
                                        onClick={() => this.applyPreset(preset)}
                                    >
                                        {isActive ? '✓ ' : ''}
                                        {preset.label}
                                    </button>
                                </Tooltip>
                            );
                        })}
                    </div>
                </div>

                <div className="depletion-nuclide-panel">
                    <div className="depletion-sidebar-section">
                        <label className="depletion-sidebar-label">Nuclides ({this.selectedNuclides.size} selected)</label>
                        <input
                            type="text"
                            className="depletion-search"
                            placeholder="Search nuclides…"
                            value={this.searchFilter}
                            onChange={(e) => {
                                this.searchFilter = e.target.value;
                                this.update();
                            }}
                        />
                    </div>
                    <div className="depletion-nuclide-list">{this.renderNuclideList()}</div>
                </div>
            </>
        );
    }

    private renderChartToolbar(): React.ReactNode {
        const contactDose = isContactDosePlot(this.plotType);
        const spectrum = isSpectrumPlot(this.plotType);
        return (
            <div className="depletion-chart-toolbar" role="toolbar" aria-label="Depletion chart controls">
                <div className="depletion-toolbar-group depletion-toolbar-plot">
                    <span className="depletion-toolbar-label">Plot</span>
                    <NukeSelect
                        ariaLabel="Plot type"
                        value={this.plotType}
                        options={DEPLETION_PLOT_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                        onChange={(value) => this.selectPlotType(value as DepletionPlotType)}
                        style={{ minWidth: 230 }}
                    />
                </div>

                {!spectrum && (
                    <div className="depletion-toolbar-group">
                        <span className="depletion-toolbar-label">X-axis</span>
                        <NukeSelect
                            ariaLabel="X axis"
                            value={this.xAxisType}
                            options={[
                                {
                                    value: 'burnup',
                                    label: this.hasBurnup() ? 'Burnup (MWd/kg)' : 'Burnup (MWd/kg) — unavailable',
                                    disabled: !this.hasBurnup()
                                },
                                { value: 'time', label: 'Time (days)' },
                                { value: 'step', label: 'Time step' }
                            ]}
                            onChange={(value) => {
                                this.xAxisType = value as DepletionXAxis;
                                this.update();
                            }}
                            style={{ minWidth: 150 }}
                        />
                    </div>
                )}

                {spectrum && (
                    <div className="depletion-toolbar-group">
                        <span className="depletion-toolbar-label">Step</span>
                        <NukeSelect
                            ariaLabel="Decay spectrum time step"
                            value={String(this.spectrumStepIndex)}
                            options={Array.from({ length: this.summary?.nSteps ?? 0 }, (_, index) => ({
                                value: String(index),
                                label: stepLabel(this.summary?.timeDays[index], index)
                            }))}
                            onChange={(value) => {
                                this.spectrumStepIndex = parseInt(value, 10);
                                this.spectrum = null;
                                this.analysisError = null;
                                this.update();
                                void this.loadSpectrum();
                            }}
                            style={{ minWidth: 150 }}
                        />
                    </div>
                )}

                <div className="depletion-toolbar-group">
                    <label className="depletion-checkbox-row depletion-scale-toggle">
                        <input
                            type="checkbox"
                            checked={this.scaleType === 'log'}
                            style={CHECKBOX_STYLE}
                            onChange={(e) => {
                                this.scaleType = e.target.checked ? 'log' : 'linear';
                                this.update();
                            }}
                        />
                        Log scale
                    </label>
                </div>

                {contactDose && (
                    <>
                        <div className="depletion-toolbar-group">
                            <Tooltip
                                content="Photon build-up factor applied to the slab contact-dose approximation (FISPACT-II default 2.0)."
                                position="top"
                            >
                                <span className="depletion-toolbar-label">Build-up</span>
                            </Tooltip>
                            <input
                                className="depletion-number-input"
                                type="number"
                                min="0.01"
                                step="0.1"
                                aria-label="Build-up factor"
                                value={this.buildUp}
                                onChange={(e) => {
                                    const value = parseFloat(e.target.value);
                                    if (Number.isFinite(value) && value > 0) {
                                        this.buildUp = value;
                                    }
                                }}
                                onBlur={() => void this.loadContactDose()}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        void this.loadContactDose();
                                    }
                                }}
                            />
                        </div>
                        <div className="depletion-toolbar-group">
                            <label className="depletion-checkbox-row">
                                <input
                                    type="checkbox"
                                    checked={this.byNuclide}
                                    style={CHECKBOX_STYLE}
                                    onChange={(e) => {
                                        this.byNuclide = e.target.checked;
                                        this.update();
                                        void this.loadContactDose();
                                    }}
                                />
                                By nuclide
                            </label>
                        </div>
                    </>
                )}

                {spectrum && (
                    <div className="depletion-toolbar-group depletion-toolbar-actions">
                        <button
                            className="theia-button secondary"
                            disabled={!this.spectrum || (this.spectrum.lines.length === 0 && this.spectrum.curves.length === 0)}
                            onClick={() => this.exportSpectrumCsv()}
                        >
                            <i className={codicon('export')}></i>
                            Export CSV
                        </button>
                    </div>
                )}
            </div>
        );
    }

    private renderNuclideList(): React.ReactNode {
        const filteredNuclides = this.nuclideData.filter((n) => {
            if (!this.searchFilter) return true;
            return n.nuclide.toLowerCase().includes(this.searchFilter.toLowerCase());
        });

        const sortedNuclides = [...filteredNuclides].sort((a, b) => {
            const aSelected = this.selectedNuclides.has(a.nuclide);
            const bSelected = this.selectedNuclides.has(b.nuclide);
            if (aSelected && !bSelected) return -1;
            if (!aSelected && bSelected) return 1;
            return a.nuclide.localeCompare(b.nuclide);
        });

        const displayNuclides = this.showAllNuclides ? sortedNuclides : sortedNuclides.slice(0, 20);

        return (
            <div>
                {displayNuclides.map((nuclide) => (
                    <label key={nuclide.nuclide} className="depletion-nuclide-row">
                        <input
                            type="checkbox"
                            checked={this.selectedNuclides.has(nuclide.nuclide)}
                            style={CHECKBOX_STYLE}
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
                        className="depletion-show-more"
                        onClick={() => {
                            this.showAllNuclides = true;
                            this.update();
                        }}
                    >
                        Show {sortedNuclides.length - 20} more…
                    </button>
                )}
            </div>
        );
    }

    private renderActivityNuclideList(): React.ReactNode {
        if (!this.activityData || !this.activityData.nuclides) {
            return <div className="depletion-muted">No activity data available</div>;
        }

        const sortedNuclides = [...this.activityData.nuclides].sort((a: any, b: any) => {
            const aVal =
                this.plotType === 'activity' ? a.activityCi?.[a.activityCi.length - 1] || 0 : a.decayHeat?.[a.decayHeat.length - 1] || 0;
            const bVal =
                this.plotType === 'activity' ? b.activityCi?.[b.activityCi.length - 1] || 0 : b.decayHeat?.[b.decayHeat.length - 1] || 0;
            return bVal - aVal;
        });
        const topNuclides = sortedNuclides.slice(0, 15);
        const unit = this.plotType === 'activity' ? 'Ci' : 'W';

        return (
            <div className="depletion-activity-list">
                {topNuclides.map((nuc: any, idx: number) => {
                    const value =
                        this.plotType === 'activity'
                            ? nuc.activityCi?.[nuc.activityCi.length - 1] || 0
                            : nuc.decayHeat?.[nuc.decayHeat.length - 1] || 0;
                    return (
                        <div key={nuc.nuclide} className="depletion-activity-row">
                            <span>
                                {idx + 1}. {nuc.nuclide}
                            </span>
                            <span className="depletion-muted">
                                {formatCompact(value)} {unit}
                            </span>
                        </div>
                    );
                })}
                {sortedNuclides.length > 15 && (
                    <div className="depletion-muted depletion-center">… and {sortedNuclides.length - 15} more nuclides</div>
                )}
            </div>
        );
    }

    private applyPreset(preset: DepletionNuclidePreset): void {
        const availableNucs = preset.nuclides.filter((nuc) => this.nuclideData.some((n) => n.nuclide === nuc));
        if (availableNucs.length === 0) return;
        const allSelected = availableNucs.every((nuc) => this.selectedNuclides.has(nuc));
        if (allSelected) {
            for (const nuc of availableNucs) {
                this.selectedNuclides.delete(nuc);
            }
        } else {
            for (const nuc of availableNucs) {
                this.selectedNuclides.add(nuc);
            }
        }
        this.update();
    }

    private renderPlot(): React.ReactNode {
        if (isContactDosePlot(this.plotType)) {
            return this.renderContactDose();
        }
        if (isSpectrumPlot(this.plotType)) {
            return this.renderSpectrum();
        }

        if (!this.summary || this.selectedNuclides.size === 0) {
            return (
                <div className="depletion-plot-empty">
                    {this.selectedNuclides.size === 0 ? 'Select nuclides to plot' : 'No data available'}
                </div>
            );
        }

        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#3c3c3c');

        let xValues: number[];
        let xLabel: string;
        switch (this.xAxisType) {
            case 'time':
                xValues = this.summary.timeDays;
                xLabel = 'Time (days)';
                break;
            case 'burnup':
                xValues = this.summary.burnup && this.summary.burnup.length > 0 ? this.summary.burnup : this.summary.timeDays;
                xLabel = this.hasBurnup() ? 'Burnup (MWd/kg)' : 'Time (days)';
                break;
            case 'step':
            default:
                xValues = Array.from({ length: this.summary.nSteps }, (_, i) => i);
                xLabel = 'Time step';
        }

        const traces: any[] = [];
        const colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
        let colorIndex = 0;

        if ((this.plotType === 'activity' || this.plotType === 'decay_heat') && this.activityData) {
            const totalValues = this.plotType === 'activity' ? this.activityData.totalActivityCi : this.activityData.totalDecayHeat;
            traces.push({
                x: xValues,
                y: totalValues,
                type: 'scatter',
                mode: 'lines+markers',
                name: this.plotType === 'activity' ? 'Total activity' : 'Total decay heat',
                line: { color: '#d62728', width: 3 },
                marker: { size: 8 }
            });

            if (this.showActivityNuclides && this.activityData.nuclides) {
                for (const nucActivity of this.activityData.nuclides) {
                    const values = this.plotType === 'activity' ? nucActivity.activityCi : nucActivity.decayHeat;
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
            const selectedNuclideData: { name: string; values: number[]; percentages: number[] }[] = [];
            const totalPerStep: number[] = new Array(this.summary.nSteps).fill(0);

            for (const nuclideName of this.selectedNuclides) {
                const nuclide = this.nuclideData.find((n) => n.nuclide === nuclideName);
                if (!nuclide) continue;
                const values = nuclide.concentrations;
                selectedNuclideData.push({ name: nuclideName, values, percentages: [] });
                for (let i = 0; i < this.summary.nSteps; i++) {
                    totalPerStep[i] += values[i];
                }
            }

            for (const nucData of selectedNuclideData) {
                nucData.percentages = nucData.values.map((v, i) => {
                    const total = totalPerStep[i];
                    return total > 0 ? (v / total) * 100 : 0;
                });
            }

            selectedNuclideData.sort((a, b) => b.percentages[b.percentages.length - 1] - a.percentages[a.percentages.length - 1]);

            const stackedColors = [
                '#1f77b4',
                '#ff7f0e',
                '#2ca02c',
                '#d62728',
                '#9467bd',
                '#8c564b',
                '#e377c2',
                '#7f7f7f',
                '#bcbd22',
                '#17becf',
                '#aec7e8',
                '#ffbb78',
                '#98df8a',
                '#ff9896',
                '#c5b0d5',
                '#c49c94',
                '#f7b6d2',
                '#c7c7c7',
                '#dbdb8d',
                '#9edae5',
                '#393b79',
                '#637939',
                '#8c6d31',
                '#843c39',
                '#7b4173'
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
            for (const nuclideName of this.selectedNuclides) {
                const nuclide = this.nuclideData.find((n) => n.nuclide === nuclideName);
                if (!nuclide) continue;

                let yValues: number[];
                switch (this.plotType) {
                    case 'mass':
                        yValues = nuclide.massGrams || nuclide.concentrations;
                        break;
                    case 'normalized': {
                        const initial = nuclide.concentrations[0] || 1;
                        yValues = nuclide.concentrations.map((c) => (c / initial) * 100);
                        break;
                    }
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
            margin: { t: 24, r: 24, b: 50, l: 70 },
            legend: { font: { color: fgColor }, bgcolor: bgColor },
            hovermode: 'closest'
        };

        return (
            <div className="depletion-chart">
                <PlotlyComponent
                    data={traces}
                    layout={layout}
                    config={{ responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] }}
                />
            </div>
        );
    }

    private renderAnalysisState(title: string, message: string, hint?: string): React.ReactNode {
        return (
            <div className="depletion-analysis-empty">
                <NukeEmptyState icon="warning" title={title} message={message} hint={hint} />
            </div>
        );
    }

    private renderContactDose(): React.ReactNode {
        if (this.analysisLoading) {
            return (
                <div className="depletion-loading">
                    <i className={`${codicon('loading')} codicon-modifier-spin`}></i>
                    Computing contact dose rate…
                </div>
            );
        }
        if (this.analysisError) {
            return this.renderAnalysisState(
                'Contact dose unavailable',
                this.analysisError,
                'Contact dose needs a depletion chain with decay-photon data. Set OPENMC_CHAIN_FILE or point OpenMC at a chain file, then retry.'
            );
        }
        if (!this.contactDose || !contactDoseHasSignal(this.contactDose)) {
            return this.renderAnalysisState(
                'No unstable nuclides with decay-photon data',
                this.contactDose?.emptyReason ?? 'This material has no non-zero contact dose contribution at any depletion state.',
                'Check that the depletion chain includes photon source data and that the material contains unstable nuclides.'
            );
        }

        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#3c3c3c');
        const chart = buildContactDoseChart(this.contactDose, this.summary, this.xAxisType);
        const layout: any = {
            xaxis: {
                title: { text: chart.xLabel, font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                type: 'linear'
            },
            yaxis: {
                title: { text: chart.yLabel, font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                type: this.scaleType
            },
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { t: 24, r: 24, b: 50, l: 76 },
            legend: { font: { color: fgColor }, bgcolor: bgColor },
            hovermode: 'closest'
        };

        const rows = this.byNuclide ? contactDoseNuclideRows(this.contactDose) : [];
        return (
            <div className="depletion-analysis-pane">
                <div className="depletion-analysis-summary">
                    <div className="depletion-summary-card">
                        <span>Final dose rate</span>
                        <strong>
                            {formatDoseRate(this.contactDose.total[this.contactDose.total.length - 1] ?? 0, this.contactDose.unit)}
                        </strong>
                    </div>
                    <div className="depletion-summary-card">
                        <span>Build-up factor</span>
                        <strong>{formatCompact(this.contactDose.buildUp)}</strong>
                    </div>
                    <div className="depletion-summary-card">
                        <span>Contributing nuclides</span>
                        <strong>{this.contactDose.contributingNuclides}</strong>
                    </div>
                </div>
                <div className="depletion-chart">
                    <PlotlyComponent
                        data={chart.traces}
                        layout={layout}
                        config={{ responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] }}
                    />
                </div>
                <p className="depletion-caveat">
                    {this.contactDose.caveat ??
                        'Contact dose is a slab approximation with a build-up factor; it does not include Bremsstrahlung.'}
                </p>
                {this.byNuclide && (
                    <div className="depletion-table-card">
                        <div className="depletion-table-header">
                            <span>By nuclide (final state)</span>
                            <button
                                className="theia-button secondary"
                                disabled={!this.contactDose.byNuclide?.length}
                                onClick={() => this.exportContactDoseCsv()}
                            >
                                <i className={codicon('export')}></i>
                                CSV
                            </button>
                        </div>
                        <div className="depletion-table-scroll">
                            <table className="depletion-table">
                                <thead>
                                    <tr>
                                        <th>Nuclide</th>
                                        <th className="numeric">Final ({this.contactDose.unit})</th>
                                        <th className="numeric">Max ({this.contactDose.unit})</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((row) => (
                                        <tr key={row.nuclide}>
                                            <td>{row.nuclide}</td>
                                            <td className="numeric">{formatCompact(row.final)}</td>
                                            <td className="numeric">{formatCompact(row.max)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    private renderSpectrum(): React.ReactNode {
        if (this.analysisLoading) {
            return (
                <div className="depletion-loading">
                    <i className={`${codicon('loading')} codicon-modifier-spin`}></i>
                    Building decay spectrum…
                </div>
            );
        }
        if (this.analysisError) {
            return this.renderAnalysisState(
                'Decay spectrum unavailable',
                this.analysisError,
                'Decay photons need a depletion chain with photon source data. Set OPENMC_CHAIN_FILE or point OpenMC at a chain file, then retry.'
            );
        }
        if (!this.spectrum || (this.spectrum.lines.length === 0 && this.spectrum.curves.length === 0)) {
            return this.renderAnalysisState(
                'No decay photons at this step',
                this.spectrum?.emptyReason ?? 'No decay-photon lines were found for this material and time step.',
                'Try another step, or check that the depletion chain includes photon source data.'
            );
        }

        const bgColor = this.getCssColor('--theia-editor-background', '#1e1e1e');
        const fgColor = this.getCssColor('--theia-foreground', '#cccccc');
        const gridColor = this.getCssColor('--theia-panel-border', '#3c3c3c');
        const chart = buildDecaySpectrumChart(this.spectrum);
        const layout: any = {
            xaxis: {
                title: { text: 'Photon energy (MeV)', font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                type: 'log'
            },
            yaxis: {
                title: { text: chart.yLabel, font: { color: fgColor } },
                tickfont: { color: fgColor },
                gridcolor: gridColor,
                type: this.scaleType
            },
            paper_bgcolor: bgColor,
            plot_bgcolor: bgColor,
            margin: { t: 24, r: 24, b: 50, l: 80 },
            legend: { font: { color: fgColor }, bgcolor: bgColor },
            hovermode: 'closest'
        };

        return (
            <div className="depletion-analysis-pane">
                <div className="depletion-analysis-summary">
                    <div className="depletion-summary-card">
                        <span>Total activity</span>
                        <strong>{formatActivityBq(this.spectrum.totalActivityBq)}</strong>
                    </div>
                    <div className="depletion-summary-card">
                        <span>Decay-photon intensity</span>
                        <strong>{formatActivityBq(this.spectrum.totalPhotonIntensityBq)}</strong>
                    </div>
                    <div className="depletion-summary-card">
                        <span>Lines / components</span>
                        <strong>
                            {this.spectrum.lines.length} / {this.spectrum.curves.length}
                        </strong>
                    </div>
                </div>
                <div className="depletion-chart">
                    <PlotlyComponent
                        data={chart.traces}
                        layout={layout}
                        config={{ responsive: true, displayModeBar: true, modeBarButtonsToRemove: ['lasso2d', 'select2d'] }}
                    />
                </div>
                <p className="depletion-caveat">
                    Discrete lines are photon emission rates at fixed energies; continuous components are spectral densities per eV. Total
                    activity is the material activity at step {this.spectrum.timeIndex} ({formatCompact(this.spectrum.timeDays)} d).
                </p>
            </div>
        );
    }

    private exportSpectrumCsv(): void {
        if (!this.spectrum) return;
        const csv = decaySpectrumToCsv(this.spectrum);
        const base = this.fileName.replace(/\.h5$/i, '');
        this.downloadText(`${base}.decay-spectrum.step${this.spectrum.timeIndex}.csv`, csv);
    }

    private exportContactDoseCsv(): void {
        if (!this.contactDose?.byNuclide?.length) return;
        const csv = contactDoseToCsv(this.contactDose);
        const base = this.fileName.replace(/\.h5$/i, '');
        this.downloadText(`${base}.contact-dose.${this.contactDose.doseQuantity}.csv`, csv);
    }

    private downloadText(filename: string, text: string): void {
        const blob = new Blob([text], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    private getYAxisLabel(): string {
        switch (this.plotType) {
            case 'mass':
                return 'Mass (g)';
            case 'normalized':
                return 'Relative to initial (%)';
            case 'stacked':
                return 'Composition (%)';
            case 'activity':
                return 'Activity (Ci)';
            case 'decay_heat':
                return 'Decay heat (W)';
            case 'contact_dose_air':
                return 'Contact dose rate (Gy/h)';
            case 'contact_dose_effective':
                return 'Contact dose rate (Sv/h)';
            case 'concentration':
            default:
                return 'Concentration (atoms/barn-cm)';
        }
    }

    private renderEmpty(): React.ReactNode {
        return (
            <div className="openmc-depletion-viewer depletion-viewer--empty">
                <NukeEmptyState
                    icon="flame"
                    title="No depletion file selected"
                    message="Open a depletion_results.h5 file to inspect nuclide concentrations, activity, decay heat, contact dose, and decay spectra."
                />
            </div>
        );
    }

    private renderError(): React.ReactNode {
        return (
            <div className="openmc-depletion-viewer depletion-viewer--empty">
                <NukeEmptyState
                    icon="error"
                    title="Could not read depletion results"
                    message={this.errorMessage ?? 'Unknown error'}
                    hint="Check that the file is an OpenMC depletion_results.h5 and that the configured Python environment has h5py and OpenMC."
                />
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
