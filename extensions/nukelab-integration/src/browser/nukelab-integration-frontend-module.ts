import { ContainerModule } from '@theia/core/shared/inversify';
import { MenuContribution, CommandContribution } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { NukeLabCommandContribution } from './nukelab-integration-command-contribution';
import { NukeLabMenuContribution } from './nukelab-integration-menu-contribution';
import { NukeLabSidebarContribution } from './nukelab-integration-sidebar-contribution';
import { NukeLabAppStatusService } from './nukelab-integration-app-status-service';

export default new ContainerModule((bind) => {
    bind(NukeLabAppStatusService).toSelf().inSingletonScope();

    bind(NukeLabCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NukeLabCommandContribution);

    bind(NukeLabMenuContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(NukeLabMenuContribution);

    bind(NukeLabSidebarContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(NukeLabSidebarContribution);
});
