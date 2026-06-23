import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { NukeLabIntegrationBackendContribution } from './nukelab-integration-backend-contribution';

export default new ContainerModule(bind => {
    bind(NukeLabIntegrationBackendContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(NukeLabIntegrationBackendContribution);
});
