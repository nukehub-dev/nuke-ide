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
 * Parameter-path application against the IDE state model.
 *
 * Single source of truth for the optimization parameter vocabulary used by
 * parameter sweeps and the criticality search: `<materialName>.density`,
 * `<materialName>.temperature`, `<materialName>.<nuclideName>` (fraction,
 * with renormalization of the remaining nuclides), `settings.particles` /
 * `settings.inactive` / `settings.batches` / `settings.seed`, and
 * `geometry.<cellName>.temperature`. The Python drivers (run_optimization.py
 * via index paths, run_keff_search.py via this same vocabulary) apply the
 * equivalent semantics against the openmc.Model.
 *
 * @module openmc-studio/common
 */

import { OpenMCState } from './openmc-state-schema';

/**
 * Apply a parameter value to the state using the optimization parameter-path
 * vocabulary. Mutates the passed state (callers clone first when needed).
 *
 * @param state - The state to modify.
 * @param paramPath - Dot-separated parameter path (see module doc).
 * @param value - The value to assign.
 * @returns Whether the path resolved and the value was applied.
 */
export function applyParameterByPath(state: OpenMCState, paramPath: string, value: number): boolean {
    const parts = paramPath.split('.');

    if (parts.length < 2) {
        return false;
    }

    const typePrefix = parts[0];

    if (typePrefix === 'settings') {
        return applySettingsParameter(state, parts.slice(1).join('.'), value);
    }

    if (typePrefix === 'geometry') {
        return applyGeometryParameter(state, parts.slice(1).join('.'), value);
    }

    const [materialName, ...rest] = parts;
    const targetField = rest.join('.');

    const material = state.materials.find((m) => m.name.toLowerCase() === materialName.toLowerCase());
    if (!material) {
        return false;
    }

    const nuclide = material.nuclides.find((n) => n.name.toLowerCase() === targetField.toLowerCase());
    if (nuclide) {
        setNuclideFraction(material, targetField, value);
        return true;
    }

    const prop = targetField.toLowerCase();
    if (prop === 'density') {
        material.density = value;
        return true;
    }
    if (prop === 'temperature') {
        material.temperature = value;
        return true;
    }
    return false;
}

/**
 * Apply a settings.* parameter (particles/inactive/batches/seed).
 * @param state - The state to modify.
 * @param settingKey - The settings key (without the `settings.` prefix).
 * @param value - The value to assign.
 * @returns Whether the key resolved and the value was applied.
 */
function applySettingsParameter(state: OpenMCState, settingKey: string, value: number): boolean {
    if (!state.settings || !state.settings.run) {
        return false;
    }

    const runSettings = state.settings.run as { particles?: number; inactive?: number; batches?: number };

    switch (settingKey) {
        case 'particles':
            if ('particles' in runSettings) {
                runSettings.particles = Math.max(1, Math.round(value));
                return true;
            }
            return false;
        case 'inactive':
            if ('inactive' in runSettings) {
                runSettings.inactive = Math.max(0, Math.round(value));
                return true;
            }
            return false;
        case 'batches':
            if ('batches' in runSettings) {
                runSettings.batches = Math.max(1, Math.round(value));
                return true;
            }
            return false;
        case 'seed':
            state.settings.seed = Math.max(1, Math.round(value));
            return true;
        default:
            return false;
    }
}

/**
 * Apply a geometry.<cellName>.temperature parameter.
 * @param state - The state to modify.
 * @param paramKey - The cell key (without the `geometry.` prefix).
 * @param value - The value to assign.
 * @returns Whether the cell resolved and the value was applied.
 */
function applyGeometryParameter(state: OpenMCState, paramKey: string, value: number): boolean {
    const parts = paramKey.split('.');
    if (parts.length < 2) {
        return false;
    }

    const [cellName, prop] = parts;

    if (!state.geometry || !state.geometry.cells) {
        return false;
    }

    const cell = state.geometry.cells.find((c) => c.name?.toLowerCase() === cellName.toLowerCase());
    if (!cell) {
        return false;
    }

    if (prop === 'temperature') {
        cell.temperature = value;
        return true;
    }
    return false;
}

/**
 * Extract the element symbol from a nuclide name ('U235' → 'u', 'Am242_m1' → 'am', 'O16' → 'o').
 * @param name - Nuclide name.
 * @returns Lowercase element symbol.
 */
function elementSymbol(name: string): string {
    const match = name.match(/^([A-Za-z]+)/);
    return match ? match[1].toLowerCase() : name.toLowerCase();
}

/**
 * Set a specific nuclide's fraction in a material and renormalize ONLY the
 * other nuclides of the SAME ELEMENT (e.g. enriching U235 scales U238, never
 * O16 — compound stoichiometry is preserved). The element's total fraction is
 * kept constant; if the siblings' total is zero the remainder is distributed
 * equally. A single-nuclide-per-element material needs no renormalization.
 * @param material - The material to modify.
 * @param nuclideName - Name of the nuclide whose fraction is set.
 * @param fraction - New fraction for the target nuclide.
 */
function setNuclideFraction(material: OpenMCState['materials'][number], nuclideName: string, fraction: number): void {
    const targetNuclide = material.nuclides.find((n) => n.name.toLowerCase() === nuclideName.toLowerCase());

    if (!targetNuclide) {
        return;
    }

    const targetElement = elementSymbol(targetNuclide.name);
    const siblings = material.nuclides.filter(
        (n) =>
            n.name.toLowerCase() !== nuclideName.toLowerCase() &&
            elementSymbol(n.name) === targetElement &&
            n.fractionType === targetNuclide.fractionType
    );

    if (siblings.length === 0) {
        targetNuclide.fraction = fraction;
        return;
    }

    const elementTotalBefore = targetNuclide.fraction + siblings.reduce((sum, n) => sum + n.fraction, 0);
    const remainingFraction = elementTotalBefore - fraction;
    const siblingTotalBefore = siblings.reduce((sum, n) => sum + n.fraction, 0);

    targetNuclide.fraction = fraction;

    if (siblingTotalBefore > 0) {
        for (const n of siblings) {
            n.fraction = (n.fraction / siblingTotalBefore) * remainingFraction;
        }
    } else {
        const equalFraction = remainingFraction / siblings.length;
        for (const n of siblings) {
            n.fraction = equalFraction;
        }
    }
}
