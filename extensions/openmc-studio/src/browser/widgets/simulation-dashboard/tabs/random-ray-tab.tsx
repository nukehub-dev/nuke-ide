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
import * as path from 'path';
import { injectable, inject } from '@theia/core/shared/inversify';
import { OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { PreferenceService } from '@theia/core/lib/common/preferences';
import { Tooltip, SearchableMultiSelect } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCRandomRaySettings, OpenMCRegularMesh } from '../../../../common/openmc-state-schema';
import { OpenMCCompat, MgConversionResult } from '../../../../common/openmc-studio-protocol';
import { MGXS_GROUP_STRUCTURES, computeMgConversion, computeMgRevert } from '../../../../common/mg-conversion';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';
import { calculateGeometryBounds } from './settings/geometry-bounds';

/**
 * Random ray tab of the simulation dashboard: multi-group energy mode, MGXS
 * library selection, and the `random_ray` solver configuration.
 */
@injectable()
export class RandomRayTabContribution implements DashboardTabContribution {
    readonly id = 'random-ray';
    readonly label = 'Random Ray';
    readonly icon = 'zap';
    readonly order = 5;

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    // Multi-group conversion UI state (P9B one-click CE ↔ MG)
    private mgConvertDir = '';
    private mgConvertDirInitialized = false;
    private mgConvertMethod: 'material_wise' | 'stochastic_slab' | 'infinite_medium' = 'material_wise';
    private mgConvertGroups = 'CASMO-2';
    private mgConvertParticles = 2000;
    private mgConvertBusy = false;
    private mgConvertResult?: MgConversionResult;
    private mgAppliedSummary = '';
    private mgApplyBusy = false;

    // Fixed-source domain-constraint helper state
    private sourceConstraintDomainType: 'material' | 'cell' | 'universe' = 'material';
    private sourceConstraintDomainIds: number[] = [];

