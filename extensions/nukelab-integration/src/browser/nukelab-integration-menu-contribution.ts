import { injectable } from '@theia/core/shared/inversify';
import { MenuContribution, MenuModelRegistry, ACCOUNTS_MENU } from '@theia/core/lib/common';
import { CommonMenus } from '@theia/core/lib/browser';
import { NukeLabCommands } from './nukelab-integration-command-contribution';
import { NUKELAB_APP_INSTALLED_KEY, NUKELAB_APP_STANDALONE_KEY } from './nukelab-integration-app-status-service';

export namespace NukeLabMenus {
    export const NUKELAB = [...CommonMenus.FILE, 'z_nukelab'];
}

@injectable()
export class NukeLabMenuContribution implements MenuContribution {

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerSubmenu(NukeLabMenus.NUKELAB, 'NukeLab');

        menus.registerMenuAction(NukeLabMenus.NUKELAB, {
            commandId: NukeLabCommands.BACK_TO_NUKELAB.id,
            label: NukeLabCommands.BACK_TO_NUKELAB.label,
            order: 'a10',
        });
        menus.registerMenuAction(NukeLabMenus.NUKELAB, {
            commandId: NukeLabCommands.OPEN_SERVER_DETAILS.id,
            label: NukeLabCommands.OPEN_SERVER_DETAILS.label,
            order: 'a20',
        });
        menus.registerMenuAction(NukeLabMenus.NUKELAB, {
            commandId: NukeLabCommands.INSTALL_NUKELAB_APP.id,
            label: NukeLabCommands.INSTALL_NUKELAB_APP.label,
            order: 'a30',
            when: `!${NUKELAB_APP_INSTALLED_KEY}`,
        });
        menus.registerMenuAction(NukeLabMenus.NUKELAB, {
            commandId: NukeLabCommands.OPEN_NUKELAB_APP.id,
            label: NukeLabCommands.OPEN_NUKELAB_APP.label,
            order: 'a35',
            when: `${NUKELAB_APP_INSTALLED_KEY} && !${NUKELAB_APP_STANDALONE_KEY}`,
        });
        menus.registerMenuAction(NukeLabMenus.NUKELAB, {
            commandId: NukeLabCommands.LOGOUT.id,
            label: NukeLabCommands.LOGOUT.label,
            order: 'z90',
        });

        menus.registerMenuAction(ACCOUNTS_MENU, {
            commandId: NukeLabCommands.BACK_TO_NUKELAB.id,
            label: 'Back to NukeLab',
            order: 'a10',
        });
        menus.registerMenuAction(ACCOUNTS_MENU, {
            commandId: NukeLabCommands.OPEN_SERVER_DETAILS.id,
            label: 'Server Details',
            order: 'a20',
        });
        menus.registerMenuAction(ACCOUNTS_MENU, {
            commandId: NukeLabCommands.INSTALL_NUKELAB_APP.id,
            label: 'Install NukeLab App',
            order: 'a30',
            when: `!${NUKELAB_APP_INSTALLED_KEY}`,
        });
        menus.registerMenuAction(ACCOUNTS_MENU, {
            commandId: NukeLabCommands.OPEN_NUKELAB_APP.id,
            label: 'Open NukeLab App',
            order: 'a35',
            when: `${NUKELAB_APP_INSTALLED_KEY} && !${NUKELAB_APP_STANDALONE_KEY}`,
        });
        menus.registerMenuAction(ACCOUNTS_MENU, {
            commandId: NukeLabCommands.LOGOUT.id,
            label: 'Log Out',
            order: 'z90',
        });
    }
}
