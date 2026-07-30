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
import { injectable } from '@theia/core/shared/inversify';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import {
    OpenMCState,
    OpenMCRunSettings,
    OpenMCSource,
    OpenMCSourceType,
    OpenMCIndependentSource,
    OpenMCFileSource,
    OpenMCCompiledSource,
    OpenMCSourceSpatial,
    OpenMCSourceEnergy
} from '../../../../common/openmc-state-schema';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';
import { CollapsibleSection } from './settings/collapsible-section';
import {
    changeSourceType,
    renderFileSourceEditor,
    renderCompiledSourceEditor,
    ConstraintsEditor,
    renderSurfaceSourceSection
} from './settings/source-details';
import { renderOutputSection } from './settings/output-section';
import { renderPhysicsSection } from './settings/physics-section';
import { renderConvergenceSection } from './settings/convergence-section';
import { calculateGeometryBounds } from './settings/geometry-bounds';

/**
 * Settings tab of the simulation dashboard: run configuration and source definitions.
 */
@injectable()
export class SettingsTabContribution implements DashboardTabContribution {
    readonly id = 'settings';
    readonly label = 'Settings';
    readonly icon = 'settings';
    readonly order = 0;

    /** Indices of collapsed source cards (persisted per card index). */
    private readonly collapsedSources = new Set<number>();

    /**
     * Whether a source card is collapsed. Default: expanded for the first
     * source, collapsed for the others when there are multiple sources.
     * @param index - Source index.
     * @param totalSources - Total number of sources.
     * @returns Whether the card should render collapsed.
     */
    private isSourceCardCollapsed(index: number, totalSources: number): boolean {
        if (this.collapsedSources.has(index)) {
            return true;
        }
        return index > 0 && totalSources > 1;
    }

    /**
     * Toggle a source card's collapsed state.
     * @param host - Simulation dashboard widget host.
     * @param index - Source index.
     */
    private toggleSourceCard(host: SimulationDashboardWidget, index: number): void {
        if (this.collapsedSources.has(index)) {
            this.collapsedSources.delete(index);
        } else {
            this.collapsedSources.add(index);
        }
        host.update();
    }

