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

/**
 * @module openmc-studio/browser/widgets
 */

import * as React from 'react';
import { OpenMCDepletion } from '../../../common/openmc-state-schema';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';

/** Props for the {@link DepletionTimeline} component. */
interface DepletionTimelineProps {
    /** The depletion configuration to display and edit. */
    depletion: OpenMCDepletion;
    /** Callback invoked when the depletion configuration changes. */
    onChange: (updates: Partial<OpenMCDepletion>) => void;
    /** Callback invoked to toggle decay-only mode for a specific step. */
    onToggleDecayOnly: (index: number) => void;
}

/** A parsed depletion time step with numeric value and unit. */
interface ParsedStep {
    /** Numeric value of the step. */
    value: number;
    /** Unit of the step (e.g., `s`, `d`, `MWd/kg`). */
    unit: string;
}

/** Mapping of supported time units to their labels and conversion factors. */
const TIME_UNITS: { [key: string]: { label: string; seconds: number } } = {
    s: { label: 'seconds', seconds: 1 },
    min: { label: 'minutes', seconds: 60 },
    h: { label: 'hours', seconds: 3600 },
    d: { label: 'days', seconds: 86400 },
    y: { label: 'years', seconds: 31536000 },
    'MWd/kg': { label: 'MWd/kg', seconds: 0 }
};

/**
 * Interactive timeline editor for OpenMC depletion schedules.
 *
 * Allows users to add, remove, duplicate, and configure time steps
 * for burnup calculations, including toggling decay-only steps.
 *
 * @see {@link OpenMCDepletion} for the underlying data model
 */
