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
 * Structured topology and region impact between two CAD builds.
 *
 * Solid ids are positional and may shuffle between builds, so the solid delta
 * comes from a body-aware comparison made by the caller. Region identity is the
 * manifest selector; the DAGMC group is the manifest name (falling back to the
 * selector) so downstream material references can be matched without reading
 * the `.h5m` file.
 *
 * Pure module (no Theia, no three.js) so the comparison stays vitest-coverable.
 *
 * @module nuke-cad/common
 */

import type { RegionManifestData, RegionManifestVolume } from './nuke-cad-protocol';

/** Build facts needed to describe the region set of one geometry build. */
export interface TopologyBuildSnapshot {
    readonly solidCount: number;
    readonly faceCount: number;
    readonly triangleCount: number;
    readonly selectorMap?: Readonly<Record<string, readonly number[]>>;
    readonly regionManifest?: RegionManifestData;
}

/** A manifest region as it participates in a DAGMC/OpenMC reference. */
export interface TopologyRegionRef {
    readonly kind: 'volume' | 'surface';
    readonly selector: string;
    /** DAGMC group suffix: manifest name ?? selector. */
    readonly group: string;
    readonly name?: string;
    readonly material?: string;
    readonly materialId?: string;
    readonly solidIds: readonly number[];
}

/** Positional solid changes supplied by a body-aware comparison. */
export interface TopologySolidDelta {
    readonly addedSolidIds: readonly number[];
    readonly removedSolidIds: readonly number[];
    readonly changedSolidIds: readonly number[];
}

/** A region whose identity or solid coverage changed between builds. */
export interface TopologyChangedRegion {
    readonly selector: string;
    readonly group: string;
    readonly beforeGroup: string;
    readonly afterGroup: string;
    readonly beforeSolidIds: readonly number[];
    readonly afterSolidIds: readonly number[];
    readonly beforeMaterial?: string;
    readonly afterMaterial?: string;
}

/** Complete topology and region impact of one build pair. */
export interface TopologyImpact {
    readonly solids: { readonly before: number; readonly after: number };
    readonly faces: { readonly before: number; readonly after: number };
    readonly triangles: { readonly before: number; readonly after: number };
    readonly addedSolidIds: readonly number[];
    readonly removedSolidIds: readonly number[];
    readonly changedSolidIds: readonly number[];
    readonly addedRegions: readonly TopologyRegionRef[];
    readonly removedRegions: readonly TopologyRegionRef[];
    readonly changedRegions: readonly TopologyChangedRegion[];
    readonly addedGroups: readonly string[];
    readonly removedGroups: readonly string[];
    readonly selectorMapChanged: boolean;
    readonly regionCoverageChanged: boolean;
    readonly requiresAcknowledgement: boolean;
}

/** Manifest volume entries may carry an optional physical-model material UUID. */
type ManifestVolumeWithMaterial = RegionManifestVolume & { readonly materialId?: unknown };

const EMPTY_SOLID_DELTA: TopologySolidDelta = {
    addedSolidIds: [],
    removedSolidIds: [],
    changedSolidIds: []
};

