// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandContribution } from '@theia/core/lib/common';
import { OpenMCCommands } from './index';
import { OpenMCContribution } from '../openmc-contribution';

@injectable()
export class OpenMCDepletionCommands implements CommandContribution {
    @inject(OpenMCContribution)
    protected readonly contribution: OpenMCContribution;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.OPEN_DEPLETION_VIEWER, {
            execute: () => this.contribution.openDepletionViewerCommand()
        });
        registry.registerCommand(OpenMCCommands.COMPARE_DEPLETION, {
            execute: () => this.contribution.compareDepletionCommand()
        });
        registry.registerCommand(OpenMCCommands.COMPARE_DEPLETION_WITH, {
            execute: (uri?: any) => this.contribution.compareDepletionWithCommand(uri)
        });
    }
}
