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
