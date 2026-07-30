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
import { OpenMCWeightWindowsData, OpenMCVtkConversionResult } from '../../../../../common/openmc-protocol';
import { OpenMCOutputViewerWidget } from '../output-viewer-widget';

/**
 * Viewer for OpenMC weight window files (`weight_windows.h5`). Renders the
 * mesh with the lower/upper weight bounds as cell data through the trame/VTK
 * pipeline (converted via `openmc.weight-windows-vtk`): one array per
 * (bound, energy group) named `lower_g<i>` / `upper_g<i>`, so the viewer's
 * Color By control acts as the energy-group selector and lower/upper toggle.
 * A summary panel lists meshes and windows below the 3D view.
 */
@injectable()
export class OpenMCWeightWindowsViewerWidget extends OpenMCOutputViewerWidget {
    static readonly ID = 'openmc-weight-windows-viewer-widget';
    static readonly LABEL = 'Weight Windows Viewer';

    protected data: OpenMCWeightWindowsData | undefined;
    protected conversionArrays: string[] = [];

    @postConstruct()
    protected init(): void {
        this.id = OpenMCWeightWindowsViewerWidget.ID;
        this.title.label = OpenMCWeightWindowsViewerWidget.LABEL;
        this.title.iconClass = codicon('graph');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    setFile(uri: URI): void {
        super.setFile(uri, OpenMCWeightWindowsViewerWidget.ID, OpenMCWeightWindowsViewerWidget.LABEL);
    }

    protected async convert(filePath: string): Promise<OpenMCVtkConversionResult> {
        const result = await this.openmcBackend.convertWeightWindowsToVtk(filePath);
        const arrays = result.stats?.arrays;
        this.conversionArrays = Array.isArray(arrays) ? (arrays as string[]) : [];
        return result;
    }

    protected async loadPanelData(filePath: string): Promise<void> {
        this.data = await this.openmcBackend.getWeightWindows(filePath);
    }

    protected renderViewerHint(): React.ReactNode {
        return (
            <div className="openmc-output-viewer-hint">
                Energy group and bound selection: use the viewer's Color By control — <code>lower_g0…</code>/<code>upper_g0…</code> arrays,
                one per energy group. Switch Representation to Surface and enable the scalar bar for values.
            </div>
        );
    }

    protected renderPanel(): React.ReactNode {
        if (!this.data) {
            return undefined;
        }
        return (
            <div className="openmc-output-viewer-panel">
                <h4>Weight Windows</h4>
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
