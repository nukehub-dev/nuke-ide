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
 * Tests for the DAGMC categorical color-by modes: sentinel handling, the
 * volume→material/group lookups, and the Viewer Settings option order.
 */

import { describe, expect, it } from 'vitest';
import { SOLID_COLOR } from '../../../../viewer-core/viewer-toolbar-model';
import {
    GROUP_COLOR,
    GROUP_COLOR_NOTE,
    MATERIAL_COLOR,
    MATERIAL_COLOR_NOTE,
    VOLUME_COLOR,
    VOLUME_COLOR_NOTE,
    dagmcColorByOptions,
    isCategoricalColorBy,
    isGroupColorBy,
    isMaterialColorBy,
    isVolumeColorBy,
    materialForVolume,
    primaryGroupForVolume
} from './dagmc-color-by';
import { parseDagmcModelInfo } from './dagmc-toggle-model';

function sampleInfo() {
    return parseDagmcModelInfo({
        volumes: [
            { id: 1, material: 'fuel' },
            { id: 2, material: 'clad' },
            { id: 3, material: 'Graveyard' }
        ],
        materials: {
            fuel: { volumeCount: 1, volumeIds: [1] },
            clad: { volumeCount: 1, volumeIds: [2] },
            Graveyard: { volumeCount: 1, volumeIds: [3] }
        },
        groups: {
            outer: { volumeCount: 2, volumeIds: [1, 2] },
            core: { volumeCount: 1, volumeIds: [1] },
            blanket: { volumeCount: 1, volumeIds: [3] }
        }
    });
}

describe('DAGMC categorical color-by', () => {
    it('recognizes the Material sentinel exactly', () => {
        expect(isMaterialColorBy(MATERIAL_COLOR)).toBe(true);
        expect(isMaterialColorBy('material')).toBe(false);
        expect(isMaterialColorBy(SOLID_COLOR)).toBe(false);
        expect(isMaterialColorBy('Point: flux')).toBe(false);
    });

    it('recognizes the Volume and Group sentinels exactly', () => {
        expect(isVolumeColorBy(VOLUME_COLOR)).toBe(true);
        expect(isGroupColorBy(GROUP_COLOR)).toBe(true);
        expect(isVolumeColorBy('volume')).toBe(false);
        expect(isGroupColorBy('group')).toBe(false);
        expect(isVolumeColorBy(GROUP_COLOR)).toBe(false);
        expect(isGroupColorBy(VOLUME_COLOR)).toBe(false);
    });

    it('treats Solid Color, Material, Volume, and Group as categorical modes', () => {
        expect(isCategoricalColorBy(SOLID_COLOR)).toBe(true);
        expect(isCategoricalColorBy(MATERIAL_COLOR)).toBe(true);
        expect(isCategoricalColorBy(VOLUME_COLOR)).toBe(true);
        expect(isCategoricalColorBy(GROUP_COLOR)).toBe(true);
        expect(isCategoricalColorBy('Cell: material')).toBe(false);
        expect(isCategoricalColorBy('Point: flux')).toBe(false);
    });

    it('exposes the Viewer Settings notes', () => {
        expect(MATERIAL_COLOR_NOTE).toBe('Color by material');
        expect(VOLUME_COLOR_NOTE).toBe('Color by volume');
        expect(GROUP_COLOR_NOTE).toBe('Color by group');
    });
});

describe('materialForVolume', () => {
    it('resolves the material of a known volume', () => {
        const info = sampleInfo();
        expect(materialForVolume(info, 1)).toBe('fuel');
        expect(materialForVolume(info, 3)).toBe('Graveyard');
    });

    it('returns undefined without model info, without an id, or for unknown volumes', () => {
        expect(materialForVolume(undefined, 1)).toBeUndefined();
        expect(materialForVolume(sampleInfo(), undefined)).toBeUndefined();
        expect(materialForVolume(sampleInfo(), 99)).toBeUndefined();
    });
});

