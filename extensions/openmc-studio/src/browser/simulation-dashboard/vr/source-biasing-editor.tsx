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
import { OpenMCSourceBiasing, OpenMCSourceEnergy, OpenMCSourceSpatial } from '../../../common/openmc-state-schema';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

export interface SourceBiasingEditorProps {
    sourceBiasing?: OpenMCSourceBiasing;
    onChange: (updates: Partial<OpenMCSourceBiasing>) => void;
    onToggle: (enabled: boolean) => void;
}

export const SourceBiasingEditor: React.FC<SourceBiasingEditorProps> = ({
    sourceBiasing,
    onChange,
    onToggle
}) => {
    const isEnabled = !!sourceBiasing;
    const sb = sourceBiasing || {};

    return (
        <div className='source-biasing-editor'>
            {/* Enable/Disable Card */}
            <div className={`vr-enable-card ${isEnabled ? 'enabled' : ''}`}>
                <div className='enable-card-content'>
                    <div className='enable-icon'>
                        <i className={`codicon ${isEnabled ? 'codicon-check' : 'codicon-target'}`}></i>
                    </div>
                    <div className='enable-text'>
                        <h3>Source Biasing</h3>
                        <p>{isEnabled
                            ? 'Bias source particle distributions to favor important regions.'
                            : 'Enable to bias source sampling toward regions of interest for better statistics.'}</p>
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
                            <i className='codicon codicon-location'></i>
                            <span>Spatial biasing toward important regions</span>
                        </div>
                        <div className='benefit-item'>
                            <i className='codicon codicon-flame'></i>
                            <span>Energy biasing for specific reactions</span>
                        </div>
                        <div className='benefit-item'>
                            <i className='codicon codicon-zap'></i>
                            <span>Reduce variance in tallies</span>
                        </div>
                    </div>
                )}
            </div>

            {isEnabled && (
                <>
                    {/* Strength Bias */}
                    <div className='settings-section'>
                        <h3>
                            <i className='codicon codicon-zap'></i>
                            Strength Bias
                        </h3>

                        <div className='form-group'>
                            <label>
                                Strength Bias Factor
                                <Tooltip content='Factor to adjust source particle weights when biasing' position='top'>
                                    <i className='codicon codicon-info info-icon'></i>
                                </Tooltip>
                            </label>
                            <input
                                type='number'
                                min={0}
                                step={0.1}
                                value={sb.strengthBias || ''}
                                placeholder='1.0 (no bias)'
                                onChange={(e) => {
                                    const val = e.target.value ? parseFloat(e.target.value) : undefined;
                                    onChange({ ...sb, strengthBias: val });
                                }}
                            />
                            <span className='form-hint'>Weight adjustment factor for biased sources (default: 1.0)</span>
                        </div>
                    </div>

                    {/* Energy Bias */}
                    <div className='settings-section'>
                        <h3>
                            <i className='codicon codicon-flame'></i>
                            Energy Biasing
                        </h3>

                        <div className='form-group'>
                            <label>Bias Type</label>
                            <select
                                value={sb.energyBias?.type || 'none'}
                                onChange={(e) => {
                                    const type = e.target.value as OpenMCSourceEnergy['type'] | 'none';
                                    if (type === 'none') {
                                        const { energyBias, ...rest } = sb;
                                        onChange(rest);
                                    } else {
                                        let energyBias: OpenMCSourceEnergy;
                                        switch (type) {
                                            case 'discrete':
                                                energyBias = { type: 'discrete', energies: [1e6] };
                                                break;
                                            case 'uniform':
                                                energyBias = { type: 'uniform', min: 0, max: 10e6 };
                                                break;
                                            case 'maxwell':
                                                energyBias = { type: 'maxwell', temperature: 300 };
                                                break;
                                            case 'watt':
                                                energyBias = { type: 'watt', a: 0.965, b: 2.29 };
                                                break;
                                            default:
                                                energyBias = { type: 'discrete', energies: [1e6] };
                                        }
                                        onChange({ ...sb, energyBias });
                                    }
                                }}
                            >
                                <option value='none'>No Energy Bias</option>
                                <option value='discrete'>Discrete</option>
                                <option value='uniform'>Uniform</option>
                                <option value='maxwell'>Maxwell</option>
                                <option value='watt'>Watt</option>
                            </select>
                        </div>

                        {sb.energyBias?.type === 'discrete' && (
                            <div className='form-group'>
                                <label>Biased Energy (eV)</label>
                                <input
                                    type='number'
                                    step='0.1'
                                    value={(sb.energyBias as any).energies?.[0] || 1e6}
                                    onChange={(e) => {
                                        onChange({
                                            ...sb,
                                            energyBias: { type: 'discrete', energies: [parseFloat(e.target.value) || 1e6] }
                                        });
                                    }}
                                />
                            </div>
                        )}

                        {sb.energyBias?.type === 'uniform' && (
                            <div className='form-row'>
                                <div className='form-group'>
                                    <label>Min Energy (eV)</label>
                                    <input
                                        type='number'
                                        step='0.1'
                                        value={(sb.energyBias as any).min || 0}
                                        onChange={(e) => {
                                            onChange({
                                                ...sb,
                                                energyBias: { ...(sb.energyBias as any), min: parseFloat(e.target.value) || 0 }
                                            });
                                        }}
                                    />
                                </div>
                                <div className='form-group'>
                                    <label>Max Energy (eV)</label>
                                    <input
                                        type='number'
                                        step='0.1'
                                        value={(sb.energyBias as any).max || 10e6}
                                        onChange={(e) => {
                                            onChange({
                                                ...sb,
                                                energyBias: { ...(sb.energyBias as any), max: parseFloat(e.target.value) || 10e6 }
                                            });
                                        }}
                                    />
                                </div>
                            </div>
                        )}

                        {sb.energyBias?.type === 'maxwell' && (
                            <div className='form-group'>
                                <label>Temperature (K)</label>
                                <input
                                    type='number'
                                    step='1'
                                    value={(sb.energyBias as any).temperature || 300}
                                    onChange={(e) => {
                                        onChange({
                                            ...sb,
                                            energyBias: { type: 'maxwell', temperature: parseFloat(e.target.value) || 300 }
                                        });
                                    }}
                                />
                            </div>
                        )}

                        {sb.energyBias?.type === 'watt' && (
                            <div className='form-row'>
                                <div className='form-group'>
                                    <label>a Parameter</label>
                                    <input
                                        type='number'
                                        step='0.001'
                                        value={(sb.energyBias as any).a || 0.965}
                                        onChange={(e) => {
                                            onChange({
                                                ...sb,
                                                energyBias: { ...(sb.energyBias as any), a: parseFloat(e.target.value) || 0.965 }
                                            });
                                        }}
                                    />
                                </div>
                                <div className='form-group'>
                                    <label>b Parameter</label>
                                    <input
                                        type='number'
                                        step='0.001'
                                        value={(sb.energyBias as any).b || 2.29}
                                        onChange={(e) => {
                                            onChange({
                                                ...sb,
                                                energyBias: { ...(sb.energyBias as any), b: parseFloat(e.target.value) || 2.29 }
                                            });
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Spatial Bias */}
                    <div className='settings-section'>
                        <h3>
                            <i className='codicon codicon-location'></i>
                            Spatial Biasing
                        </h3>

                        <div className='form-group'>
                            <label>Bias Type</label>
                            <select
                                value={sb.spatialBias?.type || 'none'}
                                onChange={(e) => {
                                    const type = e.target.value as OpenMCSourceSpatial['type'] | 'none';
                                    if (type === 'none') {
                                        const { spatialBias, ...rest } = sb;
                                        onChange(rest);
                                    } else {
                                        let spatialBias: OpenMCSourceSpatial;
                                        switch (type) {
                                            case 'point':
                                                spatialBias = { type: 'point', origin: [0, 0, 0] };
                                                break;
                                            case 'box':
                                                spatialBias = { type: 'box', lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] };
                                                break;
                                            case 'sphere':
                                                spatialBias = { type: 'sphere', center: [0, 0, 0], radius: 1 };
                                                break;
                                            default:
                                                spatialBias = { type: 'point', origin: [0, 0, 0] };
                                        }
                                        onChange({ ...sb, spatialBias });
                                    }
                                }}
                            >
                                <option value='none'>No Spatial Bias</option>
                                <option value='point'>Point</option>
                                <option value='box'>Box</option>
                                <option value='sphere'>Sphere</option>
                            </select>
                        </div>

                        {sb.spatialBias?.type === 'point' && (
                            <div className='form-row'>
                                {['X', 'Y', 'Z'].map((coord, idx) => (
                                    <div key={coord} className='form-group'>
                                        <label>{coord}</label>
                                        <input
                                            type='number'
                                            step='0.1'
                                            value={(sb.spatialBias as any).origin?.[idx] || 0}
                                            onChange={(e) => {
                                                const currentOrigin = (sb.spatialBias as any).origin as [number, number, number] || [0, 0, 0];
                                                const origin: [number, number, number] = [
                                                    idx === 0 ? parseFloat(e.target.value) || 0 : currentOrigin[0],
                                                    idx === 1 ? parseFloat(e.target.value) || 0 : currentOrigin[1],
                                                    idx === 2 ? parseFloat(e.target.value) || 0 : currentOrigin[2]
                                                ];
                                                onChange({
                                                    ...sb,
                                                    spatialBias: { type: 'point', origin }
                                                });
                                            }}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}

                        {sb.spatialBias?.type === 'box' && (
                            <>
                                <div className='form-row'>
                                    {['Min X', 'Min Y', 'Min Z'].map((label, idx) => (
                                        <div key={label} className='form-group'>
                                            <label>{label}</label>
                                            <input
                                                type='number'
                                                step='0.1'
                                                value={(sb.spatialBias as any).lowerLeft?.[idx] ?? -1}
                                                onChange={(e) => {
                                                    const current = (sb.spatialBias as any).lowerLeft as [number, number, number] || [-1, -1, -1];
                                                    const lowerLeft: [number, number, number] = [
                                                        idx === 0 ? parseFloat(e.target.value) || 0 : current[0],
                                                        idx === 1 ? parseFloat(e.target.value) || 0 : current[1],
                                                        idx === 2 ? parseFloat(e.target.value) || 0 : current[2]
                                                    ];
                                                    onChange({
                                                        ...sb,
                                                        spatialBias: { ...(sb.spatialBias as any), lowerLeft }
                                                    });
                                                }}
                                            />
                                        </div>
                                    ))}
                                </div>
                                <div className='form-row'>
                                    {['Max X', 'Max Y', 'Max Z'].map((label, idx) => (
                                        <div key={label} className='form-group'>
                                            <label>{label}</label>
                                            <input
                                                type='number'
                                                step='0.1'
                                                value={(sb.spatialBias as any).upperRight?.[idx] ?? 1}
                                                onChange={(e) => {
                                                    const current = (sb.spatialBias as any).upperRight as [number, number, number] || [1, 1, 1];
                                                    const upperRight: [number, number, number] = [
                                                        idx === 0 ? parseFloat(e.target.value) || 0 : current[0],
                                                        idx === 1 ? parseFloat(e.target.value) || 0 : current[1],
                                                        idx === 2 ? parseFloat(e.target.value) || 0 : current[2]
                                                    ];
                                                    onChange({
                                                        ...sb,
                                                        spatialBias: { ...(sb.spatialBias as any), upperRight }
                                                    });
                                                }}
                                            />
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {sb.spatialBias?.type === 'sphere' && (
                            <>
                                <div className='form-row'>
                                    {['Center X', 'Center Y', 'Center Z'].map((label, idx) => (
                                        <div key={label} className='form-group'>
                                            <label>{label}</label>
                                            <input
                                                type='number'
                                                step='0.1'
                                                value={(sb.spatialBias as any).center?.[idx] || 0}
                                                onChange={(e) => {
                                                    const currentCenter = (sb.spatialBias as any).center as [number, number, number] || [0, 0, 0];
                                                    const center: [number, number, number] = [
                                                        idx === 0 ? parseFloat(e.target.value) || 0 : currentCenter[0],
                                                        idx === 1 ? parseFloat(e.target.value) || 0 : currentCenter[1],
                                                        idx === 2 ? parseFloat(e.target.value) || 0 : currentCenter[2]
                                                    ];
                                                    onChange({
                                                        ...sb,
                                                        spatialBias: { ...(sb.spatialBias as any), center }
                                                    });
                                                }}
                                            />
                                        </div>
                                    ))}
                                    <div className='form-group'>
                                        <label>Radius</label>
                                        <input
                                            type='number'
                                            step='0.1'
                                            min={0}
                                            value={(sb.spatialBias as any).radius || 1}
                                            onChange={(e) => {
                                                onChange({
                                                    ...sb,
                                                    spatialBias: { ...(sb.spatialBias as any), radius: parseFloat(e.target.value) || 1 }
                                                });
                                            }}
                                        />
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

export default SourceBiasingEditor;
