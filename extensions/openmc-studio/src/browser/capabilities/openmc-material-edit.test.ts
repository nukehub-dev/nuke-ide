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
 * Tests the pure material action validator, diff builder, and snapshot helpers.
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCMaterial } from '../../common/openmc-state-schema';
import {
    cloneMaterials,
    materialEquals,
    materialValue,
    previewMaterialActions,
    validateMaterialActions,
    type OpenMCMaterialAction
} from './openmc-material-edit';

function buildMaterials(): OpenMCMaterial[] {
    return [
        {
            id: 1,
            name: 'Water',
            density: 1,
            densityUnit: 'g/cm3',
            nuclides: [
                { name: 'H1', fraction: 2, fractionType: 'ao' },
                { name: 'O16', fraction: 1, fractionType: 'ao' }
            ],
            thermalScattering: [],
            color: '#4488ff'
        },
        {
            id: 2,
            name: 'Fuel',
            density: 10.4,
            densityUnit: 'g/cm3',
            nuclides: [{ name: 'U235', fraction: 0.04, fractionType: 'wo' }],
            thermalScattering: [{ name: 'c_Graphite', fraction: 1 }]
        },
        {
            id: 3,
            name: 'Graphite',
            density: 1.6,
            densityUnit: 'macro',
            nuclides: [],
            thermalScattering: [],
            macroscopic: { name: 'graphite' }
        }
    ];
}

function update(updates: Record<string, unknown>, materialId = 1): OpenMCMaterialAction {
    return { action: 'update', materialId, updates };
}

