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
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

import { OpenMCStateManager } from '../../openmc-state-manager';
import { OpenMCXMLGenerationService } from '../../xml-generator/xml-generation-service';
import { OpenMCStudioBackendService, VolumeDomainResult } from '../../../common/openmc-studio-protocol';
import { calculateGeometryBounds } from '../simulation-dashboard/tabs/settings/geometry-bounds';

/**
 * Stochastic volume calculation window.
 *
 * Runs `openmc.VolumeCalculation` against the current model: select domains
 * (cells, materials, or universes), sample count, bounding box, and an
 * optional convergence trigger, then view per-domain volumes with
 * uncertainties and adopt material volumes back into the state.
 */
@injectable()
export class VolumeCalcWidget extends ReactWidget {
    /** Unique widget identifier. */
    static readonly ID = 'openmc-volume-calc-widget';
    /** Display label for the widget title. */
    static readonly LABEL = 'Volume Calculation';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager: OpenMCStateManager;

    @inject(OpenMCStudioBackendService)
    protected readonly backendService: OpenMCStudioBackendService;

    @inject(OpenMCXMLGenerationService)
    protected readonly xmlService: OpenMCXMLGenerationService;

    @inject(FileDialogService)
    protected readonly fileDialogService: FileDialogService;

    private domainType: 'cell' | 'material' | 'universe' = 'cell';
    private selectedIds = new Set<number>();
    private samples = 1000000;
    private useAutoBounds = true;
    private lowerLeft: [number, number, number] = [-10, -10, -10];
    private upperRight: [number, number, number] = [10, 10, 10];
    private triggerType: 'none' | 'std_dev' | 'variance' | 'rel_err' = 'none';
    private triggerThreshold = 0.01;
    private isRunning = false;
    private results?: VolumeDomainResult[];
    private statusMessage = '';

    /** Initialize widget id, title, and state listeners. */
    @postConstruct()
    protected init(): void {
        this.id = VolumeCalcWidget.ID;
        this.title.label = VolumeCalcWidget.LABEL;
        this.title.caption = VolumeCalcWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-symbol-ruler';

        this.stateManager.onStateChange(() => this.update());
        this.stateManager.onStateReload(() => this.update());

        // ReactWidget only renders on update(); schedule the initial paint explicitly.
        this.update();
    }

