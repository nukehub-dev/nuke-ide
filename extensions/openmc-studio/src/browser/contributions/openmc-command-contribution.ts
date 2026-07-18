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
 * OpenMC Command Contribution
 *
 * Aggregates all command modules and registers them.
 *
 * @module openmc-studio/browser/contributions
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { EnvironmentCommands, ProjectCommands, SimulationCommands, ViewCommands } from '../commands';

/**
 * Aggregates all OpenMC command modules and registers them with the Theia command registry.
 *
 * Binds to {@link CommandContribution} in the frontend module to activate command registration.
 * Delegates to specialized command classes for each domain (environment, project, simulation, view).
 *
 * @see {@link openmc-command-contribution.ts} for menu bindings
 * @see {@link OpenMCMenus} for associated menu paths
 */
@injectable()
export class OpenMCCommandContribution implements CommandContribution {
    @inject(EnvironmentCommands)
    protected readonly environmentCommands: EnvironmentCommands;

    @inject(ProjectCommands)
    protected readonly projectCommands: ProjectCommands;

    @inject(SimulationCommands)
    protected readonly simulationCommands: SimulationCommands;

    @inject(ViewCommands)
    protected readonly viewCommands: ViewCommands;

    /**
     * Register all OpenMC commands by delegating to domain-specific command modules.
     * @param registry - The Theia command registry
     * @see {@link EnvironmentCommands}
     * @see {@link ProjectCommands}
     * @see {@link SimulationCommands}
     * @see {@link ViewCommands}
     */
    registerCommands(registry: CommandRegistry): void {
        // Register all command modules
        this.environmentCommands.registerCommands(registry);
        this.projectCommands.registerCommands(registry);
        this.simulationCommands.registerCommands(registry);
        this.viewCommands.registerCommands(registry);
    }
}
