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
import { FrontendApplicationConfigProvider } from '@theia/core/lib/browser/frontend-application-config-provider';
import { nls } from '@theia/core/lib/common/nls';

export const GettingStartedPreferenceSchema: PreferenceSchema = {
    properties: {
        'workbench.startupEditor': {
            type: 'string',
            enum: ['none', 'welcomePage', 'readme', 'newUntitledFile', 'welcomePageInEmptyWorkbench'],
            enumDescriptions: [
                nls.localizeByDefault('Start without an editor.'),
                nls.localize(
                    'theia/getting-started/startup-editor/welcomePage',
                    'Open the Welcome page, with content to aid in getting started with {0} and extensions.',
                    FrontendApplicationConfigProvider.get().applicationName
                ),
                // eslint-disable-next-line max-len
                nls.localizeByDefault(
                    "Open the README when opening a folder that contains one, fallback to 'welcomePage' otherwise. Note: This is only observed as a global configuration, it will be ignored if set in a workspace or folder configuration."
                ),
                nls.localizeByDefault('Open a new untitled text file (only applies when opening an empty window).'),
                nls.localizeByDefault('Open the Welcome page when opening an empty workbench.')
            ],
            default: 'welcomePage',
            description: nls.localizeByDefault('Controls which editor is shown at startup, if none are restored from the previous session.')
        }
    }
};

export interface GettingStartedConfiguration {
    'workbench.startupEditor': string;
}

export const GettingStartedPreferenceContribution = Symbol('GettingStartedPreferenceContribution');
export const GettingStartedPreferences = Symbol('GettingStartedPreferences');
export type GettingStartedPreferences = PreferenceProxy<GettingStartedConfiguration>;

export function createGettingStartedPreferences(
    preferences: PreferenceService,
    schema: PreferenceSchema = GettingStartedPreferenceSchema
): GettingStartedPreferences {
    return createPreferenceProxy(preferences, schema);
}

export function bindGettingStartedPreferences(bind: interfaces.Bind): void {
    bind(GettingStartedPreferences)
        .toDynamicValue((ctx) => {
            const preferences = ctx.container.get<PreferenceService>(PreferenceService);
            const contribution = ctx.container.get<PreferenceContribution>(GettingStartedPreferenceContribution);
            return createGettingStartedPreferences(preferences, contribution.schema);
        })
        .inSingletonScope();
    bind(GettingStartedPreferenceContribution).toConstantValue({ schema: GettingStartedPreferenceSchema });
    bind(PreferenceContribution).toService(GettingStartedPreferenceContribution);
}
