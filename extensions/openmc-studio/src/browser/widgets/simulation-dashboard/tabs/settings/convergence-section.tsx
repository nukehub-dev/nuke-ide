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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState } from '../../../../../common/openmc-state-schema';
import type { SimulationDashboardWidget } from '../../simulation-dashboard-widget';

/**
 * Render the Convergence section: Shannon entropy mesh editor for monitoring
 * source convergence in eigenvalue simulations, with geometry auto-detect.
 * @param host - Simulation dashboard widget host.
 * @param state - Current OpenMC simulation state.
 * @param calculateBounds - Geometry bounds calculator (from the settings tab's source helpers).
 * @returns Convergence section React node.
 */
export function renderConvergenceSection(
    host: SimulationDashboardWidget,
    state: OpenMCState,
    calculateBounds: (state: OpenMCState) => { min: number[]; max: number[] } | null
): React.ReactNode {
    const entropyMesh = state.settings.entropyMesh;
    const hasGeometry = state.geometry.cells.length > 0;

    const autoDetect = (): void => {
        const bounds = calculateBounds(state);
        const current = state.settings.entropyMesh;
        host.stateManager.updateSettings({
            entropyMesh: {
                id: current?.id,
                lowerLeft: (bounds?.min ?? [-10, -10, -10]) as [number, number, number],
                upperRight: (bounds?.max ?? [10, 10, 10]) as [number, number, number],
                shape: current?.shape ?? [8, 8, 8]
            }
        });
    };

    const updateMesh = (updates: Partial<NonNullable<OpenMCState['settings']['entropyMesh']>>): void => {
        if (!entropyMesh) {
            return;
        }
        host.stateManager.updateSettings({ entropyMesh: { ...entropyMesh, ...updates } });
    };

    const vectorEditor = (
        label: string,
        vector: [number, number, number],
        apply: (v: [number, number, number]) => void,
        integer: boolean = false
    ): React.ReactNode => (
        <div className="form-row">
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <div className="form-group" key={axis}>
                    <label>
                        {label} {axis}
                    </label>
                    <input
                        type="number"
                        min={integer ? 1 : undefined}
                        step={integer ? 1 : 'any'}
                        value={vector[i]}
                        onChange={(e) => {
                            const next = [...vector] as [number, number, number];
                            next[i] = integer ? parseInt(e.target.value) || 1 : parseFloat(e.target.value) || 0;
                            apply(next);
                        }}
                    />
                </div>
            ))}
        </div>
    );

    return (
        <div className="convergence-section">
            <div className="form-group checkbox">
                <label>
                    <input
                        type="checkbox"
                        checked={entropyMesh !== undefined}
                        onChange={(e) => {
                            if (e.target.checked) {
                                autoDetect();
                            } else {
                                host.stateManager.updateSettings({ entropyMesh: undefined });
                            }
                        }}
                    />
                    Enable Shannon Entropy Mesh
                </label>
                <span className="form-hint">
                    Monitor source convergence during inactive batches (eigenvalue). OpenMC computes the Shannon entropy of the fission
                    source distribution over this mesh.
                </span>
            </div>

            {entropyMesh && (
                <>
                    <div className="form-row">
                        <div className="form-group">
                            <Tooltip content="Set mesh bounds from the current geometry" position="bottom">
                                <button className="theia-button secondary small" onClick={() => autoDetect()} disabled={!hasGeometry}>
                                    <i className="codicon codicon-target"></i> Auto-detect from Geometry
                                </button>
                            </Tooltip>
                            {!hasGeometry && <span className="form-hint">Define geometry cells to auto-detect bounds</span>}
                        </div>
                    </div>
                    {vectorEditor('Lower Left', entropyMesh.lowerLeft, (v) => updateMesh({ lowerLeft: v }))}
                    {vectorEditor('Upper Right', entropyMesh.upperRight, (v) => updateMesh({ upperRight: v }))}
                    {vectorEditor('Dimension', entropyMesh.shape, (v) => updateMesh({ shape: v }), true)}
                    <span className="form-hint">
                        Rule of thumb: about 20 particles per mesh cell (OpenMC uses (particles/20)^(1/3) per dimension by default).
                    </span>
                </>
            )}

            {renderCmfdBlock(host, state, calculateBounds, vectorEditor)}
        </div>
    );
}

/** CMFD mesh albedo face labels in schema order */
const ALBEDO_FACES = ['-X', '+X', '-Y', '+Y', '-Z', '+Z'] as const;

/**
 * Render the Acceleration (CMFD) block: enable toggle, mesh selection,
 * albedo faces, feedback, and run-control knobs.
 * @param host - Simulation dashboard widget host.
 * @param state - Current OpenMC simulation state.
 * @param calculateBounds - Geometry bounds calculator.
 * @param vectorEditor - Shared 3-vector editor factory from the entropy mesh editor.
 * @returns CMFD block React node.
 */