    /**
     * Render the Settings tab with run configuration and source definitions.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Settings tab React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        const { settings } = state;
        const runSettings = settings.run;

        return (
            <div className="settings-tab">
                {/* DAGMC Mode Indicator */}
                {settings.dagmcFile && (
                    <div className="dagmc-mode-banner">
                        <div className="dagmc-icon">
                            <i className="codicon codicon-file-code"></i>
                        </div>
                        <div className="dagmc-info">
                            <strong>DAGMC Geometry Active</strong>
                            <span>{settings.dagmcFile.split('/').pop()}</span>
                        </div>
                        <div className="dagmc-actions">
                            <Tooltip content="Edit DAGMC geometry" position="bottom">
                                <button className="dagmc-edit-btn" onClick={() => host.openDagmcEditor()}>
                                    <i className="codicon codicon-edit"></i>
                                    Edit
                                </button>
                            </Tooltip>
                            <span className="dagmc-badge">DAGMC Mode</span>
                        </div>
                    </div>
                )}

                {/* Quick Start Guide */}
                <div className="quick-start-guide">
                    <h4>
                        <i className="codicon codicon-book"></i> Quick Start Guide
                    </h4>
                    <div className="guide-cards">
                        <div className="guide-card">
                            <div className="guide-icon">
                                <i className="codicon codicon-flame"></i>
                            </div>
                            <h5>Eigenvalue Mode</h5>
                            <p>For criticality calculations (k-effective). Use for reactors, critical assemblies.</p>
                            <code>
                                Particles: 1000-10000
                                <br />
                                Batches: 100-500
                            </code>
                        </div>
                        <div className="guide-card">
                            <div className="guide-icon">
                                <i className="codicon codicon-target"></i>
                            </div>
                            <h5>Fixed Source</h5>
                            <p>For shielding, dose calculations. Neutrons from defined source only.</p>
                            <code>
                                Particles: 10000+
                                <br />
                                No inactive batches
                            </code>
                        </div>
                        <div className="guide-card">
                            <div className="guide-icon">
                                <i className="codicon codicon-rocket"></i>
                            </div>
                            <h5>Getting Started</h5>
                            <p>Start with fewer particles for testing, increase for production runs.</p>
                            <code>
                                Test: 100 particles
                                <br />
                                Production: 10000+
                            </code>
                        </div>
                    </div>
                </div>

                <CollapsibleSection title="General" icon="run">
                    <div className="form-group">
                        <label>Run Mode</label>
                        <select value={runSettings.mode} onChange={(e) => host.updateRunMode(e.target.value as OpenMCRunSettings['mode'])}>
                            <option value="eigenvalue">Eigenvalue (Criticality)</option>
                            <option value="fixed source">Fixed Source</option>
                            <option value="volume">Volume Calculation</option>
                        </select>
                    </div>

                    {runSettings.mode === 'eigenvalue' && (
                        <>
                            <div className="form-row">
                                <div className="form-group">
                                    <label>Particles per Generation</label>
                                    <input
                                        type="number"
                                        min={1}
                                        value={runSettings.particles}
                                        onChange={(e) =>
                                            host.updateSetting('run', {
                                                ...runSettings,
                                                particles: parseInt(e.target.value) || 1000
                                            })
                                        }
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Inactive Batches</label>
                                    <input
                                        type="number"
                                        min={0}
                                        value={runSettings.inactive}
                                        onChange={(e) =>
                                            host.updateSetting('run', {
                                                ...runSettings,
                                                inactive: parseInt(e.target.value) || 0
                                            })
                                        }
                                    />
                                </div>
                                <div className="form-group">
                                    <label>Active Batches</label>
                                    <input
                                        type="number"
                                        min={1}
                                        value={runSettings.batches}
                                        onChange={(e) =>
                                            host.updateSetting('run', {
                                                ...runSettings,
                                                batches: parseInt(e.target.value) || 10
                                            })
                                        }
                                    />
                                </div>
                            </div>
                        </>
                    )}

                    {runSettings.mode === 'fixed source' && (
                        <div className="form-row">
                            <div className="form-group">
                                <label>Particles per Batch</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={runSettings.particles}
                                    onChange={(e) =>
                                        host.updateSetting('run', {
                                            ...runSettings,
                                            particles: parseInt(e.target.value) || 1000
                                        })
                                    }
                                />
                            </div>
                            <div className="form-group">
                                <label>Batches</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={runSettings.batches}
                                    onChange={(e) =>
                                        host.updateSetting('run', {
                                            ...runSettings,
                                            batches: parseInt(e.target.value) || 10
                                        })
                                    }
                                />
                            </div>
                        </div>
                    )}
                    <h4>
                        <i className="codicon codicon-gear"></i> Advanced Settings
                    </h4>

                    <div className="form-row">
                        <div className="form-group">
                            <label>Random Seed</label>
                            <input
                                type="number"
                                value={settings.seed || ''}
                                placeholder="Random"
                                onChange={(e) => host.updateSetting('seed', e.target.value ? parseInt(e.target.value) : undefined)}
                            />
                        </div>
                        <div className="form-group">
                            <label>Threads</label>
                            <input
                                type="number"
                                min={1}
                                value={settings.threads || ''}
                                placeholder="Auto"
                                onChange={(e) => host.updateSetting('threads', e.target.value ? parseInt(e.target.value) : undefined)}
                            />
                        </div>
                    </div>

                    <div className="form-row">
                        <div className="form-group">
                            <label>Source Rejection Fraction (0-1)</label>
                            <input
                                type="number"
                                min={0}
                                max={1}
                                step={0.01}
                                value={settings.sourceRejectionFraction ?? 0.0}
                                placeholder="0.0"
                                onChange={(e) =>
                                    host.updateSetting('sourceRejectionFraction', e.target.value ? parseFloat(e.target.value) : undefined)
                                }
                            />
                            <span className="form-hint">Lower values allow more source sites. Set to 0.0 to disable rejection.</span>
                        </div>
                    </div>
                </CollapsibleSection>

                <CollapsibleSection
                    title="Sources"
                    icon="source-control"
                    actions={
                        <button className="theia-button secondary small" onClick={() => this.addSource(host)}>
                            <i className="codicon codicon-add"></i> Add Source
                        </button>
                    }
                >
                    {settings.sources.length === 0 ? (
                        <div className="empty-state">
                            <i className="codicon codicon-info"></i>
                            <p>
                                No sources defined. {runSettings.mode === 'eigenvalue' && 'A default point source at origin will be used.'}
                            </p>
                        </div>
                    ) : (
                        settings.sources.map((source, index) => {
                            const sourceType = source.type ?? 'independent';
                            const isCollapsed = this.isSourceCardCollapsed(index, settings.sources.length);
                            return (
                                <div key={index} className={`source-card${isCollapsed ? ' collapsed' : ''}`}>
                                    <div className="source-card-header">
                                        <i
                                            className={`codicon codicon-chevron-${isCollapsed ? 'right' : 'down'} source-card-chevron`}
                                            onClick={() => this.toggleSourceCard(host, index)}
                                        ></i>
                                        <span className="source-card-title">Source {index + 1}</span>
                                        <span className="strength-chip">×{source.strength ?? 1.0}</span>
                                        <div className="segmented-control">
                                            {(['independent', 'file', 'compiled'] as const).map((type) => (
                                                <button
                                                    key={type}
                                                    className={`segment${sourceType === type ? ' active' : ''}`}
                                                    onClick={() => changeSourceType(host, index, type as OpenMCSourceType)}
                                                >
                                                    {type === 'independent' ? 'Independent' : type === 'file' ? 'File' : 'Compiled'}
                                                </button>
                                            ))}
                                        </div>
                                        <Tooltip content="Remove Source" position="top">
                                            <button className="theia-button secondary small" onClick={() => this.removeSource(host, index)}>
                                                <i className="codicon codicon-trash"></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                    {!isCollapsed && (
                                        <div className="source-card-body">
                                            {sourceType === 'independent' &&
                                                this.renderSourceEditor(host, source as OpenMCIndependentSource, index)}
                                            {sourceType === 'file' && renderFileSourceEditor(host, source as OpenMCFileSource, index)}
                                            {sourceType === 'compiled' &&
                                                renderCompiledSourceEditor(host, source as OpenMCCompiledSource, index)}
                                            <ConstraintsEditor host={host} source={source} index={index} />
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}

                    {renderSurfaceSourceSection(host, state)}
                </CollapsibleSection>

                <CollapsibleSection title="Output" icon="output" defaultOpen={false}>
                    {renderOutputSection(host, state)}
                </CollapsibleSection>

                <CollapsibleSection title="Physics" icon="symbol-misc" defaultOpen={false}>
                    {renderPhysicsSection(host, state)}
                </CollapsibleSection>

                <CollapsibleSection title="Convergence" icon="graph" defaultOpen={false}>
                    {renderConvergenceSection(host, state, (s) => this.calculateGeometryBounds(s))}
                </CollapsibleSection>
            </div>
        );
    }

    /**
     * Render the editor for a single neutron/photon source.
     * @param host - Simulation dashboard widget host.
     * @param source - Source definition to edit.
     * @param index - Source index in the sources array.
     * @returns Source editor React node.
     */
    private renderSourceEditor(host: SimulationDashboardWidget, source: OpenMCIndependentSource, index: number): React.ReactNode {
        const spatial = source.spatial as any;
        const snapActions: Record<string, { label: string; icon: string; action: () => void }[]> = {
            point: [
                { label: 'Geometry Center', icon: 'target', action: () => this.snapSourceToGeometryCenter(host, index) },
                { label: 'Sphere Center', icon: 'circle-outline', action: () => this.setSourceToSphereCenter(host, index) },
                { label: 'Cylinder Axis', icon: 'dash', action: () => this.setSourceToCylinderAxis(host, index) }
            ],
            box: [
                { label: 'Tight Fit', icon: 'target', action: () => this.snapSourceToGeometryBounds(host, index, 0) },
                { label: 'With Padding', icon: 'expand-all', action: () => this.snapSourceToGeometryBounds(host, index, 0.1) }
            ],
            sphere: [
                { label: 'Match Surface', icon: 'circle-outline', action: () => this.snapSourceToMatchSphere(host, index) },
                { label: 'Enclose All', icon: 'expand-all', action: () => this.snapSourceToEncloseGeometry(host, index) }
            ]
        };

        return (
            <div className="source-editor">
                {/* Source Header */}
                <div className="source-editor-header">
                    <div className="source-type-select">
                        <label>Spatial Distribution</label>
                        <select
                            value={source.spatial.type}
                            onChange={(e) => this.updateSourceSpatial(host, index, e.target.value as OpenMCSourceSpatial['type'])}
                        >
                            <option value="point">Point</option>
                            <option value="box">Box</option>
                            <option value="sphere">Sphere</option>
                            <option value="cylinder">Cylinder</option>
                        </select>
                    </div>
                    <button className="theia-button secondary snap-main-btn" onClick={() => this.snapSourceToGeometry(host, index)}>
                        <i className="codicon codicon-target"></i>
                        <span>Snap to Geometry</span>
                    </button>
                </div>

                {/* Quick Snap Actions */}
                {snapActions[source.spatial.type] && (
                    <div className="source-quick-snaps">
                        <span className="quick-snaps-label">Quick Position:</span>
                        <div className="quick-snaps-buttons">
                            {snapActions[source.spatial.type].map((btn, btnIdx) => (
                                <button key={btnIdx} className="theia-button secondary small" onClick={btn.action}>
                                    <i className={`codicon codicon-${btn.icon}`}></i>
                                    {btn.label}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {source.spatial.type === 'point' && (
                    <div className="form-row">
                        <div className="form-group">
                            <label>X</label>
                            <input
                                type="number"
                                step="0.1"
                                value={spatial.origin?.[0] || 0}
                                onChange={(e) => this.updateSourceOrigin(host, index, 0, parseFloat(e.target.value))}
                            />
                        </div>
                        <div className="form-group">
                            <label>Y</label>
                            <input
                                type="number"
                                step="0.1"
                                value={spatial.origin?.[1] || 0}
                                onChange={(e) => this.updateSourceOrigin(host, index, 1, parseFloat(e.target.value))}
                            />
                        </div>
                        <div className="form-group">
                            <label>Z</label>
                            <input
                                type="number"
                                step="0.1"
                                value={spatial.origin?.[2] || 0}
                                onChange={(e) => this.updateSourceOrigin(host, index, 2, parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
                )}

                {source.spatial.type === 'box' && (
                    <>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Min X</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.lowerLeft?.[0] ?? -5}
                                    onChange={(e) => this.updateSourceBoxBound(host, index, 'lowerLeft', 0, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Min Y</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.lowerLeft?.[1] ?? -5}
                                    onChange={(e) => this.updateSourceBoxBound(host, index, 'lowerLeft', 1, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Min Z</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.lowerLeft?.[2] ?? -5}
                                    onChange={(e) => this.updateSourceBoxBound(host, index, 'lowerLeft', 2, parseFloat(e.target.value))}
                                />
                            </div>
                        </div>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Max X</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.upperRight?.[0] ?? 5}
                                    onChange={(e) => this.updateSourceBoxBound(host, index, 'upperRight', 0, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Max Y</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.upperRight?.[1] ?? 5}
                                    onChange={(e) => this.updateSourceBoxBound(host, index, 'upperRight', 1, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Max Z</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.upperRight?.[2] ?? 5}
                                    onChange={(e) => this.updateSourceBoxBound(host, index, 'upperRight', 2, parseFloat(e.target.value))}
                                />
                            </div>
                        </div>
                    </>
                )}

                {source.spatial.type === 'sphere' && (
                    <>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Center X</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.center?.[0] || 0}
                                    onChange={(e) => this.updateSourceSphereCenter(host, index, 0, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Center Y</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.center?.[1] || 0}
                                    onChange={(e) => this.updateSourceSphereCenter(host, index, 1, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Center Z</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={spatial.center?.[2] || 0}
                                    onChange={(e) => this.updateSourceSphereCenter(host, index, 2, parseFloat(e.target.value))}
                                />
                            </div>
                            <div className="form-group">
                                <label>Radius</label>
                                <input
                                    type="number"
                                    step="0.1"
                                    min={0}
                                    value={spatial.radius || 1}
                                    onChange={(e) => this.updateSourceSphereRadius(host, index, parseFloat(e.target.value))}
                                />
                            </div>
                        </div>
                    </>
                )}

                <div className="form-group">
                    <label>Energy Distribution</label>
                    <select
                        value={source.energy.type}
                        onChange={(e) => this.updateSourceEnergy(host, index, e.target.value as OpenMCSourceEnergy['type'])}
                    >
                        <option value="discrete">Discrete</option>
                        <option value="uniform">Uniform</option>
                        <option value="maxwell">Maxwell</option>
                        <option value="watt">Watt</option>
                    </select>
                </div>

                {source.energy.type === 'discrete' && (
                    <div className="form-row">
                        <div className="form-group">
                            <label>Energy (eV)</label>
                            <input
                                type="number"
                                step="0.1"
                                value={(source.energy as any).energies?.[0] || 1.0}
                                onChange={(e) => this.updateSourceDiscreteEnergy(host, index, parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
                )}

                {source.energy.type === 'uniform' && (
                    <div className="form-row">
                        <div className="form-group">
                            <label>Min Energy (eV)</label>
                            <input
                                type="number"
                                step="0.1"
                                value={(source.energy as any).min || 0}
                                onChange={(e) => this.updateSourceUniformEnergy(host, index, 'min', parseFloat(e.target.value))}
                            />
                        </div>
                        <div className="form-group">
                            <label>Max Energy (eV)</label>
                            <input
                                type="number"
                                step="0.1"
                                value={(source.energy as any).max || 10}
                                onChange={(e) => this.updateSourceUniformEnergy(host, index, 'max', parseFloat(e.target.value))}
                            />
                        </div>
                    </div>
                )}

                <div className="form-row">
                    <div className="form-group">
                        <label>Particle Type</label>
                        <select
                            value={source.particle || 'neutron'}
                            onChange={(e) => this.updateSourceParticle(host, index, e.target.value as 'neutron' | 'photon')}
                        >
                            <option value="neutron">Neutron</option>
                            <option value="photon">Photon</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Strength</label>
                        <input
                            type="number"
                            min={0}
                            value={source.strength || 1}
                            onChange={(e) => this.updateSourceStrength(host, index, parseFloat(e.target.value))}
                        />
                    </div>
                </div>
            </div>
        );
    }

    /**
     * Add a new default point source to the simulation.
     * @param host - Simulation dashboard widget host.
     */
    private addSource(host: SimulationDashboardWidget): void {
        const newSource: OpenMCSource = {
            spatial: { type: 'point', origin: [0, 0, 0] },
            energy: { type: 'discrete', energies: [1e6] },
            strength: 1,
            particle: 'neutron'
        };
        const settings = host.stateManager.getState().settings;
        host.stateManager.updateSettings({
            ...settings,
            sources: [...settings.sources, newSource]
        });
    }

    /**
     * Remove a source by index.
     * @param host - Simulation dashboard widget host.
     * @param index - Index of the source to remove.
     */
    private removeSource(host: SimulationDashboardWidget, index: number): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        newSources.splice(index, 1);
        host.stateManager.updateSettings({
            ...settings,
            sources: newSources
        });
    }

    /**
     * Change the spatial distribution type of a source.
     * @param host - Simulation dashboard widget host.
     * @param index - Source index.
     * @param type - New spatial distribution type.
     */
    private updateSourceSpatial(host: SimulationDashboardWidget, index: number, type: OpenMCSourceSpatial['type']): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        let spatial: OpenMCSourceSpatial;

        switch (type) {
            case 'point':
                spatial = { type: 'point', origin: [0, 0, 0] };
                break;
            case 'box':
                spatial = { type: 'box', lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] };
                break;
            case 'sphere':
                spatial = { type: 'sphere', center: [0, 0, 0], radius: 1 };
                break;
            case 'cylinder':
                spatial = { type: 'cylinder', center: [0, 0, 0], radius: 1, height: 2, axis: 'z' };
                break;
            default:
                spatial = { type: 'point', origin: [0, 0, 0] };
        }

        newSources[index] = { ...newSources[index], spatial };
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceOrigin(host: SimulationDashboardWidget, index: number, coord: number, value: number): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        const origin = [...((newSources[index].spatial as any).origin || [0, 0, 0])];
        origin[coord] = value;
        (newSources[index].spatial as any).origin = origin;
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * Change the energy distribution type of a source.
     * @param host - Simulation dashboard widget host.
     * @param index - Source index.
     * @param type - New energy distribution type.
     */
    private updateSourceEnergy(host: SimulationDashboardWidget, index: number, type: OpenMCSourceEnergy['type']): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        let energy: OpenMCSourceEnergy;

        switch (type) {
            case 'discrete':
                energy = { type: 'discrete', energies: [1e6] };
                break;
            case 'uniform':
                energy = { type: 'uniform', min: 0, max: 10e6 };
                break;
            case 'maxwell':
                energy = { type: 'maxwell', temperature: 300 };
                break;
            case 'watt':
                energy = { type: 'watt', a: 0.965, b: 2.29 };
                break;
            default:
                energy = { type: 'discrete', energies: [1e6] };
        }

        newSources[index] = { ...newSources[index], energy };
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceDiscreteEnergy(host: SimulationDashboardWidget, index: number, value: number): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        (newSources[index].energy as any).energies = [value];
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceUniformEnergy(host: SimulationDashboardWidget, index: number, key: 'min' | 'max', value: number): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        (newSources[index].energy as any)[key] = value;
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceParticle(host: SimulationDashboardWidget, index: number, particle: 'neutron' | 'photon'): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        newSources[index] = { ...newSources[index], particle };
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceStrength(host: SimulationDashboardWidget, index: number, strength: number): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        newSources[index] = { ...newSources[index], strength };
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceBoxBound(
        host: SimulationDashboardWidget,
        index: number,
        bound: 'lowerLeft' | 'upperRight',
        coord: number,
        value: number
    ): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        const bounds = [...((newSources[index].spatial as any)[bound] || [-5, -5, -5])];
        bounds[coord] = value;
        (newSources[index].spatial as any)[bound] = bounds;
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceSphereCenter(host: SimulationDashboardWidget, index: number, coord: number, value: number): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        const center = [...((newSources[index].spatial as any).center || [0, 0, 0])];
        center[coord] = value;
        (newSources[index].spatial as any).center = center;
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * @param host - Simulation dashboard widget host.
     */
    private updateSourceSphereRadius(host: SimulationDashboardWidget, index: number, value: number): void {
        const settings = host.stateManager.getState().settings;
        const newSources = [...settings.sources] as OpenMCIndependentSource[];
        (newSources[index].spatial as any).radius = Math.max(0, value);
        host.stateManager.updateSettings({ ...settings, sources: newSources });
    }

    /**
     * Set point source to the center of the first sphere in geometry
     * @param host - Simulation dashboard widget host.
     */
    private setSourceToSphereCenter(host: SimulationDashboardWidget, index: number): void {
        const state = host.stateManager.getState();
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) =>
            i === index ? ({ ...s, spatial: { ...(s as OpenMCIndependentSource).spatial } } as OpenMCSource) : { ...s }
        );
        const source = newSources[index] as OpenMCIndependentSource;

        // Find first sphere
        const sphere = state.geometry.surfaces.find((s) => s.type === 'sphere');
        if (!sphere) {
            host.messageService.warn('No sphere found. Opening CSG Builder...');
            host.openCSGBuilder();
            return;
        }

        const c = sphere.coefficients as any;
        const x0 = c.x0 !== undefined ? c.x0 : Array.isArray(c) ? c[0] : 0;
        const y0 = c.y0 !== undefined ? c.y0 : Array.isArray(c) ? c[1] : 0;
        const z0 = c.z0 !== undefined ? c.z0 : Array.isArray(c) ? c[2] : 0;

        if (x0 === undefined || y0 === undefined || z0 === undefined) {
            host.messageService.error('Could not read sphere center coordinates');
            return;
        }

        (source.spatial as any).origin = [x0, y0, z0];
        host.stateManager.updateSettings({ ...settings, sources: newSources });
        host.messageService.info(`Source ${index + 1} set to sphere center: (${x0}, ${y0}, ${z0})`);
        host.logToConsole(`Source ${index + 1} positioned at sphere center (${x0}, ${y0}, ${z0})`);
    }

    /**
     * Snap source to geometry bounds - analyzes geometry surfaces to find bounding box
     * @param host - Simulation dashboard widget host.
     */
    private snapSourceToGeometry(host: SimulationDashboardWidget, index: number): void {
        const state = host.stateManager.getState();
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) =>
            i === index ? ({ ...s, spatial: { ...(s as OpenMCIndependentSource).spatial } } as OpenMCSource) : { ...s }
        );
        const source = newSources[index] as OpenMCIndependentSource;

        // Debug: log geometry info
        console.log('[SnapToGeometry] Geometry info:', {
            surfaces: state.geometry.surfaces.length,
            cells: state.geometry.cells.length,
            surfaceTypes: state.geometry.surfaces.map((s) => s.type),
            firstSurface: state.geometry.surfaces[0]
                ? {
                      id: state.geometry.surfaces[0].id,
                      type: state.geometry.surfaces[0].type,
                      coeffs: state.geometry.surfaces[0].coefficients
                  }
                : null
        });

        // Calculate bounds from surfaces
        const bounds = this.calculateGeometryBounds(state);

        if (!bounds) {
            host.messageService.warn('No geometry defined. Open CSG Builder to create geometry?');
            host.logToConsole('No geometry found. Open CSG Builder to create geometry.', 'error');
            // Open CSG builder automatically
            host.openCSGBuilder();
            return;
        }

        // Update source based on its type
        const spatial = source.spatial as any;

        console.log(`[SnapToGeometry] Source type: ${spatial.type}, current bounds:`, {
            lowerLeft: spatial.lowerLeft,
            upperRight: spatial.upperRight,
            origin: spatial.origin,
            center: spatial.center,
            radius: spatial.radius
        });

        if (spatial.type === 'point') {
            // Set point to center of geometry
            spatial.origin = [
                (bounds.min[0] + bounds.max[0]) / 2,
                (bounds.min[1] + bounds.max[1]) / 2,
                (bounds.min[2] + bounds.max[2]) / 2
            ];
            host.messageService.info(
                `Source ${index + 1} set to geometry center: (${spatial.origin.map((v: number) => v.toFixed(2)).join(', ')})`
            );
        } else if (spatial.type === 'box') {
            // Set box to geometry bounds with 10% padding
            const padding = 0.1;
            const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
            spatial.lowerLeft = [bounds.min[0] - size[0] * padding, bounds.min[1] - size[1] * padding, bounds.min[2] - size[2] * padding];
            spatial.upperRight = [bounds.max[0] + size[0] * padding, bounds.max[1] + size[1] * padding, bounds.max[2] + size[2] * padding];
            host.messageService.info(`Source ${index + 1} box set to geometry bounds with padding`);

            // Warn if geometry has complex regions
            if (state.geometry.cells.some((c) => c.regionString && (c.regionString.includes('-') || c.regionString.includes('|')))) {
                host.logToConsole('Note: Geometry has complex regions. Box source may include areas outside cells.', 'warn');
                host.logToConsole(
                    'Tip: If simulation fails with "Too few source sites", try using a Point source at the geometry center instead.',
                    'warn'
                );
            }
        } else if (spatial.type === 'sphere') {
            // Set sphere to enclose geometry
            const center = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
            const radius =
                Math.sqrt(
                    Math.pow(bounds.max[0] - center[0], 2) + Math.pow(bounds.max[1] - center[1], 2) + Math.pow(bounds.max[2] - center[2], 2)
                ) * 1.2; // 20% padding
            spatial.center = center;
            spatial.radius = radius;
            host.messageService.info(`Source ${index + 1} sphere set to enclose geometry (radius: ${radius.toFixed(2)})`);
        }

        host.stateManager.updateSettings({ ...settings, sources: newSources });
        host.logToConsole(`Source ${index + 1} snapped to geometry bounds`);
        host.logToConsole(`  New bounds: lowerLeft=[${spatial.lowerLeft?.join(', ')}], upperRight=[${spatial.upperRight?.join(', ')}]`);

        // Force immediate update
        host.update();
    }

    /**
     * Snap point source to geometry center
     * @param host - Simulation dashboard widget host.
     */
    private snapSourceToGeometryCenter(host: SimulationDashboardWidget, index: number): void {
        const state = host.stateManager.getState();
        const bounds = this.calculateGeometryBounds(state);

        if (!bounds) {
            host.messageService.warn('No geometry defined. Opening CSG Builder...');
            host.openCSGBuilder();
            return;
        }

        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) =>
            i === index ? ({ ...s, spatial: { ...(s as OpenMCIndependentSource).spatial } } as OpenMCSource) : { ...s }
        );
        const source = newSources[index] as OpenMCIndependentSource;

        (source.spatial as any).origin = [
            (bounds.min[0] + bounds.max[0]) / 2,
            (bounds.min[1] + bounds.max[1]) / 2,
            (bounds.min[2] + bounds.max[2]) / 2
        ];

        host.stateManager.updateSettings({ ...settings, sources: newSources });
        host.messageService.info(`Source ${index + 1} set to geometry center`);
        host.logToConsole(`Source ${index + 1} positioned at geometry center (${(source.spatial as any).origin.join(', ')})`);
    }

    /**
     * Snap box source to geometry bounds with custom padding
     * @param host - Simulation dashboard widget host.
     */
    private snapSourceToGeometryBounds(host: SimulationDashboardWidget, index: number, padding: number): void {
        const state = host.stateManager.getState();
        const bounds = this.calculateGeometryBounds(state);

        if (!bounds) {
            host.messageService.warn('No geometry defined. Opening CSG Builder...');
            host.openCSGBuilder();
            return;
        }

        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) =>
            i === index ? ({ ...s, spatial: { ...(s as OpenMCIndependentSource).spatial } } as OpenMCSource) : { ...s }
        );
        const source = newSources[index] as OpenMCIndependentSource;

        const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];

        (source.spatial as any).lowerLeft = [
            bounds.min[0] - size[0] * padding,
            bounds.min[1] - size[1] * padding,
            bounds.min[2] - size[2] * padding
        ];
        (source.spatial as any).upperRight = [
            bounds.max[0] + size[0] * padding,
            bounds.max[1] + size[1] * padding,
            bounds.max[2] + size[2] * padding
        ];

        host.stateManager.updateSettings({ ...settings, sources: newSources });
        const paddingText = padding > 0 ? `with ${(padding * 100).toFixed(0)}% padding` : 'tight fit';
        host.messageService.info(`Source ${index + 1} box set to ${paddingText}`);
        host.logToConsole(`Source ${index + 1} box set to geometry bounds (${paddingText})`);
    }

    /**
     * Snap sphere source to match first geometry sphere
     * @param host - Simulation dashboard widget host.
     */
    private snapSourceToMatchSphere(host: SimulationDashboardWidget, index: number): void {
        const state = host.stateManager.getState();
        const sphere = state.geometry.surfaces.find((s) => s.type === 'sphere');

        if (!sphere) {
            host.messageService.warn('No sphere found. Opening CSG Builder...');
            host.openCSGBuilder();
            return;
        }

        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) =>
            i === index ? ({ ...s, spatial: { ...(s as OpenMCIndependentSource).spatial } } as OpenMCSource) : { ...s }
        );
        const source = newSources[index] as OpenMCIndependentSource;

        const c = sphere.coefficients as any;
        const x0 = c.x0 !== undefined ? c.x0 : Array.isArray(c) ? c[0] : 0;
        const y0 = c.y0 !== undefined ? c.y0 : Array.isArray(c) ? c[1] : 0;
        const z0 = c.z0 !== undefined ? c.z0 : Array.isArray(c) ? c[2] : 0;
        const r = c.r !== undefined ? c.r : Array.isArray(c) ? c[3] : 1;

        (source.spatial as any).center = [x0, y0, z0];
        (source.spatial as any).radius = r;

        host.stateManager.updateSettings({ ...settings, sources: newSources });
        host.messageService.info(`Source ${index + 1} matched to sphere surface`);
        host.logToConsole(`Source ${index + 1} matched to sphere at (${x0}, ${y0}, ${z0}), radius ${r}`);
    }

    /**
     * Snap sphere source to enclose all geometry
     * @param host - Simulation dashboard widget host.
     */
    private snapSourceToEncloseGeometry(host: SimulationDashboardWidget, index: number): void {
        const state = host.stateManager.getState();
        const bounds = this.calculateGeometryBounds(state);

        if (!bounds) {
            host.messageService.warn('No geometry defined. Opening CSG Builder...');
            host.openCSGBuilder();
            return;
        }

        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) =>
            i === index ? ({ ...s, spatial: { ...(s as OpenMCIndependentSource).spatial } } as OpenMCSource) : { ...s }
        );
        const source = newSources[index] as OpenMCIndependentSource;

        const center = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
        const radius =
            Math.sqrt(
                Math.pow(bounds.max[0] - center[0], 2) + Math.pow(bounds.max[1] - center[1], 2) + Math.pow(bounds.max[2] - center[2], 2)
            ) * 1.2; // 20% padding

        (source.spatial as any).center = center;
        (source.spatial as any).radius = radius;

        host.stateManager.updateSettings({ ...settings, sources: newSources });
        host.messageService.info(`Source ${index + 1} sphere encloses all geometry`);
        host.logToConsole(`Source ${index + 1} sphere set to enclose geometry (radius: ${radius.toFixed(2)})`);
    }

    /**
     * Set point source to first cylinder axis
     * @param host - Simulation dashboard widget host.
     */
    private setSourceToCylinderAxis(host: SimulationDashboardWidget, index: number): void {
        const state = host.stateManager.getState();
        const settings = state.settings;
        // Deep clone sources to avoid mutating original state
        const newSources = settings.sources.map((s, i) =>
            i === index ? ({ ...s, spatial: { ...(s as OpenMCIndependentSource).spatial } } as OpenMCSource) : { ...s }
        );
        const source = newSources[index] as OpenMCIndependentSource;

        // Find first cylinder
        const cylinder = state.geometry.surfaces.find((s) => s.type === 'z-cylinder' || s.type === 'y-cylinder' || s.type === 'x-cylinder');

        if (!cylinder) {
            host.messageService.warn('No cylinder found. Opening CSG Builder...');
            host.openCSGBuilder();
            return;
        }

        const c = cylinder.coefficients as any;
        const getValue = (key: string, idx: number) => (c[key] !== undefined ? c[key] : Array.isArray(c) ? c[idx] : 0);

        let x0 = 0,
            y0 = 0,
            z0 = 0;

        if (cylinder.type === 'z-cylinder') {
            x0 = getValue('x0', 0);
            y0 = getValue('y0', 1);
            z0 = 0;
        } else if (cylinder.type === 'y-cylinder') {
            x0 = getValue('x0', 0);
            y0 = 0;
            z0 = getValue('z0', 2);
        } else if (cylinder.type === 'x-cylinder') {
            x0 = 0;
            y0 = getValue('y0', 1);
            z0 = getValue('z0', 2);
        }

        (source.spatial as any).origin = [x0, y0, z0];
        host.stateManager.updateSettings({ ...settings, sources: newSources });
        host.messageService.info(`Source ${index + 1} set to ${cylinder.type} axis: (${x0}, ${y0}, ${z0})`);
        host.logToConsole(`Source ${index + 1} positioned at ${cylinder.type} axis (${x0}, ${y0}, ${z0})`);
    }

    /**
     * Calculate axis-aligned bounding box from geometry surfaces or DAGMC info.
     * Delegates to the shared implementation in `settings/geometry-bounds`.
     * @param state - Current OpenMC simulation state.
     * @returns Bounding box with min/max arrays, or null if no geometry.
     */
    private calculateGeometryBounds(state: OpenMCState): { min: number[]; max: number[] } | null {
        return calculateGeometryBounds(state);
    }
}
