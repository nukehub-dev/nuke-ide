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
import { 
    OpenMCMesh, 
    OpenMCRegularMesh, 
    OpenMCCylindricalMesh, 
    OpenMCSphericalMesh,
    OpenMCMeshType 
} from '../../../common/openmc-state-schema';

interface MeshEditorProps {
    mesh: OpenMCMesh;
    dagmcBoundingBox?: { min: [number, number, number]; max: [number, number, number] };
    onUpdate: (updates: Partial<OpenMCMesh>) => void;
}

export const MeshEditor: React.FC<MeshEditorProps> = ({ mesh, dagmcBoundingBox, onUpdate }) => {
    const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newType = e.target.value as OpenMCMeshType;
        if (newType === mesh.type) return;

        // Reset mesh properties when type changes
        const base = { id: mesh.id, name: mesh.name, type: newType };
        let newMesh: OpenMCMesh;

        if (newType === 'regular') {
            newMesh = { ...base, type: 'regular', lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10], dimension: [10, 10, 10] };
        } else if (newType === 'cylindrical') {
            newMesh = { ...base, type: 'cylindrical', rGrid: [0, 10], phiGrid: [0, 6.28318530718], zGrid: [-10, 10] };
        } else {
            newMesh = { ...base, type: 'spherical', rGrid: [0, 10], thetaGrid: [0, 3.14159265359], phiGrid: [0, 6.28318530718] };
        }
        onUpdate(newMesh);
    };

    return (
        <div className='mesh-editor'>
            <div className='editor-header'>
                <h3>
                    <i className='codicon codicon-table'></i>
                    Edit Mesh #{mesh.id}
                </h3>
                <p className='editor-description'>Configure mesh geometry for spatial tallying</p>
            </div>
            
            <div className='editor-sections'>
                <div className='editor-section'>
                    <h4>
                        <i className='codicon codicon-settings-gear'></i>
                        Mesh Settings
                    </h4>
                    <p className='section-description'>Define the mesh name and coordinate system for spatial tallying.</p>
                    <div className='form-group'>
                        <label>Name</label>
                        <input 
                            type='text' 
                            value={mesh.name || ''} 
                            onChange={(e) => onUpdate({ name: e.target.value })}
                            placeholder={`Mesh ${mesh.id}`}
                        />
                        <p className='form-hint'>Optional descriptive name for this mesh</p>
                    </div>
                    <div className='form-group'>
                        <Tooltip content='Coordinate system for spatial discretization' position='top'>
                            <label>Type</label>
                        </Tooltip>
                        <select value={mesh.type} onChange={handleTypeChange}>
                            <option value='regular'>Regular (Cartesian)</option>
                            <option value='cylindrical'>Cylindrical</option>
                            <option value='spherical'>Spherical</option>
                        </select>
                        <p className='form-hint'>Coordinate system for mesh grid: Cartesian, cylindrical, or spherical</p>
                    </div>
                </div>
                
                {mesh.type === 'regular' && (
                    <div className='editor-section'>
                        <h4>
                            <i className='codicon codicon-graph'></i>
                            Cartesian Grid
                        </h4>
                        <p className='section-description'>Define bounding box and number of cells in X, Y, Z directions.</p>
                        {renderRegularMeshEditor(mesh as OpenMCRegularMesh, onUpdate, dagmcBoundingBox)}
                    </div>
                )}
                
                {mesh.type === 'cylindrical' && (
                    <div className='editor-section'>
                        <h4>
                            <i className='codicon codicon-circle-outline'></i>
                            Cylindrical Grid
                        </h4>
                        <p className='section-description'>Define grid boundaries in cylindrical coordinates: r (radius), φ (azimuthal), z (vertical).</p>
                        {renderCylindricalMeshEditor(mesh as OpenMCCylindricalMesh, onUpdate)}
                    </div>
                )}
                
                {mesh.type === 'spherical' && (
                    <div className='editor-section'>
                        <h4>
                            <i className='codicon codicon-globe'></i>
                            Spherical Grid
                        </h4>
                        <p className='section-description'>Define grid boundaries in spherical coordinates: r (radius), θ (polar), φ (azimuthal).</p>
                        {renderSphericalMeshEditor(mesh as OpenMCSphericalMesh, onUpdate)}
                    </div>
                )}
            </div>
        </div>
    );
};

