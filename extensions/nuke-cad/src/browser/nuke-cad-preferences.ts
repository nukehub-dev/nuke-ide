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
        },
        'nukeCad.displayFacetingTolerance': {
            type: 'number',
            default: 0.01,
            exclusiveMinimum: 0,
            description:
                'Display-only faceting tolerance used for viewport preview of STEP imports and .nuke-cad documents. ' +
                'This is deliberately coarser than nukeCad.facetingTolerance so large models open quickly. ' +
                'DAGMC and FEM mesh exports use nukeCad.facetingTolerance instead.'
        },
        'nukeCad.maxDisplayTriangles': {
            type: 'number',
            default: 2_000_000,
            minimum: 1,
            description:
                'Soft maximum number of triangles for viewport preview tessellation. ' +
                'A warning is shown when a display build exceeds this budget. ' +
                'Does not affect DAGMC or FEM mesh export.'
        },
        'nukeCad.sketchAutoDimension': {
            type: 'boolean',
            default: false,
            description:
                'Show an inline value input after drawing a line, circle, or arc in sketch mode. ' +
                'Pressing Enter creates a driving dimension; Escape dismisses without dimensioning.'
        },
        'nukeCad.viewportBackground': {
            type: 'string',
            enum: ['theme', 'dark', 'light', 'gradient'],
            default: 'theme',
            description:
                'Viewport background style: theme follows the active theme, dark/light use a fixed color, ' +
                'gradient uses a CSS backdrop with a transparent renderer.'
        },
        'nukeCad.rebuildOnEdit': {
            type: 'string',
            enum: ['auto', 'manual'],
            default: 'auto',
            description:
                'Rebuild .nuke-cad documents automatically after each edit (auto), or only on demand (manual). ' +
                'Manual mode skips the debounced edit-triggered rebuild and marks the model stale until Rebuild runs; ' +
                'opening a document always builds. Prefer manual for large documents where each rebuild is expensive.'
        },
        'nukeCad.resultCacheSizeMB': {
            type: 'number',
            default: 1024,
            minimum: 1,
            description:
                'Maximum size in MB of the .nuke-cad result-cache sidecar (<stem>.nuke-cache.zip) before LRU eviction. ' +
                'Sent on every partial build; applies to builds started after the change.'
        },
        'nukeCad.navigationStyle': {
            type: 'string',
            enum: ['orbit', 'solidworks', 'tinkercad', 'touchpad'],
            default: 'orbit',
            description:
                'Viewport mouse/touch bindings: orbit uses left-drag orbit, SolidWorks reserves left-drag for ' +
                'selection with middle-drag orbit, TinkerCAD orbits on right-drag, touchpad uses finger gestures. ' +
                'Right-click context menus work in every style.'
        }
    }
};

/** Typed configuration interface mirroring the preference schema. */
export interface NukeCadConfiguration {
    /** Default faceting tolerance for CAD geometry builds. */
    'nukeCad.facetingTolerance': number;
    /** Display-only faceting tolerance for viewport preview builds. */
    'nukeCad.displayFacetingTolerance': number;
    /** Soft maximum triangle count for viewport preview tessellation. */
    'nukeCad.maxDisplayTriangles': number;
    /** When true, sketch entity completion prompts for an immediate driving dimension. */
    'nukeCad.sketchAutoDimension': boolean;
    /** Viewport background style: theme, dark, light, or gradient. */
    'nukeCad.viewportBackground': string;
    /** Rebuild behavior for document edits: auto rebuilds after each edit, manual marks the model stale until rebuilt. */
    'nukeCad.rebuildOnEdit': 'auto' | 'manual';
    /** Maximum size in MB of the result-cache sidecar before LRU eviction. */
    'nukeCad.resultCacheSizeMB': number;
    /** Viewport mouse/touch bindings: orbit, solidworks, tinkercad, or touchpad. */
    'nukeCad.navigationStyle': string;
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
