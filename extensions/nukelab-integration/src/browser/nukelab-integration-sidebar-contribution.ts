import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { codicon } from '@theia/core/lib/browser/widgets';
import { ACCOUNTS_MENU } from '@theia/core/lib/common/menu';
import { NukeLabContext } from '../common/nukelab-integration-protocol';
import { NukeLabCommandContribution } from './nukelab-integration-command-contribution';
import { NukeLabAppStatusService } from './nukelab-integration-app-status-service';

@injectable()
export class NukeLabSidebarContribution implements FrontendApplicationContribution {

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

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
                this.context = await response.json() as NukeLabContext;
                this.commandContribution.setContext(this.context);
            }
        } catch (error) {
            console.warn('[NukeLabIntegration] Failed to load context:', error);
        }
    }

    protected addSidebarMenu(): void {
        this.shell.leftPanelHandler.addBottomMenu({
            id: 'nukelab-account-menu',
            iconClass: codicon('account'),
            title: 'NukeLab',
            menuPath: ACCOUNTS_MENU,
            order: 2,
        });
    }
}
