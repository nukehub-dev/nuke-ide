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
 * OpenFOAM case scaffolding panel widget.
 *
 * Builds a solver-ready OpenFOAM case from the active CAD model, including
 * boundary condition field files and optional per-solid STL patch geometry.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';

import {
    NukeCadBackendService,
    FoamBoundaryCondition,
    FoamCaseRequest,
    FoamCaseResult,
    FoamStlExportRequest,
    FoamStlExportResult
} from '../../../common/nuke-cad-protocol';
import { NukeCadStateManager } from '../../state/nuke-cad-state-manager';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components/tooltip';
import './foam-panel.css';

interface FoamPanelState {
    solver: string;
    caseDir: string;
    writeTemperature: boolean;
    boundaries: FoamBoundaryCondition[];
    isScaffolding: boolean;
    isExporting: boolean;
    logOutput: string;
    lastCaseResult?: FoamCaseResult;
    lastStlResult?: FoamStlExportResult;
    solvers: string[];
}

@injectable()
export class FoamPanelWidget extends ReactWidget {
    static readonly ID = 'nuke-cad-foam-panel-widget';
    static readonly LABEL = 'OpenFOAM Case';

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(NukeCadStateManager)
    protected readonly stateManager: NukeCadStateManager;

    @inject(NukeCadBackendService)
    protected readonly backendService: NukeCadBackendService;

    private state: FoamPanelState = {
        solver: 'icoFoam',
        caseDir: '',
        writeTemperature: false,
        boundaries: [],
        isScaffolding: false,
        isExporting: false,
        logOutput: '',
        solvers: []
    };

    @postConstruct()
    protected init(): void {
        this.id = FoamPanelWidget.ID;
        this.title.label = FoamPanelWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-server-process';

        this.loadSolvers();
        this.toDispose.push(
            this.stateManager.onModelChange(() => {
                this.resetForModel();
                this.update();
            })
        );
        this.update();
    }

    private async loadSolvers(): Promise<void> {
        try {
            const solvers = await this.backendService.listFoamSolvers();
            this.state.solvers = solvers.length > 0 ? solvers : ['icoFoam', 'simpleFoam'];
            if (!this.state.solvers.includes(this.state.solver)) {
                this.state.solver = this.state.solvers[0];
            }
        } catch {
            this.state.solvers = ['icoFoam', 'simpleFoam'];
        }
        this.update();
    }

    private resetForModel(): void {
        const surfaces = this.stateManager.model?.manifest?.surfaces.map((s) => s.name ?? s.selector) ?? [];
        const boundaries: FoamBoundaryCondition[] = surfaces.map((name) => ({
            name,
            type: 'wall',
            value: undefined
        }));
        const scriptPath = this.stateManager.scriptPath;
        const defaultCaseDir = scriptPath ? `${scriptPath.replace(/\.py$/i, '')}_foam_case` : '';
        this.state = {
            ...this.state,
            caseDir: this.state.caseDir || defaultCaseDir,
            boundaries: boundaries.length > 0 ? boundaries : this.state.boundaries,
            lastCaseResult: undefined,
            lastStlResult: undefined,
            logOutput: ''
        };
    }

    private get stepPath(): string | undefined {
        return this.stateManager.model?.result.stepPath;
    }

