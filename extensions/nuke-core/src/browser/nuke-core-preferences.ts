// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Nuke Core Preferences
 * 
 * Core configuration settings for NukeIDE - located in main Settings panel.
 * 
 * @module nuke-core/browser
 */

import { interfaces } from '@theia/core/shared/inversify';
import {
    createPreferenceProxy,
    PreferenceProxy,
    PreferenceService,
    PreferenceSchema,
    PreferenceContribution
} from '@theia/core/lib/common/preferences';

export const NukeCoreConfigSchema: PreferenceSchema = {
    properties: {
        'nuke.pythonPath': {
            type: 'string',
            description: 'Path to Python executable for running Python tools',
            default: ''
        },
        'nuke.condaEnv': {
            type: 'string',
            description: 'Conda environment name to use (e.g., "nuke-env")',
            default: ''
        },
        'nuke.openmcCrossSections': {
            type: 'string',
            description: 'Path to OpenMC cross_sections.xml file',
            default: ''
        },
        'nuke.openmcChainFile': {
            type: 'string',
            description: 'Default path to OpenMC depletion chain XML file',
            default: ''
        }
    }
};

export interface NukeCoreConfiguration {
    'nuke.pythonPath': string;
    'nuke.condaEnv': string;
    'nuke.openmcCrossSections': string;
    'nuke.openmcChainFile': string;
}

export const NukeCorePreferences = Symbol('NukeCorePreferences');
export type NukeCorePreferences = PreferenceProxy<NukeCoreConfiguration>;

export const NukeCorePreferenceContribution = Symbol('NukeCorePreferenceContribution');

export function createNukeCorePreferences(preferences: PreferenceService, schema: PreferenceSchema = NukeCoreConfigSchema): NukeCorePreferences {
    return createPreferenceProxy(preferences, schema);
}

export function bindNukeCorePreferences(bind: interfaces.Bind): void {
    bind(NukeCorePreferenceContribution).toConstantValue({ schema: NukeCoreConfigSchema });
    bind(PreferenceContribution).toService(NukeCorePreferenceContribution);
    bind(NukeCorePreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get<PreferenceService>(PreferenceService);
        return createNukeCorePreferences(preferences);
    }).inSingletonScope();
}
