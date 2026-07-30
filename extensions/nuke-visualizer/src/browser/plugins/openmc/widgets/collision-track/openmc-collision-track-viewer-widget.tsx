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
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import URI from '@theia/core/lib/common/uri';
import { OpenMCCollisionTrackData, OpenMCVtkConversionResult } from '../../../../../common/openmc-protocol';
import { OpenMCOutputViewerWidget } from '../output-viewer-widget';

/** Collision sites converted for the 3D scatter (server-side cap) */
const SCATTER_LIMIT = 100000;

/**
 * Viewer for OpenMC collision track files (`collision_track.h5`). Shows a
 * paginated table of collision events (server-side filtered by event MT and
 * cell ID) plus a 3D scatter of the collision sites through the trame/VTK
 * pipeline (converted via `openmc.collision-vtk`).
 */
@injectable()
export class OpenMCCollisionTrackViewerWidget extends OpenMCOutputViewerWidget {
    static readonly ID = 'openmc-collision-track-viewer-widget';
    static readonly LABEL = 'Collision Track Viewer';

    protected mtInput = '';
    protected cellInput = '';
    protected offset = 0;
    protected pageSize = 100;
    protected data: OpenMCCollisionTrackData | undefined;
    protected filterError: string | undefined;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCCollisionTrackViewerWidget.ID;
        this.title.label = OpenMCCollisionTrackViewerWidget.LABEL;
        this.title.iconClass = codicon('pulse');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        super.setFile(uri, OpenMCCollisionTrackViewerWidget.ID, OpenMCCollisionTrackViewerWidget.LABEL);
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

    protected async loadPanelData(filePath: string): Promise<void> {
        this.data = await this.openmcBackend.getCollisionTrackData(filePath, {
            offset: this.offset,
            limit: this.pageSize,
            mt: this.mtFilter,
            cell: this.cellFilter
        });
    }

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
        await super.reload();
    }

    protected applyFilters(): void {
        this.offset = 0;
        this.reload();
    }

    protected turnPage(direction: 1 | -1): void {
        this.offset = Math.max(0, this.offset + direction * this.pageSize);
        this.reload();
    }

    protected renderControls(): React.ReactNode {
        return (
            <>
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
            </>
        );
    }

    protected renderViewerHint(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-hint">
                Collision sites as points — color by <code>energies</code> or <code>eventMt</code> via the viewer's Color By control.
            </div>
        );
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
