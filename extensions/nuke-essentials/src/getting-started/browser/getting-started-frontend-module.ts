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

import { EmptyMainPanelContribution } from './empty-main-panel-contribution';
import { ContainerModule, interfaces } from '@theia/core/shared/inversify';
import { GettingStartedWidget } from './getting-started-widget';
import {
    WidgetFactory,
    FrontendApplicationContribution,
    noopWidgetStatusBarContribution,
    WidgetStatusBarContribution
} from '@theia/core/lib/browser';
import { QuoteService } from '../../common/quote-protocol';
import { QuoteFrontendService } from '../common/quote-frontend-service';
import '../../../src/getting-started/style.css';

export default new ContainerModule((bind: interfaces.Bind) => {
    // @theia/getting-started owns the Welcome view contribution, command, and
    // startup behavior (and ai-ide depends on that extension). Bind only the
    // Nuke welcome widget into the shared view ID so both modules do not
    // register the same command, view, and preference schema twice.
    bind(FrontendApplicationContribution).to(EmptyMainPanelContribution).inSingletonScope();
    bind(WidgetStatusBarContribution).toConstantValue(noopWidgetStatusBarContribution(GettingStartedWidget));
    bind(GettingStartedWidget).toSelf();
    bind(WidgetFactory)
        .toDynamicValue((context) => ({
            id: GettingStartedWidget.ID,
            createWidget: () => context.container.get<GettingStartedWidget>(GettingStartedWidget)
        }))
        .inSingletonScope();

    // Bind quote service
    bind(QuoteService).to(QuoteFrontendService).inSingletonScope();
});
