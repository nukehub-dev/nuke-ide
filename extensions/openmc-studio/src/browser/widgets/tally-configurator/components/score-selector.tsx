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
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF PROVIDED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

import * as React from 'react';
import { OpenMCTallyScore } from '../../../../common/openmc-state-schema';
import { getScoresByCategory, getScoreEntry, isCustomMtScore } from '../../../../common/scores-catalog';

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
 * Component for selecting physical quantities (scores) to tally.
 *
 * Renders the full OpenMC score catalog (see `src/common/scores-catalog.ts`)
 * grouped into collapsible categories, plus a custom integer-MT input. Scores
 * already on the tally that are not in the catalog (custom MTs, legacy names)
 * stay visible in a "Custom / Legacy" group so existing tallies keep working.
 *
 * @see {@link TallyEditor}
 */
export const ScoreSelector: React.FC<ScoreSelectorProps> = ({ scores, onUpdate }) => {
    const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({ basic: false });
    const [customMt, setCustomMt] = React.useState('');

    /** Toggle a score in or out of the current selection. */
    const toggleScore = (score: OpenMCTallyScore) => {
        if (scores.includes(score)) {
            onUpdate(scores.filter((s) => s !== score));
        } else {
            onUpdate([...scores, score]);
        }
    };

    /** Toggle a category's collapsed state. */
    const toggleCategory = (category: string) => {
        setCollapsed({ ...collapsed, [category]: !(collapsed[category] ?? true) });
    };

    /** Scores on the tally that are not in the catalog (custom MTs, legacy names). */
    const customScores = scores.filter((s) => !getScoreEntry(s));

    /** Add the custom MT number from the input to the selection. */
    const addCustomMt = () => {
        const mt = customMt.trim();
        if (isCustomMtScore(mt) && !scores.includes(mt)) {
            onUpdate([...scores, mt]);
        }
        setCustomMt('');
    };

    return (
        <div className="score-selector">
            <div className="score-categories">
                {getScoresByCategory().map((cat) => {
                    const isCollapsed = collapsed[cat.category] ?? cat.category !== 'basic';
                    return (
                        <div key={cat.category} className="score-category">
                            <div className="category-label" onClick={() => toggleCategory(cat.category)} style={{ cursor: 'pointer' }}>
                                <i className={`codicon codicon-chevron-${isCollapsed ? 'right' : 'down'}`}></i>
                                {cat.label}
                            </div>
                            {!isCollapsed && (
                                <div className="score-grid">
                                    {cat.scores.map((s) => (
                                        <label key={s.name} className="score-checkbox-label">
                                            <input type="checkbox" checked={scores.includes(s.name)} onChange={() => toggleScore(s.name)} />
                                            <span>{s.label}</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
                {customScores.length > 0 && (
                    <div className="score-category">
                        <div className="category-label">Custom / Legacy</div>
                        <div className="score-grid">
                            {customScores.map((s) => (
                                <label key={s} className="score-checkbox-label">
                                    <input type="checkbox" checked onChange={() => toggleScore(s)} />
                                    <span>{s}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            <div className="custom-mt-input" style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <input
                    type="text"
                    value={customMt}
                    placeholder="Custom MT number (e.g. 102)"
                    onChange={(e) => setCustomMt(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            addCustomMt();
                        }
                    }}
                />
                <button className="theia-button secondary small" onClick={addCustomMt} disabled={!isCustomMtScore(customMt.trim())}>
                    <i className="codicon codicon-add"></i> Add MT
                </button>
            </div>
        </div>
    );
};
