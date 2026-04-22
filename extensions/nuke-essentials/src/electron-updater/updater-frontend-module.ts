import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { NukeUpdaterFrontendContribution } from './updater-frontend-contribution';

export default new ContainerModule(bind => {
    bind(NukeUpdaterFrontendContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NukeUpdaterFrontendContribution);
    bind(MenuContribution).toService(NukeUpdaterFrontendContribution);
});
