// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
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
import { 
    EnvironmentCommands, 
    ProjectCommands, 
    SimulationCommands,
    ViewCommands 
} from '../commands';

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

    registerCommands(registry: CommandRegistry): void {
        // Register all command modules
        this.environmentCommands.registerCommands(registry);
        this.projectCommands.registerCommands(registry);
        this.simulationCommands.registerCommands(registry);
        this.viewCommands.registerCommands(registry);
    }
}