describe('validateMaterialActions', () => {
    it('accepts every editable update field', () => {
        const materials = buildMaterials();
        const errors = validateMaterialActions(materials, [
            update({
                name: 'Coolant',
                density: 0.998,
                densityUnit: 'kg/m3',
                nuclides: [{ name: 'H1', fraction: 2, fractionType: 'ao' }],
                thermalScattering: [{ name: 'h_H2O', fraction: 1 }],
                color: '#00ff00',
                temperature: 293.6,
                volume: 100,
                isDepletable: true,
                isotropic: ['H1']
            })
        ]);

        expect(errors).toEqual([]);
    });

    it('accepts an NCrystal configuration when thermal scattering is cleared', () => {
        const materials = buildMaterials();
        const errors = validateMaterialActions(materials, [
            update({ thermalScattering: [], ncrystalCfg: 'LiquidWaterH2O_T293.6K.ncmat;temp=293.6K' }, 2)
        ]);

        expect(errors).toEqual([]);
    });

    it('keeps the schema macro density unit for macroscopic materials', () => {
        const materials = buildMaterials();

        expect(validateMaterialActions(materials, [update({ density: 1.8, densityUnit: 'macro' }, 3)])).toEqual([]);
        expect(validateMaterialActions(materials, [update({ densityUnit: 'g/cm3' }, 3)]).join(' ')).toContain(
            "macroscopic materials must use the 'macro' density unit"
        );
        expect(
            validateMaterialActions(materials, [{ action: 'add', material: { name: 'Steel', density: 1, densityUnit: 'macro' } }]).join(' ')
        ).toContain("cannot use the 'macro' density unit");
    });

    it('accepts a complete addition and a removal', () => {
        const materials = buildMaterials();
        const errors = validateMaterialActions(materials, [
            {
                action: 'add',
                material: {
                    name: 'Steel',
                    density: 7.87,
                    densityUnit: 'g/cm3',
                    nuclides: [{ name: 'Fe56', fraction: 1, fractionType: 'wo' }],
                    thermalScattering: [{ name: 'c_Steel', fraction: 1 }],
                    color: '#888888',
                    temperature: 293.6,
                    volume: 50,
                    isDepletable: true,
                    isotropic: ['Fe56']
                }
            },
            { action: 'remove', materialId: 2 }
        ]);

        expect(errors).toEqual([]);
    });

    it('accepts the minimal addition and fills optional fields later', () => {
        const materials = buildMaterials();
        const errors = validateMaterialActions(materials, [
            { action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }
        ]);

        expect(errors).toEqual([]);
    });

    it('rejects invalid field values', () => {
        const materials = buildMaterials();
        const cases: Array<{ updates: Record<string, unknown>; message: string }> = [
            { updates: { name: '   ' }, message: 'Name must be a non-empty string' },
            { updates: { density: 0 }, message: 'Density must be a finite number greater than 0' },
            { updates: { density: Number.NaN }, message: 'Density must be a finite number greater than 0' },
            { updates: { density: Number.POSITIVE_INFINITY }, message: 'Density must be a finite number greater than 0' },
            { updates: { densityUnit: 'furlongs' }, message: 'Density unit must be one of' },
            { updates: { densityUnit: 'macro' }, message: "the 'macro' density unit requires macroscopic data" },
            { updates: { temperature: 0 }, message: 'Temperature must be a finite number greater than 0' },
            { updates: { volume: -1 }, message: 'Volume must be a finite number greater than 0' },
            { updates: { color: ' ' }, message: 'Color must be a non-empty string' },
            { updates: { nuclides: 'U235' }, message: 'Nuclides must be an array' },
            { updates: { nuclides: [{ name: '', fraction: 1 }] }, message: 'needs a non-empty name' },
            { updates: { nuclides: [{ name: 'U235', fraction: -1 }] }, message: 'greater than or equal to 0' },
            { updates: { nuclides: [{ name: 'U235', fraction: 1, fractionType: 'wt' }] }, message: "must be 'ao' or 'wo'" },
            { updates: { nuclides: [{ name: 'U235', fraction: 0 }] }, message: 'must total more than 0' },
            { updates: { thermalScattering: [{ fraction: 1 }] }, message: 'needs a non-empty name' },
            { updates: { thermalScattering: [{ name: 'h_H2O', fraction: 0 }] }, message: 'greater than 0' },
            { updates: { isotropic: [1] }, message: 'non-empty strings' },
            { updates: { isDepletable: 'yes' }, message: 'must be a boolean' },
            { updates: { ncrystalCfg: ' ' }, message: 'NCrystal configuration must be a non-empty string' }
        ];

        for (const testCase of cases) {
            const errors = validateMaterialActions(materials, [update(testCase.updates)]);
            expect(errors.join(' ')).toContain(testCase.message);
        }
    });

    it('rejects NCrystal configurations that conflict with scattering or macroscopic data', () => {
        const materials = buildMaterials();

        const thermal = validateMaterialActions(materials, [update({ ncrystalCfg: 'graphite.ncmat' }, 2)]);
        expect(thermal.join(' ')).toContain('cannot be combined with thermal scattering data');

        const macroscopic = validateMaterialActions(materials, [update({ ncrystalCfg: 'graphite.ncmat' }, 3)]);
        expect(macroscopic.join(' ')).toContain('cannot be combined with macroscopic data');

        const added = validateMaterialActions(materials, [
            {
                action: 'add',
                material: {
                    name: 'Ice',
                    density: 0.9,
                    densityUnit: 'g/cm3',
                    ncrystalCfg: 'Ice.ncmat',
                    thermalScattering: [{ name: 'h_H2O', fraction: 1 }]
                }
            }
        ]);
        expect(added.join(' ')).toContain('cannot be combined with thermal scattering data');
    });

    it('rejects protected and unknown fields', () => {
        const materials = buildMaterials();
        const cases: Array<{ updates: Record<string, unknown>; message: string }> = [
            { updates: { id: 9 }, message: 'id is assigned automatically' },
            { updates: { macroscopic: { name: 'water' } }, message: 'Macroscopic data cannot be added or changed here' },
            { updates: { nukeCadMaterialId: 'uuid' }, message: 'nuke-cad provenance' },
            { updates: { nukeCadParentId: 'uuid' }, message: 'nuke-cad provenance' },
            { updates: { bogus: true }, message: 'bogus is not an editable material field' }
        ];

        for (const testCase of cases) {
            expect(validateMaterialActions(materials, [update(testCase.updates)]).join(' ')).toContain(testCase.message);
        }

        const additions: Array<{ material: Record<string, unknown>; message: string }> = [
            { material: { name: 'Steel', density: 1, densityUnit: 'g/cm3', id: 9 }, message: 'id is assigned automatically' },
            { material: { name: 'Steel', density: 1, densityUnit: 'g/cm3', macroscopic: { name: 'steel' } }, message: 'Macroscopic data' },
            { material: { name: 'Steel', density: 1, densityUnit: 'g/cm3', nukeCadMaterialId: 'uuid' }, message: 'nuke-cad provenance' },
            { material: { name: 'Steel', density: 1, densityUnit: 'g/cm3', nukeCadParentId: 'uuid' }, message: 'nuke-cad provenance' },
            { material: { name: 'Steel', density: 1, densityUnit: 'g/cm3', bogus: 1 }, message: 'not an editable material field' }
        ];
        for (const testCase of additions) {
            const errors = validateMaterialActions(materials, [{ action: 'add', material: testCase.material }]);
            expect(errors.join(' ')).toContain(testCase.message);
        }
    });

    it('rejects additions without a name, density, or density unit', () => {
        const materials = buildMaterials();
        const errors = validateMaterialActions(materials, [{ action: 'add', material: { name: 'Steel' } }]);

        expect(errors.join(' ')).toContain('needs density');
        expect(errors.join(' ')).toContain('needs densityUnit');

        const empty = validateMaterialActions(materials, [{ action: 'add', material: {} }]).join(' ');
        expect(empty).toContain('needs name');
        expect(empty).toContain('needs density');
        expect(empty).toContain('needs densityUnit');
    });

    it('rejects duplicate updates, removes, and mixed actions for one material', () => {
        const materials = buildMaterials();
        const cases: OpenMCMaterialAction[][] = [
            [update({ density: 2 }), update({ color: '#ffffff' })],
            [
                { action: 'remove', materialId: 1 },
                { action: 'remove', materialId: 1 }
            ],
            [update({ density: 2 }), { action: 'remove', materialId: 1 }],
            [{ action: 'remove', materialId: 1 }, update({ density: 2 })]
        ];

        for (const actions of cases) {
            expect(validateMaterialActions(materials, actions).join(' ')).toContain('can only be changed once per preview');
        }
    });

    it('rejects duplicate material names', () => {
        const materials = buildMaterials();

        expect(validateMaterialActions(materials, [update({ name: 'Fuel' })]).join(' ')).toContain('already used by material 2');
        expect(
            validateMaterialActions(materials, [{ action: 'add', material: { name: 'Water', density: 1, densityUnit: 'g/cm3' } }]).join(' ')
        ).toContain('already used by material 1');
        expect(
            validateMaterialActions(materials, [
                { action: 'add', material: { name: 'Steel', density: 1, densityUnit: 'g/cm3' } },
                { action: 'add', material: { name: 'Steel', density: 1, densityUnit: 'g/cm3' } }
            ]).join(' ')
        ).toContain('is added more than once');
    });

    it('rejects empty, no-op, and out-of-range action sets', () => {
        const materials = buildMaterials();

        expect(validateMaterialActions(materials, []).join(' ')).toContain('between 1 and 20');
        const tooMany = Array.from({ length: 21 }, (_, index) => update({ density: index + 2 }, index + 1));
        expect(validateMaterialActions(materials, tooMany).join(' ')).toContain('between 1 and 20');
        expect(validateMaterialActions(materials, [update({})]).join(' ')).toContain('at least one editable field');
        expect(validateMaterialActions(materials, [update({ density: 1 })])).toEqual([]);
        expect(validateMaterialActions(materials, [update({ name: 'Water' })])).toEqual([]);
        expect(() => previewMaterialActions(materials, [update({ density: 1 })])).toThrow('would not change any material');
        expect(() => previewMaterialActions(materials, [update({ name: 'Water' })])).toThrow('would not change any material');
    });

    it('accepts a mixed set where one update changes nothing', () => {
        const materials = buildMaterials();

        const preview = previewMaterialActions(materials, [update({ density: 1 }, 1), update({ density: 11 }, 2)]);

        expect(preview.changes).toEqual([{ path: 'materials.2.density', label: 'Fuel Density', kind: 'update', before: 10.4, after: 11 }]);
    });

    it('rejects missing targets and malformed actions', () => {
        const materials = buildMaterials();

        expect(validateMaterialActions(materials, [update({ density: 2 }, 99)]).join(' ')).toContain('Material 99 does not exist');
        expect(validateMaterialActions(materials, [{ action: 'remove', materialId: 99 }]).join(' ')).toContain(
            'Material 99 does not exist'
        );
        expect(
            validateMaterialActions(materials, [{ action: 'rename', materialId: 1 } as unknown as OpenMCMaterialAction]).join(' ')
        ).toContain('must be update, add, or remove');
        expect(validateMaterialActions(materials, [{ action: 'update', materialId: 0.5, updates: { density: 2 } }]).join(' ')).toContain(
            'positive integer materialId'
        );
        expect(
            validateMaterialActions(materials, [
                { action: 'update', materialId: 1, updates: { density: 2 }, summary: 'extra' } as unknown as OpenMCMaterialAction
            ]).join(' ')
        ).toContain('Update actions do not accept summary');
        expect(
            validateMaterialActions(materials, [
                {
                    action: 'add',
                    material: { name: 'Steel', density: 1, densityUnit: 'g/cm3' },
                    comment: 'extra'
                } as unknown as OpenMCMaterialAction
            ]).join(' ')
        ).toContain('Add actions do not accept comment');
    });
});

