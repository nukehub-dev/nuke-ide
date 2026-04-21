// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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

import { Command } from '@theia/core/lib/common';

export namespace OpenMCCommands {
    export const LOAD_STATEPOINT: Command = {
        id: 'openmc.load-statepoint',
        label: 'View Statepoint...',
        iconClass: 'codicon codicon-database'
    };
    export const VISUALIZE_TALLY: Command = {
        id: 'openmc.visualize-tally',
        label: 'Visualize Tally...',
        iconClass: 'codicon codicon-graph'
    };
    export const VISUALIZE_SOURCE: Command = {
        id: 'openmc.visualize-source',
        label: 'Visualize Source Distribution...',
        iconClass: 'codicon codicon-activate-breakpoints'
    };
    export const OVERLAY_TALLY_ON_GEOMETRY: Command = {
        id: 'openmc.overlay-tally',
        label: 'Overlay Tally on Geometry...',
        iconClass: 'codicon codicon-layers'
    };
    export const SHOW_TALLY_INFO: Command = {
        id: 'openmc.show-tally-info',
        label: 'Show Tally Information',
        iconClass: 'codicon codicon-info'
    };
    export const PLOT_CROSS_SECTIONS: Command = {
        id: 'openmc.plot-xs',
        label: 'Plot Cross-Sections',
        iconClass: 'codicon codicon-graph-line'
    };
    export const OPEN_DEPLETION_VIEWER: Command = {
        id: 'openmc.open-depletion',
        label: 'View Depletion Results...',
        iconClass: 'codicon codicon-flame'
    };
    export const COMPARE_DEPLETION: Command = {
        id: 'openmc.compare-depletion',
        label: 'Compare Depletion Results...',
        iconClass: 'codicon codicon-git-compare'
    };
    export const COMPARE_DEPLETION_WITH: Command = {
        id: 'openmc.compare-depletion-with',
        label: 'Compare Depletion Results',
        iconClass: 'codicon codicon-git-compare'
    };
    export const VIEW_GEOMETRY_HIERARCHY: Command = {
        id: 'openmc.view-geometry-hierarchy',
        label: 'View Geometry Hierarchy...',
        iconClass: 'codicon codicon-repo'
    };
    export const VIEW_MATERIALS: Command = {
        id: 'openmc.view-materials',
        label: 'View Materials...',
        iconClass: 'codicon codicon-symbol-variable'
    };
    export const CHECK_OVERLAPS: Command = {
        id: 'openmc.check-overlaps',
        label: 'Check Geometry Overlaps...',
        iconClass: 'codicon codicon-search'
    };
}
