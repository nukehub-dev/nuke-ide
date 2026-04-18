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
import { OpenMCTally } from '../../../../common/openmc-state-schema';

interface TallyListProps {
    tallies: OpenMCTally[];
    selectedTallyId?: number;
    onSelectTally: (id: number) => void;
    onAddTally: () => void;
    onDeleteTally: (id: number) => void;
}

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
