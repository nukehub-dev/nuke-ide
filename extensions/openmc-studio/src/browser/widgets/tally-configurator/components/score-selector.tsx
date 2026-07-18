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
import { OpenMCTallyScore } from '../../../../common/openmc-state-schema';

/**
 * Props for the {@link ScoreSelector} component.
 */
interface ScoreSelectorProps {
    /** Currently selected scores */
    scores: OpenMCTallyScore[];
    /** Callback when the score selection changes */
    onUpdate: (scores: OpenMCTallyScore[]) => void;
}

/**
 * Categorized list of available OpenMC tally scores.
 */
const AVAILABLE_SCORES: { category: string; scores: { value: OpenMCTallyScore; label: string }[] }[] = [
    {
        category: 'Basic',
        scores: [
            { value: 'flux', label: 'Flux' },
            { value: 'total', label: 'Total' },
            { value: 'absorption', label: 'Absorption' },
            { value: 'fission', label: 'Fission' }
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
            { value: 'delayed-nu-fission', label: 'Delayed nu-Fission' }
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
            { value: 'nu-fission-4', label: 'P4 nu-Fission' }
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
            { value: 'activation', label: 'Activation' }
        ]
    }
];

/**
 * Component for selecting physical quantities (scores) to tally.
 *
 * Scores are organized into categories: Basic, Reaction Rates, Legendre Moments, and Advanced.
 *
 * @see {@link TallyEditor}
 */
export const ScoreSelector: React.FC<ScoreSelectorProps> = ({ scores, onUpdate }) => {
    /** Toggle a score in or out of the current selection. */
    const toggleScore = (score: OpenMCTallyScore) => {
        if (scores.includes(score)) {
            onUpdate(scores.filter((s) => s !== score));
        } else {
            onUpdate([...scores, score]);
        }
    };

    return (
        <div className="score-selector">
            <div className="score-categories">
                {AVAILABLE_SCORES.map((cat) => (
                    <div key={cat.category} className="score-category">
                        <div className="category-label">{cat.category}</div>
                        <div className="score-grid">
                            {cat.scores.map((s) => (
                                <label key={s.value} className="score-checkbox-label">
                                    <input type="checkbox" checked={scores.includes(s.value)} onChange={() => toggleScore(s.value)} />
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
