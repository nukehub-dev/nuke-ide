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

import { describe, expect, it } from 'vitest';
import type { RegionManifestData, RegionManifestSurface, RegionManifestVolume } from './nuke-cad-protocol';
import { buildTopologyRegions, diffTopology, type TopologyBuildSnapshot } from './topology-impact';

function manifest(volumes: RegionManifestVolume[], surfaces: RegionManifestSurface[] = []): RegionManifestData {
    return { version: 1, volumes, surfaces };
}

function snapshot(overrides: Partial<TopologyBuildSnapshot> = {}): TopologyBuildSnapshot {
    return { solidCount: 1, faceCount: 1, triangleCount: 1, ...overrides };
}

describe('buildTopologyRegions', () => {
    it('sorts by kind then selector and keeps solid ids ascending', () => {
        const regions = buildTopologyRegions(
            snapshot({
                selectorMap: { zeta: [3, 1, 2], alpha: [4] },
                regionManifest: manifest(
                    [
                        { selector: 'zeta', name: 'Zeta', material: 'steel' },
                        { selector: 'alpha', name: 'Alpha', material: 'water' }
                    ],
                    [{ selector: 'top', name: 'Top' }, { selector: 'side' }]
                )
            })
        );

        expect(regions.map((region) => `${region.kind}:${region.selector}`)).toEqual([
            'surface:side',
            'surface:top',
            'volume:alpha',
            'volume:zeta'
        ]);
        expect(regions.map((region) => region.group)).toEqual(['side', 'Top', 'Alpha', 'Zeta']);
        expect(regions.map((region) => region.solidIds)).toEqual([[], [], [4], [1, 2, 3]]);
        expect(regions[2].name).toBe('Alpha');
        expect(regions[2].material).toBe('water');
    });

    it('keeps manifest volumes without selector entries and surfaces without solid ids', () => {
        const regions = buildTopologyRegions(
            snapshot({
                selectorMap: { covered: [1] },
                regionManifest: manifest(
                    [
                        { selector: 'covered', name: 'Covered' },
                        { selector: 'orphan', name: 'Orphan' }
                    ],
                    [{ selector: 'wall', name: 'Wall' }]
                )
            })
        );

        expect(regions).toEqual([
            { kind: 'surface', selector: 'wall', group: 'Wall', name: 'Wall', solidIds: [] },
            { kind: 'volume', selector: 'covered', group: 'Covered', name: 'Covered', solidIds: [1] },
            { kind: 'volume', selector: 'orphan', group: 'Orphan', name: 'Orphan', solidIds: [] }
        ]);
    });

    it('falls back to the selector when the manifest has no name', () => {
        const regions = buildTopologyRegions(snapshot({ selectorMap: { loose: [2] } }));

        expect(regions).toEqual([{ kind: 'volume', selector: 'loose', group: 'loose', solidIds: [2] }]);
    });

    it('returns no regions without a selector map or manifest', () => {
        expect(buildTopologyRegions(snapshot())).toEqual([]);
    });
});

