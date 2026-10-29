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
 * Weight-window list editor: multiple OpenMC `<weight_windows>` sets, a
 * reusable HDF5 file, the enable flag, and collision/surface checkpoints.
 *
 * @module openmc-studio/browser/widgets/vr
 */

import * as React from '@theia/core/shared/react';
import { Tooltip, NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCMesh, OpenMCVarianceReduction, OpenMCWeightWindows } from '../../../../common/openmc-state-schema';
import { coerceParticleType, particleTypeLabel } from '../../../../common/particle-types';
import { defaultWeightWindowSet, summarizeWeightWindows, validateVarianceReduction } from '../../../../common/variance-reduction';
import { ParticleTypeSelector } from '../../shared/particle-type-selector';

/** Props for the {@link WeightWindowEditor} component. */
export interface WeightWindowEditorProps {
    /** Weight-window sets. */
    weightWindows?: OpenMCWeightWindows[];
    /** Reusable HDF5 weight-window file. */
    weightWindowsFile?: string;
    /** Enable flag (`weight_windows_on`). */
    weightWindowsOn?: boolean;
    /** Split/roulette checkpoints. */
    weightWindowCheckpoints?: { collision?: boolean; surface?: boolean };
    /** Available meshes. */
    meshes: OpenMCMesh[];
    /** Change callback for the weight-window slice. */
    onChange: (updates: Partial<OpenMCVarianceReduction>) => void;
    /** Browse for a weight-window file. */
    onBrowseFile?: () => void;
    /** Import MCNP WWINP weight windows. */
    onWWINPImport?: () => void;
    /** Export one set to MCNP WWINP. */
    onWWINPExport?: (set: OpenMCWeightWindows) => void;
}

/** Format a bound array summary. */
function boundSummary(value: number | number[] | undefined): string {
    if (value === undefined) {
        return 'default';
    }
    return Array.isArray(value) ? `${value.length} values` : 'uniform value';
}

/**
 * Scalar-or-list bound editor. A scalar broadcasts to every mesh cell and
 * energy group; a list is emitted verbatim.
 * @param props - Bound value/label/change callback.
 * @returns Bound editor React node.
 */
function BoundEditor(props: {
    label: string;
    value: number | number[] | undefined;
    fallback: number;
    onChange: (value: number | number[] | undefined) => void;
}): React.ReactNode {
    const isArray = Array.isArray(props.value);
    const scalar = typeof props.value === 'number' ? props.value : props.fallback;
    return (
        <div className="ww-bound-editor">
            <div className="ww-bound-header">
                <label>{props.label}</label>
                <span className="ww-bound-summary">{boundSummary(props.value)}</span>
            </div>
            <NukeSelect
                value={isArray ? 'list' : 'scalar'}
                options={[
                    { value: 'scalar', label: 'Uniform value' },
                    { value: 'list', label: 'Value list' }
                ]}
                onChange={(mode: string) => props.onChange(mode === 'list' ? [scalar] : scalar)}
                ariaLabel={`${props.label} mode`}
            />
            {isArray ? (
                <textarea
                    rows={3}
                    value={(props.value as number[]).join(' ')}
                    onChange={(event) =>
                        props.onChange(
                            event.target.value
                                .trim()
                                .split(/[\s,;]+/)
                                .filter((part) => part.length > 0)
                                .map(Number)
                                .filter((value) => Number.isFinite(value))
                        )
                    }
                    aria-label={props.label}
                />
            ) : (
                <input
                    type="number"
                    step="any"
                    min={0}
                    value={scalar}
                    onChange={(event) => props.onChange(event.target.value === '' ? undefined : parseFloat(event.target.value))}
                    aria-label={props.label}
                />
            )}
        </div>
    );
}

