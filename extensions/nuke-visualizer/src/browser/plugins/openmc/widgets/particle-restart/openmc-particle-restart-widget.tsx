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

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { MessageService } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCBackendService, OpenMCParticleRestart } from '../../../../../common/openmc-protocol';
import { detectMissingDependencies } from '../dependency-hints';
import '../output-viewer.css';

/**
 * Preview viewer for OpenMC particle restart files (`particle_restart.h5` /
 * `particle_<batch>_<id>.h5`): the state of the particle that was lost and
 * can be re-run. Scalar/tabular data rendered as section cards — no trame
 * pipeline. A later openmc-studio task adds the run-single-particle action.
 */
@injectable()
export class OpenMCParticleRestartWidget extends ReactWidget {
    static readonly ID = 'openmc-particle-restart-widget';
    static readonly LABEL = 'Particle Restart';

    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected fileUri: URI | undefined;
    protected data: OpenMCParticleRestart | undefined;
    protected isLoading = false;
    protected error: string | undefined;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCParticleRestartWidget.ID;
        this.title.label = OpenMCParticleRestartWidget.LABEL;
        this.title.iconClass = codicon('debug-restart');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        this.fileUri = uri;
        this.id = `${OpenMCParticleRestartWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${OpenMCParticleRestartWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${OpenMCParticleRestartWidget.LABEL}: ${uri.path.toString()}`;
        this.data = undefined;
        this.error = undefined;
        this.update();
        this.load();
    }

    protected async load(): Promise<void> {
        if (!this.fileUri) {
            return;
        }
        this.isLoading = true;
        this.error = undefined;
        this.update();
        try {
            this.data = await this.openmcBackend.getParticleRestart(this.fileUri.path.toString());
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        }
        this.isLoading = false;
        this.update();
    }

    protected render(): React.ReactNode {
        const fileName = this.fileUri?.path.base ?? '';
        const data = this.data;
        return (
            <div className="openmc-output-viewer-container">
                <div className="openmc-output-viewer-header">
                    <span className="openmc-output-viewer-file">
                        <i className={codicon('debug-restart')}></i>
                        {fileName}
                    </span>
                    {data && <span className="openmc-output-viewer-chip">{data.particle}</span>}
                    {data?.runMode && <span className="openmc-output-viewer-chip">{data.runMode}</span>}
                    <Tooltip content="Reload" position="bottom">
                        <button
                            className="theia-button secondary openmc-output-viewer-reload"
                            onClick={() => this.load()}
                            disabled={this.isLoading}
                        >
                            <i className={codicon('refresh')}></i>
                        </button>
                    </Tooltip>
                </div>
                {this.renderBody()}
            </div>
        );
    }

    protected renderBody(): React.ReactNode {
        if (this.isLoading) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-spinner"></div>
                    <span>Reading particle state…</span>
                </div>
            );
        }
        if (this.error) {
            const missingDeps = detectMissingDependencies(this.error);
            return (
                <div className="openmc-output-viewer-status error">
                    <i className={codicon('error')}></i>
                    <span>
                        {this.error}
                        {missingDeps &&
                            ` — install ${missingDeps.join(', ')} into the configured environment or switch it in Settings → Nuke Utils`}
                    </span>
                </div>
            );
        }
        const data = this.data;
        if (!data) {
            return (
                <div className="openmc-output-viewer-status">
                    <span>No particle restart file loaded</span>
                </div>
            );
        }

        return (
            <div className="openmc-output-viewer-panel" style={{ maxHeight: 'none', borderTop: 'none', overflow: 'auto' }}>
                <div className="openmc-output-viewer-card">
                    <div className="openmc-output-viewer-card-title">
                        <i className={codicon('history')}></i> Run Context
                    </div>
                    <dl>
                        <dt>Lost in batch</dt>
                        <dd>{data.currentBatch}</dd>
                        <dt>Generation</dt>
                        <dd>{data.currentGeneration}</dd>
                        <dt>Generations / batch</dt>
                        <dd>{data.generationsPerBatch}</dd>
                        <dt>Particles / generation</dt>
                        <dd>{data.nParticles.toLocaleString()}</dd>
                    </dl>
                </div>

                <div className="openmc-output-viewer-card">
                    <div className="openmc-output-viewer-card-title">
                        <i className={codicon('symbol-atom')}></i> Particle State
                    </div>
                    <dl>
                        <dt>Type</dt>
                        <dd>
                            {data.particle} (PDG {data.pdg})
                        </dd>
                        <dt>Particle ID</dt>
                        <dd>{data.particleId}</dd>
                        <dt>Energy</dt>
                        <dd>{data.energy.toExponential(6)} eV</dd>
                        <dt>Weight</dt>
                        <dd>{data.weight}</dd>
                        <dt>Time</dt>
                        <dd>{data.time !== null ? `${data.time.toExponential(6)} s` : 'n/a'}</dd>
                        <dt>Position r</dt>
                        <dd>[{data.position.map((v) => v.toFixed(6)).join(', ')}] cm</dd>
                        <dt>Direction u</dt>
                        <dd>[{data.direction.map((v) => v.toFixed(6)).join(', ')}]</dd>
                    </dl>
                </div>

                <div className="openmc-output-viewer-card">
                    <div className="openmc-output-viewer-card-title">
                        <i className={codicon('file')}></i> File
                    </div>
                    <dl>
                        {data.filetype && (
                            <>
                                <dt>Filetype</dt>
                                <dd>{data.filetype}</dd>
                            </>
                        )}
                        {data.version && (
                            <>
                                <dt>Version</dt>
                                <dd>{data.version.join('.')}</dd>
                            </>
                        )}
                        <dt>Path</dt>
                        <dd>{data.file}</dd>
                    </dl>
                </div>
            </div>
        );
    }
}
