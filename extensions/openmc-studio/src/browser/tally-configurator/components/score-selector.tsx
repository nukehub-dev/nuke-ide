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
import { OpenMCTallyScore } from '../../../common/openmc-state-schema';

interface ScoreSelectorProps {
    scores: OpenMCTallyScore[];
    onUpdate: (scores: OpenMCTallyScore[]) => void;
}

const AVAILABLE_SCORES: { category: string, scores: { value: OpenMCTallyScore, label: string }[] }[] = [
    {
        category: 'Basic',
        scores: [
            { value: 'flux', label: 'Flux' },
            { value: 'total', label: 'Total' },
            { value: 'absorption', label: 'Absorption' },
            { value: 'fission', label: 'Fission' },
        ]
    },
    {
        category: 'Reaction Rates',
        scores: [
            { value: 'scatter', label: 'Scatter' },
            { value: 'elastic', label: 'Elastic' },
            { value: 'nu-fission', label: 'nu-Fission' },
            { value: 'nu-scatter', label: 'nu-Scatter' },
            { value: 'kappa-fission', label: 'kappa-Fission' },
            { value: 'prompt-nu-fission', label: 'Prompt nu-Fission' },
            { value: 'delayed-nu-fission', label: 'Delayed nu-Fission' },
        ]
    },
    {
        category: 'Legendre Moments',
        scores: [
            { value: 'scatter-1', label: 'P1 Scatter' },
            { value: 'scatter-2', label: 'P2 Scatter' },
            { value: 'scatter-3', label: 'P3 Scatter' },
            { value: 'scatter-4', label: 'P4 Scatter' },
            { value: 'nu-fission-1', label: 'P1 nu-Fission' },
            { value: 'nu-fission-2', label: 'P2 nu-Fission' },
            { value: 'nu-fission-3', label: 'P3 nu-Fission' },
            { value: 'nu-fission-4', label: 'P4 nu-Fission' },
        ]
    },
    {
        category: 'Advanced',
        scores: [
            { value: 'current', label: 'Current' },
            { value: 'heating', label: 'Heating' },
            { value: 'heating-local', label: 'Heating (Local)' },
            { value: 'events', label: 'Events' },
            { value: 'inverse-velocity', label: 'Inverse Velocity' },
            { value: 'activation', label: 'Activation' },
        ]
    }
];

export const ScoreSelector: React.FC<ScoreSelectorProps> = ({ scores, onUpdate }) => {
    const toggleScore = (score: OpenMCTallyScore) => {
        if (scores.includes(score)) {
            onUpdate(scores.filter(s => s !== score));
        } else {
            onUpdate([...scores, score]);
        }
    };

    return (
        <div className='score-selector'>
            <div className='score-categories'>
                {AVAILABLE_SCORES.map(cat => (
                    <div key={cat.category} className='score-category'>
                        <div className='category-label'>{cat.category}</div>
                        <div className='score-grid'>
                            {cat.scores.map(s => (
                                <label key={s.value} className='score-checkbox-label'>
                                    <input 
                                        type='checkbox' 
                                        checked={scores.includes(s.value)} 
                                        onChange={() => toggleScore(s.value)}
                                    />
                                    <span>{s.label}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
