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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCRandomRaySettings, OpenMCRegularMesh } from '../../../../common/openmc-state-schema';
import { OpenMCCompat } from '../../../../common/openmc-studio-protocol';
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
                                <Tooltip content="Select an MGXS library file" position="bottom">
                                    <button className="theia-button secondary" onClick={() => this.browseMgxsLibrary(host)}>
                                        <i className="codicon codicon-folder-opened"></i> Browse
                                    </button>
                                </Tooltip>
                            </div>
                        </div>
                    )}
                </div>

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
