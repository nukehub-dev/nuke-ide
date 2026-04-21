import { ContainerModule } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import { DocsServerContribution } from './docs-server-contribution';

export default new ContainerModule((bind) => {
    bind(DocsServerContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(DocsServerContribution);
});
