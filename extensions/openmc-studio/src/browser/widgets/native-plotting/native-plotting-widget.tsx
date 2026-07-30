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
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

import { OpenMCStateManager } from '../../openmc-state-manager';
import { OpenMCXMLGenerationService } from '../../xml-generator/xml-generation-service';
import { OpenMCStudioBackendService, GeneratedPlotFile } from '../../../common/openmc-studio-protocol';
import { OpenMCPlotConfig } from '../../../common/openmc-state-schema';

/**
 * Native OpenMC plotting window.
 *
 * Edits the model's plot configurations (slice, voxel, solid ray-trace,
 * wireframe ray-trace) and renders them with `openmc -p`. Generated PNGs open
 * in Theia's default handler; voxel output is converted to VTK and opened
 * through the nuke-visualizer viewer registry.
 */
@injectable()
export class NativePlottingWidget extends ReactWidget {
    /** Unique widget identifier. */
    static readonly ID = 'openmc-native-plotting-widget';
    /** Display label for the widget title. */
    static readonly LABEL = 'Native Plotting';

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

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    private selectedPlotId?: number;
    private isRunning = false;
    private statusMessage = '';
    private generatedFiles: GeneratedPlotFile[] = [];

    /** Initialize widget id, title, and state listeners. */
    @postConstruct()
    protected init(): void {
        this.id = NativePlottingWidget.ID;
        this.title.label = NativePlottingWidget.LABEL;
        this.title.caption = NativePlottingWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-graph';

        this.stateManager.onStateChange(() => this.update());
        this.stateManager.onStateReload(() => this.update());
    }

    /**
     * Create a default plot configuration of the given type.
     * @param type - Plot type.
     * @param id - Plot ID.
     * @returns The default plot configuration.
     */
    private createDefaultPlot(type: OpenMCPlotConfig['type'], id: number): OpenMCPlotConfig {
        const base: OpenMCPlotConfig = { id, type, basis: 'xy', origin: [0, 0, 0], colorBy: 'material' };
        switch (type) {
            case 'slice':
                return { ...base, width: 10, height: 10, pixels: [800, 800] };
            case 'voxel':
                return { ...base, lowerLeft: [-10, -10, -10], upperRight: [10, 10, 10], voxels: [50, 50, 50] };
            case 'solid-raytrace':
                return {
                    ...base,
                    pixels: [800, 800],
                    cameraPosition: [20, 20, 20],
                    lookAt: [0, 0, 0],
                    up: [0, 0, 1],
                    horizontalFieldOfView: 70
                };
            case 'wireframe-raytrace':
                return {
                    ...base,
                    pixels: [800, 800],
                    cameraPosition: [20, 20, 20],
                    lookAt: [0, 0, 0],
                    up: [0, 0, 1],
                    horizontalFieldOfView: 70,
                    wireframeThickness: 1,
                    wireframeColor: [0, 0, 0]
                };
        }
    }

    /**
     * Add a new plot of the given type.
     * @param type - Plot type to add.
     */
    private addPlot(type: OpenMCPlotConfig['type']): void {
        const plots = this.stateManager.getState().plots ?? [];
        const nextId = plots.length > 0 ? Math.max(...plots.map((p) => p.id)) + 1 : 1;
        this.stateManager.updatePlots([...plots, this.createDefaultPlot(type, nextId)]);
        this.selectedPlotId = nextId;
        this.update();
    }

    /**
     * Remove the plot with the given ID.
     * @param id - Plot ID to remove.
     */
    private removePlot(id: number): void {
        const plots = (this.stateManager.getState().plots ?? []).filter((p) => p.id !== id);
        this.stateManager.updatePlots(plots);
        if (this.selectedPlotId === id) {
            this.selectedPlotId = undefined;
        }
        this.update();
    }

    /**
     * Update the currently selected plot with partial changes.
     * @param updates - Partial plot configuration.
     */
    private updateSelectedPlot(updates: Partial<OpenMCPlotConfig>): void {
        const plots = (this.stateManager.getState().plots ?? []).map((p) =>
            p.id === this.selectedPlotId ? ({ ...p, ...updates } as OpenMCPlotConfig) : p
        );
        this.stateManager.updatePlots(plots);
    }

    /**
     * Generate XML and render all configured plots, then open the outputs.
     */
    private async generatePlots(): Promise<void> {
        const state = this.stateManager.getState();
        const plots = state.plots ?? [];
        if (plots.length === 0) {
            this.messageService.warn('Add at least one plot configuration');
            return;
        }

        const props: OpenFileDialogProps = {
            title: 'Select Working Directory for Plot Generation',
            canSelectFiles: false,
            canSelectFolders: true
        };
        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }
        const workingDirectory = uri.path.toString();

        this.isRunning = true;
        this.generatedFiles = [];
        this.statusMessage = 'Generating XML files...';
        this.update();

