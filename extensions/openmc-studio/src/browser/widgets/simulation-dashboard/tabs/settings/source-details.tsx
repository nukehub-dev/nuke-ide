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
    OpenMCMeshSource,
    OpenMCTokamakSource,
    OpenMCIndependentSource,
    OpenMCSourceEnergy,
    OpenMCSurfaceSourceWrite
} from '../../../../../common/openmc-state-schema';
import { getMeshElementCount } from '../../../../../common/mesh-utils';
import type { SimulationDashboardWidget } from '../../simulation-dashboard-widget';
import { CollapsibleSection } from './collapsible-section';
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
    } else if (type === 'mesh') {
        next = { ...base, type: 'mesh', sources: [] };
    } else if (type === 'tokamak') {
        // ITER-like defaults (values in cm; profile must run 0 → 1)
        next = {
            ...base,
            type: 'tokamak',
            majorRadius: 600,
            minorRadius: 200,
            elongation: 1.7,
            triangularity: 0.33,
            shafranovShift: 30,
            profile: [
                { r: 0, s: 1 },
                { r: 0.5, s: 0.8 },
                { r: 1, s: 0 }
            ],
            energy: { type: 'discrete', energies: [14.1e6] }
        };
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
 * Build a default per-element sub-source for a mesh source.
 * Spatial is a placeholder only — MeshSource ignores sub-source spatial
 * distributions at runtime (openmc/source.py MeshSource sources setter).
 * @returns Default independent sub-source.
 */
function defaultMeshSubSource(): OpenMCIndependentSource {
    return {
        type: 'independent',
        spatial: { type: 'point', origin: [0, 0, 0] },
        energy: { type: 'discrete', energies: [1e6] },
        particle: 'neutron',
        strength: 1.0
    };
}

/**
 * Build a fresh energy distribution of the given type with sane defaults.
 * @param type - Energy distribution type.
 * @returns Default energy distribution.
 */
function defaultEnergyOfType(type: OpenMCSourceEnergy['type']): OpenMCSourceEnergy {
    switch (type) {
        case 'uniform':
            return { type: 'uniform', min: 0, max: 20e6 };
        case 'maxwell':
            return { type: 'maxwell', temperature: 293.6 };
        case 'watt':
            return { type: 'watt', a: 0.988e6, b: 2.249e-6 };
        default:
            return { type: 'discrete', energies: [1e6] };
    }
}

/**
 * Render the type-specific parameter fields for an energy distribution.
 * @param energy - Energy distribution to edit.
 * @param apply - Callback replacing the energy distribution.
 * @returns Parameter fields React node.
 */
function renderEnergyParamFields(energy: OpenMCSourceEnergy, apply: (energy: OpenMCSourceEnergy) => void): React.ReactNode {
    if (energy.type === 'uniform') {
        return (
            <>
                <div className="form-group">
                    <label>Min Energy (eV)</label>
                    <input
                        type="number"
                        step="any"
                        value={energy.min}
                        onChange={(e) => apply({ ...energy, min: parseFloat(e.target.value) || 0 })}
                    />
                </div>
                <div className="form-group">
                    <label>Max Energy (eV)</label>
                    <input
                        type="number"
                        step="any"
                        value={energy.max}
                        onChange={(e) => apply({ ...energy, max: parseFloat(e.target.value) || 0 })}
                    />
                </div>
            </>
        );
    }
    if (energy.type === 'maxwell') {
        return (
            <div className="form-group">
                <label>Temperature (K)</label>
                <input
                    type="number"
                    step="any"
                    value={energy.temperature}
                    onChange={(e) => apply({ ...energy, temperature: parseFloat(e.target.value) || 0 })}
                />
            </div>
        );
    }
    if (energy.type === 'watt') {
        return (
            <>
                <div className="form-group">
                    <label>Watt a (eV)</label>
                    <input
                        type="number"
                        step="any"
                        value={energy.a}
                        onChange={(e) => apply({ ...energy, a: parseFloat(e.target.value) || 0 })}
                    />
                </div>
                <div className="form-group">
                    <label>Watt b (1/eV)</label>
                    <input
                        type="number"
                        step="any"
                        value={energy.b}
                        onChange={(e) => apply({ ...energy, b: parseFloat(e.target.value) || 0 })}
                    />
                </div>
            </>
        );
    }
    // discrete: single energy value
    const discrete = energy as { energies?: number[] };
    return (
        <div className="form-group">
            <label>Energy (eV)</label>
            <input
                type="number"
                step="any"
                value={discrete.energies?.[0] ?? 1e6}
                onChange={(e) => apply({ type: 'discrete', energies: [parseFloat(e.target.value) || 1e6] })}
            />
        </div>
    );
}

/**
 * Render the energy type select plus type-specific parameter fields.
 * Shared by the mesh sub-source editor and the tokamak source editor.
 * @param energy - Energy distribution to edit.
 * @param apply - Callback replacing the energy distribution.
 * @returns Energy editor React node.
 */
function renderEnergyFields(energy: OpenMCSourceEnergy, apply: (energy: OpenMCSourceEnergy) => void): React.ReactNode {
    return (
        <>
            <div className="form-group">
                <label>Energy</label>
                <select value={energy.type} onChange={(e) => apply(defaultEnergyOfType(e.target.value as OpenMCSourceEnergy['type']))}>
                    <option value="discrete">Discrete</option>
                    <option value="uniform">Uniform</option>
                    <option value="maxwell">Maxwell</option>
                    <option value="watt">Watt</option>
                </select>
            </div>
            {renderEnergyParamFields(energy, apply)}
        </>
    );
}

/**
 * Render the editor for a mesh source (openmc.MeshSource): a mesh selector
 * plus one independent sub-source per mesh element. This OpenMC version
 * requires exactly mesh.n_elements sub-sources; the total strength is the
 * computed sum of sub-source strengths.
 * @param host - Simulation dashboard widget host.
 * @param source - Mesh source to edit.
 * @param index - Source index in the sources array.
 * @param state - Current OpenMC simulation state (for the mesh list).
 * @returns Mesh source editor React node.
 */
export function renderMeshSourceEditor(
    host: SimulationDashboardWidget,
    source: OpenMCMeshSource,
    index: number,
    state: OpenMCState
): React.ReactNode {
    const meshes = state.meshes;
    const selectedMesh = source.meshId !== undefined ? meshes.find((m) => m.id === source.meshId) : undefined;
    const elementCount = selectedMesh ? getMeshElementCount(selectedMesh) : undefined;
    const subs = source.sources ?? [];
    const totalStrength = subs.reduce((sum, s) => sum + (s.strength ?? 1.0), 0);

    const updateSubs = (next: OpenMCIndependentSource[]): void => updateSourceAt(host, index, { sources: next });
    const updateSub = (j: number, updates: Partial<OpenMCIndependentSource>): void =>
        updateSubs(subs.map((s, i) => (i === j ? ({ ...s, ...updates } as OpenMCIndependentSource) : s)));

    return (
        <div className="source-editor">
            <div className="form-row">
                <div className="form-group">
                    <label>Mesh</label>
                    <select
                        value={source.meshId ?? ''}
                        onChange={(e) => updateSourceAt(host, index, { meshId: e.target.value ? parseInt(e.target.value) : undefined })}
                    >
                        <option value="">Select mesh…</option>
                        {meshes.map((mesh) => (
                            <option key={mesh.id} value={mesh.id}>
                                {mesh.name || `Mesh ${mesh.id}`} ({mesh.type})
                            </option>
                        ))}
                    </select>
                    <span className="form-hint">
                        {meshes.length === 0
                            ? 'No meshes defined — create one in the Tally Configurator (Meshes section)'
                            : 'Source sites are generated uniformly within mesh elements'}
                    </span>
                </div>
                <div className="form-group">
                    <label>Total Strength</label>
                    <div>
                        <span className="strength-chip">×{totalStrength}</span>
                    </div>
                    <span className="form-hint">Computed: sum of sub-source strengths</span>
                </div>
            </div>
            {selectedMesh && elementCount !== undefined && subs.length !== elementCount && (
                <span className="form-hint">
                    Selected mesh has {elementCount} elements — exactly {elementCount} sub-sources required (one per element), currently{' '}
                    {subs.length}
                </span>
            )}

            {subs.map((sub, j) => (
                <div key={j} className="form-row">
                    <div className="form-group">
                        <label>Element {j + 1} · Strength</label>
                        <input
                            type="number"
                            min={0}
                            step="any"
                            value={sub.strength ?? 1.0}
                            onChange={(e) => updateSub(j, { strength: parseFloat(e.target.value) || 1.0 })}
                        />
                    </div>
                    <div className="form-group">
                        <label>Particle</label>
                        <select
                            value={sub.particle ?? 'neutron'}
                            onChange={(e) => updateSub(j, { particle: e.target.value as 'neutron' | 'photon' })}
                        >
                            <option value="neutron">Neutron</option>
                            <option value="photon">Photon</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Energy</label>
                        <select
                            value={sub.energy.type}
                            onChange={(e) => updateSub(j, { energy: defaultEnergyOfType(e.target.value as OpenMCSourceEnergy['type']) })}
                        >
                            <option value="discrete">Discrete</option>
                            <option value="uniform">Uniform</option>
                            <option value="maxwell">Maxwell</option>
                            <option value="watt">Watt</option>
                        </select>
                    </div>
                    {renderEnergyParamFields(sub.energy, (energy) => updateSub(j, { energy }))}
                    <div className="form-group">
                        <label aria-hidden="true">&nbsp;</label>
                        <Tooltip content="Remove Sub-source" position="top">
                            <button className="theia-button secondary small" onClick={() => updateSubs(subs.filter((_, i) => i !== j))}>
                                <i className="codicon codicon-trash"></i>
                            </button>
                        </Tooltip>
                    </div>
                </div>
            ))}

            <div className="form-row">
                <div className="form-group">
                    <button className="theia-button secondary small" onClick={() => updateSubs([...subs, defaultMeshSubSource()])}>
                        <i className="codicon codicon-add"></i> Add Sub-source
                    </button>
                </div>
                {selectedMesh && elementCount !== undefined && subs.length > 0 && subs.length < elementCount && (
                    <div className="form-group">
                        <Tooltip content="Append copies of the first sub-source until every mesh element has one" position="top">
                            <button
                                className="theia-button secondary small"
                                onClick={() => {
                                    const filled = [...subs];
                                    while (filled.length < elementCount) {
                                        filled.push({ ...subs[0], energy: { ...subs[0].energy } });
                                    }
                                    updateSubs(filled);
                                }}
                            >
                                <i className="codicon codicon-copy"></i> Fill to {elementCount}
                            </button>
                        </Tooltip>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Render the editor for a tokamak source (openmc.TokamakSource): Miller
 * flux-surface geometry, emission profile S(r/a) as an editable (r, s) pair
 * table, and a single neutron energy distribution.
 * @param host - Simulation dashboard widget host.
 * @param source - Tokamak source to edit.
 * @param index - Source index in the sources array.
 * @returns Tokamak source editor React node.
 */
export function renderTokamakSourceEditor(host: SimulationDashboardWidget, source: OpenMCTokamakSource, index: number): React.ReactNode {
    const update = (updates: Partial<OpenMCTokamakSource>): void => updateSourceAt(host, index, updates);
    const profile = source.profile ?? [];

    const updateProfilePoint = (i: number, updates: Partial<{ r: number; s: number }>): void =>
        update({ profile: profile.map((p, j) => (j === i ? { ...p, ...updates } : p)) });

    return (
        <div className="source-editor">
            <h4>
                <i className="codicon codicon-globe"></i> Plasma Geometry
            </h4>
            <div className="form-row">
                <div className="form-group">
                    <label>Major Radius R₀ (cm)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.majorRadius}
                        onChange={(e) => update({ majorRadius: parseFloat(e.target.value) || 0 })}
                    />
                </div>
                <div className="form-group">
                    <label>Minor Radius a (cm)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.minorRadius}
                        onChange={(e) => update({ minorRadius: parseFloat(e.target.value) || 0 })}
                    />
                </div>
                <div className="form-group">
                    <label>Elongation κ</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.elongation}
                        onChange={(e) => update({ elongation: parseFloat(e.target.value) || 0 })}
                    />
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>Triangularity δ</label>
                    <input
                        type="number"
                        min={-1}
                        max={1}
                        step="any"
                        value={source.triangularity}
                        onChange={(e) => update({ triangularity: parseFloat(e.target.value) || 0 })}
                    />
                    <span className="form-hint">In [-1, 1]</span>
                </div>
                <div className="form-group">
                    <label>Shafranov Shift Δ (cm)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.shafranovShift}
                        onChange={(e) => update({ shafranovShift: parseFloat(e.target.value) || 0 })}
                    />
                    <span className="form-hint">Must be &lt; a/2</span>
                </div>
                <div className="form-group">
                    <label>Vertical Shift (cm)</label>
                    <input
                        type="number"
                        step="any"
                        value={source.verticalShift ?? 0}
                        onChange={(e) => update({ verticalShift: parseFloat(e.target.value) || 0 })}
                    />
                </div>
            </div>

            <h4>
                <i className="codicon codicon-graph-line"></i> Emission Profile S(r/a)
            </h4>
            {profile.map((point, i) => (
                <div className="form-row" key={i}>
                    <div className="form-group">
                        <label>r/a</label>
                        <input
                            type="number"
                            min={0}
                            max={1}
                            step="any"
                            value={point.r}
                            onChange={(e) => updateProfilePoint(i, { r: parseFloat(e.target.value) || 0 })}
                        />
                    </div>
                    <div className="form-group">
                        <label>S</label>
                        <input
                            type="number"
                            min={0}
                            step="any"
                            value={point.s}
                            onChange={(e) => updateProfilePoint(i, { s: parseFloat(e.target.value) || 0 })}
                        />
                    </div>
                    <div className="form-group">
                        <label aria-hidden="true">&nbsp;</label>
                        <Tooltip content="Remove Point" position="top">
                            <button
                                className="theia-button secondary small"
                                onClick={() => update({ profile: profile.filter((_, j) => j !== i) })}
                            >
                                <i className="codicon codicon-trash"></i>
                            </button>
                        </Tooltip>
                    </div>
                </div>
            ))}
            <div className="form-row">
                <div className="form-group">
                    <button
                        className="theia-button secondary small"
                        onClick={() => {
                            const lastR = profile.length > 0 ? profile[profile.length - 1].r : 0;
                            const nextR = Math.min(1, lastR + (profile.length > 1 ? lastR - profile[profile.length - 2].r : 0.5));
                            update({ profile: [...profile, { r: nextR, s: 0 }] });
                        }}
                    >
                        <i className="codicon codicon-add"></i> Add Point
                    </button>
                </div>
            </div>
            <span className="form-hint">
                r/a must start at 0, end at 1, and strictly increase; S ≥ 0 with at least one positive value (arbitrary units, linearly
                interpolated between points)
            </span>

            <h4>
                <i className="codicon codicon-pulse"></i> Energy &amp; Sampling
            </h4>
            <div className="form-row">
                {renderEnergyFields(source.energy, (energy) => update({ energy }))}
                <div className="form-group">
                    <label>Strength</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.strength ?? 1.0}
                        onChange={(e) => update({ strength: parseFloat(e.target.value) || 1.0 })}
                    />
                </div>
            </div>
            <div className="form-row">
                <div className="form-group">
                    <label>φ Start (rad)</label>
                    <input
                        type="number"
                        step="any"
                        value={source.phiStart ?? 0}
                        onChange={(e) => update({ phiStart: parseFloat(e.target.value) || 0 })}
                    />
                </div>
                <div className="form-group">
                    <label>φ Extent (rad)</label>
                    <input
                        type="number"
                        min={0}
                        step="any"
                        value={source.phiExtent ?? 2 * Math.PI}
                        onChange={(e) => update({ phiExtent: parseFloat(e.target.value) || 2 * Math.PI })}
                    />
                    <span className="form-hint">Toroidal coverage, up to 2π</span>
                </div>
                <div className="form-group">
                    <label>Poloidal Grid Points</label>
                    <input
                        type="number"
                        min={3}
                        value={source.nAlpha ?? 101}
                        onChange={(e) => update({ nAlpha: parseInt(e.target.value) || 101 })}
                    />
                    <span className="form-hint">CDF sampling resolution (default 101)</span>
                </div>
            </div>
        </div>
    );
}

