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
 * Tests for the tally overlay dataset classifier (no DI/DOM): kind
 * detection for the `visualize-mesh` / `visualize-overlay` /
 * `visualize-source` outputs, slice-axis detection, per-kind color-by
 * defaults, and header descriptions.
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';
import { SOLID_COLOR } from '../native-vtk/native-vtk-data';
import {
    buildTallyUnderlayMenuItem,
    classifyTallyOverlayDataset,
    csgUnderlayCells,
    defaultOverlayColorBy,
    describeTallyOverlayDataset,
    detectSliceAxis,
    detectTallyOverlayKind,
    hasMeshArrays,
    hasSourceArrays,
    isTallyOverlayKind,
    pointSizeForKind,
    smoothableGridDims
} from './tally-overlay-model';
import { classifyNativeVtkArrays } from '../native-vtk/native-vtk-data';
import { parseGeometryNativeModel } from '../geometry-native/geometry-native-model';

function array(name: string, association: 'point' | 'cell' = 'point'): OpenMCVtkArrayInfo {
    return { name, association, components: 1, range: [0, 1] };
}

describe('isTallyOverlayKind', () => {
    it('guards the four dataset kinds', () => {
        expect(isTallyOverlayKind('mesh')).toBe(true);
        expect(isTallyOverlayKind('slice')).toBe(true);
        expect(isTallyOverlayKind('source')).toBe(true);
        expect(isTallyOverlayKind('overlay')).toBe(true);
        expect(isTallyOverlayKind('tracks')).toBe(false);
    });
});

describe('hasSourceArrays / hasMeshArrays', () => {
    it('matches the source and mesh vocabularies', () => {
        expect(hasSourceArrays(['source', 'energy'])).toBe(true);
        expect(hasSourceArrays(['STRENGTH'])).toBe(true);
        expect(hasSourceArrays(['energy', 'flux_group_0'])).toBe(false);
        expect(hasMeshArrays(['flux_group_0'])).toBe(true);
        expect(hasMeshArrays(['fission_mean'])).toBe(true);
        expect(hasMeshArrays(['tally_score'])).toBe(true);
        expect(hasMeshArrays(['energy'])).toBe(false);
    });
});

describe('detectSliceAxis', () => {
    it('finds the degenerate grid dimension', () => {
        expect(detectSliceAxis([1, 32, 32])).toBe('x');
        expect(detectSliceAxis([32, 1, 32])).toBe('y');
        expect(detectSliceAxis([32, 32, 1])).toBe('z');
        expect(detectSliceAxis([32, 32, 32])).toBeUndefined();
    });
});

describe('detectTallyOverlayKind', () => {
    it('routes source clouds, slices, meshes, and overlays', () => {
        expect(detectTallyOverlayKind({ family: 'polydata', arrayNames: ['source', 'energy'] })).toBe('source');
        expect(detectTallyOverlayKind({ family: 'image', gridDimensions: [32, 32, 1], arrayNames: ['flux_group_0'] })).toBe('slice');
        expect(detectTallyOverlayKind({ family: 'rectilinear', gridDimensions: [8, 8, 8], arrayNames: ['lower_g0', 'upper_g0'] })).toBe(
            'mesh'
        );
        expect(detectTallyOverlayKind({ family: 'rectilinear', gridDimensions: [8, 8, 8], arrayNames: ['phi'] })).toBe('overlay');
        expect(detectTallyOverlayKind({ family: 'polydata', arrayNames: ['energy', 'time'] })).toBe('source');
    });
});

