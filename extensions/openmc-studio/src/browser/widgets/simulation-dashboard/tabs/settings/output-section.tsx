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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCSettings, OpenMCCollisionTrack } from '../../../../../common/openmc-state-schema';
import type { SimulationDashboardWidget } from '../../simulation-dashboard-widget';
import { parseNumberList, parseStringList, arraysEqual } from './section-utils';

type SourcePoint = NonNullable<OpenMCSettings['sourcePoint']>;
type OutputOptions = NonNullable<OpenMCSettings['output']>;

/**
 * Update the output control options, normalizing an empty object to undefined.
 * @param host - Simulation dashboard widget host.
 * @param updates - Partial output options.
 */
function updateOutput(host: SimulationDashboardWidget, updates: Partial<OutputOptions>): void {
    const settings = host.stateManager.getState().settings;
    const merged = { ...(settings.output ?? {}), ...updates };
    const hasContent = Object.values(merged).some((v) => v !== undefined);
    host.stateManager.updateSettings({ output: hasContent ? merged : undefined });
}

/**
 * Update the sourcepoint options, normalizing an empty object to undefined.
 * @param host - Simulation dashboard widget host.
 * @param updates - Partial sourcepoint options.
 */
function updateSourcePoint(host: SimulationDashboardWidget, updates: Partial<SourcePoint>): void {
    const settings = host.stateManager.getState().settings;
    const merged = { ...(settings.sourcePoint ?? {}), ...updates };
    const hasContent = Object.values(merged).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
    host.stateManager.updateSettings({ sourcePoint: hasContent ? merged : undefined });
}

/**
 * Update the collision track options, normalizing an empty object to undefined.
 * @param host - Simulation dashboard widget host.
 * @param updates - Partial collision track options.
 */
function updateCollisionTrack(host: SimulationDashboardWidget, updates: Partial<OpenMCCollisionTrack>): void {
    const settings = host.stateManager.getState().settings;
    const merged = { ...(settings.collisionTrack ?? {}), ...updates };
    const hasContent = Object.values(merged).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
    host.stateManager.updateSettings({ collisionTrack: hasContent ? merged : undefined });
}

/**
 * Update the run-level tally trigger settings, normalizing an empty object to undefined.
 * @param host - Simulation dashboard widget host.
 * @param updates - Partial trigger settings.
 */
function updateTriggerSettings(host: SimulationDashboardWidget, updates: Partial<NonNullable<OpenMCState['settings']['triggers']>>): void {
    const settings = host.stateManager.getState().settings;
    const merged = { ...(settings.triggers ?? {}), ...updates };
    const hasContent = Object.values(merged).some((v) => v !== undefined);
    host.stateManager.updateSettings({ triggers: hasContent ? merged : undefined });
}

/**
 * Render the Output section: summary/tallies output control, statepoint and
 * sourcepoint options, particle tracks, and collision track output.
 * @param host - Simulation dashboard widget host.
 * @param state - Current OpenMC simulation state.
 * @returns Output section React node.
 */
