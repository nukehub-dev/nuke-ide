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
import { OpenMCBackendService, OpenMCTracksInfo, OpenMCVtkConversionResult } from '../../../../../common/openmc-protocol';
import { NativeVtkViewerWidget } from '../native-vtk-viewer-widget';
import { parseNativeVtkXml, readVtkText } from '../native-vtk/native-vtk-data';
import { detectMissingDependencies } from '../dependency-hints';
import { startSplitDrag } from '../drag-split';
import { NukeSelect } from 'nuke-essentials/lib/theme/browser/components';

/** Particle filter options offered by the tracks viewer */
const PARTICLE_OPTIONS = ['', 'neutron', 'photon', 'electron', 'positron'] as const;

/**
 * Viewer for OpenMC particle track files (`tracks.h5` / `tracks_p<N>.h5`).
 * Converts track polylines via `openmc.tracks-vtk` and renders the `.vtp`
 * natively with three.js — color-by switches apply instantly with no server
 * restart. A track metadata table sits below the 3D view.
 *
 * Files the native XML parser cannot read render an actionable error panel
 * (open the converted VTK in the generic VTK viewer instead) — there is no
 * serve fallback.
 */
@injectable()
export class OpenMCTracksViewerWidget extends NativeVtkViewerWidget {
    static override readonly ID: string = 'openmc-tracks-viewer-widget';
    static override readonly LABEL: string = 'Tracks Viewer';

    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    /** The source `tracks.h5` file (the native base points at VTK; this stays on the source). */
    protected sourceUri: URI | undefined;
    /** VTK file produced by the last conversion (set by reload). */
    protected lastVtkPath: string | undefined;

    protected particle = '';
    protected maxTracks = 500;
    protected tracksInfo: OpenMCTracksInfo | undefined;
    /** Panel height in px once the user drags the split (undefined = CSS default 40%). */
    protected panelHeight?: number;
    private reloadToken = 0;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCTracksViewerWidget.ID;
        this.title.label = OpenMCTracksViewerWidget.LABEL;
        this.title.iconClass = codicon('git-branch');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        this.sourceUri = uri;
        this.tracksInfo = undefined;
        this.id = `${OpenMCTracksViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${OpenMCTracksViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${OpenMCTracksViewerWidget.LABEL}: ${uri.path.toString()}`;
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

    protected convert(filePath: string): Promise<OpenMCVtkConversionResult> {
        return this.openmcBackend.convertTracksToVtk(filePath, {
            particle: this.particle || undefined,
            maxTracks: this.maxTracks,
            maxPoints: 500
        });
    }

    /** (Re)run the conversion and load the result natively. */
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

            this.statusMessage = 'Loading data…';
            this.update();
            this.tracksInfo = await this.openmcBackend.getTracksInfo(filePath);
            if (token !== this.reloadToken) {
                return;
            }

            this.statusMessage = 'Reading VTK file…';
            this.update();
            const text = await readVtkText(this.fileService, new URI(result.vtkPath));
            if (token !== this.reloadToken) {
                return;
            }
            // Probe the native XML reader: the native parser stays XML-only
            // by design, so an unparseable file is an actionable error
            // (open the converted VTK in the generic VTK viewer instead).
            let nativeText: string;
            try {
                await parseNativeVtkXml(text);
                nativeText = text;
            } catch (probeError) {
                const detail = probeError instanceof Error ? probeError.message : String(probeError);
                throw new Error(
                    `Tracks file not supported by the native viewer: ${detail}. ` +
                        'Open the converted VTK file in the generic VTK viewer (Visualizer) instead.'
                );
            }
            if (token !== this.reloadToken) {
                return;
            }

            this.fileUri = this.sourceUri;
            // setVtkText parses without touching fileUri/title, so the
            // header keeps showing the source file.
            await this.setVtkText(nativeText);
            if (token !== this.reloadToken) {
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

    override dispose(): void {
        this.reloadToken++;
        super.dispose();
    }

    protected setParticle(particle: string): void {
        this.particle = particle;
        this.update();
    }

    protected setMaxTracks(value: number): void {
        this.maxTracks = Number.isFinite(value) && value > 0 ? value : this.maxTracks;
        this.update();
    }

    protected override renderHeader(): React.ReactNode {
        return (
            <>
                {super.renderHeader()}
                {this.renderFilterBar()}
            </>
        );
    }

    /** Particle / max-tracks filters: Apply re-runs the conversion. */
    protected renderFilterBar(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-header">
                <div className="openmc-output-viewer-control">
                    Particle
                    <NukeSelect
                        ariaLabel="Particle type filter"
                        value={this.particle}
                        options={PARTICLE_OPTIONS.map((p) => ({ value: p, label: p === '' ? 'All' : p }))}
                        onChange={(value) => this.setParticle(value)}
                        disabled={this.isLoading}
                    />
                </div>
                <label className="openmc-output-viewer-control">
                    Max tracks
                    <input
                        type="number"
                        min={1}
                        value={this.maxTracks}
                        onChange={(e) => this.setMaxTracks(parseInt(e.target.value, 10))}
                        disabled={this.isLoading}
                    />
                </label>
                <button className="theia-button" onClick={() => this.reload()} disabled={this.isLoading}>
                    Apply
                </button>
            </div>
        );
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
                            This tracks file cannot be displayed by the native 3D viewer — only the XML VTK datasets the converter produces
                            are supported here.
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
        if (!this.tracksInfo) {
            return undefined;
        }
        const rows = this.tracksInfo.tracks.slice(0, 200);
        return (
            <div className="openmc-output-viewer-panel">
                <h4>
                    Tracks: {this.tracksInfo.nTracks} ({this.tracksInfo.totalStates} states total)
                    {this.tracksInfo.files.length > 1 ? ` — combined from ${this.tracksInfo.files.length} files` : ''}
                </h4>
                <table className="openmc-output-viewer-table">
                    <thead>
                        <tr>
                            <th>Batch</th>
                            <th>Gen</th>
                            <th>Particle ID</th>
                            <th>Particles</th>
                            <th>States</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((track) => (
                            <tr key={track.dataset}>
                                <td>{track.batch}</td>
                                <td>{track.generation}</td>
                                <td>{track.particleId}</td>
                                <td>{track.segments.map((s) => `${s.particle} (${s.nStates})`).join(', ')}</td>
                                <td>{track.nStates}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {this.tracksInfo.tracks.length > rows.length && (
                    <div className="openmc-output-viewer-pager">Showing first {rows.length} tracks</div>
                )}
            </div>
        );
    }
}