function renderRegularMeshEditor(
    mesh: OpenMCRegularMesh, 
    onUpdate: (updates: Partial<OpenMCRegularMesh>) => void,
    dagmcBoundingBox?: { min: [number, number, number]; max: [number, number, number] }
) {
    const updateCoord = (field: 'lowerLeft' | 'upperRight', index: number, value: string) => {
        const num = parseFloat(value);
        if (isNaN(num)) return;
        const newCoords = [...mesh[field]] as [number, number, number];
        newCoords[index] = num;
        onUpdate({ [field]: newCoords });
    };

    const updateDim = (index: number, value: string) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num <= 0) return;
        const newDim = [...mesh.dimension] as [number, number, number];
        newDim[index] = num;
        onUpdate({ dimension: newDim });
    };

    const setFromGeometry = () => {
        if (dagmcBoundingBox) {
            onUpdate({
                lowerLeft: [...dagmcBoundingBox.min],
                upperRight: [...dagmcBoundingBox.max]
            });
        }
    };

    return (
        <div className='mesh-type-editor'>
            {dagmcBoundingBox && (
                <div className='editor-toolbar'>
                    <Tooltip content='Set mesh bounds from DAGMC geometry bounding box' position='top'>
                        <button className='add-button' onClick={setFromGeometry}>
                            <i className='codicon codicon-target'></i> Set from Geometry Bounds
                        </button>
                    </Tooltip>
                </div>
            )}
            <div className='form-row'>
                <div className='form-group'>
                    <label>Lower Left (x, y, z)</label>
                    <div className='coord-inputs'>
                        <input type='number' value={mesh.lowerLeft[0]} onChange={(e) => updateCoord('lowerLeft', 0, e.target.value)} />
                        <input type='number' value={mesh.lowerLeft[1]} onChange={(e) => updateCoord('lowerLeft', 1, e.target.value)} />
                        <input type='number' value={mesh.lowerLeft[2]} onChange={(e) => updateCoord('lowerLeft', 2, e.target.value)} />
                    </div>
                    <p className='form-hint'>Minimum coordinates of bounding box (cm)</p>
                </div>
            </div>
            <div className='form-row'>
                <div className='form-group'>
                    <label>Upper Right (x, y, z)</label>
                    <div className='coord-inputs'>
                        <input type='number' value={mesh.upperRight[0]} onChange={(e) => updateCoord('upperRight', 0, e.target.value)} />
                        <input type='number' value={mesh.upperRight[1]} onChange={(e) => updateCoord('upperRight', 1, e.target.value)} />
                        <input type='number' value={mesh.upperRight[2]} onChange={(e) => updateCoord('upperRight', 2, e.target.value)} />
                    </div>
                    <p className='form-hint'>Maximum coordinates of bounding box (cm)</p>
                </div>
            </div>
            <div className='form-row'>
                <div className='form-group'>
                    <label>Dimension (nx, ny, nz)</label>
                    <div className='coord-inputs'>
                        <input type='number' value={mesh.dimension[0]} onChange={(e) => updateDim(0, e.target.value)} min='1' />
                        <input type='number' value={mesh.dimension[1]} onChange={(e) => updateDim(1, e.target.value)} min='1' />
                        <input type='number' value={mesh.dimension[2]} onChange={(e) => updateDim(2, e.target.value)} min='1' />
                    </div>
                    <p className='form-hint'>Number of mesh cells in each direction (must be ≥1)</p>
                </div>
            </div>
        </div>
    );
}

function renderCylindricalMeshEditor(mesh: OpenMCCylindricalMesh, onUpdate: (updates: Partial<OpenMCCylindricalMesh>) => void) {
    const handleGridChange = (field: 'rGrid' | 'phiGrid' | 'zGrid', value: string) => {
        const parts = value.split(/\s+/).map(p => parseFloat(p)).filter(p => !isNaN(p));
        onUpdate({ [field]: parts });
    };

    return (
        <div className='mesh-type-editor'>
            <div className='form-group'>
                <label>r-Grid (boundaries)</label>
                <input 
                    type='text' 
                    value={mesh.rGrid.join(' ')} 
                    onChange={(e) => handleGridChange('rGrid', e.target.value)}
                    placeholder='e.g. 0 5 10'
                />
                <p className='form-hint'>Radial grid boundaries (cm), space-separated values</p>
            </div>
            <div className='form-group'>
                <label>phi-Grid (boundaries in radians)</label>
                <input 
                    type='text' 
                    value={mesh.phiGrid.join(' ')} 
                    onChange={(e) => handleGridChange('phiGrid', e.target.value)}
                    placeholder='e.g. 0 1.57 3.14 4.71 6.28'
                />
                <p className='form-hint'>Azimuthal grid boundaries (radians), 0 to 2π, space-separated</p>
            </div>
            <div className='form-group'>
                <label>z-Grid (boundaries)</label>
                <input 
                    type='text' 
                    value={mesh.zGrid.join(' ')} 
                    onChange={(e) => handleGridChange('zGrid', e.target.value)}
                    placeholder='e.g. -10 0 10'
                />
                <p className='form-hint'>Vertical grid boundaries (cm), space-separated values</p>
            </div>
        </div>
    );
}

function renderSphericalMeshEditor(mesh: OpenMCSphericalMesh, onUpdate: (updates: Partial<OpenMCSphericalMesh>) => void) {
    const handleGridChange = (field: 'rGrid' | 'thetaGrid' | 'phiGrid', value: string) => {
        const parts = value.split(/\s+/).map(p => parseFloat(p)).filter(p => !isNaN(p));
        onUpdate({ [field]: parts });
    };

    return (
        <div className='mesh-type-editor'>
            <div className='form-group'>
                <label>r-Grid (boundaries)</label>
                <input 
                    type='text' 
                    value={mesh.rGrid.join(' ')} 
                    onChange={(e) => handleGridChange('rGrid', e.target.value)}
                    placeholder='e.g. 0 5 10'
                />
                <p className='form-hint'>Radial grid boundaries (cm), space-separated values</p>
            </div>
            <div className='form-group'>
                <label>theta-Grid (boundaries in radians, 0 to π)</label>
                <input 
                    type='text' 
                    value={mesh.thetaGrid.join(' ')} 
                    onChange={(e) => handleGridChange('thetaGrid', e.target.value)}
                    placeholder='e.g. 0 1.57 3.14'
                />
                <p className='form-hint'>Polar angle grid boundaries (radians), 0 to π, space-separated</p>
            </div>
            <div className='form-group'>
                <label>phi-Grid (boundaries in radians, 0 to 2π)</label>
                <input 
                    type='text' 
                    value={mesh.phiGrid.join(' ')} 
                    onChange={(e) => handleGridChange('phiGrid', e.target.value)}
                    placeholder='e.g. 0 3.14 6.28'
                />
                <p className='form-hint'>Azimuthal grid boundaries (radians), 0 to 2π, space-separated</p>
            </div>
        </div>
    );
}
