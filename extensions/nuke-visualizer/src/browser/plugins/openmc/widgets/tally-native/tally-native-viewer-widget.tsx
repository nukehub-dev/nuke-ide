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
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { NativeVtkViewerWidget } from '../native-vtk-viewer-widget';
import { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import {
    SliceAxis,
    TallyOverlayKind,
    classifyTallyOverlayDataset,
    defaultOverlayColorBy,
    describeTallyOverlayDataset,
    isTallyOverlayKind,
    pointSizeForKind
} from './tally-overlay-model';

/**
 * Native tally mesh/overlay/source viewer widget (P3-D2): renders the three
 * `tally_viz.py` dataset kinds (`openmc.visualize-mesh` full-3D grids,
 * `openmc.visualize-overlay` slice or full-3D tally-on-geometry,
 * `openmc.visualize-source` / statepoint-source point clouds) plus the
 * static `slice_viz.py` slice files (F9) on the P1 three.js viewer — VTK
 * bytes arrive through `FileService`, parsing and instant color-by are
 * inherited, and this subclass only adds kind-aware defaults (dataset
 * classification, per-kind point-size preset, kind-preferred color-by).
 * No server, no restart.
 *
 * This widget is intentionally NOT wired into any contribution yet: the
 * parent phase registers the opener, feeds it the converted VTK paths, and
 * calls `setTallyText` (or `setVtkFile` + `setTallyKind`) per dataset.
 */
@injectable()
export class TallyNativeViewerWidget extends NativeVtkViewerWidget {
    static override readonly ID: string = 'tally-native-viewer-widget';
    static override readonly LABEL: string = 'Native Tally Viewer';

    protected tallyKind: TallyOverlayKind = 'mesh';
    protected sliceAxis: SliceAxis | undefined;

    @postConstruct()
    protected override init(): void {
        this.id = TallyNativeViewerWidget.ID;
        this.title.label = TallyNativeViewerWidget.LABEL;
        this.title.iconClass = codicon('graph-scatter');
        this.title.closable = true;
        this.node.tabIndex = 0;
    }

    /** Current dataset kind driving defaults and the header badge. */
    getTallyKind(): TallyOverlayKind {
        return this.tallyKind;
    }

    /**
     * Switch the dataset kind: applies the per-kind point-size preset and,
     * when a dataset is already loaded, re-picks the kind-preferred default
     * color-by. Instant — no reload, no server restart.
     */
    setTallyKind(kind: TallyOverlayKind): void {
        if (!isTallyOverlayKind(kind)) {
            return;
        }
        this.tallyKind = kind;
        this.sliceAxis = undefined;
        const pointSize = pointSizeForKind(kind);
        if (this.model) {
            const result = classifyTallyOverlayDataset(this.currentArrayInfos(), this.model.family, this.model.gridDimensions);
            this.sliceAxis = result.sliceAxis;
            this.applyProps({ colorBy: result.colorBy, pointSize });
        } else {
            this.applyProps({ pointSize });
        }
        this.update();
    }

    /**
     * Load already-read VTK XML text as a known dataset kind: parses through
     * the P1 path, then applies the kind default color-by and point size.
     */
    async setTallyText(text: string, kind: TallyOverlayKind): Promise<void> {
        this.tallyKind = isTallyOverlayKind(kind) ? kind : 'overlay';
        await super.setVtkText(text);
        if (this.model) {
            const result = classifyTallyOverlayDataset(this.currentArrayInfos(), this.model.family, this.model.gridDimensions);
            // Keep the caller's kind (the file may predate the heuristic);
            // only the slice axis comes from the grid shape.
            this.sliceAxis = this.tallyKind === 'slice' && this.model.gridDimensions ? result.sliceAxis : undefined;
            this.applyProps({
                colorBy: defaultOverlayColorBy(this.tallyKind, result.classified, this.model.family),
                pointSize: pointSizeForKind(this.tallyKind)
            });
        }
        this.update();
    }

    private currentArrayInfos(): OpenMCVtkArrayInfo[] {
        if (!this.model) {
            return [];
        }
        return [...this.model.pointArrays, ...this.model.cellArrays].map((entry) => ({
            name: entry.name,
            association: entry.association,
            components: entry.components,
            range: entry.range as [number, number]
        }));
    }

    protected override renderHeader(): React.ReactNode {
        return (
            <>
                {super.renderHeader()}
                <Tooltip content={this.describeTallyKind()} position="bottom">
                    <span className="openmc-output-viewer-file" style={{ fontSize: '11px', opacity: 0.8 }}>
                        <i className={codicon('tag')}></i>
                        {this.tallyKind}
                        {this.sliceAxis ? ` ⟂ ${this.sliceAxis}` : ''}
                    </span>
                </Tooltip>
            </>
        );
    }

    private describeTallyKind(): string {
        if (!this.model) {
            return `Tally ${this.tallyKind} — no dataset loaded`;
        }
        return describeTallyOverlayDataset({
            kind: this.tallyKind,
            family: this.model.family,
            nPoints: this.model.nPoints,
            sliceAxis: this.sliceAxis,
            colorBy: this.colorBy
        });
    }
}
