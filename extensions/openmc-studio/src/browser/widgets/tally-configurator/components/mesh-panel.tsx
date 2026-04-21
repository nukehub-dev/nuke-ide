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
import { OpenMCMesh } from '../../../../common/openmc-state-schema';

/**
 * Props for the {@link MeshPanel} component.
 */
interface MeshPanelProps {
    /** List of defined meshes */
    meshes: OpenMCMesh[];
    /** ID of the currently selected mesh */
    selectedMeshId?: number;
    /** Called when a mesh is selected */
    onSelectMesh: (id: number) => void;
    /** Called to add a new mesh */
    onAddMesh: () => void;
    /** Called to delete a mesh by ID */
    onDeleteMesh: (id: number) => void;
}

/**
 * Panel displaying a list of configured meshes with add/delete actions.
 *
 * @see {@link MeshEditor}
 * @see {@link TallyConfiguratorWidget}
 */
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

/**
 * Get the codicon class for a mesh type.
 * @param type - Mesh coordinate system type.
 * @returns Codicon CSS class string.
 */
function getMeshIcon(type: string): string {
    switch (type) {
        case 'regular': return 'codicon-table';
        case 'cylindrical': return 'codicon-circle-outline';
        case 'spherical': return 'codicon-globe';
        default: return 'codicon-symbol-misc';
    }
}

/**
 * Get a short human-readable description of a mesh.
 * @param mesh - The mesh to describe.
 * @returns Description string.
 */
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
