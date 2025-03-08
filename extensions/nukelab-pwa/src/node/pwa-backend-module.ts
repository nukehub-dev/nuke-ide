import { ContainerModule } from 'inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { PWABackendService } from './pwa-backend-service';

console.log("Backend Module Loaded");

export default new ContainerModule(bind => {
    bind(PWABackendService).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(PWABackendService);
});
