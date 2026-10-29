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
 * Validation for tally filters, shared by the backend readiness checklist and
 * the filter editor's inline messages. Messages carry both a cause and a fix.
 *
 * @module openmc-studio/common
 */

import { OpenMCCell, OpenMCMaterial, OpenMCMesh, OpenMCTally, OpenMCTallyFilter } from './openmc-state-schema';
import { getMeshElementCount } from './mesh-utils';
import { normalizeReactionBin } from './reaction-catalog';
import { getCellInstancePairs, getMeshMaterialPairs } from './tally-filter-utils';

/** Model inventory used to validate filter references. */
export interface TallyFilterValidationContext {
    /** Geometry cells (cell-instance and material domains). */
    cells?: OpenMCCell[];
    /** Project materials (material-from and mesh-material domains). */
    materials?: OpenMCMaterial[];
    /** Project meshes (mesh filters). */
    meshes?: OpenMCMesh[];
}

/** One filter validation finding. */
export interface TallyFilterValidationIssue {
    /** Whether the finding blocks a run. */
    severity: 'error' | 'warning';
    /** What is wrong and why. */
    message: string;
    /** How to fix it. */
    fix: string;
}

function isStrictlyIncreasing(values: number[]): boolean {
    return values.every((value, index) => index === 0 || value > values[index - 1]);
}

function validateMeshReference(
    filter: OpenMCTallyFilter,
    context: TallyFilterValidationContext,
    issues: TallyFilterValidationIssue[]
): void {
    const meshIds = new Set((context.meshes ?? []).map((mesh) => mesh.id));
    if (filter.meshId === undefined || filter.meshId === 0) {
        issues.push({
            severity: 'error',
            message: `${filter.type} filter has no mesh selected`,
            fix: 'Select a mesh in the filter editor or create one in the Meshes tab'
        });
    } else if (context.meshes && !meshIds.has(filter.meshId)) {
        issues.push({
            severity: 'error',
            message: `${filter.type} filter references mesh ${filter.meshId} which does not exist`,
            fix: 'Choose an existing mesh in the filter editor or re-create the deleted mesh'
        });
    }
}

/**
 * Validate one filter's bins, pairs, references, and ranges.
 *
 * @param filter - Filter to validate.
 * @param context - Current geometry/materials/meshes.
 * @returns Findings; an empty array means the filter is valid.
 */
