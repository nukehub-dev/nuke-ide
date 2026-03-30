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
import { OpenMCTally, OpenMCMesh, OpenMCTallyScore } from '../../../common/openmc-state-schema';
import { ScoreSelector } from './score-selector';
import { FilterBuilder } from './filter-builder';
import { NuclideSelector } from './nuclide-selector';

interface TallyEditorProps {
    tally: OpenMCTally;
    meshes: OpenMCMesh[];
    onUpdate: (updates: Partial<OpenMCTally>) => void;
}

export const TallyEditor: React.FC<TallyEditorProps> = ({ tally, meshes, onUpdate }) => {
    const hasMeshFilter = tally.filters.some(f => f.type === 'mesh');
    const isTrackLength = tally.estimator === 'tracklength';
    const showTrackLengthWarning = isTrackLength && !hasMeshFilter;

    // In OpenMC, track-length estimator only works with flux score
    const trackLengthCompatibleScores: OpenMCTallyScore[] = ['flux'];
    const hasIncompatibleScores = isTrackLength && tally.scores.some(s => !trackLengthCompatibleScores.includes(s));
    const incompatibleScores = tally.scores.filter(s => !trackLengthCompatibleScores.includes(s));

    return (
        <div className='tally-editor'>
            <div className='editor-header'>
                <h3>
                    <i className='codicon codicon-graph-line'></i>
                    Edit Tally #{tally.id}
                </h3>
                <p className='editor-description'>Configure tally parameters, scores, filters, and nuclides</p>
            </div>
            
            <div className='editor-sections'>
                <div className='editor-section'>
                    <h4>
                        <i className='codicon codicon-settings-gear'></i>
                        Basic Settings
                    </h4>
                    <p className='section-description'>Configure tally name and scoring method. The estimator determines how particle contributions are calculated.</p>
                    <div className='form-group'>
                        <Tooltip content='Descriptive name for this tally' position='top'>
                            <label>Name</label>
                        </Tooltip>
                        <input 
                            type='text' 
                            value={tally.name || ''} 
                            onChange={(e) => onUpdate({ name: e.target.value })}
                            placeholder={`Tally ${tally.id}`}
                        />
                    </div>
                    <div className='form-group'>
                        <Tooltip content='Method for estimating particle contributions to tallies' position='top'>
                            <label>Estimator</label>
                        </Tooltip>
                        <select 
                            value={tally.estimator || 'tracklength'} 
                            onChange={(e) => onUpdate({ estimator: e.target.value as any })}
                        >
                            <option value='tracklength'>Tracklength (default)</option>
                            <option value='analog'>Analog</option>
                            <option value='collision'>Collision</option>
                        </select>
                        <p className='form-hint'>Determines how scores are calculated</p>
                        {showTrackLengthWarning && (
                            <p className='validation-warning'>
                                <i className='codicon codicon-warning'></i>
                                Track-length estimator requires a mesh filter. Please add a mesh filter or switch to collision/analog estimator.
                            </p>
                        )}
                        {hasIncompatibleScores && (
                            <p className='validation-error'>
                                <i className='codicon codicon-error'></i>
                                Track-length estimator only works with the 'flux' score. 
                                Score(s) '{incompatibleScores.join(', ')}' require collision or analog estimator.
                            </p>
                        )}
                    </div>
                </div>
                
                <div className='editor-section'>
                    <h4>
                        <i className='codicon codicon-check'></i>
                        Scores
                    </h4>
                    <p className='section-description'>Select physical quantities to measure: flux (particle flow), fission rates, heating, etc.</p>
                    <ScoreSelector 
                        scores={tally.scores} 
                        onUpdate={(scores) => onUpdate({ scores })} 
                    />
                </div>
                
                <div className='editor-section'>
                    <h4>
                        <i className='codicon codicon-filter'></i>
                        Filters
                    </h4>
                    <p className='section-description'>Limit tally scoring to specific regions, energies, or cells.</p>
                    <FilterBuilder 
                        filters={tally.filters} 
                        meshes={meshes}
                        onUpdate={(filters) => onUpdate({ filters })} 
                    />
                </div>
                
                <div className='editor-section'>
                    <h4>
                        <i className='codicon codicon-tag'></i>
                        Nuclides
                    </h4>
                    <p className='section-description'>Specify which nuclides (isotopes) to tally. Use "total" for all neutrons, or individual nuclides like U235.</p>
                    <NuclideSelector 
                        nuclides={tally.nuclides} 
                        onUpdate={(nuclides) => onUpdate({ nuclides })} 
                    />
                </div>
            </div>
        </div>
    );
};
