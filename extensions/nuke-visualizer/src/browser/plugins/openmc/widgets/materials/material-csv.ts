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

import { OpenMCMaterial } from '../../../../../common/openmc-protocol';

export const MATERIAL_CSV_HEADER = [
    'material_id',
    'material_name',
    'density',
    'density_unit',
    'temperature_k',
    'volume_cm3',
    'depletable',
    'kind',
    'name',
    'fraction',
    'fraction_type'
];

/** Quote a CSV field only when it contains a delimiter, quote, or line break. */
export function csvField(value: string | number | boolean | undefined): string {
    const text = value === undefined ? '' : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialize a materials table to CSV: one row per nuclide or S(α,β) entry,
 * with the parent material repeated. Materials without a composition produce
 * a single row with empty `kind`/`name`/`fraction` fields.
 */
export function materialsToCsv(materials: OpenMCMaterial[]): string {
    const rows: string[][] = [MATERIAL_CSV_HEADER];

    for (const material of materials) {
        const prefix = [
            material.id,
            material.name,
            material.density,
            material.densityUnit,
            material.temperature,
            material.volume,
            material.isDepletable
        ];
        if (material.nuclides.length === 0 && material.thermalScattering.length === 0) {
            rows.push([...prefix, '', '', '', ''].map((value) => csvField(value)));
            continue;
        }
        for (const nuclide of material.nuclides) {
            rows.push([...prefix, 'nuclide', nuclide.name, nuclide.fraction, nuclide.fractionType].map((value) => csvField(value)));
        }
        for (const thermal of material.thermalScattering) {
            rows.push([...prefix, 'thermal_scattering', thermal.name, thermal.fraction, ''].map((value) => csvField(value)));
        }
    }

    return rows.map((row) => row.join(',')).join('\n') + '\n';
}
