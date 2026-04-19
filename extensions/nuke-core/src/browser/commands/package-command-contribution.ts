// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Package Command Contribution
 *
 * Commands: Install Package
 *
 * @module nuke-core/browser/commands
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService, QuickInputService } from '@theia/core/lib/browser/quick-input';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { NukeCoreService } from '../services/nuke-core-service';
import { EnvironmentActionsHelper } from '../services/environment-actions-helper';
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

    @inject(TerminalService)
    protected readonly terminalService: TerminalService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(EnvironmentActionsHelper)
    protected readonly envActions: EnvironmentActionsHelper;

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeCoreCommands.INSTALL_PACKAGE, {
            execute: () => this.installPackage()
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(NukeMenus.TOOLS, {
            commandId: NukeCoreCommands.INSTALL_PACKAGE.id,
            label: 'Install Package',
            order: 'b'
        });
    }

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

        try {
            const roots = await this.workspaceService.roots;
            const workspaceRoot = roots[0]?.resource?.path?.toString() || '';
            const cmdInfo = await this.nukeCore.prepareInstallPackagesCommand({ packages, useConda, cwd: workspaceRoot });

            const terminal = await this.terminalService.newTerminal({
                title: `Install: ${packages.join(', ')}`,
                cwd: cmdInfo.cwd
            });
            await terminal.start();
            this.terminalService.open(terminal, { mode: 'reveal' });

            const args = this.envActions.parseCommandString(cmdInfo.command);
            await terminal.executeCommand({ cwd: cmdInfo.cwd, args });

            this.messageService.info(`Installing ${packages.join(', ')} with ${useConda ? 'conda' : 'pip'} in terminal...`);

            await this.envActions.waitForTerminal(terminal);

            const status = terminal.exitStatus;
            if (status && status.code === 0) {
                this.messageService.info(`Successfully installed: ${packages.join(', ')}`);
            } else {
                this.messageService.warn(
                    `Package installation may have failed or produced warnings. Check the terminal for details.`
                );
            }
        } catch (error) {
            this.messageService.error(`Installation failed: ${error}`);
        }
    }
}
