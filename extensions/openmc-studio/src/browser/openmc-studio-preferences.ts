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
 * Defines the preference schema, configuration interface, and binding logic
 * for OpenMC Studio user settings within the Theia preference system.
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

/** Preference schema for OpenMC Studio settings. */
export const OpenMCStudioPreferenceSchema: PreferenceSchema = {
    properties: {
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

/** Typed configuration interface mirroring the preference schema. */
export interface OpenMCStudioConfiguration {
    /** Default number of particles per batch for new projects. */
    'openmcStudio.defaultParticles': number;
    /** Default number of batches for new projects. */
    'openmcStudio.defaultBatches': number;
    /** Default number of inactive batches for eigenvalue calculations. */
    'openmcStudio.defaultInactive': number;
}

/** Symbol used to bind the {@link PreferenceContribution} for OpenMC Studio. */
export const OpenMCStudioPreferenceContribution = Symbol('OpenMCStudioPreferenceContribution');
/** Symbol used to bind the typed {@link PreferenceProxy} for OpenMC Studio. */
export const OpenMCStudioPreferences = Symbol('OpenMCStudioPreferences');
/** Typed preference proxy for reading OpenMC Studio settings. */
export type OpenMCStudioPreferences = PreferenceProxy<OpenMCStudioConfiguration>;

/**
 * Create a typed preference proxy for OpenMC Studio settings.
 *
 * @param preferences - The Theia {@link PreferenceService} instance.
 * @param schema - The preference schema to use (defaults to {@link OpenMCStudioPreferenceSchema}).
 * @returns A typed {@link PreferenceProxy} for OpenMC Studio configuration.
 */
export function createOpenMCStudioPreferences(preferences: PreferenceService, schema: PreferenceSchema = OpenMCStudioPreferenceSchema): OpenMCStudioPreferences {
    return createPreferenceProxy(preferences, schema);
}

/**
 * Bind OpenMC Studio preferences into the Inversify container.
 *
 * @param bind - The Inversify {@link interfaces.Bind} function.
 */
export function bindOpenMCStudioPreferences(bind: interfaces.Bind): void {
    bind(OpenMCStudioPreferences).toDynamicValue(ctx => {
        const preferences = ctx.container.get<PreferenceService>(PreferenceService);
        const contribution = ctx.container.get<PreferenceContribution>(OpenMCStudioPreferenceContribution);
        return createOpenMCStudioPreferences(preferences, contribution.schema);
    }).inSingletonScope();
    bind(OpenMCStudioPreferenceContribution).toConstantValue({ schema: OpenMCStudioPreferenceSchema });
    bind(PreferenceContribution).toService(OpenMCStudioPreferenceContribution);
}
