import { ContainerModule } from '@theia/core/shared/inversify';
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { ElectronConnectionHandler } from '@theia/core/lib/electron-main/messaging/electron-connection-handler';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { NukeUpdaterService, NukeUpdaterServicePath } from '../common/updater-protocol';
import { NukeUpdaterMainImpl } from './updater-main-impl';

export default new ContainerModule((bind) => {
    bind(NukeUpdaterMainImpl).toSelf().inSingletonScope();
    bind(NukeUpdaterService).toService(NukeUpdaterMainImpl);
    bind(ElectronMainApplicationContribution).toService(NukeUpdaterMainImpl);
    bind(ElectronConnectionHandler)
        .toDynamicValue((context) => new RpcConnectionHandler(NukeUpdaterServicePath, () => context.container.get(NukeUpdaterService)))
        .inSingletonScope();
});