    /**
     * Render the Multi-Group Conversion section: the one-click CE → MG
     * converter (with backup) or the MG → CE revert when a backup exists.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Conversion section React node, or undefined when not applicable.
     */
    private renderMgConversion(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const backup = state.metadata.mgBackup;
        const isMultiGroup = state.settings.energyMode === 'multigroup';
        const macroscopicNames = state.materials.filter((m) => m.macroscopic).map((m) => m.name);
        const result = this.mgConvertResult;

        // Seed the working directory from the persisted preference once
        if (!this.mgConvertDirInitialized) {
            this.mgConvertDirInitialized = true;
            this.mgConvertDir = this.mgConvertDir || this.preferenceService.get<string>('openmcStudio.lastMgxsWorkDir', '');
        }

        if (backup) {
            return (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-arrow-swap"></i> Multi-Group Conversion
                    </h3>
                    <div className="rr-actions-row">
                        <Tooltip content="Restore the pre-conversion nuclide materials and energy mode" position="bottom">
                            <button className="theia-button secondary" onClick={() => this.revertMgConversion(host)}>
                                <i className="codicon codicon-history"></i> Revert to Continuous-Energy
                            </button>
                        </Tooltip>
                    </div>
                    <span className="form-hint">
                        This project was converted to multi-group. Reverting restores the original nuclide materials and energy mode (the
                        MGXS library path is kept).
                    </span>
                </div>
            );
        }

        if (isMultiGroup) {
            const nonMacroscopicMaterials = state.materials.filter((m) => !m.macroscopic && m.nuclides && m.nuclides.length > 0);
            if (nonMacroscopicMaterials.length === 0) {
                return undefined;
            }
            return (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-arrow-swap"></i> Multi-Group Conversion
                    </h3>
                    <div className="depletion-warning-box">
                        <i className="codicon codicon-warning"></i>
                        <div className="warning-content">
                            <strong>Project is multi-group but materials are still nuclide-decomposed</strong>
                            <p>
                                {nonMacroscopicMaterials.length} material(s) need to be switched to macroscopic:{' '}
                                {nonMacroscopicMaterials.map((m) => m.name || `material ${m.id}`).join(', ')}.
                            </p>
                        </div>
                    </div>
                    {state.settings.mgxsLibrary ? (
                        <div className="rr-actions-row">
                            <button
                                className="theia-button primary"
                                disabled={this.mgApplyBusy}
                                onClick={() => this.applyExistingMgConversion(host)}
                            >
                                <i className="codicon codicon-check"></i>
                                {this.mgApplyBusy ? 'Applying…' : 'Apply MGXS Library'}
                            </button>
                        </div>
                    ) : (
                        <span className="form-hint">
                            No MGXS library is configured. Generate one with the MGXS Generator window first, then return here to apply it.
                        </span>
                    )}
                    {this.mgAppliedSummary && <span className="form-hint">{this.mgAppliedSummary}</span>}
                </div>
            );
        }

        return (
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-arrow-swap"></i> Multi-Group Conversion
                </h3>
                {macroscopicNames.length > 0 ? (
                    <span className="form-hint">
                        Conversion requires nuclide-decomposed materials; macroscopic materials present: {macroscopicNames.join(', ')}.
                    </span>
                ) : (
                    <>
                        <span className="form-hint">
                            CE detail is preserved in a backup — but save a CE project copy for depletion work.
                        </span>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Method</label>
                                <select
                                    value={this.mgConvertMethod}
                                    onChange={(e) => {
                                        this.mgConvertMethod = e.target.value as typeof this.mgConvertMethod;
                                        host.update();
                                    }}
                                >
                                    <option value="material_wise">Material Wise (highest fidelity)</option>
                                    <option value="stochastic_slab">Stochastic Slab</option>
                                    <option value="infinite_medium">Infinite Medium</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Group Structure</label>
                                <select
                                    value={this.mgConvertGroups}
                                    onChange={(e) => {
                                        this.mgConvertGroups = e.target.value;
                                        host.update();
                                    }}
                                >
                                    {MGXS_GROUP_STRUCTURES.map((g) => (
                                        <option key={g} value={g}>
                                            {g}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Particles</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={this.mgConvertParticles}
                                    onChange={(e) => {
                                        this.mgConvertParticles = parseInt(e.target.value) || 2000;
                                        host.update();
                                    }}
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Working Directory</label>
                                <div className="file-input-group">
                                    <input
                                        type="text"
                                        value={this.mgConvertDir}
                                        placeholder="Directory for the generated XML + mgxs.h5..."
                                        onChange={(e) => {
                                            this.mgConvertDir = e.target.value;
                                            host.update();
                                        }}
                                    />
                                    <button className="theia-button secondary" onClick={() => this.browseMgConvertDir(host)}>
                                        <i className="codicon codicon-folder-opened"></i> Browse
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="rr-actions-row">
                            <button
                                className="theia-button primary"
                                disabled={this.mgConvertBusy || this.mgConvertDir.trim() === ''}
                                onClick={() => this.runMgConversion(host)}
                            >
                                <i className="codicon codicon-play"></i>
                                {this.mgConvertBusy ? 'Converting…' : 'Run Conversion'}
                            </button>
                            {result?.success && (
                                <button className="theia-button primary" onClick={() => this.applyMgConversion(host)}>
                                    <i className="codicon codicon-check"></i> Apply Conversion ({result.xsDataNames?.length ?? 0} materials)
                                </button>
                            )}
                        </div>
                        {result &&
                            (result.success ? (
                                <span className="form-hint">
                                    Library written to {result.mgxsPath} — {result.xsDataNames?.length ?? 0} material(s) have an XS data
                                    set. Apply to switch them to macroscopic and enter multi-group mode.
                                </span>
                            ) : (
                                <div className="depletion-warning-box">
                                    <i className="codicon codicon-error"></i>
                                    <div className="warning-content">
                                        <strong>Conversion failed</strong>
                                        <p>{result.error}</p>
                                    </div>
                                </div>
                            ))}
                        {this.mgAppliedSummary && <span className="form-hint">{this.mgAppliedSummary}</span>}
                    </>
                )}
            </div>
        );
    }

    /**
     * Browse for the conversion working directory.
     * @param host - Simulation dashboard widget host.
     */
    private async browseMgConvertDir(host: SimulationDashboardWidget): Promise<void> {
        const uri = await host.fileDialogService.showOpenDialog({
            title: 'Select Conversion Working Directory',
            canSelectFiles: false,
            canSelectFolders: true
        });
        if (uri) {
            this.mgConvertDir = uri.path.toString();
            host.update();
        }
    }

    /**
     * Generate the project XML into the working directory and run the
     * conversion driver (MGXS generation + material mapping).
     * @param host - Simulation dashboard widget host.
     */
    private async runMgConversion(host: SimulationDashboardWidget): Promise<void> {
        this.mgConvertBusy = true;
        this.mgConvertResult = undefined;
        this.mgAppliedSummary = '';
        // Persist the last-used working directory across sessions
        void this.preferenceService.set('openmcStudio.lastMgxsWorkDir', this.mgConvertDir);
        host.update();
        try {
            const backend = host.studioService.getBackendService();
            const state = host.stateManager.getState();
            const xml = await host.xmlService.generateXML({
                state,
                outputDirectory: this.mgConvertDir,
                files: {
                    geometry: true,
                    materials: true,
                    settings: true,
                    tallies: state.tallies.length > 0,
                    plots: false
                }
            });
            if (!xml.success) {
                this.mgConvertResult = { success: false, error: `XML generation failed: ${xml.error}` };
                return;
            }
            this.mgConvertResult = await backend.convertToMultigroupProject({
                workingDirectory: this.mgConvertDir,
                method: this.mgConvertMethod,
                groups: this.mgConvertGroups,
                particles: this.mgConvertParticles,
                output: 'mgxs.h5'
            });
        } catch (error) {
            this.mgConvertResult = { success: false, error: String(error) };
        } finally {
            this.mgConvertBusy = false;
            host.update();
        }
    }

    /**
     * Apply a successful conversion: macroscopic materials for every mapped
     * material, multi-group mode + library path, and the CE backup stash.
     * @param host - Simulation dashboard widget host.
     */
    private applyMgConversion(host: SimulationDashboardWidget): void {
        const result = this.mgConvertResult;
        if (!result?.success || !result.mgxsPath) {
            return;
        }
        const state = host.stateManager.getState();
        const updates = computeMgConversion(state, result.xsDataNames ?? [], result.mgxsPath);
        for (const material of updates.materials) {
            host.stateManager.updateMaterial(material.id, material);
        }
        host.stateManager.updateSettings(updates.settings);
        host.stateManager.updateMetadata({ mgBackup: updates.mgBackup });
        this.mgAppliedSummary = `Converted ${updates.convertedNames.length} material(s) to macroscopic (${updates.convertedNames.join(', ')}). Library: ${result.mgxsPath}`;
        this.mgConvertResult = undefined;
        host.update();
    }

    /**
     * Apply an existing MGXS library to a project that is already marked
     * multi-group but still has nuclide-decomposed materials. Reads the library's
     * XS data set names and switches the matching materials to macroscopic.
     * @param host - Simulation dashboard widget host.
     */
    private async applyExistingMgConversion(host: SimulationDashboardWidget): Promise<void> {
        this.mgApplyBusy = true;
        this.mgAppliedSummary = '';
        host.update();
        try {
            const state = host.stateManager.getState();
            const rawMgxsPath = state.settings.mgxsLibrary;
            if (!rawMgxsPath) {
                this.mgAppliedSummary = 'No MGXS library path is configured.';
                return;
            }
            const projectPath = host.stateManager.projectPath;
            const projectDir = projectPath ? path.dirname(projectPath) : undefined;
            const mgxsPath = path.isAbsolute(rawMgxsPath) || !projectDir ? rawMgxsPath : path.join(projectDir, rawMgxsPath);

            const backend = host.studioService.getBackendService();
            const result = await backend.getMgxsDataNames(mgxsPath);
            if (!result.success) {
                this.mgAppliedSummary = result.error || 'Failed to read MGXS library';
                return;
            }
            const updates = computeMgConversion(state, result.xsDataNames ?? [], mgxsPath);
            for (const material of updates.materials) {
                host.stateManager.updateMaterial(material.id, material);
            }
            host.stateManager.updateSettings(updates.settings);
            host.stateManager.updateMetadata({ mgBackup: updates.mgBackup });
            this.mgAppliedSummary = `Converted ${updates.convertedNames.length} material(s) to macroscopic (${updates.convertedNames.join(', ')}). Library: ${mgxsPath}`;
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.mgAppliedSummary = `Failed to apply MGXS library: ${msg}`;
        } finally {
            this.mgApplyBusy = false;
            host.update();
        }
    }

    /**
     * Revert to continuous-energy: restore the backed-up materials and energy
     * mode, keep the MGXS library path, clear the backup.
     * @param host - Simulation dashboard widget host.
     */
    private revertMgConversion(host: SimulationDashboardWidget): void {
        const state = host.stateManager.getState();
        const updates = computeMgRevert(state);
        if (!updates) {
            return;
        }
        for (const material of updates.materials) {
            host.stateManager.updateMaterial(material.id, material);
        }
        host.stateManager.updateSettings({ energyMode: updates.energyMode });
        host.stateManager.updateMetadata({ mgBackup: undefined });
        this.mgAppliedSummary = '';
        host.update();
    }

    /** Probed OpenMC compatibility for feature gating (fetched once). */
    private compat?: OpenMCCompat;
    private compatRequested = false;

    /**
     * Fetch the OpenMC compatibility descriptor once and re-render when it
     * arrives (gates the s2 sample method on envs that reject it).
     * @param host - Simulation dashboard widget host.
     */
    private requestCompat(host: SimulationDashboardWidget): void {
        if (this.compatRequested) {
            return;
        }
        this.compatRequested = true;
        void host.studioService.getOpenMCCompat().then((compat) => {
            this.compat = compat;
            host.update();
        });
    }

    /**
     * Apply a domain constraint to every independent source in fixed-source mode.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     */
    private applySourceDomainConstraint(host: SimulationDashboardWidget, state: OpenMCState): void {
        const domainIds = this.sourceConstraintDomainIds;
        if (domainIds.length === 0) {
            host.messageService.warn('Select at least one domain ID');
            return;
        }
        const settings = host.stateManager.getState().settings;
        const newSources = settings.sources.map((source) => {
            if ((source as any).spatial === undefined) {
                return source;
            }
            return {
                ...source,
                constraints: {
                    ...source.constraints,
                    domainType: this.sourceConstraintDomainType,
                    domainIds
                }
            };
        });
        host.stateManager.updateSettings({ sources: newSources });
        host.messageService.info(
            `Constrained ${newSources.length} source(s) to ${this.sourceConstraintDomainType} ID(s) ${domainIds.join(', ')}`
        );
        host.update();
    }

    /**
     * Render the fixed-source domain-constraint helper. Only shown when random
     * ray is enabled and the run mode is fixed source.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns React node for the constraint helper, or undefined.
     */
    private renderFixedSourceConstraints(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const settings = state.settings;
        if (settings.run.mode !== 'fixed source' || !settings.randomRay) {
            return undefined;
        }

        const independentSources = settings.sources.filter((s) => (s as any).spatial !== undefined);
        if (independentSources.length === 0) {
            return (
                <div className="depletion-warning-box">
                    <i className="codicon codicon-warning"></i>
                    <div className="warning-content">
                        <strong>No independent sources defined</strong>
                        <p>Fixed-source random ray needs at least one independent source. Add one in the Sources tab.</p>
                    </div>
                </div>
            );
        }

        const unconstrained = independentSources.filter((s) => {
            const spatial = (s as any).spatial;
            const isPoint = spatial?.type === 'point';
            const hasDomain = s.constraints?.domainType && s.constraints.domainIds && s.constraints.domainIds.length > 0;
            return !isPoint && !hasDomain;
        });

        const materialOptions = state.materials.map((m) => ({ id: m.id, label: `${m.name} (id ${m.id})` }));
        const cellOptions = [
            ...state.geometry.cells.map((c) => ({ id: c.id, label: `${c.name ?? 'Cell'} ${c.id}` })),
            ...(settings.dagmcInfo?.volumes ?? []).map((v) => ({ id: v.id, label: `${v.material} volume ${v.id}` }))
        ];
        const universeOptions = state.geometry.universes.map((u) => ({ id: u.id, label: `${u.name ?? 'Universe'} ${u.id}` }));

        const currentOptions =
            this.sourceConstraintDomainType === 'material'
                ? materialOptions
                : this.sourceConstraintDomainType === 'cell'
                  ? cellOptions
                  : universeOptions;

        const hasSelection = this.sourceConstraintDomainIds.length > 0;

        return (
            <div className="settings-section">
                <h4>
                    <i className="codicon codicon-lock"></i> Fixed-Source Domain Constraint
                </h4>
                {unconstrained.length > 0 && (
                    <div className="depletion-warning-box">
                        <i className="codicon codicon-warning"></i>
                        <div className="warning-content">
                            <strong>{unconstrained.length} source(s) must be constrained</strong>
                            <p>
                                Fixed-source random ray requires every source to be a point source or constrained to a cell, material, or
                                universe domain. Unconstrained sources will raise a validation error.
                            </p>
                        </div>
                    </div>
                )}
                <ul className="source-list">
                    {independentSources.map((s, i) => {
                        const spatial = (s as any).spatial;
                        const isPoint = spatial?.type === 'point';
                        const hasDomain = s.constraints?.domainType && s.constraints.domainIds && s.constraints.domainIds.length > 0;
                        const status = isPoint
                            ? 'point source'
                            : hasDomain
                              ? `constrained to ${s.constraints!.domainType} ${s.constraints!.domainIds!.join(', ')}`
                              : 'unconstrained';
                        return (
                            <li key={i} className={isPoint || hasDomain ? 'ok' : 'warn'}>
                                <i className={`codicon codicon-${isPoint || hasDomain ? 'check' : 'warning'}`}></i>
                                Source {i + 1}: {status}
                            </li>
                        );
                    })}
                </ul>
                <div className="form-row">
                    <div className="form-group">
                        <label>Domain Type</label>
                        <select
                            value={this.sourceConstraintDomainType}
                            onChange={(e) => {
                                this.sourceConstraintDomainType = e.target.value as 'material' | 'cell' | 'universe';
                                this.sourceConstraintDomainIds = [];
                                host.update();
                            }}
                        >
                            <option value="material">Material</option>
                            <option value="cell">Cell / DAGMC Volume</option>
                            <option value="universe">Universe</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Domain IDs</label>
                        <SearchableMultiSelect
                            options={currentOptions}
                            selectedIds={this.sourceConstraintDomainIds}
                            onChange={(ids) => {
                                this.sourceConstraintDomainIds = ids as number[];
                                host.update();
                            }}
                            searchPlaceholder={`Search ${this.sourceConstraintDomainType}…`}
                            emptyMessage={`No ${this.sourceConstraintDomainType}s match`}
                            maxHeight={160}
                        />
                        <span className="form-hint">
                            {this.sourceConstraintDomainType === 'material'
                                ? 'Constrain source sites to a material (e.g., the plasma/fuel material)'
                                : this.sourceConstraintDomainType === 'cell'
                                  ? 'Constrain source sites to a CSG cell or DAGMC volume'
                                  : 'Constrain source sites to a universe'}
                        </span>
                    </div>
                </div>
                <div className="rr-actions-row">
                    <Tooltip content="Apply the domain constraint to every independent source" position="bottom">
                        <button className="theia-button primary small" onClick={() => this.applySourceDomainConstraint(host, state)}>
                            <i className="codicon codicon-check"></i> Apply to All Sources
                        </button>
                    </Tooltip>
                    {this.sourceConstraintDomainType === 'material' && hasSelection && (
                        <Tooltip
                            content="Auto-fill the fuel/source material (lowest density, or name suggesting fuel/plasma/fissile)"
                            position="bottom"
                        >
                            <button
                                className="theia-button secondary small"
                                onClick={() => {
                                    const fuel = this.guessFuelMaterial(state);
                                    if (fuel) {
                                        this.sourceConstraintDomainIds = [fuel.id];
                                        host.update();
                                    } else {
                                        host.messageService.warn('No fuel-like material found');
                                    }
                                }}
                            >
                                <i className="codicon codicon-lightbulb"></i> Guess Fuel
                            </button>
                        </Tooltip>
                    )}
                </div>
                <span className="form-hint">
                    Domain constraints tell OpenMC to reject source sites outside the chosen domain. Constrain to the fuel/source material
                    or volume so neutrons are born in the right region.
                </span>
            </div>
        );
    }

    /**
     * Heuristic: pick the material most likely to be the fuel/source region.
     * Prefers names suggesting fuel/plasma/fissile material, then falls back to
     * the lowest-density material.
     * @param state - Current OpenMC simulation state.
     * @returns The guessed material, or undefined.
     */
    private guessFuelMaterial(state: OpenMCState): { id: number; name: string } | undefined {
        const nameHint =
            /fuel|plasma|u235|u-235|uranium|plutonium|pu239|pu-239|enriched|fissile|tritium|deuterium|dt|d-t|li6|li-6|breeder/i;
        const byName = state.materials.find((m) => nameHint.test(m.name));
        if (byName) {
            return { id: byName.id, name: byName.name };
        }
        const sorted = [...state.materials].sort((a, b) => a.density - b.density);
        return sorted.length > 0 ? { id: sorted[0].id, name: sorted[0].name } : undefined;
    }

    /**
     * Render the Random Ray tab.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Random ray tab React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const settings = state.settings;
        const randomRay = settings.randomRay;
        const isMultiGroup = settings.energyMode === 'multigroup';
        const regularMeshes = state.meshes.filter((m) => m.type === 'regular') as OpenMCRegularMesh[];
        this.requestCompat(host);
        const s2Unsupported = this.compat !== undefined && !this.compat.s2SampleMethod;

        const updateRandomRay = (updates: Partial<OpenMCRandomRaySettings>): void => {
            const merged = { ...(randomRay ?? {}), ...updates };
            const hasContent = Object.values(merged).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
            host.stateManager.updateSettings({ randomRay: hasContent ? merged : undefined });
        };

        return (
            <div className="random-ray-tab">
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-symbol-misc"></i> Energy Mode
                    </h3>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Energy Treatment</label>
                            <select
                                value={settings.energyMode ?? 'continuous-energy'}
                                onChange={(e) =>
                                    host.stateManager.updateSettings({
                                        energyMode: e.target.value as 'continuous-energy' | 'multigroup'
                                    })
                                }
                            >
                                <option value="continuous-energy">Continuous Energy</option>
                                <option value="multigroup">Multi-Group</option>
                            </select>
                        </div>
                    </div>
                    {isMultiGroup && (
                        <div className="depletion-warning-box">
                            <i className="codicon codicon-warning"></i>
                            <div className="warning-content">
                                <strong>Multi-group mode affects the whole model</strong>
                                <p>
                                    Requires an MGXS library and (typically) macroscopic materials. Tally scores and results are reported
                                    per energy group. Use the MGXS Generator window to produce a library from the current model.
                                </p>
                            </div>
                        </div>
                    )}
                    {isMultiGroup && (
                        <div className="form-row">
                            <div className="form-group">
                                <label>MGXS Library (mgxs.h5)</label>
                                <input
                                    type="text"
                                    value={settings.mgxsLibrary ?? randomRay?.mgxsLibraryPath ?? ''}
                                    placeholder="Path to mgxs.h5"
                                    onChange={(e) =>
                                        // Migrates the legacy randomRay.mgxsLibraryPath to the
                                        // canonical settings.mgxsLibrary on first edit (legacy kept)
                                        host.stateManager.updateSettings({ mgxsLibrary: e.target.value || undefined })
                                    }
                                />
                                <span className="form-hint">Required for multi-group runs (OPENMC_MG_CROSS_SECTIONS)</span>
                            </div>
                            <div className="form-group">
                                <label>&nbsp;</label>
                                <div className="rr-actions-row">
                                    <Tooltip content="Select an MGXS library file" position="bottom">
                                        <button className="theia-button secondary" onClick={() => this.browseMgxsLibrary(host)}>
                                            <i className="codicon codicon-folder-opened"></i> Browse
                                        </button>
                                    </Tooltip>
                                    <Tooltip content="Generate an MGXS library from the current model" position="bottom">
                                        <button className="theia-button secondary" onClick={() => host.openMgxsGeneratorWindow()}>
                                            <i className="codicon codicon-library"></i> Generate…
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {this.renderMgConversion(host, state)}

                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-zap"></i> Random Ray Solver
                        <span className="optional-badge">{randomRay ? 'Enabled' : 'Disabled'}</span>
                    </h3>
                    <div className="form-group checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={randomRay !== undefined}
                                disabled={!isMultiGroup}
                                onChange={(e) => {
                                    if (e.target.checked) {
                                        const bounds = calculateGeometryBounds(state);
                                        host.stateManager.updateSettings({
                                            randomRay: {
                                                distanceInactive: 50,
                                                distanceActive: 250,
                                                raySource: bounds
                                                    ? {
                                                          lowerLeft: bounds.min as [number, number, number],
                                                          upperRight: bounds.max as [number, number, number]
                                                      }
                                                    : undefined
                                            }
                                        });
                                    } else {
                                        host.stateManager.updateSettings({ randomRay: undefined });
                                    }
                                }}
                            />
                            Enable random ray solver
                        </label>
                        {!isMultiGroup && <span className="form-hint">Random ray requires multi-group energy mode.</span>}
                    </div>

                    {randomRay && (
                        <>
                            {this.renderFixedSourceConstraints(host, state)}

                            <div className="form-row">
                                <div className="form-group">
                                    <label>Inactive Distance (cm)</label>
                                    <input
                                        type="number"
                                        min={0}
                                        step="any"
                                        value={randomRay.distanceInactive ?? 0}
                                        onChange={(e) => updateRandomRay({ distanceInactive: parseFloat(e.target.value) || 0 })}
                                    />
                                    <span className="form-hint">Dead-zone distance at the start of each ray</span>
                                </div>
                                <div className="form-group">
                                    <label>Active Distance (cm)</label>
                                    <input
                                        type="number"
                                        min={0}
                                        step="any"
                                        value={randomRay.distanceActive ?? 0}
                                        onChange={(e) => updateRandomRay({ distanceActive: parseFloat(e.target.value) || 0 })}
                                    />
                                    <span className="form-hint">Active (scored) ray distance</span>
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Source Shape</label>
                                    <select
                                        value={randomRay.sourceShape ?? 'flat'}
                                        onChange={(e) =>
                                            updateRandomRay({ sourceShape: e.target.value as 'flat' | 'linear' | 'linear_xy' })
                                        }
                                    >
                                        <option value="flat">Flat (default)</option>
                                        <option value="linear">Linear</option>
                                        <option value="linear_xy">Linear XY</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label>Sample Method</label>
                                    <select
                                        value={randomRay.sampleMethod ?? 'prng'}
                                        onChange={(e) => updateRandomRay({ sampleMethod: e.target.value as 'prng' | 'halton' | 's2' })}
                                    >
                                        <option value="prng">PRNG (default)</option>
                                        <option value="halton">Halton</option>
                                        <option value="s2" disabled={s2Unsupported}>
                                            S2{s2Unsupported ? ' (not supported by the configured OpenMC)' : ''}
                                        </option>
                                    </select>
                                    {s2Unsupported && randomRay.sampleMethod === 's2' && (
                                        <span className="form-hint">
                                            s2 is not supported by the configured OpenMC — 'halton' will be written to settings.xml instead.
                                        </span>
                                    )}
                                </div>
                                <div className="form-group">
                                    <label>Volume Estimator</label>
                                    <select
                                        value={randomRay.volumeEstimator ?? 'hybrid'}
                                        onChange={(e) =>
                                            updateRandomRay({
                                                volumeEstimator: e.target.value as 'naive' | 'simulation_averaged' | 'hybrid'
                                            })
                                        }
                                    >
                                        <option value="hybrid">Hybrid (default)</option>
                                        <option value="naive">Naive</option>
                                        <option value="simulation_averaged">Simulation Averaged</option>
                                    </select>
                                </div>
                            </div>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Diagonal Stabilization ρ</label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={1}
                                        step="any"
                                        value={randomRay.diagonalStabilizationRho ?? 0}
                                        onChange={(e) => updateRandomRay({ diagonalStabilizationRho: parseFloat(e.target.value) || 0 })}
                                    />
                                    <span className="form-hint">0 disables diagonal stabilization</span>
                                </div>
                            </div>
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={randomRay.volumeNormalizedFluxTallies ?? false}
                                        onChange={(e) => updateRandomRay({ volumeNormalizedFluxTallies: e.target.checked })}
                                    />
                                    Volume-normalized flux tallies
                                </label>
                                <span className="form-hint">
                                    Report flux tallies in units of cm/cm³ (normalized per source-region volume)
                                </span>
                            </div>
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={randomRay.adjoint ?? false}
                                        onChange={(e) => updateRandomRay({ adjoint: e.target.checked })}
                                    />
                                    Adjoint flux mode
                                </label>
                                <span className="form-hint">
                                    Runs a forward then an adjoint solve — used by FW-CADIS weight window generation (see the Variance
                                    Reduction tab)
                                </span>
                            </div>

                            <h4>
                                <i className="codicon codicon-target"></i> Ray Source (Uniform Box)
                            </h4>
                            <div className="rr-actions-row">
                                <Tooltip content="Set the ray source box from the current geometry bounds" position="bottom">
                                    <button
                                        className="theia-button secondary small"
                                        onClick={() => {
                                            const bounds = calculateGeometryBounds(state);
                                            if (bounds) {
                                                updateRandomRay({
                                                    raySource: {
                                                        lowerLeft: bounds.min as [number, number, number],
                                                        upperRight: bounds.max as [number, number, number]
                                                    }
                                                });
                                            } else {
                                                host.messageService.warn('Cannot auto-detect bounds: no geometry defined');
                                            }
                                        }}
                                    >
                                        <i className="codicon codicon-target"></i> Auto-detect from Geometry
                                    </button>
                                </Tooltip>
                            </div>
                            {this.renderVectorInput('Lower Left', randomRay.raySource?.lowerLeft ?? [0, 0, 0], (v) =>
                                updateRandomRay({ raySource: { ...(randomRay.raySource ?? { upperRight: [10, 10, 10] }), lowerLeft: v } })
                            )}
                            {this.renderVectorInput('Upper Right', randomRay.raySource?.upperRight ?? [10, 10, 10], (v) =>
                                updateRandomRay({ raySource: { ...(randomRay.raySource ?? { lowerLeft: [0, 0, 0] }), upperRight: v } })
                            )}

                            <h4>
                                <i className="codicon codicon-target"></i> Adjoint Source (Uniform Box)
                            </h4>
                            <div className="rr-actions-row">
                                <Tooltip
                                    content="Set the adjoint source (detector response) box from the current geometry bounds"
                                    position="bottom"
                                >
                                    <button
                                        className="theia-button secondary small"
                                        onClick={() => {
                                            const bounds = calculateGeometryBounds(state);
                                            if (bounds) {
                                                updateRandomRay({
                                                    adjointSource: {
                                                        lowerLeft: bounds.min as [number, number, number],
                                                        upperRight: bounds.max as [number, number, number]
                                                    }
                                                });
                                            } else {
                                                host.messageService.warn('Cannot auto-detect bounds: no geometry defined');
                                            }
                                        }}
                                    >
                                        <i className="codicon codicon-target"></i> Auto-detect from Geometry
                                    </button>
                                </Tooltip>
                                <Tooltip content="Clear the adjoint source" position="bottom">
                                    <button
                                        className="theia-button secondary small"
                                        disabled={!randomRay.adjointSource}
                                        onClick={() => updateRandomRay({ adjointSource: undefined })}
                                    >
                                        <i className="codicon codicon-close"></i> Clear
                                    </button>
                                </Tooltip>
                            </div>
                            {this.renderVectorInput('Lower Left', randomRay.adjointSource?.lowerLeft ?? [0, 0, 0], (v) =>
                                updateRandomRay({
                                    adjointSource: { ...(randomRay.adjointSource ?? { upperRight: [10, 10, 10] }), lowerLeft: v }
                                })
                            )}
                            {this.renderVectorInput('Upper Right', randomRay.adjointSource?.upperRight ?? [10, 10, 10], (v) =>
                                updateRandomRay({
                                    adjointSource: { ...(randomRay.adjointSource ?? { lowerLeft: [0, 0, 0] }), upperRight: v }
                                })
                            )}
                            <span className="form-hint">
                                Localized adjoint source / detector response function (FW-CADIS adjoint solve)
                            </span>

                            <h4>
                                <i className="codicon codicon-symbol-grid"></i> Source Region
                            </h4>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Source Region Mesh</label>
                                    <select
                                        value={randomRay.sourceRegionMeshId ?? ''}
                                        onChange={(e) =>
                                            updateRandomRay({
                                                sourceRegionMeshId: e.target.value ? parseInt(e.target.value) : undefined
                                            })
                                        }
                                    >
                                        <option value="">None</option>
                                        {regularMeshes.map((mesh) => (
                                            <option key={mesh.id} value={mesh.id}>
                                                {mesh.name || `Mesh ${mesh.id}`}
                                            </option>
                                        ))}
                                    </select>
                                    <span className="form-hint">Regular meshes are created in the Tally Configurator</span>
                                </div>
                                {randomRay.sourceRegionMeshId !== undefined && (
                                    <>
                                        <div className="form-group">
                                            <label>Domain Type</label>
                                            <select
                                                value={randomRay.sourceRegionDomainType ?? 'cell'}
                                                onChange={(e) =>
                                                    updateRandomRay({
                                                        sourceRegionDomainType: e.target.value as 'cell' | 'material' | 'universe'
                                                    })
                                                }
                                            >
                                                <option value="cell">Cells</option>
                                                <option value="material">Materials</option>
                                                <option value="universe">Universes</option>
                                            </select>
                                        </div>
                                        <div className="form-group">
                                            <label>Domain IDs</label>
                                            <input
                                                type="text"
                                                value={(randomRay.sourceRegionDomainIds ?? []).join(' ')}
                                                placeholder="e.g. 1 2 3"
                                                onChange={(e) => {
                                                    const parsed = e.target.value
                                                        .split(/\s+/)
                                                        .map((v) => parseInt(v, 10))
                                                        .filter((v) => !isNaN(v));
                                                    updateRandomRay({ sourceRegionDomainIds: parsed });
                                                }}
                                            />
                                        </div>
                                    </>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        );
    }

    /**
     * Render a 3-vector input row.
     * @param label - Row label.
     * @param vector - Current vector value.
     * @param onChange - Change handler.
     * @returns Vector input row React node.
     */
    private renderVectorInput(
        label: string,
        vector: [number, number, number],
        onChange: (v: [number, number, number]) => void
    ): React.ReactNode {
        return (
            <div className="form-row">
                {([0, 1, 2] as const).map((i) => (
                    <div className="form-group" key={i}>
                        <label>
                            {label} {'XYZ'[i]}
                        </label>
                        <input
                            type="number"
                            step="any"
                            value={vector[i]}
                            onChange={(e) => {
                                const next = [...vector] as [number, number, number];
                                next[i] = parseFloat(e.target.value) || 0;
                                onChange(next);
                            }}
                        />
                    </div>
                ))}
            </div>
        );
    }

    /**
     * Open a file dialog to select an MGXS library file.
     * @param host - Simulation dashboard widget host.
     */
    private async browseMgxsLibrary(host: SimulationDashboardWidget): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select MGXS Library File',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'MGXS Library': ['h5'],
                'All Files': ['*']
            }
        };
        const uri = await host.fileDialogService.showOpenDialog(props);
        if (uri) {
            host.stateManager.updateSettings({ mgxsLibrary: uri.path.toString() });
        }
    }
}
