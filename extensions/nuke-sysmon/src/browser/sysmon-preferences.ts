// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { interfaces } from '@theia/core/shared/inversify';
import {
    createPreferenceProxy,
    PreferenceProxy,
    PreferenceService,
    PreferenceSchema,
    PreferenceContribution
} from '@theia/core/lib/common/preferences';

export const SysmonConfigSchema: PreferenceSchema = {
    properties: {
        'sysmon.updateInterval': {
            type: 'number',
            minimum: 500,
            maximum: 60000,
            default: 2000,
            description: 'System monitor update interval in milliseconds (500ms - 60s)'
        }
    }
};

export interface SysmonConfiguration {
    'sysmon.updateInterval': number;
}

export const SysmonPreferences = Symbol('SysmonPreferences');
export type SysmonPreferences = PreferenceProxy<SysmonConfiguration>;

export function createSysmonPreferences(preferences: PreferenceService): SysmonPreferences {
    return createPreferenceProxy(preferences, SysmonConfigSchema);
}

export const SysmonPreferenceContribution = Symbol('SysmonPreferenceContribution');

export function bindSysmonPreferences(bind: interfaces.Bind): void {
    bind(SysmonPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get<PreferenceService>(PreferenceService);
        return createSysmonPreferences(preferences);
    }).inSingletonScope();

    bind(SysmonPreferenceContribution).toConstantValue({ schema: SysmonConfigSchema });
    bind(PreferenceContribution).toService(SysmonPreferenceContribution);
}