function compareStrings(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

function optionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sortedIds(ids: readonly number[] | undefined): number[] {
    return [...(ids ?? [])].sort((left, right) => left - right);
}

function sameNumberList(left: readonly number[], right: readonly number[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function regionKey(region: Pick<TopologyRegionRef, 'kind' | 'selector'>): string {
    return `${region.kind}:${region.selector}`;
}

function compareRegionRefs(left: TopologyRegionRef, right: TopologyRegionRef): number {
    return compareStrings(left.kind, right.kind) || compareStrings(left.selector, right.selector);
}

function volumeRegion(selector: string, entry: RegionManifestVolume | undefined, solidIds: readonly number[]): TopologyRegionRef {
    const name = entry ? optionalText(entry.name) : undefined;
    const material = entry ? optionalText(entry.material) : undefined;
    const materialId = entry ? optionalText((entry as ManifestVolumeWithMaterial).materialId) : undefined;
    return {
        kind: 'volume',
        selector,
        group: name ?? selector,
        ...(name !== undefined ? { name } : {}),
        ...(material !== undefined ? { material } : {}),
        ...(materialId !== undefined ? { materialId } : {}),
        solidIds: sortedIds(solidIds)
    };
}

function regionsEqual(before: TopologyRegionRef, after: TopologyRegionRef): boolean {
    return (
        before.group === after.group &&
        before.material === after.material &&
        before.materialId === after.materialId &&
        sameNumberList(before.solidIds, after.solidIds)
    );
}

function groupSet(regions: readonly TopologyRegionRef[]): Set<string> {
    const groups = new Set<string>();
    for (const region of regions) {
        groups.add(region.group);
    }
    return groups;
}

/** Stable semantic form of a selector map: sorted selectors and sorted solid ids. */
function normalizeSelectorMap(map: Readonly<Record<string, readonly number[]>> | undefined): string {
    if (!map) {
        return '[]';
    }
    return JSON.stringify(
        Object.keys(map)
            .sort(compareStrings)
            .map((selector) => [selector, sortedIds(map[selector])])
    );
}

function finiteCount(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

/**
 * Build the region references of one snapshot.
 *
 * Selector-map entries become volumes with their 1-based solid ids. Manifest
 * volumes without a selector-map entry remain visible with no solid coverage,
 * and manifest surfaces are always listed. Results sort by `(kind, selector)`;
 * `solidIds` sort numerically.
 *
 * @param snapshot - Build counts plus the selector map and region manifest.
 * @returns Sorted, immutable region references.
 */
export function buildTopologyRegions(snapshot: TopologyBuildSnapshot): readonly TopologyRegionRef[] {
    const manifest = snapshot.regionManifest;
    const manifestVolumes = new Map<string, RegionManifestVolume>();
    for (const entry of manifest?.volumes ?? []) {
        if (!manifestVolumes.has(entry.selector)) {
            manifestVolumes.set(entry.selector, entry);
        }
    }

    const volumes = new Map<string, TopologyRegionRef>();
    const selectorMap = snapshot.selectorMap;
    if (selectorMap) {
        for (const selector of Object.keys(selectorMap)) {
            volumes.set(selector, volumeRegion(selector, manifestVolumes.get(selector), selectorMap[selector] ?? []));
        }
    }
    for (const [selector, entry] of manifestVolumes) {
        if (!volumes.has(selector)) {
            volumes.set(selector, volumeRegion(selector, entry, []));
        }
    }

    const surfaces: TopologyRegionRef[] = [];
    const surfaceSelectors = new Set<string>();
    for (const entry of manifest?.surfaces ?? []) {
        if (surfaceSelectors.has(entry.selector)) {
            continue;
        }
        surfaceSelectors.add(entry.selector);
        const name = optionalText(entry.name);
        surfaces.push({
            kind: 'surface',
            selector: entry.selector,
            group: name ?? entry.selector,
            ...(name !== undefined ? { name } : {}),
            solidIds: []
        });
    }

    return [...surfaces, ...volumes.values()].sort(compareRegionRefs);
}

/**
 * Diff two build snapshots into a structured topology and region impact.
 *
 * Region identity keys use `kind:selector`. A region changes when its DAGMC
 * group, material, material id, or solid coverage differs. Added and removed
 * groups are set differences, so a renamed group appears in both lists.
 *
 * @param before - Snapshot of the current build.
 * @param after - Snapshot of the candidate build.
 * @param solids - Positional solid delta from a body-aware comparison.
 * @returns Counts, solid ids, region changes, and the acknowledgement gate.
 */
export function diffTopology(
    before: TopologyBuildSnapshot,
    after: TopologyBuildSnapshot,
    solids: TopologySolidDelta = EMPTY_SOLID_DELTA
): TopologyImpact {
    const beforeRegions = buildTopologyRegions(before);
    const afterRegions = buildTopologyRegions(after);
    const beforeByKey = new Map<string, TopologyRegionRef>();
    for (const region of beforeRegions) {
        beforeByKey.set(regionKey(region), region);
    }
    const afterByKey = new Map<string, TopologyRegionRef>();
    for (const region of afterRegions) {
        afterByKey.set(regionKey(region), region);
    }

    const addedRegions = afterRegions.filter((region) => !beforeByKey.has(regionKey(region)));
    const removedRegions = beforeRegions.filter((region) => !afterByKey.has(regionKey(region)));
    const changedRegions: TopologyChangedRegion[] = [];
    let regionCoverageChanged = addedRegions.length > 0 || removedRegions.length > 0;

    for (const afterRegion of afterRegions) {
        const beforeRegion = beforeByKey.get(regionKey(afterRegion));
        if (!beforeRegion || regionsEqual(beforeRegion, afterRegion)) {
            continue;
        }
        changedRegions.push({
            selector: afterRegion.selector,
            group: afterRegion.group,
            beforeGroup: beforeRegion.group,
            afterGroup: afterRegion.group,
            beforeSolidIds: beforeRegion.solidIds,
            afterSolidIds: afterRegion.solidIds,
            ...(beforeRegion.material !== undefined ? { beforeMaterial: beforeRegion.material } : {}),
            ...(afterRegion.material !== undefined ? { afterMaterial: afterRegion.material } : {})
        });
        if (
            beforeRegion.group !== afterRegion.group ||
            beforeRegion.material !== afterRegion.material ||
            beforeRegion.materialId !== afterRegion.materialId
        ) {
            regionCoverageChanged = true;
        }
    }

    const beforeGroups = groupSet(beforeRegions);
    const afterGroups = groupSet(afterRegions);
    const addedGroups = [...afterGroups].filter((group) => !beforeGroups.has(group)).sort(compareStrings);
    const removedGroups = [...beforeGroups].filter((group) => !afterGroups.has(group)).sort(compareStrings);

    const selectorMapChanged = normalizeSelectorMap(before.selectorMap) !== normalizeSelectorMap(after.selectorMap);
    const addedSolidIds = [...(solids.addedSolidIds ?? [])];
    const removedSolidIds = [...(solids.removedSolidIds ?? [])];
    const changedSolidIds = [...(solids.changedSolidIds ?? [])];
    const beforeSolids = finiteCount(before.solidCount);
    const afterSolids = finiteCount(after.solidCount);
    const beforeFaces = finiteCount(before.faceCount);
    const afterFaces = finiteCount(after.faceCount);
    const beforeTriangles = finiteCount(before.triangleCount);
    const afterTriangles = finiteCount(after.triangleCount);

    const requiresAcknowledgement =
        beforeSolids !== afterSolids ||
        beforeFaces !== afterFaces ||
        beforeTriangles !== afterTriangles ||
        addedSolidIds.length > 0 ||
        removedSolidIds.length > 0 ||
        changedSolidIds.length > 0 ||
        addedRegions.length > 0 ||
        removedRegions.length > 0 ||
        changedRegions.length > 0 ||
        selectorMapChanged ||
        regionCoverageChanged;

    return {
        solids: { before: beforeSolids, after: afterSolids },
        faces: { before: beforeFaces, after: afterFaces },
        triangles: { before: beforeTriangles, after: afterTriangles },
        addedSolidIds,
        removedSolidIds,
        changedSolidIds,
        addedRegions,
        removedRegions,
        changedRegions,
        addedGroups,
        removedGroups,
        selectorMapChanged,
        regionCoverageChanged,
        requiresAcknowledgement
    };
}
