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

import { OpenMCNuclide } from './openmc-state-schema';
import { NATURAL_ELEMENTS } from './natural-elements';

/**
 * Shared material helper utilities.
 *
 * Names ending in digits are treated as individual nuclides (e.g. U235, Fe56,
 * H2). Bare element symbols (e.g. U, Fe, Pb) are treated as natural elements.
 * The OpenMC XML reader used by the `openmc` binary no longer accepts the
 * `<element>` tag, so elements must be expanded into their natural isotopes
 * before XML emission.
 */

/**
 * Determine whether a material constituent name refers to a natural element.
 *
 * Names ending with one or more digits are interpreted as specific nuclides;
 * everything else is interpreted as an element symbol.
 */
export function isElementName(name: string): boolean {
    return !/\d+$/.test(name);
}

/**
 * Extract the mass number from a nuclide name (e.g. "U235" -> 235, "H2" -> 2).
 */
function massNumberFromNuclide(name: string): number {
    const match = name.match(/(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
}

/**
 * Atomic weight used for weight-fraction conversion.
 */
function atomicWeightForNuclide(name: string): number {
    if (isElementName(name)) {
        const element = NATURAL_ELEMENTS[name];
        if (!element) {
            throw new Error(`Unknown element: ${name}`);
        }
        return element.atomicWeight;
    }
    const massNumber = massNumberFromNuclide(name);
    if (massNumber <= 0) {
        throw new Error(`Cannot determine atomic weight for ${name}`);
    }
    return massNumber;
}

/**
 * Expand a material's constituents into individual nuclides.
 *
 * Element symbols are expanded to their natural isotopes using the abundances
 * in {@link NATURAL_ELEMENTS}. Weight fractions (`wo`) are first converted to
 * atomic fractions at the material level, then expanded. The returned list
 * always uses atomic fractions (`ao`).
 *
 * When `availableNuclides` is provided, element expansion is limited to
 * isotopes present in the data library; missing isotopes are dropped and the
 * remaining abundances are renormalized within that element. Explicitly named
 * nuclides are never filtered.
 */
export function expandMaterialNuclides(nuclides: OpenMCNuclide[], availableNuclides?: Set<string>): { name: string; fraction: number }[] {
    if (nuclides.length === 0) {
        return [];
    }

    const hasElements = nuclides.some((n) => isElementName(n.name));
    if (!hasElements) {
        return nuclides.map((n) => ({ name: n.name, fraction: n.fraction }));
    }

    // Convert to atomic fractions first.
    let atomicFractions: { name: string; fraction: number }[];

    const allAreAo = nuclides.every((n) => n.fractionType === 'ao');
    const allAreWo = nuclides.every((n) => n.fractionType === 'wo');

    if (allAreAo) {
        atomicFractions = nuclides.map((n) => ({ name: n.name, fraction: n.fraction }));
    } else if (allAreWo) {
        // Convert weight fractions to atomic fractions.
        let total = 0;
        const proportional: { name: string; value: number }[] = [];
        for (const n of nuclides) {
            const value = n.fraction / atomicWeightForNuclide(n.name);
            proportional.push({ name: n.name, value });
            total += value;
        }
        atomicFractions = proportional.map((p) => ({ name: p.name, fraction: total > 0 ? p.value / total : 0 }));
    } else {
        // Mixed ao/wo within one material is ambiguous; treat as ao for safety.
        atomicFractions = nuclides.map((n) => ({ name: n.name, fraction: n.fraction }));
    }

    // Expand elements to isotopes.
    const expanded: { name: string; fraction: number }[] = [];
    for (const n of atomicFractions) {
        if (isElementName(n.name)) {
            const element = NATURAL_ELEMENTS[n.name];
            if (!element) {
                throw new Error(`Unknown element: ${n.name}`);
            }

            let isotopes = Object.entries(element.isotopes);
            if (availableNuclides) {
                isotopes = isotopes.filter(([isotope]) => availableNuclides.has(isotope));
            }

            if (isotopes.length === 0) {
                throw new Error(
                    `No isotopes of element ${n.name} are available in the cross-sections library. ` +
                        `Check that your nuclear data library includes this element.`
                );
            }

            const abundanceSum = isotopes.reduce((sum, [, abundance]) => sum + abundance, 0);
            for (const [isotope, abundance] of isotopes) {
                const normalizedAbundance = abundanceSum > 0 ? abundance / abundanceSum : 0;
                expanded.push({ name: isotope, fraction: n.fraction * normalizedAbundance });
            }
        } else {
            expanded.push({ name: n.name, fraction: n.fraction });
        }
    }

    return expanded;
}
