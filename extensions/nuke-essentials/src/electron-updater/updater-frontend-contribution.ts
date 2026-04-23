import {
    Command,
    CommandContribution,
    CommandRegistry,
    MenuContribution,
    MenuModelRegistry,
    MessageService,
} from '@theia/core/lib/common';
import { CommonMenus } from '@theia/core/lib/browser';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { NukeUpdaterService } from '../common/updater-protocol';

export namespace NukeUpdaterCommands {
    export const CHECK_FOR_UPDATES: Command = {
        id: 'nuke-updater:check-for-updates',
        label: 'Check for Updates...',
    };
    export const RESTART_TO_UPDATE: Command = {
        id: 'nuke-updater:restart-to-update',
        label: 'Restart to Update',
    };
}

@injectable()
export class NukeUpdaterFrontendContribution implements CommandContribution, MenuContribution {

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(NukeUpdaterService)
    protected readonly updaterService: NukeUpdaterService;

    private readyToUpdate = false;

    @postConstruct()
    protected init(): void {
        setInterval(async () => {
            try {
                const status = await this.updaterService.getStatus();
                this.readyToUpdate = status?.readyToUpdate ?? false;
            } catch {
                // ignore
            }
        }, 5000);
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(NukeUpdaterCommands.CHECK_FOR_UPDATES, {
            execute: async () => {
                this.updaterService.checkForUpdates();
                await this.messageService.info('Checking for updates...');
            },
            isEnabled: () => !this.readyToUpdate,
            isVisible: () => !this.readyToUpdate,
        });

        registry.registerCommand(NukeUpdaterCommands.RESTART_TO_UPDATE, {
            execute: () => {
                this.updaterService.restartToUpdate();
            },
            isEnabled: () => this.readyToUpdate,
            isVisible: () => this.readyToUpdate,
        });
    }

    registerMenus(registry: MenuModelRegistry): void {
        registry.registerMenuAction(CommonMenus.HELP, {
            commandId: NukeUpdaterCommands.CHECK_FOR_UPDATES.id,
            label: NukeUpdaterCommands.CHECK_FOR_UPDATES.label,
            order: 'z1',
        });
        registry.registerMenuAction(CommonMenus.HELP, {
            commandId: NukeUpdaterCommands.RESTART_TO_UPDATE.id,
            label: NukeUpdaterCommands.RESTART_TO_UPDATE.label,
            order: 'z2',
        });
    }
}
