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
import { OpenMCVtkConversionResult, OpenMCVtkFileInfo } from '../../../../../common/openmc-protocol';
import { OpenMCOutputViewerWidget } from '../output-viewer-widget';
import { ClassifiedVtkArrays, classifyVtkArrays, colorByValue, defaultColorBy } from './random-ray-arrays';

/** Extensions served directly (already VTK); .h5 goes through voxel conversion */
const DIRECT_VTK_EXTENSIONS = new Set(['.vtk', '.vti', '.vtr', '.vtp', '.vtu', '.vts']);

/**
 * Viewer for OpenMC random-ray results: multigroup voxel data (flux per
 * energy group, fission/external source, FSR/material maps) from legacy
 * `.vtk` random-ray outputs, `.vti` files, or voxel `.h5` plots (converted
 * via `openmc.voxel-vtk`).
 *
 * Renders through the standard trame/VTK pipeline (`base.serve`). The
 * quick-select bar drives the initial color-by of a freshly started server
 * (`base.serve --color-by`); changing the selection restarts the server —
 * there is no remote-control API into a running trame instance.
 */
@injectable()
export class OpenMCRandomRayResultsWidget extends OpenMCOutputViewerWidget {
    static readonly ID = 'openmc-random-ray-results-widget';
    static readonly LABEL = 'Random Ray Results';

    protected vtkInfo: OpenMCVtkFileInfo | undefined;
    protected classified: ClassifiedVtkArrays | undefined;
    protected selectedColorBy: string | undefined;
    protected restarting = false;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCRandomRayResultsWidget.ID;
        this.title.label = OpenMCRandomRayResultsWidget.LABEL;
        this.title.iconClass = codicon('symbol-misc');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        this.selectedColorBy = undefined;
        this.vtkInfo = undefined;
        this.classified = undefined;
        super.setFile(uri, OpenMCRandomRayResultsWidget.ID, OpenMCRandomRayResultsWidget.LABEL);
    }

    protected getColorBy(): string | undefined {
        return this.selectedColorBy;
    }

    protected convert(filePath: string): Promise<OpenMCVtkConversionResult> {
        const ext = this.fileUri?.path.ext.toLowerCase() ?? '';
        if (DIRECT_VTK_EXTENSIONS.has(ext)) {
            // Already VTK — serve the file itself, no conversion needed
            return Promise.resolve({ success: true, vtkPath: filePath });
        }
        if (ext === '.h5') {
            return this.openmcBackend.convertVoxelToVtk(filePath);
        }
        return Promise.resolve({ success: false, error: `Unsupported file type for random-ray results: ${ext || filePath}` });
    }

    protected async loadPanelData(): Promise<void> {
        if (!this.lastVtkPath) {
            return;
        }
        this.vtkInfo = await this.openmcBackend.getVtkInfo(this.lastVtkPath);
        this.classified = classifyVtkArrays(this.vtkInfo.arrays);
        // Default coloring: first flux group (or first available array)
        if (!this.selectedColorBy) {
            this.selectedColorBy = defaultColorBy(this.classified);
        }
    }

    protected async selectColorBy(value: string | undefined): Promise<void> {
        this.selectedColorBy = value;
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

    protected renderControls(): React.ReactNode {
        if (!this.classified) {
            return undefined;
        }
        const { fluxGroups, sources, ids } = this.classified;
        return (
            <>
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
            </>
        );
    }

    protected renderViewerHint(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-hint">
                Quick-select colors the voxel grid by array (restarts the viewer). Fine-tuning (color map, slicing, representation) is in
                the viewer's control panel.
            </div>
        );
    }

    protected renderPanel(): React.ReactNode {
        if (!this.vtkInfo) {
            return undefined;
        }
        const info = this.vtkInfo;
        return (
            <div className="openmc-output-viewer-panel">
                <h4>
                    {info.type} — {info.nCells.toLocaleString()} cells
                    {info.dimensions ? ` (grid ${info.dimensions.join(' × ')})` : ''}
                </h4>
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
                        {info.arrays.map((array) => (
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
