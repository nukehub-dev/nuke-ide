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
 * Volume/material/group toggle model for the native DAGMC viewer (P2-C2).
 *
 * Replaces the trame volume-select/group autocomplete in `dagmc_viz.py`:
 * the backend keeps serving `get_dagmc_model_info` JSON (`dagmc.info`
 * command — volumes with id/material/triangle counts, materials and groups
 * with their volume membership), and this module turns that payload plus a
 * small immutable visibility state into per-volume visibility decisions the
 * widget applies by showing/hiding already-loaded blocks. No server restart,
 * no `ExtractBlock` round-trip.
 *
 * Pure functions + types only; no trame, no vuetify, no DOM.
 */

/** One DAGMC volume as reported by `get_dagmc_model_info`. */
export interface DagmcVolumeMeta {
    readonly id: number;
    readonly material: string;
    readonly numTriangles: number;
    readonly numSurfaces: number;
    /** `[xmin, xmax, ymin, ymax, zmin, zmax]`, or null when unavailable. */
    readonly boundingBox: readonly [number, number, number, number, number, number] | null;
}

/** Material entry: member volumes of one material. */
export interface DagmcMaterialMeta {
    readonly volumeCount: number;
    readonly volumeIds: number[];
}

/** Group entry: member volumes of one DAGMC group. */
export interface DagmcGroupMeta {
    readonly volumeCount: number;
    readonly volumeIds: number[];
}

/** Validated subset of the `get_dagmc_model_info` payload the viewer needs. */
export interface DagmcModelInfo {
    readonly volumes: DagmcVolumeMeta[];
    readonly materials: Record<string, DagmcMaterialMeta>;
    readonly groups: Record<string, DagmcGroupMeta>;
}

/**
 * Visibility state: hidden-sets plus the graveyard switch. Everything is
 * visible by default except graveyard volumes (the client-side equivalent
 * of the converter's `include_graveyard=False` default and the
 * `filter_graveyard` pass).
 */
export interface DagmcVisibility {
    readonly hiddenVolumes: readonly number[];
    readonly hiddenMaterials: readonly string[];
    readonly hiddenGroups: readonly string[];
    readonly showGraveyard: boolean;
}

/** Fresh default visibility: nothing hidden, graveyard off. */
export function createDefaultDagmcVisibility(): DagmcVisibility {
    return { hiddenVolumes: [], hiddenMaterials: [], hiddenGroups: [], showGraveyard: false };
}

/** True for the `Graveyard` termination material (case-insensitive). */
export function isGraveyardMaterial(material: string): boolean {
    return material.toLowerCase() === 'graveyard';
}

/** Volume ids hidden because their material is the graveyard and it is switched off. */
export function graveyardVolumeIds(info: DagmcModelInfo): number[] {
    return info.volumes.filter((volume) => isGraveyardMaterial(volume.material)).map((volume) => volume.id);
}

/** Names of the groups containing `volumeId` (empty when in no group). */
export function groupsOfVolume(info: DagmcModelInfo, volumeId: number): string[] {
    return Object.entries(info.groups)
        .filter(([, group]) => group.volumeIds.includes(volumeId))
        .map(([name]) => name);
}

/**
 * Effective visibility of one volume: hidden when toggled off directly, when
 * its material is toggled off, when the graveyard switch excludes it, or
 * when every group containing it is toggled off (volumes in no group are
 * unaffected by group toggles). Unknown ids are never visible.
 */
export function isDagmcVolumeVisible(visibility: DagmcVisibility, info: DagmcModelInfo, volumeId: number): boolean {
    const volume = info.volumes.find((entry) => entry.id === volumeId);
    if (!volume) {
        return false;
    }
    if (!visibility.showGraveyard && isGraveyardMaterial(volume.material)) {
        return false;
    }
    if (visibility.hiddenVolumes.includes(volumeId)) {
        return false;
    }
    if (visibility.hiddenMaterials.includes(volume.material)) {
        return false;
    }
    const groups = groupsOfVolume(info, volumeId);
    if (groups.length > 0 && groups.every((name) => visibility.hiddenGroups.includes(name))) {
        return false;
    }
    return true;
}

/** Ids of all currently visible volumes, in model order. */
export function visibleDagmcVolumeIds(visibility: DagmcVisibility, info: DagmcModelInfo): number[] {
    return info.volumes.filter((volume) => isDagmcVolumeVisible(visibility, info, volume.id)).map((volume) => volume.id);
}

/** Count of currently visible volumes. */
export function countVisibleDagmcVolumes(visibility: DagmcVisibility, info: DagmcModelInfo): number {
    return visibleDagmcVolumeIds(visibility, info).length;
}

function toggleEntry<T>(entries: readonly T[], entry: T): T[] {
    return entries.includes(entry) ? entries.filter((existing) => existing !== entry) : [...entries, entry];
}

