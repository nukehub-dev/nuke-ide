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
 * Nuke Core Tools Contribution
 *
 * Registers Nuke Core's own commands into the Nuke Tools sidebar.
 *
 * @module nuke-core/browser/tools-sidebar
 */

import { injectable } from '@theia/core/shared/inversify';
import { NukeToolsContribution, NukeToolsRegistry } from '../../common/nuke-tools-protocol';
import { NukeCoreCommands } from '../commands/nuke-core-commands';

@injectable()
export class NukeCoreToolsContribution implements NukeToolsContribution {
    registerTools(registry: NukeToolsRegistry): void {
        registry.registerItem({
            id: 'switchEnvironment',
            label: 'Switch Environment',
            commandId: NukeCoreCommands.SWITCH_ENVIRONMENT.id,
            category: ['Environment'],
            order: 'a',
            icon: 'server-environment',
            description: 'Switch the active Python environment used by Nuke.'
        });

        registry.registerItem({
            id: 'createEnvironment',
            label: 'Create Environment',
            commandId: NukeCoreCommands.CREATE_ENVIRONMENT.id,
            category: ['Environment'],
            order: 'b',
            icon: 'add',
            description: 'Create a new conda or virtualenv Python environment.'
        });

        registry.registerItem({
            id: 'environmentActions',
            label: 'Environment Actions',
            commandId: NukeCoreCommands.ENVIRONMENT_ACTIONS.id,
            category: ['Environment'],
            order: 'c',
            icon: 'list-unordered',
            description: 'Open the environment actions picker for an existing environment.'
        });

        registry.registerItem({
            id: 'deleteEnvironment',
            label: 'Delete Environment',
            commandId: NukeCoreCommands.DELETE_ENVIRONMENT.id,
            category: ['Environment'],
            order: 'd',
            icon: 'trash',
            description: 'Delete an existing Python environment with typed confirmation.'
        });

        registry.registerItem({
            id: 'installPackage',
            label: 'Install Package',
            commandId: NukeCoreCommands.INSTALL_PACKAGE.id,
            category: ['Packages'],
            order: 'a',
            icon: 'package',
            description: 'Install Python packages into the active environment with pip/uv or conda.'
        });

        registry.registerItem({
            id: 'healthCheck',
            label: 'Run Health Check',
            commandId: NukeCoreCommands.HEALTH_CHECK.id,
            category: ['Health & Diagnostics'],
            order: 'a',
            icon: 'pass',
            description: 'Run a full health check across Nuke Core subsystems.'
        });

        registry.registerItem({
            id: 'validateConfig',
            label: 'Validate Configuration',
            commandId: NukeCoreCommands.VALIDATE_CONFIG.id,
            category: ['Health & Diagnostics'],
            order: 'b',
            icon: 'checklist',
            description: 'Validate the current Nuke Core configuration and report errors or warnings.'
        });

        registry.registerItem({
            id: 'showDiagnostics',
            label: 'Show Diagnostics',
            commandId: NukeCoreCommands.DIAGNOSTICS.id,
            category: ['Health & Diagnostics'],
            order: 'c',
            icon: 'output',
            description: 'Display detailed runtime diagnostics in the output panel.'
        });
    }
}
