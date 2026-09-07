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
import { OpenMCBackendService, OpenMCCollisionTrackData, OpenMCVtkConversionResult } from '../../../../../common/openmc-protocol';
import { NativeVtkViewerWidget } from '../native-vtk-viewer-widget';
import { parseNativeVtkXml, readVtkText } from '../native-vtk/native-vtk-data';
import { detectMissingDependencies } from '../dependency-hints';
import { startSplitDrag } from '../drag-split';

/** Collision sites converted for the 3D scatter (server-side cap) */
const SCATTER_LIMIT = 100000;

/**
 * Viewer for OpenMC collision track files (`collision_track.h5`). Shows a
 * paginated table of collision events (server-side filtered by event MT and
 * cell ID) plus a 3D scatter of the collision sites rendered natively with
 * three.js — color-by switches apply instantly with no server restart.
 *
 * Files the native XML parser cannot read render an actionable error panel
 * (open the converted VTK in the generic VTK viewer instead) — there is no
 * serve fallback.
 */
@injectable()
export class OpenMCCollisionTrackViewerWidget extends NativeVtkViewerWidget {
    static override readonly ID: string = 'openmc-collision-track-viewer-widget';
    static override readonly LABEL: string = 'Collision Track Viewer';

    @inject(OpenMCBackendService)
    protected readonly openmcBackend!: OpenMCBackendService;

    /** The source `collision_track.h5` file (the native base points at VTK; this stays on the source). */
    protected sourceUri: URI | undefined;
    /** VTK file produced by the last conversion (set by reload). */
    protected lastVtkPath: string | undefined;

    protected mtInput = '';
    protected cellInput = '';
    protected offset = 0;
    protected pageSize = 100;
    protected data: OpenMCCollisionTrackData | undefined;
    protected filterError: string | undefined;
    /** Panel height in px once the user drags the split (undefined = CSS default 40%). */
    protected panelHeight?: number;
    private reloadToken = 0;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCCollisionTrackViewerWidget.ID;
        this.title.label = OpenMCCollisionTrackViewerWidget.LABEL;
        this.title.iconClass = codicon('pulse');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        this.sourceUri = uri;
        this.data = undefined;
        this.filterError = undefined;
        this.id = `${OpenMCCollisionTrackViewerWidget.ID}:${uri.path.toString()}`;
        this.title.label = `${OpenMCCollisionTrackViewerWidget.LABEL}: ${uri.path.base}`;
        this.title.caption = `${OpenMCCollisionTrackViewerWidget.LABEL}: ${uri.path.toString()}`;
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

    /** Parse a comma-separated integer list; returns undefined when empty. */
    protected parseIntList(input: string, label: string): number[] | undefined {
        const trimmed = input.trim();
        if (!trimmed) {
            return undefined;
        }
        const values = trimmed.split(',').map((v) => Number(v.trim()));
        if (values.some((v) => !Number.isInteger(v))) {
            throw new Error(`Invalid ${label} list: ${input}`);
        }
        return values;
    }

    protected get mtFilter(): number[] | undefined {
        return this.parseIntList(this.mtInput, 'MT');
    }

    protected get cellFilter(): number[] | undefined {
        return this.parseIntList(this.cellInput, 'cell');
    }

    protected convert(filePath: string): Promise<OpenMCVtkConversionResult> {
        return this.openmcBackend.convertCollisionTrackToVtk(filePath, {
            mt: this.mtFilter,
            cell: this.cellFilter,
            limit: SCATTER_LIMIT
        });
    }

    /** (Re)run the conversion and load the result natively. */
    async reload(): Promise<void> {
        try {
            this.filterError = undefined;
            // validate filter inputs before touching the backend
            void this.mtFilter;
            void this.cellFilter;
        } catch (error) {
            this.filterError = error instanceof Error ? error.message : String(error);
            this.update();
            return;
        }
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
            this.data = await this.openmcBackend.getCollisionTrackData(filePath, {
                offset: this.offset,
                limit: this.pageSize,
                mt: this.mtFilter,
                cell: this.cellFilter
            });
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
                    `Collision track file not supported by the native viewer: ${detail}. ` +
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

    protected applyFilters(): void {
        this.offset = 0;
        this.reload();
    }

    protected turnPage(direction: 1 | -1): void {
        this.offset = Math.max(0, this.offset + direction * this.pageSize);
        this.reload();
    }

    protected override renderHeader(): React.ReactNode {
        return (
            <>
                {super.renderHeader()}
                {this.renderFilterBar()}
            </>
        );
    }

    /** MT / cell filters: Apply re-runs the conversion. */
    protected renderFilterBar(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-header">
                <label className="openmc-output-viewer-control">
                    MT
                    <input
                        type="text"
                        placeholder="e.g. 2,18,102"
                        value={this.mtInput}
                        onChange={(e) => {
                            this.mtInput = e.target.value;
                            this.update();
                        }}
                        disabled={this.isLoading}
                    />
                </label>
                <label className="openmc-output-viewer-control">
                    Cell
                    <input
                        type="text"
                        placeholder="e.g. 1,2"
                        value={this.cellInput}
                        onChange={(e) => {
                            this.cellInput = e.target.value;
                            this.update();
                        }}
                        disabled={this.isLoading}
                    />
                </label>
                <button className="theia-button" onClick={() => this.applyFilters()} disabled={this.isLoading}>
                    Apply
                </button>
                {this.filterError && <span className="openmc-output-viewer-control">{this.filterError}</span>}
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
                            This collision track file cannot be displayed by the native 3D viewer — only the XML VTK datasets the converter
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
        const { collisions, matchedCollisions, totalCollisions, offset } = this.data;
        const rows = collisions.eventMt.length;
        return (
            <div className="openmc-output-viewer-panel">
                <h4>
                    Collisions: {matchedCollisions.toLocaleString()} matched of {totalCollisions.toLocaleString()}
                </h4>
                <table className="openmc-output-viewer-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Position [cm]</th>
                            <th>E [eV]</th>
                            <th>dE [eV]</th>
                            <th>Time [s]</th>
                            <th>Wgt</th>
                            <th>MT</th>
                            <th>Cell</th>
                            <th>Nuclide</th>
                            <th>Material</th>
                        </tr>
                    </thead>
                    <tbody>
                        {collisions.eventMt.map((mt, i) => (
                            <tr key={offset + i}>
                                <td>{offset + i}</td>
                                <td>{collisions.positions[i]?.map((v) => v.toFixed(3)).join(', ')}</td>
                                <td>{collisions.energies[i]?.toExponential(3)}</td>
                                <td>{collisions.energyLosses[i]?.toExponential(3)}</td>
                                <td>{collisions.times[i]?.toExponential(3)}</td>
                                <td>{collisions.weights[i]?.toFixed(3)}</td>
                                <td>{mt}</td>
                                <td>{collisions.cellIds[i]}</td>
                                <td>{collisions.nuclideIds[i]}</td>
                                <td>{collisions.materialIds[i]}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <div className="openmc-output-viewer-pager">
                    <button className="theia-button secondary" onClick={() => this.turnPage(-1)} disabled={this.isLoading || offset === 0}>
                        Previous
                    </button>
                    <span>
                        {offset}–{offset + rows} of {matchedCollisions.toLocaleString()}
                    </span>
                    <button
                        className="theia-button secondary"
                        onClick={() => this.turnPage(1)}
                        disabled={this.isLoading || offset + rows >= matchedCollisions}
                    >
                        Next
                    </button>
                </div>
            </div>
        );
    }
}
