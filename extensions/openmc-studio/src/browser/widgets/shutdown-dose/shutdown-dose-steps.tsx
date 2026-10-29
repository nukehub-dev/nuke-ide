// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Shutdown Dose wizard step views (method, schedule, tallies, review, results).
 *
 * @module openmc-studio/browser
 */

import * as React from '@theia/core/shared/react';
import { NukeSelect, Tooltip } from 'nuke-essentials/lib/theme/browser/components';

import {
    OpenMCShutdownDoseBoundingBox,
    OpenMCShutdownDoseConfig,
    OpenMCShutdownDoseTallyTemplate,
    OpenMCShutdownDoseWizardStep,
    OpenMCState,
    OpenMCMesh,
    OpenMCRegularMesh,
    OpenMCTally
} from '../../../common/openmc-state-schema';
import {
    ShutdownDoseIssue,
    ShutdownDoseReadiness,
    createDefaultShutdownDoseConfig,
    describeCellActivationReadiness,
    getPhotonTallies,
    getShutdownDoseTimeIndexCount,
    isPhotonTally,
    normalizeShutdownDoseSchedule
} from '../../../common/shutdown-dose';
import {
    ShutdownDoseProgress,
    ShutdownDoseResult,
    ShutdownDoseStep,
    ShutdownDoseTallySummary,
    ShutdownDoseValidationIssue
} from '../../../common/openmc-studio-protocol';

/** Wizard step metadata. */
export interface ShutdownDoseStepDefinition {
    id: OpenMCShutdownDoseWizardStep;
    label: string;
    icon: string;
    description: string;
}

/** Ordered wizard steps. */
export const SHUTDOWN_DOSE_STEPS: ShutdownDoseStepDefinition[] = [
    {
        id: 'method',
        label: 'Method & model',
        icon: 'codicon-openmc-shutdown-dose',
        description: 'Choose R2S or D1S and the activation domains'
    },
    {
        id: 'schedule',
        label: 'Schedule',
        icon: 'codicon-calendar',
        description: 'Irradiation steps, source rates, chain, and photon times'
    },
    { id: 'tallies', label: 'Photon tally', icon: 'codicon-openmc-tally', description: 'Select photon tallies or add a dose tally' },
    { id: 'review', label: 'Review & run', icon: 'codicon-openmc-run', description: 'Check readiness and launch the driver' },
    { id: 'results', label: 'Results', icon: 'codicon-openmc-statepoint', description: 'Dose, activity, and photon tally summaries' }
];

/** Callbacks and derived data shared by every step view. */
export interface ShutdownDoseStepProps {
    state: OpenMCState;
    config: OpenMCShutdownDoseConfig;
    readiness: ShutdownDoseReadiness;
    update: (updates: Partial<OpenMCShutdownDoseConfig>) => void;
    setCellVolume: (cellId: number, volume: number | undefined) => void;
    chooseDirectory: (title: string) => Promise<string | undefined>;
    chooseChainFile: () => Promise<string | undefined>;
    addDoseTally: (meshId?: number) => Promise<void>;
    isAddingDose: boolean;
    doseError?: string;
    backendIssues: ShutdownDoseValidationIssue[];
    run: () => void;
    cancel: () => void;
    isRunning: boolean;
    progress?: ShutdownDoseProgress;
    result?: ShutdownDoseResult;
    openFolder: (path: string) => void;
    openFile: (path: string) => void;
    goToStep: (step: OpenMCShutdownDoseWizardStep) => void;
    loadPreviousResult: () => void;
}

/** Render a validation issue list. */
export function ShutdownDoseIssues({ issues }: { issues: ShutdownDoseIssue[] }): React.ReactNode {
    if (issues.length === 0) {
        return null;
    }
    return (
        <ul className="shutdown-dose-issues" aria-live="polite">
            {issues.map((issue, index) => (
                <li key={`${issue.field}-${index}`} className={`shutdown-dose-issue ${issue.severity}`}>
                    <i className={`codicon ${issue.severity === 'error' ? 'codicon-error' : 'codicon-warning'}`} />
                    <div>
                        <strong>{issue.message}</strong>
                        <span>{issue.suggestion}</span>
                    </div>
                </li>
            ))}
        </ul>
    );
}

/** Format a duration in seconds for display. */
function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return '0 s';
    }
    if (seconds >= 86400) {
        return `${(seconds / 86400).toPrecision(4)} d`;
    }
    if (seconds >= 3600) {
        return `${(seconds / 3600).toPrecision(4)} h`;
    }
    if (seconds >= 60) {
        return `${(seconds / 60).toPrecision(4)} min`;
    }
    return `${seconds.toPrecision(4)} s`;
}

/** Format a number compactly. */
function formatNumber(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) {
        return '—';
    }
    if (value !== 0 && (Math.abs(value) >= 1e5 || Math.abs(value) < 1e-3)) {
        return value.toExponential(3);
    }
    return value.toPrecision(5);
}

/** Split a configured timestep into editable text + unit. */
function splitTimestep(
    value: number | string,
    defaultUnit: 's' | 'min' | 'h' | 'd' | 'a'
): { text: string; unit: 's' | 'min' | 'h' | 'd' | 'a' } {
    if (typeof value === 'number') {
        return { text: String(value), unit: defaultUnit };
    }
    const match = String(value).match(/^\s*([^a-zA-Z]*?)\s*([a-zA-Z]*)\s*$/);
    if (!match) {
        return { text: String(value), unit: defaultUnit };
    }
    const unit = (match[2].toLowerCase() || defaultUnit) as 's' | 'min' | 'h' | 'd' | 'a';
    return { text: match[1], unit };
}

/** Mesh display summary. */
function describeMesh(mesh: OpenMCMesh): string {
    if (mesh.type === 'regular') {
        const regular = mesh as OpenMCRegularMesh;
        return `${regular.dimension.join(' × ')} cells · ${regular.lowerLeft.join(', ')} → ${regular.upperRight.join(', ')} cm`;
    }
    if (mesh.type === 'cylindrical') {
        return `cylindrical · ${Math.max(0, mesh.rGrid.length - 1)} × ${Math.max(0, mesh.phiGrid.length - 1)} × ${Math.max(0, mesh.zGrid.length - 1)}`;
    }
    if (mesh.type === 'spherical') {
        return `spherical · ${Math.max(0, mesh.rGrid.length - 1)} × ${Math.max(0, mesh.thetaGrid.length - 1)} × ${Math.max(0, mesh.phiGrid.length - 1)}`;
    }
    if (mesh.type === 'rectilinear') {
        return `rectilinear · ${Math.max(0, mesh.xGrid.length - 1)} × ${Math.max(0, mesh.yGrid.length - 1)} × ${Math.max(0, mesh.zGrid.length - 1)}`;
    }
    return `unstructured · ${mesh.library} · ${mesh.filename}`;
}

