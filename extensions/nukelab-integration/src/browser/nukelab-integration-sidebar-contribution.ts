import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { codicon } from '@theia/core/lib/browser/widgets';
import { ACCOUNTS_MENU } from '@theia/core/lib/common/menu';
import { NukeLabContext } from '../common/nukelab-integration-protocol';
import { NukeLabCommandContribution, NukeLabCommands } from './nukelab-integration-command-contribution';
import { NukeLabAppStatusService } from './nukelab-integration-app-status-service';

@injectable()
export class NukeLabSidebarContribution implements FrontendApplicationContribution {
    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    @inject(NukeLabCommandContribution)
    protected readonly commandContribution: NukeLabCommandContribution;

    @inject(NukeLabAppStatusService)
    protected readonly appStatusService: NukeLabAppStatusService;

    protected context: NukeLabContext | undefined;

    @postConstruct()
    protected init(): void {
        this.appStatusService.initialize();
        this.loadContext();
    }

    async onStart(_app: FrontendApplication): Promise<void> {
        this.addSidebarMenu();
    }

    protected async loadContext(): Promise<void> {
        try {
            const response = await fetch('/api/nukelab/context');
            if (response.ok) {
                this.context = (await response.json()) as NukeLabContext;
                this.commandContribution.setContext(this.context);
                this.updateUserStatus();
            }
        } catch (error) {
            console.warn('[NukeLabIntegration] Failed to load context:', error);
        }
    }

    /**
     * Shows the current NukeLab user in the status bar (right side), so it is
     * always visible who this workspace server belongs to. Only shown when the
     * IDE runs under NukeLab (i.e. the context provides a user).
     */
    protected updateUserStatus(): void {
        const user = this.context?.username || this.context?.userId;
        if (!user) {
            return;
        }
        this.statusBar.setElement('nukelab-user', {
            text: `$(account) ${user}`,
            alignment: StatusBarAlignment.RIGHT,
            tooltip: `Signed in to NukeLab as ${user}`,
            command: this.context?.serverId ? NukeLabCommands.OPEN_SERVER_DETAILS.id : undefined,
            priority: 3
        });
    }

    protected addSidebarMenu(): void {
        this.shell.leftPanelHandler.addBottomMenu({
            id: 'nukelab-account-menu',
            iconClass: codicon('account'),
            title: 'NukeLab',
            menuPath: ACCOUNTS_MENU,
            order: 2
        });
    }
}