    private async scaffoldCase(): Promise<void> {
        if (!this.state.caseDir) {
            this.messageService.warn('Enter a case directory first.');
            return;
        }

        const writeFields = ['U', 'p'];
        if (this.state.writeTemperature) {
            writeFields.push('T');
        }

        const request: FoamCaseRequest = {
            caseDir: this.state.caseDir,
            solver: this.state.solver,
            boundaries: this.state.boundaries,
            writeFields,
            settings: {
                endTime: this.state.solver === 'simpleFoam' ? 1000 : 100,
                deltaT: this.state.solver === 'simpleFoam' ? 1 : 0.005,
                writeInterval: this.state.solver === 'simpleFoam' ? 100 : 20
            }
        };

        this.state.isScaffolding = true;
        this.state.logOutput = 'Scaffolding OpenFOAM case...\n';
        this.update();

        try {
            const result = await this.backendService.buildFoamCase(request);
            this.state.lastCaseResult = result;
            if (result.success) {
                this.state.logOutput += `Created ${result.files.length} file(s) in ${result.caseDir}\n${result.files.join('\n')}`;
                this.messageService.info(`OpenFOAM case scaffolded: ${result.caseDir}`);
            } else {
                this.state.logOutput += `Error: ${result.error ?? 'unknown'}`;
                this.messageService.error(result.error || 'OpenFOAM scaffolding failed.');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.logOutput += `Error: ${message}`;
            this.messageService.error(`OpenFOAM scaffolding error: ${message}`);
        } finally {
            this.state.isScaffolding = false;
            this.update();
        }
    }

    private async exportStl(): Promise<void> {
        const stepPath = this.stepPath;
        if (!stepPath) {
            this.messageService.warn('No STEP model is available. Build or import a CAD model first.');
            return;
        }

        const outputDir = this.state.caseDir ? `${this.state.caseDir}/constant/triSurface` : `${stepPath.replace(/\.step$/i, '')}_stl`;

        const request: FoamStlExportRequest = {
            stepPath,
            outputDir
        };

        this.state.isExporting = true;
        this.state.logOutput = 'Exporting per-solid STL files...\n';
        this.update();

        try {
            const result = await this.backendService.exportFoamStl(request);
            this.state.lastStlResult = result;
            if (result.success) {
                this.state.logOutput += `Exported ${result.stlFiles.length} STL file(s) to ${result.outputDir}\n${result.stlFiles.join('\n')}`;
                this.messageService.info(`STL export complete: ${result.stlFiles.length} file(s)`);
            } else {
                this.state.logOutput += `Error: ${result.error ?? 'unknown'}`;
                this.messageService.error(result.error || 'STL export failed.');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.logOutput += `Error: ${message}`;
            this.messageService.error(`STL export error: ${message}`);
        } finally {
            this.state.isExporting = false;
            this.update();
        }
    }

    private updateBoundary(index: number, patch: Partial<FoamBoundaryCondition>): void {
        const boundaries = [...this.state.boundaries];
        boundaries[index] = { ...boundaries[index], ...patch };
        this.state.boundaries = boundaries;
        this.update();
    }

    private addBoundary(): void {
        this.state.boundaries = [...this.state.boundaries, { name: 'patch', type: 'wall' }];
        this.update();
    }

    private removeBoundary(index: number): void {
        const boundaries = [...this.state.boundaries];
        boundaries.splice(index, 1);
        this.state.boundaries = boundaries;
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <div className="foam-panel">
                <div className="foam-panel-header">
                    <span className="codicon codicon-server-process" />
                    <span>OpenFOAM Case Setup</span>
                </div>

                <div className="foam-section">
                    <div className="foam-row">
                        <label>Solver</label>
                        <select
                            value={this.state.solver}
                            onChange={(e) => {
                                this.state.solver = e.target.value;
                                this.update();
                            }}
                            disabled={this.state.isScaffolding || this.state.isExporting}
                        >
                            {this.state.solvers.map((solver) => (
                                <option key={solver} value={solver}>
                                    {solver}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="foam-row">
                        <label>Case Directory</label>
                        <input
                            type="text"
                            value={this.state.caseDir}
                            onChange={(e) => {
                                this.state.caseDir = e.target.value;
                                this.update();
                            }}
                            placeholder="/path/to/model_foam_case"
                            disabled={this.state.isScaffolding || this.state.isExporting}
                        />
                    </div>

                    <div className="foam-row foam-checkbox">
                        <input
                            id="foam-write-temperature"
                            type="checkbox"
                            checked={this.state.writeTemperature}
                            onChange={(e) => {
                                this.state.writeTemperature = e.target.checked;
                                this.update();
                            }}
                            disabled={this.state.isScaffolding || this.state.isExporting}
                        />
                        <label htmlFor="foam-write-temperature">Write temperature field (T)</label>
                    </div>
                </div>

                <div className="foam-section">
                    <div className="foam-section-title">Boundary Conditions</div>
                    {this.state.boundaries.length === 0 && (
                        <div className="foam-hint">No boundary patches defined. Add one or load a model with named surfaces.</div>
                    )}
                    {this.state.boundaries.map((boundary, index) => (
                        <div key={`${boundary.name}-${index}`} className="foam-boundary">
                            <input
                                type="text"
                                value={boundary.name}
                                onChange={(e) => this.updateBoundary(index, { name: e.target.value })}
                                placeholder="patch name"
                                disabled={this.state.isScaffolding || this.state.isExporting}
                            />
                            <select
                                value={boundary.type}
                                onChange={(e) => this.updateBoundary(index, { type: e.target.value })}
                                disabled={this.state.isScaffolding || this.state.isExporting}
                            >
                                <option value="wall">wall</option>
                                <option value="inlet">inlet</option>
                                <option value="outlet">outlet</option>
                                <option value="symmetry">symmetry</option>
                                <option value="patch">patch</option>
                            </select>
                            <input
                                type="text"
                                value={boundary.value ?? ''}
                                onChange={(e) => this.updateBoundary(index, { value: e.target.value || undefined })}
                                placeholder="value"
                                disabled={this.state.isScaffolding || this.state.isExporting}
                            />
                            <Tooltip content="Remove boundary">
                                <button
                                    className="theia-button secondary"
                                    onClick={() => this.removeBoundary(index)}
                                    disabled={this.state.isScaffolding || this.state.isExporting}
                                >
                                    <span className="codicon codicon-trash" />
                                </button>
                            </Tooltip>
                        </div>
                    ))}
                    <button
                        className="theia-button secondary"
                        onClick={() => this.addBoundary()}
                        disabled={this.state.isScaffolding || this.state.isExporting}
                    >
                        <span className="codicon codicon-add" /> Add Boundary
                    </button>
                </div>

                <div className="foam-actions">
                    <button
                        className="theia-button primary"
                        onClick={() => this.scaffoldCase()}
                        disabled={this.state.isScaffolding || this.state.isExporting}
                    >
                        {this.state.isScaffolding ? 'Scaffolding...' : 'Scaffold Case'}
                    </button>
                    <button
                        className="theia-button secondary"
                        onClick={() => this.exportStl()}
                        disabled={this.state.isScaffolding || this.state.isExporting || !this.stepPath}
                    >
                        {this.state.isExporting ? 'Exporting...' : 'Export STL'}
                    </button>
                </div>

                {this.state.logOutput && (
                    <div className="foam-log">
                        <div className="foam-log-header">Log</div>
                        <pre>{this.state.logOutput}</pre>
                    </div>
                )}
            </div>
        );
    }
}
