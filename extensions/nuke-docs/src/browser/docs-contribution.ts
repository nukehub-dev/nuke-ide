import { injectable } from '@theia/core/shared/inversify';
import { Command, CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import { AbstractViewContribution, CommonMenus } from '@theia/core/lib/browser';
import { DocsWidget } from './docs-widget';

export namespace NukeDocsCommands {
    export const OPEN_DOCS: Command = {
        id: 'nuke.docs.open',
        label: 'Documentation'
    };
}

@injectable()
export class DocsContribution extends AbstractViewContribution<DocsWidget> {
    constructor() {
        super({
            widgetId: DocsWidget.ID,
            widgetName: DocsWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main'
            }
        });
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(NukeDocsCommands.OPEN_DOCS, {
            execute: () => this.openView({ activate: true })
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.HELP, {
            commandId: NukeDocsCommands.OPEN_DOCS.id,
            label: NukeDocsCommands.OPEN_DOCS.label,
            order: 'a05'
        });
    }
}
