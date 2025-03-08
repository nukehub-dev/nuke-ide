import { ContainerModule } from 'inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PWAFrontendService } from './pwa-frontend-service';

export default new ContainerModule(bind => {
    bind(PWAFrontendService).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(PWAFrontendService);
});
