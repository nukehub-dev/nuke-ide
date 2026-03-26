// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common';
import { SysmonFrontendService } from './sysmon-service';
import { SysmonService } from '../common/sysmon-protocol';
import { SysmonStatusContribution } from './sysmon-status-contribution';
import { SysmonWidget } from './sysmon-widget';
import { SysmonCommandContribution } from './sysmon-command-contribution';
import { bindSysmonPreferences } from './sysmon-preferences';

export default new ContainerModule(bind => {
    // Preferences
    bindSysmonPreferences(bind);

    // Service
    bind(SysmonFrontendService).toSelf().inSingletonScope();
    bind(SysmonService).toService(SysmonFrontendService);

    // Status Bar Contribution
    bind(SysmonStatusContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(SysmonStatusContribution);

    // Command Contribution
    bind(SysmonCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(SysmonCommandContribution);

    // Widget Factory
    bind(SysmonWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: SysmonWidget.ID,
        createWidget: () => ctx.container.get(SysmonWidget)
    })).inSingletonScope();
});
