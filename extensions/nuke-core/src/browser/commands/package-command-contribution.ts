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
 * Package Command Contribution
 *
 * Registers the Install Package command and menu item, allowing users
 * to install Python packages into the active environment via pip/uv or conda.
 *
 * DI bindings:
 * - {@link NukeCoreService} – backend package queries
 * - {@link MessageService} – user-facing toast notifications
 * - {@link QuickPickService} – quick-pick UI for package manager selection
 * - {@link QuickInputService} – text input prompt for package name(s)
 * - {@link EnvironmentActionsHelper} – shared package installation utilities
 *
 * @see {@link NukeCoreCommands}
 *
 * @module nuke-core/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService, QuickInputService } from '@theia/core/lib/browser/quick-input';
import { EnvironmentActionsHelper, NukeCoreService } from '../services';
import { NukeCoreCommands } from './index';
import { NukeMenus } from '../nuke-core-menus';

@injectable()
export class NukePackageCommandContribution implements CommandContribution, MenuContribution {

    @inject(NukeCoreService)
    protected readonly nukeCore: NukeCoreService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(QuickPickService)
    protected readonly quickPick: QuickPickService;

    @inject(QuickInputService)
    protected readonly quickInput: QuickInputService;

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    /**
     * Registers the Install Package command with the application command registry.
     *
     * @param commands - Theia command registry to register against.
     */
    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeCoreCommands.INSTALL_PACKAGE, {
            execute: () => this.installPackage()
        });
    }

    /**
     * Adds the Install Package command to the Nuke Tools menu.
     *
     * @param menus - Theia menu model registry.
     */
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.INSTALL_PACKAGE.id,
            label: 'Install Package',
            order: 'b'
        });
    }

    /**
     * Interactive workflow to install Python packages.
     * Prompts for package name(s), then asks whether to use pip/uv or conda/mamba.
     *
     * @returns Resolves when installation finishes or the user cancels.
     * @see {@link EnvironmentActionsHelper.installPackages}
     */
    protected async installPackage(): Promise<void> {
        const packageName = await this.quickInput.input({
            prompt: 'Enter package name(s) to install',
            placeHolder: 'e.g., openmc or numpy pandas'
        });

        if (!packageName || !packageName.trim()) {
            return;
        }

        const packages = packageName.trim().split(/\s+/);

        // Ask user which package manager to use
        const managerItems = [
            { label: '📦 pip / uv', description: 'Install with pip (or uv if available)', value: 'pip' as const },
            { label: '🐍 conda / mamba', description: 'Install with conda-forge', value: 'conda' as const }
        ];

        const managerSelected = await this.quickPick.show(managerItems, {
            placeholder: 'Select package manager'
        });

        if (!managerSelected || !('value' in managerSelected)) {
            return;
        }

        const useConda = managerSelected.value === 'conda';

        const result = await this.envActions.installPackages({
            packages,
            title: `Install: ${packages.join(', ')}`,
            useConda
        });

        if (result.success) {
            this.messageService.info(result.message);
        } else {
            this.messageService.warn(result.message);
        }
    }
}
