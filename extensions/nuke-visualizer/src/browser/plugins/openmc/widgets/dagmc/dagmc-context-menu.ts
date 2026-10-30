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

/**
 * DAGMC canvas context-menu model.
 *
 * The shared viewer menu covers view actions; DAGMC adds the selection-aware
 * volume actions already present in the bottom bar and outline, so a
 * right-click on a selected volume can hide/isolate it without leaving the
 * canvas. Pure and vitest-covered.
 *
 * @module nuke-visualizer/browser/plugins/openmc/widgets/dagmc
 */

import {
    buildViewerContextMenuItems,
    type ViewerContextMenuItem,
    type ViewerContextMenuState
} from '../../../../viewer-core/viewer-context-menu';

export interface DagmcContextMenuState extends ViewerContextMenuState {
    readonly selectedVolumeId: number | null;
    /** True when any volume, material, or group is currently hidden. */
    readonly hasHiddenVolumes: boolean;
}

/**
 * Standard view actions plus the DAGMC selection group. The selection group
 * sits before the shading rows (after Fit/Screenshot/Clip) so it stays near
 * the visibility controls; disabled rows still explain the missing selection
 * through their labels.
 */
export function buildDagmcContextMenuItems(state: DagmcContextMenuState): ViewerContextMenuItem[] {
    const selected = state.selectedVolumeId;
    const items = buildViewerContextMenuItems(state);
    const selectionItems: ViewerContextMenuItem[] = [
        {
            id: 'hide-volume',
            label: selected === null ? 'Hide Volume' : `Hide Volume ${selected}`,
            icon: 'codicon-eye-closed',
            separatorAbove: true,
            disabled: selected === null
        },
        {
            id: 'isolate-volume',
            label: selected === null ? 'Isolate Volume' : `Isolate Volume ${selected}`,
            icon: 'codicon-eye',
            disabled: selected === null
        },
        {
            id: 'show-all-volumes',
            label: 'Show All Volumes',
            icon: 'codicon-eye-watch',
            disabled: !state.hasHiddenVolumes
        }
    ];
    const firstShading = items.findIndex((item) => item.id.startsWith('shading:'));
    items.splice(firstShading < 0 ? items.length : firstShading, 0, ...selectionItems);
    return items;
}