/**
 * Build a one-line summary of the active constraints for the collapsed header.
 * @param constraints - Source constraints to summarize.
 * @returns Summary string, or empty when nothing is set.
 */
function summarizeConstraints(constraints: OpenMCSource['constraints']): string {
    if (!constraints) {
        return '';
    }
    const parts: string[] = [];
    if (constraints.domainType) {
        parts.push(`domain: ${constraints.domainType}`);
    }
    if (constraints.energyBounds) {
        parts.push('E bounds set');
    }
    if (constraints.timeBounds) {
        parts.push('T bounds set');
    }
    if (constraints.fissionable) {
        parts.push('fissionable');
    }
    if (constraints.rejectionStrategy && constraints.rejectionStrategy !== 'resample') {
        parts.push(constraints.rejectionStrategy);
    }
    return parts.join(' · ');
}

/**
 * Collapsible constraints editor for a source (domain/fissionable/energy/time/rejection).
 * Collapsed by default when no constraints are set; shows a one-line summary when collapsed.
 * @param props - Host, source, and source index.
 * @returns Constraints editor React node.
 */
export function ConstraintsEditor(props: { host: SimulationDashboardWidget; source: OpenMCSource; index: number }): React.ReactNode {
    const { host, source, index } = props;
    const constraints = source.constraints;
    const [collapsed, setCollapsed] = React.useState(!constraints || Object.keys(constraints).length === 0);

    const updateConstraints = (updates: Partial<NonNullable<OpenMCSource['constraints']>>): void => {
        const merged = { ...(constraints ?? {}), ...updates };
        // Normalize: drop the constraints object entirely when nothing is set
        const hasContent = Object.values(merged).some((v) => v !== undefined && (!Array.isArray(v) || v.length > 0));
        updateSourceAt(host, index, { constraints: hasContent ? merged : undefined });
    };

    const energyBounds = constraints?.energyBounds;
    const timeBounds = constraints?.timeBounds;
    const summary = summarizeConstraints(constraints);

    return (
        <div className="constraints-editor">
            <div className="category-header" onClick={() => setCollapsed(!collapsed)}>
                <i className={`codicon codicon-chevron-${collapsed ? 'right' : 'down'}`}></i>
                <span>Source Constraints</span>
                {collapsed && summary && <span className="summary-chip">{summary}</span>}
                {collapsed && !summary && <span className="summary-chip">none set</span>}
            </div>
            {!collapsed && (
                <>
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
                        <div className="form-group checkbox stacked">
                            <label aria-hidden="true">&nbsp;</label>
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
                </>
            )}
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
        <CollapsibleSection title="Surface Source" icon="save" defaultOpen={false}>
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
                <div className="form-group checkbox stacked">
                    <label aria-hidden="true">&nbsp;</label>
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
        </CollapsibleSection>
    );
}
