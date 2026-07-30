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
import { OpenMCTracksInfo, OpenMCVtkConversionResult } from '../../../../../common/openmc-protocol';
import { OpenMCOutputViewerWidget } from '../output-viewer-widget';

/** Particle filter options offered by the tracks viewer */
const PARTICLE_OPTIONS = ['', 'neutron', 'photon', 'electron', 'positron'] as const;

/**
 * Viewer for OpenMC particle track files (`tracks.h5` / `tracks_p<N>.h5`).
 * Renders track polylines through the trame/VTK pipeline (converted via
 * `openmc.tracks-vtk`) and shows a track metadata table below the 3D view.
 */
@injectable()
export class OpenMCTracksViewerWidget extends OpenMCOutputViewerWidget {
    static readonly ID = 'openmc-tracks-viewer-widget';
    static readonly LABEL = 'Tracks Viewer';

    protected particle = '';
    protected maxTracks = 500;
    protected tracksInfo: OpenMCTracksInfo | undefined;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCTracksViewerWidget.ID;
        this.title.label = OpenMCTracksViewerWidget.LABEL;
        this.title.iconClass = codicon('git-branch');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        super.setFile(uri, OpenMCTracksViewerWidget.ID, OpenMCTracksViewerWidget.LABEL);
    }

    protected convert(filePath: string): Promise<OpenMCVtkConversionResult> {
        return this.openmcBackend.convertTracksToVtk(filePath, {
            particle: this.particle || undefined,
            maxTracks: this.maxTracks,
            maxPoints: 500
        });
    }

    protected async loadPanelData(filePath: string): Promise<void> {
        this.tracksInfo = await this.openmcBackend.getTracksInfo(filePath);
    }

    protected renderControls(): React.ReactNode {
        return (
            <>
                <label className="openmc-output-viewer-control">
                    Particle
                    <select value={this.particle} onChange={(e) => this.setParticle(e.target.value)} disabled={this.isLoading}>
                        {PARTICLE_OPTIONS.map((p) => (
                            <option key={p} value={p}>
                                {p === '' ? 'All' : p}
                            </option>
                        ))}
                    </select>
                </label>
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
            </>
        );
    }

    protected setParticle(particle: string): void {
        this.particle = particle;
        this.update();
    }

    protected setMaxTracks(value: number): void {
        this.maxTracks = Number.isFinite(value) && value > 0 ? value : this.maxTracks;
        this.update();
    }

    protected renderViewerHint(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-hint">
                Color by particle type (cell data <code>pdg</code>) or energy (point data <code>energy</code>) via the viewer's Color By
                control.
            </div>
        );
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