function renderCmfdBlock(
    host: SimulationDashboardWidget,
    state: OpenMCState,
    calculateBounds: (state: OpenMCState) => { min: number[]; max: number[] } | null,
    vectorEditor: (
        label: string,
        vector: [number, number, number],
        apply: (v: [number, number, number]) => void,
        integer?: boolean
    ) => React.ReactNode
): React.ReactNode {
    const cmfd = state.settings.cmfd;
    const regularMeshes = state.meshes.filter((m) => m.type === 'regular');
    const hasGeometry = state.geometry.cells.length > 0;

    const updateCmfd = (updates: Partial<NonNullable<OpenMCState['settings']['cmfd']>>): void => {
        const merged = { ...(cmfd ?? {}), ...updates };
        const hasContent = Object.values(merged).some((v) => v !== undefined);
        host.stateManager.updateSettings({ cmfd: hasContent ? merged : undefined });
    };

    const updateMesh = (updates: Partial<NonNullable<NonNullable<OpenMCState['settings']['cmfd']>['mesh']>>): void => {
        updateCmfd({ mesh: { ...(cmfd?.mesh ?? {}), ...updates } });
    };

    const autoDetectBounds = (): void => {
        const bounds = calculateBounds(state);
        if (!bounds) {
            host.messageService.warn('Cannot auto-detect bounds: no geometry defined');
            return;
        }
        updateMesh({
            lowerLeft: bounds.min as [number, number, number],
            upperRight: bounds.max as [number, number, number]
        });
    };

    const albedo = cmfd?.mesh?.albedo ?? [1, 1, 1, 1, 1, 1];

    return (
        <>
            <h4>
                <i className="codicon codicon-dashboard"></i> Acceleration (CMFD)
            </h4>
            <div className="form-group checkbox">
                <label>
                    <input
                        type="checkbox"
                        checked={cmfd?.enabled ?? false}
                        onChange={(e) => updateCmfd(e.target.checked ? { enabled: true } : { enabled: undefined })}
                    />
                    Enable CMFD acceleration
                </label>
                <span className="form-hint">
                    Coarse Mesh Finite Difference accelerates fission source convergence during inactive batches (eigenvalue). Runs via
                    openmc.cmfd.CMFDRun in generated Python — this OpenMC version has no settings.xml element for CMFD.
                </span>
            </div>

            {cmfd?.enabled && (
                <>
                    <div className="form-row">
                        <div className="form-group">
                            <label>CMFD Mesh</label>
                            <select
                                value={cmfd.meshRef ?? 'inline'}
                                onChange={(e) =>
                                    updateCmfd({ meshRef: e.target.value === 'inline' ? undefined : parseInt(e.target.value) })
                                }
                            >
                                <option value="inline">Inline (custom bounds)</option>
                                {regularMeshes.map((mesh) => (
                                    <option key={mesh.id} value={mesh.id}>
                                        {mesh.name || `Mesh ${mesh.id}`}
                                    </option>
                                ))}
                            </select>
                            <span className="form-hint">Reuse a tally mesh or define inline bounds below</span>
                        </div>
                    </div>

                    {cmfd.meshRef === undefined && (
                        <>
                            <div className="form-row">
                                <div className="form-group">
                                    <Tooltip content="Set mesh bounds from the current geometry" position="bottom">
                                        <button
                                            className="theia-button secondary small"
                                            onClick={() => autoDetectBounds()}
                                            disabled={!hasGeometry}
                                        >
                                            <i className="codicon codicon-target"></i> Auto-detect from Geometry
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>
                            {vectorEditor('Lower Left', cmfd.mesh?.lowerLeft ?? [-10, -10, -10], (v) => updateMesh({ lowerLeft: v }))}
                            {vectorEditor('Upper Right', cmfd.mesh?.upperRight ?? [10, 10, 10], (v) => updateMesh({ upperRight: v }))}
                            {vectorEditor('Dimension', cmfd.mesh?.dimension ?? [5, 5, 5], (v) => updateMesh({ dimension: v }), true)}
                        </>
                    )}

                    <div className="form-row">
                        {ALBEDO_FACES.map((face, i) => (
                            <div className="form-group" key={face}>
                                <label>Albedo {face}</label>
                                <input
                                    type="number"
                                    min={0}
                                    max={1}
                                    step="any"
                                    value={albedo[i]}
                                    onChange={(e) => {
                                        const next = [...albedo] as [number, number, number, number, number, number];
                                        next[i] = parseFloat(e.target.value) || 0;
                                        updateMesh({ albedo: next });
                                    }}
                                />
                            </div>
                        ))}
                    </div>

                    <div className="form-group checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={cmfd.feedback ?? false}
                                onChange={(e) => updateCmfd({ feedback: e.target.checked })}
                            />
                            Enable CMFD feedback
                        </label>
                        <span className="form-hint">
                            The CMFD diffusion result adjusts the weight of fission source neutrons on the next batch (per OpenMC docs).
                        </span>
                    </div>

                    <details className="cmfd-run-control">
                        <summary className="category-header">
                            <i className="codicon codicon-settings-gear"></i> Run Control
                        </summary>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Tally Begin (batch)</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={cmfd.tallyBegin ?? 1}
                                    onChange={(e) => updateCmfd({ tallyBegin: parseInt(e.target.value) || 1 })}
                                />
                            </div>
                            <div className="form-group">
                                <label>Solver Begin (batch)</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={cmfd.solverBegin ?? 1}
                                    onChange={(e) => updateCmfd({ solverBegin: parseInt(e.target.value) || 1 })}
                                />
                            </div>
                            <div className="form-group">
                                <label>Normalization</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={cmfd.norm ?? 1.0}
                                    onChange={(e) => updateCmfd({ norm: parseFloat(e.target.value) || 1.0 })}
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Eigenvalue Tolerance (ktol)</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={cmfd.cmfdKtol ?? 1e-8}
                                    onChange={(e) => updateCmfd({ cmfdKtol: parseFloat(e.target.value) || 1e-8 })}
                                />
                            </div>
                            <div className="form-group">
                                <label>Source Tolerance (stol)</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={cmfd.stol ?? 1e-8}
                                    onChange={(e) => updateCmfd({ stol: parseFloat(e.target.value) || 1e-8 })}
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Gauss-Seidel Abs Tol</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={cmfd.gaussSeidelTolerance?.[0] ?? 1e-10}
                                    onChange={(e) =>
                                        updateCmfd({
                                            gaussSeidelTolerance: [
                                                parseFloat(e.target.value) || 1e-10,
                                                cmfd.gaussSeidelTolerance?.[1] ?? 1e-5
                                            ]
                                        })
                                    }
                                />
                            </div>
                            <div className="form-group">
                                <label>Gauss-Seidel Rel Tol</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={cmfd.gaussSeidelTolerance?.[1] ?? 1e-5}
                                    onChange={(e) =>
                                        updateCmfd({
                                            gaussSeidelTolerance: [
                                                cmfd.gaussSeidelTolerance?.[0] ?? 1e-10,
                                                parseFloat(e.target.value) || 1e-5
                                            ]
                                        })
                                    }
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Window Type</label>
                                <select
                                    value={cmfd.windowType ?? 'none'}
                                    onChange={(e) => updateCmfd({ windowType: e.target.value as 'expanding' | 'rolling' | 'none' })}
                                >
                                    <option value="none">None (default)</option>
                                    <option value="expanding">Expanding</option>
                                    <option value="rolling">Rolling</option>
                                </select>
                            </div>
                            {cmfd.windowType === 'rolling' && (
                                <div className="form-group">
                                    <label>Window Size</label>
                                    <input
                                        type="number"
                                        min={1}
                                        value={cmfd.windowSize ?? 10}
                                        onChange={(e) => updateCmfd({ windowSize: parseInt(e.target.value) || 10 })}
                                    />
                                </div>
                            )}
                        </div>
                        <div className="checkbox-grid">
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={cmfd.downscatter ?? false}
                                        onChange={(e) => updateCmfd({ downscatter: e.target.checked })}
                                    />
                                    Effective downscatter (2-group)
                                </label>
                            </div>
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={cmfd.powerMonitor ?? false}
                                        onChange={(e) => updateCmfd({ powerMonitor: e.target.checked })}
                                    />
                                    Power monitor
                                </label>
                            </div>
                            <div className="form-group checkbox">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={cmfd.runAdjoint ?? false}
                                        onChange={(e) => updateCmfd({ runAdjoint: e.target.checked })}
                                    />
                                    Run adjoint (last batch)
                                </label>
                            </div>
                            {cmfd.runAdjoint && (
                                <div className="form-group">
                                    <label>Adjoint Type</label>
                                    <select
                                        value={cmfd.adjointType ?? 'physical'}
                                        onChange={(e) => updateCmfd({ adjointType: e.target.value as 'physical' | 'math' })}
                                    >
                                        <option value="physical">Physical</option>
                                        <option value="math">Math</option>
                                    </select>
                                </div>
                            )}
                        </div>
                    </details>
                </>
            )}
        </>
    );
}
