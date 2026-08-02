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
            order: 'a',
            icon: 'pass',
            description: 'Run a health check on the visualizer environment.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.install-base',
            label: 'Install Base Dependencies',
            commandId: InstallBaseVisualizerCommand.id,
            category: ['Visualizer', 'Environment'],
            order: 'b',
            icon: 'package',
            description: 'Install base visualizer dependencies into the active environment.'
        });

        registry.registerItem({
            id: 'nuke-visualizer.install-openmc',
            label: 'Install OpenMC Dependencies',
            commandId: InstallOpenMCCommand.id,
            category: ['Visualizer', 'Environment'],
            order: 'c',
            icon: 'cloud-download',
            description: 'Install OpenMC-specific visualizer dependencies into the active environment.'
        });
    }
}
