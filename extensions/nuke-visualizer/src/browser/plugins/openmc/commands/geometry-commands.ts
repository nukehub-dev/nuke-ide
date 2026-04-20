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
export class OpenMCGeometryCommands implements CommandContribution {
    @inject(OpenMCContribution)
    protected readonly contribution: OpenMCContribution;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(OpenMCCommands.VIEW_GEOMETRY_HIERARCHY, {
            execute: () => this.contribution.viewGeometryHierarchyCommand()
        });
        registry.registerCommand(OpenMCCommands.CHECK_OVERLAPS, {
            execute: () => this.contribution.checkOverlapsCommand()
        });
        registry.registerCommand(OpenMCCommands.VIEW_MATERIALS, {
            execute: () => this.contribution.viewMaterialsCommand()
        });
    }
}