describe('primaryGroupForVolume', () => {
    it('resolves a single-group membership', () => {
        expect(primaryGroupForVolume(sampleInfo(), 2)).toBe('outer');
        expect(primaryGroupForVolume(sampleInfo(), 3)).toBe('blanket');
    });

    it('keeps the first group in object insertion order for multi-group volumes', () => {
        const info = sampleInfo();
        expect(primaryGroupForVolume(info, 1)).toBe('outer');
        const reversed = parseDagmcModelInfo({
            volumes: [{ id: 1, material: 'fuel' }],
            groups: {
                core: { volumeCount: 1, volumeIds: [1] },
                outer: { volumeCount: 1, volumeIds: [1] }
            }
        });
        expect(primaryGroupForVolume(reversed, 1)).toBe('core');
    });

    it('returns undefined without model info, without an id, or without membership', () => {
        expect(primaryGroupForVolume(undefined, 1)).toBeUndefined();
        expect(primaryGroupForVolume(sampleInfo(), undefined)).toBeUndefined();
        expect(primaryGroupForVolume(sampleInfo(), 99)).toBeUndefined();
    });
});

describe('dagmcColorByOptions', () => {
    const arrays = [
        { value: 'Point: flux', label: 'Point: flux' },
        { value: 'Cell: material', label: 'Cell: material' }
    ];

    it('offers only Solid Color before blocks load', () => {
        expect(dagmcColorByOptions(false, true, true, arrays)).toEqual([{ value: SOLID_COLOR, label: SOLID_COLOR }]);
    });

    it('offers Solid Color, Volume, and arrays without model info', () => {
        expect(dagmcColorByOptions(true, false, false, arrays)).toEqual([
            { value: SOLID_COLOR, label: SOLID_COLOR },
            { value: VOLUME_COLOR, label: VOLUME_COLOR },
            ...arrays
        ]);
    });

    it('inserts Material, Volume, and Group before the arrays when model info exists', () => {
        expect(dagmcColorByOptions(true, true, true, arrays)).toEqual([
            { value: SOLID_COLOR, label: SOLID_COLOR },
            { value: MATERIAL_COLOR, label: MATERIAL_COLOR },
            { value: VOLUME_COLOR, label: VOLUME_COLOR },
            { value: GROUP_COLOR, label: GROUP_COLOR },
            ...arrays
        ]);
    });

    it('omits Group when the model carries no groups', () => {
        expect(dagmcColorByOptions(true, true, false, arrays)).toEqual([
            { value: SOLID_COLOR, label: SOLID_COLOR },
            { value: MATERIAL_COLOR, label: MATERIAL_COLOR },
            { value: VOLUME_COLOR, label: VOLUME_COLOR },
            ...arrays
        ]);
    });

    it('offers the categorical modes even when no classified array exists', () => {
        expect(dagmcColorByOptions(true, true, true, [])).toEqual([
            { value: SOLID_COLOR, label: SOLID_COLOR },
            { value: MATERIAL_COLOR, label: MATERIAL_COLOR },
            { value: VOLUME_COLOR, label: VOLUME_COLOR },
            { value: GROUP_COLOR, label: GROUP_COLOR }
        ]);
    });

    it('deduplicates array options that collide with the categorical entries', () => {
        expect(
            dagmcColorByOptions(true, true, true, [
                { value: SOLID_COLOR, label: 'duplicate solid' },
                { value: MATERIAL_COLOR, label: 'duplicate material' },
                { value: VOLUME_COLOR, label: 'duplicate volume' },
                { value: GROUP_COLOR, label: 'duplicate group' }
            ])
        ).toEqual([
            { value: SOLID_COLOR, label: SOLID_COLOR },
            { value: MATERIAL_COLOR, label: MATERIAL_COLOR },
            { value: VOLUME_COLOR, label: VOLUME_COLOR },
            { value: GROUP_COLOR, label: GROUP_COLOR }
        ]);
    });
});
