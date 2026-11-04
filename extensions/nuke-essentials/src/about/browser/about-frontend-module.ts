import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { ContainerModule } from '@theia/core/shared/inversify';
import { MenuContribution } from '@theia/core/lib/common/menu';
import '../../../src/about/style.css';
import { NukeAboutDialog } from './about-dialog';
import { AboutMenuContribution } from './about-menu-contribution';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    bind(AboutMenuContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(AboutMenuContribution);

    // about dialog
    if (isBound(AboutDialog)) {
        rebind(AboutDialog).to(NukeAboutDialog).inSingletonScope();
    } else {
        bind(AboutDialog).to(NukeAboutDialog).inSingletonScope();
    }
});
