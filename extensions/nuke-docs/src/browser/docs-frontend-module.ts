import { ContainerModule } from '@theia/core/shared/inversify';
import { bindViewContribution, WidgetFactory } from '@theia/core/lib/browser';
import { DocsWidget } from './docs-widget';
import { DocsContribution } from './docs-contribution';

import './style.css';

export default new ContainerModule((bind) => {
  bindViewContribution(bind, DocsContribution);

  bind(DocsWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(({ container }) => ({
    id: DocsWidget.ID,
    createWidget: () => container.get(DocsWidget)
  })).inSingletonScope();
});