export function renderOutputSection(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
    const settings = state.settings;
    const output = settings.output;
    const sourcePoint = settings.sourcePoint;
    const collisionTrack = settings.collisionTrack;
    const tracks = settings.tracks ?? [];
    const statepointBatches = Array.isArray(settings.statepointBatches)
        ? settings.statepointBatches
        : (settings.statepointBatches?.at ?? []);

    // summary.h5 falls back to the legacy outputSummary field
    const summaryEnabled = output?.summary ?? settings.outputSummary ?? true;

    return (
        <div className="output-section">
            <h4>
                <i className="codicon codicon-output"></i> Output Files
            </h4>
            <div className="checkbox-grid">
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={summaryEnabled}
                            onChange={(e) => updateOutput(host, { summary: e.target.checked })}
                        />
                        Write summary.h5
                    </label>
                </div>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={output?.tallies ?? true}
                            onChange={(e) => updateOutput(host, { tallies: e.target.checked })}
                        />
                        Write tallies.out
                    </label>
                </div>
            </div>

            <h4>
                <i className="codicon codicon-database"></i> Statepoint
            </h4>
            <div className="form-group">
                <label>Statepoint Batches</label>
                <input
                    type="text"
                    value={statepointBatches.join(' ')}
                    placeholder="All batches (default)"
                    onChange={(e) => {
                        const parsed = parseNumberList(e.target.value).map((n) => Math.trunc(n));
                        if (!arraysEqual(parsed, statepointBatches)) {
                            host.stateManager.updateSettings({ statepointBatches: parsed.length > 0 ? parsed : undefined });
                        }
                    }}
                />
                <span className="form-hint">Batch numbers at which to write statepoint files (e.g. 10 20 30)</span>
            </div>

            <h4>
                <i className="codicon codicon-symbol-namespace"></i> Sourcepoint
            </h4>
            <div className="checkbox-grid">
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={sourcePoint?.write ?? true}
                            onChange={(e) => updateSourcePoint(host, { write: e.target.checked })}
                        />
                        Write source points
                    </label>
                </div>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={sourcePoint?.separate ?? false}
                            onChange={(e) => updateSourcePoint(host, { separate: e.target.checked })}
                        />
                        Write to separate file (source.h5)
                    </label>
                </div>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={sourcePoint?.overwrite ?? false}
                            onChange={(e) => updateSourcePoint(host, { overwrite: e.target.checked })}
                        />
                        Overwrite latest statepoint
                    </label>
                </div>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={sourcePoint?.mcpl ?? false}
                            onChange={(e) => updateSourcePoint(host, { mcpl: e.target.checked })}
                        />
                        Write MCPL format
                    </label>
                </div>
            </div>
            <div className="form-group">
                <label>Sourcepoint Batches</label>
                <input
                    type="text"
                    value={(sourcePoint?.batches ?? []).join(' ')}
                    placeholder="All batches (default)"
                    onChange={(e) => {
                        const parsed = parseNumberList(e.target.value).map((n) => Math.trunc(n));
                        if (!arraysEqual(parsed, sourcePoint?.batches ?? [])) {
                            updateSourcePoint(host, { batches: parsed.length > 0 ? parsed : undefined });
                        }
                    }}
                />
                <span className="form-hint">Batches at which to write source points (statepoint batches are always included)</span>
            </div>

            <h4>
                <i className="codicon codicon-pulse"></i> Particle Tracks
            </h4>
            {tracks.length > 0 && (
                <div className="track-row track-header">
                    <label>Batch</label>
                    <label>Generation</label>
                    <label>Particle</label>
                    <span></span>
                </div>
            )}
            {tracks.map((track, trackIndex) => (
                <div className="track-row" key={trackIndex}>
                    {([0, 1, 2] as const).map((coord) => (
                        <input
                            key={coord}
                            type="number"
                            min={1}
                            value={track[coord]}
                            onChange={(e) => {
                                const newTracks = tracks.map((t) => [...t] as [number, number, number]);
                                newTracks[trackIndex][coord] = parseInt(e.target.value) || 1;
                                host.stateManager.updateSettings({ tracks: newTracks });
                            }}
                        />
                    ))}
                    <Tooltip content="Remove track" position="top">
                        <button
                            className="theia-button secondary small track-delete"
                            onClick={() =>
                                host.stateManager.updateSettings({
                                    tracks:
                                        tracks.filter((_, i) => i !== trackIndex).length > 0
                                            ? tracks.filter((_, i) => i !== trackIndex)
                                            : undefined
                                })
                            }
                        >
                            <i className="codicon codicon-trash"></i>
                        </button>
                    </Tooltip>
                </div>
            ))}
            <div className="form-row">
                <div className="form-group">
                    <button
                        className="theia-button secondary small"
                        onClick={() => host.stateManager.updateSettings({ tracks: [...tracks, [1, 1, 1]] })}
                    >
                        <i className="codicon codicon-add"></i> Add Track
                    </button>
                </div>
            </div>
            <div className="form-row">
                <div className="form-group max-tracks">
                    <label>Max Tracks</label>
                    <input
                        type="number"
                        min={1}
                        value={settings.maxTracks ?? ''}
                        placeholder="Default (1000)"
                        onChange={(e) =>
                            host.stateManager.updateSettings({ maxTracks: e.target.value ? parseInt(e.target.value) : undefined })
                        }
                    />
                </div>
            </div>
            <span className="form-hint">Track files record particle trajectories for visualization (tracks.h5)</span>

            <h4>
                <i className="codicon codicon-list-flat"></i> Collision Track
            </h4>
            <div className="form-group checkbox">
                <label>
                    <input
                        type="checkbox"
                        checked={collisionTrack !== undefined}
                        onChange={(e) =>
                            updateCollisionTrack(host, e.target.checked ? { maxCollisions: 1000 } : { maxCollisions: undefined })
                        }
                    />
                    Enable collision track output (collision_track.h5)
                </label>
            </div>
            {collisionTrack && (
                <>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Max Collisions</label>
                            <input
                                type="number"
                                min={1}
                                value={collisionTrack.maxCollisions ?? ''}
                                placeholder="Default (1000)"
                                onChange={(e) =>
                                    updateCollisionTrack(host, { maxCollisions: e.target.value ? parseInt(e.target.value) : undefined })
                                }
                            />
                        </div>
                        <div className="form-group">
                            <label>Max Files</label>
                            <input
                                type="number"
                                min={1}
                                value={collisionTrack.maxCollisionTrackFiles ?? ''}
                                placeholder="Default"
                                onChange={(e) =>
                                    updateCollisionTrack(host, {
                                        maxCollisionTrackFiles: e.target.value ? parseInt(e.target.value) : undefined
                                    })
                                }
                            />
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Reactions (MT numbers or names)</label>
                            <input
                                type="text"
                                value={(collisionTrack.reactions ?? []).join(' ')}
                                placeholder="e.g. 102 total"
                                onChange={(e) => {
                                    const parsed = parseStringList(e.target.value).map((token) =>
                                        /^-?\d+$/.test(token) ? parseInt(token) : token
                                    );
                                    if (!arraysEqual(parsed, collisionTrack.reactions ?? [])) {
                                        updateCollisionTrack(host, { reactions: parsed.length > 0 ? parsed : undefined });
                                    }
                                }}
                            />
                        </div>
                        <div className="form-group">
                            <label>Nuclides</label>
                            <input
                                type="text"
                                value={(collisionTrack.nuclides ?? []).join(' ')}
                                placeholder="e.g. U235 H1"
                                onChange={(e) => {
                                    const parsed = parseStringList(e.target.value);
                                    if (!arraysEqual(parsed, collisionTrack.nuclides ?? [])) {
                                        updateCollisionTrack(host, { nuclides: parsed.length > 0 ? parsed : undefined });
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Cell IDs</label>
                            <input
                                type="text"
                                value={(collisionTrack.cellIds ?? []).join(' ')}
                                placeholder="All cells"
                                onChange={(e) => {
                                    const parsed = parseNumberList(e.target.value).map((n) => Math.trunc(n));
                                    if (!arraysEqual(parsed, collisionTrack.cellIds ?? [])) {
                                        updateCollisionTrack(host, { cellIds: parsed.length > 0 ? parsed : undefined });
                                    }
                                }}
                            />
                        </div>
                        <div className="form-group">
                            <label>Material IDs</label>
                            <input
                                type="text"
                                value={(collisionTrack.materialIds ?? []).join(' ')}
                                placeholder="All materials"
                                onChange={(e) => {
                                    const parsed = parseNumberList(e.target.value).map((n) => Math.trunc(n));
                                    if (!arraysEqual(parsed, collisionTrack.materialIds ?? [])) {
                                        updateCollisionTrack(host, { materialIds: parsed.length > 0 ? parsed : undefined });
                                    }
                                }}
                            />
                        </div>
                        <div className="form-group">
                            <label>Universe IDs</label>
                            <input
                                type="text"
                                value={(collisionTrack.universeIds ?? []).join(' ')}
                                placeholder="All universes"
                                onChange={(e) => {
                                    const parsed = parseNumberList(e.target.value).map((n) => Math.trunc(n));
                                    if (!arraysEqual(parsed, collisionTrack.universeIds ?? [])) {
                                        updateCollisionTrack(host, { universeIds: parsed.length > 0 ? parsed : undefined });
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Deposited Energy Threshold (eV)</label>
                            <input
                                type="number"
                                min={0}
                                step="any"
                                value={collisionTrack.depositedEnergyThreshold ?? ''}
                                placeholder="None"
                                onChange={(e) =>
                                    updateCollisionTrack(host, {
                                        depositedEnergyThreshold: e.target.value ? parseFloat(e.target.value) : undefined
                                    })
                                }
                            />
                        </div>
                        <div className="form-group checkbox">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={collisionTrack.mcpl ?? false}
                                    onChange={(e) => updateCollisionTrack(host, { mcpl: e.target.checked ? true : undefined })}
                                />
                                Write MCPL format
                            </label>
                        </div>
                    </div>
                </>
            )}
            <h4>
                <i className="codicon codicon-debug-stop"></i> Tally Triggers
            </h4>
            <div className="form-row">
                <div className="form-group">
                    <label>Batch Interval</label>
                    <input
                        type="number"
                        min={1}
                        value={settings.triggers?.batchInterval ?? ''}
                        placeholder="Default (1)"
                        onChange={(e) =>
                            updateTriggerSettings(host, { batchInterval: e.target.value ? parseInt(e.target.value) : undefined })
                        }
                    />
                    <span className="form-hint">Evaluate per-tally triggers every N batches</span>
                </div>
                <div className="form-group">
                    <label>Max Batches</label>
                    <input
                        type="number"
                        min={1}
                        value={settings.triggers?.maxBatches ?? ''}
                        placeholder="No limit"
                        onChange={(e) => updateTriggerSettings(host, { maxBatches: e.target.value ? parseInt(e.target.value) : undefined })}
                    />
                    <span className="form-hint">Stop even if no trigger has fired</span>
                </div>
            </div>
            <span className="form-hint">
                Triggers are configured per tally in the Tally Configurator (Triggers section); trigger activation is emitted automatically
                when any tally has triggers.
            </span>
        </div>
    );
}
