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
 * Shutdown Dose widget (Tools → OpenMC → Advanced → Shutdown Dose).
 *
 * A resumable five-step wizard for R2S and D1S calculations. The configuration
 * lives in the project state (`shutdownDose`), is never written to
 * settings.xml, and is handed to the Python drivers through the backend.
 *
 * @module openmc-studio/browser
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FileDialogService } from '@theia/filesystem/lib/browser';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import URI from '@theia/core/lib/common/uri';

import { OpenMCShutdownDoseConfig, OpenMCShutdownDoseWizardStep, OpenMCState } from '../../../common/openmc-state-schema';
import {
    ShutdownDoseReadiness,
    assessShutdownDoseReadiness,
    createDefaultShutdownDoseConfig,
    createDoseTally,
    getNextShutdownDoseTallyId
} from '../../../common/shutdown-dose';
import {
    OpenMCStudioBackendService,
    ShutdownDoseProgress,
    ShutdownDoseProgressEvent,
    ShutdownDoseResult,
    ShutdownDoseValidationIssue,
    StartShutdownDoseRequest
} from '../../../common/openmc-studio-protocol';
import { OpenMCStateManager } from '../../openmc-state-manager';
import { OpenMCXMLGenerationService } from '../../xml-generator/xml-generation-service';
import { SHUTDOWN_DOSE_STEPS, ShutdownDoseStepProps, shutdownDoseStepView } from './shutdown-dose-steps';

const PROGRESS_EVENT = 'openmc-shutdown-dose-progress';

