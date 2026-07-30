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

import * as React from '@theia/core/shared/react';
import { OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    OpenMCState,
    OpenMCSource,
    OpenMCSourceType,
    OpenMCFileSource,
    OpenMCCompiledSource,
    OpenMCSurfaceSourceWrite
} from '../../../../../common/openmc-state-schema';
import type { SimulationDashboardWidget } from '../../simulation-dashboard-widget';
import { parseNumberList, arraysEqual } from './section-utils';

/**
 * Replace a source in the settings sources array.
 * @param host - Simulation dashboard widget host.
 * @param index - Source index in the sources array.
 * @param updates - Partial source object with the new values.
 */
export function updateSourceAt(host: SimulationDashboardWidget, index: number, updates: Partial<OpenMCSource>): void {
    const settings = host.stateManager.getState().settings;
    const newSources = [...settings.sources];
    newSources[index] = { ...newSources[index], ...updates } as OpenMCSource;
    host.stateManager.updateSettings({ ...settings, sources: newSources });
}

/**
 * Convert a source to a different source type, preserving id/strength/constraints.
 * @param host - Simulation dashboard widget host.
 * @param index - Source index in the sources array.
 * @param type - New source type.
 */
export function changeSourceType(host: SimulationDashboardWidget, index: number, type: OpenMCSourceType): void {
    const settings = host.stateManager.getState().settings;
    const old = settings.sources[index];
    const base = { id: old.id, strength: old.strength, constraints: old.constraints };

    let next: OpenMCSource;
    if (type === 'file') {
        next = { ...base, type: 'file', path: '' };
    } else if (type === 'compiled') {
        next = { ...base, type: 'compiled', library: '' };
    } else {
        next = {
            ...base,
            type: 'independent',
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'discrete', energies: [1e6] },
            particle: 'neutron'
        };
    }

    const newSources = [...settings.sources];
    newSources[index] = next;
    host.stateManager.updateSettings({ ...settings, sources: newSources });
}

/**
 * Open a file dialog and return the selected path.
 * @param host - Simulation dashboard widget host.
 * @param title - Dialog title.
 * @param filters - File filters (label → extensions).
 * @returns The selected path, or undefined when cancelled.
 */
async function browseFile(
    host: SimulationDashboardWidget,
    title: string,
    filters: { [label: string]: string[] }
): Promise<string | undefined> {
    const props: OpenFileDialogProps = {
        title,
        canSelectFiles: true,
        canSelectFolders: false,
        filters
    };
    const uri = await host.fileDialogService.showOpenDialog(props);
    return uri?.path.toString();
}

/**
 * Render the editor for a file source (particles read from a source file).
 * @param host - Simulation dashboard widget host.
 * @param source - File source to edit.
 * @param index - Source index in the sources array.
 * @returns File source editor React node.
 */
export function renderFileSourceEditor(host: SimulationDashboardWidget, source: OpenMCFileSource, index: number): React.ReactNode {
    return (
        <div className="source-editor">
            <div className="form-row">
                <div className="form-group">
                    <label>Source File Path</label>
                    <input
                        type="text"
                        value={source.path}
                        placeholder="surface_source.h5"
                        onChange={(e) => updateSourceAt(host, index, { path: e.target.value })}
                    />
                    <span className="form-hint">HDF5 or MCPL source file (e.g. written by surface source writing)</span>
                </div>
                <div className="form-group">
                    <label>&nbsp;</label>
                    <button
                        className="theia-button secondary"
                        onClick={async () => {
                            const path = await browseFile(host, 'Select Source File', {
                                'Source Files': ['h5', 'hdf5', 'mcpl'],
                                'All Files': ['*']
                            });
                            if (path) {
                                updateSourceAt(host, index, { path });
                            }
                        }}
                    >
                        <i className="codicon codicon-folder-opened"></i> Browse
                    </button>
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Strength (relative weight)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.strength ?? 1.0}
                        onChange={(e) => updateSourceAt(host, index, { strength: parseFloat(e.target.value) || 1.0 })}
                    />
                </div>
            </div>
        </div>
    );
}

/**
 * Render the editor for a compiled source (shared library sampling).
 * @param host - Simulation dashboard widget host.
 * @param source - Compiled source to edit.
 * @param index - Source index in the sources array.
 * @returns Compiled source editor React node.
 */
