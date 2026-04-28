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

export const VisualizerPreferenceSchema: PreferenceSchema = {
    properties: {
        'nukeVisualizer.serverTimeout': {
            type: 'number',
            default: 30,
            description: 'Base timeout in seconds to wait for visualizer server to start.'
        },
        'nukeVisualizer.serverTimeoutPerMB': {
            type: 'number',
            default: 0.5,
            description: 'Additional timeout per MB of file size for large DAGMC/CAD files.'
        }
    }
};

export interface VisualizerConfiguration {
    'nukeVisualizer.serverTimeout': number;
    'nukeVisualizer.serverTimeoutPerMB': number;
}

export const VisualizerPreferenceContribution = Symbol('VisualizerPreferenceContribution');
export const VisualizerPreferences = Symbol('VisualizerPreferences');
export type VisualizerPreferences = PreferenceProxy<VisualizerConfiguration>;

export function createVisualizerPreferences(preferences: PreferenceService, schema: PreferenceSchema = VisualizerPreferenceSchema): VisualizerPreferences {
    return createPreferenceProxy(preferences, schema);
}

export function bindVisualizerPreferences(bind: interfaces.Bind): void {
    bind(VisualizerPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get<PreferenceService>(PreferenceService);
        const contribution = ctx.container.get<PreferenceContribution>(VisualizerPreferenceContribution);
        return createVisualizerPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(VisualizerPreferenceContribution).toConstantValue({ schema: VisualizerPreferenceSchema });
    bind(PreferenceContribution).toService(VisualizerPreferenceContribution);
}
