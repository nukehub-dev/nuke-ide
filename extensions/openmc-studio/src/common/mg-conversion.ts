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

/**
 * Pure state logic for the one-click CE ↔ multi-group conversion (P9B).
 * The backend driver (`python/convert_to_multigroup_project.py`) produces the
 * library plus a material → XS-data-name mapping; these functions compute the
 * state updates for applying or reverting the conversion. Materials without
 * an XS data set stay untouched in both directions (mixed models work).
 *
 * @module openmc-studio/common
 */

import { OpenMCMaterial, OpenMCProjectMetadata, OpenMCSettings, OpenMCState } from './openmc-state-schema';
import { expandMaterialNuclides } from './material-utils';
import { MgXsDataMapping, MgXsNuclideMapping } from './openmc-studio-protocol';

/** Energy group structures accepted by openmc.mgxs.EnergyGroups (UI lists). */
export const MGXS_GROUP_STRUCTURES = [
    'CASMO-2',
    'CASMO-4',
    'CASMO-8',
    'CASMO-16',
    'CASMO-25',
    'ECCO-33',
    'CASMO-40',
    'VITAMIN-J-42',
    'SCALE-44',
    'MPACT-51',
    'MPACT-60',
    'MPACT-69',
    'CASMO-70',
    'XMAS-172',
    'VITAMIN-J-175',
    'SCALE-252',
    'TRIPOLI-315',
    'SHEM-361',
    'LLNL-616',
    'CCFE-709'
];

/** State updates for applying a multi-group conversion. */
export interface MgConversionUpdates {
    /** Materials with macroscopic XS applied to the converted ones */
    materials: OpenMCMaterial[];
    /** Names of the materials that were converted */
    convertedNames: string[];
    /** Pre-conversion snapshot to stash in project metadata */
    mgBackup: NonNullable<OpenMCProjectMetadata['mgBackup']>;
    /** Settings updates: multi-group mode + library path (clears the nuclide-wise flag) */
    settings: Pick<OpenMCSettings, 'energyMode' | 'mgxsLibrary' | 'nuclideWiseMgxs'>;
}

/**
 * Compute the state updates for applying a successful conversion.
 * @param state - Current (continuous-energy) project state.
 * @param xsDataNames - Material → XS-data-name mapping from the backend job.
 * @param mgxsPath - Absolute path of the generated mgxs.h5 library.
 * @returns Materials with macroscopic XS applied, the backup, and settings updates.
 */
export function computeMgConversion(state: OpenMCState, xsDataNames: MgXsDataMapping[], mgxsPath: string): MgConversionUpdates {
    const xsByMaterial = new Map(xsDataNames.map((m) => [m.materialName, m.xsDataName]));
    const convertedNames: string[] = [];
    const materials = state.materials.map((material) => {
        const xsDataName = xsByMaterial.get(material.name);
        if (xsDataName === undefined) {
            return material;
        }
        convertedNames.push(material.name);
        return {
            ...material,
            macroscopic: { name: xsDataName },
            densityUnit: 'macro' as const,
            density: 1.0
        };
    });

    return {
        materials,
        convertedNames,
        mgBackup: {
            materials: state.materials.map((m) => ({ ...m })),
            energyMode: state.settings.energyMode
        },
        settings: { energyMode: 'multigroup', mgxsLibrary: mgxsPath, nuclideWiseMgxs: false }
    };
}

/** State updates for applying a nuclide-wise multi-group conversion. */
export interface NuclideWiseMgConversionUpdates {
    /** Materials, unchanged — nuclide-wise conversion keeps them nuclide-decomposed */
    materials: OpenMCMaterial[];
    /** Nuclide names (after element expansion) covered by the library */
    coveredNuclides: string[];
    /** Nuclide names the materials need but the library does not provide */
    missingNuclides: string[];
    /** Pre-conversion snapshot to stash in project metadata */
    mgBackup: NonNullable<OpenMCProjectMetadata['mgBackup']>;
    /** Settings updates: multi-group mode + library path + nuclide-wise flag */
    settings: Pick<OpenMCSettings, 'energyMode' | 'mgxsLibrary' | 'nuclideWiseMgxs'>;
}

/**
 * Compute the state updates for applying a successful nuclide-wise conversion.
 * Unlike the material-wise conversion, no material is modified: materials stay
 * nuclide-decomposed and resolve each `<nuclide>` against a same-named XS data
 * set in the library. Element constituents (e.g. 'Fe') are checked against the
 * library after natural-isotope expansion — the same expansion XML emission
 * performs, so the two sides stay consistent.
 * @param state - Current (continuous-energy) project state.
 * @param xsNuclideNames - Nuclide → XS-data-name mapping from the backend job.
 * @param mgxsPath - Absolute path of the generated mgxs.h5 library.
 * @returns Unchanged materials, library coverage, the backup, and settings updates.
 */
export function computeNuclideWiseMgConversion(
    state: OpenMCState,
    xsNuclideNames: MgXsNuclideMapping[],
    mgxsPath: string
): NuclideWiseMgConversionUpdates {
    const libraryNuclides = new Set(xsNuclideNames.map((m) => m.xsDataName));
    const required = new Set<string>();
    for (const material of state.materials) {
        if (material.macroscopic) {
            continue;
        }
        let expanded: { name: string }[];
        try {
            expanded = expandMaterialNuclides(material.nuclides ?? []);
        } catch {
            // Unknown element names — fall back to the raw names so coverage is
            // still reported (XML emission surfaces the real error later).
            expanded = (material.nuclides ?? []).map((n) => ({ name: n.name }));
        }
        for (const nuclide of expanded) {
            required.add(nuclide.name);
        }
    }
    const coveredNuclides = [...required].filter((name) => libraryNuclides.has(name)).sort();
    const missingNuclides = [...required].filter((name) => !libraryNuclides.has(name)).sort();

    return {
        materials: state.materials.map((m) => ({ ...m })),
        coveredNuclides,
        missingNuclides,
        mgBackup: {
            materials: state.materials.map((m) => ({ ...m })),
            energyMode: state.settings.energyMode
        },
        settings: { energyMode: 'multigroup', mgxsLibrary: mgxsPath, nuclideWiseMgxs: true }
    };
}

/** State updates for reverting a multi-group conversion. */
export interface MgRevertUpdates {
    /** Restored pre-conversion materials */
    materials: OpenMCMaterial[];
    /** Restored pre-conversion energy mode */
    energyMode: OpenMCSettings['energyMode'];
}

/**
 * Compute the state updates for reverting to continuous-energy.
 * The MGXS library path is kept; the backup is cleared by the caller.
 * `macroscopic` is stripped explicitly (set to `undefined`) because callers
 * apply these materials through the state manager's shallow-merge update,
 * which keeps any key absent from the update — without the explicit key the
 * stale macroscopic XS reference would survive the revert.
 * @param state - Current (multi-group, converted) project state.
 * @returns The restored materials and energy mode, or undefined without a backup.
 */
export function computeMgRevert(state: OpenMCState): MgRevertUpdates | undefined {
    const backup = state.metadata.mgBackup;
    if (!backup) {
        return undefined;
    }
    return {
        materials: backup.materials.map((m) => ({ ...m, macroscopic: undefined })),
        energyMode: backup.energyMode
    };
}
