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

import { OpenMCStateManager } from '../../openmc-state-manager';
import { OpenMCXMLGenerationService } from '../../xml-generator/xml-generation-service';
import { OpenMCStudioBackendService } from '../../../common/openmc-studio-protocol';

/** Predefined energy group structures accepted by openmc.mgxs.EnergyGroups */
const GROUP_STRUCTURES = [
    'CASMO-2',
    'CASMO-4',
    'CASMO-8',
    'CASMO-16',
    'CASMO-25',
    'ECCO-33',
    'CASMO-40',
    'VITAMIN-J-42',
    'SCALE-44',
    'MPACT-51',
    'MPACT-60',
    'MPACT-69',
    'CASMO-70',
    'XMAS-172',
    'VITAMIN-J-175',
    'SCALE-252',
    'TRIPOLI-315',
    'SHEM-361',
    'LLNL-616',
    'CCFE-709'
];

/**
 * MGXS library generator window.
 *
 * Wraps `Model.convert_to_multigroup()` (and optionally
 * `Model.convert_to_random_ray()`) to produce a multi-group cross section
 * library from the current model, then writes the library path back into the
 * project settings for multi-group runs.
 */
@injectable()
export class MgxsGeneratorWidget extends ReactWidget {
    /** Unique widget identifier. */
    static readonly ID = 'openmc-mgxs-generator-widget';
    /** Display label for the widget title. */
    static readonly LABEL = 'MGXS Generator';

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

    private method: 'material_wise' | 'stochastic_slab' | 'infinite_medium' = 'material_wise';
    private groups = 'CASMO-2';
    private particles = 2000;
    private correction: 'none' | 'P0' = 'none';
    private temperaturesText = '';
    private convertToRandomRay = false;
    private isRunning = false;
    private statusMessage = '';
    private generatedPath?: string;

    /** Initialize widget id, title, and state listeners. */
    @postConstruct()
    protected init(): void {
        this.id = MgxsGeneratorWidget.ID;
        this.title.label = MgxsGeneratorWidget.LABEL;
        this.title.caption = MgxsGeneratorWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-library';

        this.stateManager.onStateChange(() => this.update());
        this.stateManager.onStateReload(() => this.update());

        // ReactWidget only renders on update(); schedule the initial paint explicitly.
        this.update();
    }

    /**
     * Generate XML and run the MGXS conversion, then store the library path.
     */
    private async generate(): Promise<void> {
        const props: OpenFileDialogProps = {
            title: 'Select Working Directory for MGXS Generation',
            canSelectFiles: false,
            canSelectFolders: true
        };
        const uri = await this.fileDialogService.showOpenDialog(props);
        if (!uri) {
            return;
        }
        const workingDirectory = uri.path.toString();

        this.isRunning = true;
        this.generatedPath = undefined;
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

            this.statusMessage = 'Running continuous-energy MGXS generation (this may take a while)...';
            this.update();

            const temperatures = this.temperaturesText
                .split(/[\s,]+/)
                .filter((t) => t.length > 0)
                .map(Number)
                .filter((n) => !isNaN(n));

            const result = await this.backendService.generateMgxs({
                workingDirectory,
                method: this.method,
                groups: this.groups,
                particles: this.particles,
                correction: this.correction,
                temperatures: temperatures.length > 0 ? temperatures : undefined,
                output: 'mgxs.h5',
                randomRay: this.convertToRandomRay
            });

            if (result.success && result.mgxsPath) {
                this.generatedPath = result.mgxsPath;
                this.stateManager.updateSettings({ mgxsLibrary: result.mgxsPath });
                this.statusMessage = `MGXS library written to ${result.mgxsPath}`;
                this.messageService.info(`MGXS library generated and set as project library: ${result.mgxsPath}`);
            } else {
                this.statusMessage = `MGXS generation failed: ${result.error}`;
                this.messageService.error(result.error || 'MGXS generation failed');
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
     * Render the MGXS generator window.
     * @returns The React element tree for the widget.
     */
    protected render(): React.ReactNode {
        return (
            <div className="mgxs-generator-widget openmc-widget">
                <div className="settings-section">
                    <h3>
                        <i className="codicon codicon-library"></i> Multi-Group Cross Section Library
                    </h3>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Generation Method</label>
                            <select value={this.method} onChange={(e) => (this.method = e.target.value as typeof this.method)}>
                                <option value="material_wise">Material Wise (highest fidelity)</option>
                                <option value="stochastic_slab">Stochastic Slab</option>
                                <option value="infinite_medium">Infinite Medium</option>
                            </select>
                            <span className="form-hint">Material Wise runs a continuous-energy solve of the actual geometry</span>
                        </div>
                        <div className="form-group">
                            <label>Energy Group Structure</label>
                            <select value={this.groups} onChange={(e) => (this.groups = e.target.value)}>
                                {GROUP_STRUCTURES.map((g) => (
                                    <option key={g} value={g}>
                                        {g}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="form-row">
                        <div className="form-group">
                            <label>Particles</label>
                            <input
                                type="number"
                                min={1}
                                value={this.particles}
                                onChange={(e) => (this.particles = parseInt(e.target.value) || 2000)}
                            />
                        </div>
                        <div className="form-group">
                            <label>Transport Correction</label>
                            <select value={this.correction} onChange={(e) => (this.correction = e.target.value as 'none' | 'P0')}>
                                <option value="none">None (default)</option>
                                <option value="P0">P0</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label>Temperatures (K, optional)</label>
                            <input
                                type="text"
                                value={this.temperaturesText}
                                placeholder="e.g. 300 600 900"
                                onChange={(e) => (this.temperaturesText = e.target.value)}
                            />
                            <span className="form-hint">Space/comma-separated; one MGXS set per temperature point</span>
                        </div>
                    </div>
                    <div className="form-group checkbox">
                        <label>
                            <input
                                type="checkbox"
                                checked={this.convertToRandomRay}
                                onChange={(e) => (this.convertToRandomRay = e.target.checked)}
                            />
                            Also convert model to random ray (sets random_ray defaults in settings.xml)
                        </label>
                    </div>
                </div>

                <div className="mgxs-generate-actions">
                    <button className="theia-button primary large" onClick={() => this.generate()} disabled={this.isRunning}>
                        <i className="codicon codicon-play"></i>
                        {this.isRunning ? 'Generating...' : 'Generate MGXS Library'}
                    </button>
                    {this.statusMessage && <span className="mgxs-status">{this.statusMessage}</span>}
                </div>

                {this.generatedPath && (
                    <div className="settings-section">
                        <h3>
                            <i className="codicon codicon-check"></i> Result
                        </h3>
                        <p>
                            Library path saved to project settings: <code>{this.generatedPath}</code>
                        </p>
                        <p className="form-hint">Switch to multi-group energy mode in the Random Ray tab to use this library.</p>
                    </div>
                )}
            </div>
        );
    }
}
