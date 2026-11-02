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
 * Read-only matching of CAD region references against an OpenMC DAGMC project.
 *
 * Only stable project fields are read: the DAGMC file path, the DAGMC material
 * group names and volumes, and the material names plus nuke-cad provenance
 * ids. The `.h5m` file itself is never opened and nothing is mutated.
 *
 * @module nuke-cad/common
 */

import type { TopologyImpact, TopologyRegionRef } from './topology-impact';

/** Read-only facts extracted from one saved `.nuke-openmc` project file. */
export interface OpenmcReferenceSnapshot {
    readonly status: 'saved-project' | 'no-saved-project' | 'missing-project-file' | 'unreadable-project' | 'invalid-project';
    readonly projectPath?: string;
    readonly dagmcFile?: string;
    readonly dagmcGroups: readonly string[];
    readonly materialNames: readonly string[];
    readonly materialIds: readonly string[];
    readonly warnings: readonly string[];
}

/** One downstream reference that a removed/changed CAD region would break. */
export interface OpenmcRegionBlocker {
    readonly region: TopologyRegionRef;
    readonly reference: string;
    readonly kind: 'dagmc-group' | 'material' | 'material-id';
    readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const text = value.trim();
    return text.length > 0 ? text : undefined;
}

function nonEmpty(value: string | undefined): value is string {
    return value !== undefined && value.length > 0;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Normalize a DAGMC group reference for comparison.
 *
 * Trims surrounding whitespace and removes a leading `mat:` tag prefix, so
 * `mat:fuel` and `fuel` refer to the same material group. Case is preserved
 * because MOAB group names are case-sensitive.
 *
 * @param value - Raw group name or tag value.
 * @returns The bare group name.
 */
export function normalizeDagmcGroup(value: string): string {
    const text = value.trim();
    return /^mat:/i.test(text) ? text.slice(4).trim() : text;
}

function invalidSnapshot(projectPath: string, warning: string): OpenmcReferenceSnapshot {
    return {
        status: 'invalid-project',
        projectPath,
        dagmcGroups: [],
        materialNames: [],
        materialIds: [],
        warnings: [warning]
    };
}

function projectState(root: Record<string, unknown>): Record<string, unknown> | undefined {
    if ('state' in root) {
        return isRecord(root.state) ? root.state : undefined;
    }
    return root;
}

/**
 * Parse stable DAGMC and material references from a project JSON payload.
 *
 * Accepts both the current `{ version, state }` wrapper and a raw state object
 * written by older builds. Unknown schema versions are tolerated; malformed
 * JSON and non-object payloads return `invalid-project` instead of throwing.
 *
 * @param projectPath - Path of the project file the payload came from.
 * @param json - Raw project file text.
 * @returns The parsed reference snapshot.
 */
export function parseOpenmcRegionReferences(projectPath: string, json: string): OpenmcReferenceSnapshot {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch (error) {
        return invalidSnapshot(projectPath, `OpenMC project '${projectPath}' is not valid JSON: ${errorText(error)}`);
    }
    if (!isRecord(parsed)) {
        return invalidSnapshot(projectPath, `OpenMC project '${projectPath}' does not contain a JSON object.`);
    }
    const state = projectState(parsed);
    if (!state) {
        return invalidSnapshot(projectPath, `OpenMC project '${projectPath}' has no readable state object.`);
    }

    const settings = isRecord(state.settings) ? state.settings : undefined;
    const dagmcInfo = settings && isRecord(settings.dagmcInfo) ? settings.dagmcInfo : undefined;
    const dagmcFile = trimmed(settings?.dagmcFile) ?? trimmed(dagmcInfo?.filePath);

    const dagmcGroups: string[] = [];
    const seenGroups = new Set<string>();
    const addGroup = (value: unknown): void => {
        if (typeof value !== 'string') {
            return;
        }
        const group = normalizeDagmcGroup(value);
        if (group.length === 0 || group.toLowerCase() === 'graveyard' || seenGroups.has(group)) {
            return;
        }
        seenGroups.add(group);
        dagmcGroups.push(group);
    };
    if (dagmcInfo && isRecord(dagmcInfo.materials)) {
        for (const name of Object.keys(dagmcInfo.materials)) {
            addGroup(name);
        }
    }
    if (dagmcInfo && Array.isArray(dagmcInfo.volumes)) {
        for (const volume of dagmcInfo.volumes) {
            if (isRecord(volume)) {
                addGroup(volume.material);
            }
        }
    }

    const materialNames: string[] = [];
    const materialIds: string[] = [];
    const seenNames = new Set<string>();
    const seenIds = new Set<string>();
    const materials = Array.isArray(state.materials) ? state.materials : [];
    for (const material of materials) {
        if (!isRecord(material)) {
            continue;
        }
        const name = trimmed(material.name);
        if (name !== undefined && name.toLowerCase() === 'graveyard') {
            continue;
        }
        if (name !== undefined && !seenNames.has(name)) {
            seenNames.add(name);
            materialNames.push(name);
        }
        const id = trimmed(material.nukeCadMaterialId);
        if (id !== undefined && id.toLowerCase() !== 'graveyard' && !seenIds.has(id)) {
            seenIds.add(id);
            materialIds.push(id);
        }
    }

    return {
        status: 'saved-project',
        projectPath,
        ...(dagmcFile !== undefined ? { dagmcFile } : {}),
        dagmcGroups,
        materialNames,
        materialIds,
        warnings: []
    };
}

/**
 * Find OpenMC references that removed or renamed CAD regions would break.
 *
 * Volumes only: surfaces carry no DAGMC material groups. A group, material
 * name, or material id blocks only when the project still references it and no
 * after region retains the same key. Results dedupe by
 * `selector + reference + kind`.
 *
 * @param impact - Removed and changed regions from {@link diffTopology}.
 * @param afterRegions - Region references of the candidate build.
 * @param snapshot - References parsed from the active project.
 * @returns Blockers in removed-then-changed order.
 */
export function findOpenmcRegionBlockers(
    impact: Pick<TopologyImpact, 'removedRegions' | 'changedRegions'>,
    afterRegions: readonly TopologyRegionRef[],
    snapshot: OpenmcReferenceSnapshot
): readonly OpenmcRegionBlocker[] {
    if (snapshot.status !== 'saved-project') {
        return [];
    }

    const groups = new Set(snapshot.dagmcGroups.map(normalizeDagmcGroup).filter(nonEmpty));
    const materialNames = new Set(snapshot.materialNames.map((name) => name.trim()).filter(nonEmpty));
    const materialIds = new Set(snapshot.materialIds.map((id) => id.trim()).filter(nonEmpty));

    const afterVolumes = afterRegions.filter((region) => region.kind === 'volume');
    const afterGroups = new Set(afterVolumes.map((region) => normalizeDagmcGroup(region.group)).filter(nonEmpty));
    const afterMaterialNames = new Set(afterVolumes.map((region) => region.material?.trim()).filter(nonEmpty));
    const afterMaterialIds = new Set(afterVolumes.map((region) => region.materialId?.trim()).filter(nonEmpty));

    const blockers: OpenmcRegionBlocker[] = [];
    const seen = new Set<string>();
    const add = (region: TopologyRegionRef, reference: string, kind: OpenmcRegionBlocker['kind'], message: string): void => {
        const key = `${region.selector}\u0000${reference}\u0000${kind}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        blockers.push({ region, reference, kind, message });
    };

    const checkRegion = (region: TopologyRegionRef, group: string, material: string | undefined, materialId: string | undefined): void => {
        const normalizedGroup = normalizeDagmcGroup(group);
        if (normalizedGroup.length > 0 && groups.has(normalizedGroup) && !afterGroups.has(normalizedGroup)) {
            const materialName = material?.trim();
            const message =
                materialName !== undefined && materialName.length > 0
                    ? `OpenMC material '${materialName}' still references DAGMC group '${normalizedGroup}'.`
                    : `OpenMC still references DAGMC group '${normalizedGroup}' from region '${region.selector}'.`;
            add(region, normalizedGroup, 'dagmc-group', message);
        }

        const materialName = material?.trim();
        if (materialName !== undefined && materialNames.has(materialName) && !afterMaterialNames.has(materialName)) {
            add(region, materialName, 'material', `OpenMC material '${materialName}' still references region '${region.selector}'.`);
        }

        const id = materialId?.trim();
        if (id !== undefined && materialIds.has(id) && !afterMaterialIds.has(id)) {
            add(region, id, 'material-id', `OpenMC material with nuke-cad id '${id}' still references region '${region.selector}'.`);
        }
    };

    for (const region of impact.removedRegions) {
        if (region.kind !== 'volume') {
            continue;
        }
        checkRegion(region, region.group, region.material, region.materialId);
    }

    for (const changed of impact.changedRegions) {
        if (changed.beforeGroup === changed.afterGroup && changed.beforeMaterial === changed.afterMaterial) {
            continue;
        }
        const beforeRegion: TopologyRegionRef = {
            kind: 'volume',
            selector: changed.selector,
            group: changed.beforeGroup,
            ...(changed.beforeMaterial !== undefined ? { material: changed.beforeMaterial } : {}),
            solidIds: changed.beforeSolidIds
        };
        checkRegion(beforeRegion, changed.beforeGroup, changed.beforeMaterial, undefined);
    }

    return blockers;
}
