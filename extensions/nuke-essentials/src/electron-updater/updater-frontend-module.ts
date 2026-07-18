import { ContainerModule } from '@theia/core/shared/inversify';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { NukeUpdaterService, NukeUpdaterServicePath } from '../common/updater-protocol';
import { NukeUpdaterFrontendContribution } from './updater-frontend-contribution';

export default new ContainerModule((bind) => {
    bind(NukeUpdaterService)
        .toDynamicValue((context) => ElectronIpcConnectionProvider.createProxy(context.container, NukeUpdaterServicePath))
        .inSingletonScope();
    bind(NukeUpdaterFrontendContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NukeUpdaterFrontendContribution);
    bind(MenuContribution).toService(NukeUpdaterFrontendContribution);
});