/** Energy-bound token editor with chips and a count summary. */
function EnergyBoundsEditor(props: { bounds: number[]; onChange: (bounds: number[]) => void }): React.ReactNode {
    const [draft, setDraft] = React.useState('');
    const add = (): void => {
        const value = parseFloat(draft.trim());
        if (!Number.isFinite(value)) {
            return;
        }
        const next = [...props.bounds, value].sort((a, b) => a - b);
        props.onChange(next);
        setDraft('');
    };
    return (
        <div className="ww-energy-bounds">
            <div className="ww-bound-header">
                <label>Energy bounds (eV)</label>
                <span className="ww-bound-summary">
                    {props.bounds.length} bound{props.bounds.length === 1 ? '' : 's'} · {Math.max(1, props.bounds.length - 1)} group
                    {Math.max(1, props.bounds.length - 1) === 1 ? '' : 's'}
                </span>
            </div>
            <div className="ww-energy-chips">
                {props.bounds.map((bound, index) => (
                    <span className="ww-energy-chip" key={`${bound}-${index}`}>
                        {bound.toExponential(2)}
                        <Tooltip content="Remove this bound" position="top">
                            <button
                                type="button"
                                className="chip-remove"
                                onClick={() => props.onChange(props.bounds.filter((_, i) => i !== index))}
                                aria-label={`Remove energy bound ${bound}`}
                            >
                                <i className="codicon codicon-close"></i>
                            </button>
                        </Tooltip>
                    </span>
                ))}
            </div>
            <div className="ww-energy-add">
                <input
                    type="text"
                    value={draft}
                    placeholder="Add bound (0, 1e6, 2e7) and press Enter"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            add();
                        }
                    }}
                    aria-label="Add energy bound"
                />
                <button type="button" className="theia-button secondary small" onClick={add}>
                    <i className="codicon codicon-add"></i> Add
                </button>
            </div>
        </div>
    );
}

/** One weight-window set card. */
function WeightWindowCard(props: {
    set: OpenMCWeightWindows;
    index: number;
    meshes: OpenMCMesh[];
    onChange: (updates: Partial<OpenMCWeightWindows>) => void;
    onDelete: () => void;
    onExport?: () => void;
}): React.ReactNode {
    const { set } = props;
    return (
        <div className="ww-set-card" data-ww-id={set.id}>
            <div className="ww-set-header">
                <div className="ww-set-title">
                    <span className="ww-set-id">Set {set.id ?? props.index + 1}</span>
                    <span className="ww-set-particle">
                        {particleTypeLabel(coerceParticleType(set.particleType) ?? { name: 'neutron', pdg: 2112 })}
                    </span>
                </div>
                <div className="ww-set-actions">
                    {props.onExport && (
                        <Tooltip content="Export this set to MCNP WWINP" position="top">
                            <button type="button" className="theia-button secondary small" onClick={props.onExport}>
                                <i className="codicon codicon-file-export"></i>
                            </button>
                        </Tooltip>
                    )}
                    <Tooltip content="Delete this weight-window set" position="top">
                        <button type="button" className="theia-button secondary small" onClick={props.onDelete}>
                            <i className="codicon codicon-trash"></i>
                        </button>
                    </Tooltip>
                </div>
            </div>

            <div className="form-row">
                <div className="form-group">
                    <label>Mesh</label>
                    <NukeSelect
                        value={String(set.meshId ?? '')}
                        options={[
                            { value: '', label: 'Select a mesh...' },
                            ...props.meshes.map((mesh) => ({
                                value: String(mesh.id),
                                label: `${mesh.name || `Mesh ${mesh.id}`} (${mesh.type})`
                            }))
                        ]}
                        onChange={(value: string) => props.onChange({ meshId: parseInt(value) || 0 })}
                        ariaLabel={`Weight-window set ${set.id ?? props.index + 1} mesh`}
                    />
                    {!props.meshes.some((mesh) => mesh.id === set.meshId) && (
                        <span className="form-error">Select a mesh; weight windows cannot be emitted without one</span>
                    )}
                </div>
                <ParticleTypeSelector
                    value={set.particleType}
                    onChange={(particle) => props.onChange({ particleType: particle })}
                    scope="weight-window"
                    allowedNames={['neutron', 'photon']}
                    allowCustom={false}
                    ariaLabel={`Weight-window set ${set.id ?? props.index + 1} particle type`}
                    label="Particle type"
                />
            </div>

            <EnergyBoundsEditor bounds={set.energyBounds ?? []} onChange={(energyBounds) => props.onChange({ energyBounds })} />

            <div className="ww-bound-grid">
                <BoundEditor
                    label="Lower weight bound"
                    value={set.lowerBound}
                    fallback={0.5}
                    onChange={(lowerBound) => props.onChange({ lowerBound: lowerBound ?? 0.5 })}
                />
                <BoundEditor
                    label="Upper weight bound"
                    value={set.upperBound}
                    fallback={(typeof set.lowerBound === 'number' ? set.lowerBound : 0.5) * 2}
                    onChange={(upperBound) => props.onChange({ upperBound })}
                />
            </div>

            <div className="form-row">
                <div className="form-group">
                    <label>
                        Survival ratio
                        <Tooltip
                            content="Survival weight divided by the lower weight bound after rouletting (OpenMC default 3.0)."
                            position="top"
                        >
                            <i className="codicon codicon-info" aria-hidden="true"></i>
                        </Tooltip>
                    </label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={set.survivalWeight ?? 3}
                        onChange={(event) => props.onChange({ survivalWeight: parseFloat(event.target.value) || undefined })}
                        aria-label={`Weight-window set ${set.id ?? props.index + 1} survival ratio`}
                    />
                </div>
                <div className="form-group">
                    <label>Max split</label>
                    <input
                        type="number"
                        min={1}
                        step={1}
                        value={set.maxSplit ?? 10}
                        onChange={(event) => props.onChange({ maxSplit: parseInt(event.target.value) || 10 })}
                        aria-label={`Weight-window set ${set.id ?? props.index + 1} max split`}
                    />
                </div>
                <div className="form-group">
                    <label>Weight cutoff</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={set.weightCutoff ?? 1e-38}
                        onChange={(event) => props.onChange({ weightCutoff: parseFloat(event.target.value) || 1e-38 })}
                        aria-label={`Weight-window set ${set.id ?? props.index + 1} weight cutoff`}
                    />
                </div>
            </div>
        </div>
    );
}