/** Toggle one volume's hidden flag. */
export function toggleDagmcVolume(visibility: DagmcVisibility, volumeId: number): DagmcVisibility {
    return { ...visibility, hiddenVolumes: toggleEntry(visibility.hiddenVolumes, volumeId) };
}

/** Toggle one material's hidden flag (hides every volume of that material). */
export function toggleDagmcMaterial(visibility: DagmcVisibility, material: string): DagmcVisibility {
    return { ...visibility, hiddenMaterials: toggleEntry(visibility.hiddenMaterials, material) };
}

/** Toggle one group's hidden flag. */
export function toggleDagmcGroup(visibility: DagmcVisibility, group: string): DagmcVisibility {
    return { ...visibility, hiddenGroups: toggleEntry(visibility.hiddenGroups, group) };
}

/** Switch graveyard volumes on or off. */
export function setDagmcShowGraveyard(visibility: DagmcVisibility, show: boolean): DagmcVisibility {
    return { ...visibility, showGraveyard: show };
}

/** Clear every hidden-set (graveyard switch kept). */
export function showAllDagmc(visibility: DagmcVisibility): DagmcVisibility {
    return { ...visibility, hiddenVolumes: [], hiddenMaterials: [], hiddenGroups: [] };
}

/** Error thrown when a `dagmc.info` payload fails validation. */
export class DagmcModelInfoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DagmcModelInfoError';
    }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DagmcModelInfoError(`dagmc.info payload field '${field}' must be an object`);
    }
    return value as Record<string, unknown>;
}

function asNumber(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DagmcModelInfoError(`dagmc.info payload field '${field}' must be a finite number`);
    }
    return value;
}

function asString(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        throw new DagmcModelInfoError(`dagmc.info payload field '${field}' must be a string`);
    }
    return value;
}

function asNumberArray(value: unknown, field: string): number[] {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
        throw new DagmcModelInfoError(`dagmc.info payload field '${field}' must be an array of finite numbers`);
    }
    return value as number[];
}

function parseVolume(value: unknown, index: number): DagmcVolumeMeta {
    const entry = asRecord(value, `volumes[${index}]`);
    const id = asNumber(entry['id'], `volumes[${index}].id`);
    const material =
        entry['material'] === undefined || entry['material'] === null ? 'void' : asString(entry['material'], `volumes[${index}].material`);
    const numTriangles = entry['numTriangles'] === undefined ? 0 : asNumber(entry['numTriangles'], `volumes[${index}].numTriangles`);
    const numSurfaces = entry['numSurfaces'] === undefined ? 0 : asNumber(entry['numSurfaces'], `volumes[${index}].numSurfaces`);
    const rawBox = entry['boundingBox'];
    let boundingBox: DagmcVolumeMeta['boundingBox'] = null;
    if (rawBox !== undefined && rawBox !== null) {
        const numbers = asNumberArray(rawBox, `volumes[${index}].boundingBox`);
        if (numbers.length !== 6) {
            throw new DagmcModelInfoError(`dagmc.info payload field 'volumes[${index}].boundingBox' must have 6 entries`);
        }
        boundingBox = [numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]];
    }
    return { id, material, numTriangles, numSurfaces, boundingBox };
}

function parseMembership(value: unknown, field: string): { volumeCount: number; volumeIds: number[] } {
    const entry = asRecord(value, field);
    const volumeIds = asNumberArray(entry['volumeIds'], `${field}.volumeIds`);
    const volumeCount = entry['volumeCount'] === undefined ? volumeIds.length : asNumber(entry['volumeCount'], `${field}.volumeCount`);
    return { volumeCount, volumeIds };
}

/**
 * Validate an unknown JSON value as the `get_dagmc_model_info` shape the
 * viewer needs. Extra payload fields (`surfaces`, `fileInfo`) are ignored;
 * missing `materials`/`groups` default to empty maps.
 */
export function parseDagmcModelInfo(value: unknown): DagmcModelInfo {
    const root = asRecord(value, '<root>');
    if (!Array.isArray(root['volumes'])) {
        throw new DagmcModelInfoError("dagmc.info payload field 'volumes' must be an array");
    }
    const volumes = (root['volumes'] as unknown[]).map((entry, index) => parseVolume(entry, index));
    const materials: Record<string, DagmcMaterialMeta> = {};
    if (root['materials'] !== undefined) {
        for (const [name, entry] of Object.entries(asRecord(root['materials'], 'materials'))) {
            materials[name] = parseMembership(entry, `materials['${name}']`);
        }
    }
    const groups: Record<string, DagmcGroupMeta> = {};
    if (root['groups'] !== undefined) {
        for (const [name, entry] of Object.entries(asRecord(root['groups'], 'groups'))) {
            groups[name] = parseMembership(entry, `groups['${name}']`);
        }
    }
    return { volumes, materials, groups };
}