export const DepletionTimeline: React.FC<DepletionTimelineProps> = ({ depletion, onChange, onToggleDecayOnly }) => {
    const [selectedStepIndex, setSelectedStepIndex] = React.useState<number>(-1);

    const timeSteps = depletion.timeSteps || [];
    const decayOnlySteps = depletion.decayOnlySteps || [];

    /**
     * Parse a time step string into a numeric value and unit.
     *
     * @param step - The raw step value (string or number).
     * @returns The parsed step with value and unit.
     */
    const parseStep = (step: string | number): ParsedStep => {
        if (typeof step === 'number') {
            return { value: step, unit: 's' };
        }
        const match = step.match(/^(\d+(?:\.\d+)?)\s*([a-z/]+)$/i);
        if (match) {
            return { value: parseFloat(match[1]), unit: match[2] };
        }
        return { value: parseFloat(step) || 0, unit: 's' };
    };

    /**
     * Format a time value with its unit for display.
     *
     * @param value - The numeric value.
     * @param unit - The unit string.
     * @returns A formatted time string.
     */
    const formatTime = (value: number, unit: string): string => {
        if (unit === 'MWd/kg') return `${value.toFixed(2)} MWd/kg`;
        return `${value} ${unit}`;
    };

    /**
     * Calculate the accumulated time in seconds up to a given step index.
     *
     * @param index - The step index to accumulate up to.
     * @returns Total elapsed seconds.
     */
    const calculateAccumulatedTime = (index: number): number => {
        let total = 0;
        for (let i = 0; i <= index && i < timeSteps.length; i++) {
            const step = parseStep(timeSteps[i]);
            const unitInfo = TIME_UNITS[step.unit] || TIME_UNITS['s'];
            if (unitInfo.seconds > 0) {
                total += step.value * unitInfo.seconds;
            }
        }
        return total;
    };

    /**
     * Format an accumulated time in seconds into a human-readable string.
     *
     * @param seconds - Total elapsed seconds.
     * @returns A human-readable duration string.
     */
    const formatAccumulatedTime = (seconds: number): string => {
        if (seconds < 60) return `${seconds.toFixed(0)}s`;
        if (seconds < 3600) return `${(seconds / 60).toFixed(1)}min`;
        if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
        if (seconds < 31536000) return `${(seconds / 86400).toFixed(1)}d`;
        return `${(seconds / 31536000).toFixed(2)}y`;
    };

    /** Append a new default time step to the schedule. */
    const handleAddStep = () => {
        const currentSteps = [...timeSteps].map((s) => String(s));
        const newSteps = [...currentSteps, '30.0 d'];
        onChange({ timeSteps: newSteps });
        setSelectedStepIndex(newSteps.length - 1);
    };

    /**
     * Remove a time step at the specified index.
     *
     * @param index - The index of the step to remove.
     */
    const handleRemoveStep = (index: number) => {
        const newSteps = [...timeSteps].map((s) => String(s));
        newSteps.splice(index, 1);
        onChange({ timeSteps: newSteps });
        if (selectedStepIndex >= newSteps.length) {
            setSelectedStepIndex(Math.max(-1, newSteps.length - 1));
        }
    };

    /**
     * Update the value and unit of a time step.
     *
     * @param index - The step index to update.
     * @param value - The new numeric value.
     * @param unit - The new unit.
     */
    const handleUpdateStep = (index: number, value: number, unit: string) => {
        const newSteps = [...timeSteps].map((s) => String(s));
        newSteps[index] = `${value} ${unit}`;
        onChange({ timeSteps: newSteps });
    };

    /**
     * Duplicate a time step immediately after the specified index.
     *
     * @param index - The step index to duplicate.
     */
    const handleDuplicateStep = (index: number) => {
        const newSteps = [...timeSteps].map((s) => String(s));
        newSteps.splice(index + 1, 0, String(timeSteps[index]));
        onChange({ timeSteps: newSteps });
        setSelectedStepIndex(index + 1);
    };

    const currentStep = selectedStepIndex >= 0 && timeSteps[selectedStepIndex] ? parseStep(timeSteps[selectedStepIndex]) : null;

    const cumulativeTimes = timeSteps.map((_, idx) => calculateAccumulatedTime(idx));

    return (
        <div className="timeline-container">
            <div className="timeline-section-header">
                <div className="timeline-title">
                    <i className="codicon codicon-history"></i>
                    <div>
                        <h3>Operational Timeline</h3>
                        <p>Define time intervals for burnup calculations</p>
                    </div>
                </div>
                <button className="theia-button primary" onClick={handleAddStep}>
                    <i className="codicon codicon-add"></i>
                    Add Step
                </button>
            </div>

            {timeSteps.length === 0 ? (
                <div className="timeline-empty">
                    <div className="timeline-empty-icon">
                        <i className="codicon codicon-history"></i>
                    </div>
                    <h4>No Timeline Steps</h4>
                    <p>Add steps to define your depletion schedule</p>
                    <button className="theia-button secondary" onClick={handleAddStep}>
                        <i className="codicon codicon-add"></i>
                        Add First Step
                    </button>
                </div>
            ) : (
                <>
                    <div className="timeline-visualization">
                        <div className="timeline-track-wrapper">
                            <div className="timeline-track">
                                {timeSteps.map((step, index) => {
                                    const isDecayOnly = decayOnlySteps.includes(index);
                                    const parsed = parseStep(step);
                                    const isSelected = selectedStepIndex === index;
                                    const isLast = index === timeSteps.length - 1;
                                    const accumulatedSeconds = cumulativeTimes[index];

                                    return (
                                        <React.Fragment key={index}>
                                            <Tooltip
                                                content={`Step ${index + 1}: ${formatTime(parsed.value, parsed.unit)} ${isDecayOnly ? '(Decay)' : '(Active'} - Total: ${formatAccumulatedTime(accumulatedSeconds)}`}
                                                position="top"
                                            >
                                                <div
                                                    className={`timeline-step-node ${isSelected ? 'selected' : ''} ${isDecayOnly ? 'decay' : 'active'}`}
                                                    onClick={() => setSelectedStepIndex(index)}
                                                >
                                                    <div className="step-indicator">
                                                        {isDecayOnly ? (
                                                            <i className="codicon codicon-flame"></i>
                                                        ) : (
                                                            <i className="codicon codicon-zap"></i>
                                                        )}
                                                    </div>
                                                    <div className="step-number-badge">{index + 1}</div>
                                                    <div className="step-details">
                                                        <span className="step-value">
                                                            {parsed.value} {parsed.unit}
                                                        </span>
                                                        <span className="step-total">{formatAccumulatedTime(accumulatedSeconds)}</span>
                                                    </div>
                                                </div>
                                            </Tooltip>
                                            {!isLast && (
                                                <div className={`timeline-connector ${isDecayOnly ? 'decay' : 'active'}`}>
                                                    <i className="codicon codicon-chevron-right"></i>
                                                </div>
                                            )}
                                        </React.Fragment>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="timeline-stats">
                            <div className="stat-item">
                                <span className="stat-label">Steps</span>
                                <span className="stat-value">{timeSteps.length}</span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-label">Total Duration</span>
                                <span className="stat-value highlight">
                                    {formatAccumulatedTime(cumulativeTimes[cumulativeTimes.length - 1])}
                                </span>
                            </div>
                            <div className="stat-item">
                                <span className="stat-label">Decay Steps</span>
                                <span className="stat-value">{decayOnlySteps.length}</span>
                            </div>
                        </div>
                    </div>

                    {currentStep && selectedStepIndex >= 0 && (
                        <div className="timeline-editor-panel">
                            <div className="timeline-editor-header">
                                <div className="timeline-editor-title">
                                    <i className="codicon codicon-edit"></i>
                                    <span>Edit Step {selectedStepIndex + 1}</span>
                                    <span className={`step-type-badge ${decayOnlySteps.includes(selectedStepIndex) ? 'decay' : 'active'}`}>
                                        {decayOnlySteps.includes(selectedStepIndex) ? 'Decay Only' : 'Active'}
                                    </span>
                                </div>
                                <div className="timeline-editor-actions">
                                    <Tooltip content="Duplicate" position="top">
                                        <button className="icon-btn" onClick={() => handleDuplicateStep(selectedStepIndex)}>
                                            <i className="codicon codicon-copy"></i>
                                        </button>
                                    </Tooltip>
                                    <Tooltip content="Delete" position="top">
                                        <button className="icon-btn delete" onClick={() => handleRemoveStep(selectedStepIndex)}>
                                            <i className="codicon codicon-trash"></i>
                                        </button>
                                    </Tooltip>
                                    <button className="icon-btn" onClick={() => setSelectedStepIndex(-1)}>
                                        <i className="codicon codicon-close"></i>
                                    </button>
                                </div>
                            </div>

                            <div className="timeline-editor-body">
                                <div className="timeline-editor-fields">
                                    <div className="editor-field">
                                        <label>
                                            <i className="codicon codicon-clock"></i>
                                            Duration
                                        </label>
                                        <div className="duration-input-combo">
                                            <input
                                                type="number"
                                                value={currentStep.value}
                                                onChange={(e) =>
                                                    handleUpdateStep(selectedStepIndex, parseFloat(e.target.value), currentStep.unit)
                                                }
                                                step="any"
                                                min="0"
                                            />
                                            <select
                                                value={currentStep.unit}
                                                onChange={(e) => handleUpdateStep(selectedStepIndex, currentStep.value, e.target.value)}
                                            >
                                                <option value="s">Seconds</option>
                                                <option value="min">Minutes</option>
                                                <option value="h">Hours</option>
                                                <option value="d">Days</option>
                                                <option value="y">Years</option>
                                                <option value="MWd/kg">MWd/kg</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div className="editor-field">
                                        <label>
                                            <i className="codicon codicon-settings-gear"></i>
                                            Mode
                                        </label>
                                        <div className="mode-selector">
                                            <button
                                                className={`mode-btn ${!decayOnlySteps.includes(selectedStepIndex) ? 'active' : ''}`}
                                                onClick={() =>
                                                    decayOnlySteps.includes(selectedStepIndex) && onToggleDecayOnly(selectedStepIndex)
                                                }
                                            >
                                                <i className="codicon codicon-zap"></i>
                                                Active
                                            </button>
                                            <button
                                                className={`mode-btn decay ${decayOnlySteps.includes(selectedStepIndex) ? 'active' : ''}`}
                                                onClick={() =>
                                                    !decayOnlySteps.includes(selectedStepIndex) && onToggleDecayOnly(selectedStepIndex)
                                                }
                                            >
                                                <i className="codicon codicon-flame"></i>
                                                Decay
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                <div className="timeline-editor-info">
                                    <i className="codicon codicon-info"></i>
                                    <span>
                                        {decayOnlySteps.includes(selectedStepIndex)
                                            ? 'Decay-only step runs at zero power. Use for cooling periods between cycles.'
                                            : 'Active step depletes materials at the configured power level.'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};