        try {
            const xmlResult = await this.xmlService.generateXML({
                state,
                outputDirectory: workingDirectory,
                files: {
                    materials: true,
                    settings: true,
                    geometry: true,
                    tallies: state.tallies.length > 0,
                    plots: true
                }
            });
            if (!xmlResult.success) {
                this.messageService.error(`Failed to generate XML: ${xmlResult.error}`);
                this.statusMessage = `XML generation failed: ${xmlResult.error}`;
                this.isRunning = false;
                this.update();
                return;
            }

            this.statusMessage = 'Rendering plots (openmc -p)...';
            this.update();

            const result = await this.backendService.generatePlots({
                workingDirectory,
                plots,
                convertVoxelToVtk: true
            });

            if (!result.success) {
                this.statusMessage = `Plot generation failed: ${result.error}`;
                this.messageService.error(result.error || 'Plot generation failed');
            } else {
                this.generatedFiles = result.files ?? [];
                this.statusMessage = `Generated ${this.generatedFiles.length} file(s)`;
                this.messageService.info(`Generated ${this.generatedFiles.length} plot file(s)`);

                // Open PNG previews and VTK files through the default handlers
                for (const file of this.generatedFiles) {
                    if (file.kind === 'png' || file.kind === 'vti') {
                        const fileUri = new URI(file.path);
                        await this.openerService.getOpener(fileUri).then((opener) => opener.open(fileUri));
                    }
                }
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
     * Render a 3-vector input row.
     * @param label - Row label.
     * @param vector - Current value.
     * @param onChange - Change handler.
     * @param integer - Whether to parse as integers.
     * @returns Vector input row React node.
     */
    private renderVectorInput(
        label: string,
        vector: [number, number, number],
        onChange: (v: [number, number, number]) => void,
        integer = false
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
                            step={integer ? 1 : 'any'}
                            value={vector[i]}
                            onChange={(e) => {
                                const next = [...vector] as [number, number, number];
                                next[i] = integer ? parseInt(e.target.value) || 0 : parseFloat(e.target.value) || 0;
                                onChange(next);
                            }}
                        />
                    </div>
                ))}
            </div>
        );
    }

    /**
     * Render a 2-vector input row (e.g. pixels).
     * @param label - Row label.
     * @param vector - Current value.
     * @param onChange - Change handler.
     * @returns Vector input row React node.
     */
    private renderPairInput(label: string, vector: [number, number], onChange: (v: [number, number]) => void): React.ReactNode {
        return (
            <div className="form-row">
                {([0, 1] as const).map((i) => (
                    <div className="form-group" key={i}>
                        <label>
                            {label} {i === 0 ? 'X' : 'Y'}
                        </label>
                        <input
                            type="number"
                            min={1}
                            value={vector[i]}
                            onChange={(e) => {
                                const next = [...vector] as [number, number];
                                next[i] = parseInt(e.target.value) || 1;
                                onChange(next);
                            }}
                        />
                    </div>
                ))}
            </div>
        );
    }

    /**
     * Render a space-separated ID list input.
     * @param label - Input label.
     * @param ids - Current IDs.
     * @param onChange - Change handler.
     * @returns ID list input React node.
     */
    private renderIdListInput(label: string, ids: number[], onChange: (ids: number[]) => void): React.ReactNode {
        return (
            <div className="form-group">
                <label>{label}</label>
                <input
                    type="text"
                    value={ids.join(' ')}
                    placeholder="e.g. 1 2 3"
                    onChange={(e) => {
                        const parsed = e.target.value
                            .split(/\s+/)
                            .map((v) => parseInt(v, 10))
                            .filter((v) => !isNaN(v));
                        if (parsed.length !== ids.length || parsed.some((v, i) => v !== ids[i])) {
                            onChange(parsed);
                        }
                    }}
                />
            </div>
        );
    }

    /**
     * Render the camera controls shared by ray-trace plot types.
     * @param plot - Plot being edited.
     * @returns Camera controls React node.
     */
    private renderCameraControls(plot: OpenMCPlotConfig): React.ReactNode {
        return (
            <>
                {this.renderVectorInput('Camera', plot.cameraPosition ?? [1, 0, 0], (v) => this.updateSelectedPlot({ cameraPosition: v }))}
                {this.renderVectorInput('Look At', plot.lookAt ?? [0, 0, 0], (v) => this.updateSelectedPlot({ lookAt: v }))}
                {this.renderVectorInput('Up', plot.up ?? [0, 0, 1], (v) => this.updateSelectedPlot({ up: v }))}
                <div className="form-row">
                    <div className="form-group">
                        <label>Horizontal FOV (degrees)</label>
                        <input
                            type="number"
                            min={1}
                            max={179}
                            step="any"
                            value={plot.horizontalFieldOfView ?? 70}
                            onChange={(e) => this.updateSelectedPlot({ horizontalFieldOfView: parseFloat(e.target.value) || 70 })}
                        />
                    </div>
                    <div className="form-group">
                        <label>Orthographic Width (0 = perspective)</label>
                        <input
                            type="number"
                            min={0}
                            step="any"
                            value={plot.orthographicWidth ?? 0}
                            onChange={(e) =>
                                this.updateSelectedPlot({
                                    orthographicWidth: parseFloat(e.target.value) > 0 ? parseFloat(e.target.value) : undefined
                                })
                            }
                        />
                    </div>
                </div>
                {this.renderPairInput('Pixels', plot.pixels ?? [800, 800], (v) => this.updateSelectedPlot({ pixels: v }))}
            </>
        );
    }

    /**
     * Render the editor form for the selected plot.
     * @param plot - Plot being edited.
     * @returns Plot editor React node.
     */
    private renderPlotEditor(plot: OpenMCPlotConfig): React.ReactNode {
        return (
            <div className="plot-editor">
                <div className="form-row">
                    <div className="form-group">
                        <label>Name</label>
                        <input
                            type="text"
                            value={plot.name ?? ''}
                            placeholder={`Plot ${plot.id}`}
                            onChange={(e) => this.updateSelectedPlot({ name: e.target.value || undefined })}
                        />
                    </div>
                    <div className="form-group">
                        <label>Color By</label>
                        <select
                            value={plot.colorBy}
                            onChange={(e) => this.updateSelectedPlot({ colorBy: e.target.value as OpenMCPlotConfig['colorBy'] })}
                        >
                            <option value="cell">Cell</option>
                            <option value="material">Material</option>
                        </select>
                    </div>
                </div>

                {plot.type === 'slice' && (
                    <>
                        <div className="form-row">
                            <div className="form-group">
                                <label>Basis</label>
                                <select
                                    value={plot.basis}
                                    onChange={(e) => this.updateSelectedPlot({ basis: e.target.value as 'xy' | 'xz' | 'yz' })}
                                >
                                    <option value="xy">XY</option>
                                    <option value="xz">XZ</option>
                                    <option value="yz">YZ</option>
                                </select>
                            </div>
                            <div className="form-group">
                                <label>Width</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={plot.width ?? 10}
                                    onChange={(e) => this.updateSelectedPlot({ width: parseFloat(e.target.value) || 10 })}
                                />
                            </div>
                            <div className="form-group">
                                <label>Height</label>
                                <input
                                    type="number"
                                    step="any"
                                    value={plot.height ?? 10}
                                    onChange={(e) => this.updateSelectedPlot({ height: parseFloat(e.target.value) || 10 })}
                                />
                            </div>
                        </div>
                        {this.renderVectorInput('Origin', plot.origin, (v) => this.updateSelectedPlot({ origin: v }))}
                        {this.renderPairInput('Pixels', plot.pixels ?? [800, 800], (v) => this.updateSelectedPlot({ pixels: v }))}
                        <div className="form-group checkbox">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={plot.meshlines ?? false}
                                    onChange={(e) => this.updateSelectedPlot({ meshlines: e.target.checked })}
                                />
                                Show Mesh Lines
                            </label>
                        </div>
                    </>
                )}

                {plot.type === 'voxel' && (
                    <>
                        {this.renderVectorInput('Lower Left', plot.lowerLeft ?? [-10, -10, -10], (v) =>
                            this.updateSelectedPlot({ lowerLeft: v })
                        )}
                        {this.renderVectorInput('Upper Right', plot.upperRight ?? [10, 10, 10], (v) =>
                            this.updateSelectedPlot({ upperRight: v })
                        )}
                        {this.renderVectorInput('Voxels', plot.voxels ?? [50, 50, 50], (v) => this.updateSelectedPlot({ voxels: v }), true)}
                        <span className="form-hint">Voxel output (.h5) is converted to VTK and opened in the 3D viewer.</span>
                    </>
                )}

                {plot.type === 'solid-raytrace' && (
                    <>
                        {this.renderCameraControls(plot)}
                        {this.renderVectorInput('Light Position', plot.lightPosition ?? plot.cameraPosition ?? [1, 0, 0], (v) =>
                            this.updateSelectedPlot({ lightPosition: v })
                        )}
                        <div className="form-row">
                            <div className="form-group">
                                <label>Diffuse Fraction</label>
                                <input
                                    type="number"
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    value={plot.diffuseFraction ?? 0.1}
                                    onChange={(e) => this.updateSelectedPlot({ diffuseFraction: parseFloat(e.target.value) || 0.1 })}
                                />
                            </div>
                        </div>
                        {this.renderIdListInput('Opaque Domain IDs', plot.opaqueIds ?? [], (ids) =>
                            this.updateSelectedPlot({ opaqueIds: ids })
                        )}
                    </>
                )}

                {plot.type === 'wireframe-raytrace' && (
                    <>
                        {this.renderCameraControls(plot)}
                        <div className="form-row">
                            <div className="form-group">
                                <label>Wireframe Thickness (px)</label>
                                <input
                                    type="number"
                                    min={1}
                                    value={plot.wireframeThickness ?? 1}
                                    onChange={(e) => this.updateSelectedPlot({ wireframeThickness: parseInt(e.target.value) || 1 })}
                                />
                            </div>
                        </div>
                        {this.renderVectorInput(
                            'Wireframe Color (RGB)',
                            plot.wireframeColor ?? [0, 0, 0],
                            (v) => this.updateSelectedPlot({ wireframeColor: v }),
                            true
                        )}
                        {this.renderIdListInput('Wireframe Domain IDs', plot.wireframeIds ?? [], (ids) =>
                            this.updateSelectedPlot({ wireframeIds: ids })
                        )}
                        <span className="form-hint">Domains (cells or materials per Color By) outlined by the wireframe.</span>
                    </>
                )}
            </div>
        );
    }

    /**
     * Render the native plotting window.
     * @returns The React element tree for the widget.
     */
    protected render(): React.ReactNode {
        const plots = this.stateManager.getState().plots ?? [];
        const selectedPlot = plots.find((p) => p.id === this.selectedPlotId);

        return (
            <div className="native-plotting-widget openmc-widget">
                <div className="plot-list-panel">
                    <div className="plot-list-header">
                        <h4>
                            <i className="codicon codicon-graph"></i> Plots
                        </h4>
                        <div className="plot-add-buttons">
                            <Tooltip content="Add slice plot" position="bottom">
                                <button className="theia-button secondary small" onClick={() => this.addPlot('slice')}>
                                    + Slice
                                </button>
                            </Tooltip>
                            <Tooltip content="Add voxel plot" position="bottom">
                                <button className="theia-button secondary small" onClick={() => this.addPlot('voxel')}>
                                    + Voxel
                                </button>
                            </Tooltip>
                            <Tooltip content="Add solid ray-trace plot" position="bottom">
                                <button className="theia-button secondary small" onClick={() => this.addPlot('solid-raytrace')}>
                                    + Solid RT
                                </button>
                            </Tooltip>
                            <Tooltip content="Add wireframe ray-trace plot" position="bottom">
                                <button className="theia-button secondary small" onClick={() => this.addPlot('wireframe-raytrace')}>
                                    + Wireframe RT
                                </button>
                            </Tooltip>
                        </div>
                    </div>
                    {plots.length === 0 ? (
                        <div className="empty-state">
                            <i className="codicon codicon-info"></i>
                            <p>No plots configured. Add a plot to get started.</p>
                        </div>
                    ) : (
                        <div className="plot-list">
                            {plots.map((plot) => (
                                <div
                                    key={plot.id}
                                    className={`plot-list-item ${plot.id === this.selectedPlotId ? 'selected' : ''}`}
                                    onClick={() => {
                                        this.selectedPlotId = plot.id;
                                        this.update();
                                    }}
                                >
                                    <span className="plot-list-item-label">
                                        #{plot.id} {plot.name || plot.type}
                                    </span>
                                    <span className="plot-type-badge">{plot.type}</span>
                                    <button
                                        className="theia-button secondary small"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            this.removePlot(plot.id);
                                        }}
                                    >
                                        <i className="codicon codicon-trash"></i>
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="plot-config-panel">
                    {selectedPlot ? (
                        <div className="settings-section">
                            <h3>
                                <i className="codicon codicon-settings-gear"></i> Plot #{selectedPlot.id} Configuration
                            </h3>
                            {this.renderPlotEditor(selectedPlot)}
                        </div>
                    ) : (
                        <div className="empty-state">
                            <i className="codicon codicon-info"></i>
                            <p>Select a plot to edit its configuration.</p>
                        </div>
                    )}

                    <div className="plot-generate-actions">
                        <button
                            className="theia-button primary large"
                            onClick={() => this.generatePlots()}
                            disabled={this.isRunning || plots.length === 0}
                        >
                            <i className="codicon codicon-play"></i>
                            {this.isRunning ? 'Generating...' : 'Generate Plots'}
                        </button>
                        {this.statusMessage && <span className="plot-status">{this.statusMessage}</span>}
                    </div>

                    {this.generatedFiles.length > 0 && (
                        <div className="settings-section">
                            <h3>
                                <i className="codicon codicon-file"></i> Generated Files
                            </h3>
                            <ul className="generated-files-list">
                                {this.generatedFiles.map((file, index) => (
                                    <li key={index}>
                                        <i className={`codicon codicon-${file.kind === 'png' ? 'file-media' : 'file'}`}></i> {file.path}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </div>
        );
    }
}
