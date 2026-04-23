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
let ipcRenderer: typeof import('electron').ipcRenderer | undefined;
try {
    ipcRenderer = require('@theia/electron/shared/electron').ipcRenderer;
} catch {
    // Not available in browser builds
}

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

    private readyToUpdate = false;

    @postConstruct()
    protected init(): void {
        if (!ipcRenderer) {
            return;
        }
        setInterval(async () => {
            try {
                const status = await ipcRenderer.invoke('nuke-updater:status');
                this.readyToUpdate = status?.readyToUpdate ?? false;
            } catch {
                // ignore
            }
        }, 5000);
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(NukeUpdaterCommands.CHECK_FOR_UPDATES, {
            execute: async () => {
                if (!ipcRenderer) {
                    return;
                }
                ipcRenderer.send('nuke-updater:check');
                await this.messageService.info('Checking for updates...');
            },
            isEnabled: () => !this.readyToUpdate && !!ipcRenderer,
            isVisible: () => !this.readyToUpdate && !!ipcRenderer,
        });

        registry.registerCommand(NukeUpdaterCommands.RESTART_TO_UPDATE, {
            execute: () => {
                if (!ipcRenderer) {
                    return;
                }
                ipcRenderer.send('nuke-updater:restart');
            },
            isEnabled: () => this.readyToUpdate && !!ipcRenderer,
            isVisible: () => this.readyToUpdate && !!ipcRenderer,
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
