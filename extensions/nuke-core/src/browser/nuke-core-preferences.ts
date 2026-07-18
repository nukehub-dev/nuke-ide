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
 * Nuke Core Preferences
 *
 * Core configuration settings for NukeIDE - located in main Settings panel.
 *
 * Defines the preference schema, TypeScript configuration interface, and DI binding helpers
 * for Nuke Core settings exposed through Theia's preference system.
 *
 * @module nuke-core/browser
 * @see {@link ./nuke-core-preference-layout | Nuke Preference Layout}
 * @see {@link ./nuke-core-frontend-module | Nuke Core Frontend Module}
 */

import { interfaces } from '@theia/core/shared/inversify';
import {
    createPreferenceProxy,
    PreferenceProxy,
    PreferenceService,
    PreferenceSchema,
    PreferenceContribution
} from '@theia/core/lib/common/preferences';

/**
 * Preference schema for Nuke Core settings.
 *
 * All properties are grouped under the "Nuke Utils" category in the Settings UI.
 *
 * @see {@link NukeCoreConfiguration}
 * @see {@link bindNukeCorePreferences}
 */
export const NukeCoreConfigSchema: PreferenceSchema = {
    title: 'Nuke Utils',
    properties: {
        /** Path to the Python executable used for running Python-based tools and scripts. */
        'nuke.pythonPath': {
            type: 'string',
            description: 'Path to Python executable for running Python tools',
            default: ''
        },
        /** Name of the Conda environment to activate (e.g., "nuke-env"). */
        'nuke.condaEnv': {
            type: 'string',
            description: 'Conda environment name to use (e.g., "nuke-env")',
            default: ''
        },
        /** Absolute path to the OpenMC cross_sections.xml file. */
        'nuke.openmcCrossSections': {
            type: 'string',
            description: 'Path to OpenMC cross_sections.xml file',
            default: ''
        },
        /** Default path to the OpenMC depletion chain XML file. */
        'nuke.openmcChainFile': {
            type: 'string',
            description: 'Default path to OpenMC depletion chain XML file',
            default: ''
        },
        /** Controls visibility of the Python environment status bar item. */
        'nuke.showStatusBar': {
            type: 'string',
            enum: ['auto', 'always', 'never'],
            enumDescriptions: ['Only show status bar when Python is not configured', 'Always show status bar', 'Never show status bar'],
            default: 'auto',
            description: 'Control when to show the Python environment status bar item'
        },
        /** Extra pip index URL for installing private or internally-hosted packages. */
        'nuke.pipExtraIndexUrl': {
            type: 'string',
            description: 'Extra pip index URL for private packages (e.g., https://pkgs.dev.azure.com/.../simple)',
            default: ''
        },
        /** Comma-separated list of Conda channels to use when resolving packages. */
        'nuke.condaChannels': {
            type: 'string',
            description: 'Comma-separated list of conda channels (default: conda-forge). E.g., conda-forge,nvidia,pytorch',
            default: 'conda-forge'
        }
    }
};

/**
 * Typed interface mirroring the keys defined in {@link NukeCoreConfigSchema}.
 *
 * This interface is consumed by {@link NukeCorePreferences} to provide type-safe
 * access to preference values.
 */
export interface NukeCoreConfiguration {
    'nuke.pythonPath': string;
    'nuke.condaEnv': string;
    'nuke.openmcCrossSections': string;
    'nuke.openmcChainFile': string;
    'nuke.showStatusBar': 'auto' | 'always' | 'never';
    'nuke.pipExtraIndexUrl': string;
    'nuke.condaChannels': string;
}

/**
 * Inversify symbol used to inject the Nuke Core typed preference proxy.
 *
 * @see {@link createNukeCorePreferences}
 * @see {@link bindNukeCorePreferences}
 */
export const NukeCorePreferences = Symbol('NukeCorePreferences');

/**
 * Type alias for the typed preference proxy returned by {@link createNukeCorePreferences}.
 */
export type NukeCorePreferences = PreferenceProxy<NukeCoreConfiguration>;

/**
 * Inversify symbol used to bind the {@link PreferenceContribution} for Nuke Core.
 *
 * @see {@link bindNukeCorePreferences}
 */
export const NukeCorePreferenceContribution = Symbol('NukeCorePreferenceContribution');

/**
 * Creates a type-safe preference proxy backed by the Nuke Core schema.
 *
 * @param preferences - The Theia {@link @theia/core/lib/common/preferences#PreferenceService} instance.
 * @param schema - Optional override of the preference schema; defaults to {@link NukeCoreConfigSchema}.
 * @returns A typed {@link PreferenceProxy} for {@link NukeCoreConfiguration}.
 * @see {@link NukeCorePreferences}
 */
export function createNukeCorePreferences(
    preferences: PreferenceService,
    schema: PreferenceSchema = NukeCoreConfigSchema
): NukeCorePreferences {
    return createPreferenceProxy(preferences, schema);
}

/**
 * Binds the Nuke Core preference schema and typed proxy into the Inversify container.
 *
 * @param bind - The Inversify {@link @theia/core/shared/inversify#interfaces.Bind} function.
 * @returns void
 * @see {@link NukeCorePreferenceContribution}
 * @see {@link NukeCorePreferences}
 */
export function bindNukeCorePreferences(bind: interfaces.Bind): void {
    bind(NukeCorePreferenceContribution).toConstantValue({ schema: NukeCoreConfigSchema });
    bind(PreferenceContribution).toService(NukeCorePreferenceContribution);
    bind(NukeCorePreferences)
        .toDynamicValue((ctx) => {
            const preferences = ctx.container.get<PreferenceService>(PreferenceService);
            return createNukeCorePreferences(preferences);
        })
        .inSingletonScope();
}
