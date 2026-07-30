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
import { OpenFileDialogProps, SaveFileDialogProps } from '@theia/filesystem/lib/browser';
import { OpenMCState } from '../../../../common/openmc-state-schema';
import { WeightWindowEditor, SourceBiasingEditor } from '../vr';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';

/**
 * Variance reduction tab of the simulation dashboard: survival biasing, weight windows and source biasing.
 */
@injectable()
export class VarianceReductionTabContribution implements DashboardTabContribution {
    readonly id = 'variance-reduction';
    readonly label = 'Variance Reduction';
    readonly icon = 'dashboard';
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
                {state.settings.run.mode === 'eigenvalue' && (
                    <div className="settings-section ufs-section">
                        <h3>
                            <i className="codicon codicon-radio-tower"></i>
                            Uniform Fission Site (UFS)
                        </h3>
                        <div className="form-group checkbox">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={vr.ufs?.enabled || false}
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
                            For eigenvalue calculations: sample fission sites uniformly across the fissionable mesh. Improves source
                            convergence for problems with localized fission sources.
                        </span>

                        {vr.ufs?.enabled && meshes.length > 0 && (
                            <div className="form-group" style={{ marginTop: '12px' }}>
                                <label>UFS Mesh (optional)</label>
                                <select
                                    value={vr.ufs.meshId || ''}
                                    onChange={(e) => {
                                        const meshId = e.target.value ? parseInt(e.target.value) : undefined;
                                        host.stateManager.updateVarianceReduction({
                                            ...vr,
                                            ufs: { ...vr.ufs, meshId }
                                        });
                                    }}
                                >
                                    <option value="">Use weight window mesh</option>
                                    {meshes.map((mesh) => (
                                        <option key={mesh.id} value={mesh.id}>
                                            {mesh.name || `Mesh ${mesh.id}`} ({mesh.type})
                                        </option>
                                    ))}
                                </select>
                                <span className="form-hint">Select a specific mesh or use the weight window mesh</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Cutoff Settings -->
                <div className='settings-section cutoff-section'>
                    <h3>
                        <i className='codicon codicon-settings'></i>
                        Weight Cutoffs
                    </h3>

                    <div className='form-row'>
                        <div className='form-group'>
                            <label>
                                Weight Cutoff
                                <Tooltip content='Particles with weight below this value are terminated' position='top'>
                                    <i className='codicon codicon-info info-icon'></i>
                                </Tooltip>
                            </label>
                            <input
                                type='number'
                                min={0}
                                step={0.001}
                                value={vr.cutoff?.weight || ''}
                                placeholder='Default'
                                onChange={(e) => {
                                    const weight = e.target.value ? parseFloat(e.target.value) : undefined;
                                    host.stateManager.updateVarianceReduction({
                                        ...vr,
                                        cutoff: { ...vr.cutoff, weight }
                                    });
                                }}
                            />
                            <span className='form-hint'>Terminate particles below this weight</span>
                        </div>

                        <div className='form-group'>
                            <label>
                                Average Weight Cutoff
                                <Tooltip content='Threshold for average weight of particles in a cell' position='top'>
                                    <i className='codicon codicon-info info-icon'></i>
                                </Tooltip>
                            </label>
                            <input
                                type='number'
                                min={0}
                                step={0.001}
                                value={vr.cutoff?.weightAvg || ''}
                                placeholder='Default'
                                onChange={(e) => {
                                    const weightAvg = e.target.value ? parseFloat(e.target.value) : undefined;
                                    host.stateManager.updateVarianceReduction({
                                        ...vr,
                                        cutoff: { ...vr.cutoff, weightAvg }
                                    });
                                }}
                            />
                            <span className='form-hint'>Cell-based average weight threshold</span>
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
                                            weightWindowGenerator: { iterations: 5, particleType: 'neutron' }
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
                                    <select
                                        value={vr.weightWindowGenerator.method ?? 'magic'}
                                        onChange={(e) =>
                                            host.stateManager.updateVarianceReduction({
                                                ...vr,
                                                weightWindowGenerator: {
                                                    ...vr.weightWindowGenerator,
                                                    method: e.target.value as 'magic' | 'fw_cadis'
                                                }
                                            })
                                        }
                                    >
                                        <option value="magic">MAGIC (default)</option>
                                        <option value="fw_cadis">FW-CADIS (multi-group)</option>
                                    </select>
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
                                    <label>Particle Type</label>
                                    <select
                                        value={vr.weightWindowGenerator.particleType || 'neutron'}
                                        onChange={(e) =>
                                            host.stateManager.updateVarianceReduction({
                                                ...vr,
                                                weightWindowGenerator: {
                                                    ...vr.weightWindowGenerator,
                                                    particleType: e.target.value as 'neutron' | 'photon'
                                                }
                                            })
                                        }
                                    >
                                        <option value="neutron">Neutron</option>
                                        <option value="photon">Photon</option>
                                    </select>
                                    <span className="form-hint">Particle type to generate weight windows for</span>
                                </div>
                            </div>

                            {(vr.weightWindowGenerator.method ?? 'magic') === 'fw_cadis' &&
                                (state.settings.energyMode === 'multigroup' && state.settings.mgxsLibrary ? (
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
                                    <div className="depletion-warning-box">
                                        <i className="codicon codicon-warning"></i>
                                        <div className="warning-content">
                                            <strong>FW-CADIS requires multi-group mode</strong>
                                            <p>
                                                Switch to multi-group energy mode and set an MGXS library in the Random Ray tab to use
                                                FW-CADIS.
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
                    meshes={meshes}
                    onChange={(updates) =>
                        host.stateManager.updateVarianceReduction({
                            ...vr,
                            weightWindows: { ...vr.weightWindows, ...updates } as any
                        })
                    }
                    onToggle={(enabled) => {
                        if (enabled) {
                            host.stateManager.updateVarianceReduction({
                                ...vr,
                                weightWindows: {
                                    meshId: meshes[0]?.id || 0,
                                    lowerBound: 0.5,
                                    energyBounds: [0.0, 2e7] // Default: 0 to 20 MeV
                                }
                            });
                        } else {
                            host.stateManager.updateVarianceReduction({
                                ...vr,
                                weightWindows: undefined
                            });
                        }
                    }}
                    onWWINPImport={() => this.importWWINP(host)}
                    onWWINPExport={() => this.exportWWINP(host)}
                />

                {/* Source Biasing Editor */}
                <SourceBiasingEditor
                    sourceBiasing={vr.sourceBiasing}
                    onChange={(updates) =>
                        host.stateManager.updateVarianceReduction({
                            ...vr,
                            sourceBiasing: { ...vr.sourceBiasing, ...updates }
                        })
                    }
                    onToggle={(enabled) => {
                        if (enabled) {
                            host.stateManager.updateVarianceReduction({
                                ...vr,
                                sourceBiasing: {}
                            });
                        } else {
                            host.stateManager.updateVarianceReduction({
                                ...vr,
                                sourceBiasing: undefined
                            });
                        }
                    }}
                />
            </div>
        );
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
                host.stateManager.updateVarianceReduction({
                    ...vr,
                    weightWindows: result.weightWindows
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
     * Export current weight windows to an MCNP WWINP file.
     * @param host - Simulation dashboard widget host.
     */
    private async exportWWINP(host: SimulationDashboardWidget): Promise<void> {
        const state = host.stateManager.getState();
        const vr = state.varianceReduction;

        if (!vr?.weightWindows) {
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
                weightWindows: vr.weightWindows,
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
