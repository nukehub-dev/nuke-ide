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
import { OpenMCMesh } from '../../../common/openmc-state-schema';

interface MeshPanelProps {
    meshes: OpenMCMesh[];
    selectedMeshId?: number;
    onSelectMesh: (id: number) => void;
    onAddMesh: () => void;
    onDeleteMesh: (id: number) => void;
}

export const MeshPanel: React.FC<MeshPanelProps> = ({ 
    meshes, 
    selectedMeshId, 
    onSelectMesh, 
    onAddMesh, 
    onDeleteMesh 
}) => {
    return (
        <div className='mesh-list-panel'>
            <div className='panel-header'>
                <h3>
                    <i className='codicon codicon-table'></i>
                    Meshes ({meshes.length})
                </h3>
                <Tooltip content='Create a new mesh' position='bottom'>
                    <button className='add-button' onClick={onAddMesh}>
                        <i className='codicon codicon-add'></i> Add
                    </button>
                </Tooltip>
            </div>
            <div className='list-container'>
                {meshes.length === 0 ? (
                    <div className='empty-state'>
                        <i className='codicon codicon-table'></i>
                        <p>No meshes defined</p>
                        <p className='empty-hint'>Click "Add" to create a new mesh</p>
                    </div>
                ) : (
                    meshes.map(mesh => (
                        <div 
                            key={mesh.id} 
                            className={`mesh-card ${selectedMeshId === mesh.id ? 'active' : ''}`}
                            onClick={() => onSelectMesh(mesh.id)}
                        >
                            <div className='mesh-item-main'>
                                <div className='mesh-item-info'>
                                    <span className='mesh-item-id'>#{mesh.id}</span>
                                    <span className='mesh-item-name'>{mesh.name || `Mesh ${mesh.id}`}</span>
                                    <span className={`mesh-type-badge ${mesh.type}`}>
                                        <i className={`codicon ${getMeshIcon(mesh.type)}`}></i>
                                        {mesh.type}
                                    </span>
                                </div>
                                <div className='mesh-item-actions'>
                                    <Tooltip content='Delete this mesh' position='top'>
                                        <button 
                                            className='delete-item-btn' 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDeleteMesh(mesh.id);
                                            }}
                                        >
                                            <i className='codicon codicon-trash'></i>
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>
                            <div className='mesh-item-details'>
                                <div className='mesh-dimensions'>
                                    <i className='codicon codicon-ruler'></i>
                                    <span>{getMeshDescription(mesh)}</span>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

function getMeshIcon(type: string): string {
    switch (type) {
        case 'regular': return 'codicon-table';
        case 'cylindrical': return 'codicon-circle-outline';
        case 'spherical': return 'codicon-globe';
        default: return 'codicon-symbol-misc';
    }
}

function getMeshDescription(mesh: OpenMCMesh): string {
    switch (mesh.type) {
        case 'regular':
            return `${mesh.dimension?.[0] || 0}×${mesh.dimension?.[1] || 0}×${mesh.dimension?.[2] || 0} cells`;
        case 'cylindrical':
            return `Cylindrical (r, φ, z)`;
        case 'spherical':
            return `Spherical (r, θ, φ)`;
        default:
            return 'Unknown mesh type';
    }
}
