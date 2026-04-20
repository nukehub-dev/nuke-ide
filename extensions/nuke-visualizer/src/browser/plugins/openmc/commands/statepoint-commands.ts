// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandContribution } from '@theia/core/lib/common';
import { OpenMCCommands } from './index';
import { OpenMCContribution } from '../openmc-contribution';
import { OpenMCService } from '../openmc-service';

@injectable()
export class OpenMCStatepointCommands implements CommandContribution {
    @inject(OpenMCContribution)
    protected readonly contribution: OpenMCContribution;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.LOAD_STATEPOINT, {
            execute: () => this.contribution.loadStatepointCommand()
        });
        registry.registerCommand(OpenMCCommands.VISUALIZE_TALLY, {
            execute: () => this.contribution.visualizeTallyCommand(),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });
        registry.registerCommand(OpenMCCommands.VISUALIZE_SOURCE, {
            execute: () => this.contribution.visualizeSourceCommand()
        });
        registry.registerCommand(OpenMCCommands.SHOW_TALLY_INFO, {
            execute: () => this.contribution.showTallyInfoCommand(),
            isEnabled: () => this.openmcService.getCurrentStatepoint() !== null
        });
    }
}
