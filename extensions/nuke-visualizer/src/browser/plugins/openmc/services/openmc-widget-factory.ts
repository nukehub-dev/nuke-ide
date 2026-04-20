// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { WidgetManager, ApplicationShell } from '@theia/core/lib/browser';
import { VisualizerWidget } from '../../../visualizer-widget';

@injectable()
export class OpenMCWidgetFactory {
    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    /**
     * Create and configure a visualizer widget.
     * Can be called with loading state first, then server URL set later.
     */
    async createVisualizerWidget(
        fileUri: URI,
        label: string,
        widgetId?: string,
        serverInfo?: { port: number; url: string },
        loadingMessage?: string
    ): Promise<VisualizerWidget> {
        const finalWidgetId = widgetId || `${VisualizerWidget.ID}:${fileUri.path.toString()}`;

        const widget = await this.widgetManager.getOrCreateWidget<VisualizerWidget>(
            VisualizerWidget.ID,
            { uri: fileUri.toString(), id: finalWidgetId }
        );

        widget.id = finalWidgetId;
        widget.setUri(fileUri);
        widget.id = finalWidgetId;

        widget.title.label = label;
        widget.title.caption = label;

        if (loadingMessage && !serverInfo) {
            (widget as any).statusMessage = loadingMessage;
            widget.update();
        }

        if (serverInfo) {
            widget.setServerUrl(serverInfo.url, serverInfo.port);
        }

        await this.shell.addWidget(widget, { area: 'main' });
        await this.shell.activateWidget(widget.id);

        return widget;
    }

    /**
     * Create a visualizer widget in loading state.
     * Returns the widget and a function to complete loading once server is ready.
     */
    async createVisualizerWidgetLoading(
        fileUri: URI,
        label: string,
        widgetId: string,
        loadingMessage: string
    ): Promise<{ widget: VisualizerWidget; completeLoading: (port: number, url: string) => void }> {
        const widget = await this.createVisualizerWidget(
            fileUri,
            label,
            widgetId,
            undefined,
            loadingMessage
        );

        const completeLoading = (port: number, url: string) => {
            widget.setServerUrl(url, port);
        };

        return { widget, completeLoading };
    }

    /**
     * Find an existing widget by ID in the main area.
     */
    findExistingWidget(widgetId: string): VisualizerWidget | undefined {
        for (const widget of this.shell.getWidgets('main')) {
            if (widget.id === widgetId && widget instanceof VisualizerWidget) {
                return widget;
            }
        }
        return undefined;
    }
}
