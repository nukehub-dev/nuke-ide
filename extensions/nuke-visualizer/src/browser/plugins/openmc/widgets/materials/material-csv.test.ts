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

import { describe, expect, it } from 'vitest';
import { OpenMCMaterial } from '../../../../../common/openmc-protocol';
import { MATERIAL_CSV_HEADER, csvField, materialsToCsv } from './material-csv';

function material(overrides: Partial<OpenMCMaterial>): OpenMCMaterial {
    return {
        id: 1,
        name: 'fuel',
        density: 10.4,
        densityUnit: 'g/cm3',
        nuclides: [],
        thermalScattering: [],
        isDepletable: false,
        totalNuclides: 0,
        ...overrides
    };
}

describe('csvField', () => {
    it('quotes fields containing delimiters, quotes, or line breaks', () => {
        expect(csvField('fuel')).toBe('fuel');
        expect(csvField('fuel, hot')).toBe('"fuel, hot"');
        expect(csvField('say "hi"')).toBe('"say ""hi"""');
        expect(csvField('line\nbreak')).toBe('"line\nbreak"');
        expect(csvField(undefined)).toBe('');
    });
});

describe('materialsToCsv', () => {
    it('writes one row per nuclide and thermal scattering entry', () => {
        const csv = materialsToCsv([
            material({
                nuclides: [
                    { name: 'U235', fraction: 0.04, fractionType: 'ao' },
                    { name: 'U238', fraction: 0.96, fractionType: 'ao' }
                ],
                thermalScattering: [{ name: 'c_U_in_UO2', fraction: 1 }],
                isDepletable: true
            })
        ]);

        const lines = csv.trimEnd().split('\n');
        expect(lines[0]).toBe(MATERIAL_CSV_HEADER.join(','));
        expect(lines[1]).toBe('1,fuel,10.4,g/cm3,,,true,nuclide,U235,0.04,ao');
        expect(lines[2]).toBe('1,fuel,10.4,g/cm3,,,true,nuclide,U238,0.96,ao');
        expect(lines[3]).toBe('1,fuel,10.4,g/cm3,,,true,thermal_scattering,c_U_in_UO2,1,');
        expect(csv.endsWith('\n')).toBe(true);
    });

    it('keeps optional temperature and volume, and emits one row for empty materials', () => {
        const csv = materialsToCsv([material({ temperature: 600, volume: 12.5 })]);
        const lines = csv.trimEnd().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe('1,fuel,10.4,g/cm3,600,12.5,false,,,,');
    });

    it('escapes material names containing commas', () => {
        const csv = materialsToCsv([
            material({
                name: 'fuel, hot',
                nuclides: [{ name: 'U235', fraction: 1, fractionType: 'wo' }]
            })
        ]);
        const lines = csv.trimEnd().split('\n');
        expect(lines[1]).toBe('1,"fuel, hot",10.4,g/cm3,,,false,nuclide,U235,1,wo');
    });
});
