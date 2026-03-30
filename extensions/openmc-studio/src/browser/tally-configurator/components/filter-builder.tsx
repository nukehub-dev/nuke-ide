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
        } else if (type === 'energyout') {
            newFilter = { type: 'energyout', bins: [0, 2e7] };
        } else if (type === 'mu') {
            newFilter = { type: 'mu', bins: [-1, 1] };
        } else if (type === 'polar') {
            newFilter = { type: 'polar', bins: [0, 3.14159] };
        } else if (type === 'azimuthal') {
            newFilter = { type: 'azimuthal', bins: [0, 6.28318530718] };
        } else if (type === 'delayedgroup') {
            newFilter = { type: 'delayedgroup', bins: [1, 2, 3, 4, 5, 6] };
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

    const getBinHelp = (type: string): string => {
        const helpMap: Record<string, string> = {
            universe: 'e.g. 0 1 2',
            material: 'e.g. 1 2 3',
            cell: 'e.g. 1 2 3',
            cellborn: 'e.g. 1 2 3',
            surface: 'e.g. 10 20 30',
            distribcell: 'e.g. 1',
            delayedgroup: 'e.g. 1 2 3 (groups 1-6)',
            energy: 'e.g. 0 1e-5 0.625 2e7',
            energyout: 'e.g. 0 1e-5 0.625 2e7',
            mu: 'e.g. -1 0 1 (-1 to 1)',
            polar: 'e.g. 0 1.5708 3.14159 (0 to π)',
            azimuthal: 'e.g. 0 3.14159 6.28318 (0 to 2π)',
            time: 'e.g. 0 1e-3 1e-2 0.1 (seconds)',
        };
        return helpMap[type] || 'e.g. 1 2 3';
    };

    const renderFilterContent = (filter: OpenMCTallyFilter, index: number) => {
        if (filter.type === 'mesh') {
            return (
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
            );
        }
        
        if (filter.type === 'energy' || filter.type === 'energyout' || filter.type === 'mu' || filter.type === 'polar' || filter.type === 'azimuthal' || filter.type === 'time') {
            return (
                <div className='form-group'>
                    <label>
                        {filter.type === 'energy' && 'Energy Bins (eV)'}
                        {filter.type === 'energyout' && 'Outgoing Energy Bins (eV)'}
                        {filter.type === 'mu' && 'Cosine of Scattering Angle (-1 to 1)'}
                        {filter.type === 'polar' && 'Polar Angle Bins (radians, 0 to π)'}
                        {filter.type === 'azimuthal' && 'Azimuthal Angle Bins (radians, 0 to 2π)'}
                        {filter.type === 'time' && 'Time Bins (seconds)'}
                    </label>
                    <input 
                        type='text' 
                        value={filter.bins.join(' ')} 
                        onChange={(e) => updateFilter(index, { bins: e.target.value.split(/\s+/).map(v => parseFloat(v)).filter(v => !isNaN(v)) })}
                        placeholder={getBinHelp(filter.type)}
                    />
                    <p className='form-hint'>{getBinHelp(filter.type)}</p>
                </div>
            );
        }
        
        return (
            <div className='form-group'>
                <label>Bins (IDs, space-separated)</label>
                <input 
                    type='text' 
                    value={filter.bins.join(' ')} 
                    onChange={(e) => updateFilter(index, { bins: e.target.value.split(/\s+/).map(v => parseInt(v, 10)).filter(v => !isNaN(v)) })}
                    placeholder={getBinHelp(filter.type)}
                />
                <p className='form-hint'>{getBinHelp(filter.type)}</p>
            </div>
        );
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
                            {renderFilterContent(filter, index)}
                        </div>
                    </div>
                ))}
            </div>
            <div className='add-filter-controls'>
                <Tooltip content='Filter by spatial mesh cell' position='top'>
                    <button className='add-button' onClick={() => addFilter('mesh')} disabled={meshes.length === 0}>+ Mesh Filter</button>
                </Tooltip>
                <Tooltip content='Filter by energy bins (eV)' position='top'>
                    <button className='add-button' onClick={() => addFilter('energy')}>+ Energy</button>
                </Tooltip>
                <Tooltip content='Filter by outgoing energy bins (eV)' position='top'>
                    <button className='add-button' onClick={() => addFilter('energyout')}>+ Energy Out</button>
                </Tooltip>
                <Tooltip content='Filter by cell IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('cell')}>+ Cell</button>
                </Tooltip>
                <Tooltip content='Filter by material IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('material')}>+ Material</button>
                </Tooltip>
                <Tooltip content='Filter by universe IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('universe')}>+ Universe</button>
                </Tooltip>
                <Tooltip content='Filter by surface IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('surface')}>+ Surface</button>
                </Tooltip>
                <Tooltip content='Filter by birth cell IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('cellborn')}>+ Cell Born</button>
                </Tooltip>
                <Tooltip content='Filter by distributed cell IDs' position='top'>
                    <button className='add-button' onClick={() => addFilter('distribcell')}>+ Distribcell</button>
                </Tooltip>
            </div>
            <div className='add-filter-controls' style={{marginTop: '8px'}}>
                <Tooltip content='Filter by delayed neutron precursor groups (1-6)' position='top'>
                    <button className='add-button' onClick={() => addFilter('delayedgroup')}>+ Delayed Group</button>
                </Tooltip>
                <Tooltip content='Filter by cosine of scattering angle (-1 to 1)' position='top'>
                    <button className='add-button' onClick={() => addFilter('mu')}>+ Mu (Angle)</button>
                </Tooltip>
                <Tooltip content='Filter by polar angle (0 to π)' position='top'>
                    <button className='add-button' onClick={() => addFilter('polar')}>+ Polar</button>
                </Tooltip>
                <Tooltip content='Filter by azimuthal angle (0 to 2π)' position='top'>
                    <button className='add-button' onClick={() => addFilter('azimuthal')}>+ Azimuthal</button>
                </Tooltip>
                <Tooltip content='Filter by time bins (seconds)' position='top'>
                    <button className='add-button' onClick={() => addFilter('time')}>+ Time</button>
                </Tooltip>
            </div>
        </div>
    );
};