describe('diffTopology', () => {
    it('reports no change for identical snapshots', () => {
        const before = snapshot({
            solidCount: 2,
            faceCount: 20,
            triangleCount: 200,
            selectorMap: { fuel: [1], clad: [2] },
            regionManifest: manifest([
                { selector: 'fuel', name: 'fuel', material: 'UO2' },
                { selector: 'clad', name: 'clad', material: 'Zircaloy' }
            ])
        });

        const impact = diffTopology(before, before);

        expect(impact.solids).toEqual({ before: 2, after: 2 });
        expect(impact.faces).toEqual({ before: 20, after: 20 });
        expect(impact.triangles).toEqual({ before: 200, after: 200 });
        expect(impact.addedSolidIds).toEqual([]);
        expect(impact.removedSolidIds).toEqual([]);
        expect(impact.changedSolidIds).toEqual([]);
        expect(impact.addedRegions).toEqual([]);
        expect(impact.removedRegions).toEqual([]);
        expect(impact.changedRegions).toEqual([]);
        expect(impact.addedGroups).toEqual([]);
        expect(impact.removedGroups).toEqual([]);
        expect(impact.selectorMapChanged).toBe(false);
        expect(impact.regionCoverageChanged).toBe(false);
        expect(impact.requiresAcknowledgement).toBe(false);
    });

    it('reports a pattern count change as a changed region with a grown solid list', () => {
        const before = snapshot({
            solidCount: 3,
            faceCount: 30,
            triangleCount: 300,
            selectorMap: { blade: [1, 2, 3] },
            regionManifest: manifest([{ selector: 'blade', name: 'Blade', material: 'steel' }])
        });
        const after = snapshot({
            solidCount: 4,
            faceCount: 40,
            triangleCount: 400,
            selectorMap: { blade: [1, 2, 3, 4] },
            regionManifest: manifest([{ selector: 'blade', name: 'Blade', material: 'steel' }])
        });

        const impact = diffTopology(before, after, { addedSolidIds: [4], removedSolidIds: [], changedSolidIds: [] });

        expect(impact.addedSolidIds).toEqual([4]);
        expect(impact.selectorMapChanged).toBe(true);
        expect(impact.regionCoverageChanged).toBe(false);
        expect(impact.requiresAcknowledgement).toBe(true);
        expect(impact.changedRegions).toEqual([
            {
                selector: 'blade',
                group: 'Blade',
                beforeGroup: 'Blade',
                afterGroup: 'Blade',
                beforeSolidIds: [1, 2, 3],
                afterSolidIds: [1, 2, 3, 4],
                beforeMaterial: 'steel',
                afterMaterial: 'steel'
            }
        ]);
        expect(impact.addedGroups).toEqual([]);
        expect(impact.removedGroups).toEqual([]);
    });

    it('reports added and removed region selectors', () => {
        const before = snapshot({
            selectorMap: { fuel: [1] },
            regionManifest: manifest([{ selector: 'fuel', name: 'Fuel', material: 'UO2' }])
        });
        const after = snapshot({
            solidCount: 2,
            selectorMap: { fuel: [1], clad: [2] },
            regionManifest: manifest([
                { selector: 'fuel', name: 'Fuel', material: 'UO2' },
                { selector: 'clad', name: 'Clad', material: 'Zircaloy' }
            ])
        });

        const added = diffTopology(before, after);

        expect(added.addedRegions).toEqual([
            { kind: 'volume', selector: 'clad', group: 'Clad', name: 'Clad', material: 'Zircaloy', solidIds: [2] }
        ]);
        expect(added.removedRegions).toEqual([]);
        expect(added.addedGroups).toEqual(['Clad']);
        expect(added.removedGroups).toEqual([]);
        expect(added.regionCoverageChanged).toBe(true);
        expect(added.requiresAcknowledgement).toBe(true);

        const removed = diffTopology(after, before);

        expect(removed.removedRegions).toEqual([
            { kind: 'volume', selector: 'clad', group: 'Clad', name: 'Clad', material: 'Zircaloy', solidIds: [2] }
        ]);
        expect(removed.addedRegions).toEqual([]);
        expect(removed.addedGroups).toEqual([]);
        expect(removed.removedGroups).toEqual(['Clad']);
        expect(removed.regionCoverageChanged).toBe(true);
    });

    it('reports a renamed manifest name as a group change', () => {
        const before = snapshot({
            selectorMap: { fuel: [1] },
            regionManifest: manifest([{ selector: 'fuel', name: 'fuel', material: 'UO2' }])
        });
        const after = snapshot({
            selectorMap: { fuel: [1] },
            regionManifest: manifest([{ selector: 'fuel', name: 'fuel_hot', material: 'UO2' }])
        });

        const impact = diffTopology(before, after);

        expect(impact.changedRegions).toEqual([
            {
                selector: 'fuel',
                group: 'fuel_hot',
                beforeGroup: 'fuel',
                afterGroup: 'fuel_hot',
                beforeSolidIds: [1],
                afterSolidIds: [1],
                beforeMaterial: 'UO2',
                afterMaterial: 'UO2'
            }
        ]);
        expect(impact.addedGroups).toEqual(['fuel_hot']);
        expect(impact.removedGroups).toEqual(['fuel']);
        expect(impact.regionCoverageChanged).toBe(true);
        expect(impact.requiresAcknowledgement).toBe(true);
    });

    it('reports material and material-id changes as coverage changes', () => {
        const before = snapshot({
            selectorMap: { fuel: [1] },
            regionManifest: manifest([
                { selector: 'fuel', name: 'fuel', material: 'UO2', materialId: 'material-a' } as RegionManifestVolume & {
                    materialId: string;
                }
            ])
        });
        const after = snapshot({
            selectorMap: { fuel: [1] },
            regionManifest: manifest([
                { selector: 'fuel', name: 'fuel', material: 'MOX', materialId: 'material-b' } as RegionManifestVolume & {
                    materialId: string;
                }
            ])
        });

        const impact = diffTopology(before, after);

        expect(impact.changedRegions).toHaveLength(1);
        expect(impact.changedRegions[0]).toMatchObject({ beforeMaterial: 'UO2', afterMaterial: 'MOX' });
        expect(impact.regionCoverageChanged).toBe(true);
        expect(impact.requiresAcknowledgement).toBe(true);
    });

    it('handles missing manifests and selector maps as empty', () => {
        const before = snapshot({ solidCount: 2, selectorMap: { fuel: [1] } });
        const after = snapshot({ solidCount: 1, regionManifest: manifest([{ selector: 'clad', name: 'Clad' }]) });

        const impact = diffTopology(before, after);

        expect(impact.removedRegions).toEqual([{ kind: 'volume', selector: 'fuel', group: 'fuel', solidIds: [1] }]);
        expect(impact.addedRegions).toEqual([{ kind: 'volume', selector: 'clad', group: 'Clad', name: 'Clad', solidIds: [] }]);
        expect(impact.selectorMapChanged).toBe(true);
        expect(impact.regionCoverageChanged).toBe(true);
        expect(impact.requiresAcknowledgement).toBe(true);

        const empty = diffTopology(snapshot(), snapshot());
        expect(empty.requiresAcknowledgement).toBe(false);
        expect(empty.selectorMapChanged).toBe(false);
    });

    it('normalizes selector-map key order and solid-id order semantically', () => {
        const before = snapshot({ solidCount: 2, selectorMap: { zeta: [2], alpha: [3, 1] } });
        const after = snapshot({ solidCount: 2, selectorMap: { alpha: [1, 3], zeta: [2] } });

        const impact = diffTopology(before, after);

        expect(impact.selectorMapChanged).toBe(false);
        expect(impact.changedRegions).toEqual([]);
        expect(impact.regionCoverageChanged).toBe(false);
        expect(impact.requiresAcknowledgement).toBe(false);
    });

    it('treats a missing selector map as an empty one', () => {
        const impact = diffTopology(snapshot(), snapshot({ selectorMap: {} }));

        expect(impact.selectorMapChanged).toBe(false);
        expect(impact.requiresAcknowledgement).toBe(false);
    });

    it('reports surface name changes and ignores surface solids', () => {
        const before = snapshot({ regionManifest: manifest([], [{ selector: 'wall', name: 'Wall' }]) });
        const after = snapshot({ regionManifest: manifest([], [{ selector: 'wall', name: 'Outer wall' }]) });

        const impact = diffTopology(before, after);

        expect(impact.changedRegions).toEqual([
            {
                selector: 'wall',
                group: 'Outer wall',
                beforeGroup: 'Wall',
                afterGroup: 'Outer wall',
                beforeSolidIds: [],
                afterSolidIds: []
            }
        ]);
        expect(impact.addedGroups).toEqual(['Outer wall']);
        expect(impact.removedGroups).toEqual(['Wall']);
        expect(impact.regionCoverageChanged).toBe(true);
        expect(impact.requiresAcknowledgement).toBe(true);
    });

    it('sorts added regions deterministically', () => {
        const before = snapshot({ selectorMap: {} });
        const after = snapshot({
            solidCount: 3,
            selectorMap: { zeta: [3], alpha: [1] },
            regionManifest: manifest([{ selector: 'middle', name: 'Middle' }])
        });

        const impact = diffTopology(before, after);

        expect(impact.addedRegions.map((region) => region.selector)).toEqual(['alpha', 'middle', 'zeta']);
        expect(impact.addedGroups).toEqual(['Middle', 'alpha', 'zeta']);
    });

    it('requires acknowledgement for count changes without a solid delta', () => {
        const impact = diffTopology(snapshot({ solidCount: 1 }), snapshot({ solidCount: 2 }));

        expect(impact.addedSolidIds).toEqual([]);
        expect(impact.removedSolidIds).toEqual([]);
        expect(impact.changedSolidIds).toEqual([]);
        expect(impact.regionCoverageChanged).toBe(false);
        expect(impact.requiresAcknowledgement).toBe(true);
    });
});