export function validateTallyFilter(filter: OpenMCTallyFilter, context: TallyFilterValidationContext = {}): TallyFilterValidationIssue[] {
    const issues: TallyFilterValidationIssue[] = [];
    const materialIds = new Set((context.materials ?? []).map((material) => material.id));
    const cellIds = new Set((context.cells ?? []).map((cell) => cell.id));

    switch (filter.type) {
        case 'materialfrom':
            if (filter.bins.length === 0) {
                issues.push({
                    severity: 'error',
                    message: 'Material-from filter has no material bins',
                    fix: 'Add at least one material ID to count events by the material the particle came from'
                });
            }
            for (const bin of filter.bins) {
                if (!Number.isInteger(bin) || bin <= 0) {
                    issues.push({
                        severity: 'error',
                        message: `Material-from bin ${bin} is not a positive material ID`,
                        fix: 'Use whole material IDs from the Materials tab'
                    });
                } else if (context.materials && !materialIds.has(bin)) {
                    issues.push({
                        severity: 'error',
                        message: `Material-from filter references material ${bin}, which is not defined`,
                        fix: 'Pick an existing material ID or create the material first'
                    });
                }
            }
            break;

        case 'cellinstance': {
            const pairs = getCellInstancePairs(filter);
            if (filter.bins.length % 2 !== 0) {
                issues.push({
                    severity: 'error',
                    message: 'Cell-instance bins must be cell/instance pairs, but the list has an odd length',
                    fix: 'Remove the extra value or add the missing instance number'
                });
            }
            if (pairs.length === 0 && filter.bins.length === 0) {
                issues.push({
                    severity: 'error',
                    message: 'Cell-instance filter has no pairs',
                    fix: 'Add a row with a cell ID and instance index (instance 0 is the first occurrence)'
                });
            }
            for (const pair of pairs) {
                if (!Number.isInteger(pair.first) || pair.first <= 0) {
                    issues.push({
                        severity: 'error',
                        message: `Cell-instance cell ${pair.first} is not a positive cell ID`,
                        fix: 'Choose a cell from the geometry or enter its whole ID'
                    });
                } else if (context.cells && !cellIds.has(pair.first)) {
                    issues.push({
                        severity: 'error',
                        message: `Cell-instance filter references cell ${pair.first}, which is not in the geometry`,
                        fix: 'Pick a cell from the geometry tree or create it first'
                    });
                }
                if (!Number.isInteger(pair.second) || pair.second < 0) {
                    issues.push({
                        severity: 'error',
                        message: `Cell-instance instance ${pair.second} for cell ${pair.first} is not a non-negative whole number`,
                        fix: 'Use 0 for the first instance, 1 for the second, and so on'
                    });
                }
            }
            break;
        }

        case 'parentnuclide':
            if (!filter.nuclideBins || filter.nuclideBins.length === 0) {
                issues.push({
                    severity: 'error',
                    message: 'Parent-nuclide filter has no nuclides',
                    fix: 'Add one or more parent nuclide names, for example U235 or Pu239'
                });
            }
            for (const name of filter.nuclideBins ?? []) {
                if (!name.trim() || /\s/.test(name)) {
                    issues.push({
                        severity: 'error',
                        message: `Parent nuclide "${name}" is not a valid nuclide name`,
                        fix: 'Use the compact OpenMC name without spaces, for example U235 or Am242m'
                    });
                }
            }
            break;

        case 'meshborn':
            validateMeshReference(filter, context, issues);
            break;

        case 'meshmaterial': {
            validateMeshReference(filter, context, issues);
            const pairs = getMeshMaterialPairs(filter);
            if (filter.bins.length % 2 !== 0) {
                issues.push({
                    severity: 'error',
                    message: 'Mesh-material bins must be element/material pairs, but the list has an odd length',
                    fix: 'Remove the extra value or add the missing pair member'
                });
            }
            if (pairs.length === 0 && filter.bins.length === 0) {
                issues.push({
                    severity: 'error',
                    message: 'Mesh-material filter has no element/material pairs',
                    fix: 'Add a row with a zero-based mesh element and a material'
                });
            }
            const mesh = (context.meshes ?? []).find((candidate) => candidate.id === filter.meshId);
            const elementCount = mesh ? getMeshElementCount(mesh) : undefined;
            for (const pair of pairs) {
                if (!Number.isInteger(pair.first) || pair.first < 0) {
                    issues.push({
                        severity: 'error',
                        message: `Mesh-material element ${pair.first} is not a zero-based whole element index`,
                        fix: 'Use 0 for the first mesh element, 1 for the second, and so on'
                    });
                } else if (elementCount !== undefined && pair.first >= elementCount) {
                    issues.push({
                        severity: 'error',
                        message: `Mesh-material element ${pair.first} is outside mesh ${filter.meshId} (${elementCount} elements)`,
                        fix: `Use an element index from 0 to ${elementCount - 1}`
                    });
                }
                if (!Number.isInteger(pair.second) || pair.second <= 0) {
                    issues.push({
                        severity: 'error',
                        message: `Mesh-material material ${pair.second} is not a positive material ID`,
                        fix: 'Choose a material from the Materials tab'
                    });
                } else if (context.materials && !materialIds.has(pair.second)) {
                    issues.push({
                        severity: 'error',
                        message: `Mesh-material filter references material ${pair.second}, which is not defined`,
                        fix: 'Pick an existing material or create it first'
                    });
                }
            }
            break;
        }

        case 'mesh':
        case 'meshsurface':
            validateMeshReference(filter, context, issues);
            break;

        case 'collision':
            if (filter.bins.length === 0) {
                issues.push({
                    severity: 'error',
                    message: 'Collision filter has no collision numbers',
                    fix: 'Add positive collision numbers, for example 1 2 3'
                });
            }
            if (!filter.bins.every((bin) => Number.isInteger(bin) && bin >= 1)) {
                issues.push({
                    severity: 'error',
                    message: 'Collision bins must be positive whole collision numbers',
                    fix: 'Replace fractional or zero values with collision counts ≥ 1'
                });
            }
            if (!isStrictlyIncreasing(filter.bins)) {
                issues.push({
                    severity: 'error',
                    message: 'Collision bins are not in ascending order',
                    fix: 'Sort the collision numbers from smallest to largest'
                });
            }
            break;

        case 'reaction':
            if (!filter.reactionBins || filter.reactionBins.length === 0) {
                issues.push({
                    severity: 'error',
                    message: 'Reaction filter has no reactions',
                    fix: 'Pick a reaction such as (n,gamma) or add an MT number like 102'
                });
            }
            for (const bin of filter.reactionBins ?? []) {
                if (!normalizeReactionBin(bin)) {
                    issues.push({
                        severity: 'error',
                        message: `Reaction "${bin}" is not a known OpenMC reaction`,
                        fix: 'Pick a reaction from the MT/name list or use a valid MT number such as 102'
                    });
                }
            }
            break;

        case 'particleproduction': {
            const particles = filter.particleTypes ?? [];
            if (particles.length === 0) {
                issues.push({
                    severity: 'error',
                    message: 'Particle-production filter has no secondary particle types',
                    fix: 'Select at least one particle such as photon or neutron'
                });
            }
            for (const particle of particles) {
                if (!particle.trim() || /\s/.test(particle)) {
                    issues.push({
                        severity: 'error',
                        message: `Particle type "${particle}" is not a valid OpenMC particle name`,
                        fix: 'Use a compact name such as photon, neutron, electron, positron, or a nuclide like C12'
                    });
                }
            }
            const energies = filter.productionEnergyBins ?? [];
            if (energies.length === 1) {
                issues.push({
                    severity: 'error',
                    message: 'Particle-production energy binning needs at least two boundaries',
                    fix: 'Add an upper boundary or clear the energy bins for un-binned production'
                });
            }
            if (energies.length >= 2 && !isStrictlyIncreasing(energies)) {
                issues.push({
                    severity: 'error',
                    message: 'Particle-production energy boundaries are not strictly increasing',
                    fix: 'Order the boundaries from lowest to highest energy in eV'
                });
            }
            if (energies.some((energy) => !Number.isFinite(energy) || energy < 0)) {
                issues.push({
                    severity: 'error',
                    message: 'Particle-production energy boundaries must be finite and non-negative',
                    fix: 'Enter energies in eV using non-negative numbers'
                });
            }
            break;
        }

        case 'musurface':
            if (filter.bins.length < 2) {
                issues.push({
                    severity: 'error',
                    message: 'Mu-surface filter needs at least two cosine boundaries',
                    fix: 'Provide a range such as -1 0 1'
                });
            }
            if (filter.bins.some((bin) => !Number.isFinite(bin) || bin < -1 || bin > 1)) {
                issues.push({
                    severity: 'error',
                    message: 'Mu-surface boundaries must lie between -1 and 1',
                    fix: 'Clamp every boundary to the cosine of the surface-crossing angle'
                });
            }
            if (!isStrictlyIncreasing(filter.bins)) {
                issues.push({
                    severity: 'error',
                    message: 'Mu-surface boundaries are not strictly increasing',
                    fix: 'Order the boundaries from -1 to 1'
                });
            }
            break;

        case 'weight':
            if (filter.bins.length < 2) {
                issues.push({
                    severity: 'error',
                    message: 'Weight filter needs at least two weight boundaries',
                    fix: 'Provide a range such as 0 0.5 1 2'
                });
            }
            if (filter.bins.some((bin) => !Number.isFinite(bin) || bin < 0)) {
                issues.push({
                    severity: 'error',
                    message: 'Weight boundaries must be finite and non-negative',
                    fix: 'Enter non-negative incoming particle weights'
                });
            }
            if (!isStrictlyIncreasing(filter.bins)) {
                issues.push({
                    severity: 'error',
                    message: 'Weight boundaries are not strictly increasing',
                    fix: 'Order the boundaries from lowest to highest weight'
                });
            }
            break;

        default:
            break;
    }

    return issues;
}

