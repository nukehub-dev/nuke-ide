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
 * Tests for the DAGMC volume/material/group toggle model: `dagmc.info`
 * payload validation and the visibility algebra over volumes, materials,
 * groups, and the graveyard switch.
 */

import { describe, expect, it } from 'vitest';
import {
    countVisibleDagmcVolumes,
    createDefaultDagmcVisibility,
    DagmcModelInfo,
    DagmcModelInfoError,
    graveyardVolumeIds,
    groupsOfVolume,
    hideAllDagmc,
    isDagmcVolumeVisible,
    isGraveyardMaterial,
    isolateDagmcVolume,
    parseDagmcModelInfo,
    setDagmcShowGraveyard,
    showAllDagmc,
    toggleDagmcGroup,
    toggleDagmcMaterial,
    toggleDagmcVolume,
    visibleDagmcVolumeIds
} from './dagmc-toggle-model';

function sampleInfo(): DagmcModelInfo {
    return parseDagmcModelInfo({
        volumes: [
            { id: 1, material: 'fuel', numTriangles: 100, numSurfaces: 2, boundingBox: [0, 1, 0, 1, 0, 1] },
            { id: 2, material: 'clad', numTriangles: 50, numSurfaces: 1, boundingBox: null },
            { id: 3, material: 'Graveyard', numTriangles: 12, numSurfaces: 1, boundingBox: null }
        ],
        materials: {
            fuel: { volumeCount: 1, volumeIds: [1] },
            clad: { volumeCount: 1, volumeIds: [2] },
            Graveyard: { volumeCount: 1, volumeIds: [3] }
        },
        groups: {
            core: { volumeCount: 2, volumeIds: [1, 2] },
            blanket: { volumeCount: 1, volumeIds: [2] }
        },
        surfaces: [],
        fileInfo: { name: 'tokamak.h5m' }
    });
}

describe('parseDagmcModelInfo', () => {
    it('accepts the get_dagmc_model_info shape and ignores extras', () => {
        const info = sampleInfo();
        expect(info.volumes).toHaveLength(3);
        expect(info.materials['fuel']).toEqual({ volumeCount: 1, volumeIds: [1] });
        expect(info.groups['core']?.volumeIds).toEqual([1, 2]);
        expect(info.volumes[0].boundingBox).toEqual([0, 1, 0, 1, 0, 1]);
        expect(info.volumes[1].boundingBox).toBeNull();
    });

    it('defaults missing materials/groups and void material', () => {
        const info = parseDagmcModelInfo({ volumes: [{ id: 7 }] });
        expect(info.materials).toEqual({});
        expect(info.groups).toEqual({});
        expect(info.volumes[0]).toMatchObject({ id: 7, material: 'void', numTriangles: 0, numSurfaces: 0, boundingBox: null });
    });

    it('rejects malformed payloads', () => {
        expect(() => parseDagmcModelInfo(undefined)).toThrow(DagmcModelInfoError);
        expect(() => parseDagmcModelInfo({ volumes: [{ id: 'one' }] })).toThrow(DagmcModelInfoError);
        expect(() => parseDagmcModelInfo({ volumes: [{ id: 1, boundingBox: [0, 1] }] })).toThrow(DagmcModelInfoError);
        expect(() => parseDagmcModelInfo({ volumes: 'nope' })).toThrow(DagmcModelInfoError);
        expect(() => parseDagmcModelInfo({ volumes: [], materials: [] })).toThrow(DagmcModelInfoError);
    });
});

describe('dagmc visibility', () => {
    it('hides graveyard volumes by default', () => {
        const info = sampleInfo();
        const visibility = createDefaultDagmcVisibility();
        expect(isGraveyardMaterial('Graveyard')).toBe(true);
        expect(isGraveyardMaterial('graveyard')).toBe(true);
        expect(isGraveyardMaterial('fuel')).toBe(false);
        expect(graveyardVolumeIds(info)).toEqual([3]);
        expect(visibleDagmcVolumeIds(visibility, info)).toEqual([1, 2]);
        expect(countVisibleDagmcVolumes(visibility, info)).toBe(2);
        expect(isDagmcVolumeVisible(setDagmcShowGraveyard(visibility, true), info, 3)).toBe(true);
    });

    it('toggles volumes, materials, and groups', () => {
        const info = sampleInfo();
        let visibility = createDefaultDagmcVisibility();
        visibility = toggleDagmcVolume(visibility, 1);
        expect(visibleDagmcVolumeIds(visibility, info)).toEqual([2]);
        visibility = toggleDagmcVolume(visibility, 1);
        expect(visibleDagmcVolumeIds(visibility, info)).toEqual([1, 2]);
        visibility = toggleDagmcMaterial(visibility, 'clad');
        expect(visibleDagmcVolumeIds(visibility, info)).toEqual([1]);
        visibility = showAllDagmc(visibility);
        expect(visibleDagmcVolumeIds(visibility, info)).toEqual([1, 2]);
    });

    it('hides a volume only when every containing group is hidden', () => {
        const info = sampleInfo();
        expect(groupsOfVolume(info, 2)).toEqual(['core', 'blanket']);
        expect(groupsOfVolume(info, 1)).toEqual(['core']);
        let visibility = toggleDagmcGroup(createDefaultDagmcVisibility(), 'core');
        expect(isDagmcVolumeVisible(visibility, info, 1)).toBe(false);
        expect(isDagmcVolumeVisible(visibility, info, 2)).toBe(true);
        visibility = toggleDagmcGroup(visibility, 'blanket');
        expect(isDagmcVolumeVisible(visibility, info, 2)).toBe(false);
    });

    it('never shows unknown volumes', () => {
        expect(isDagmcVolumeVisible(createDefaultDagmcVisibility(), sampleInfo(), 999)).toBe(false);
    });

    it('isolates one volume and keeps the other switches untouched', () => {
        const info = sampleInfo();
        const visibility = isolateDagmcVolume(toggleDagmcMaterial(createDefaultDagmcVisibility(), 'clad'), 1, [1, 2, 3]);
        expect(visibility.hiddenVolumes).toEqual([2, 3]);
        expect(visibility.hiddenMaterials).toEqual(['clad']);
        expect(visibleDagmcVolumeIds(visibility, info)).toEqual([1]);
        expect(visibleDagmcVolumeIds(showAllDagmc(visibility), info)).toEqual([1, 2]);
    });

    it('hides every supplied volume and dedupes ids without touching other switches', () => {
        const info = sampleInfo();
        const start = toggleDagmcGroup(setDagmcShowGraveyard(toggleDagmcMaterial(createDefaultDagmcVisibility(), 'clad'), true), 'core');
        const visibility = hideAllDagmc(start, [1, 2, 2, 3, 1]);
        expect(visibility.hiddenVolumes).toEqual([1, 2, 3]);
        expect(visibility.hiddenMaterials).toEqual(['clad']);
        expect(visibility.hiddenGroups).toEqual(['core']);
        expect(visibility.showGraveyard).toBe(true);
        expect(visibleDagmcVolumeIds(visibility, info)).toEqual([]);
        expect(visibleDagmcVolumeIds(showAllDagmc(visibility), info)).toEqual([1, 2, 3]);
    });

    it('hides nothing when given no ids', () => {
        const visibility = hideAllDagmc(createDefaultDagmcVisibility(), []);
        expect(visibility.hiddenVolumes).toEqual([]);
        expect(visibleDagmcVolumeIds(visibility, sampleInfo())).toEqual([1, 2]);
    });
});
