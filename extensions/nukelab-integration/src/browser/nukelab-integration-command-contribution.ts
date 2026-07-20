import { injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { NukeLabContext } from '../common/nukelab-integration-protocol';

export namespace NukeLabCommands {
    export const BACK_TO_NUKELAB: Command = {
        id: 'nukelab.backToNukeLab',
        label: 'NukeLab: Back to Dashboard'
    };
    export const OPEN_SERVER_DETAILS: Command = {
        id: 'nukelab.openServerDetails',
        label: 'NukeLab: Open Server Details'
    };
    export const INSTALL_NUKELAB_APP: Command = {
        id: 'nukelab.installNukeLabApp',
        label: 'NukeLab: Install NukeLab App'
    };
    export const OPEN_NUKELAB_APP: Command = {
        id: 'nukelab.openNukeLabApp',
        label: 'NukeLab: Open NukeLab App'
    };
    export const LOGOUT: Command = {
        id: 'nukelab.logout',
        label: 'NukeLab: Log Out'
    };
}

@injectable()
export class NukeLabCommandContribution implements CommandContribution {
    protected context: NukeLabContext | undefined;

    setContext(context: NukeLabContext | undefined): void {
        this.context = context;
    }

    registerCommands(commands: CommandRegistry): void {
        // The IDE is served through the NukeLab gateway on the hub origin, so
        // origin-relative paths always land on the right page regardless of
        // how NUKELAB_PUBLIC_URL is (or isn't) configured.
        commands.registerCommand(NukeLabCommands.BACK_TO_NUKELAB, {
            execute: () => this.navigateTop('/')
        });
        commands.registerCommand(NukeLabCommands.OPEN_SERVER_DETAILS, {
            execute: () => this.navigateTop('/servers/' + (this.context?.serverId || '')),
            isEnabled: () => !!this.context?.serverId
        });
        commands.registerCommand(NukeLabCommands.INSTALL_NUKELAB_APP, {
            execute: () => this.openTab('/'),
            isEnabled: () => !this.isAppInstalled()
        });
        commands.registerCommand(NukeLabCommands.OPEN_NUKELAB_APP, {
            execute: () => this.openTab('/'),
            isEnabled: () => this.isAppInstalled() && !this.isStandalone()
        });
        commands.registerCommand(NukeLabCommands.LOGOUT, {
            execute: () => this.navigateTop('/api/auth/signout')
        });
    }

    protected isAppInstalled(): boolean {
        if (typeof window === 'undefined') {
            return false;
        }
        const standalone = window.matchMedia('(display-mode: standalone)').matches;
        const iosStandalone = 'standalone' in window.navigator && !!(window.navigator as Navigator & { standalone?: boolean }).standalone;
        return standalone || iosStandalone;
    }

    protected isStandalone(): boolean {
        return this.isAppInstalled();
    }

    private navigateTop(url: string): void {
        if (typeof window !== 'undefined') {
            window.top?.location.assign(url);
        }
    }

    private openTab(url: string): void {
        if (typeof window !== 'undefined') {
            window.open(url, '_blank');
        }
    }
}
