import { ContainerModule } from '@theia/core/shared/inversify';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { NukeUpdaterMainImpl } from './updater-main-impl';

export default new ContainerModule(bind => {
    bind(NukeUpdaterMainImpl).toSelf().inSingletonScope();
    bind(ElectronMainApplicationContribution).toService(NukeUpdaterMainImpl);
});
