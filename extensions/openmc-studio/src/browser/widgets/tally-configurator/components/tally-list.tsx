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
import { OpenMCTally } from '../../../../common/openmc-state-schema';

/**
 * Props for the {@link TallyList} component.
 */
interface TallyListProps {
    /** List of defined tallies */
    tallies: OpenMCTally[];
    /** ID of the currently selected tally */
    selectedTallyId?: number;
    /** Called when a tally is selected */
    onSelectTally: (id: number) => void;
    /** Called to add a new tally */
    onAddTally: () => void;
    /** Called to delete a tally by ID */
    onDeleteTally: (id: number) => void;
}

/**
 * Panel displaying a list of configured tallies with add/delete actions.
 *
 * @see {@link TallyEditor}
 * @see {@link TallyConfiguratorWidget}
 */
export const TallyList: React.FC<TallyListProps> = ({ 
    tallies, 
    selectedTallyId, 
    onSelectTally, 
    onAddTally, 
    onDeleteTally 
}) => {
    return (
        <div className='tally-list-panel'>
            <div className='panel-header'>
                <h3>
                    <i className='codicon codicon-graph-line'></i>
                    Tallies ({tallies.length})
                </h3>
                <Tooltip content='Create a new tally' position='bottom'>
                    <button className='add-button' onClick={onAddTally}>
                        <i className='codicon codicon-add'></i> Add
                    </button>
                </Tooltip>
            </div>
            <div className='list-container'>
                {tallies.length === 0 ? (
                    <div className='empty-state'>
                        <i className='codicon codicon-graph-line'></i>
                        <p>No tallies defined</p>
                        <p className='empty-hint'>Click "Add" to create a new tally</p>
                    </div>
                ) : (
                    tallies.map(tally => (
                        <div 
                            key={tally.id} 
                            className={`tally-card ${selectedTallyId === tally.id ? 'active' : ''}`}
                            onClick={() => onSelectTally(tally.id)}
                        >
                            <div className='tally-item-main'>
                                <div className='tally-item-info'>
                                    <span className='tally-item-id'>#{tally.id}</span>
                                    <span className='tally-item-name'>{tally.name || `Tally ${tally.id}`}</span>
                                </div>
                                <div className='tally-item-actions'>
                                    <Tooltip content='Delete this tally' position='top'>
                                        <button 
                                            className='delete-item-btn' 
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onDeleteTally(tally.id);
                                            }}
                                        >
                                            <i className='codicon codicon-trash'></i>
                                        </button>
                                    </Tooltip>
                                </div>
                            </div>
                            <div className='tally-item-details'>
                                <div className='tally-scores'>
                                    <i className='codicon codicon-check'></i>
                                    <span>{tally.scores.length} score{tally.scores.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div className='tally-filters'>
                                    <i className='codicon codicon-filter'></i>
                                    <span>{tally.filters.length} filter{tally.filters.length !== 1 ? 's' : ''}</span>
                                </div>
                                <div className='tally-nuclides'>
                                    <i className='codicon codicon-tag'></i>
                                    <span>{tally.nuclides.length} nuclide{tally.nuclides.length !== 1 ? 's' : ''}</span>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};
