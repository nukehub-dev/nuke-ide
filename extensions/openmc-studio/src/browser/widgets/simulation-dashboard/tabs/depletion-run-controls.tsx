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

/**
 * Advanced depletion run controls: CRAM substeps, reactivity (keff search)
 * control, external feed/removal rates, and continuation. Rendered inside the
 * Depletion tab's Advanced section; the common depletion form stays unchanged.
 *
 * @module openmc-studio/browser
 */

import * as React from '@theia/core/shared/react';
import { OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCExternalSourceRate, OpenMCReactivityControl, OpenMCState } from '../../../../common/openmc-state-schema';
import { OpenMCCompat } from '../../../../common/openmc-studio-protocol';
import {
    EXTERNAL_SOURCE_RATE_UNITS,
    getDepletionSubsteps,
    isReactivityControlEnabled,
    summarizeExternalSourceRates,
    validateDepletionAdvanced
} from '../../../../common/depletion-config';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';

/** Props for {@link DepletionRunControls}. */
export interface DepletionRunControlsProps {
    /** Dashboard host (state manager, update, file dialogs). */
    host: SimulationDashboardWidget;
    /** Current simulation state. */
    state: OpenMCState;
    /** Probed OpenMC compatibility (undefined while the probe is pending). */
    compat?: OpenMCCompat;
}

/**
 * Render the advanced depletion run controls.
 * @param props - Dashboard host, state, and compatibility.
 * @returns Advanced run-control React node.
 */
