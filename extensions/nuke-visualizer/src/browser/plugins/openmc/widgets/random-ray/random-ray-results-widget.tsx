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
import {
    OpenMCBackendService,
    OpenMCVtkArrayInfo,
    OpenMCVtkConversionResult,
    OpenMCVtkFileInfo
} from '../../../../../common/openmc-protocol';
import { VisualizerBackendService } from '../../../../../common/base-visualizer-protocol';
import { toProxiedVisualizerUrl } from '../../../../visualizer-url';
import { NativeVtkViewerWidget } from '../native-vtk-viewer-widget';
import { parseNativeVtkXml } from '../native-vtk/native-vtk-data';
import { ClassifiedVtkArrays, classifyVtkArrays, colorByValue, defaultColorBy } from './random-ray-arrays';
import { detectMissingDependencies } from '../dependency-hints';
import { startSplitDrag } from '../drag-split';

/** Extensions served directly (already VTK); .h5 goes through voxel conversion */
const DIRECT_VTK_EXTENSIONS = new Set(['.vtk', '.vti', '.vtr', '.vtp', '.vtu', '.vts']);

/**
 * Viewer for OpenMC random-ray results: multigroup voxel data (flux per
 * energy group, fission/external source, FSR/material maps) from legacy
 * `.vtk` random-ray outputs, `.vti` files, or voxel `.h5` plots (converted
 * via `openmc.voxel-vtk`).
 *
 * Native-first: XML datasets load into the three.js viewer through
 * `FileService`, and the quick-select bar sets color-by instantly via
 * `applyProps` (no restart). Legacy ASCII `.vtk` outputs are XML-parser-only
 * in the native viewer, so when the native parse fails the widget falls back
 * to the old convert→serve→iframe path (`base.serve --color-by`, restart on
 * selection change) instead of extending the parser here.
 */
@injectable()
export class OpenMCRandomRayResultsWidget extends NativeVtkViewerWidget {
    static override readonly ID: string = 'openmc-random-ray-results-widget';
    static override readonly LABEL: string = 'Random Ray Results';

    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    @inject(VisualizerBackendService)
    protected readonly visualizerBackend!: VisualizerBackendService;