/**
 * Validate the filters a mu-surface tally needs alongside it.
 *
 * `musurface` bins the angle at which a particle crosses a surface, so OpenMC
 * only populates it for `current` scores on a tally that also has a surface
 * filter.
 *
 * @param filters - Every filter on the tally.
 * @param scores - Tally scores.
 * @returns Findings for the mu-surface companions.
 */
export function validateMusurfaceCompanions(filters: OpenMCTallyFilter[], scores: OpenMCTally['scores']): TallyFilterValidationIssue[] {
    const issues: TallyFilterValidationIssue[] = [];
    if (!filters.some((filter) => filter.type === 'musurface')) {
        return issues;
    }
    if (!filters.some((filter) => filter.type === 'surface')) {
        issues.push({
            severity: 'warning',
            message: 'Mu-surface filter needs a surface filter to know which crossing angle to bin',
            fix: 'Add a surface filter or remove the mu-surface filter'
        });
    }
    if (!scores.includes('current')) {
        issues.push({
            severity: 'warning',
            message: 'Mu-surface filter is only populated for the current score',
            fix: 'Add the current score or remove the mu-surface filter'
        });
    }
    return issues;
}

/**
 * Validate every filter on a tally plus cross-filter requirements.
 *
 * @param tally - Tally whose filters/scores are checked.
 * @param context - Current geometry/materials/meshes.
 * @returns Findings; an empty array means the tally's filters are consistent.
 */
export function validateTallyFilterSet(
    tally: Pick<OpenMCTally, 'filters' | 'scores'>,
    context: TallyFilterValidationContext = {}
): TallyFilterValidationIssue[] {
    const issues: TallyFilterValidationIssue[] = [];
    issues.push(...validateMusurfaceCompanions(tally.filters, tally.scores));
    for (const filter of tally.filters) {
        issues.push(...validateTallyFilter(filter, context));
    }
    return issues;
}
