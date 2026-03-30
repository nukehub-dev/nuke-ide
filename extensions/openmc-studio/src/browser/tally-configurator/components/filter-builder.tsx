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

import * as React from 'react';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCTallyFilter, OpenMCMesh } from '../../../common/openmc-state-schema';

interface FilterBuilderProps {
    filters: OpenMCTallyFilter[];
    meshes: OpenMCMesh[];
    onUpdate: (filters: OpenMCTallyFilter[]) => void;
}

export const FilterBuilder: React.FC<FilterBuilderProps> = ({ filters, meshes, onUpdate }) => {
    const addFilter = (type: string) => {
        let newFilter: OpenMCTallyFilter;
        if (type === 'mesh') {
            newFilter = { type: 'mesh', bins: meshes.length > 0 ? [meshes[0].id] : [], meshId: meshes.length > 0 ? meshes[0].id : 0 };
        } else if (type === 'energy') {
            newFilter = { type: 'energy', bins: [0, 2e7] };
        } else {
            newFilter = { type: type as any, bins: [] };
        }
        onUpdate([...filters, newFilter]);
    };

    const removeFilter = (index: number) => {
        onUpdate(filters.filter((_, i) => i !== index));
    };

    const updateFilter = (index: number, updates: Partial<OpenMCTallyFilter>) => {
        const newFilters = [...filters];
        newFilters[index] = { ...newFilters[index], ...updates } as OpenMCTallyFilter;
        onUpdate(newFilters);
    };

    return (
        <div className='filter-builder'>
            <div className='filter-list'>
                {filters.map((filter, index) => (
                    <div key={index} className='filter-item'>
                        <div className='filter-header'>
                            <span className='filter-type-badge'>{filter.type}</span>
                            <Tooltip content='Remove filter' position='top'>
                                <button className='remove-filter-btn' onClick={() => removeFilter(index)}>
                                    <i className='codicon codicon-trash'></i>
                                </button>
                            </Tooltip>
                        </div>
                        <div className='filter-content'>
                            {filter.type === 'mesh' && (
                                <div className='form-group'>
                                    <label>Mesh</label>
                                    <select 
                                        value={filter.meshId} 
                                        onChange={(e) => updateFilter(index, { meshId: parseInt(e.target.value, 10), bins: [parseInt(e.target.value, 10)] })}
                                    >
                                        <option value={0}>Select Mesh</option>
                                        {meshes.map(m => (
                                            <option key={m.id} value={m.id}>{m.name || `Mesh ${m.id}`}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            {filter.type === 'energy' && (
                                <div className='form-group'>
                                    <label>Energy Bins (eV, space-separated)</label>
                                    <input 
                                        type='text' 
                                        value={filter.bins.join(' ')} 
                                        onChange={(e) => updateFilter(index, { bins: e.target.value.split(/\s+/).map(v => parseFloat(v)).filter(v => !isNaN(v)) })}
                                        placeholder='e.g. 0 1e-5 2e7'
                                    />
                                </div>
                            )}
                            {(filter.type === 'cell' || filter.type === 'material' || filter.type === 'universe') && (
                                <div className='form-group'>
                                    <label>Bins (IDs, space-separated)</label>
                                    <input 
                                        type='text' 
                                        value={filter.bins.join(' ')} 
                                        onChange={(e) => updateFilter(index, { bins: e.target.value.split(/\s+/).map(v => parseInt(v, 10)).filter(v => !isNaN(v)) })}
                                        placeholder='e.g. 1 2 3'
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            <div className='add-filter-controls'>
                <Tooltip content='Filter by spatial mesh cell' position='top'>
                    <button className='add-button' onClick={() => addFilter('mesh')} disabled={meshes.length === 0}>+ Mesh Filter</button>
                </Tooltip>
                <Tooltip content='Filter by energy bins (eV)' position='top'>
                    <button className='add-button' onClick={() => addFilter('energy')}>+ Energy Filter</button>
                </Tooltip>
                <Tooltip content='Filter by cell IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('cell')}>+ Cell Filter</button>
                </Tooltip>
                <Tooltip content='Filter by material IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('material')}>+ Material Filter</button>
                </Tooltip>
            </div>
        </div>
    );
};