    /**
     * Toggle a domain ID in the selection.
     * @param id - Domain ID to toggle.
     */
    private toggleDomain(id: number): void {
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
        } else {
            this.selectedIds.add(id);
        }
        this.update();
    }

    /**
     * Auto-detect the bounding box from the current geometry.
     */
    private autoDetectBounds(): void {
        const bounds = calculateGeometryBounds(this.stateManager.getState());
        if (bounds) {
            this.lowerLeft = bounds.min as [number, number, number];
            this.upperRight = bounds.max as [number, number, number];
            this.update();
        } else {
            this.messageService.warn('Cannot auto-detect bounds: no geometry defined');
        }
    }

    /**
     * Generate XML into a working directory and run the volume calculation.
     */
    private async runCalculation(): Promise<void> {
        if (this.selectedIds.size === 0) {
            this.messageService.warn('Select at least one domain');
            return;
        }

        const props: OpenFileDialogProps = {
            title: 'Select Working Directory for Volume Calculation',
            canSelectFiles: false,
            canSelectFolders: true
        };
        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }
        const workingDirectory = uri.path.toString();

        this.isRunning = true;
        this.results = undefined;
        this.statusMessage = 'Generating XML files...';
        this.update();

        try {
            const state = this.stateManager.getState();
            const xmlResult = await this.xmlService.generateXML({
                state,
                outputDirectory: workingDirectory,
                files: {
                    materials: true,
                    settings: true,
                    geometry: true,
                    tallies: state.tallies.length > 0,
                    plots: false
                }
            });
            if (!xmlResult.success) {
                this.messageService.error(`Failed to generate XML: ${xmlResult.error}`);
                this.statusMessage = `XML generation failed: ${xmlResult.error}`;
                this.isRunning = false;
                this.update();
                return;
            }

            this.statusMessage = 'Running stochastic volume calculation...';
            this.update();

            const result = await this.backendService.runVolumeCalculation({
                workingDirectory,
                domainType: this.domainType,
                domainIds: Array.from(this.selectedIds).sort((a, b) => a - b),
                samples: this.samples,
                lowerLeft: this.useAutoBounds ? undefined : this.lowerLeft,
                upperRight: this.useAutoBounds ? undefined : this.upperRight,
                triggerType: this.triggerType === 'none' ? undefined : this.triggerType,
                triggerThreshold: this.triggerType === 'none' ? undefined : this.triggerThreshold
            });

            if (result.success && result.results) {
                this.results = result.results;
                this.statusMessage = `Volume calculation complete (${result.results.length} domain(s))`;
                this.messageService.info('Volume calculation complete');
            } else {
                this.statusMessage = `Volume calculation failed: ${result.error}`;
                this.messageService.error(result.error || 'Volume calculation failed');
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.statusMessage = `Error: ${msg}`;
            this.messageService.error(msg);
        } finally {
            this.isRunning = false;
            this.update();
        }
    }

    /**
     * Adopt the calculated volumes into the materials of the current state.
     * Only available for material-domain calculations.
     */
    private adoptVolumes(): void {
        if (!this.results || this.domainType !== 'material') {
            return;
        }
        const state = this.stateManager.getState();
        let adopted = 0;
        for (const result of this.results) {
            const material = state.materials.find((m) => m.id === result.id);
            if (material) {
                this.stateManager.updateMaterial(result.id, { volume: result.volume });
                adopted++;
            }
        }
        this.messageService.info(`Adopted calculated volumes into ${adopted} material(s)`);
    }

    /**
     * Render a vector input row (3 number fields).
     * @param label - Row label.
     * @param vector - Current vector value.
     * @param onChange - Change handler.
     * @param disabled - Whether inputs are disabled.
     * @returns Vector input row React node.
     */
    private renderVectorInput(
        label: string,
        vector: [number, number, number],
        onChange: (v: [number, number, number]) => void,
        disabled: boolean
    ): React.ReactNode {
        return (
            <div className="form-row">
                {([0, 1, 2] as const).map((i) => (
                    <div className="form-group" key={i}>
                        <label>
                            {label} {'XYZ'[i]}
                        </label>
                        <input
                            type="number"
                            step="any"
                            value={vector[i]}
                            disabled={disabled}
                            onChange={(e) => {
                                const next = [...vector] as [number, number, number];
                                next[i] = parseFloat(e.target.value) || 0;
                                onChange(next);
                            }}
                        />
                    </div>
                ))}
            </div>
        );
    }

    /**
     * Render the volume calculation window.
     * @returns The React element tree for the widget.
     */
    protected render(): React.ReactNode {
        const state = this.stateManager.getState();
        const domains =
            this.domainType === 'cell'
                ? state.geometry.cells.map((c) => ({ id: c.id, label: c.name || `Cell ${c.id}` }))
                : this.domainType === 'material'
                  ? state.materials.map((m) => ({ id: m.id, label: m.name || `Material ${m.id}` }))
                  : state.geometry.universes.map((u) => ({ id: u.id, label: u.name || `Universe ${u.id}` }));

        return (
            <div className="volume-calc-widget openmc-widget">
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-symbol-ruler"></i> Domains
                    </h3>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Domain Type</label>
                            <select
                                value={this.domainType}
                                onChange={(e) => {
                                    this.domainType = e.target.value as 'cell' | 'material' | 'universe';
                                    this.selectedIds.clear();
                                    this.update();
                                }}
                            >
                                <option value="cell">Cells</option>
                                <option value="material">Materials</option>
                                <option value="universe">Universes</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label>Samples</label>
                            <input
                                type="number"
                                min={1}
                                value={this.samples}
                                onChange={(e) => (this.samples = parseInt(e.target.value) || 1000000)}
                            />
                        </div>
                    </div>
                    {domains.length === 0 ? (
                        <div className="empty-state">
                            <i className="codicon codicon-info"></i>
                            <p>No {this.domainType}s defined in the current model.</p>
                        </div>
                    ) : (
                        <div className="domain-list">
                            {domains.map((d) => (
                                <label key={d.id} className="score-checkbox-label">
                                    <input type="checkbox" checked={this.selectedIds.has(d.id)} onChange={() => this.toggleDomain(d.id)} />
                                    <span>
                                        #{d.id} {d.label}
                                    </span>
                                </label>
                            ))}
                        </div>
                    )}
                </div>

                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-bounds"></i> Bounding Box
                    </h3>
                    <div className="form-row">
                        <div className="form-group checkbox">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={this.useAutoBounds}
                                    onChange={(e) => {
                                        this.useAutoBounds = e.target.checked;
                                        this.update();
                                    }}
                                />
                                Let OpenMC auto-detect bounds
                            </label>
                        </div>
                        <div className="form-group">
                            <Tooltip content="Compute bounds from the current geometry" position="bottom">
                                <button className="theia-button secondary small" onClick={() => this.autoDetectBounds()}>
                                    <i className="codicon codicon-target"></i> Auto-detect from Geometry
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                    {!this.useAutoBounds && (
                        <>
                            {this.renderVectorInput('Lower Left', this.lowerLeft, (v) => (this.lowerLeft = v), this.isRunning)}
                            {this.renderVectorInput('Upper Right', this.upperRight, (v) => (this.upperRight = v), this.isRunning)}
                        </>
                    )}
                </div>

                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-stopwatch"></i> Convergence Trigger
                    </h3>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Trigger Type</label>
                            <select
                                value={this.triggerType}
                                onChange={(e) => (this.triggerType = e.target.value as 'none' | 'std_dev' | 'variance' | 'rel_err')}
                            >
                                <option value="none">None (fixed samples)</option>
                                <option value="std_dev">Standard Deviation</option>
                                <option value="variance">Variance</option>
                                <option value="rel_err">Relative Error</option>
                            </select>
                        </div>
                        {this.triggerType !== 'none' && (
                            <div className="form-group">
                                <label>Threshold</label>
                                <input
                                    type="number"
                                    min={0}
                                    step="any"
                                    value={this.triggerThreshold}
                                    onChange={(e) => (this.triggerThreshold = parseFloat(e.target.value) || 0.01)}
                                />
                            </div>
                        )}
                    </div>
                </div>

                <div className="volume-calc-actions">
                    <button
                        className="theia-button primary large"
                        onClick={() => this.runCalculation()}
                        disabled={this.isRunning || this.selectedIds.size === 0}
                    >
                        <i className="codicon codicon-play"></i>
                        {this.isRunning ? 'Running...' : 'Run Volume Calculation'}
                    </button>
                    {this.statusMessage && <span className="volume-calc-status">{this.statusMessage}</span>}
                </div>

                {this.results && (
                    <div className="settings-section">
                        <h3>
                            <i className="codicon codicon-table"></i> Results
                        </h3>
                        <table className="volume-results-table">
                            <thead>
                                <tr>
                                    <th>Domain</th>
                                    <th>Volume (cm³)</th>
                                    <th>± σ</th>
                                    <th>Atoms Estimate</th>
                                </tr>
                            </thead>
                            <tbody>
                                {this.results.map((r) => {
                                    const totalAtoms = Object.values(r.atoms ?? {}).reduce((sum, a) => sum + a.value, 0);
                                    return (
                                        <tr key={r.id}>
                                            <td>
                                                {this.domainType} #{r.id}
                                            </td>
                                            <td>{r.volume.toExponential(6)}</td>
                                            <td>{r.stdDev.toExponential(3)}</td>
                                            <td>{totalAtoms > 0 ? totalAtoms.toExponential(4) : '—'}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {this.domainType === 'material' && (
                            <button className="theia-button primary" onClick={() => this.adoptVolumes()}>
                                <i className="codicon codicon-check"></i> Adopt Volumes into Materials
                            </button>
                        )}
                        {this.domainType !== 'material' && (
                            <span className="form-hint">Volume adoption is available for material-domain calculations.</span>
                        )}
                    </div>
                )}
            </div>
        );
    }
}
