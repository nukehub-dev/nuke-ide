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
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { OpenMCBackendService, OpenMCWeightWindowsData } from '../../../../../common/openmc-protocol';
import { NativeVtkViewerWidget } from '../native-vtk-viewer-widget';
import { readVtkText } from '../native-vtk/native-vtk-data';
import { detectMissingDependencies } from '../dependency-hints';
import { startSplitDrag } from '../drag-split';

/**
 * Viewer for OpenMC weight window files (`weight_windows.h5`). Converts the
 * file to a `.vtr` rectilinear grid via `openmc.weight-windows-vtk` (one
 * cell-data array per (bound, energy group) named `lower_g<i>` /
 * `upper_g<i>`, `ww<id>_` prefixed for multi-window files) and renders it
 * with the native three.js viewer — color-by switches apply instantly with
 * no server restart. A summary panel lists meshes and windows below the 3D
 * view.
 *
 * The mesh selector re-runs the conversion anchored to the chosen mesh
 * (`--mesh-id`; windows on other meshes are skipped by the backend) when a
 * file carries windows on multiple meshes.
 *
 * Files the native XML parser cannot read render an actionable error panel
 * (open the converted VTK in the generic VTK viewer instead) — there is no
 * serve fallback.
 */
@injectable()
export class OpenMCWeightWindowsViewerWidget extends NativeVtkViewerWidget {
    static override readonly ID: string = 'openmc-weight-windows-viewer-widget';
    static override readonly LABEL: string = 'Weight Windows Viewer';

    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    /** The source `weight_windows.h5` file (the native base points at VTK; this stays on the source). */
    protected sourceUri: URI | undefined;
    /** VTK file produced by the last conversion (set by reload). */
    protected lastVtkPath: string | undefined;
    protected data: OpenMCWeightWindowsData | undefined;
    /** Mesh ID the conversion is anchored to (undefined = first window's mesh). */
    protected selectedMeshId?: number;
    /** Panel height in px once the user drags the split (undefined = CSS default 40%). */
    protected panelHeight?: number;
    private reloadToken = 0;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCWeightWindowsViewerWidget.ID;
        this.title.label = OpenMCWeightWindowsViewerWidget.LABEL;
        this.title.iconClass = codicon('graph');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        this.sourceUri = uri;
        this.selectedMeshId = undefined;
        this.data = undefined;
        this.id = `${OpenMCWeightWindowsViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${OpenMCWeightWindowsViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${OpenMCWeightWindowsViewerWidget.LABEL}: ${uri.path.toString()}`;
        this.error = undefined;
        this.update();
        void this.reload();
    }

    /**
     * Header reload/retry buttons call `setVtkFile(this.fileUri)`; the file
     * URI stays on the source `.h5`, so route that back through a full
     * reconversion instead of parsing the HDF5 as VTK.
     */
    override async setVtkFile(uri: URI): Promise<void> {
        if (this.sourceUri && uri.path.toString() === this.sourceUri.path.toString()) {
            await this.reload();
            return;
        }
        await super.setVtkFile(uri);
    }

    /** (Re)run the conversion and load the result into the native viewer. */
    async reload(): Promise<void> {
        const filePath = this.sourceUri?.path.toString();
        if (!filePath) {
            return;
        }
        const token = ++this.reloadToken;
        this.isLoading = true;
        this.error = undefined;
        this.statusMessage = 'Converting to VTK…';
        this.update();

        try {
            const result = await this.openmcBackend.convertWeightWindowsToVtk(filePath, this.selectedMeshId);
            if (token !== this.reloadToken) {
                return;
            }
            if (!result.success || !result.vtkPath) {
                throw new Error(result.error || 'Conversion failed');
            }
            this.lastVtkPath = result.vtkPath;

            this.statusMessage = 'Loading data…';
            this.update();
            this.data = await this.openmcBackend.getWeightWindows(filePath);
            if (token !== this.reloadToken) {
                return;
            }

            this.statusMessage = 'Reading VTK file…';
            this.update();
            const text = await readVtkText(this.fileService, new URI(result.vtkPath));
            if (token !== this.reloadToken) {
                return;
            }
            // setVtkText parses without touching fileUri/title, so the header
            // keeps showing the source file while the scene shows the VTK.
            // A parse failure lands in this.error — name the file kind and
            // point at the generic VTK viewer instead of failing bare.
            this.fileUri = this.sourceUri;
            await this.setVtkText(text);
            if (token !== this.reloadToken) {
                return;
            }
            if (this.error) {
                this.error =
                    `Weight windows file not supported by the native viewer: ${this.error}. ` +
                    'Open the converted VTK file in the generic VTK viewer (Visualizer) instead.';
                this.fileUri = this.sourceUri;
                this.isLoading = false;
                this.update();
                return;
            }
            this.fileUri = this.sourceUri;
            this.isLoading = false;
            this.statusMessage = '';
            this.update();
        } catch (error) {
            if (token !== this.reloadToken) {
                return;
            }
            this.isLoading = false;
            this.error = error instanceof Error ? error.message : String(error);
            this.update();
        }
    }

    protected override renderContent(): React.ReactNode {
        const base = super.renderContent();
        const panel = this.renderPanel();
        if (!panel) {
            return base;
        }
        return (
            <>
                {base}
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
        );
    }

    /**
     * Drag-to-resize the split between the 3D view and the data panel
     * (shared helper: direct DOM writes during the drag, `update()` only on
     * mouseup).
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

    protected override renderError(): React.ReactNode {
        const missingDeps = this.error ? detectMissingDependencies(this.error) : undefined;
        if (missingDeps) {
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
                                Install the missing packages into the configured environment (for the 3D viewers that is <code>vtk</code>).
                            </li>
                            <li>
                                Or point NukeIDE at an environment that has them in <strong>Settings → Nuke Utils</strong> (Python
                                environment), then reload this viewer.
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
        if (this.error?.includes('not supported by the native viewer')) {
            return (
                <div className="openmc-output-viewer-status">
                    <div className="openmc-output-viewer-dep-panel">
                        <div className="dep-title">
                            <i className={codicon('warning')}></i>
                            Not supported by the native viewer
                        </div>
                        <p className="dep-summary">
                            This weight windows file cannot be displayed by the native 3D viewer — only the XML VTK datasets the converter
                            produces are supported here.
                        </p>
                        <ul className="dep-actions">
                            <li>
                                Open the converted VTK file
                                {this.lastVtkPath ? (
                                    <>
                                        {' '}
                                        (<code>{this.lastVtkPath}</code>)
                                    </>
                                ) : (
                                    ''
                                )}{' '}
                                in the generic VTK viewer (<strong>Visualizer</strong>) instead — it keeps the compatibility viewer for
                                files the native viewer cannot parse.
                            </li>
                        </ul>
                        <p className="dep-backend-error">
                            <span className="dep-backend-label">Parser error:</span> {this.error}
                        </p>
                        <button className="theia-button secondary" onClick={() => this.reload()}>
                            <i className={codicon('refresh')}></i>
                            Retry
                        </button>
                    </div>
                </div>
            );
        }
        return super.renderError();
    }

    protected renderPanel(): React.ReactNode {
        if (!this.data) {
            return undefined;
        }
        const meshIds = [...new Set(this.data.weightWindows.map((w) => w.meshId))].sort((a, b) => a - b);
        return (
            <div className="openmc-output-viewer-panel">
                <h4>Weight Windows</h4>
                {meshIds.length > 1 && (
                    <div className="openmc-output-viewer-card">
                        <div className="openmc-output-viewer-card-title">Mesh to display</div>
                        <select
                            value={this.selectedMeshId ?? meshIds[0]}
                            onChange={(e) => {
                                this.selectedMeshId = parseInt(e.target.value);
                                this.update();
                                void this.reload();
                            }}
                        >
                            {meshIds.map((id) => (
                                <option key={id} value={id}>
                                    Mesh {id} ({this.data!.weightWindows.filter((w) => w.meshId === id).length} window
                                    {this.data!.weightWindows.filter((w) => w.meshId === id).length === 1 ? '' : 's'})
                                </option>
                            ))}
                        </select>
                    </div>
                )}
                {this.data.meshes.map((mesh) => (
                    <div className="openmc-output-viewer-card" key={`mesh-${mesh.id}`}>
                        <div className="openmc-output-viewer-card-title">Mesh {mesh.id}</div>
                        <dl>
                            <dt>Type</dt>
                            <dd>{mesh.type}</dd>
                            {mesh.dimension && (
                                <>
                                    <dt>Dimensions</dt>
                                    <dd>{mesh.dimension.join(' × ')}</dd>
                                </>
                            )}
                            {mesh.lower_left && (
                                <>
                                    <dt>Lower left</dt>
                                    <dd>{mesh.lower_left.map((v) => v.toFixed(3)).join(', ')}</dd>
                                </>
                            )}
                            {mesh.upper_right && (
                                <>
                                    <dt>Upper right</dt>
                                    <dd>{mesh.upper_right.map((v) => v.toFixed(3)).join(', ')}</dd>
                                </>
                            )}
                        </dl>
                    </div>
                ))}
                {this.data.weightWindows.map((window) => (
                    <div className="openmc-output-viewer-card" key={`ww-${window.id}`}>
                        <div className="openmc-output-viewer-card-title">
                            Weight window {window.id} ({window.particleType})
                        </div>
                        <dl>
                            <dt>Mesh</dt>
                            <dd>{window.meshId}</dd>
                            <dt>Energy groups</dt>
                            <dd>{window.boundsShape[0]}</dd>
                            <dt>Energy bounds [eV]</dt>
                            <dd>
                                {window.energyBounds[0]?.toExponential(2)} –{' '}
                                {window.energyBounds[window.energyBounds.length - 1]?.toExponential(2)}
                            </dd>
                            <dt>Survival ratio</dt>
                            <dd>{window.survivalRatio}</dd>
                            <dt>Max split</dt>
                            <dd>{window.maxSplit}</dd>
                            <dt>Weight cutoff</dt>
                            <dd>{window.weightCutoff}</dd>
                        </dl>
                    </div>
                ))}
            </div>
        );
    }
}
