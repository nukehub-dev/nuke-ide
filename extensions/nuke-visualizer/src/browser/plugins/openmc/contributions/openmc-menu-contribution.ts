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

import { injectable } from '@theia/core/shared/inversify';
import { MenuModelRegistry, MenuContribution } from '@theia/core/lib/common';
import { NukeVisualizerMenus } from '../../../contributions/visualizer-menus';
import { OpenMCCommands } from '../commands';

@injectable()
export class OpenMCMenuContribution implements MenuContribution {
    registerMenus(registry: MenuModelRegistry): void {
        registry.registerSubmenu(NukeVisualizerMenus.OPENMC, 'OpenMC');

        registry.registerSubmenu(NukeVisualizerMenus.OPENMC_STATEPOINT, 'Statepoint');
        registry.registerSubmenu(NukeVisualizerMenus.OPENMC_TALLY, 'Tally');
        registry.registerSubmenu(NukeVisualizerMenus.OPENMC_DEPLETION, 'Depletion');
        registry.registerSubmenu(NukeVisualizerMenus.OPENMC_GEOMETRY, 'Geometry');
        registry.registerSubmenu(NukeVisualizerMenus.OPENMC_MATERIAL, 'Materials');
        registry.registerSubmenu(NukeVisualizerMenus.OPENMC_PLOT, 'Plotting');

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_STATEPOINT, {
            commandId: OpenMCCommands.LOAD_STATEPOINT.id,
            order: 'a'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_TALLY, {
            commandId: OpenMCCommands.VISUALIZE_TALLY.id,
            order: 'a'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_TALLY, {
            commandId: OpenMCCommands.VISUALIZE_SOURCE.id,
            order: 'b'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_TALLY, {
            commandId: OpenMCCommands.OVERLAY_TALLY_ON_GEOMETRY.id,
            order: 'c'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_TALLY, {
            commandId: OpenMCCommands.SHOW_TALLY_INFO.id,
            order: 'd'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_DEPLETION, {
            commandId: OpenMCCommands.OPEN_DEPLETION_VIEWER.id,
            order: 'a'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_DEPLETION, {
            commandId: OpenMCCommands.COMPARE_DEPLETION.id,
            order: 'b'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_GEOMETRY, {
            commandId: OpenMCCommands.VIEW_GEOMETRY_HIERARCHY.id,
            order: 'a'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_GEOMETRY, {
            commandId: OpenMCCommands.CHECK_OVERLAPS.id,
            order: 'b'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_MATERIAL, {
            commandId: OpenMCCommands.VIEW_MATERIALS.id,
            order: 'a'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_PLOT, {
            commandId: OpenMCCommands.PLOT_CROSS_SECTIONS.id,
            order: 'a'
        });

        registry.registerMenuAction(NukeVisualizerMenus.OPENMC_TALLY, {
            commandId: OpenMCCommands.OPEN_TALLIES.id,
            order: 'e'
        });
    }
}
