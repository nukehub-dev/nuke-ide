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
