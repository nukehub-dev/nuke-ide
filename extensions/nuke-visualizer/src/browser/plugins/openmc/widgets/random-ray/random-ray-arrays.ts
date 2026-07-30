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
 * Pure helpers classifying VTK data arrays for the random-ray results
 * viewer's quick-select bar. Random-ray legacy `.vtk` outputs carry
 * `flux_group_<i>` point arrays plus `FSRs`, `Materials`, and
 * `total_fission_source`/`external_source` (OpenMC
 * src/random_ray/flat_source_domain.cpp `output_to_vtk`); voxel `.vti`
 * conversions carry a cell `id` array. No DI/DOM dependencies — unit-testable
 * in node.
 */

import type { OpenMCVtkArrayInfo } from '../../../../../common/openmc-protocol';

/** Array names treated as source/fission quantities (lowercased). */
const SOURCE_ARRAY_NAMES = new Set(['total_fission_source', 'external_source', 'fission_source', 'fission', 'source']);

/** Array names treated as domain/material identifiers (lowercased). */
const ID_ARRAY_NAMES = new Set(['fsrs', 'fsr', 'materials', 'material', 'material_id', 'cell_id', 'id']);

export interface ClassifiedVtkArrays {
    /** Per-energy-group flux arrays, sorted by group index */
    fluxGroups: OpenMCVtkArrayInfo[];
    /** Fission/external source arrays */
    sources: OpenMCVtkArrayInfo[];
    /** FSR/material/cell identifier arrays */
    ids: OpenMCVtkArrayInfo[];
    /** Everything else */
    other: OpenMCVtkArrayInfo[];
}

const FLUX_GROUP_RE = /^flux_(?:group_|g)(\d+)$/i;

/** Group index of a flux array name, or -1 when it is not a flux group array. */
export function fluxGroupIndex(name: string): number {
    const match = FLUX_GROUP_RE.exec(name);
    return match ? parseInt(match[1], 10) : -1;
}

/** Classify VTK arrays into random-ray categories for the quick-select bar. */
export function classifyVtkArrays(arrays: readonly OpenMCVtkArrayInfo[]): ClassifiedVtkArrays {
    const result: ClassifiedVtkArrays = { fluxGroups: [], sources: [], ids: [], other: [] };
    for (const array of arrays) {
        if (fluxGroupIndex(array.name) >= 0) {
            result.fluxGroups.push(array);
        } else if (SOURCE_ARRAY_NAMES.has(array.name.toLowerCase())) {
            result.sources.push(array);
        } else if (ID_ARRAY_NAMES.has(array.name.toLowerCase())) {
            result.ids.push(array);
        } else {
            result.other.push(array);
        }
    }
    result.fluxGroups.sort((a, b) => fluxGroupIndex(a.name) - fluxGroupIndex(b.name));
    return result;
}

/** The trame viewer's color-by value for an array ('Point: <name>' / 'Cell: <name>'). */
export function colorByValue(array: OpenMCVtkArrayInfo): string {
    return `${array.association === 'point' ? 'Point' : 'Cell'}: ${array.name}`;
}

/** Pick the default color-by array: first flux group, else first array. */
export function defaultColorBy(classified: ClassifiedVtkArrays): string | undefined {
    const first = classified.fluxGroups[0] ?? classified.sources[0] ?? classified.ids[0] ?? classified.other[0];
    return first ? colorByValue(first) : undefined;
}
