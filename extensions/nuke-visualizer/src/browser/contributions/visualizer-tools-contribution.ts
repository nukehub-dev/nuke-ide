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

/**
 * Nuke Visualizer Tools Contribution
 *
 * Registers Nuke Visualizer commands into the Nuke Tools sidebar.
 *
 * @module nuke-visualizer/browser/contributions
 */

import { injectable } from '@theia/core/shared/inversify';
import { NukeToolsContribution, NukeToolsRegistry } from 'nuke-core/lib/common/nuke-tools-protocol';
import {
    VisualizerCommand,
    VisualizerHealthCheckCommand,
    InstallBaseVisualizerCommand,
    InstallOpenMCCommand
} from '../commands/visualizer-commands';
import { OpenMCCommands } from '../plugins/openmc/commands';

@injectable()
export class VisualizerToolsContribution implements NukeToolsContribution {
    registerTools(registry: NukeToolsRegistry): void {
        registry.registerItem({
            id: 'nuke-visualizer.open',
            label: 'Open Visualizer',
            commandId: VisualizerCommand.id,
            category: ['Visualizer'],
            order: 'a',
            icon: 'graph',
            description: 'Open the Nuke Visualizer panel.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.health-check',
            label: 'Run Health Check',
            commandId: VisualizerHealthCheckCommand.id,
            category: ['Visualizer', 'Environment'],
            categoryOrder: 'z',
            order: 'a',
            icon: 'pass',
            description: 'Run a health check on the visualizer environment.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.install-base',
            label: 'Install Base Dependencies',
            commandId: InstallBaseVisualizerCommand.id,
            category: ['Visualizer', 'Environment'],
            categoryOrder: 'z',
            order: 'b',
            icon: 'package',
            description: 'Install base visualizer dependencies into the active environment.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.install-openmc',
            label: 'Install OpenMC Dependencies',
            commandId: InstallOpenMCCommand.id,
            category: ['Visualizer', 'Environment'],
            categoryOrder: 'z',
            order: 'c',
            icon: 'cloud-download',
            description: 'Install OpenMC-specific visualizer dependencies into the active environment.'
        });

        // OpenMC visualization widgets
        registry.registerItem({
            id: 'nuke-visualizer.openmc.statepoint',
            label: 'Load Statepoint...',
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            category: ['Visualizer', 'OpenMC', 'Statepoint'],
            categoryOrder: 'b',
            order: 'a',
            icon: 'database',
            description: 'Open an OpenMC statepoint file for inspection.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.tallies',
            label: 'Open Tallies',
            commandId: OpenMCCommands.OPEN_TALLIES.id,
            category: ['Visualizer', 'OpenMC', 'Tally'],
            categoryOrder: 'b',
            order: 'a',
            icon: 'list-tree',
            description: 'Open the OpenMC tallies panel.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.visualize-tally',
            label: 'Visualize Tally...',
            commandId: OpenMCCommands.VISUALIZE_TALLY.id,
            category: ['Visualizer', 'OpenMC', 'Tally'],
            categoryOrder: 'b',
            order: 'b',
            icon: 'graph',
            description: 'Visualize a selected OpenMC tally.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.visualize-source',
            label: 'Visualize Source Distribution...',
            commandId: OpenMCCommands.VISUALIZE_SOURCE.id,
            category: ['Visualizer', 'OpenMC', 'Tally'],
            categoryOrder: 'b',
            order: 'c',
            icon: 'activate-breakpoints',
            description: 'Visualize the OpenMC source distribution.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.overlay-tally',
            label: 'Overlay Tally on Geometry...',
            commandId: OpenMCCommands.OVERLAY_TALLY_ON_GEOMETRY.id,
            category: ['Visualizer', 'OpenMC', 'Tally'],
            categoryOrder: 'b',
            order: 'd',
            icon: 'layers',
            description: 'Overlay tally results onto geometry.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.show-tally-info',
            label: 'Show Tally Information',
            commandId: OpenMCCommands.SHOW_TALLY_INFO.id,
            category: ['Visualizer', 'OpenMC', 'Tally'],
            categoryOrder: 'b',
            order: 'e',
            icon: 'info',
            description: 'Show detailed information for a tally.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.geometry-hierarchy',
            label: 'View Geometry Hierarchy...',
            commandId: OpenMCCommands.VIEW_GEOMETRY_HIERARCHY.id,
            category: ['Visualizer', 'OpenMC', 'Geometry'],
            categoryOrder: 'b',
            order: 'a',
            icon: 'repo',
            description: 'Inspect the OpenMC geometry hierarchy.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.check-overlaps',
            label: 'Check Geometry Overlaps...',
            commandId: OpenMCCommands.CHECK_OVERLAPS.id,
            category: ['Visualizer', 'OpenMC', 'Geometry'],
            categoryOrder: 'b',
            order: 'b',
            icon: 'search',
            description: 'Check the OpenMC geometry for overlapping cells.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.view-materials',
            label: 'View Materials...',
            commandId: OpenMCCommands.VIEW_MATERIALS.id,
            category: ['Visualizer', 'OpenMC', 'Materials'],
            categoryOrder: 'b',
            order: 'a',
            icon: 'symbol-variable',
            description: 'Open the OpenMC materials explorer.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.nuclear-data',
            label: 'Nuclear Data',
            commandId: OpenMCCommands.OPEN_NUCLEAR_DATA.id,
            category: ['Visualizer', 'OpenMC', 'Materials'],
            categoryOrder: 'b',
            order: 'b',
            icon: 'database',
            description: 'Browse nuclear data libraries.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.plot-xs',
            label: 'Plot Cross-Sections',
            commandId: OpenMCCommands.PLOT_CROSS_SECTIONS.id,
            category: ['Visualizer', 'OpenMC', 'Plotting'],
            categoryOrder: 'b',
            order: 'a',
            icon: 'graph-line',
            description: 'Plot neutron cross-sections.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.depletion-viewer',
            label: 'View Depletion Results...',
            commandId: OpenMCCommands.OPEN_DEPLETION_VIEWER.id,
            category: ['Visualizer', 'OpenMC', 'Depletion'],
            categoryOrder: 'b',
            order: 'a',
            icon: 'flame',
            description: 'Open the OpenMC depletion results viewer.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.openmc.compare-depletion',
            label: 'Compare Depletion Results...',
            commandId: OpenMCCommands.COMPARE_DEPLETION.id,
            category: ['Visualizer', 'OpenMC', 'Depletion'],
            categoryOrder: 'b',
            order: 'b',
            icon: 'git-compare',
            description: 'Compare two OpenMC depletion result files.'
        });
    }
}
