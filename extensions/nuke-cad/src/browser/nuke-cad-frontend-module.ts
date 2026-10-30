// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * Frontend DI module for nuke-cad.
 *
 * @see src/node/nuke-cad-backend-module.ts
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging';
import { CommandContribution, MenuContribution } from '@theia/core/lib/common';
import { OpenHandler, WidgetFactory } from '@theia/core/lib/browser';
import { NukeToolsContribution } from 'nuke-core/lib/common/nuke-tools-protocol';

import { NukeCadBackendService, NukeCadBackendServicePath } from '../common/nuke-cad-protocol';
import { NukeCadFrontendService } from './nuke-cad-frontend-service';
import { bindNukeCadPreferences, NukeCadPreferences } from './nuke-cad-preferences';
import { NukeCadStateManager } from './state/nuke-cad-state-manager';
import { CadDocumentStore } from './document/cad-document-store';
import { NukeCadCommandContribution } from './contributions/nuke-cad-command-contribution';
import { NukeCadToolsContribution } from './contributions/nuke-cad-tools-contribution';
import { NukeCadMenuContribution } from './contributions/nuke-cad-menu-contribution';
import { NukeCadOpenHandler } from './contributions/nuke-cad-openhandler-contribution';
import { CadViewportWidget } from './widgets/cad-viewport/cad-viewport-widget';
import { CadOutlinePanelWidget } from './widgets/outline-panel/outline-panel-widget';
import { CadFeatureTreeWidget } from './widgets/feature-tree/feature-tree-widget';
import { CadBomPanelWidget } from './widgets/bom-panel/bom-panel';
import { DrawingSheetWidget } from './widgets/drawing-sheet/drawing-sheet-widget';
import { FemPanelWidget } from './widgets/fem-panel/fem-panel-widget';
import { FoamPanelWidget } from './widgets/foam-panel/foam-panel-widget';

export default new ContainerModule((bind) => {
    bindNukeCadPreferences(bind);

    bind(NukeCadStateManager).toSelf().inSingletonScope();
    bind(CadDocumentStore).toSelf().inSingletonScope();

    bind(NukeCadFrontendService)
        .toDynamicValue((ctx) => {
            const proxy = ctx.container.get(WebSocketConnectionProvider).createProxy<NukeCadBackendService>(NukeCadBackendServicePath);
            const preferences = ctx.container.get<NukeCadPreferences>(NukeCadPreferences);
            return new NukeCadFrontendService(proxy, preferences);
        })
        .inSingletonScope();
    bind(NukeCadBackendService).toService(NukeCadFrontendService);

    bind(NukeCadCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(NukeCadCommandContribution);

    bind(NukeCadToolsContribution).toSelf().inSingletonScope();
    bind(NukeToolsContribution).toService(NukeCadToolsContribution);

    bind(NukeCadMenuContribution).toSelf().inSingletonScope();
    bind(MenuContribution).toService(NukeCadMenuContribution);

    bind(NukeCadOpenHandler).toSelf().inSingletonScope();
    bind(OpenHandler).toService(NukeCadOpenHandler);

    bind(WidgetFactory)
        .toDynamicValue((ctx) => ({
            id: CadViewportWidget.ID,
            createWidget: () => ctx.container.get(CadViewportWidget)
        }))
        .inSingletonScope();
    bind(CadViewportWidget).toSelf();

    bind(WidgetFactory)
        .toDynamicValue((ctx) => ({
            id: CadOutlinePanelWidget.ID,
            createWidget: () => ctx.container.get(CadOutlinePanelWidget)
        }))
        .inSingletonScope();
    bind(CadOutlinePanelWidget).toSelf();

    bind(WidgetFactory)
        .toDynamicValue((ctx) => ({
            id: CadFeatureTreeWidget.ID,
            createWidget: () => ctx.container.get(CadFeatureTreeWidget)
        }))
        .inSingletonScope();
    bind(CadFeatureTreeWidget).toSelf();

    bind(WidgetFactory)
        .toDynamicValue((ctx) => ({
            id: CadBomPanelWidget.ID,
            createWidget: () => ctx.container.get(CadBomPanelWidget)
        }))
        .inSingletonScope();
    bind(CadBomPanelWidget).toSelf();

    bind(WidgetFactory)
        .toDynamicValue((ctx) => ({
            id: DrawingSheetWidget.ID,
            createWidget: () => ctx.container.get(DrawingSheetWidget)
        }))
        .inSingletonScope();
    bind(DrawingSheetWidget).toSelf();

    bind(WidgetFactory)
        .toDynamicValue((ctx) => ({
            id: FemPanelWidget.ID,
            createWidget: () => ctx.container.get(FemPanelWidget)
        }))
        .inSingletonScope();
    bind(FemPanelWidget).toSelf();

    bind(WidgetFactory)
        .toDynamicValue((ctx) => ({
            id: FoamPanelWidget.ID,
            createWidget: () => ctx.container.get(FoamPanelWidget)
        }))
        .inSingletonScope();
    bind(FoamPanelWidget).toSelf();
});