/**
 * Editor for all weight-window sets, the reusable file, the enable flag, and
 * checkpoints. Sets stack in narrow panels and long bound arrays collapse to a
 * summary plus a text editor.
 */
export const WeightWindowEditor: React.FC<WeightWindowEditorProps> = (props) => {
    const sets = props.weightWindows ?? [];
    const hasWindows = sets.length > 0 || !!props.weightWindowsFile;
    const enabled = props.weightWindowsOn ?? hasWindows;
    const issues = validateVarianceReduction(
        {
            weightWindows: sets,
            weightWindowsFile: props.weightWindowsFile,
            weightWindowsOn: props.weightWindowsOn,
            weightWindowCheckpoints: props.weightWindowCheckpoints
        },
        props.meshes,
        'eigenvalue'
    ).filter(
        (issue) => issue.field === 'weight-windows' || issue.field === 'weight-windows-file' || issue.field === 'weight-window-checkpoints'
    );

    const updateSet = (index: number, updates: Partial<OpenMCWeightWindows>): void => {
        props.onChange({ weightWindows: sets.map((set, i) => (i === index ? { ...set, ...updates } : set)) });
    };
    const removeSet = (index: number): void => {
        const next = sets.filter((_, i) => i !== index);
        props.onChange({ weightWindows: next.length > 0 ? next : undefined });
    };
    const addSet = (): void => {
        const meshId = props.meshes[0]?.id;
        if (meshId === undefined) {
            return;
        }
        props.onChange({ weightWindows: [...sets, defaultWeightWindowSet(meshId, sets)], weightWindowsOn: true });
    };

    return (
        <div className="weight-window-editor">
            <div className={`vr-enable-card ${enabled ? 'enabled' : ''}`}>
                <div className="enable-card-content">
                    <div className="enable-icon">
                        <i className={`codicon ${enabled ? 'codicon-check' : 'codicon-dashboard'}`}></i>
                    </div>
                    <div className="enable-text">
                        <h3>Weight Windows</h3>
                        <p>
                            {enabled
                                ? 'Split and roulette particles using mesh-based weight bounds.'
                                : 'Enable to control particle population using weight windows for deep-penetration problems.'}
                        </p>
                    </div>
                    <label className="ww-enable-toggle">
                        <input
                            type="checkbox"
                            checked={enabled}
                            disabled={!hasWindows}
                            onChange={(event) => props.onChange({ weightWindowsOn: event.target.checked })}
                        />
                        Enable weight windows
                    </label>
                </div>
            </div>

            <div className="settings-section">
                <div className="ww-list-header">
                    <h3>
                        <i className="codicon codicon-openmc-grid"></i> Weight-window sets
                    </h3>
                    <span className="ww-list-summary">{summarizeWeightWindows(sets)}</span>
                </div>
                {sets.length === 0 && (
                    <div className="ww-empty-state">
                        <i className="codicon codicon-openmc-grid"></i>
                        <p>No weight-window sets yet. A set maps one mesh to lower/upper weight bounds.</p>
                        <button className="theia-button primary" onClick={addSet} disabled={props.meshes.length === 0}>
                            <i className="codicon codicon-add"></i> Add weight-window set
                        </button>
                        {props.meshes.length === 0 && (
                            <span className="form-hint">Create a mesh first in the Tallies tab (Meshes → Add).</span>
                        )}
                    </div>
                )}
                {sets.map((set, index) => (
                    <WeightWindowCard
                        key={set.id ?? index}
                        set={set}
                        index={index}
                        meshes={props.meshes}
                        onChange={(updates) => updateSet(index, updates)}
                        onDelete={() => removeSet(index)}
                        onExport={props.onWWINPExport ? () => props.onWWINPExport!(set) : undefined}
                    />
                ))}
                {sets.length > 0 && (
                    <button className="theia-button secondary ww-add-set" onClick={addSet} disabled={props.meshes.length === 0}>
                        <i className="codicon codicon-add"></i> Add weight-window set
                    </button>
                )}
            </div>

            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-file-media"></i> Weight-window file
                </h3>
                <div className="form-row">
                    <div className="form-group">
                        <label>HDF5 file</label>
                        <input
                            type="text"
                            value={props.weightWindowsFile ?? ''}
                            placeholder="weight_windows.h5"
                            onChange={(event) => props.onChange({ weightWindowsFile: event.target.value || undefined })}
                            aria-label="Weight-window file"
                        />
                    </div>
                    <div className="form-group ww-file-actions">
                        <label>&nbsp;</label>
                        <button className="theia-button secondary" onClick={props.onBrowseFile} disabled={!props.onBrowseFile}>
                            <i className="codicon codicon-folder-opened"></i> Browse
                        </button>
                    </div>
                </div>
                <span className="form-hint">
                    OpenMC loads weight windows from this file at simulation start. The file is loaded in addition to any sets above (OpenMC
                    appends both).
                </span>
                {props.weightWindowsFile && (
                    <div className="openmc-warning-box">
                        <i className="codicon codicon-warning"></i>
                        <div className="warning-content">
                            <strong>Generator runs overwrite this file</strong>
                            <p>
                                After the generation run, turn the weight-window generator off and keep the generated file for production.
                            </p>
                        </div>
                    </div>
                )}
                {(props.onWWINPImport || props.onWWINPExport) && (
                    <div className="wwinp-actions">
                        {props.onWWINPImport && (
                            <Tooltip content="Import weight windows from an MCNP WWINP file" position="top">
                                <button className="theia-button secondary" onClick={props.onWWINPImport}>
                                    <i className="codicon codicon-file-add"></i> Import WWINP
                                </button>
                            </Tooltip>
                        )}
                    </div>
                )}
            </div>

            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-debug-breakpoint"></i> Checkpoints
                </h3>
                <div className="ww-checkpoint-row">
                    <label>
                        <input
                            type="checkbox"
                            checked={props.weightWindowCheckpoints?.collision ?? true}
                            onChange={(event) =>
                                props.onChange({
                                    weightWindowCheckpoints: {
                                        ...props.weightWindowCheckpoints,
                                        collision: event.target.checked
                                    }
                                })
                            }
                        />
                        Collision
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={props.weightWindowCheckpoints?.surface ?? false}
                            onChange={(event) =>
                                props.onChange({
                                    weightWindowCheckpoints: {
                                        ...props.weightWindowCheckpoints,
                                        surface: event.target.checked
                                    }
                                })
                            }
                        />
                        Surface crossing
                    </label>
                </div>
                <span className="form-hint">
                    At least one checkpoint must be enabled while weight windows are on. OpenMC defaults to collision checks.
                </span>
            </div>

            {issues.length > 0 && (
                <div className="ww-validation">
                    {issues.map((issue, index) => (
                        <div key={`${issue.field}-${index}`} className={`ww-validation-item ${issue.severity}`}>
                            <i className={`codicon codicon-${issue.severity === 'error' ? 'error' : 'warning'}`}></i>
                            <div>
                                <span>{issue.message}</span>
                                <span className="form-hint">{issue.suggestion}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default WeightWindowEditor;
