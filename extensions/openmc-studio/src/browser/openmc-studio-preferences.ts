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

/**
 * OpenMC Studio Preferences
 * 
 * Preferences for OpenMC Studio extension.
 * Note: Python path and conda environment are shared with nuke-visualizer
 * via 'nukeVisualizer.pythonPath' and 'nukeVisualizer.condaEnv'.
 * 
 * @module openmc-studio/browser
 */

import { interfaces } from '@theia/core/shared/inversify';
import {
    createPreferenceProxy,
    PreferenceProxy,
    PreferenceService,
    PreferenceSchema,
    PreferenceContribution
} from '@theia/core/lib/common/preferences';

export const OpenMCStudioPreferenceSchema: PreferenceSchema = {
    properties: {
        'openmcStudio.openmcPath': {
            type: 'string',
            default: '',
            description: 'Path to OpenMC executable. Leave empty to use Python module (python -m openmc).'
        },
        'openmcStudio.crossSectionsPath': {
            type: 'string',
            default: '',
            description: 'Path to OpenMC cross_sections.xml file. If not set, uses OPENMC_CROSS_SECTIONS environment variable.'
        },
        'openmcStudio.defaultParticles': {
            type: 'number',
            default: 1000,
            description: 'Default number of particles per batch for new projects.'
        },
        'openmcStudio.defaultBatches': {
            type: 'number',
            default: 100,
            description: 'Default number of batches for new projects.'
        },
        'openmcStudio.defaultInactive': {
            type: 'number',
            default: 10,
            description: 'Default number of inactive batches for eigenvalue calculations.'
        }
    }
};

export interface OpenMCStudioConfiguration {
    'openmcStudio.openmcPath': string;
    'openmcStudio.crossSectionsPath': string;
    'openmcStudio.defaultParticles': number;
    'openmcStudio.defaultBatches': number;
    'openmcStudio.defaultInactive': number;
}

export const OpenMCStudioPreferenceContribution = Symbol('OpenMCStudioPreferenceContribution');
export const OpenMCStudioPreferences = Symbol('OpenMCStudioPreferences');
export type OpenMCStudioPreferences = PreferenceProxy<OpenMCStudioConfiguration>;

export function createOpenMCStudioPreferences(preferences: PreferenceService, schema: PreferenceSchema = OpenMCStudioPreferenceSchema): OpenMCStudioPreferences {
    return createPreferenceProxy(preferences, schema);
}

export function bindOpenMCStudioPreferences(bind: interfaces.Bind): void {
    bind(OpenMCStudioPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get<PreferenceService>(PreferenceService);
        const contribution = ctx.container.get<PreferenceContribution>(OpenMCStudioPreferenceContribution);
        return createOpenMCStudioPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(OpenMCStudioPreferenceContribution).toConstantValue({ schema: OpenMCStudioPreferenceSchema });
    bind(PreferenceContribution).toService(OpenMCStudioPreferenceContribution);
}
