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
import { OpenMCStudioBackendService } from '../../../common/openmc-studio-protocol';
import { computeMgRevert } from '../../../common/mg-conversion';
import { OpenMCState } from '../../../common/openmc-state-schema';

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

const MGXS_TYPES = [
    'total',
    'transport',
    'nu-transport',
    'absorption',
    'capture',
    'fission',
    'nu-fission',
    'kappa-fission',
    'scatter',
    'nu-scatter',
    'scatter matrix',
    'nu-scatter matrix',
    'multiplicity matrix',
    'nu-fission matrix',
    'consistent scatter matrix',
    'consistent nu-scatter matrix',
    'chi',
    'chi-prompt',
    'inverse-velocity',
    'current',
    'diffusion-coefficient',
    'nu-diffusion-coefficient'
];

/** Default XS types for library mode (mirrors the driver default) */
const DEFAULT_LIBRARY_TYPES = ['total', 'absorption', 'fission', 'nu-fission', 'chi', 'scatter matrix'];

/**
 * MGXS library generator window.
 *
 * Wraps `Model.convert_to_multigroup()` (and optionally
 * `Model.convert_to_random_ray()`) to produce a multi-group cross section
 * library from the current model, then writes the library path back into the
 * project settings for multi-group runs. A second 'Library' mode drives
 * `openmc.mgxs.Library` directly for fine-grained control over XS types,
 * spatial domains, nuclide decomposition, Legendre order, and estimator.
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

    // Library (manual) mode state
    private mode: 'convert' | 'library' = 'convert';
    private libraryTypes = new Set<string>(DEFAULT_LIBRARY_TYPES);
    private domainType: 'material' | 'cell' | 'universe' = 'material';
    private domainIds = new Set<number>();
    private byNuclide = false;
    private legendreOrder = 0;
    private estimator: '' | 'analog' | 'tracklength' | 'collision' = '';
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
            // MGXS generation runs continuous-energy Monte Carlo; strip solver-specific
            // settings (random ray, FW-CADIS/variance reduction, source constraints,
            // project tallies) and force CE mode so OpenMC does not reject the input.
            const sanitizedState: OpenMCState = {
                ...state,
                settings: {
                    ...state.settings,
                    energyMode: 'continuous-energy',
                    randomRay: undefined,
                    sourceRejectionFraction: undefined,
                    sources: state.settings.sources.map((source) => ({ ...source, constraints: undefined }))
                },
                varianceReduction: undefined
            };
            const xmlResult = await this.xmlService.generateXML({
                state: sanitizedState,
                outputDirectory: workingDirectory,
                files: {
                    materials: true,
                    settings: true,
                    geometry: true,
                    tallies: false,
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

            if (this.mode === 'library') {
                await this.generateLibraryMode(workingDirectory);
                return;
            }

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
     * Run the fine-grained openmc.mgxs.Library generation (manual mode).
     * @param workingDirectory - Directory with generated XML inputs.
     */
    private async generateLibraryMode(workingDirectory: string): Promise<void> {
        const result = await this.backendService.generateMgxsLibrary({
            workingDirectory,
            groups: this.groups,
            mgxsTypes: [...this.libraryTypes],
            domainType: this.domainType,
            domainIds: this.domainIds.size > 0 ? [...this.domainIds] : undefined,
            byNuclide: this.byNuclide,
            legendreOrder: this.legendreOrder,
            estimator: this.estimator || undefined,
            correction: this.correction,
            particles: this.particles,
            output: 'mgxs.h5'
        });

        if (result.success && result.mgxsPath) {
            this.generatedPath = result.mgxsPath;
            this.stateManager.updateSettings({ mgxsLibrary: result.mgxsPath });
            this.statusMessage = `MGXS library written to ${result.mgxsPath} (${result.mgxsTypes?.length} XS types over ${result.domainIds?.length} domain(s))`;
            this.messageService.info(`MGXS library generated and set as project library: ${result.mgxsPath}`);
        } else {
            this.statusMessage = `MGXS generation failed: ${result.error}`;
            this.messageService.error(result.error || 'MGXS generation failed');
        }
    }

    /**
     * Render the automatic (convert_to_multigroup) form.
     * @returns Convert-mode form React node.
     */
    private renderConvertForm(): React.ReactNode {
        return (
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-library"></i> Multi-Group Cross Section Library
                </h3>
                <div className="form-row">
                    <div className="form-group">
                        <label>Generation Method</label>
                        <select
                            value={this.method}
                            onChange={(e) => {
                                this.method = e.target.value as typeof this.method;
                                this.update();
                            }}
                        >
                            <option value="material_wise">Material Wise (highest fidelity)</option>
                            <option value="stochastic_slab">Stochastic Slab</option>
                            <option value="infinite_medium">Infinite Medium</option>
                        </select>
                        <span className="form-hint">Material Wise runs a continuous-energy solve of the actual geometry</span>
                    </div>
                    <div className="form-group">
                        <label>Energy Group Structure</label>
                        <select
                            value={this.groups}
                            onChange={(e) => {
                                this.groups = e.target.value;
                                this.update();
                            }}
                        >
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
                            onChange={(e) => {
                                this.particles = parseInt(e.target.value) || 2000;
                                this.update();
                            }}
                        />
                    </div>
                    <div className="form-group">
                        <label>Transport Correction</label>
                        <select
                            value={this.correction}
                            onChange={(e) => {
                                this.correction = e.target.value as 'none' | 'P0';
                                this.update();
                            }}
                        >
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
                            onChange={(e) => {
                                this.temperaturesText = e.target.value;
                                this.update();
                            }}
                        />
                        <span className="form-hint">Space/comma-separated; one MGXS set per temperature point</span>
                    </div>
                </div>
                <div className="form-group checkbox">
                    <label>
                        <input
                            type="checkbox"
                            checked={this.convertToRandomRay}
                            onChange={(e) => {
                                this.convertToRandomRay = e.target.checked;
                                this.update();
                            }}
                        />
                        Also convert model to random ray (sets random_ray defaults in settings.xml)
                    </label>
                </div>
            </div>
        );
    }

    /**
     * Render the fine-grained openmc.mgxs.Library form.
     * @returns Library-mode form React node.
     */
    private renderLibraryForm(): React.ReactNode {
        const state = this.stateManager.getState();
        const domains =
            this.domainType === 'material'
                ? state.materials.map((m) => ({ id: m.id, label: m.name || `Material ${m.id}` }))
                : this.domainType === 'cell'
                  ? state.geometry.cells.map((c) => ({ id: c.id, label: c.name || `Cell ${c.id}` }))
                  : state.geometry.universes.map((u) => ({ id: u.id, label: u.name || `Universe ${u.id}` }));

        return (
            <div className="settings-section">
                <h3>
                    <i className="codicon codicon-symbol-operator"></i> Fine-Grained MGXS Library
                </h3>
                <div className="form-row">
                    <div className="form-group">
                        <label>Energy Group Structure</label>
                        <select
                            value={this.groups}
                            onChange={(e) => {
                                this.groups = e.target.value;
                                this.update();
                            }}
                        >
                            {GROUP_STRUCTURES.map((g) => (
                                <option key={g} value={g}>
                                    {g}
                                </option>
                            ))}
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Particles</label>
                        <input
                            type="number"
                            min={1}
                            value={this.particles}
                            onChange={(e) => {
                                this.particles = parseInt(e.target.value) || 2000;
                                this.update();
                            }}
                        />
                    </div>
                    <div className="form-group">
                        <label>Transport Correction</label>
                        <select
                            value={this.correction}
                            onChange={(e) => {
                                this.correction = e.target.value as 'none' | 'P0';
                                this.update();
                            }}
                        >
                            <option value="none">None (default)</option>
                            <option value="P0">P0</option>
                        </select>
                    </div>
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Domain Type</label>
                        <select
                            value={this.domainType}
                            onChange={(e) => {
                                this.domainType = e.target.value as typeof this.domainType;
                                this.domainIds = new Set();
                                this.update();
                            }}
                        >
                            <option value="material">Material</option>
                            <option value="cell">Cell</option>
                            <option value="universe">Universe</option>
                        </select>
                    </div>
                    <div className="form-group">
                        <label>Domains (none checked = all)</label>
                        <div className="checkbox-grid">
                            {domains.map((d) => (
                                <label key={d.id}>
                                    <input
                                        type="checkbox"
                                        checked={this.domainIds.has(d.id)}
                                        onChange={(e) => {
                                            const next = new Set(this.domainIds);
                                            if (e.target.checked) {
                                                next.add(d.id);
                                            } else {
                                                next.delete(d.id);
                                            }
                                            this.domainIds = next;
                                            this.update();
                                        }}
                                    />
                                    {d.label}
                                </label>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label>Legendre Order</label>
                        <input
                            type="number"
                            min={0}
                            value={this.legendreOrder}
                            onChange={(e) => {
                                this.legendreOrder = parseInt(e.target.value) || 0;
                                this.update();
                            }}
                        />
                    </div>
                    <div className="form-group">
                        <label>Estimator</label>
                        <select
                            value={this.estimator}
                            onChange={(e) => {
                                this.estimator = e.target.value as typeof this.estimator;
                                this.update();
                            }}
                        >
                            <option value="">Default (per XS type)</option>
                            <option value="analog">Analog</option>
                            <option value="tracklength">Tracklength</option>
                            <option value="collision">Collision</option>
                        </select>
                    </div>
                    <div className="form-group checkbox stacked">
                        <label aria-hidden="true">&nbsp;</label>
                        <label>
                            <input
                                type="checkbox"
                                checked={this.byNuclide}
                                onChange={(e) => {
                                    this.byNuclide = e.target.checked;
                                    this.update();
                                }}
                            />
                            By-nuclide decomposition
                        </label>
                    </div>
                </div>
                <div className="form-group">
                    <label>Cross Section Types ({this.libraryTypes.size} selected)</label>
                    <div className="xs-types-grid">
                        {MGXS_TYPES.map((t) => (
                            <label key={t}>
                                <input
                                    type="checkbox"
                                    checked={this.libraryTypes.has(t)}
                                    onChange={(e) => {
                                        const next = new Set(this.libraryTypes);
                                        if (e.target.checked) {
                                            next.add(t);
                                        } else {
                                            next.delete(t);
                                        }
                                        this.libraryTypes = next;
                                        this.update();
                                    }}
                                />
                                {t}
                            </label>
                        ))}
                    </div>
                    <span className="form-hint">
                        Scatter/multiplicity matrix types are added automatically when missing (required for XSdata output)
                    </span>
                </div>
            </div>
        );
    }

    /**
     * One-click fix for MGXS generation compatibility: switch to continuous-energy
     * mode and restore pre-conversion materials from the MG backup when available.
     */
    private autoFixCompatibility(): void {
        const state = this.stateManager.getState();
        const macroscopicNames = state.materials.filter((m) => m.macroscopic).map((m) => m.name);
        const needsEnergySwitch = state.settings.energyMode === 'multigroup';
        const needsMaterialRestore = macroscopicNames.length > 0;

        if (needsEnergySwitch) {
            this.stateManager.updateSettings({ energyMode: 'continuous-energy' });
        }

        if (needsMaterialRestore) {
            const updates = computeMgRevert(state);
            if (updates) {
                for (const material of updates.materials) {
                    this.stateManager.updateMaterial(material.id, material);
                }
                // The energy mode was already switched to continuous-energy above if needed;
                // keep it as CE because MGXS generation requires continuous-energy mode.
                this.stateManager.updateMetadata({ mgBackup: undefined });
            } else {
                this.messageService.warn(
                    'Cannot automatically restore nuclide-decomposed materials: no pre-conversion backup exists. Recreate the materials manually or load a CE project copy.'
                );
                return;
            }
        }

        this.messageService.info('Model is now compatible with MGXS generation.');
    }

    /**
     * Render the MGXS generator window.
     * @returns The React element tree for the widget.
     */
    protected render(): React.ReactNode {
        // MGXS generation is a continuous-energy, per-nuclide workflow —
        // flag incompatible projects up front (the driver also guards this)
        const state = this.stateManager.getState();
        const isMultiGroup = state.settings.energyMode === 'multigroup';
        const macroscopicNames = state.materials.filter((m) => m.macroscopic).map((m) => m.name);
        const issues: string[] = [];
        if (isMultiGroup) {
            issues.push('Project is in multi-group energy mode.');
        }
        if (macroscopicNames.length > 0) {
            issues.push(`Materials are macroscopic: ${macroscopicNames.join(', ')}.`);
        }
        const isIncompatible = issues.length > 0;
        const canRestoreMaterials = macroscopicNames.length === 0 || state.metadata.mgBackup !== undefined;
        const needsOnlyEnergySwitch = isMultiGroup && macroscopicNames.length === 0;

        return (
            <div className="mgxs-generator-widget openmc-widget">
                <div className="openmc-header">
                    <div className="header-info">
                        <h2>
                            <i className="codicon codicon-library"></i>
                            MGXS Generator
                        </h2>
                        <p className="header-description">Multi-group cross section library from continuous-energy solves</p>
                    </div>
                    <div className="header-actions">
                        <Tooltip
                            content={
                                isIncompatible ? issues.join(' ') : this.isRunning ? 'Generation in progress' : 'Generate the MGXS library'
                            }
                            position="bottom"
                        >
                            <button
                                className="theia-button primary large"
                                onClick={() => this.generate()}
                                disabled={this.isRunning || isIncompatible}
                            >
                                <i className="codicon codicon-play"></i>
                                {this.isRunning ? 'Generating...' : 'Generate MGXS Library'}
                            </button>
                        </Tooltip>
                    </div>
                </div>

                <div className="mgxs-body">
                    {isIncompatible && (
                        <div className="openmc-warning-box">
                            <i className="codicon codicon-warning"></i>
                            <div className="warning-content">
                                <strong>MGXS generation requires a continuous-energy model with nuclide-decomposed materials</strong>
                                <ul>
                                    {issues.map((issue, index) => (
                                        <li key={index}>{issue}</li>
                                    ))}
                                </ul>
                                <button
                                    className="theia-button primary"
                                    onClick={() => this.autoFixCompatibility()}
                                    disabled={!canRestoreMaterials}
                                >
                                    <i className="codicon codicon-arrow-swap"></i>
                                    {needsOnlyEnergySwitch
                                        ? 'Switch to Continuous Energy'
                                        : 'Switch to Continuous Energy & Restore Materials'}
                                </button>
                                {!canRestoreMaterials && (
                                    <span className="form-hint">
                                        Cannot automatically restore nuclide-decomposed materials: no pre-conversion backup exists.
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                    <div className="mgxs-mode-row">
                        <div className="segmented-control">
                            {(['convert', 'library'] as const).map((m) => (
                                <button
                                    key={m}
                                    className={`segment${this.mode === m ? ' active' : ''}`}
                                    onClick={() => {
                                        this.mode = m;
                                        this.update();
                                    }}
                                >
                                    {m === 'convert' ? 'Convert (automatic)' : 'Library (manual)'}
                                </button>
                            ))}
                        </div>
                    </div>

                    {this.mode === 'library' ? this.renderLibraryForm() : this.renderConvertForm()}

                    {this.statusMessage && (
                        <div className="mgxs-generate-actions">
                            <span className="mgxs-status">{this.statusMessage}</span>
                        </div>
                    )}

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
            </div>
        );
    }
}
