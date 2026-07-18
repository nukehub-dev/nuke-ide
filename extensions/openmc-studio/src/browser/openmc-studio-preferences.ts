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
        },
        'openmcStudio.defaultFacetingTolerance': {
            type: 'number',
            default: 1.0,
            description: 'Default faceting tolerance (cm) for CAD-to-DAGMC conversion. Smaller values produce finer meshes.'
        },
        'openmcStudio.autoAdjustFacetingTolerance': {
            type: 'boolean',
            default: true,
            description: 'Automatically increase faceting tolerance for very large models to prevent excessive mesh generation time.'
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
    /** Default faceting tolerance (cm) for CAD-to-DAGMC conversion. */
    'openmcStudio.defaultFacetingTolerance': number;
    /** Whether to auto-adjust faceting tolerance for large models. */
    'openmcStudio.autoAdjustFacetingTolerance': boolean;
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
export function createOpenMCStudioPreferences(
    preferences: PreferenceService,
    schema: PreferenceSchema = OpenMCStudioPreferenceSchema
): OpenMCStudioPreferences {
    return createPreferenceProxy(preferences, schema);
}

/**
 * Bind OpenMC Studio preferences into the Inversify container.
 *
 * @param bind - The Inversify {@link interfaces.Bind} function.
 */
export function bindOpenMCStudioPreferences(bind: interfaces.Bind): void {
    bind(OpenMCStudioPreferences)
        .toDynamicValue((ctx) => {
            const preferences = ctx.container.get<PreferenceService>(PreferenceService);
            const contribution = ctx.container.get<PreferenceContribution>(OpenMCStudioPreferenceContribution);
            return createOpenMCStudioPreferences(preferences, contribution.schema);
        })
        .inSingletonScope();
    bind(OpenMCStudioPreferenceContribution).toConstantValue({ schema: OpenMCStudioPreferenceSchema });
    bind(PreferenceContribution).toService(OpenMCStudioPreferenceContribution);
}
