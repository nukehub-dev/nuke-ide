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
import { OpenMCTally, OpenMCMesh, OpenMCTallyScore } from '../../../../common/openmc-state-schema';
import { ScoreSelector } from './score-selector';
import { FilterBuilder } from './filter-builder';
import { NuclideSelector } from './nuclide-selector';

/**
 * Props for the {@link TallyEditor} component.
 */
interface TallyEditorProps {
    /** Tally to edit */
    tally: OpenMCTally;
    /** Available meshes for mesh filter selection */
    meshes: OpenMCMesh[];
    /** Callback when tally properties change */
    onUpdate: (updates: Partial<OpenMCTally>) => void;
}

/**
 * Editor for configuring an individual OpenMC tally.
 *
 * Provides sections for basic settings (name, estimator), scores, filters, and nuclides.
 * Also displays validation warnings for incompatible estimator / score combinations.
 *
 * @see {@link TallyList}
 * @see {@link ScoreSelector}
 * @see {@link FilterBuilder}
 * @see {@link NuclideSelector}
 */
export const TallyEditor: React.FC<TallyEditorProps> = ({ tally, meshes, onUpdate }) => {
    const hasMeshFilter = tally.filters.some((f) => f.type === 'mesh');
    const isTrackLength = tally.estimator === 'tracklength';
    const showTrackLengthWarning = isTrackLength && !hasMeshFilter;

    // In OpenMC, track-length estimator only works with flux score
    const trackLengthCompatibleScores: OpenMCTallyScore[] = ['flux'];
    const hasIncompatibleScores = isTrackLength && tally.scores.some((s) => !trackLengthCompatibleScores.includes(s));
    const incompatibleScores = tally.scores.filter((s) => !trackLengthCompatibleScores.includes(s));

    return (
        <div className="tally-editor">
            <div className="editor-header">
                <h3>
                    <i className="codicon codicon-graph-line"></i>
                    Edit Tally #{tally.id}
                </h3>
                <p className="editor-description">Configure tally parameters, scores, filters, and nuclides</p>
            </div>

            <div className="editor-sections">
                <div className="editor-section">
                    <h4>
                        <i className="codicon codicon-settings-gear"></i>
                        Basic Settings
                    </h4>
                    <p className="section-description">
                        Configure tally name and scoring method. The estimator determines how particle contributions are calculated.
                    </p>
                    <div className="form-group">
                        <Tooltip content="Descriptive name for this tally" position="top">
                            <label>Name</label>
                        </Tooltip>
                        <input
                            type="text"
                            value={tally.name || ''}
                            onChange={(e) => onUpdate({ name: e.target.value })}
                            placeholder={`Tally ${tally.id}`}
                        />
                    </div>
                    <div className="form-group">
                        <Tooltip content="Method for estimating particle contributions to tallies" position="top">
                            <label>Estimator</label>
                        </Tooltip>
                        <select value={tally.estimator || 'tracklength'} onChange={(e) => onUpdate({ estimator: e.target.value as any })}>
                            <option value="tracklength">Tracklength (default)</option>
                            <option value="analog">Analog</option>
                            <option value="collision">Collision</option>
                        </select>
                        <p className="form-hint">Determines how scores are calculated</p>
                        {showTrackLengthWarning && (
                            <p className="validation-warning">
                                <i className="codicon codicon-warning"></i>
                                Track-length estimator requires a mesh filter. Please add a mesh filter or switch to collision/analog
                                estimator.
                            </p>
                        )}
                        {hasIncompatibleScores && (
                            <p className="validation-error">
                                <i className="codicon codicon-error"></i>
                                Track-length estimator only works with the 'flux' score. Score(s) '{incompatibleScores.join(', ')}' require
                                collision or analog estimator.
                            </p>
                        )}
                    </div>
                </div>

                <div className="editor-section">
                    <h4>
                        <i className="codicon codicon-check"></i>
                        Scores
                    </h4>
                    <p className="section-description">
                        Select physical quantities to measure: flux (particle flow), fission rates, heating, etc.
                    </p>
                    <ScoreSelector scores={tally.scores} onUpdate={(scores) => onUpdate({ scores })} />
                </div>

                <div className="editor-section">
                    <h4>
                        <i className="codicon codicon-filter"></i>
                        Filters
                    </h4>
                    <p className="section-description">Limit tally scoring to specific regions, energies, or cells.</p>
                    <FilterBuilder filters={tally.filters} meshes={meshes} onUpdate={(filters) => onUpdate({ filters })} />
                </div>

                <div className="editor-section">
                    <h4>
                        <i className="codicon codicon-tag"></i>
                        Nuclides
                    </h4>
                    <p className="section-description">
                        Specify which nuclides (isotopes) to tally. Use "total" for all neutrons, or individual nuclides like U235.
                    </p>
                    <NuclideSelector nuclides={tally.nuclides} onUpdate={(nuclides) => onUpdate({ nuclides })} />
                </div>
            </div>
        </div>
    );
};