describe('defaultOverlayColorBy', () => {
    it('prefers source arrays for source clouds and flux groups for slices', () => {
        const source = classifyNativeVtkArrays([array('energy'), array('source')]);
        expect(defaultOverlayColorBy('source', source, 'polydata')).toBe('Point: source');
        const slice = classifyNativeVtkArrays([array('energy'), array('flux_group_1'), array('flux_group_0')]);
        expect(defaultOverlayColorBy('slice', slice, 'image')).toBe('Point: flux_group_0');
    });

    it('falls back to the P1 default and Solid Color', () => {
        const mesh = classifyNativeVtkArrays([array('lower_g0', 'cell')]);
        expect(defaultOverlayColorBy('mesh', mesh, 'rectilinear')).toBe('Cell: lower_g0');
        expect(defaultOverlayColorBy('overlay', classifyNativeVtkArrays([]), 'rectilinear')).toBe(SOLID_COLOR);
    });
});

describe('pointSizeForKind', () => {
    it('enlarges source points', () => {
        expect(pointSizeForKind('source')).toBeGreaterThan(pointSizeForKind('slice'));
        expect(pointSizeForKind('mesh')).toBe(pointSizeForKind('overlay'));
    });
});

describe('classifyTallyOverlayDataset', () => {
    it('classifies a slice end to end with its axis and default', () => {
        const result = classifyTallyOverlayDataset([array('flux_group_0'), array('id', 'cell')], 'image', [16, 16, 1]);
        expect(result.kind).toBe('slice');
        expect(result.sliceAxis).toBe('z');
        expect(result.colorBy).toBe('Point: flux_group_0');
    });

    it('classifies a source cloud end to end', () => {
        const result = classifyTallyOverlayDataset([array('source'), array('energy')], 'polydata');
        expect(result.kind).toBe('source');
        expect(result.sliceAxis).toBeUndefined();
        expect(result.colorBy).toBe('Point: source');
    });
});

describe('describeTallyOverlayDataset', () => {
    it('summarizes every kind for the viewer header', () => {
        expect(describeTallyOverlayDataset({ kind: 'source', family: 'polydata', nPoints: 1000, colorBy: 'Point: source' })).toContain(
            'Source cloud'
        );
        expect(
            describeTallyOverlayDataset({ kind: 'slice', family: 'image', nPoints: 256, sliceAxis: 'z', colorBy: 'Point: flux_group_0' })
        ).toContain('⟂ z');
        expect(describeTallyOverlayDataset({ kind: 'mesh', family: 'rectilinear', nPoints: 512, colorBy: 'Cell: lower_g0' })).toContain(
            'Mesh tally'
        );
        expect(describeTallyOverlayDataset({ kind: 'overlay', family: 'rectilinear', nPoints: 512, colorBy: SOLID_COLOR })).toContain(
            'Tally overlay'
        );
    });
});

describe('csgUnderlayCells', () => {
    it('keeps drawable cells including void shells and drops degenerate bboxes', () => {
        const cells = parseGeometryNativeModel({
            cells: [
                { id: 1, material: 'uo2', bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
                { id: 2, material: 'void', bbox: { min: [0, 0, 0], max: [2, 2, 2] } },
                { id: 3, material: 'water', bbox: { min: [0, 0, 0], max: [1, 1, 0] } }
            ]
        }).cells;
        expect(csgUnderlayCells(cells).map((cell) => cell.id)).toEqual([1, 2]);
        expect(csgUnderlayCells([])).toEqual([]);
    });
});

describe('buildTallyUnderlayMenuItem', () => {
    it('toggles with visibility and disables before cells load', () => {
        expect(buildTallyUnderlayMenuItem(true, true)).toMatchObject({ id: 'underlay', checked: true, disabled: false });
        expect(buildTallyUnderlayMenuItem(true, false)).toMatchObject({ id: 'underlay', checked: false, disabled: false });
        expect(buildTallyUnderlayMenuItem(false, false)).toMatchObject({ id: 'underlay', checked: false, disabled: true });
    });
});

describe('smoothableGridDims', () => {
    it('admits true 3D grids and rejects slices, lines, and missing dims', () => {
        expect(smoothableGridDims([20, 20, 10])).toBe(true);
        expect(smoothableGridDims([16, 16, 1])).toBe(false);
        expect(smoothableGridDims([8, 1, 1])).toBe(false);
        expect(smoothableGridDims(undefined)).toBe(false);
    });
});
