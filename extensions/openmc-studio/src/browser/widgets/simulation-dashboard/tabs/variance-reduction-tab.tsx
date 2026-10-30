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
import { NukeSelect, Tooltip as NukeTooltip } from 'nuke-essentials/lib/theme/browser/components';
import { injectable } from '@theia/core/shared/inversify';
import { OpenFileDialogProps, SaveFileDialogProps } from '@theia/filesystem/lib/browser';
import { OpenMCState, OpenMCWeightWindows } from '../../../../common/openmc-state-schema';
import { NEUTRON_PARTICLE } from '../../../../common/particle-types';
import { nextWeightWindowId } from '../../../../common/variance-reduction';
import { ParticleTypeSelector } from '../../shared/particle-type-selector';
import { WeightWindowEditor } from '../vr';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';

/**
 * Variance reduction tab of the simulation dashboard: survival biasing, weight windows and source biasing.
 */
@injectable()
export class VarianceReductionTabContribution implements DashboardTabContribution {
    readonly id = 'variance-reduction';
    readonly label = 'Variance Reduction';
    readonly icon = 'openmc-variance';
    readonly order = 4;

    /**
     * Render the Variance Reduction tab with survival biasing, weight windows,
     * and source biasing controls.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Variance reduction tab React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const vr = state.varianceReduction || {};
        const meshes = state.meshes || [];

        return (
            <div className="variance-reduction-tab">
                {/* Info Banner */}
                <div className="info-banner vr-info-banner">
                    <i className="codicon codicon-info"></i>
                    <div className="info-content">
                        <strong>Variance Reduction Techniques</strong>
                        <span>Use these methods to improve simulation efficiency for deep penetration and shielding problems.</span>
                    </div>
                </div>

                {/* Survival Biasing Toggle */}
                <div className="settings-section survival-biasing-section">
                    <h3>
                        <i className="codicon codicon-shield"></i>
                        Survival Biasing
                    </h3>
                    <div className="form-group checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={vr.survivalBiasing || false}
                                onChange={(e) =>
                                    host.stateManager.updateVarianceReduction({
                                        ...vr,
                                        survivalBiasing: e.target.checked
                                    })
                                }
                            />
                            Enable Survival Biasing (Implicit Capture)
                        </label>
                    </div>
                    <span className="form-hint">
                        Instead of terminating absorption events, reduce particle weight and continue tracking. Recommended for problems
                        with strong absorption.
                    </span>
                </div>

                {/* Uniform Fission Site (UFS) */}
                {(() => {
                    const isEigenvalue = state.settings.run.mode === 'eigenvalue';
                    const regularMeshes = meshes.filter((mesh) => mesh.type === 'regular');
                    const ufsEnabled = !!vr.ufs?.enabled;
                    return (
                        <div className="settings-section ufs-section">
                            <h3>
                                <i className="codicon codicon-radio-tower"></i>
                                Uniform Fission Site (UFS)
                            </h3>
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={ufsEnabled}
                                        disabled={!isEigenvalue}
                                        onChange={(e) => {
                                            if (e.target.checked) {
                                                host.stateManager.updateVarianceReduction({
                                                    ...vr,
                                                    ufs: { enabled: true }
                                                });
                                            } else {
                                                host.stateManager.updateVarianceReduction({
                                                    ...vr,
                                                    ufs: undefined
                                                });
                                            }
                                        }}
                                    />
                                    Enable Uniform Fission Site
                                </label>
                            </div>
                            <span className="form-hint">
                                UFS re-weights fission sites uniformly over a regular mesh in eigenvalue runs. It is ignored in fixed-source
                                mode.
                            </span>
                            {!isEigenvalue && (
                                <span className="form-hint source-warning">Switch the run mode to eigenvalue to use UFS.</span>
                            )}

                            {ufsEnabled && (
                                <div className="form-group ufs-mesh-picker">
                                    <label>UFS mesh</label>
                                    <NukeSelect
                                        value={String(vr.ufs?.meshId ?? '')}
                                        options={[
                                            {
                                                value: '',
                                                label: regularMeshes.length > 0 ? 'Select a regular mesh...' : 'No regular meshes'
                                            },
                                            ...regularMeshes.map((mesh) => ({
                                                value: String(mesh.id),
                                                label: `${mesh.name || `Mesh ${mesh.id}`} (${mesh.type})`
                                            }))
                                        ]}
                                        onChange={(value: string) => {
                                            const meshId = value ? parseInt(value) : undefined;
                                            host.stateManager.updateVarianceReduction({
                                                ...vr,
                                                ufs: { ...vr.ufs, enabled: true, meshId }
                                            });
                                        }}
                                        ariaLabel="UFS mesh"
                                    />
                                    {vr.ufs?.meshId === undefined ? (
                                        <span className="form-error">
                                            Select a regular mesh; UFS cannot run without <code>ufs_mesh</code>.
                                        </span>
                                    ) : (
                                        <span className="form-hint">The mesh must cover every fissionable region.</span>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })()}

                {/* Cutoff Settings */}
                <div className="settings-section cutoff-section">
                    <h3>
                        <i className="codicon codicon-settings"></i>
                        Weight Cutoffs
                    </h3>

                    <div className="form-row">
                        <div className="form-group">
                            <label>
                                Weight Cutoff
                                <NukeTooltip content="Particles with weight below this value are terminated" position="top">
                                    <i className="codicon codicon-info info-icon"></i>
                                </NukeTooltip>
                            </label>
                            <input
                                type="number"
                                min={0}
                                step={0.001}
                                value={vr.cutoff?.weight || ''}
                                placeholder="Default"
                                onChange={(e) => {
                                    const weight = e.target.value ? parseFloat(e.target.value) : undefined;
                                    host.stateManager.updateVarianceReduction({
                                        ...vr,
                                        cutoff: { ...vr.cutoff, weight }
                                    });
                                }}
                            />
                            <span className="form-hint">Terminate particles below this weight</span>
                        </div>

                        <div className="form-group">
                            <label>
                                Average Weight Cutoff
                                <NukeTooltip content="Threshold for average weight of particles in a cell" position="top">
                                    <i className="codicon codicon-info info-icon"></i>
                                </NukeTooltip>
                            </label>
                            <input
                                type="number"
                                min={0}
                                step={0.001}
                                value={vr.cutoff?.weightAvg || ''}
                                placeholder="Default"
                                onChange={(e) => {
                                    const weightAvg = e.target.value ? parseFloat(e.target.value) : undefined;
                                    host.stateManager.updateVarianceReduction({
                                        ...vr,
                                        cutoff: { ...vr.cutoff, weightAvg }
                                    });
                                }}
                            />
                            <span className="form-hint">Cell-based average weight threshold</span>
                        </div>
                    </div>
                </div>

                {/* Weight Window Generator */}
                <div className="settings-section ww-generator-section">
                    <h3>
                        <i className="codicon codicon-rocket"></i>
                        Weight Window Generator
                    </h3>

                    <div className="form-group checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={!!vr.weightWindowGenerator}
                                onChange={(e) => {
                                    if (e.target.checked) {
                                        host.stateManager.updateVarianceReduction({
                                            ...vr,
                                            weightWindowGenerator: { iterations: 5, particleType: NEUTRON_PARTICLE }
                                        });
                                    } else {
                                        host.stateManager.updateVarianceReduction({
                                            ...vr,
                                            weightWindowGenerator: undefined
                                        });
                                    }
                                }}
                            />
                            Enable Weight Window Generator
                        </label>
                    </div>

                    {vr.weightWindowGenerator && (
                        <div className="ww-generator-config">
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Method</label>
                                    <NukeSelect
                                        value={vr.weightWindowGenerator.method ?? 'magic'}
                                        options={[
                                            { value: 'magic', label: 'MAGIC (default)' },
                                            { value: 'fw_cadis', label: 'FW-CADIS (multi-group)' }
                                        ]}
                                        onChange={(value: string) =>
                                            host.stateManager.updateVarianceReduction({
                                                ...vr,
                                                weightWindowGenerator: {
                                                    ...vr.weightWindowGenerator,
                                                    method: value as 'magic' | 'fw_cadis'
                                                }
                                            })
                                        }
                                        ariaLabel="Weight window generator method"
                                    />
                                </div>

                                <div className="form-group">
                                    <label>Max Realizations</label>
                                    <input
                                        type="number"
                                        min={1}
                                        value={
                                            vr.weightWindowGenerator.maxRealizations ??
                                            vr.weightWindowGenerator.iterations ??
                                            (state.settings.run.mode === 'eigenvalue' ? state.settings.run.batches : 1)
                                        }
                                        onChange={(e) =>
                                            host.stateManager.updateVarianceReduction({
                                                ...vr,
                                                weightWindowGenerator: {
                                                    ...vr.weightWindowGenerator,
                                                    maxRealizations: parseInt(e.target.value) || 1
                                                }
                                            })
                                        }
                                    />
                                    <span className="form-hint">Tally realizations when generating (defaults to batch count)</span>
                                </div>

                                <div className="form-group">
                                    <ParticleTypeSelector
                                        value={vr.weightWindowGenerator.particleType}
                                        onChange={(particleType) =>
                                            host.stateManager.updateVarianceReduction({
                                                ...vr,
                                                weightWindowGenerator: {
                                                    ...vr.weightWindowGenerator,
                                                    particleType
                                                }
                                            })
                                        }
                                        scope="weight-window"
                                        allowedNames={['neutron', 'photon']}
                                        allowCustom={false}
                                        ariaLabel="Generator particle type"
                                        label="Particle Type"
                                    />
                                    <span className="form-hint">Particle type to generate weight windows for</span>
                                </div>
                            </div>

                            {(vr.weightWindowGenerator.method ?? 'magic') === 'fw_cadis' &&
                                (state.settings.energyMode === 'multigroup' && state.settings.mgxsLibrary && state.settings.randomRay ? (
                                    <>
                                        <div className="form-row">
                                            <div className="form-group">
                                                <label>Update Interval</label>
                                                <input
                                                    type="number"
                                                    min={1}
                                                    value={vr.weightWindowGenerator.updateInterval ?? 1}
                                                    onChange={(e) =>
                                                        host.stateManager.updateVarianceReduction({
                                                            ...vr,
                                                            weightWindowGenerator: {
                                                                ...vr.weightWindowGenerator,
                                                                updateInterval: parseInt(e.target.value) || 1
                                                            }
                                                        })
                                                    }
                                                />
                                            </div>
                                            <div className="form-group checkbox">
                                                <label>
                                                    <input
                                                        type="checkbox"
                                                        checked={vr.weightWindowGenerator.onTheFly ?? true}
                                                        onChange={(e) =>
                                                            host.stateManager.updateVarianceReduction({
                                                                ...vr,
                                                                weightWindowGenerator: {
                                                                    ...vr.weightWindowGenerator,
                                                                    onTheFly: e.target.checked
                                                                }
                                                            })
                                                        }
                                                    />
                                                    Apply weight windows on the fly
                                                </label>
                                            </div>
                                        </div>
                                        <div className="form-group">
                                            <label>Target Tallies (local VR)</label>
                                            <div className="checkbox-row">
                                                {state.tallies.map((tally) => (
                                                    <label key={tally.id} className="score-checkbox-label">
                                                        <input
                                                            type="checkbox"
                                                            checked={(vr.weightWindowGenerator?.targetTallyIds ?? []).includes(tally.id)}
                                                            onChange={() => {
                                                                const current = vr.weightWindowGenerator?.targetTallyIds ?? [];
                                                                const next = current.includes(tally.id)
                                                                    ? current.filter((id) => id !== tally.id)
                                                                    : [...current, tally.id];
                                                                host.stateManager.updateVarianceReduction({
                                                                    ...vr,
                                                                    weightWindowGenerator: {
                                                                        ...vr.weightWindowGenerator,
                                                                        targetTallyIds: next.length > 0 ? next : undefined
                                                                    }
                                                                });
                                                            }}
                                                        />
                                                        <span>{tally.name || `Tally ${tally.id}`}</span>
                                                    </label>
                                                ))}
                                                {state.tallies.length === 0 && (
                                                    <span className="form-hint">No tallies defined — FW-CADIS targets global VR</span>
                                                )}
                                            </div>
                                            <span className="form-hint">
                                                FW-CADIS derives weight windows from the adjoint flux (enable adjoint mode in the Random Ray
                                                tab)
                                            </span>
                                        </div>
                                    </>
                                ) : (
                                    <div className="openmc-warning-box">
                                        <i className="codicon codicon-warning"></i>
                                        <div className="warning-content">
                                            <strong>FW-CADIS requires random ray mode</strong>
                                            <p>
                                                Enable the random ray solver in the Random Ray tab (multi-group energy mode and an MGXS
                                                library are required) to use FW-CADIS.
                                            </p>
                                        </div>
                                    </div>
                                ))}
                        </div>
                    )}
                </div>

                {/* Weight Windows Editor */}
                <WeightWindowEditor
                    weightWindows={vr.weightWindows}
                    weightWindowsFile={vr.weightWindowsFile}
                    weightWindowsOn={vr.weightWindowsOn}
                    weightWindowCheckpoints={vr.weightWindowCheckpoints}
                    meshes={meshes}
                    onChange={(updates) =>
                        host.stateManager.updateVarianceReduction({
                            ...vr,
                            ...updates
                        })
                    }
                    onBrowseFile={() => this.browseWeightWindowsFile(host)}
                    onWWINPImport={() => this.importWWINP(host)}
                    onWWINPExport={(set) => this.exportWWINP(host, set)}
                />

                <div className="vr-source-bias-note">
                    <i className="codicon codicon-info" aria-hidden="true"></i>
                    <span>
                        Source bias is configured per distribution in <strong>Settings → Sources</strong>: energy/time, direction, and
                        point-cloud/mesh spatial sections each carry their own bias control.
                    </span>
                </div>

                {vr.weightWindowGenerator && host.producedWeightWindowsUri && (
                    <div className="ww-bootstrap-action">
                        <div className="ww-bootstrap-text">
                            <strong>Generated weight_windows.h5 is available</strong>
                            <span>
                                Use the generated file for production and turn the generator off so the next run does not overwrite it.
                            </span>
                        </div>
                        <button
                            className="theia-button primary"
                            onClick={() => {
                                host.stateManager.updateVarianceReduction({
                                    ...vr,
                                    weightWindowsFile: host.producedWeightWindowsUri!.path.toString(),
                                    weightWindowsOn: true,
                                    weightWindowGenerator: undefined
                                });
                                host.messageService.info('Weight-window file set; generator disabled for the follow-up run');
                            }}
                        >
                            <i className="codicon codicon-file-media"></i> Use generated weight_windows.h5
                        </button>
                    </div>
                )}
            </div>
        );
    }

    /**
     * Browse for a weight-window HDF5 file and store its absolute path.
     * @param host - Simulation dashboard widget host.
     */
    private async browseWeightWindowsFile(host: SimulationDashboardWidget): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Weight Windows File',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'Weight Windows': ['h5', 'hdf5'],
                'All Files': ['*']
            }
        };
        const uri = await host.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }
        const state = host.stateManager.getState();
        host.stateManager.updateVarianceReduction({
            ...(state.varianceReduction ?? {}),
            weightWindowsFile: uri.path.toString(),
            weightWindowsOn: true
        });
    }

    /**
     * Import MCNP WWINP weight window file.
     * @param host - Simulation dashboard widget host.
     */
    private async importWWINP(host: SimulationDashboardWidget): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Import MCNP WWINP File',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'MCNP Weight Windows': ['wwinp'],
                'All Files': ['*']
            }
        };

        const uri = await host.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }

        host.messageService.info(`Importing WWINP from ${uri.path.toString()}...`);

        try {
            // Call backend service to parse WWINP
            const result = await host.studioService.getBackendService().importWWINP({
                filePath: uri.path.toString()
            });

            if (result.success && result.weightWindows) {
                const state = host.stateManager.getState();
                const vr = state.varianceReduction || {};
                const sets = vr.weightWindows ?? [];
                host.stateManager.updateVarianceReduction({
                    ...vr,
                    weightWindows: [
                        ...sets,
                        {
                            ...result.weightWindows,
                            id: nextWeightWindowId(sets)
                        }
                    ],
                    weightWindowsOn: true
                });
                host.messageService.info('WWINP imported successfully');
            } else {
                host.messageService.error(`Failed to import WWINP: ${result.error}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            host.messageService.error(`WWINP import error: ${msg}`);
        }
    }

    /**
     * Export one weight-window set to an MCNP WWINP file.
     * @param host - Simulation dashboard widget host.
     * @param set - Weight-window set to export.
     */
    private async exportWWINP(host: SimulationDashboardWidget, set: OpenMCWeightWindows): Promise<void> {
        const state = host.stateManager.getState();

        if (!set) {
            host.messageService.warn('No weight windows configured to export');
            return;
        }

        const props: SaveFileDialogProps = {
            title: 'Export MCNP WWINP File',
            inputValue: 'wwinp'
        };

        const uri = await host.fileDialogService.showSaveDialog(props);
        if (!uri) {
            return;
        }

        host.messageService.info(`Exporting WWINP to ${uri.path.toString()}...`);

        try {
            // Call backend service to generate WWINP
            const result = await host.studioService.getBackendService().exportWWINP({
                filePath: uri.path.toString(),
                weightWindows: set,
                meshes: state.meshes
            });

            if (result.success) {
                host.messageService.info('WWINP exported successfully');
            } else {
                host.messageService.error(`Failed to export WWINP: ${result.error}`);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            host.messageService.error(`WWINP export error: ${msg}`);
        }
    }
}
