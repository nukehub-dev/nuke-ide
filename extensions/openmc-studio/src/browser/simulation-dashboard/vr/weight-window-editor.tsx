// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as React from '@theia/core/shared/react';
import { OpenMCWeightWindows, OpenMCMesh } from '../../../common/openmc-state-schema';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

export interface WeightWindowEditorProps {
    weightWindows?: OpenMCWeightWindows;
    meshes: OpenMCMesh[];
    onChange: (updates: Partial<OpenMCWeightWindows>) => void;
    onToggle: (enabled: boolean) => void;
}

export const WeightWindowEditor: React.FC<WeightWindowEditorProps> = ({
    weightWindows,
    meshes,
    onChange,
    onToggle
}) => {
    const isEnabled = !!weightWindows;
    const ww = weightWindows || { meshId: 0, lowerBound: 0.5 };

    const selectedMesh = meshes.find(m => m.id === ww.meshId);
    
    // Local state for energy bounds text input to allow incomplete typing
    const [energyBoundsText, setEnergyBoundsText] = React.useState(ww.energyBounds?.join(', ') || '');
    
    // Sync energyBoundsText with prop changes (e.g., when loading a project)
    React.useEffect(() => {
        setEnergyBoundsText(ww.energyBounds?.join(', ') || '');
    }, [ww.energyBounds]);

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
                            Energy-Dependent Weight Windows (Optional)
                        </h3>

                        <div className='form-group'>
                            <label>Energy Bounds (eV)</label>
                            <div className='energy-bounds-input'>
                                <input
                                    type='text'
                                    value={energyBoundsText}
                                    placeholder='e.g., 1e-5, 0.1, 1e6, 2e7'
                                    onChange={(e) => {
                                        // Just update local text state while typing
                                        setEnergyBoundsText(e.target.value);
                                    }}
                                    onBlur={(e) => {
                                        // Parse and validate on blur
                                        const bounds = e.target.value
                                            .split(',')
                                            .map(s => parseFloat(s.trim()))
                                            .filter(n => !isNaN(n));
                                        onChange({ ...ww, energyBounds: bounds.length > 0 ? bounds : undefined });
                                    }}
                                />
                            </div>
                            <span className='form-hint'>Comma-separated list of energy boundaries for multi-group weight windows</span>
                        </div>

                        {ww.energyBounds && ww.energyBounds.length > 0 && (
                            <div className='energy-bounds-preview'>
                                <span className='preview-label'>Energy Groups:</span>
                                <div className='energy-groups'>
                                    {ww.energyBounds.map((bound, idx) => (
                                        <span key={idx} className='energy-bound-tag'>
                                            {bound.toExponential(2)} eV
                                        </span>
                                    ))}
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
