// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * Categorical (array-less) color-by helpers for the native DAGMC viewer.
 *
 * `Solid Color` and the DAGMC-specific `Material`, `Volume`, and `Group`
 * modes carry no scalar array: no range, component, colormap, or legend
 * applies. Keeping the sentinels and the volume→material/group lookups here
 * (pure) lets the widget, the Viewer Settings snapshot, and the outline share
 * one contract.
 */

import { SOLID_COLOR } from '../../../../viewer-core/viewer-toolbar-model';
import type { ViewerColorByOption } from '../../../../viewer-settings/viewer-settings-model';
import type { DagmcModelInfo } from './dagmc-toggle-model';

/** Categorical color-by sentinel: one deterministic color per DAGMC material. */
export const MATERIAL_COLOR = 'Material';

/** Categorical color-by sentinel: one deterministic color per DAGMC volume. */
export const VOLUME_COLOR = 'Volume';

/** Categorical color-by sentinel: one deterministic color per DAGMC group. */
export const GROUP_COLOR = 'Group';

/** Short Viewer Settings note shown while the Material mode is active. */
export const MATERIAL_COLOR_NOTE = 'Color by material';

/** Short Viewer Settings note shown while the Volume mode is active. */
export const VOLUME_COLOR_NOTE = 'Color by volume';

/** Short Viewer Settings note shown while the Group mode is active. */
export const GROUP_COLOR_NOTE = 'Color by group';

/** True for the DAGMC Material color-by sentinel. */
export function isMaterialColorBy(value: string): boolean {
    return value === MATERIAL_COLOR;
}

/** True for the DAGMC Volume color-by sentinel. */
export function isVolumeColorBy(value: string): boolean {
    return value === VOLUME_COLOR;
}

/** True for the DAGMC Group color-by sentinel. */
export function isGroupColorBy(value: string): boolean {
    return value === GROUP_COLOR;
}

/** True for color-by modes without a scalar array (Solid Color, Material, Volume, Group). */
export function isCategoricalColorBy(value: string): boolean {
    return value === SOLID_COLOR || isMaterialColorBy(value) || isVolumeColorBy(value) || isGroupColorBy(value);
}

/** Material name of one DAGMC volume (undefined without model info or for unknown ids). */
export function materialForVolume(info: DagmcModelInfo | undefined, volumeId: number | undefined): string | undefined {
    if (!info || volumeId === undefined) {
        return undefined;
    }
    return info.volumes.find((volume) => volume.id === volumeId)?.material;
}

/**
 * Primary group of one DAGMC volume: the first group key (object insertion
 * order) whose `volumeIds` include the id. Undefined without model info, an
 * id, or membership.
 */
export function primaryGroupForVolume(info: DagmcModelInfo | undefined, volumeId: number | undefined): string | undefined {
    if (!info || volumeId === undefined) {
        return undefined;
    }
    for (const [name, group] of Object.entries(info.groups)) {
        if (group.volumeIds.includes(volumeId)) {
            return name;
        }
    }
    return undefined;
}

/**
 * Color-by options in render order: Solid Color first, Material whenever the
 * `dagmc.info` payload is available, Volume whenever blocks exist, Group when
 * the payload carries groups, then the classified scalar arrays. Without
 * blocks only Solid Color is offered (nothing to recolor yet).
 */
export function dagmcColorByOptions(
    hasBlocks: boolean,
    hasModelInfo: boolean,
    hasGroups: boolean,
    arrayOptions: readonly ViewerColorByOption[]
): ViewerColorByOption[] {
    if (!hasBlocks) {
        return [{ value: SOLID_COLOR, label: SOLID_COLOR }];
    }
    const options: ViewerColorByOption[] = [{ value: SOLID_COLOR, label: SOLID_COLOR }];
    if (hasModelInfo) {
        options.push({ value: MATERIAL_COLOR, label: MATERIAL_COLOR });
    }
    options.push({ value: VOLUME_COLOR, label: VOLUME_COLOR });
    if (hasGroups) {
        options.push({ value: GROUP_COLOR, label: GROUP_COLOR });
    }
    for (const option of arrayOptions) {
        if (!options.some((entry) => entry.value === option.value)) {
            options.push(option);
        }
    }
    return options;
}
