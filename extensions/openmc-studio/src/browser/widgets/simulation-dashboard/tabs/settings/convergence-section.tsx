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
        </div>
    );
}