export function renderCompiledSourceEditor(host: SimulationDashboardWidget, source: OpenMCCompiledSource, index: number): React.ReactNode {
    return (
        <div className="source-editor">
            <div className="form-row">
                <div className="form-group">
                    <label>Library Path</label>
                    <input
                        type="text"
                        value={source.library}
                        placeholder="libsource.so"
                        onChange={(e) => updateSourceAt(host, index, { library: e.target.value })}
                    />
                </div>
                <div className="form-group">
                    <label>&nbsp;</label>
                    <button
                        className="theia-button secondary"
                        onClick={async () => {
                            const library = await browseFile(host, 'Select Compiled Source Library', {
                                'Shared Libraries': ['so', 'dylib', 'dll'],
                                'All Files': ['*']
                            });
                            if (library) {
                                updateSourceAt(host, index, { library });
                            }
                        }}
                    >
                        <i className="codicon codicon-folder-opened"></i> Browse
                    </button>
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Parameters</label>
                    <input
                        type="text"
                        value={source.parameters ?? ''}
                        placeholder="Optional parameter string passed to the library"
                        onChange={(e) => updateSourceAt(host, index, { parameters: e.target.value || undefined })}
                    />
                </div>
                <div className="form-group">
                    <label>Strength (relative weight)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.strength ?? 1.0}
                        onChange={(e) => updateSourceAt(host, index, { strength: parseFloat(e.target.value) || 1.0 })}
                    />
                </div>
            </div>
        </div>
    );
}

/**
 * Render the constraints editor for a source (domain/fissionable/energy/time/rejection).
 * @param host - Simulation dashboard widget host.
 * @param source - Source whose constraints to edit.
 * @param index - Source index in the sources array.
 * @returns Constraints editor React node.
 */
export function renderConstraintsEditor(host: SimulationDashboardWidget, source: OpenMCSource, index: number): React.ReactNode {
    const constraints = source.constraints;
    const updateConstraints = (updates: Partial<NonNullable<OpenMCSource['constraints']>>): void => {
        const merged = { ...(constraints ?? {}), ...updates };
        // Normalize: drop the constraints object entirely when nothing is set
        const hasContent = Object.values(merged).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
        updateSourceAt(host, index, { constraints: hasContent ? merged : undefined });
    };

    const energyBounds = constraints?.energyBounds;
    const timeBounds = constraints?.timeBounds;

    return (
        <div className="constraints-editor">
            <h4>
                <i className="codicon codicon-filter"></i> Source Constraints
            </h4>
            <div className="form-row">
                <div className="form-group">
                    <label>Domain Type</label>
                    <select
                        value={constraints?.domainType ?? ''}
                        onChange={(e) =>
                            updateConstraints({
                                domainType: (e.target.value || undefined) as 'cell' | 'material' | 'universe' | undefined,
                                domainIds: e.target.value ? constraints?.domainIds : undefined
                            })
                        }
                    >
                        <option value="">None</option>
                        <option value="cell">Cell</option>
                        <option value="material">Material</option>
                        <option value="universe">Universe</option>
                    </select>
                </div>
                {constraints?.domainType && (
                    <div className="form-group">
                        <label>Domain IDs</label>
                        <input
                            type="text"
                            value={(constraints.domainIds ?? []).join(' ')}
                            placeholder="e.g. 1 2 3"
                            onChange={(e) => {
                                const parsed = parseNumberList(e.target.value).map((n) => Math.trunc(n));
                                if (!arraysEqual(parsed, constraints.domainIds ?? [])) {
                                    updateConstraints({ domainIds: parsed });
                                }
                            }}
                        />
                        <span className="form-hint">Sampled sites must be within one of these domains</span>
                    </div>
                )}
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Energy Min (eV)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={energyBounds?.[0] ?? ''}
                        placeholder="No limit"
                        onChange={(e) =>
                            updateConstraints({
                                energyBounds: e.target.value ? [parseFloat(e.target.value), energyBounds?.[1] ?? 20e6] : undefined
                            })
                        }
                    />
                </div>
                <div className="form-group">
                    <label>Energy Max (eV)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={energyBounds?.[1] ?? ''}
                        placeholder="No limit"
                        onChange={(e) =>
                            updateConstraints({
                                energyBounds: e.target.value ? [energyBounds?.[0] ?? 0, parseFloat(e.target.value)] : undefined
                            })
                        }
                    />
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Time Min (s)</label>
                    <input
                        type="number"
                        step="any"
                        value={timeBounds?.[0] ?? ''}
                        placeholder="No limit"
                        onChange={(e) =>
                            updateConstraints({
                                timeBounds: e.target.value ? [parseFloat(e.target.value), timeBounds?.[1] ?? 1.0] : undefined
                            })
                        }
                    />
                </div>
                <div className="form-group">
                    <label>Time Max (s)</label>
                    <input
                        type="number"
                        step="any"
                        value={timeBounds?.[1] ?? ''}
                        placeholder="No limit"
                        onChange={(e) =>
                            updateConstraints({
                                timeBounds: e.target.value ? [timeBounds?.[0] ?? 0, parseFloat(e.target.value)] : undefined
                            })
                        }
                    />
                </div>
            </div>
            <div className="form-row">
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={constraints?.fissionable ?? false}
                            onChange={(e) => updateConstraints({ fissionable: e.target.checked ? true : undefined })}
                        />
                        Fissionable sites only
                    </label>
                </div>
                <div className="form-group">
                    <label>Rejection Strategy</label>
                    <select
                        value={constraints?.rejectionStrategy ?? 'resample'}
                        onChange={(e) => updateConstraints({ rejectionStrategy: e.target.value as 'resample' | 'kill' })}
                    >
                        <option value="resample">Resample (pick a new site)</option>
                        <option value="kill">Kill (accept and terminate)</option>
                    </select>
                </div>
            </div>
        </div>
    );
}

