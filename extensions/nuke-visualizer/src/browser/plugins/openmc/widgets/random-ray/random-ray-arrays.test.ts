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
 * Tests for the random-ray array classification helpers (pure, no DI).
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import { classifyVtkArrays, colorByValue, defaultColorBy, fluxGroupIndex } from './random-ray-arrays';

function array(name: string, association: 'point' | 'cell' = 'point'): OpenMCVtkArrayInfo {
    return { name, association, components: 1, range: [0, 1] };
}

describe('fluxGroupIndex', () => {
    it('parses flux group array names', () => {
        expect(fluxGroupIndex('flux_group_0')).toBe(0);
        expect(fluxGroupIndex('flux_group_12')).toBe(12);
        expect(fluxGroupIndex('flux_g3')).toBe(3);
    });

    it('rejects non-flux names', () => {
        expect(fluxGroupIndex('flux')).toBe(-1);
        expect(fluxGroupIndex('flux_group')).toBe(-1);
        expect(fluxGroupIndex('total_fission_source')).toBe(-1);
        expect(fluxGroupIndex('my_flux_group_1')).toBe(-1);
    });
});

describe('classifyVtkArrays', () => {
    it('classifies a typical random-ray legacy .vtk output', () => {
        // Mirrors OpenMC src/random_ray/flat_source_domain.cpp output_to_vtk
        const result = classifyVtkArrays([
            array('flux_group_2'),
            array('flux_group_0'),
            array('flux_group_10'),
            array('FSRs'),
            array('Materials'),
            array('total_fission_source')
        ]);
        expect(result.fluxGroups.map((a) => a.name)).toEqual(['flux_group_0', 'flux_group_2', 'flux_group_10']);
        expect(result.sources.map((a) => a.name)).toEqual(['total_fission_source']);
        expect(result.ids.map((a) => a.name)).toEqual(['FSRs', 'Materials']);
        expect(result.other).toEqual([]);
    });

    it('classifies voxel conversion and fixed-source outputs', () => {
        const result = classifyVtkArrays([array('id', 'cell'), array('external_source'), array('phi')]);
        expect(result.ids.map((a) => a.name)).toEqual(['id']);
        expect(result.sources.map((a) => a.name)).toEqual(['external_source']);
        expect(result.other.map((a) => a.name)).toEqual(['phi']);
    });
});

describe('colorByValue / defaultColorBy', () => {
    it('formats the trame color-by value with the association prefix', () => {
        expect(colorByValue(array('flux_group_0'))).toBe('Point: flux_group_0');
        expect(colorByValue(array('id', 'cell'))).toBe('Cell: id');
    });

    it('prefers the first flux group as the default coloring', () => {
        const classified = classifyVtkArrays([array('FSRs'), array('flux_group_1'), array('flux_group_0')]);
        expect(defaultColorBy(classified)).toBe('Point: flux_group_0');
    });

    it('falls back through sources, ids, then other', () => {
        expect(defaultColorBy(classifyVtkArrays([array('FSRs'), array('total_fission_source')]))).toBe('Point: total_fission_source');
        expect(defaultColorBy(classifyVtkArrays([array('Materials')]))).toBe('Point: Materials');
        expect(defaultColorBy(classifyVtkArrays([array('phi')]))).toBe('Point: phi');
        expect(defaultColorBy(classifyVtkArrays([]))).toBeUndefined();
    });
});