export const DepletionRunControls: React.FC<DepletionRunControlsProps> = ({ host, state, compat }) => {
    const depletion = state.depletion;
    if (!depletion) {
        return undefined;
    }

    const issues = validateDepletionAdvanced(state);
    const depletableMaterials = state.materials.filter((material) => material.isDepletable);
    const allMaterials = state.materials;
    const cells = state.geometry.cells;

    const fieldIssues = (field: string): React.ReactNode => {
        const matching = issues.filter((issue) => issue.field === field || issue.field.startsWith(`${field}.`));
        if (matching.length === 0) {
            return undefined;
        }
        return (
            <>
                {matching.map((issue, index) => (
                    <span key={index} className={`depletion-field-message ${issue.severity}`}>
                        <i className={`codicon ${issue.severity === 'error' ? 'codicon-error' : 'codicon-warning'}`}></i>
                        {issue.message} {issue.suggestion}
                    </span>
                ))}
            </>
        );
    };

    const control = depletion.reactivityControl;
    const controlEnabled = isReactivityControlEnabled(control);
    const selectedMaterial =
        control?.materialId !== undefined ? allMaterials.find((material) => material.id === control.materialId) : undefined;
    const nuclides = selectedMaterial?.nuclides.map((nuclide) => nuclide.name) ?? [];
    const substepsSupported = compat?.depletionSubsteps ?? true;
    const keffSupported = compat?.depletionKeffSearch ?? true;
    const externalRatesSupported = compat?.depletionExternalSourceRate ?? true;
    const continuationSupported = compat?.depletionContinuation ?? true;

    const updateControl = (updates: Partial<OpenMCReactivityControl>): void => {
        host.stateManager.updateReactivityControl(updates);
    };

    const setParameter = (parameter: OpenMCReactivityControl['parameter']): void => {
        const base: Partial<OpenMCReactivityControl> = { parameter };
        if (parameter === 'cell-translation') {
            base.cellId = control?.cellId ?? cells[0]?.id ?? 1;
            base.axis = control?.axis ?? 'z';
        } else {
            base.materialId = control?.materialId ?? allMaterials[0]?.id ?? 1;
            base.nuclide = control?.nuclide ?? allMaterials[0]?.nuclides[0]?.name ?? 'U235';
        }
        updateControl(base);
    };

    const updateExternalRate = (index: number, updates: Partial<OpenMCExternalSourceRate>): void => {
        host.stateManager.updateExternalSourceRate(index, updates);
    };

    const addExternalRate = (): void => {
        host.stateManager.addExternalSourceRate({
            material: depletableMaterials[0]?.id ?? allMaterials[0]?.id ?? 1,
            composition: [{ name: 'U235', weightPercent: 100 }],
            rate: -1e-6,
            units: 'g/s'
        });
    };

    const updateCompositionEntry = (
        index: number,
        entryIndex: number,
        updates: Partial<OpenMCExternalSourceRate['composition'][number]>
    ): void => {
        const rate = depletion.externalSourceRates?.[index];
        if (!rate) {
            return;
        }
        const composition = rate.composition.map((entry, i) => (i === entryIndex ? { ...entry, ...updates } : entry));
        updateExternalRate(index, { composition });
    };

    const addCompositionEntry = (index: number): void => {
        const rate = depletion.externalSourceRates?.[index];
        if (!rate) {
            return;
        }
        updateExternalRate(index, { composition: [...rate.composition, { name: 'U238', weightPercent: 0 }] });
    };

    const removeCompositionEntry = (index: number, entryIndex: number): void => {
        const rate = depletion.externalSourceRates?.[index];
        if (!rate) {
            return;
        }
        updateExternalRate(index, { composition: rate.composition.filter((_, i) => i !== entryIndex) });
    };

    const browsePreviousResults = async (): Promise<void> => {
        const props: OpenFileDialogProps = {
            title: 'Select Previous Depletion Results',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'HDF5 Results': ['h5', 'hdf5'],
                'All Files': ['*']
            }
        };
        const uri = await host.fileDialogService.showOpenDialog(props);
        if (uri) {
            host.stateManager.updateDepletion({ continueFromResults: uri.path.toString(), continueTimesteps: true });
        }
    };

    const rateTotals = summarizeExternalSourceRates(depletion.externalSourceRates);
    const rateUnitTotals = [
        ...Object.entries(rateTotals.feed).map(([units, value]) => `feed ${value} ${units}`),
        ...Object.entries(rateTotals.removal).map(([units, value]) => `removal ${value} ${units}`)
    ];

    return (
        <div className="depletion-run-controls">
            <p className="depletion-run-controls-intro">
                These controls run through the OpenMC Python API. The standalone <code>openmc</code> binary does not read them from
                settings.xml, so use OpenMC Studio to run a depletion case that uses them.
            </p>

            {/* Solver accuracy */}
            <div className="depletion-run-group">
                <h4>
                    <i className="codicon codicon-symbol-method"></i>
                    Solver accuracy
                    <Tooltip content="Substeps split each depletion interval into smaller CRAM solves." position="top">
                        <i className="codicon codicon-info info-icon"></i>
                    </Tooltip>
                </h4>
                <div className="form-row">
                    <div className="form-group">
                        <label htmlFor="depletion-substeps">CRAM substeps</label>
                        <input
                            id="depletion-substeps"
                            type="number"
                            min={1}
                            step={1}
                            value={getDepletionSubsteps(depletion)}
                            onChange={(event) =>
                                host.stateManager.updateDepletion({
                                    substeps: Math.max(1, Math.trunc(Number(event.target.value) || 1))
                                })
                            }
                        />
                        <span className="form-hint">
                            Subdivides each timestep; improves accuracy for short-lived nuclides. 1 disables subdivision.
                        </span>
                        {!substepsSupported && (
                            <span className="depletion-field-message warning">
                                <i className="codicon codicon-warning"></i>
                                Substeps require OpenMC 0.16 or newer in the selected environment.
                            </span>
                        )}
                        {fieldIssues('substeps')}
                    </div>
                </div>
            </div>

            {/* Reactivity control */}
            <div className="depletion-run-group">
                <h4>
                    <i className="codicon codicon-openmc-reactivity"></i>
                    Reactivity control
                    <Tooltip
                        content="Runs a keff search before each depletion step and moves the chosen parameter to hold a target keff."
                        position="top"
                    >
                        <i className="codicon codicon-info info-icon"></i>
                    </Tooltip>
                </h4>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={controlEnabled}
                            onChange={(event) => updateControl({ enabled: event.target.checked })}
                        />
                        Hold a target k-effective by adjusting a model parameter
                    </label>
                    <span className="form-hint">Off by default; a search at every depletion step is expensive.</span>
                    {!keffSupported && (
                        <span className="depletion-field-message warning">
                            <i className="codicon codicon-warning"></i>
                            Reactivity control requires OpenMC 0.16 or newer in the selected environment.
                        </span>
                    )}
                </div>

                {controlEnabled && (
                    <>
                        <div className="openmc-warning-box depletion-run-warning">
                            <i className="codicon codicon-warning"></i>
                            <div className="warning-content">
                                <strong>Search runs at each depletion step</strong>
                                <p>
                                    Every step adds transport solves while the search converges. Start with a narrow bracket and a modest
                                    maximum iteration count.
                                </p>
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Parameter type</label>
                                <NukeSelect
                                    value={control?.parameter ?? 'cell-translation'}
                                    options={[
                                        { value: 'cell-translation', label: 'Control-rod position' },
                                        { value: 'nuclide-density', label: 'Nuclide density' }
                                    ]}
                                    onChange={(value: string) => setParameter(value as OpenMCReactivityControl['parameter'])}
                                    ariaLabel="Reactivity control parameter type"
                                />
                                {fieldIssues('reactivityControl.parameter')}
                            </div>
                            {control?.parameter === 'nuclide-density' ? (
                                <>
                                    <div className="form-group">
                                        <label>Material</label>
                                        <NukeSelect
                                            value={String(control?.materialId ?? allMaterials[0]?.id ?? '')}
                                            options={allMaterials.map((material) => ({
                                                value: String(material.id),
                                                label: `#${material.id} ${material.name}`
                                            }))}
                                            onChange={(value: string) => updateControl({ materialId: parseInt(value) })}
                                            ariaLabel="Reactivity control material"
                                        />
                                        {fieldIssues('reactivityControl.materialId')}
                                    </div>
                                    <div className="form-group">
                                        <label>Nuclide</label>
                                        <input
                                            type="text"
                                            value={control?.nuclide ?? ''}
                                            placeholder="e.g. U235"
                                            onChange={(event) => updateControl({ nuclide: event.target.value })}
                                        />
                                        <span className="form-hint">
                                            Specific isotope (elements expand to isotopes at runtime).
                                            {nuclides.length > 0
                                                ? ` In material: ${nuclides.slice(0, 8).join(', ')}${nuclides.length > 8 ? '…' : ''}`
                                                : ''}
                                        </span>
                                        {fieldIssues('reactivityControl.nuclide')}
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div className="form-group">
                                        <label>Control-rod cell</label>
                                        {cells.length > 0 ? (
                                            <NukeSelect
                                                value={String(control?.cellId ?? cells[0]?.id ?? '')}
                                                options={cells.map((cell) => ({
                                                    value: String(cell.id),
                                                    label: `#${cell.id}${cell.name ? ` ${cell.name}` : ''}`
                                                }))}
                                                onChange={(value: string) => updateControl({ cellId: parseInt(value) })}
                                                ariaLabel="Reactivity control cell"
                                            />
                                        ) : (
                                            <input
                                                type="number"
                                                min={1}
                                                step={1}
                                                value={control?.cellId ?? ''}
                                                placeholder={state.settings.dagmcFile ? 'DAGMC volume ID' : 'Cell ID'}
                                                onChange={(event) => updateControl({ cellId: Math.trunc(Number(event.target.value) || 0) })}
                                            />
                                        )}
                                        <span className="form-hint">
                                            {state.settings.dagmcFile
                                                ? 'DAGMC volume ID; checked when the run starts.'
                                                : 'Cell translation is changed through openmc.lib during the search.'}
                                        </span>
                                        {fieldIssues('reactivityControl.cellId')}
                                    </div>
                                    <div className="form-group">
                                        <label>Translation axis</label>
                                        <NukeSelect
                                            value={control?.axis ?? 'z'}
                                            options={[
                                                { value: 'x', label: 'X' },
                                                { value: 'y', label: 'Y' },
                                                { value: 'z', label: 'Z' }
                                            ]}
                                            onChange={(value: string) => updateControl({ axis: value as OpenMCReactivityControl['axis'] })}
                                            ariaLabel="Reactivity control axis"
                                        />
                                        {fieldIssues('reactivityControl.axis')}
                                    </div>
                                </>
                            )}
                        </div>

                        <div className="form-row depletion-search-grid">
                            <div className="form-group">
                                <label>First guess (x0)</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={control?.x0 ?? 0}
                                    onChange={(event) => updateControl({ x0: Number(event.target.value) })}
                                />
                                {fieldIssues('reactivityControl.x0')}
                            </div>
                            <div className="form-group">
                                <label>Second guess (x1)</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={control?.x1 ?? 1}
                                    onChange={(event) => updateControl({ x1: Number(event.target.value) })}
                                />
                                {fieldIssues('reactivityControl.x1')}
                            </div>
                            <div className="form-group">
                                <label>Bracket min</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={control?.bracket?.[0] ?? -10}
                                    onChange={(event) =>
                                        updateControl({
                                            bracket: [Number(event.target.value), control?.bracket?.[1] ?? 10]
                                        })
                                    }
                                />
                            </div>
                            <div className="form-group">
                                <label>Bracket max</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={control?.bracket?.[1] ?? 10}
                                    onChange={(event) =>
                                        updateControl({
                                            bracket: [control?.bracket?.[0] ?? -10, Number(event.target.value)]
                                        })
                                    }
                                />
                                {fieldIssues('reactivityControl.bracket')}
                            </div>
                            <div className="form-group">
                                <label>Target keff</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={control?.targetKeff ?? 1.0}
                                    onChange={(event) => updateControl({ targetKeff: Number(event.target.value) })}
                                />
                                {fieldIssues('reactivityControl.targetKeff')}
                            </div>
                            <div className="form-group">
                                <label>k tolerance</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={control?.kTol ?? 1e-4}
                                    onChange={(event) => updateControl({ kTol: Number(event.target.value) })}
                                />
                                {fieldIssues('reactivityControl.kTol')}
                            </div>
                            <div className="form-group">
                                <label>Final sigma</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={control?.sigmaFinal ?? 3e-4}
                                    onChange={(event) => updateControl({ sigmaFinal: Number(event.target.value) })}
                                />
                                {fieldIssues('reactivityControl.sigmaFinal')}
                            </div>
                            <div className="form-group">
                                <label>Max iterations</label>
                                <input
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={control?.maxIterations ?? 50}
                                    onChange={(event) =>
                                        updateControl({
                                            maxIterations: Math.max(1, Math.trunc(Number(event.target.value) || 1))
                                        })
                                    }
                                />
                                {fieldIssues('reactivityControl.maxIterations')}
                            </div>
                            <div className="form-group">
                                <label>On non-convergence</label>
                                <NukeSelect
                                    value={control?.onFailure ?? 'fail'}
                                    options={[
                                        { value: 'fail', label: 'Stop the run' },
                                        { value: 'warn', label: 'Warn and continue' }
                                    ]}
                                    onChange={(value: string) =>
                                        updateControl({ onFailure: value as OpenMCReactivityControl['onFailure'] })
                                    }
                                    ariaLabel="Reactivity control failure behavior"
                                />
                                <span className="form-hint">“Warn” continues with the last searched value.</span>
                                {fieldIssues('reactivityControl.onFailure')}
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* External source rates */}
            <div className="depletion-run-group">
                <h4>
                    <i className="codicon codicon-openmc-feed"></i>
                    External feed / removal
                    <Tooltip content="Adds or removes material at a mass rate during depletion." position="top">
                        <i className="codicon codicon-info info-icon"></i>
                    </Tooltip>
                </h4>
                <p className="form-hint">
                    Positive rates feed material in; negative rates remove it. OpenMC normalizes the composition weights.
                </p>
                {!externalRatesSupported && (
                    <span className="depletion-field-message warning">
                        <i className="codicon codicon-warning"></i>
                        External source rates require OpenMC 0.15.3 or newer in the selected environment.
                    </span>
                )}
                {depletion.externalSourceRates && depletion.externalSourceRates.length > 0 ? (
                    <div className="depletion-rate-scroll">
                        <div className="depletion-rate-table">
                            {depletion.externalSourceRates.map((rate, index) => (
                                <div className="depletion-rate-row" key={index}>
                                    <div className="depletion-rate-cell">
                                        <label>Material</label>
                                        <NukeSelect
                                            value={String(rate.material)}
                                            options={depletableMaterials.map((material) => ({
                                                value: String(material.id),
                                                label: `#${material.id} ${material.name}`
                                            }))}
                                            onChange={(value: string) => updateExternalRate(index, { material: parseInt(value) })}
                                            ariaLabel={`External rate ${index + 1} material`}
                                        />
                                        {fieldIssues(`externalSourceRates.${index}.material`)}
                                    </div>
                                    <div className="depletion-rate-cell depletion-rate-composition">
                                        <label>Composition (weight %)</label>
                                        {rate.composition.map((entry, entryIndex) => (
                                            <div className="depletion-composition-row" key={entryIndex}>
                                                <input
                                                    type="text"
                                                    value={entry.name}
                                                    placeholder="Element / nuclide"
                                                    aria-label={`Rate ${index + 1} composition ${entryIndex + 1} name`}
                                                    onChange={(event) =>
                                                        updateCompositionEntry(index, entryIndex, { name: event.target.value })
                                                    }
                                                />
                                                <input
                                                    type="number"
                                                    step="any"
                                                    min={0}
                                                    value={entry.weightPercent}
                                                    aria-label={`Rate ${index + 1} composition ${entryIndex + 1} weight percent`}
                                                    onChange={(event) =>
                                                        updateCompositionEntry(index, entryIndex, {
                                                            weightPercent: Number(event.target.value)
                                                        })
                                                    }
                                                />
                                                <Tooltip content="Remove composition entry" position="top">
                                                    <button
                                                        className="theia-button secondary small"
                                                        aria-label={`Remove composition entry ${entryIndex + 1} from rate ${index + 1}`}
                                                        onClick={() => removeCompositionEntry(index, entryIndex)}
                                                    >
                                                        <i className="codicon codicon-close"></i>
                                                    </button>
                                                </Tooltip>
                                            </div>
                                        ))}
                                        <button className="theia-button secondary small" onClick={() => addCompositionEntry(index)}>
                                            <i className="codicon codicon-add"></i> Add entry
                                        </button>
                                        {fieldIssues(`externalSourceRates.${index}.composition`)}
                                    </div>
                                    <div className="depletion-rate-cell">
                                        <label>Rate</label>
                                        <input
                                            type="number"
                                            step="any"
                                            value={rate.rate}
                                            aria-label={`External rate ${index + 1} value`}
                                            onChange={(event) => updateExternalRate(index, { rate: Number(event.target.value) })}
                                        />
                                        <span className="form-hint">+ feeds, − removes</span>
                                        {fieldIssues(`externalSourceRates.${index}.rate`)}
                                    </div>
                                    <div className="depletion-rate-cell">
                                        <label>Units</label>
                                        <NukeSelect
                                            value={rate.units ?? 'g/s'}
                                            options={EXTERNAL_SOURCE_RATE_UNITS.map((units) => ({ value: units!, label: units! }))}
                                            onChange={(value: string) =>
                                                updateExternalRate(index, { units: value as OpenMCExternalSourceRate['units'] })
                                            }
                                            ariaLabel={`External rate ${index + 1} units`}
                                        />
                                        {fieldIssues(`externalSourceRates.${index}.units`)}
                                    </div>
                                    <div className="depletion-rate-cell">
                                        <label>Timesteps (optional)</label>
                                        <input
                                            type="text"
                                            value={(rate.timesteps ?? []).join(', ')}
                                            placeholder="All steps"
                                            aria-label={`External rate ${index + 1} timestep indices`}
                                            onChange={(event) => {
                                                const tokens = event.target.value
                                                    .split(',')
                                                    .map((token) => token.trim())
                                                    .filter((token) => token.length > 0);
                                                updateExternalRate(index, {
                                                    timesteps: tokens.length > 0 ? tokens.map(Number) : undefined
                                                });
                                            }}
                                        />
                                        <span className="form-hint">Zero-based indices; blank = every step.</span>
                                        {fieldIssues(`externalSourceRates.${index}.timesteps`)}
                                    </div>
                                    <div className="depletion-rate-cell depletion-rate-actions">
                                        <Tooltip content="Remove this feed/removal rate" position="top">
                                            <button
                                                className="theia-button secondary small"
                                                aria-label={`Remove external rate ${index + 1}`}
                                                onClick={() => host.stateManager.removeExternalSourceRate(index)}
                                            >
                                                <i className="codicon codicon-trash"></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div className="depletion-rate-empty">
                        <i className="codicon codicon-openmc-feed"></i>
                        <p>No external feeds or removals. Add one to model a continuous material feed or cleanup.</p>
                    </div>
                )}
                <div className="depletion-rate-footer">
                    <button className="theia-button secondary" disabled={depletableMaterials.length === 0} onClick={addExternalRate}>
                        <i className="codicon codicon-add"></i> Add feed/removal rate
                    </button>
                    {rateTotals.count > 0 && (
                        <span className="depletion-rate-total">
                            {rateUnitTotals.length > 0 ? rateUnitTotals.join(' · ') : 'No net feed or removal'}
                        </span>
                    )}
                </div>
                {depletableMaterials.length === 0 && (
                    <span className="form-hint">Mark at least one fuel material as depletable to add a rate.</span>
                )}
            </div>

            {/* Continuation */}
            <div className="depletion-run-group">
                <h4>
                    <i className="codicon codicon-history"></i>
                    Continuation
                    <Tooltip
                        content="Starts the operator from an earlier depletion results file instead of fresh compositions."
                        position="top"
                    >
                        <i className="codicon codicon-info info-icon"></i>
                    </Tooltip>
                </h4>
                <div className="form-row">
                    <div className="form-group depletion-continuation-file">
                        <label>Previous results file</label>
                        <div className="file-input-group">
                            <input
                                type="text"
                                value={depletion.continueFromResults ?? ''}
                                placeholder="depletion_results.h5..."
                                onChange={(event) =>
                                    host.stateManager.updateDepletion({
                                        continueFromResults: event.target.value || undefined
                                    })
                                }
                            />
                            <button className="theia-button secondary" onClick={browsePreviousResults}>
                                <i className="codicon codicon-folder-opened"></i> Browse
                            </button>
                        </div>
                        <span className="form-hint">The operator reads compositions and volumes from this file.</span>
                        {fieldIssues('continuation')}
                        {!continuationSupported && (
                            <span className="depletion-field-message warning">
                                <i className="codicon codicon-warning"></i>
                                Continuation requires OpenMC 0.15.1 or newer in the selected environment.
                            </span>
                        )}
                    </div>
                    <div className="form-group">
                        <label>Restart mode</label>
                        <div className="form-group checkbox">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={depletion.continueTimesteps ?? false}
                                    onChange={(event) =>
                                        host.stateManager.updateDepletion({
                                            continueTimesteps: event.target.checked
                                        })
                                    }
                                />
                                Continue the previous timesteps
                            </label>
                            <span className="form-hint">
                                The timestep schedule and power must start with the previous run’s values; only the new steps execute. Off =
                                append the configured steps to the previous results.
                            </span>
                        </div>
                    </div>
                </div>
                {depletion.continueFromResults && (
                    <span className="form-hint">
                        External-rate timestep indices refer to the steps this run executes; with continuation the first new step is index
                        0.
                    </span>
                )}
            </div>
        </div>
    );
};
