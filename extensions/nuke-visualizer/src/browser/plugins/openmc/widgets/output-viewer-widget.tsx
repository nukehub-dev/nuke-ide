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
import { injectable, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { MessageService } from '@theia/core/lib/common';
import { OpenMCBackendService, OpenMCVtkConversionResult } from '../../../../common/openmc-protocol';
import { VisualizerBackendService } from '../../../../common/base-visualizer-protocol';
import { toProxiedVisualizerUrl } from '../../../visualizer-url';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { detectMissingDependencies } from './dependency-hints';
import { startSplitDrag } from './drag-split';
import './output-viewer.css';

/**
 * Base class for the OpenMC output file viewers (tracks, collision track,
 * weight windows). Handles the shared lifecycle: convert the HDF5 output to
 * a VTK file via the backend, serve it through the base visualizer's trame
 * server (`base.serve`), and render it in an iframe routed through the
 * visualizer reverse proxy. Subclasses provide the conversion call and any
 * extra controls/panels (filter inputs, data tables).
 */
@injectable()
export abstract class OpenMCOutputViewerWidget extends ReactWidget {
    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend!: VisualizerBackendService;

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    protected fileUri: URI | undefined;
    protected serverUrl: string | undefined;
    protected serverPort: number | undefined;
    protected isLoading = false;
    protected error: string | undefined;
    protected statusMessage = '';
    /** VTK file currently served (set by reload after conversion). */
    protected lastVtkPath: string | undefined;
    private loadToken = 0;

    /** Run the backend conversion, returning the VTK result. */
    protected abstract convert(filePath: string): Promise<OpenMCVtkConversionResult>;

    /** Optional hook: fetch panel data (tables, summaries) after a successful load. */
    protected async loadPanelData(filePath: string): Promise<void> {
        // default: no panel data
    }

    /**
     * Optional hook: initial color-by selection passed to the trame server
     * ('Solid Color', 'Point: <name>', 'Cell: <name>'). Default: viewer default.
     */
    protected getColorBy(): string | undefined {
        return undefined;
    }

    /** Viewer-specific controls rendered in the header row. */
    protected renderControls(): React.ReactNode {
        return undefined;
    }

    /** Viewer-specific panel rendered below the 3D view (tables, summaries). */
    protected renderPanel(): React.ReactNode {
        return undefined;
    }

    /** Hint text shown above the iframe describing the available color-by arrays. */
    protected renderViewerHint(): React.ReactNode {
        return undefined;
    }

    get filePath(): string | undefined {
        return this.fileUri?.path.toString();
    }

    setFile(uri: URI, widgetId: string, label: string): void {
        this.fileUri = uri;
        this.id = `${widgetId}:${uri.path.toString()}`;
        this.title.label = `${label}: ${uri.path.base}`;
        this.title.caption = `${label}: ${uri.path.toString()}`;
        this.error = undefined;
        this.update();
        this.reload();
    }

    /** (Re)run the conversion and restart the trame server. */
    async reload(): Promise<void> {
        const filePath = this.filePath;
        if (!filePath) {
            return;
        }
        const token = ++this.loadToken;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Converting to VTK…';
        this.update();

        try {
            const result = await this.convert(filePath);
            if (token !== this.loadToken) {
                return;
            }
            if (!result.success || !result.vtkPath) {
                throw new Error(result.error || 'Conversion failed');
            }
            this.lastVtkPath = result.vtkPath;

            // Panel data first: viewers may use it to pick the initial color-by
            this.statusMessage = 'Loading data…';
            this.update();
            await this.loadPanelData(filePath);
            if (token !== this.loadToken) {
                return;
            }

            this.statusMessage = 'Starting viewer…';
            this.update();
            await this.restartServer(result.vtkPath);
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.statusMessage = '';
            this.update();
        } catch (error) {
            if (token !== this.loadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.update();
        }
    }

    protected async restartServer(vtkPath: string): Promise<void> {
        if (this.serverPort !== undefined) {
            try {
                await this.visualizerBackend.stopServer(this.serverPort);
            } catch {
                // best effort — the process may already be gone
            }
            this.serverPort = undefined;
            this.serverUrl = undefined;
        }
        const info = await this.visualizerBackend.startServer(vtkPath, undefined, undefined, this.getColorBy());
        this.lastVtkPath = vtkPath;
        this.serverPort = info.port;
        this.serverUrl = toProxiedVisualizerUrl(info.url);
    }

    /** Restart the trame server for the current VTK file (e.g. after a color-by change). */
    protected async refreshServer(): Promise<void> {
        if (this.lastVtkPath) {
            await this.restartServer(this.lastVtkPath);
            this.update();
        }
    }

    override dispose(): void {
        if (this.serverPort !== undefined) {
            this.visualizerBackend.stopServer(this.serverPort).catch(() => undefined);
            this.serverPort = undefined;
        }
        super.dispose();
    }

    protected render(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-container">
                {this.renderHeader()}
                {this.error ? this.renderError() : this.renderContent()}
            </div>
        );
    }

    protected renderHeader(): React.ReactNode {
        const fileName = this.fileUri?.path.base ?? '';
        return (
            <div className="openmc-output-viewer-header">
                <span className="openmc-output-viewer-file">
                    <i className={codicon('file')}></i>
                    {fileName}
                </span>
                {this.renderControls()}
                <Tooltip content="Reload" position="bottom">
                    <button
                        className="theia-button secondary openmc-output-viewer-reload"
                        onClick={() => this.reload()}
                        disabled={this.isLoading}
                    >
                        <i className={codicon('refresh')}></i>
                    </button>
                </Tooltip>
            </div>
        );
    }

    protected renderContent(): React.ReactNode {
        if (this.isLoading && !this.serverUrl) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-spinner"></div>
                    <span>{this.statusMessage || 'Loading…'}</span>
                </div>
            );
        }
        const panel = this.renderPanel();
        return (
            <>
                <div className="openmc-output-viewer-viewarea">
                    {this.renderViewerHint()}
                    {this.serverUrl ? (
                        <iframe className="openmc-output-viewer-iframe" src={this.serverUrl} title={this.title.label} />
                    ) : (
                        <div className="openmc-output-viewer-status">
                            <span>{this.statusMessage || 'No file loaded'}</span>
                        </div>
                    )}
                </div>
                {panel && (
                    <>
                        <div
                            className="openmc-output-viewer-split-handle"
                            onMouseDown={this.startSplitDrag}
                            role="separator"
                            aria-orientation="horizontal"
                        />
                        <div
                            className="openmc-output-viewer-panel-host"
                            style={this.panelHeight !== undefined ? { height: `${this.panelHeight}px`, flex: 'none' } : undefined}
                        >
                            {panel}
                        </div>
                    </>
                )}
            </>
        );
    }

    /** Panel height in px once the user drags the split (undefined = CSS default 40%). */
    protected panelHeight?: number;

    /**
     * Drag-to-resize the split between the 3D view and the data panel
     * (shared helper: direct DOM writes during the drag, iframe click-shield).
     */
    protected startSplitDrag = (e: React.MouseEvent): void => {
        const host = this.node.querySelector<HTMLElement>('.openmc-output-viewer-panel-host');
        const container = this.node.querySelector<HTMLElement>('.openmc-output-viewer-container');
        if (!host || !container) {
            return;
        }
        const startHeight = host.getBoundingClientRect().height;
        const containerHeight = container.getBoundingClientRect().height;
        // Keep at least 120px for the 3D view and 80px for the panel
        const maxHeight = Math.max(120, containerHeight - 120);
        startSplitDrag({
            event: e,
            node: this.node,
            sizeFromEvent: (start, ev) => Math.round(Math.min(maxHeight, Math.max(80, startHeight + (start.clientY - ev.clientY)))),
            apply: (size) => {
                host.style.height = `${size}px`;
                host.style.flex = 'none';
                this.panelHeight = size;
            },
            commit: () => this.update()
        });
    };

    protected renderError(): React.ReactNode {
        const missingDeps = this.error ? detectMissingDependencies(this.error) : undefined;
        if (missingDeps) {
            return this.renderDependencyError(missingDeps);
        }
        return (
            <div className="openmc-output-viewer-status error">
                <i className={codicon('error')}></i>
                <span>{this.error}</span>
            </div>
        );
    }

    /**
     * Actionable error panel for missing Python dependencies: name what's
     * missing and how to fix it, keeping the genuine backend error text.
     */
    protected renderDependencyError(missingDeps: string[]): React.ReactNode {
        return (
            <div className="openmc-output-viewer-status">
                <div className="openmc-output-viewer-dep-panel">
                    <div className="dep-title">
                        <i className={codicon('warning')}></i>
                        Missing Python dependencies
                    </div>
                    <p className="dep-summary">
                        This viewer needs <strong>{missingDeps.join(', ')}</strong>, which the configured Python environment does not
                        provide.
                    </p>
                    <ul className="dep-actions">
                        <li>
                            Install the missing packages into the configured environment (for the 3D viewers that is <code>vtk</code> and{' '}
                            <code>trame</code> with <code>paraview</code>).
                        </li>
                        <li>
                            Or point NukeIDE at an environment that has them in <strong>Settings → Nuke Utils</strong> (Python environment),
                            then reload this viewer.
                        </li>
                    </ul>
                    <p className="dep-backend-error">
                        <span className="dep-backend-label">Backend error:</span> {this.error}
                    </p>
                    <button className="theia-button secondary" onClick={() => this.reload()}>
                        <i className={codicon('refresh')}></i>
                        Retry
                    </button>
                </div>
            </div>
        );
    }
}
