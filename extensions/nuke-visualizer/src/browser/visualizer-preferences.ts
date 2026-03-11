// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
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

export const VisualizerPreferenceSchema: PreferenceSchema = {
    properties: {
        'nukeVisualizer.pythonPath': {
            type: 'string',
            default: '',
            description: 'Path to Python executable with both visualizer and ParaView installed (e.g., /home/user/anaconda3/envs/visualizer/bin/python). Leave empty for auto-detection.'
        },
        'nukeVisualizer.condaEnv': {
            type: 'string',
            default: '',
            description: 'Conda environment name containing visualizer and ParaView (e.g., visualizer). Leave empty for auto-detection.'
        },
        'nukeVisualizer.serverTimeout': {
            type: 'number',
            default: 30,
            description: 'Timeout in seconds to wait for visualizer server to start.'
        }
    }
};

export interface VisualizerConfiguration {
    'nukeVisualizer.pythonPath': string;
    'nukeVisualizer.condaEnv': string;
    'nukeVisualizer.serverTimeout': number;
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