/**
 * Update the surface-source-writing settings, normalizing an empty object to undefined.
 * @param host - Simulation dashboard widget host.
 * @param updates - Partial surface source write settings.
 */
function updateSurfaceSourceWrite(host: SimulationDashboardWidget, updates: Partial<OpenMCSurfaceSourceWrite>): void {
    const settings = host.stateManager.getState().settings;
    const merged = { ...(settings.surfaceSourceWrite ?? {}), ...updates };
    const hasContent = Object.values(merged).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
    host.stateManager.updateSettings({ surfaceSourceWrite: hasContent ? merged : undefined });
}

/**
 * Render the surface source writing/reading editors (surf_source_write / surf_source_read).
 * @param host - Simulation dashboard widget host.
 * @param state - Current OpenMC simulation state.
 * @returns Surface source section React node.
 */
export function renderSurfaceSourceSection(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
    const ssw = state.settings.surfaceSourceWrite;
    const ssr = state.settings.surfaceSourceRead;

    return (
        <div className="surface-source-section">
            <h4>
                <i className="codicon codicon-save"></i> Surface Source Writing
            </h4>
            <div className="form-row">
                <div className="form-group">
                    <label>Surface IDs</label>
                    <input
                        type="text"
                        value={(ssw?.surfaceIds ?? []).join(' ')}
                        placeholder="e.g. 1 2 3"
                        onChange={(e) => {
                            const parsed = parseNumberList(e.target.value).map((n) => Math.trunc(n));
                            if (!arraysEqual(parsed, ssw?.surfaceIds ?? [])) {
                                updateSurfaceSourceWrite(host, { surfaceIds: parsed.length > 0 ? parsed : undefined });
                            }
                        }}
                    />
                    <span className="form-hint">Bank particles crossing these surfaces into a surface source file</span>
                </div>
                <div className="form-group">
                    <label>Max Particles (per process)</label>
                    <input
                        type="number"
                        min={1}
                        value={ssw?.maxParticles ?? ''}
                        placeholder="Default (1000000)"
                        onChange={(e) =>
                            updateSurfaceSourceWrite(host, { maxParticles: e.target.value ? parseInt(e.target.value) : undefined })
                        }
                    />
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Cell (either direction)</label>
                    <input
                        type="number"
                        min={1}
                        value={ssw?.cell ?? ''}
                        placeholder="Cell ID"
                        onChange={(e) => updateSurfaceSourceWrite(host, { cell: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                </div>
                <div className="form-group">
                    <label>Cell From (leaving)</label>
                    <input
                        type="number"
                        min={1}
                        value={ssw?.cellfrom ?? ''}
                        placeholder="Cell ID"
                        onChange={(e) =>
                            updateSurfaceSourceWrite(host, { cellfrom: e.target.value ? parseInt(e.target.value) : undefined })
                        }
                    />
                </div>
                <div className="form-group">
                    <label>Cell To (entering)</label>
                    <input
                        type="number"
                        min={1}
                        value={ssw?.cellto ?? ''}
                        placeholder="Cell ID"
                        onChange={(e) => updateSurfaceSourceWrite(host, { cellto: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Max Source Files</label>
                    <input
                        type="number"
                        min={1}
                        value={ssw?.maxSourceFiles ?? ''}
                        placeholder="Default"
                        onChange={(e) =>
                            updateSurfaceSourceWrite(host, { maxSourceFiles: e.target.value ? parseInt(e.target.value) : undefined })
                        }
                    />
                </div>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={ssw?.mcpl ?? false}
                            onChange={(e) => updateSurfaceSourceWrite(host, { mcpl: e.target.checked ? true : undefined })}
                        />
                        Write MCPL format (instead of HDF5)
                    </label>
                </div>
            </div>

            <h4>
                <i className="codicon codicon-folder-opened"></i> Surface Source Reading
            </h4>
            <div className="form-row">
                <div className="form-group">
                    <label>Surface Source File</label>
                    <input
                        type="text"
                        value={ssr?.path ?? ''}
                        placeholder="surface_source.h5"
                        onChange={(e) =>
                            host.stateManager.updateSettings({ surfaceSourceRead: e.target.value ? { path: e.target.value } : undefined })
                        }
                    />
                </div>
                <div className="form-group">
                    <label>&nbsp;</label>
                    <Tooltip content="Select a surface source file">
                        <button
                            className="theia-button secondary"
                            onClick={async () => {
                                const path = await browseFile(host, 'Select Surface Source File', {
                                    'Source Files': ['h5', 'hdf5', 'mcpl'],
                                    'All Files': ['*']
                                });
                                if (path) {
                                    host.stateManager.updateSettings({ surfaceSourceRead: { path } });
                                }
                            }}
                        >
                            <i className="codicon codicon-folder-opened"></i> Browse
                        </button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}
