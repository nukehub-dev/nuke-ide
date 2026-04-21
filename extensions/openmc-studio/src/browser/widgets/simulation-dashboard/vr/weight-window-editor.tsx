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
 * @module openmc-studio/browser/widgets/vr
 */

import * as React from '@theia/core/shared/react';
import { OpenMCWeightWindows, OpenMCMesh } from '../../../../common/openmc-state-schema';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

/** Props for the {@link WeightWindowEditor} component. */
export interface WeightWindowEditorProps {
    /** Current weight windows configuration, if any. */
    weightWindows?: OpenMCWeightWindows;
    /** Available meshes that can be used for weight window definition. */
    meshes: OpenMCMesh[];
    /** Callback invoked when the weight windows configuration changes. */
    onChange: (updates: Partial<OpenMCWeightWindows>) => void;
    /** Callback invoked to enable or disable weight windows entirely. */
    onToggle: (enabled: boolean) => void;
    /** Optional callback to import weight windows from an MCNP WWINP file. */
    onWWINPImport?: () => void;
    /** Optional callback to export weight windows to an MCNP WWINP file. */
    onWWINPExport?: () => void;
}

/**
 * Editor for configuring OpenMC weight window parameters.
 *
 * Provides controls for mesh selection, weight bounds, particle type,
 * and energy bounds. Supports MCNP WWINP import/export when callbacks are provided.
 *
 * @see {@link OpenMCWeightWindows} for the data model
 * @see {@link OpenMCMesh} for mesh definitions
 */
