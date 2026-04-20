// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
