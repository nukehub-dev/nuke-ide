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
import { OpenMCState } from '../../../../../common/openmc-state-schema';
import type { SimulationDashboardWidget } from '../../simulation-dashboard-widget';

/**
 * Render the Physics section: photon transport toggle, electron treatment, and
 * atomic relaxation settings.
 * @param host - Simulation dashboard widget host.
 * @param state - Current OpenMC simulation state.
 * @returns Physics section React node.
 */
export function renderPhysicsSection(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
    const settings = state.settings;

    return (
        <div className="physics-section">
            <div className="form-group checkbox">
                <label>
                    <input
                        type="checkbox"
                        checked={settings.photonTransport || false}
                        onChange={(e) => host.updateSetting('photonTransport', e.target.checked)}
                    />
                    Enable Photon Transport
                </label>
            </div>

            {settings.photonTransport && (
                <>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Electron Treatment</label>
                            <select
                                value={settings.electronTreatment ?? 'led'}
                                onChange={(e) => host.updateSetting('electronTreatment', e.target.value as 'led' | 'ttb')}
                            >
                                <option value="led">LED (Local Energy Deposition)</option>
                                <option value="ttb">TTB (Thick-Target Bremsstrahlung)</option>
                            </select>
                            <span className="form-hint">How energy from photon-produced electrons is treated</span>
                        </div>
                        <div className="form-group checkbox">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={settings.atomicRelaxation ?? true}
                                    onChange={(e) => host.updateSetting('atomicRelaxation', e.target.checked)}
                                />
                                Atomic Relaxation
                            </label>
                            <span className="form-hint">Emit fluorescence photons and Auger electrons after photoelectric effect</span>
                        </div>
                    </div>
                </>
            )}
            {!settings.photonTransport && (
                <span className="form-hint">Photon options become available when photon transport is enabled.</span>
            )}
        </div>
    );
}
