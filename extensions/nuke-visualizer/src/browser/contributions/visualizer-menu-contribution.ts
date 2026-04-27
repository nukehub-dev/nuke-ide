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
import { NukeVisualizerMenus } from '../contributions/visualizer-menus';
import {
    VisualizerCommand,
    VisualizerHealthCheckCommand,
    InstallBaseVisualizerCommand,
    InstallOpenMCCommand
} from '../commands/visualizer-commands';

@injectable()
export class VisualizerMenuContribution implements MenuContribution {
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerSubmenu(NukeVisualizerMenus.VISUALIZER, 'Visualizer');
        menus.registerMenuAction(NukeVisualizerMenus.VISUALIZER, {
            commandId: VisualizerCommand.id,
            label: VisualizerCommand.label,
            order: '0_main'
        });
        menus.registerSubmenu(NukeVisualizerMenus.ENVIRONMENT, 'Environment');
        menus.registerMenuAction(NukeVisualizerMenus.ENVIRONMENT, {
            commandId: VisualizerHealthCheckCommand.id,
            label: VisualizerHealthCheckCommand.label,
            order: 'a'
        });
        menus.registerMenuAction(NukeVisualizerMenus.ENVIRONMENT, {
            commandId: InstallBaseVisualizerCommand.id,
            label: InstallBaseVisualizerCommand.label,
            order: 'b'
        });
        menus.registerMenuAction(NukeVisualizerMenus.ENVIRONMENT, {
            commandId: InstallOpenMCCommand.id,
            label: InstallOpenMCCommand.label,
            order: 'c'
        });
    }
}