@injectable()
export class ShutdownDoseWidget extends ReactWidget {
    /** Unique widget identifier. */
    static readonly ID = 'openmc-shutdown-dose-widget';
    /** Display label. */
    static readonly LABEL = 'Shutdown Dose';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCStateManager)
    protected readonly stateManager!: OpenMCStateManager;

    @inject(OpenMCStudioBackendService)
    protected readonly backend!: OpenMCStudioBackendService;

    @inject(OpenMCXMLGenerationService)
    protected readonly xmlService!: OpenMCXMLGenerationService;

    @inject(FileDialogService)
    protected readonly fileDialogService!: FileDialogService;

    @inject(FileNavigatorContribution)
    protected readonly fileNavigator!: FileNavigatorContribution;

    @inject(OpenerService)
    protected readonly openerService!: OpenerService;

    private isRunning = false;
    private processId?: string;
    private progress?: ShutdownDoseProgress;
    private result?: ShutdownDoseResult;
    private isAddingDose = false;
    private doseError?: string;
    private backendIssues: ShutdownDoseValidationIssue[] = [];

    /** Initialize widget chrome and listeners. */
    @postConstruct()
    protected init(): void {
        this.id = ShutdownDoseWidget.ID;
        this.title.label = ShutdownDoseWidget.LABEL;
        this.title.caption = 'R2S / D1S shutdown-dose workflow';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-openmc-shutdown-dose';

        this.stateManager.onStateChange(() => this.update());
        this.stateManager.onStateReload(() => {
            this.result = undefined;
            this.progress = undefined;
            this.isRunning = false;
            this.update();
            void this.restoreLastResult();
        });

        window.addEventListener(PROGRESS_EVENT, this.handleProgressEvent as EventListener);
        this.update();
        void this.restoreLastResult();
    }

    /** Remove the window listener. */
    dispose(): void {
        window.removeEventListener(PROGRESS_EVENT, this.handleProgressEvent as EventListener);
        super.dispose();
    }

    /** Current configuration (persisted state or a fresh default). */
    private getConfig(state: OpenMCState): OpenMCShutdownDoseConfig {
        return state.shutdownDose ?? createDefaultShutdownDoseConfig(state);
    }

    /** Merge a partial update into the persisted configuration. */
    private readonly updateConfig = (updates: Partial<OpenMCShutdownDoseConfig>): void => {
        const state = this.stateManager.getState();
        const base = this.getConfig(state);
        this.backendIssues = [];
        this.stateManager.updateShutdownDose({ ...base, ...updates });
    };

    /** Update one cell's volume (required for cell-based activation). */
    private readonly setCellVolume = (cellId: number, volume: number | undefined): void => {
        this.stateManager.updateCell(cellId, { volume });
    };

    /** Show a directory picker. */
    private readonly chooseDirectory = async (title: string): Promise<string | undefined> => {
        const uri = await this.fileDialogService.showOpenDialog({
            title,
            canSelectFiles: false,
            canSelectFolders: true
        });
        return uri?.path.toString();
    };

    /** Show a chain-file picker. */
    private readonly chooseChainFile = async (): Promise<string | undefined> => {
        const uri = await this.fileDialogService.showOpenDialog({
            title: 'Select Depletion Chain',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: {
                'Depletion chain': ['xml'],
                'All files': ['*']
            }
        });
        return uri?.path.toString();
    };

    /** Read OpenMC dose coefficients and add a dose tally to the project. */
    private readonly addDoseTally = async (meshId?: number): Promise<void> => {
        const state = this.stateManager.getState();
        const config = this.getConfig(state);
        const template = config.doseTallyTemplate ?? createDefaultShutdownDoseConfig(state).doseTallyTemplate!;
        this.isAddingDose = true;
        this.doseError = undefined;
        this.update();
        try {
            const coefficients = await this.backend.getDoseCoefficients({
                particle: 'photon',
                dataSource: template.dataSource,
                doseQuantity: template.doseQuantity,
                geometry: template.geometry
            });
            if (!coefficients.success || !coefficients.energy || !coefficients.response) {
                this.doseError = coefficients.error || 'Could not read dose-response coefficients.';
                this.messageService.error(this.doseError);
                return;
            }
            const tally = createDoseTally(getNextShutdownDoseTallyId(state), template, coefficients.energy, coefficients.response, meshId);
            const selected = new Set(config.photonTallyIds ?? []);
            selected.add(tally.id);
            this.stateManager.addTally(tally);
            this.updateConfig({ photonTallyIds: [...selected].sort((a, b) => a - b), doseTallyId: tally.id });
            this.messageService.info(`Added dose tally #${tally.id}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.doseError = message;
            this.messageService.error(`Could not add dose tally: ${message}`);
        } finally {
            this.isAddingDose = false;
            this.update();
        }
    };

    /** Validate, generate XML, and launch the selected driver. */
    private readonly run = async (): Promise<void> => {
        const state = this.stateManager.getState();
        const config = this.getConfig(state);
        const readiness = assessShutdownDoseReadiness(state, config);
        if (!readiness.ready) {
            this.messageService.error('Resolve the blocking issues before running the shutdown-dose workflow.');
            return;
        }

        let runDirectory = config.outputDirectory;
        if (!runDirectory) {
            runDirectory = await this.chooseDirectory('Select Shutdown Dose Run Directory');
            if (!runDirectory) {
                return;
            }
        }

        const candidate: OpenMCShutdownDoseConfig = {
            ...config,
            workingDirectory: runDirectory,
            outputDirectory: runDirectory,
            wizardStep: 'review'
        };
        const validation = await this.backend.validateShutdownDose({ state, config: candidate });
        if (!validation.ready) {
            this.backendIssues = validation.issues.filter((issue) => issue.severity === 'error');
            this.messageService.error(this.backendIssues[0]?.message || 'Shutdown-dose configuration is not ready.');
            this.update();
            return;
        }
        this.backendIssues = [];

        this.isRunning = true;
        this.result = undefined;
        this.progress = { step: config.method === 'd1s' ? 'd1s' : 'neutron', message: 'Generating model XML', fraction: 0 };
        this.update();

        try {
            const xml = await this.xmlService.generateXML({
                state,
                outputDirectory: runDirectory,
                files: {
                    materials: true,
                    settings: true,
                    geometry: true,
                    tallies: state.tallies.length > 0,
                    plots: false
                }
            });
            if (!xml.success) {
                this.isRunning = false;
                this.progress = undefined;
                this.messageService.error(`XML generation failed: ${xml.error}`);
                this.update();
                return;
            }

            const runConfig: OpenMCShutdownDoseConfig = candidate;
            this.updateConfig({ workingDirectory: runDirectory, outputDirectory: runDirectory });

            const request: StartShutdownDoseRequest = {
                workingDirectory: runDirectory,
                config: runConfig
            };
            const response = await this.backend.startShutdownDose(request);
            if (!response.success) {
                this.isRunning = false;
                this.progress = undefined;
                this.messageService.error(response.error || 'Could not start the shutdown-dose driver.');
                this.update();
                return;
            }
            this.processId = response.processId;
            this.progress = { step: config.method === 'd1s' ? 'd1s' : 'neutron', message: 'Driver started', fraction: 0.01 };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.isRunning = false;
            this.progress = undefined;
            this.messageService.error(`Shutdown-dose run failed: ${message}`);
        }
        this.update();
    };

    /** Cancel the running driver. */
    private readonly cancel = async (): Promise<void> => {
        if (!this.processId) {
            return;
        }
        const cancelled = await this.backend.cancelShutdownDose(this.processId);
        if (cancelled) {
            this.progress = { ...(this.progress ?? { step: 'done', message: '' }), message: 'Cancelling…' };
            this.update();
        }
    };

    /** Apply a streamed progress event and finish the run on the terminal event. */
    private readonly handleProgressEvent = (event: Event): void => {
        const detail = (event as CustomEvent<ShutdownDoseProgressEvent>).detail;
        if (!detail) {
            return;
        }
        if (this.processId && detail.processId !== this.processId) {
            return;
        }
        if (!this.processId) {
            this.processId = detail.processId;
        }
        this.progress = detail.progress;
        if (detail.result) {
            this.result = detail.result;
            this.isRunning = false;
            this.processId = undefined;
            const state = this.stateManager.getState();
            const config = this.getConfig(state);
            if (detail.result.outputDirectory) {
                this.updateConfig({
                    wizardStep: 'results',
                    lastRun: {
                        outputDirectory: detail.result.outputDirectory,
                        method: detail.result.summary?.method ?? config.method,
                        completedAt: new Date().toISOString()
                    }
                });
            } else {
                this.updateConfig({ wizardStep: 'results' });
            }
            if (detail.result.success) {
                this.messageService.info('Shutdown-dose calculation complete.');
            } else {
                this.messageService.error(detail.result.error || 'Shutdown-dose calculation failed.');
            }
        }
        this.update();
    };

    /** Load a previous run's summary from its output directory. */
    private readonly loadPreviousResult = async (): Promise<void> => {
        const config = this.getConfig(this.stateManager.getState());
        if (!config.lastRun?.outputDirectory) {
            return;
        }
        const loaded = await this.backend.readShutdownDoseSummary({ outputDirectory: config.lastRun.outputDirectory });
        if (loaded.success && loaded.result) {
            this.result = loaded.result;
            this.progress = undefined;
            this.updateConfig({ wizardStep: 'results' });
        } else {
            this.messageService.warn(loaded.error || 'Could not load the previous shutdown-dose summary.');
        }
        this.update();
    };

    /** Restore the results page after a project reload. */
    private async restoreLastResult(): Promise<void> {
        const state = this.stateManager.getState();
        const config = state.shutdownDose;
        if (!config?.lastRun || config.wizardStep !== 'results' || this.result) {
            return;
        }
        const loaded = await this.backend.readShutdownDoseSummary({ outputDirectory: config.lastRun.outputDirectory });
        if (loaded.success && loaded.result) {
            this.result = loaded.result;
            this.update();
        }
    }

    /** Reveal a directory in the file navigator. */
    private readonly openFolder = (path: string): void => {
        void this.fileNavigator.selectFileNode(URI.fromFilePath(path)).catch((error) => {
            this.messageService.warn(`Could not reveal ${path}: ${error}`);
        });
    };

    /** Open a file with the default viewer, falling back to the navigator. */
    private readonly openFile = (path: string): void => {
        void open(this.openerService, URI.fromFilePath(path))
            .then((opened) => {
                if (!opened) {
                    this.openFolder(path);
                    this.messageService.warn(`No viewer opened ${path}; revealed it in the file navigator instead.`);
                }
            })
            .catch(() => {
                this.openFolder(path);
                this.messageService.warn(`No viewer opened ${path}; revealed it in the file navigator instead.`);
            });
    };

    /** Persist and navigate to a wizard page. */
    private readonly goToStep = (step: OpenMCShutdownDoseWizardStep): void => {
        this.updateConfig({ wizardStep: step });
    };

    /** Whether a step can be opened. */
    private canNavigateTo(step: OpenMCShutdownDoseWizardStep, readiness: ShutdownDoseReadiness, config: OpenMCShutdownDoseConfig): boolean {
        if (step === 'method') {
            return true;
        }
        if (step === 'results') {
            return !!this.result || !!config.lastRun;
        }
        const baseReady = readiness.errors.every(
            (issue) => !['method', 'domains', 'schedule', 'chain', 'd1s', 'output', 'tallies'].includes(issue.field)
        );
        if (step === 'schedule') {
            return readiness.errors.every((issue) => !['method', 'domains'].includes(issue.field));
        }
        if (step === 'tallies') {
            return (
                readiness.errors.every((issue) => !['method', 'domains', 'schedule', 'chain', 'd1s'].includes(issue.field)) &&
                readiness.errors.every((issue) => issue.field !== 'output')
            );
        }
        return baseReady && readiness.errors.every((issue) => issue.field !== 'tallies');
    }

    /** Build the props shared by the step views. */
    private stepProps(state: OpenMCState, config: OpenMCShutdownDoseConfig, readiness: ShutdownDoseReadiness): ShutdownDoseStepProps {
        return {
            state,
            config,
            readiness,
            update: this.updateConfig,
            setCellVolume: this.setCellVolume,
            chooseDirectory: this.chooseDirectory,
            chooseChainFile: this.chooseChainFile,
            addDoseTally: this.addDoseTally,
            isAddingDose: this.isAddingDose,
            doseError: this.doseError,
            backendIssues: this.backendIssues,
            run: this.run,
            cancel: this.cancel,
            isRunning: this.isRunning,
            progress: this.progress,
            result: this.result,
            openFolder: this.openFolder,
            openFile: this.openFile,
            goToStep: this.goToStep,
            loadPreviousResult: this.loadPreviousResult
        };
    }

    /** Render the widget. */
    protected render(): React.ReactNode {
        const state = this.stateManager.getState();
        const config = this.getConfig(state);
        const readiness = assessShutdownDoseReadiness(state, config);
        const currentStep = config.wizardStep ?? 'method';
        const currentIndex = SHUTDOWN_DOSE_STEPS.findIndex((step) => step.id === currentStep);
        const readyBadge = readiness.ready ? 'ready' : 'blocked';
        const domainCount =
            config.method === 'd1s'
                ? 0
                : (config.domainType ?? 'cell') === 'mesh'
                  ? (config.meshIds?.length ?? 0)
                  : (config.cellIds?.length ?? 0);

        return (
            <div className="shutdown-dose-widget openmc-widget">
                <div className="openmc-header">
                    <div className="header-info">
                        <h2>
                            <i className="codicon codicon-openmc-shutdown-dose" /> Shutdown Dose
                        </h2>
                        <p className="header-description">R2S and D1S activation, decay-photon transport, and dose results</p>
                    </div>
                    <div className="header-actions">
                        <Tooltip
                            content={readiness.ready ? 'Configuration is ready to run' : 'Review the blocking issues in the wizard'}
                            position="bottom"
                        >
                            <span className={`shutdown-dose-badge ${readyBadge}`}>
                                <i className={`codicon ${readiness.ready ? 'codicon-pass-filled' : 'codicon-error'}`} />
                                {readiness.ready ? 'Ready' : `${readiness.errors.length} issue(s)`}
                            </span>
                        </Tooltip>
                    </div>
                    <div className="header-stats">
                        <div className="stat-item">
                            <span className="stat-value">{config.method.toUpperCase()}</span>
                            <span className="stat-label">Method</span>
                        </div>
                        <div className="stat-item">
                            <span className="stat-value">{domainCount}</span>
                            <span className="stat-label">{config.method === 'd1s' ? 'Coupled' : 'Regions'}</span>
                        </div>
                        <div className="stat-item">
                            <span className="stat-value">{config.photonTallyIds?.length ?? 0}</span>
                            <span className="stat-label">Tallies</span>
                        </div>
                    </div>
                </div>

                <nav className="shutdown-dose-stepper" aria-label="Shutdown dose wizard steps">
                    {SHUTDOWN_DOSE_STEPS.map((step, index) => {
                        const active = step.id === currentStep;
                        const complete = index < currentIndex && this.canNavigateTo(step.id, readiness, config);
                        const enabled = this.canNavigateTo(step.id, readiness, config);
                        return (
                            <Tooltip key={step.id} content={step.description} position="bottom">
                                <button
                                    type="button"
                                    className={`shutdown-dose-step ${active ? 'active' : ''} ${complete ? 'complete' : ''}`}
                                    aria-current={active ? 'step' : undefined}
                                    disabled={!enabled}
                                    onClick={() => this.goToStep(step.id)}
                                >
                                    <i className={`codicon ${step.icon}`} />
                                    <span className="step-index">{index + 1}</span>
                                    <span className="step-label">{step.label}</span>
                                </button>
                            </Tooltip>
                        );
                    })}
                </nav>

                <div className="shutdown-dose-body">{shutdownDoseStepView(currentStep, this.stepProps(state, config, readiness))}</div>

                <div className="shutdown-dose-footer">
                    <button
                        type="button"
                        className="theia-button secondary"
                        disabled={currentIndex <= 0}
                        onClick={() => {
                            const previous = SHUTDOWN_DOSE_STEPS[Math.max(0, currentIndex - 1)];
                            this.goToStep(previous.id);
                        }}
                    >
                        <i className="codicon codicon-chevron-left" /> Back
                    </button>
                    <span className="shutdown-dose-footer-hint">
                        Step {currentIndex + 1} of {SHUTDOWN_DOSE_STEPS.length}
                    </span>
                    {currentStep !== 'review' && currentStep !== 'results' && (
                        <Tooltip
                            content={
                                this.canNavigateTo(SHUTDOWN_DOSE_STEPS[currentIndex + 1]?.id ?? 'results', readiness, config)
                                    ? 'Continue to the next step'
                                    : 'Resolve the issues on this step first'
                            }
                            position="top"
                        >
                            <button
                                type="button"
                                className="theia-button primary"
                                disabled={!this.canNavigateTo(SHUTDOWN_DOSE_STEPS[currentIndex + 1]?.id ?? 'results', readiness, config)}
                                onClick={() => {
                                    const next = SHUTDOWN_DOSE_STEPS[Math.min(SHUTDOWN_DOSE_STEPS.length - 1, currentIndex + 1)];
                                    this.goToStep(next.id);
                                }}
                            >
                                Next <i className="codicon codicon-chevron-right" />
                            </button>
                        </Tooltip>
                    )}
                    {currentStep === 'results' && (
                        <button type="button" className="theia-button secondary" onClick={() => this.goToStep('review')}>
                            <i className="codicon codicon-debug-restart" /> New run
                        </button>
                    )}
                </div>
            </div>
        );
    }
}