export const WeightWindowEditor: React.FC<WeightWindowEditorProps> = ({
    weightWindows,
    meshes,
    onChange,
    onToggle,
    onWWINPImport,
    onWWINPExport
}) => {
    const isEnabled = !!weightWindows;
    const ww = weightWindows || { meshId: 0, lowerBound: 0.5 };

    const selectedMesh = meshes.find(m => m.id === ww.meshId);

    return (
        <div className='weight-window-editor'>
            {/* Enable/Disable Card */}
            <div className={`vr-enable-card ${isEnabled ? 'enabled' : ''}`}>
                <div className='enable-card-content'>
                    <div className='enable-icon'>
                        <i className={`codicon ${isEnabled ? 'codicon-check' : 'codicon-dashboard'}`}></i>
                    </div>
                    <div className='enable-text'>
                        <h3>Weight Windows</h3>
                        <p>{isEnabled
                            ? 'Split and Russian roulette based on particle weight bounds.'
                            : 'Enable to control particle population using weight windows for deep penetration problems.'}</p>
                    </div>
                    <button
                        className={`theia-button ${isEnabled ? 'secondary' : 'primary'}`}
                        onClick={() => onToggle(!isEnabled)}
                    >
                        <i className={`codicon ${isEnabled ? 'codicon-close' : 'codicon-play'}`}></i>
                        {isEnabled ? 'Disable' : 'Enable'}
                    </button>
                </div>

                {!isEnabled && (
                    <div className='enable-benefits'>
                        <div className='benefit-item'>
                            <i className='codicon codicon-target'></i>
                            <span>Reduce variance in shielding</span>
                        </div>
                        <div className='benefit-item'>
                            <i className='codicon codicon-zap'></i>
                            <span>Better deep penetration results</span>
                        </div>
                        <div className='benefit-item'>
                            <i className='codicon codicon-graph-line'></i>
                            <span>Faster convergence</span>
                        </div>
                    </div>
                )}
            </div>

            {isEnabled && (
                <>
                    {/* WWINP Import/Export */}
                    {(onWWINPImport || onWWINPExport) && (
                        <div className='settings-section wwinp-section'>
                            <h3>
                                <i className='codicon codicon-file-code'></i>
                                MCNP WWINP Import/Export
                            </h3>
                            <div className='wwinp-actions'>
                                {onWWINPImport && (
                                    <Tooltip content='Import weight windows from MCNP WWINP file' position='top'>
                                        <button
                                            className='theia-button secondary'
                                            onClick={onWWINPImport}
                                        >
                                            <i className='codicon codicon-file-add'></i>
                                            Import WWINP
                                        </button>
                                    </Tooltip>
                                )}
                                {onWWINPExport && (
                                    <Tooltip content='Export weight windows to MCNP WWINP format' position='top'>
                                        <button
                                            className='theia-button secondary'
                                            onClick={onWWINPExport}
                                            disabled={!selectedMesh}
                                        >
                                            <i className='codicon codicon-file-export'></i>
                                            Export WWINP
                                        </button>
                                    </Tooltip>
                                )}
                            </div>
                            <span className='form-hint'>
                                Import existing MCNP weight windows or export for use in other codes.
                            </span>
                        </div>
                    )}

                    {/* Mesh Selection */}
                    <div className='settings-section'>
                        <h3>
                            <i className='codicon codicon-layout'></i>
                            Weight Window Mesh
                        </h3>

                        {meshes.length === 0 ? (
                            <div className='vr-warning-box'>
                                <i className='codicon codicon-warning'></i>
                                <div className='warning-content'>
                                    <strong>No Meshes Available</strong>
                                    <p>Weight windows require a mesh. Go to the <strong>Tallies</strong> tab and create a mesh first.</p>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className='form-group'>
                                    <label>Select Mesh</label>
                                    <select
                                        value={ww.meshId || ''}
                                        onChange={(e) => onChange({ ...ww, meshId: parseInt(e.target.value) || 0 })}
                                    >
                                        <option value=''>Select a mesh...</option>
                                        {meshes.map(mesh => (
                                            <option key={mesh.id} value={mesh.id}>
                                                {mesh.name || `Mesh ${mesh.id}`} ({mesh.type})
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {selectedMesh && (
                                    <div className='mesh-info-card'>
                                        <div className='mesh-info-header'>
                                            <i className='codicon codicon-info'></i>
                                            <span>Selected Mesh Properties</span>
                                        </div>
                                        <div className='mesh-info-grid'>
                                            <div className='info-item'>
                                                <label>Type:</label>
                                                <span>{selectedMesh.type}</span>
                                            </div>
                                            <div className='info-item'>
                                                <label>ID:</label>
                                                <span>{selectedMesh.id}</span>
                                            </div>
                                            {'dimension' in selectedMesh && (
                                                <div className='info-item'>
                                                    <label>Dimensions:</label>
                                                    <span>{(selectedMesh as any).dimension?.join(' × ')}</span>
                                                </div>
                                            )}
                                            {'rGrid' in selectedMesh && (
                                                <div className='info-item'>
                                                    <label>R-grid:</label>
                                                    <span>{(selectedMesh as any).rGrid?.length} bins</span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    {/* Weight Bounds */}
                    <div className='settings-section'>
                        <h3>
                            <i className='codicon codicon-settings-gear'></i>
                            Weight Bounds
                        </h3>

                        <div className='form-row'>
                            <div className='form-group'>
                                <label>
                                    Lower Weight Bound
                                    <Tooltip content='Particles with weight below this bound will be split' position='top'>
                                        <i className='codicon codicon-info info-icon'></i>
                                    </Tooltip>
                                </label>
                                <input
                                    type='number'
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={typeof ww.lowerBound === 'number' ? ww.lowerBound : 0.5}
                                    onChange={(e) => onChange({ ...ww, lowerBound: parseFloat(e.target.value) })}
                                />
                                <span className='form-hint'>Default: 0.5 - particles below this weight are split</span>
                            </div>

                            <div className='form-group'>
                                <label>
                                    Upper Weight Bound (optional)
                                    <Tooltip content='Particles with weight above this bound will undergo Russian roulette' position='top'>
                                        <i className='codicon codicon-info info-icon'></i>
                                    </Tooltip>
                                </label>
                                <input
                                    type='number'
                                    min={0}
                                    step={0.1}
                                    value={typeof ww.upperBound === 'number' ? ww.upperBound : ''}
                                    placeholder='Auto (2× lower)'
                                    onChange={(e) => {
                                        const val = e.target.value ? parseFloat(e.target.value) : undefined;
                                        onChange({ ...ww, upperBound: val });
                                    }}
                                />
                                <span className='form-hint'>If not set, defaults to 2× lower bound</span>
                            </div>
                        </div>

                        <div className='form-group'>
                            <label>
                                Survival Weight (optional)
                                <Tooltip content='Weight assigned to surviving particles after Russian roulette' position='top'>
                                    <i className='codicon codicon-info info-icon'></i>
                                </Tooltip>
                            </label>
                            <input
                                type='number'
                                min={0}
                                step={0.1}
                                value={ww.survivalWeight || ''}
                                placeholder='Auto (upper bound)'
                                onChange={(e) => {
                                    const val = e.target.value ? parseFloat(e.target.value) : undefined;
                                    onChange({ ...ww, survivalWeight: val });
                                }}
                            />
                            <span className='form-hint'>If not set, defaults to upper weight bound</span>
                        </div>
                    </div>

                    {/* Particle Type */}
                    <div className='settings-section'>
                        <h3>
                            <i className='codicon codicon-radio-tower'></i>
                            Particle Settings
                        </h3>

                        <div className='form-group'>
                            <label>Particle Type</label>
                            <select
                                value={ww.particleType || 'neutron'}
                                onChange={(e) => onChange({ ...ww, particleType: e.target.value as 'neutron' | 'photon' })}
                            >
                                <option value='neutron'>Neutron</option>
                                <option value='photon'>Photon</option>
                            </select>
                        </div>
                    </div>

                    {/* Energy Bounds */}
                    <div className='settings-section'>
                        <h3>
                            <i className='codicon codicon-flame'></i>
                            Energy Bounds
                        </h3>

                        <div className='form-group'>
                            <label>Energy Bounds (eV)</label>
                            
                            {/* Energy Bounds Chips */}
                            <div className='energy-bounds-chips'>
                                {(ww.energyBounds || []).map((bound, idx) => (
                                    <span key={idx} className='energy-bound-chip'>
                                        {bound.toExponential(2)} eV
                                        <Tooltip content='Remove this bound' position='top'>
                                            <button
                                                className='chip-remove'
                                                onClick={() => {
                                                    const newBounds = (ww.energyBounds || []).filter((_, i) => i !== idx);
                                                    onChange({ ...ww, energyBounds: newBounds.length >= 2 ? newBounds : undefined });
                                                }}
                                            >
                                                <i className='codicon codicon-close'></i>
                                            </button>
                                        </Tooltip>
                                    </span>
                                ))}
                            </div>
                            
                            {/* Add New Bound Input */}
                            <div className='energy-bounds-add'>
                                <input
                                    type='text'
                                    placeholder='Add energy bound (e.g., 0, 1e6, 2e7) and press Enter'
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            const value = parseFloat(e.currentTarget.value.trim());
                                            if (!isNaN(value)) {
                                                const currentBounds = ww.energyBounds || [];
                                                if (!currentBounds.includes(value)) {
                                                    const newBounds = [...currentBounds, value].sort((a, b) => a - b);
                                                    onChange({ ...ww, energyBounds: newBounds });
                                                }
                                                e.currentTarget.value = '';
                                            }
                                        }
                                    }}
                                    className={!ww.energyBounds || ww.energyBounds.length < 2 ? 'invalid' : ''}
                                />
                            </div>
                            
                            <span className='form-hint'>
                                Type a value and press Enter to add. At least 2 bounds required for energy groups.
                            </span>
                            {(!ww.energyBounds || ww.energyBounds.length < 2) && (
                                <span className='form-error'>At least 2 energy bounds are required</span>
                            )}
                        </div>

                        {ww.energyBounds && ww.energyBounds.length >= 2 && (
                            <div className='energy-bounds-preview'>
                                <span className='preview-label'>{ww.energyBounds.length - 1} Energy Group(s):</span>
                                <div className='energy-group-bars'>
                                    {ww.energyBounds.slice(0, -1).map((bound, idx) => {
                                        const nextBound = ww.energyBounds![idx + 1];
                                        const width = Math.min(100, Math.max(20, (nextBound - bound) / bound * 100));
                                        return (
                                            <div key={idx} className='energy-group-bar'>
                                                <div className='bar' style={{ width: `${width}%` }}></div>
                                                <span className='bar-label'>
                                                    {bound.toExponential(1)} - {nextBound.toExponential(1)} eV
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

export default WeightWindowEditor;
