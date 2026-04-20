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
export class OpenMCPlottingCommands implements CommandContribution {
    @inject(OpenMCContribution)
    protected readonly contribution: OpenMCContribution;

    @inject(OpenMCService)
    protected readonly openmcService: OpenMCService;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.PLOT_CROSS_SECTIONS, {
            execute: () => this.contribution.plotXSCommand()
        });
        registry.registerCommand(OpenMCCommands.OVERLAY_TALLY_ON_GEOMETRY, {
            execute: () => this.contribution.overlayTallyCommand()
        });
    }
}