    /** The source file (the native base points at VTK; this stays on the source). */
    protected sourceUri: URI | undefined;
    /** VTK file currently loaded or served (set by reload after conversion). */
    protected lastVtkPath: string | undefined;
    /** Rendering path: native three.js, or the trame fallback for legacy files. */
    protected mode: 'native' | 'served' = 'native';
    protected serverUrl: string | undefined;
    protected serverPort: number | undefined;
    protected vtkInfo: OpenMCVtkFileInfo | undefined;
    /** Quick-select grouping (random-ray flux/source/id classes, separate from the base viewer's own classification). */
    protected quickSelect: ClassifiedVtkArrays | undefined;
    protected selectedColorBy: string | undefined;
    protected restarting = false;
    /** Panel height in px once the user drags the split (undefined = CSS default 40%). */
    protected panelHeight?: number;
    private reloadToken = 0;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCRandomRayResultsWidget.ID;
        this.title.label = OpenMCRandomRayResultsWidget.LABEL;
        this.title.iconClass = codicon('symbol-misc');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        this.sourceUri = uri;
        this.selectedColorBy = undefined;
        this.vtkInfo = undefined;
        this.quickSelect = undefined;
        this.mode = 'native';
        void this.stopFallbackServer();
        this.id = `${OpenMCRandomRayResultsWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${OpenMCRandomRayResultsWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${OpenMCRandomRayResultsWidget.LABEL}: ${uri.path.toString()}`;
        this.error = undefined;
        this.update();
        void this.reload();
    }

    /**
     * Header reload/retry buttons call `setVtkFile(this.fileUri)`; the file
     * URI stays on the source file, so route that back through a full
     * reconversion instead of parsing the source as VTK.
     */
    override async setVtkFile(uri: URI): Promise<void> {
        if (this.sourceUri && uri.path.toString() === this.sourceUri.path.toString()) {
            await this.reload();
            return;
        }
        await super.setVtkFile(uri);
    }

    /** Initial color-by for a freshly started fallback server. */
    protected getColorBy(): string | undefined {
        return this.selectedColorBy;
    }

    protected convert(filePath: string): Promise<OpenMCVtkConversionResult> {
        const ext = this.sourceUri?.path.ext.toLowerCase() ?? '';
        if (DIRECT_VTK_EXTENSIONS.has(ext)) {
            // Already VTK — serve the file itself, no conversion needed
            return Promise.resolve({ success: true, vtkPath: filePath });
        }
        if (ext === '.h5') {
            return this.openmcBackend.convertVoxelToVtk(filePath);
        }
        return Promise.resolve({ success: false, error: `Unsupported file type for random-ray results: ${ext || filePath}` });
    }

    /** (Re)run the conversion and load the result natively (or via the fallback server). */
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
            const result = await this.convert(filePath);
            if (token !== this.reloadToken) {
                return;
            }
            if (!result.success || !result.vtkPath) {
                throw new Error(result.error || 'Conversion failed');
            }
            this.lastVtkPath = result.vtkPath;

            this.statusMessage = 'Reading VTK file…';
            this.update();
            const content = await this.fileService.read(new URI(result.vtkPath));
            if (token !== this.reloadToken) {
                return;
            }
            // Probe the native XML reader first: legacy ASCII `.vtk` (and
            // other non-XML datasets) throw here and take the serve fallback
            // below — the native parser stays XML-only by design.
            let nativeText: string | undefined;
            try {
                await parseNativeVtkXml(content.value.toString());
                nativeText = content.value.toString();
            } catch (probeError) {
                console.warn(
                    `[random-ray] Native VTK parse failed for ${result.vtkPath}, falling back to the trame server:`,
                    probeError instanceof Error ? probeError.message : probeError
                );
            }
            if (token !== this.reloadToken) {
                return;
            }

            if (nativeText !== undefined) {
                await this.stopFallbackServer();
                if (token !== this.reloadToken) {
                    return;
                }
                this.mode = 'native';
                this.serverUrl = undefined;
                // setVtkText parses without touching fileUri/title, so the
                // header keeps showing the source file.
                this.fileUri = this.sourceUri;
                await this.setVtkText(nativeText);
                if (token !== this.reloadToken) {
                    return;
                }
                this.fileUri = this.sourceUri;
                const arrays = [...(this.model?.pointArrays ?? []), ...(this.model?.cellArrays ?? [])];
                this.quickSelect = classifyVtkArrays(arrays);
                if (!this.selectedColorBy) {
                    this.selectedColorBy = defaultColorBy(this.quickSelect);
                }
                if (this.selectedColorBy !== undefined) {
                    this.applyProps({ colorBy: this.selectedColorBy });
                }
                this.isLoading = false;
                this.statusMessage = '';
                this.update();
                return;
            }

            // Legacy path: inspect the file and serve it through base.serve.
            this.statusMessage = 'Loading data…';
            this.update();
            this.vtkInfo = await this.openmcBackend.getVtkInfo(result.vtkPath);
            if (token !== this.reloadToken) {
                return;
            }
            this.quickSelect = classifyVtkArrays(this.vtkInfo.arrays);
            if (!this.selectedColorBy) {
                this.selectedColorBy = defaultColorBy(this.quickSelect);
            }
            this.statusMessage = 'Starting viewer…';
            this.update();
            await this.restartServer(result.vtkPath);
            if (token !== this.reloadToken) {
                return;
            }
            this.mode = 'served';
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

    protected async restartServer(vtkPath: string): Promise<void> {
        await this.stopFallbackServer();
        const info = await this.visualizerBackend.startServer(vtkPath, undefined, undefined, this.getColorBy());
        this.lastVtkPath = vtkPath;
        this.serverPort = info.port;
        this.serverUrl = toProxiedVisualizerUrl(info.url);
    }

    /** Restart the fallback trame server for the current VTK file (e.g. after a color-by change). */
    protected async refreshServer(): Promise<void> {
        if (this.lastVtkPath) {
            await this.restartServer(this.lastVtkPath);
            this.update();
        }
    }

    protected async stopFallbackServer(): Promise<void> {
        if (this.serverPort !== undefined) {
            try {
                await this.visualizerBackend.stopServer(this.serverPort);
            } catch {
                // best effort — the process may already be gone
            }
            this.serverPort = undefined;
            this.serverUrl = undefined;
        }
    }

    override dispose(): void {
        this.reloadToken++;
        if (this.serverPort !== undefined) {
            this.visualizerBackend.stopServer(this.serverPort).catch(() => undefined);
            this.serverPort = undefined;
        }
        super.dispose();
    }

    protected async selectColorBy(value: string | undefined): Promise<void> {
        this.selectedColorBy = value;
        if (this.mode === 'native') {
            // Instant: rewrite the color buffer, no server involved.
            if (value !== undefined) {
                this.applyProps({ colorBy: value });
            }
            this.update();
            return;
        }
        this.restarting = true;
        this.update();
        try {
            await this.refreshServer();
        } catch (error) {
            this.messageService.error(`Failed to restart viewer: ${error instanceof Error ? error.message : error}`);
        }
        this.restarting = false;
        this.update();
    }

    protected override renderHeader(): React.ReactNode {
        return (
            <>
                {super.renderHeader()}
                {this.renderQuickSelect()}
            </>
        );
    }

    /** Array quick-select bar: instant color-by on the native path, server restart on the legacy fallback. */
    protected renderQuickSelect(): React.ReactNode {
        if (!this.quickSelect) {
            return undefined;
        }
        const { fluxGroups, sources, ids } = this.quickSelect;
        return (
            <div
                className="openmc-output-viewer-header"
                title={this.mode === 'native' ? 'Quick-select colors the grid instantly' : 'Quick-select restarts the legacy viewer'}
            >
                {fluxGroups.length > 0 && (
                    <label className="openmc-output-viewer-control">
                        Flux group
                        <select
                            value={this.selectedColorBy ?? ''}
                            onChange={(e) => this.selectColorBy(e.target.value || undefined)}
                            disabled={this.isLoading || this.restarting}
                        >
                            {fluxGroups.map((array) => (
                                <option key={array.name} value={colorByValue(array)}>
                                    {array.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {sources.map((array) => (
                    <button
                        key={array.name}
                        className={`theia-button${this.selectedColorBy === colorByValue(array) ? '' : ' secondary'}`}
                        onClick={() => this.selectColorBy(colorByValue(array))}
                        disabled={this.isLoading || this.restarting}
                    >
                        {array.name}
                    </button>
                ))}
                {ids.map((array) => (
                    <button
                        key={array.name}
                        className={`theia-button${this.selectedColorBy === colorByValue(array) ? '' : ' secondary'}`}
                        onClick={() => this.selectColorBy(colorByValue(array))}
                        disabled={this.isLoading || this.restarting}
                    >
                        {array.name}
                    </button>
                ))}
                <button
                    className={`theia-button${this.selectedColorBy === 'Solid Color' ? '' : ' secondary'}`}
                    onClick={() => this.selectColorBy('Solid Color')}
                    disabled={this.isLoading || this.restarting}
                >
                    Solid
                </button>
            </div>
        );
    }

    protected override renderContent(): React.ReactNode {
        if (this.mode === 'served') {
            return this.renderServedContent();
        }
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

    /** Legacy fallback content: trame iframe plus the array panel. */
    protected renderServedContent(): React.ReactNode {
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
                    <div className="openmc-output-viewer-hint">
                        Legacy VTK file — served through the compatibility viewer. Quick-select colors the voxel grid by array (restarts the
                        viewer). Fine-tuning (color map, slicing, representation) is in the viewer&apos;s control panel.
                    </div>
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
        return super.renderError();
    }

    protected renderPanel(): React.ReactNode {
        if (this.mode === 'native' && this.model) {
            const model = this.model;
            const arrays = [...model.pointArrays, ...model.cellArrays];
            const kind = model.family === 'rectilinear' ? 'RectilinearGrid' : model.family === 'image' ? 'ImageData' : 'PolyData';
            const count =
                model.family === 'polydata' ? `${model.nPoints.toLocaleString()} points` : `${model.nPoints.toLocaleString()} cells`;
            const grid = model.gridDimensions ? ` (grid ${model.gridDimensions.join(' × ')})` : '';
            return this.renderArrayTable(arrays, `${kind} — ${count}${grid}`);
        }
        if (this.vtkInfo) {
            const info = this.vtkInfo;
            const grid = info.dimensions ? ` (grid ${info.dimensions.join(' × ')})` : '';
            return this.renderArrayTable(info.arrays, `${info.type} — ${info.nCells.toLocaleString()} cells${grid}`);
        }
        return undefined;
    }

    protected renderArrayTable(arrays: OpenMCVtkArrayInfo[], title: string): React.ReactNode {
        return (
            <div className="openmc-output-viewer-panel">
                <h4>{title}</h4>
                <table className="openmc-output-viewer-table">
                    <thead>
                        <tr>
                            <th>Array</th>
                            <th>Association</th>
                            <th>Components</th>
                            <th>Range</th>
                        </tr>
                    </thead>
                    <tbody>
                        {arrays.map((array) => (
                            <tr key={`${array.association}-${array.name}`}>
                                <td>{array.name}</td>
                                <td>{array.association}</td>
                                <td>{array.components}</td>
                                <td>
                                    {array.range[0].toExponential(3)} – {array.range[1].toExponential(3)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }
}
