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
 * Nuke CAD Preferences
 *
 * Defines the preference schema, configuration interface, and binding logic
 * for Nuke CAD user settings within the Theia preference system.
 *
 * Only durable user defaults live here; per-model choices stay in
 * session/project state. Note that openmc-studio keeps its own
 * `openmcStudio.defaultFacetingTolerance` for its DAGMC editor: nuke-cad is
 * an optional extension with no dependency on openmc-studio, so the two tools
 * intentionally carry separate preferences.
 *
 * @module nuke-cad/browser
 */

import { interfaces } from '@theia/core/shared/inversify';
import {
    createPreferenceProxy,
    PreferenceProxy,
    PreferenceService,
    PreferenceSchema,
    PreferenceContribution
} from '@theia/core/lib/common/preferences';

/** Preference schema for Nuke CAD settings. */
export const NukeCadPreferenceSchema: PreferenceSchema = {
    properties: {
        'nukeCad.facetingTolerance': {
            type: 'number',
            default: 0.001,
            exclusiveMinimum: 0,
            description:
                'Default faceting tolerance for CAD geometry builds (tessellation and DAGMC export). ' +
                'Smaller values produce finer meshes at the cost of build time. ' +
                'Applies to builds started after the change; an explicit per-build tolerance still wins.'
        }
    }
};

/** Typed configuration interface mirroring the preference schema. */
export interface NukeCadConfiguration {
    /** Default faceting tolerance for CAD geometry builds. */
    'nukeCad.facetingTolerance': number;
}

/** Symbol used to bind the {@link PreferenceContribution} for Nuke CAD. */
export const NukeCadPreferenceContribution = Symbol('NukeCadPreferenceContribution');
/** Symbol used to bind the typed {@link PreferenceProxy} for Nuke CAD. */
export const NukeCadPreferences = Symbol('NukeCadPreferences');
/** Typed preference proxy for reading Nuke CAD settings. */
export type NukeCadPreferences = PreferenceProxy<NukeCadConfiguration>;

/**
 * Create a typed preference proxy for Nuke CAD settings.
 *
 * @param preferences - The Theia {@link PreferenceService} instance.
 * @param schema - The preference schema to use (defaults to {@link NukeCadPreferenceSchema}).
 * @returns A typed {@link PreferenceProxy} for Nuke CAD configuration.
 */
export function createNukeCadPreferences(
    preferences: PreferenceService,
    schema: PreferenceSchema = NukeCadPreferenceSchema
): NukeCadPreferences {
    return createPreferenceProxy(preferences, schema);
}

/**
 * Bind Nuke CAD preferences into the Inversify container.
 *
 * @param bind - The Inversify {@link interfaces.Bind} function.
 */
export function bindNukeCadPreferences(bind: interfaces.Bind): void {
    bind(NukeCadPreferences)
        .toDynamicValue((ctx) => {
            const preferences = ctx.container.get<PreferenceService>(PreferenceService);
            const contribution = ctx.container.get<PreferenceContribution>(NukeCadPreferenceContribution);
            return createNukeCadPreferences(preferences, contribution.schema);
        })
        .inSingletonScope();
    bind(NukeCadPreferenceContribution).toConstantValue({ schema: NukeCadPreferenceSchema });
    bind(PreferenceContribution).toService(NukeCadPreferenceContribution);
}