/** Human-readable filter summary for a tally. */
function describeTallyFilters(tally: OpenMCTally): string {
    if (tally.filters.length === 0) {
        return 'No filters';
    }
    return tally.filters.map((filter) => (filter.type === 'mesh' ? `mesh ${filter.meshId}` : filter.type)).join(' · ');
}

/** Source rate list always as an array. */
function sourceRateList(config: OpenMCShutdownDoseConfig): number[] {
    if (Array.isArray(config.sourceRates)) {
        return config.sourceRates;
    }
    return config.timesteps.map(() => config.sourceRates as number);
}

/** Time label for a photon time index. */
function timeIndexLabel(config: OpenMCShutdownDoseConfig, index: number): string {
    const { schedule } = normalizeShutdownDoseSchedule(config);
    const seconds = schedule.slice(0, index).reduce((total, step) => total + step.seconds, 0);
    return `t${index} · ${formatDuration(seconds)}`;
}

/** A small accessible sparkline (no external chart library). */
function Sparkline({ values, label }: { values: number[]; label: string }): React.ReactNode {
    const finite = values.filter((value) => Number.isFinite(value));
    if (finite.length === 0) {
        return <div className="shutdown-dose-sparkline-empty">No data</div>;
    }
    const maxPoints = 160;
    const sample = finite.length <= maxPoints ? finite : finite.filter((_, index) => index % Math.ceil(finite.length / maxPoints) === 0);
    const min = Math.min(...sample);
    const max = Math.max(...sample);
    const span = max - min || 1;
    const width = 320;
    const height = 84;
    const points = sample
        .map((value, index) => {
            const x = sample.length === 1 ? width / 2 : (index / (sample.length - 1)) * width;
            const y = height - ((value - min) / span) * (height - 8) - 4;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(' ');
    return (
        <svg className="shutdown-dose-sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label} trend`}>
            <polyline points={points} fill="none" stroke="var(--theia-focusBorder)" strokeWidth="1.6" />
        </svg>
    );
}

/** Step 1: method and activation domains. */
export function MethodStep(props: ShutdownDoseStepProps): React.ReactNode {
    const { state, config, update, readiness } = props;
    const domainType = config.domainType ?? 'cell';
    const cellIds = new Set(config.cellIds ?? []);
    const meshIds = new Set(config.meshIds ?? []);
    const selectedCells = state.geometry.cells.filter((cell) => cellIds.has(cell.id));
    const issues = readiness.errors.filter((issue) => issue.field === 'domains' || issue.field === 'method');

    const setBoundingBox = (cellId: number, box: OpenMCShutdownDoseBoundingBox | undefined): void => {
        const next = { ...(config.boundingBoxes ?? {}) };
        if (box) {
            next[cellId] = box;
        } else {
            delete next[cellId];
        }
        update({ boundingBoxes: Object.keys(next).length > 0 ? next : undefined });
    };

    return (
        <>
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-openmc-shutdown-dose" /> Analysis method
                </h3>
                <div className="shutdown-dose-method-grid">
                    <button
                        type="button"
                        className={`shutdown-dose-method-card ${config.method === 'r2s' ? 'selected' : ''}`}
                        aria-pressed={config.method === 'r2s'}
                        onClick={() => update({ method: 'r2s' })}
                    >
                        <i className="codicon codicon-openmc-depletion" />
                        <span className="method-title">R2S</span>
                        <span className="method-copy">
                            Neutron transport → activation → decay photon source → photon transport. Highest fidelity; writes a large output
                            tree.
                        </span>
                    </button>
                    <button
                        type="button"
                        className={`shutdown-dose-method-card ${config.method === 'd1s' ? 'selected' : ''}`}
                        aria-pressed={config.method === 'd1s'}
                        onClick={() => update({ method: 'd1s' })}
                    >
                        <i className="codicon codicon-openmc-source" />
                        <span className="method-title">D1S</span>
                        <span className="method-copy">
                            One coupled neutron–photon transport with decay photons and time correction factors. Faster; activation is not
                            spatially resolved.
                        </span>
                    </button>
                </div>
                <p className="form-hint">
                    Both methods run on the current model and write into a timestamped output folder. R2S/D1S settings are never written to
                    settings.xml.
                </p>
                <ShutdownDoseIssues issues={issues} />
            </div>

            {config.method === 'r2s' ? (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-openmc-cell" /> Activation domain
                    </h3>
                    <div className="shutdown-dose-segmented" role="group" aria-label="Activation domain type">
                        <button
                            type="button"
                            className={domainType === 'cell' ? 'selected' : ''}
                            aria-pressed={domainType === 'cell'}
                            onClick={() => update({ domainType: 'cell' })}
                        >
                            Cells
                        </button>
                        <button
                            type="button"
                            className={domainType === 'mesh' ? 'selected' : ''}
                            aria-pressed={domainType === 'mesh'}
                            onClick={() => update({ domainType: 'mesh' })}
                        >
                            Meshes
                        </button>
                    </div>

                    {domainType === 'cell' ? (
                        state.geometry.cells.length === 0 ? (
                            <div className="empty-state">
                                <i className="codicon codicon-openmc-cell" />
                                <p>No cells defined yet. R2S activates material-filled cells; build the geometry first.</p>
                            </div>
                        ) : (
                            <div className="shutdown-dose-domain-list">
                                {state.geometry.cells.map((cell) => {
                                    const readiness = describeCellActivationReadiness(cell);
                                    const selected = cellIds.has(cell.id);
                                    return (
                                        <div key={cell.id} className={`shutdown-dose-domain-row ${selected ? 'selected' : ''}`}>
                                            <label className="shutdown-dose-domain-check">
                                                <input
                                                    type="checkbox"
                                                    checked={selected}
                                                    disabled={!readiness.ready}
                                                    onChange={(event) => {
                                                        const next = new Set(cellIds);
                                                        if (event.target.checked) {
                                                            next.add(cell.id);
                                                        } else {
                                                            next.delete(cell.id);
                                                        }
                                                        update({ cellIds: [...next].sort((a, b) => a - b) });
                                                    }}
                                                />
                                                <span>
                                                    <strong>#{cell.id}</strong> {cell.name || 'Unnamed cell'}
                                                </span>
                                            </label>
                                            <span className={`shutdown-dose-readiness ${readiness.ready ? 'ready' : 'blocked'}`}>
                                                <i
                                                    className={`codicon ${readiness.ready ? 'codicon-pass-filled' : 'codicon-circle-slash'}`}
                                                />
                                                {readiness.detail}
                                            </span>
                                            {cell.fillType === 'material' && (
                                                <label className="shutdown-dose-inline-field">
                                                    Volume (cm³)
                                                    <input
                                                        type="number"
                                                        min={0}
                                                        step="any"
                                                        value={cell.volume ?? ''}
                                                        placeholder="required"
                                                        onChange={(event) => {
                                                            const value = parseFloat(event.target.value);
                                                            props.setCellVolume(
                                                                cell.id,
                                                                Number.isFinite(value) && value > 0 ? value : undefined
                                                            );
                                                        }}
                                                    />
                                                </label>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )
                    ) : state.meshes.length === 0 ? (
                        <div className="empty-state">
                            <i className="codicon codicon-openmc-mesh" />
                            <p>No meshes defined yet. Create a mesh in the Tally Configurator, then select it here.</p>
                        </div>
                    ) : (
                        <div className="shutdown-dose-domain-list">
                            {state.meshes.map((mesh) => (
                                <label key={mesh.id} className={`shutdown-dose-domain-row ${meshIds.has(mesh.id) ? 'selected' : ''}`}>
                                    <span className="shutdown-dose-domain-check">
                                        <input
                                            type="checkbox"
                                            checked={meshIds.has(mesh.id)}
                                            onChange={(event) => {
                                                const next = new Set(meshIds);
                                                if (event.target.checked) {
                                                    next.add(mesh.id);
                                                } else {
                                                    next.delete(mesh.id);
                                                }
                                                update({ meshIds: [...next].sort((a, b) => a - b) });
                                            }}
                                        />
                                        <span>
                                            <strong>#{mesh.id}</strong> {mesh.name || 'Unnamed mesh'}
                                        </span>
                                    </span>
                                    <span className="shutdown-dose-readiness">{describeMesh(mesh)}</span>
                                </label>
                            ))}
                        </div>
                    )}

                    {domainType === 'cell' && selectedCells.length > 0 && (
                        <details className="shutdown-dose-advanced">
                            <summary>Bounding box overrides (optional)</summary>
                            <p className="form-hint">
                                OpenMC derives each activation cell's box from its CSG region. Set an explicit box only when the region has
                                no axis-aligned bounds (for example, a rotated plane).
                            </p>
                            {selectedCells.map((cell) => {
                                const box = config.boundingBoxes?.[cell.id];
                                const lower = box?.lowerLeft ?? ([-1, -1, -1] as [number, number, number]);
                                const upper = box?.upperRight ?? ([1, 1, 1] as [number, number, number]);
                                const updateAxis = (which: 'lowerLeft' | 'upperRight', axis: 0 | 1 | 2, text: string): void => {
                                    const parsed = parseFloat(text);
                                    const nextLower = [...lower] as [number, number, number];
                                    const nextUpper = [...upper] as [number, number, number];
                                    const target = which === 'lowerLeft' ? nextLower : nextUpper;
                                    target[axis] = Number.isFinite(parsed) ? parsed : 0;
                                    setBoundingBox(cell.id, { lowerLeft: nextLower, upperRight: nextUpper });
                                };
                                return (
                                    <div key={cell.id} className="shutdown-dose-bbox-row">
                                        <div className="shutdown-dose-bbox-header">
                                            <strong>Cell #{cell.id}</strong>
                                            <button
                                                type="button"
                                                className="theia-button secondary small"
                                                disabled={!box}
                                                onClick={() => setBoundingBox(cell.id, undefined)}
                                            >
                                                Use auto
                                            </button>
                                        </div>
                                        <div className="shutdown-dose-bbox-grid">
                                            {([0, 1, 2] as const).map((axis) => (
                                                <label key={`lower-${axis}`}>
                                                    Lower {'XYZ'[axis]}
                                                    <input
                                                        type="number"
                                                        step="any"
                                                        value={box?.lowerLeft[axis] ?? ''}
                                                        placeholder="auto"
                                                        aria-label={`Cell ${cell.id} lower ${'XYZ'[axis]}`}
                                                        onChange={(event) => updateAxis('lowerLeft', axis, event.target.value)}
                                                    />
                                                </label>
                                            ))}
                                            {([0, 1, 2] as const).map((axis) => (
                                                <label key={`upper-${axis}`}>
                                                    Upper {'XYZ'[axis]}
                                                    <input
                                                        type="number"
                                                        step="any"
                                                        value={box?.upperRight[axis] ?? ''}
                                                        placeholder="auto"
                                                        aria-label={`Cell ${cell.id} upper ${'XYZ'[axis]}`}
                                                        onChange={(event) => updateAxis('upperRight', axis, event.target.value)}
                                                    />
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </details>
                    )}

                    <p className="form-hint">
                        Multiple meshes are treated as independent activation regions and must not overlap. OpenMC assumes disjoint meshes;
                        the driver warns when regular-mesh bounds intersect.
                    </p>
                </div>
            ) : (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-openmc-source" /> D1S model
                    </h3>
                    <p className="form-hint">
                        D1S uses one coupled transport solve; no activation domain is needed. Every selected photon tally receives a
                        ParentNuclideFilter, and the driver applies time correction factors at the chosen schedule index.
                    </p>
                    <ul className="shutdown-dose-facts">
                        <li>Run mode: {state.settings.run.mode}</li>
                        <li>Photon tallies available: {getPhotonTallies(state).length}</li>
                        <li>Chain: {config.chainFile || 'not selected'}</li>
                    </ul>
                </div>
            )}
        </>
    );
}

/** Step 2: schedule, chain, and photon times. */
export function ScheduleStep(props: ShutdownDoseStepProps): React.ReactNode {
    const { config, update, readiness } = props;
    const defaultUnit = config.timestepUnits ?? 's';
    const rates = sourceRateList(config);
    const issues = readiness.errors.filter((issue) => ['schedule', 'chain', 'd1s'].includes(issue.field));
    const timeCount = getShutdownDoseTimeIndexCount(config);
    const selectedIndices = config.photonTimeIndices;

    const updateTimestep = (index: number, text: string, unit: 's' | 'min' | 'h' | 'd' | 'a'): void => {
        const next = [...config.timesteps];
        next[index] = `${text} ${unit}`;
        update({ timesteps: next });
    };

    const updateRate = (index: number, value: string): void => {
        const next = [...rates];
        const parsed = parseFloat(value);
        next[index] = Number.isFinite(parsed) ? parsed : 0;
        update({ sourceRates: next });
    };

    const addStep = (): void => {
        const nextTimesteps = [...config.timesteps, `1 ${defaultUnit}`];
        const nextRates = [...rates, 0];
        update({ timesteps: nextTimesteps, sourceRates: nextRates });
    };

    const removeStep = (index: number): void => {
        if (config.timesteps.length <= 1) {
            return;
        }
        update({
            timesteps: config.timesteps.filter((_, i) => i !== index),
            sourceRates: rates.filter((_, i) => i !== index)
        });
    };

    return (
        <>
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-calendar" /> Activation schedule
                </h3>
                <div className="shutdown-dose-table-scroll">
                    <table className="shutdown-dose-table">
                        <thead>
                            <tr>
                                <th scope="col">Step</th>
                                <th scope="col">Duration</th>
                                <th scope="col">Unit</th>
                                <th scope="col">Source rate (n/s)</th>
                                <th scope="col">
                                    <span className="sr-only">Remove</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {config.timesteps.map((value, index) => {
                                const row = splitTimestep(value, defaultUnit);
                                return (
                                    <tr key={index}>
                                        <td>{index + 1}</td>
                                        <td>
                                            <input
                                                type="text"
                                                inputMode="decimal"
                                                aria-label={`Timestep ${index + 1} value`}
                                                value={row.text}
                                                onChange={(event) => updateTimestep(index, event.target.value, row.unit)}
                                            />
                                        </td>
                                        <td>
                                            <NukeSelect
                                                ariaLabel={`Timestep ${index + 1} unit`}
                                                value={row.unit}
                                                options={[
                                                    { value: 's', label: 'seconds' },
                                                    { value: 'min', label: 'minutes' },
                                                    { value: 'h', label: 'hours' },
                                                    { value: 'd', label: 'days' },
                                                    { value: 'a', label: 'years' }
                                                ]}
                                                onChange={(unit) => updateTimestep(index, row.text, unit as 's' | 'min' | 'h' | 'd' | 'a')}
                                            />
                                        </td>
                                        <td>
                                            <input
                                                type="number"
                                                min={0}
                                                step="any"
                                                aria-label={`Source rate for step ${index + 1}`}
                                                value={rates[index] ?? 0}
                                                onChange={(event) => updateRate(index, event.target.value)}
                                            />
                                        </td>
                                        <td>
                                            <Tooltip content="Remove this activation step" position="left">
                                                <button
                                                    type="button"
                                                    className="theia-button secondary icon-only"
                                                    aria-label={`Remove step ${index + 1}`}
                                                    disabled={config.timesteps.length <= 1}
                                                    onClick={() => removeStep(index)}
                                                >
                                                    <i className="codicon codicon-trash" />
                                                </button>
                                            </Tooltip>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <div className="shutdown-dose-row-actions">
                    <button type="button" className="theia-button secondary" onClick={addStep}>
                        <i className="codicon codicon-add" /> Add step
                    </button>
                    <span className="form-hint">
                        {normalizeShutdownDoseSchedule(config).schedule.length} interval(s) ·{' '}
                        {formatDuration(normalizeShutdownDoseSchedule(config).schedule.reduce((sum, step) => sum + step.seconds, 0))} total
                    </span>
                </div>
                <ShutdownDoseIssues issues={issues.filter((issue) => issue.field === 'schedule')} />
            </div>

            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-openmc-depletion" /> Chain and photon times
                </h3>
                <div className="form-row">
                    <div className="form-group shutdown-dose-path-field">
                        <label>Depletion chain</label>
                        <div className="shutdown-dose-path-row">
                            <input
                                type="text"
                                readOnly
                                value={config.chainFile || ''}
                                placeholder="No chain selected"
                                aria-label="Depletion chain file"
                            />
                            <Tooltip content="Choose the depletion chain XML used for activation and decay data" position="bottom">
                                <button
                                    type="button"
                                    className="theia-button secondary"
                                    onClick={async () => {
                                        const path = await props.chooseChainFile();
                                        if (path) {
                                            update({ chainFile: path });
                                        }
                                    }}
                                >
                                    Browse…
                                </button>
                            </Tooltip>
                            {config.chainFile && (
                                <Tooltip content="Clear the chain selection" position="bottom">
                                    <button
                                        type="button"
                                        className="theia-button secondary"
                                        aria-label="Clear chain file"
                                        onClick={() => update({ chainFile: undefined })}
                                    >
                                        <i className="codicon codicon-close" />
                                    </button>
                                </Tooltip>
                            )}
                        </div>
                    </div>
                </div>
                <ShutdownDoseIssues issues={issues.filter((issue) => issue.field === 'chain')} />

                {config.method === 'r2s' ? (
                    <>
                        <label className="shutdown-dose-toggle">
                            <input
                                type="checkbox"
                                checked={selectedIndices === undefined}
                                onChange={(event) => update({ photonTimeIndices: event.target.checked ? undefined : [0] })}
                            />
                            Photon transport at every time with a decay source
                        </label>
                        <div className="shutdown-dose-index-row">
                            {Array.from({ length: timeCount }, (_, index) => {
                                const selected = selectedIndices === undefined ? true : selectedIndices.includes(index);
                                return (
                                    <Tooltip
                                        key={index}
                                        content={`Transport photons at ${timeIndexLabel(config, index)}`}
                                        position="bottom"
                                    >
                                        <button
                                            type="button"
                                            className={`shutdown-dose-index ${selected ? 'selected' : ''}`}
                                            aria-pressed={selected}
                                            disabled={selectedIndices === undefined}
                                            onClick={() => {
                                                if (selectedIndices === undefined) {
                                                    return;
                                                }
                                                const next = selectedIndices.includes(index)
                                                    ? selectedIndices.filter((value) => value !== index)
                                                    : [...selectedIndices, index].sort((a, b) => a - b);
                                                update({ photonTimeIndices: next.length > 0 ? next : undefined });
                                            }}
                                        >
                                            {timeIndexLabel(config, index)}
                                        </button>
                                    </Tooltip>
                                );
                            })}
                        </div>
                        <p className="form-hint">
                            Indices run from the initial state (t0) through the end of the schedule. Times with no decay source are skipped;
                            explicitly selected times without a source are reported as an error by the driver.
                        </p>
                    </>
                ) : (
                    <div className="form-row">
                        <div className="form-group">
                            <label>Correction time index</label>
                            <NukeSelect
                                ariaLabel="D1S correction time index"
                                value={String(config.d1sTimeIndex ?? -1)}
                                options={[
                                    ...Array.from({ length: timeCount }, (_, index) => ({
                                        value: String(index),
                                        label: `${timeIndexLabel(config, index)} (index ${index})`
                                    })),
                                    ...(timeCount > 0 ? [{ value: String(-timeCount), label: `Final time (index ${-timeCount})` }] : [])
                                ]}
                                onChange={(value) => update({ d1sTimeIndex: parseInt(value, 10) })}
                            />
                        </div>
                        <div className="form-group checkbox">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={config.d1sSumNuclides !== false}
                                    onChange={(event) => update({ d1sSumNuclides: event.target.checked })}
                                />
                                Sum corrected tallies over parent nuclides
                            </label>
                            <span className="form-hint">Uncheck to keep the per-nuclide breakdown in the corrected tally.</span>
                        </div>
                    </div>
                )}
                <ShutdownDoseIssues issues={issues.filter((issue) => issue.field === 'd1s')} />
            </div>

            {config.method === 'r2s' && (config.domainType ?? 'cell') === 'mesh' && (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-settings-gear" /> Mesh material-volume sampling
                    </h3>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Ray samples per mesh element</label>
                            <input
                                type="number"
                                min={1000}
                                step={1000}
                                value={config.matVolSamples ?? 100000}
                                onChange={(event) => update({ matVolSamples: parseInt(event.target.value, 10) || 100000 })}
                            />
                            <span className="form-hint">
                                Passed as `mat_vol_kwargs={'{'}n_samples{'}'}`. More samples improve volume fractions but increase runtime.
                            </span>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

/** Step 3: photon tallies and dose template. */
export function TalliesStep(props: ShutdownDoseStepProps): React.ReactNode {
    const { state, config, update, readiness, isAddingDose, doseError } = props;
    const photonTallies = getPhotonTallies(state);
    const selected = new Set(config.photonTallyIds ?? []);
    const template = config.doseTallyTemplate ?? createDefaultShutdownDoseConfig(state).doseTallyTemplate!;
    const issues = readiness.errors.filter((issue) => issue.field === 'tallies');
    const [meshId, setMeshId] = React.useState<number | undefined>(undefined);

    const updateTemplate = (updates: Partial<OpenMCShutdownDoseTallyTemplate>): void => {
        const next = { ...template, ...updates };
        if (next.doseQuantity === 'ambient' && next.dataSource !== 'icrp74') {
            next.dataSource = 'icrp74';
        }
        if (next.dataSource === 'icrp116' && next.doseQuantity === 'ambient') {
            next.doseQuantity = 'effective';
        }
        update({ doseTallyTemplate: next });
    };

    return (
        <>
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-openmc-tally" /> Photon tallies
                </h3>
                <p className="form-hint">
                    R2S copies the selected tallies into the photon model; D1S adds a ParentNuclideFilter and corrects the selected tallies.
                </p>
                {state.tallies.length === 0 ? (
                    <div className="empty-state">
                        <i className="codicon codicon-openmc-tally" />
                        <p>No tallies defined yet. Add a dose tally below or create a photon tally in the Tally Configurator.</p>
                    </div>
                ) : (
                    <div className="shutdown-dose-tally-list">
                        {state.tallies.map((tally) => {
                            const photon = isPhotonTally(tally);
                            return (
                                <label
                                    key={tally.id}
                                    className={`shutdown-dose-tally-row ${selected.has(tally.id) ? 'selected' : ''} ${photon ? '' : 'disabled'}`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={selected.has(tally.id)}
                                        disabled={!photon}
                                        onChange={(event) => {
                                            const next = new Set(selected);
                                            if (event.target.checked) {
                                                next.add(tally.id);
                                            } else {
                                                next.delete(tally.id);
                                            }
                                            update({ photonTallyIds: [...next].sort((a, b) => a - b) });
                                        }}
                                    />
                                    <span className="shutdown-dose-tally-main">
                                        <strong>#{tally.id}</strong> {tally.name || 'Unnamed tally'}
                                        <span className="shutdown-dose-tally-meta">
                                            {tally.scores.join(', ') || 'no scores'} · {describeTallyFilters(tally)}
                                            {config.doseTallyId === tally.id ? ' · dose tally' : ''}
                                        </span>
                                    </span>
                                    {!photon && (
                                        <span className="shutdown-dose-readiness blocked">
                                            Add a photon Particle Filter to use this tally
                                        </span>
                                    )}
                                </label>
                            );
                        })}
                    </div>
                )}
                {photonTallies.length === 0 && (
                    <div className="empty-state">
                        <i className="codicon codicon-openmc-tally" />
                        <p>No photon tallies yet. Add a dose tally below, or add a photon tally in the Tally Configurator.</p>
                    </div>
                )}
                <ShutdownDoseIssues issues={issues} />
            </div>

            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-add" /> Add dose tally
                </h3>
                <p className="form-hint">
                    Creates a photon flux tally weighted by OpenMC's shipped ICRP dose-response coefficients (via
                    `openmc.data.dose_coefficients`). No response function is hard-coded in the UI.
                </p>
                <div className="form-row">
                    <div className="form-group">
                        <label>Data source</label>
                        <NukeSelect
                            ariaLabel="Dose data source"
                            value={template.dataSource}
                            options={[
                                { value: 'icrp116', label: 'ICRP-116' },
                                { value: 'icrp74', label: 'ICRP-74' }
                            ]}
                            onChange={(value) => updateTemplate({ dataSource: value as 'icrp74' | 'icrp116' })}
                        />
                    </div>
                    <div className="form-group">
                        <label>Dose quantity</label>
                        <NukeSelect
                            ariaLabel="Dose quantity"
                            value={template.doseQuantity}
                            options={[
                                { value: 'effective', label: 'Effective dose' },
                                { value: 'ambient', label: 'Ambient dose equivalent H*(10)' }
                            ]}
                            onChange={(value) => updateTemplate({ doseQuantity: value as 'effective' | 'ambient' })}
                        />
                        <span className="form-hint">Ambient H*(10) is available from ICRP-74 photon tables.</span>
                    </div>
                    <div className="form-group">
                        <label>Geometry</label>
                        <NukeSelect
                            ariaLabel="Dose irradiation geometry"
                            value={template.geometry}
                            options={['AP', 'PA', 'LLAT', 'RLAT', 'ROT', 'ISO'].map((value) => ({ value, label: value }))}
                            onChange={(value) => updateTemplate({ geometry: value as OpenMCShutdownDoseTallyTemplate['geometry'] })}
                        />
                    </div>
                    <div className="form-group">
                        <label>Interpolation</label>
                        <NukeSelect
                            ariaLabel="Dose response interpolation"
                            value={template.interpolation}
                            options={[
                                { value: 'log-log', label: 'log-log' },
                                { value: 'linear-linear', label: 'linear-linear' },
                                { value: 'linear-log', label: 'linear-log' },
                                { value: 'log-linear', label: 'log-linear' },
                                { value: 'histogram', label: 'histogram' }
                            ]}
                            onChange={(value) =>
                                updateTemplate({ interpolation: value as OpenMCShutdownDoseTallyTemplate['interpolation'] })
                            }
                        />
                    </div>
                    <div className="form-group">
                        <label>Apply to mesh</label>
                        <NukeSelect
                            ariaLabel="Dose tally mesh filter"
                            value={meshId === undefined ? '' : String(meshId)}
                            options={[
                                { value: '', label: 'No mesh filter' },
                                ...state.meshes.map((mesh) => ({ value: String(mesh.id), label: `#${mesh.id} ${mesh.name || ''}` }))
                            ]}
                            onChange={(value) => setMeshId(value ? parseInt(value, 10) : undefined)}
                        />
                        <span className="form-hint">Optional mesh filter for a dose map; leave empty for a global tally.</span>
                    </div>
                </div>
                <div className="shutdown-dose-row-actions">
                    <button
                        type="button"
                        className="theia-button primary"
                        disabled={isAddingDose}
                        onClick={() => props.addDoseTally(meshId)}
                    >
                        <i className="codicon codicon-add" /> {isAddingDose ? 'Adding…' : 'Add dose tally'}
                    </button>
                    {config.doseTallyId !== undefined && <span className="form-hint">Dose tally: #{config.doseTallyId}</span>}
                </div>
                {doseError && (
                    <p className="shutdown-dose-inline-error" role="alert">
                        <i className="codicon codicon-error" /> {doseError}
                    </p>
                )}
            </div>

            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-openmc-source" /> Breakdown
                </h3>
                {config.method === 'r2s' ? (
                    <label className="shutdown-dose-toggle">
                        <input
                            type="checkbox"
                            checked={!!config.byParentNuclide}
                            onChange={(event) => update({ byParentNuclide: event.target.checked })}
                        />
                        Score photon tallies per parent radionuclide
                    </label>
                ) : (
                    <p className="form-hint">
                        Parent-nuclide correction is controlled by "Sum corrected tallies over parent nuclides" in the Schedule step.
                    </p>
                )}
                <p className="form-hint">
                    Parent breakdown adds a ParentNuclideFilter to photon tallies; the Results step lists the parent bins when present.
                </p>
            </div>
        </>
    );
}

/** Step 4: review and run. */
export function ReviewStep(props: ShutdownDoseStepProps): React.ReactNode {
    const { config, readiness, update, isRunning, progress, result, backendIssues } = props;
    const schedule = readiness.schedule;
    const meshDomain = config.method === 'r2s' && (config.domainType ?? 'cell') === 'mesh';
    const domainLabel =
        config.method === 'd1s'
            ? 'Coupled neutron–photon transport'
            : meshDomain
              ? `${config.meshIds?.length ?? 0} mesh(es)`
              : `${config.cellIds?.length ?? 0} cell(s)`;
    const runtimeSteps: ShutdownDoseStep[] =
        config.method === 'r2s' ? ['neutron', 'activation', 'source', 'photon', 'done'] : ['d1s', 'done'];

    return (
        <>
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-openmc-run" /> Run summary
                </h3>
                <div className="shutdown-dose-summary-grid">
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Method</span>
                        <strong>{config.method.toUpperCase()}</strong>
                    </div>
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Activation</span>
                        <strong>{domainLabel}</strong>
                    </div>
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Schedule</span>
                        <strong>
                            {schedule.length} step(s) · {formatDuration(schedule.reduce((sum, step) => sum + step.seconds, 0))}
                        </strong>
                    </div>
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Photon tallies</span>
                        <strong>{config.photonTallyIds?.length ?? 0}</strong>
                    </div>
                    <div className="shutdown-dose-summary-card wide">
                        <span className="label">Chain</span>
                        <strong className="mono">{config.chainFile || 'not selected'}</strong>
                    </div>
                </div>
                <div className="form-group shutdown-dose-path-field">
                    <label>Run directory</label>
                    <div className="shutdown-dose-path-row">
                        <input
                            type="text"
                            readOnly
                            value={config.outputDirectory || ''}
                            placeholder="Choose a directory for XML and output"
                            aria-label="Run directory"
                        />
                        <Tooltip content="Choose the directory where the model XML and R2S/D1S output tree are written" position="bottom">
                            <button
                                type="button"
                                className="theia-button secondary"
                                onClick={async () => {
                                    const path = await props.chooseDirectory('Select Shutdown Dose Run Directory');
                                    if (path) {
                                        update({ outputDirectory: path, workingDirectory: path });
                                    }
                                }}
                            >
                                Browse…
                            </button>
                        </Tooltip>
                    </div>
                    <span className="form-hint">
                        The wizard generates the model XML here, then the driver writes a timestamped subfolder.
                    </span>
                </div>
                <div className="shutdown-dose-warning">
                    <i className="codicon codicon-warning" />
                    <span>
                        R2S can run for a long time and writes a large output tree (neutron, activation, and photon transport). Start with a
                        short schedule and a small particle count before scaling up.
                    </span>
                </div>
                <ShutdownDoseIssues issues={[...readiness.errors, ...readiness.warnings]} />
                <ShutdownDoseIssues issues={backendIssues} />
            </div>

            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-openmc-run" /> Run
                </h3>
                <div className="shutdown-dose-row-actions">
                    {!isRunning ? (
                        <Tooltip
                            content={
                                readiness.ready ? 'Generate XML and start the shutdown-dose driver' : 'Resolve the blocking issues first'
                            }
                            position="bottom"
                        >
                            <button
                                type="button"
                                className="theia-button primary large"
                                disabled={!readiness.ready}
                                onClick={() => props.run()}
                            >
                                <i className="codicon codicon-play" /> Run {config.method.toUpperCase()}
                            </button>
                        </Tooltip>
                    ) : (
                        <Tooltip content="Stop the running driver" position="bottom">
                            <button type="button" className="theia-button secondary large" onClick={() => props.cancel()}>
                                <i className="codicon codicon-stop" /> Cancel
                            </button>
                        </Tooltip>
                    )}
                    {result && !isRunning && (
                        <button type="button" className="theia-button secondary" onClick={() => props.goToStep('results')}>
                            <i className="codicon codicon-openmc-statepoint" /> View results
                        </button>
                    )}
                </div>
                {(isRunning || progress) && (
                    <div className="shutdown-dose-progress" aria-live="polite">
                        <div className="shutdown-dose-progress-track">
                            <div
                                className="shutdown-dose-progress-fill"
                                style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }}
                            />
                        </div>
                        <div className="shutdown-dose-progress-steps">
                            {runtimeSteps.map((step) => (
                                <span
                                    key={step}
                                    className={`shutdown-dose-progress-step ${
                                        progress?.step === step
                                            ? 'active'
                                            : runtimeSteps.indexOf(step) < runtimeSteps.indexOf(progress?.step ?? 'neutron')
                                              ? 'done'
                                              : ''
                                    }`}
                                >
                                    {step}
                                </span>
                            ))}
                        </div>
                        <span className="shutdown-dose-progress-message">{progress?.message || 'Preparing…'}</span>
                    </div>
                )}
                <p className="form-hint">
                    The configuration is saved in the project. A run writes `r2s_summary.json` or `d1s_summary.json` for the Results page.
                </p>
            </div>
        </>
    );
}

/** One photon tally result card. */
function TallySummaryCard({ summary, method }: { summary: ShutdownDoseTallySummary; method: 'r2s' | 'd1s' }): React.ReactNode {
    return (
        <div className="shutdown-dose-result-card">
            <div className="result-card-header">
                <strong>
                    #{summary.tallyId} {summary.name || 'Tally'}
                </strong>
                <span className="shutdown-dose-badge">{summary.timeIndex === undefined ? 'D1S' : `time ${summary.timeIndex}`}</span>
            </div>
            <div className="shutdown-dose-stat-grid">
                <div>
                    <span className="label">Min</span>
                    <strong>{formatNumber(summary.min)}</strong>
                </div>
                <div>
                    <span className="label">Mean</span>
                    <strong>
                        {formatNumber(summary.mean.length > 0 ? summary.mean.reduce((a, b) => a + b, 0) / summary.mean.length : undefined)}
                    </strong>
                </div>
                <div>
                    <span className="label">Max</span>
                    <strong>{formatNumber(summary.max)}</strong>
                </div>
                <div>
                    <span className="label">Bins</span>
                    <strong>{summary.bins}</strong>
                </div>
            </div>
            <Sparkline values={summary.mean} label={summary.name || `Tally ${summary.tallyId}`} />
            {summary.parentNuclides && summary.parentNuclides.length > 0 && (
                <p className="shutdown-dose-parents">
                    <span className="label">Parents:</span> {summary.parentNuclides.slice(0, 8).join(', ')}
                    {summary.parentNuclides.length > 8 ? ` +${summary.parentNuclides.length - 8}` : ''}
                    {method === 'd1s' && summary.summedOverParents ? ' (summed)' : ''}
                </p>
            )}
        </div>
    );
}

/** Step 5: results. */
export function ResultsStep(props: ShutdownDoseStepProps): React.ReactNode {
    const { result, config, state, loadPreviousResult, goToStep } = props;
    if (!result) {
        return (
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-openmc-statepoint" /> Results
                </h3>
                <div className="empty-state">
                    <i className="codicon codicon-openmc-statepoint" />
                    <p>No shutdown-dose result is loaded. Run the workflow or open a previous output directory.</p>
                    {config.lastRun && (
                        <button type="button" className="theia-button secondary" onClick={() => loadPreviousResult()}>
                            <i className="codicon codicon-folder-opened" /> Load {config.lastRun.outputDirectory}
                        </button>
                    )}
                    <button type="button" className="theia-button secondary" onClick={() => goToStep('review')}>
                        Back to review
                    </button>
                </div>
            </div>
        );
    }

    const summary = result.summary;
    const warnings = summary?.warnings ?? [];
    return (
        <>
            <div className="settings-section">
                <div className="result-card-header">
                    <h3>
                        <i className="codicon codicon-openmc-shutdown-dose" />{' '}
                        {summary?.method?.toUpperCase() ?? config.method.toUpperCase()} result
                    </h3>
                    {result.success ? (
                        <span className="shutdown-dose-badge ready">
                            <i className="codicon codicon-pass-filled" /> complete
                        </span>
                    ) : (
                        <span className="shutdown-dose-badge blocked">
                            <i className="codicon codicon-error" /> failed
                        </span>
                    )}
                </div>
                <div className="shutdown-dose-summary-grid">
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Activation regions</span>
                        <strong>{summary?.activationRegions ?? '—'}</strong>
                    </div>
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Photon tallies</span>
                        <strong>{summary?.photonTallies ?? 0}</strong>
                    </div>
                    {summary?.neutronTallies !== undefined && (
                        <div className="shutdown-dose-summary-card">
                            <span className="label">Neutron tallies</span>
                            <strong>{summary.neutronTallies}</strong>
                        </div>
                    )}
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Photon times</span>
                        <strong>{summary?.photonTimeIndices?.join(', ') ?? '—'}</strong>
                    </div>
                    <div className="shutdown-dose-summary-card">
                        <span className="label">Warnings</span>
                        <strong>{warnings.length}</strong>
                    </div>
                </div>
                <p className="shutdown-dose-output-path mono">{result.outputDirectory}</p>
                {!result.success && result.error && (
                    <p className="shutdown-dose-inline-error" role="alert">
                        <i className="codicon codicon-error" /> {result.error}
                    </p>
                )}
                <div className="shutdown-dose-row-actions">
                    {result.outputDirectory && (
                        <button type="button" className="theia-button secondary" onClick={() => props.openFolder(result.outputDirectory!)}>
                            <i className="codicon codicon-folder-opened" /> Reveal output folder
                        </button>
                    )}
                    {result.statepoint && (
                        <button type="button" className="theia-button secondary" onClick={() => props.openFile(result.statepoint!)}>
                            <i className="codicon codicon-file-binary" /> Open statepoint
                        </button>
                    )}
                    <button type="button" className="theia-button secondary" onClick={() => goToStep('review')}>
                        <i className="codicon codicon-debug-restart" /> Run again
                    </button>
                </div>
            </div>

            {summary?.dose && (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-openmc-tally" /> Dose response
                    </h3>
                    <div className="shutdown-dose-stat-grid">
                        <div>
                            <span className="label">Peak</span>
                            <strong>{formatNumber(summary.dose.peak)}</strong>
                        </div>
                        <div>
                            <span className="label">Mean</span>
                            <strong>{formatNumber(summary.dose.mean)}</strong>
                        </div>
                        <div>
                            <span className="label">Tally</span>
                            <strong>#{summary.dose.tallyId}</strong>
                        </div>
                        <div>
                            <span className="label">Time index</span>
                            <strong>{summary.dose.timeIndex ?? '—'}</strong>
                        </div>
                    </div>
                    <p className="form-hint">
                        Values are the selected dose tally's response-weighted flux. Units come from the OpenMC EnergyFunctionFilter
                        response (pSv cm² for photons).
                    </p>
                </div>
            )}

            {(summary?.activity || summary?.decayHeat) && (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-openmc-depletion" /> Activity and decay heat
                    </h3>
                    <div className="shutdown-dose-result-grid">
                        {summary.activity && (
                            <div className="shutdown-dose-result-card">
                                <div className="result-card-header">
                                    <strong>Total activity</strong>
                                    <span className="shutdown-dose-badge">Bq</span>
                                </div>
                                <Sparkline values={summary.activity.totalBq} label="Total activity" />
                                <span className="shutdown-dose-result-value">
                                    {formatNumber(summary.activity.totalBq[summary.activity.totalBq.length - 1])} Bq
                                </span>
                            </div>
                        )}
                        {summary.decayHeat && (
                            <div className="shutdown-dose-result-card">
                                <div className="result-card-header">
                                    <strong>Decay heat</strong>
                                    <span className="shutdown-dose-badge">W</span>
                                </div>
                                <Sparkline values={summary.decayHeat.totalW} label="Decay heat" />
                                <span className="shutdown-dose-result-value">
                                    {formatNumber(summary.decayHeat.totalW[summary.decayHeat.totalW.length - 1])} W
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {summary?.photonTallySummaries && summary.photonTallySummaries.length > 0 && (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-openmc-tally" /> Photon tallies
                    </h3>
                    <div className="shutdown-dose-result-grid">
                        {summary.photonTallySummaries.map((tally, index) => (
                            <TallySummaryCard
                                key={`${tally.tallyId}-${tally.timeIndex ?? 'd1s'}-${index}`}
                                summary={tally}
                                method={summary?.method ?? config.method}
                            />
                        ))}
                    </div>
                </div>
            )}

            {summary?.timeCorrectionFactors && Object.keys(summary.timeCorrectionFactors).length > 0 && (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-openmc-source" /> Time correction factors
                    </h3>
                    <div className="shutdown-dose-table-scroll">
                        <table className="shutdown-dose-table">
                            <thead>
                                <tr>
                                    <th scope="col">Parent nuclide</th>
                                    <th scope="col">Factor</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.entries(summary.timeCorrectionFactors).map(([nuclide, factor]) => (
                                    <tr key={nuclide}>
                                        <td>{nuclide}</td>
                                        <td>{formatNumber(factor)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {warnings.length > 0 && (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-warning" /> Warnings
                    </h3>
                    <ul className="shutdown-dose-warning-list">
                        {warnings.map((warning, index) => (
                            <li key={index}>{warning}</li>
                        ))}
                    </ul>
                </div>
            )}

            {result.files && result.files.length > 0 && (
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-files" /> Output files
                    </h3>
                    <div className="shutdown-dose-file-list">
                        {result.files.slice(0, 30).map((file) => (
                            <button
                                key={file}
                                type="button"
                                className="shutdown-dose-file-link"
                                onClick={() => props.openFolder(result.outputDirectory!)}
                            >
                                <i className="codicon codicon-file" /> {file}
                            </button>
                        ))}
                        {result.files.length > 30 && <span className="form-hint">+{result.files.length - 30} more files</span>}
                    </div>
                </div>
            )}

            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-info" /> Model
                </h3>
                <p className="form-hint">
                    Project: {state.metadata.name} · Run mode: {state.settings.run.mode} · Tally count: {state.tallies.length}
                </p>
                <p className="form-hint">Tally selection is stored in the project so the same result can be re-opened after a reload.</p>
            </div>
        </>
    );
}

/** Render the requested wizard step. */
export function shutdownDoseStepView(step: OpenMCShutdownDoseWizardStep, props: ShutdownDoseStepProps): React.ReactNode {
    switch (step) {
        case 'method':
            return <MethodStep {...props} />;
        case 'schedule':
            return <ScheduleStep {...props} />;
        case 'tallies':
            return <TalliesStep {...props} />;
        case 'review':
            return <ReviewStep {...props} />;
        case 'results':
            return <ResultsStep {...props} />;
        default:
            return <MethodStep {...props} />;
    }
}
