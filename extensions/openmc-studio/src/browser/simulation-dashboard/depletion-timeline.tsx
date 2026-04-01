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
import { OpenMCDepletion } from '../../common/openmc-state-schema';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';

interface DepletionTimelineProps {
    depletion: OpenMCDepletion;
    onChange: (updates: Partial<OpenMCDepletion>) => void;
    onToggleDecayOnly: (index: number) => void;
}

interface ParsedStep {
    value: number;
    unit: string;
}

const TIME_UNITS: { [key: string]: { label: string; seconds: number } } = {
    's': { label: 'seconds', seconds: 1 },
    'min': { label: 'minutes', seconds: 60 },
    'h': { label: 'hours', seconds: 3600 },
    'd': { label: 'days', seconds: 86400 },
    'y': { label: 'years', seconds: 31536000 },
    'MWd/kg': { label: 'MWd/kg', seconds: 0 }
};

export const DepletionTimeline: React.FC<DepletionTimelineProps> = ({ depletion, onChange, onToggleDecayOnly }) => {
    const [selectedStepIndex, setSelectedStepIndex] = React.useState<number>(-1);

    const timeSteps = depletion.timeSteps || [];
    const decayOnlySteps = depletion.decayOnlySteps || [];

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

    const formatTime = (value: number, unit: string): string => {
        if (unit === 'MWd/kg') return `${value.toFixed(2)} MWd/kg`;
        return `${value} ${unit}`;
    };

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

    const formatAccumulatedTime = (seconds: number): string => {
        if (seconds < 60) return `${seconds.toFixed(0)}s`;
        if (seconds < 3600) return `${(seconds / 60).toFixed(1)}min`;
        if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
        if (seconds < 31536000) return `${(seconds / 86400).toFixed(1)}d`;
        return `${(seconds / 31536000).toFixed(2)}y`;
    };

    const handleAddStep = () => {
        const currentSteps = [...timeSteps].map(s => String(s));
        const newSteps = [...currentSteps, '30.0 d'];
        onChange({ timeSteps: newSteps });
        setSelectedStepIndex(newSteps.length - 1);
    };

    const handleRemoveStep = (index: number) => {
        const newSteps = [...timeSteps].map(s => String(s));
        newSteps.splice(index, 1);
        onChange({ timeSteps: newSteps });
        if (selectedStepIndex >= newSteps.length) {
            setSelectedStepIndex(Math.max(-1, newSteps.length - 1));
        }
    };

    const handleUpdateStep = (index: number, value: number, unit: string) => {
        const newSteps = [...timeSteps].map(s => String(s));
        newSteps[index] = `${value} ${unit}`;
        onChange({ timeSteps: newSteps });
    };

    const handleDuplicateStep = (index: number) => {
        const newSteps = [...timeSteps].map(s => String(s));
        newSteps.splice(index + 1, 0, String(timeSteps[index]));
        onChange({ timeSteps: newSteps });
        setSelectedStepIndex(index + 1);
    };

    const currentStep = selectedStepIndex >= 0 && timeSteps[selectedStepIndex]
        ? parseStep(timeSteps[selectedStepIndex])
        : null;

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
                                                        <span className="step-value">{parsed.value} {parsed.unit}</span>
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
                                <span className="stat-value highlight">{formatAccumulatedTime(cumulativeTimes[cumulativeTimes.length - 1])}</span>
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
                                                onChange={(e) => handleUpdateStep(selectedStepIndex, parseFloat(e.target.value), currentStep.unit)}
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
                                                onClick={() => decayOnlySteps.includes(selectedStepIndex) && onToggleDecayOnly(selectedStepIndex)}
                                            >
                                                <i className="codicon codicon-zap"></i>
                                                Active
                                            </button>
                                            <button
                                                className={`mode-btn decay ${decayOnlySteps.includes(selectedStepIndex) ? 'active' : ''}`}
                                                onClick={() => !decayOnlySteps.includes(selectedStepIndex) && onToggleDecayOnly(selectedStepIndex)}
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
