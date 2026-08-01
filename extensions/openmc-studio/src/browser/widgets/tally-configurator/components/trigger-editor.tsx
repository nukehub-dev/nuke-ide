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
import { OpenMCTallyScore, OpenMCTallyTrigger, OpenMCTallyTriggerType } from '../../../../common/openmc-state-schema';

/**
 * Props for the {@link TriggerEditor} component.
 */
interface TriggerEditorProps {
    /** Triggers defined on the tally */
    triggers: OpenMCTallyTrigger[];
    /** The tally's selected scores (options for per-trigger score subsets) */
    tallyScores: OpenMCTallyScore[];
    /** Run-level trigger evaluation interval in batches (settings.triggers.batchInterval) */
    batchInterval?: number;
    /** Callback when the trigger list changes */
    onUpdate: (triggers: OpenMCTallyTrigger[]) => void;
}

/**
 * Editor for per-tally triggers (openmc.Trigger): finish the simulation when
 * the tally's uncertainties meet a criterion. Each trigger has a type, a
 * threshold, and an optional score subset (empty = all of the tally's
 * scores). Requires run-level trigger activation, which the generators emit
 * automatically; the evaluation interval is the run-level batch interval.
 *
 * @see {@link TallyEditor}
 */
export const TriggerEditor: React.FC<TriggerEditorProps> = ({ triggers, tallyScores, batchInterval, onUpdate }) => {
    const updateTrigger = (index: number, updates: Partial<OpenMCTallyTrigger>): void => {
        onUpdate(triggers.map((t, i) => (i === index ? { ...t, ...updates } : t)));
    };

    const toggleScore = (index: number, score: string): void => {
        const current = triggers[index].scores ?? [];
        const next = current.includes(score) ? current.filter((s) => s !== score) : [...current, score];
        // An empty subset means "all scores" (trigger.py: scores attribute omitted)
        updateTrigger(index, { scores: next.length > 0 ? next : undefined });
    };

    return (
        <div className="trigger-editor">
            {triggers.map((trigger, index) => (
                <div className="form-row" key={index}>
                    <div className="form-group">
                        <label>Type</label>
                        <select
                            value={trigger.type}
                            onChange={(e) => updateTrigger(index, { type: e.target.value as OpenMCTallyTriggerType })}
                        >
                            <option value="rel_err">Relative Error</option>
                            <option value="std_dev">Standard Deviation</option>
                            <option value="variance">Variance</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Threshold</label>
                        <input
                            type="number"
                            min={0}
                            step="any"
                            value={trigger.threshold}
                            onChange={(e) => updateTrigger(index, { threshold: parseFloat(e.target.value) || 0 })}
                        />
                    </div>
                    <div className="form-group checkbox">
                        <label>&nbsp;</label>
                        <label>
                            <input
                                type="checkbox"
                                checked={trigger.ignoreZeros ?? false}
                                onChange={(e) => updateTrigger(index, { ignoreZeros: e.target.checked ? true : undefined })}
                            />
                            Ignore zeros
                        </label>
                    </div>
                    <div className="form-group">
                        <label>&nbsp;</label>
                        <button className="remove-filter-btn" onClick={() => onUpdate(triggers.filter((_, i) => i !== index))}>
                            <i className="codicon codicon-trash"></i>
                        </button>
                    </div>
                    {tallyScores.length > 0 && (
                        <div className="form-group">
                            <label>Scores (none checked = all)</label>
                            <div className="checkbox-row">
                                {tallyScores.map((score) => (
                                    <label key={score} className="score-checkbox-label">
                                        <input
                                            type="checkbox"
                                            checked={trigger.scores?.includes(score) ?? false}
                                            onChange={() => toggleScore(index, score)}
                                        />
                                        {score}
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            ))}

            <button
                className="add-button"
                onClick={() => onUpdate([...triggers, { type: 'rel_err', threshold: 0.01 }])}
                disabled={tallyScores.length === 0}
            >
                <i className="codicon codicon-add"></i> Add Trigger
            </button>
            {tallyScores.length === 0 && <p className="form-hint">Select tally scores first — triggers are evaluated per score.</p>}
            {triggers.length > 0 && (
                <p className="form-hint">
                    Trigger evaluation runs every {batchInterval ?? 1} batch(es) — set the interval under Settings → Output → Tally
                    Triggers. The run stops when the threshold is met (or max batches is reached).
                </p>
            )}
        </div>
    );
};
