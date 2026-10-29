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

import { describe, it, expect } from 'vitest';

import { OpenMCCell, OpenMCMaterial, OpenMCMesh, OpenMCTallyFilter } from './openmc-state-schema';
import { validateMusurfaceCompanions, validateTallyFilter, validateTallyFilterSet } from './tally-filter-validation';

const cells: OpenMCCell[] = [{ id: 1, fillType: 'material', fillId: 1 }];
const materials: OpenMCMaterial[] = [
    { id: 1, name: 'Fuel', density: 10, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] },
    { id: 2, name: 'Water', density: 1, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] }
];
const meshes: OpenMCMesh[] = [{ type: 'regular', id: 1, lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1], dimension: [2, 2, 1] }];
const context = { cells, materials, meshes };

function errorMessages(filter: OpenMCTallyFilter): string[] {
    return validateTallyFilter(filter, context)
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message);
}

describe('tally filter validation', () => {
    it('reports odd cell-instance bins, missing cells, and negative instances with fixes', () => {
        const odd = validateTallyFilter({ type: 'cellinstance', bins: [1, 0, 9], pairs: [] }, context);
        expect(odd.map((issue) => issue.message)).toEqual(expect.arrayContaining([expect.stringContaining('odd length')]));
        expect(odd.every((issue) => issue.fix.length > 0)).toBe(true);

        const missingCell = validateTallyFilter({ type: 'cellinstance', bins: [9, 0], pairs: [{ first: 9, second: 0 }] }, context);
        expect(missingCell.some((issue) => issue.message.includes('cell 9'))).toBe(true);

        const negative = validateTallyFilter({ type: 'cellinstance', bins: [1, -1], pairs: [{ first: 1, second: -1 }] }, context);
        expect(negative.some((issue) => issue.message.includes('not a non-negative whole number'))).toBe(true);
    });

    it('reports mesh-material elements outside the mesh and undefined materials', () => {
        const issues = validateTallyFilter(
            {
                type: 'meshmaterial',
                bins: [4, 1, 0, 99],
                pairs: [
                    { first: 4, second: 1 },
                    { first: 0, second: 99 }
                ],
                meshId: 1
            },
            context
        );
        expect(issues.some((issue) => issue.message.includes('outside mesh 1 (4 elements)'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('material 99'))).toBe(true);
    });

    it('reports undefined mesh-material mesh references', () => {
        const issues = validateTallyFilter({ type: 'meshmaterial', bins: [0, 1], pairs: [{ first: 0, second: 1 }], meshId: 9 }, context);
        expect(issues.some((issue) => issue.message.includes('mesh 9 which does not exist'))).toBe(true);
    });

    it('rejects unknown reactions and accepts canonical names and MT numbers', () => {
        expect(errorMessages({ type: 'reaction', bins: [], reactionBins: ['(n,unicorn)'] })).toContain(
            'Reaction "(n,unicorn)" is not a known OpenMC reaction'
        );
        expect(errorMessages({ type: 'reaction', bins: [], reactionBins: ['(n,gamma)'] })).toEqual([]);
        expect(validateTallyFilter({ type: 'reaction', bins: [], reactionBins: ['102'] }, context)).toEqual([]);
        expect(errorMessages({ type: 'reaction', bins: [], reactionBins: [] })).toContain('Reaction filter has no reactions');
    });

    it('rejects unsorted particle-production energies, empty particle lists, and single boundaries', () => {
        expect(
            errorMessages({
                type: 'particleproduction',
                bins: [],
                particleTypes: [],
                productionEnergyBins: [2e7, 1e5]
            })
        ).toEqual(
            expect.arrayContaining([
                'Particle-production filter has no secondary particle types',
                'Particle-production energy boundaries are not strictly increasing'
            ])
        );
        expect(errorMessages({ type: 'particleproduction', bins: [], particleTypes: ['photon'], productionEnergyBins: [1e5] })).toContain(
            'Particle-production energy binning needs at least two boundaries'
        );
    });

    it('rejects unsorted or negative weight bins', () => {
        expect(errorMessages({ type: 'weight', bins: [1, 0.5] })).toEqual(
            expect.arrayContaining(['Weight boundaries are not strictly increasing'])
        );
        expect(errorMessages({ type: 'weight', bins: [-1, 1] })).toContain('Weight boundaries must be finite and non-negative');
        expect(errorMessages({ type: 'weight', bins: [1] })).toContain('Weight filter needs at least two weight boundaries');
    });

    it('rejects fractional, zero, and unsorted collision bins', () => {
        expect(errorMessages({ type: 'collision', bins: [0, 1.5] })).toContain('Collision bins must be positive whole collision numbers');
        expect(errorMessages({ type: 'collision', bins: [3, 1] })).toContain('Collision bins are not in ascending order');
    });

    it('rejects mu-surface bins outside the cosine range and unsorted boundaries', () => {
        expect(errorMessages({ type: 'musurface', bins: [-2, 1] })).toContain('Mu-surface boundaries must lie between -1 and 1');
        expect(errorMessages({ type: 'musurface', bins: [1, -1] })).toContain('Mu-surface boundaries are not strictly increasing');
    });

    it('warns when mu-surface lacks its surface filter or current score', () => {
        const companions = validateMusurfaceCompanions([{ type: 'musurface', bins: [-1, 1] }], ['flux']);
        expect(companions.map((issue) => issue.message)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('needs a surface filter'),
                expect.stringContaining('only populated for the current score')
            ])
        );
        expect(
            validateMusurfaceCompanions(
                [
                    { type: 'musurface', bins: [-1, 1] },
                    { type: 'surface', bins: [1] }
                ],
                ['current']
            )
        ).toEqual([]);
    });

    it('reports material-from and parent-nuclide problems', () => {
        expect(errorMessages({ type: 'materialfrom', bins: [9] })).toContain(
            'Material-from filter references material 9, which is not defined'
        );
        expect(errorMessages({ type: 'parentnuclide', bins: [], nuclideBins: ['U 235'] })).toContain(
            'Parent nuclide "U 235" is not a valid nuclide name'
        );
        expect(errorMessages({ type: 'parentnuclide', bins: [], nuclideBins: [] })).toContain('Parent-nuclide filter has no nuclides');
    });

    it('collects per-filter and companion issues for the backend checklist', () => {
        const issues = validateTallyFilterSet(
            {
                filters: [
                    { type: 'cellinstance', bins: [9, 0], pairs: [{ first: 9, second: 0 }] },
                    { type: 'musurface', bins: [-1, 1] }
                ],
                scores: ['flux']
            },
            context
        );
        expect(issues.some((issue) => issue.message.includes('cell 9'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('needs a surface filter'))).toBe(true);
    });
});
