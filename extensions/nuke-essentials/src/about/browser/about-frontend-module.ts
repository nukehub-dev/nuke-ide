import { AboutDialog } from '@theia/core/lib/browser/about-dialog';
import { ContainerModule } from '@theia/core/shared/inversify';
import '../../../src/about/style.css';
import { NukeAboutDialog } from './about-dialog';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    // about dialog
    if (isBound(AboutDialog)) {
        rebind(AboutDialog).to(NukeAboutDialog).inSingletonScope();
    } else {
        bind(AboutDialog).to(NukeAboutDialog).inSingletonScope();
    }
});
