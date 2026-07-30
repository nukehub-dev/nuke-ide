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

import * as React from 'react';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCTallyFilter, OpenMCTallyFilterType, OpenMCMesh } from '../../../../common/openmc-state-schema';
import { OPENMC_FILTERS, getFilterDescriptor, createDefaultFilter } from '../../../../common/filters-catalog';

/**
 * Props for the {@link FilterBuilder} component.
 */
interface FilterBuilderProps {
    /** Current list of filters */
    filters: OpenMCTallyFilter[];
    /** Available meshes for mesh filters */
    meshes: OpenMCMesh[];
    /** Callback when filters are updated */
    onUpdate: (filters: OpenMCTallyFilter[]) => void;
}

/** Delayed neutron precursor groups (ENDF/B-VII.1 uses 6) */
const DELAYED_GROUPS = [1, 2, 3, 4, 5, 6];

/**
 * Interactive builder for OpenMC tally filters.
 *
 * Renders a parameter editor per filter type driven by the filter catalog
 * (see `src/common/filters-catalog.ts`): domain IDs, energy/angle/time bins,
 * mesh selection, delayed-group checkboxes, expansion orders, and the
 * energy-function response table.
 *
 * @see {@link TallyEditor}
 */
export const FilterBuilder: React.FC<FilterBuilderProps> = ({ filters, meshes, onUpdate }) => {
    /** Add a new filter of the given type with catalog defaults. */
    const addFilter = (type: OpenMCTallyFilterType) => {
        onUpdate([...filters, createDefaultFilter(type, meshes.length > 0 ? meshes[0].id : undefined)]);
    };

    /** Remove the filter at the given index. */
    const removeFilter = (index: number) => {
        onUpdate(filters.filter((_, i) => i !== index));
    };

    /** Update the filter at the given index with partial changes. */
    const updateFilter = (index: number, updates: Partial<OpenMCTallyFilter>) => {
        const newFilters = [...filters];
        newFilters[index] = { ...newFilters[index], ...updates } as OpenMCTallyFilter;
        onUpdate(newFilters);
    };

    /** Render a space-separated numeric bins text input (float). */
    const renderBinsInput = (filter: OpenMCTallyFilter, index: number, label: string, integer: boolean): React.ReactNode => {
        const help = getFilterDescriptor(filter.type)?.binHelp ?? 'e.g. 1 2 3';
        return (
            <div className="form-group">
                <label>{label}</label>
                <input
                    type="text"
                    value={filter.bins.join(' ')}
                    onChange={(e) =>
                        updateFilter(index, {
                            bins: e.target.value
                                .split(/\s+/)
                                .map((v) => (integer ? parseInt(v, 10) : parseFloat(v)))
                                .filter((v) => !isNaN(v))
                        })
                    }
                    placeholder={help}
                />
                <p className="form-hint">{help}</p>
            </div>
        );
    };

    /** Render the mesh selector for mesh-based filters. */
    const renderMeshSelect = (filter: OpenMCTallyFilter, index: number): React.ReactNode => (
        <div className="form-group">
            <label>Mesh</label>
            <select
                value={filter.meshId}
                onChange={(e) => updateFilter(index, { meshId: parseInt(e.target.value, 10), bins: [parseInt(e.target.value, 10)] })}
            >
                <option value={0}>Select Mesh</option>
                {meshes.map((m) => (
                    <option key={m.id} value={m.id}>
                        {m.name || `Mesh ${m.id}`}
                    </option>
                ))}
            </select>
        </div>
    );

    /** Render the delayed-group checkbox list (groups 1-6). */
    const renderDelayedGroups = (filter: OpenMCTallyFilter, index: number): React.ReactNode => (
        <div className="form-group">
            <label>Delayed Neutron Precursor Groups</label>
            <div className="checkbox-row">
                {DELAYED_GROUPS.map((group) => (
                    <label key={group} className="score-checkbox-label">
                        <input
                            type="checkbox"
                            checked={filter.bins.includes(group)}
                            onChange={() =>
                                updateFilter(index, {
                                    bins: filter.bins.includes(group)
                                        ? filter.bins.filter((g) => g !== group)
                                        : [...filter.bins, group].sort((a, b) => a - b)
                                })
                            }
                        />
                        <span>Group {group}</span>
                    </label>
                ))}
            </div>
        </div>
    );

    /** Render the particle-type checkboxes (1=neutron, 2=photon). */
    const renderParticleTypes = (filter: OpenMCTallyFilter, index: number): React.ReactNode => (
        <div className="form-group">
            <label>Particle Types</label>
            <div className="checkbox-row">
                {[
                    { id: 1, label: 'Neutron' },
                    { id: 2, label: 'Photon' }
                ].map((p) => (
                    <label key={p.id} className="score-checkbox-label">
                        <input
                            type="checkbox"
                            checked={filter.bins.includes(p.id)}
                            onChange={() =>
                                updateFilter(index, {
                                    bins: filter.bins.includes(p.id) ? filter.bins.filter((b) => b !== p.id) : [...filter.bins, p.id]
                                })
                            }
                        />
                        <span>{p.label}</span>
                    </label>
                ))}
            </div>
        </div>
    );

    /** Render an expansion-order number input. */
    const renderOrderInput = (filter: OpenMCTallyFilter, index: number, label: string): React.ReactNode => (
        <div className="form-group">
            <label>{label}</label>
            <input
                type="number"
                min={0}
                value={filter.order ?? 0}
                onChange={(e) => updateFilter(index, { order: parseInt(e.target.value, 10) || 0 })}
            />
        </div>
    );

    /** Render the energy-function editor: interpolation + energy/response pairs. */
    const renderEnergyFunction = (filter: OpenMCTallyFilter, index: number): React.ReactNode => {
        const energyValues = filter.energyValues ?? [];
        const responseValues = filter.responseValues ?? [];
        const rowCount = Math.max(energyValues.length, responseValues.length);

        const updatePair = (row: number, energy: number, response: number) => {
            const newEnergy = [...energyValues];
            const newResponse = [...responseValues];
            newEnergy[row] = energy;
            newResponse[row] = response;
            updateFilter(index, { energyValues: newEnergy, responseValues: newResponse });
        };

        const removeRow = (row: number) => {
            updateFilter(index, {
                energyValues: energyValues.filter((_, i) => i !== row),
                responseValues: responseValues.filter((_, i) => i !== row)
            });
        };

        const addRow = () => {
            const lastEnergy = energyValues[energyValues.length - 1] ?? 1;
            const lastResponse = responseValues[responseValues.length - 1] ?? 1;
            updateFilter(index, { energyValues: [...energyValues, lastEnergy * 10], responseValues: [...responseValues, lastResponse] });
        };

        return (
            <div className="energy-function-editor">
                <div className="form-group">
                    <label>Interpolation</label>
                    <select
                        value={filter.interpolation ?? 'linear-linear'}
                        onChange={(e) => updateFilter(index, { interpolation: e.target.value as OpenMCTallyFilter['interpolation'] })}
                    >
                        <option value="histogram">Histogram</option>
                        <option value="linear-linear">Linear-Linear</option>
                        <option value="linear-log">Linear-Log</option>
                        <option value="log-linear">Log-Linear</option>
                        <option value="log-log">Log-Log</option>
                    </select>
                </div>
                {Array.from({ length: rowCount }, (_, row) => (
                    <div className="form-row" key={row}>
                        <div className="form-group">
                            <label>Energy (eV)</label>
                            <input
                                type="number"
                                min={0}
                                step="any"
                                value={energyValues[row] ?? 0}
                                onChange={(e) => updatePair(row, parseFloat(e.target.value) || 0, responseValues[row] ?? 0)}
                            />
                        </div>
                        <div className="form-group">
                            <label>Response</label>
                            <input
                                type="number"
                                step="any"
                                value={responseValues[row] ?? 0}
                                onChange={(e) => updatePair(row, energyValues[row] ?? 0, parseFloat(e.target.value) || 0)}
                            />
                        </div>
                        <div className="form-group">
                            <label>&nbsp;</label>
                            <Tooltip content="Remove point" position="top">
                                <button className="remove-filter-btn" onClick={() => removeRow(row)}>
                                    <i className="codicon codicon-trash"></i>
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                ))}
                <button className="add-button" onClick={addRow}>
                    + Add Point
                </button>
            </div>
        );
    };

    /** Render the editor controls for a specific filter. */
    const renderFilterContent = (filter: OpenMCTallyFilter, index: number): React.ReactNode => {
        const descriptor = getFilterDescriptor(filter.type);
        switch (descriptor?.editor) {
            case 'mesh':
                return renderMeshSelect(filter, index);
            case 'energy-bins':
                return renderBinsInput(filter, index, filter.type === 'energy' ? 'Energy Bins (eV)' : 'Outgoing Energy Bins (eV)', false);
            case 'mu-bins':
                return renderBinsInput(filter, index, 'Cosine of Scattering Angle (-1 to 1)', false);
            case 'polar-bins':
                return renderBinsInput(filter, index, 'Polar Angle Bins (radians, 0 to π)', false);
            case 'azimuthal-bins':
                return renderBinsInput(filter, index, 'Azimuthal Angle Bins (radians, 0 to 2π)', false);
            case 'time-bins':
                return renderBinsInput(filter, index, 'Time Bins (seconds)', false);
            case 'delayed-groups':
                return renderDelayedGroups(filter, index);
            case 'particle-types':
                return renderParticleTypes(filter, index);
            case 'legendre-order':
                return renderOrderInput(filter, index, 'Expansion Order');
            case 'spatial-legendre':
                return (
                    <>
                        <div className="form-row">
                            {renderOrderInput(filter, index, 'Expansion Order')}
                            <div className="form-group">
                                <label>Axis</label>
                                <select
                                    value={filter.axis ?? 'z'}
                                    onChange={(e) => updateFilter(index, { axis: e.target.value as 'x' | 'y' | 'z' })}
                                >
                                    <option value="x">X</option>
                                    <option value="y">Y</option>
                                    <option value="z">Z</option>
                                </select>
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Minimum</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={filter.min ?? 0}
                                    onChange={(e) => updateFilter(index, { min: parseFloat(e.target.value) || 0 })}
                                />
                            </div>
                            <div className="form-group">
                                <label>Maximum</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={filter.max ?? 0}
                                    onChange={(e) => updateFilter(index, { max: parseFloat(e.target.value) || 0 })}
                                />
                            </div>
                        </div>
                    </>
                );
            case 'spherical-harmonics':
                return (
                    <div className="form-row">
                        {renderOrderInput(filter, index, 'Expansion Order')}
                        <div className="form-group">
                            <label>Cosine Treatment</label>
                            <select
                                value={filter.cosine ?? 'particle'}
                                onChange={(e) => updateFilter(index, { cosine: e.target.value as 'scatter' | 'particle' })}
                            >
                                <option value="particle">Particle (direction)</option>
                                <option value="scatter">Scatter (scattering angle)</option>
                            </select>
                        </div>
                    </div>
                );
            case 'zernike':
                return (
                    <>
                        <div className="form-row">{renderOrderInput(filter, index, 'Expansion Order')}</div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Center X</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={filter.center?.x ?? 0}
                                    onChange={(e) =>
                                        updateFilter(index, {
                                            center: { ...(filter.center ?? { x: 0, y: 0, r: 1 }), x: parseFloat(e.target.value) || 0 }
                                        })
                                    }
                                />
                            </div>
                            <div className="form-group">
                                <label>Center Y</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={filter.center?.y ?? 0}
                                    onChange={(e) =>
                                        updateFilter(index, {
                                            center: { ...(filter.center ?? { x: 0, y: 0, r: 1 }), y: parseFloat(e.target.value) || 0 }
                                        })
                                    }
                                />
                            </div>
                            <div className="form-group">
                                <label>Radius</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={filter.center?.r ?? 1}
                                    onChange={(e) =>
                                        updateFilter(index, {
                                            center: { ...(filter.center ?? { x: 0, y: 0, r: 1 }), r: parseFloat(e.target.value) || 1 }
                                        })
                                    }
                                />
                            </div>
                        </div>
                    </>
                );
            case 'energy-function':
                return renderEnergyFunction(filter, index);
            default:
                return renderBinsInput(filter, index, 'Bins (IDs, space-separated)', true);
        }
    };

    const midpoint = Math.ceil(OPENMC_FILTERS.length / 2);

    return (
        <div className="filter-builder">
            <div className="filter-list">
                {filters.map((filter, index) => (
                    <div key={index} className="filter-item">
                        <div className="filter-header">
                            <span className="filter-type-badge">{filter.type}</span>
                            <Tooltip content="Remove filter" position="top">
                                <button className="remove-filter-btn" onClick={() => removeFilter(index)}>
                                    <i className="codicon codicon-trash"></i>
                                </button>
                            </Tooltip>
                        </div>
                        <div className="filter-content">{renderFilterContent(filter, index)}</div>
                    </div>
                ))}
            </div>
            {[OPENMC_FILTERS.slice(0, midpoint), OPENMC_FILTERS.slice(midpoint)].map((group, groupIndex) => (
                <div className="add-filter-controls" key={groupIndex} style={groupIndex > 0 ? { marginTop: '8px' } : undefined}>
                    {group.map((descriptor) => (
                        <Tooltip key={descriptor.type} content={descriptor.tooltip} position="top">
                            <button
                                className="add-button"
                                onClick={() => addFilter(descriptor.type)}
                                disabled={descriptor.requiresMesh && meshes.length === 0}
                            >
                                + {descriptor.label}
                            </button>
                        </Tooltip>
                    ))}
                </div>
            ))}
        </div>
    );
};