describe('previewMaterialActions', () => {
    it('produces per-field update changes without mutating the input', () => {
        const materials = buildMaterials();
        const original = JSON.parse(JSON.stringify(materials)) as OpenMCMaterial[];

        const preview = previewMaterialActions(materials, [update({ density: 1.5, color: '#00ff00' })]);

        expect(preview.changes).toEqual([
            { path: 'materials.1.density', label: 'Water Density', kind: 'update', before: 1, after: 1.5 },
            { path: 'materials.1.color', label: 'Water Color', kind: 'update', before: '#4488ff', after: '#00ff00' }
        ]);
        expect(materials).toEqual(original);
        expect(preview.after[0]).not.toBe(materials[0]);
        expect(preview.after[0]).toMatchObject({ id: 1, density: 1.5, color: '#00ff00' });
        expect(preview.addedIds).toEqual([]);
    });

    it('skips unchanged fields in a mixed update', () => {
        const materials = buildMaterials();

        const preview = previewMaterialActions(materials, [update({ name: 'Water', density: 2 })]);

        expect(preview.changes).toEqual([{ path: 'materials.1.density', label: 'Water Density', kind: 'update', before: 1, after: 2 }]);
    });

    it('assigns ids to additions and advances past used ids', () => {
        const materials = buildMaterials();

        const preview = previewMaterialActions(
            materials,
            [
                { action: 'add', material: { name: ' Steel ', density: 7.87, densityUnit: 'g/cm3' } },
                { action: 'add', material: { name: 'Lead', density: 11.34, densityUnit: 'g/cm3' } }
            ],
            2
        );

        expect(preview.addedIds).toEqual([4, 5]);
        expect(preview.changes[0]).toMatchObject({
            path: 'materials.4',
            label: 'Add material Steel',
            kind: 'add',
            after: { id: 4, name: 'Steel', density: 7.87, densityUnit: 'g/cm3', nuclides: [], thermalScattering: [] }
        });
        expect(preview.changes[1]).toMatchObject({ path: 'materials.5', label: 'Add material Lead', kind: 'add' });
        expect(preview.after.map((material) => material.id)).toEqual([1, 2, 3, 4, 5]);
        expect(materials.map((material) => material.id)).toEqual([1, 2, 3]);
    });

    it('uses the highest id plus one when no allocator is provided', () => {
        const preview = previewMaterialActions(buildMaterials(), [
            { action: 'add', material: { name: 'Steel', density: 7.87, densityUnit: 'g/cm3' } }
        ]);

        expect(preview.addedIds).toEqual([4]);
    });

    it('stores the full snapshot for a removal', () => {
        const materials = buildMaterials();

        const preview = previewMaterialActions(materials, [{ action: 'remove', materialId: 2 }]);

        expect(preview.changes).toEqual([{ path: 'materials.2', label: 'Remove material Fuel', kind: 'remove', before: materials[1] }]);
        expect(preview.after.map((material) => material.id)).toEqual([1, 3]);
        expect(materials).toHaveLength(3);
    });

    it('normalizes nuclide names and defaults the fraction type', () => {
        const materials = buildMaterials();

        const preview = previewMaterialActions(materials, [update({ nuclides: [{ name: ' H1 ', fraction: 2 }] })]);

        expect(preview.changes[0].after).toEqual([{ name: 'H1', fraction: 2, fractionType: 'ao' }]);
        expect(preview.after[0].nuclides).toEqual([{ name: 'H1', fraction: 2, fractionType: 'ao' }]);
    });

    it('throws for invalid and no-op action sets', () => {
        const materials = buildMaterials();

        expect(() => previewMaterialActions(materials, [update({ density: 1 })])).toThrow('would not change any material');
        expect(() => previewMaterialActions(materials, [{ action: 'remove', materialId: 99 }])).toThrow('does not exist');
    });
});

describe('material helpers', () => {
    it('reads editable fields', () => {
        const [water] = buildMaterials();

        expect(materialValue(water, 'name')).toBe('Water');
        expect(materialValue(water, 'densityUnit')).toBe('g/cm3');
        expect(materialValue(water, 'nuclides')).toHaveLength(2);
    });

    it('compares missing and undefined properties as equal', () => {
        expect(materialEquals({ id: 1, name: 'Water' }, { id: 1, name: 'Water', color: undefined })).toBe(true);
        expect(materialEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(materialEquals([1, 2], [2, 1])).toBe(false);
        expect(materialEquals([1, 2], [1, 2, 3])).toBe(false);
        expect(materialEquals(1, 2)).toBe(false);
    });

    it('deep-clones materials', () => {
        const materials = buildMaterials();
        const clone = cloneMaterials(materials);

        clone[0].name = 'Changed';
        clone[0].nuclides[0].fraction = 99;

        expect(materials[0].name).toBe('Water');
        expect(materials[0].nuclides[0].fraction).toBe(2);
    });
});
