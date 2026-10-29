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
 * Variance-reduction model helpers shared by XML generation/import, the Python
 * exporter, the state manager, and the dashboard editors.
 *
 * The model mirrors OpenMC's `WeightWindows` XML shape (`openmc/weight_windows.py`)
 * and the uniform fission site setting (`openmc/settings.py` `ufs_mesh`).
 *
 * @module openmc-studio/common
 */

import {
    OpenMCAngleBias,
    OpenMCArrayBias,
    OpenMCBiasProbabilities,
    OpenMCMesh,
    OpenMCMixtureUnivariate,
    OpenMCSource,
    OpenMCSourceEnergy,
    OpenMCUnivariate,
    OpenMCVarianceReduction,
    OpenMCWeightWindows,
    OpenMCUFS
} from './openmc-state-schema';
import { getMeshElementCount } from './mesh-utils';

/** Default energy-bound structure for a fresh weight-window set: one group. */
export const DEFAULT_WEIGHT_WINDOW_ENERGY_BOUNDS = [0, 20e6];

/** Default lower weight bound for a fresh set. */
export const DEFAULT_WEIGHT_WINDOW_LOWER_BOUND = 0.5;

/** Maximum number of split particles OpenMC allows by default. */
export const DEFAULT_WEIGHT_WINDOW_MAX_SPLIT = 10;

/** Default weight cutoff below which particles are terminated. */
export const DEFAULT_WEIGHT_WINDOW_CUTOFF = 1e-38;

/** One variance-reduction validation finding (cause + fix). */
export interface VarianceReductionIssue {
    /** Whether the finding blocks a run. */
    severity: 'error' | 'warning';
    /** Editor field the finding belongs to. */
    field: 'weight-windows' | 'weight-windows-file' | 'weight-window-checkpoints' | 'weight-window-generator' | 'ufs';
    /** What is wrong. */
    message: string;
    /** How to fix it. */
    suggestion: string;
}

/** Result of migrating a legacy variance-reduction object. */
export interface VarianceReductionMigration {
    /** Normalized variance-reduction object (sourceBiasing removed). */
    varianceReduction?: OpenMCVarianceReduction;
    /** Sources with any migrated energy bias attached. */
    sources: OpenMCSource[];
    /** Human-readable migration notes (shown in the run log). */
    warnings: string[];
}

/** Number of energy groups in a weight-window set (at least one). */
export function weightWindowEnergyGroups(set: OpenMCWeightWindows): number {
    return set.energyBounds && set.energyBounds.length >= 2 ? set.energyBounds.length - 1 : 1;
}

/** Number of mesh elements for a weight-window set's mesh. */
export function weightWindowCellCount(set: OpenMCWeightWindows, meshes: OpenMCMesh[]): number | undefined {
    const mesh = meshes.find((candidate) => candidate.id === set.meshId);
    return mesh ? getMeshElementCount(mesh) : undefined;
}

/**
 * Expand a scalar or array weight bound to one value per mesh cell and energy
 * group, matching OpenMC's `lower_ww_bounds` / `upper_ww_bounds` requirement.
 * @param bound - Scalar broadcast value or an explicit array.
 * @param total - Required number of values.
 * @returns The expanded array (or the explicit array unchanged when its length differs).
 */
export function expandWeightWindowBound(bound: number | number[] | undefined, total: number): number[] {
    if (bound === undefined) {
        return [];
    }
    if (Array.isArray(bound)) {
        return bound;
    }
    return Array.from({ length: Math.max(0, total) }, () => bound);
}

/** Resolve the lower and upper bound arrays for one set. */
export function resolveWeightWindowBounds(
    set: OpenMCWeightWindows,
    meshes: OpenMCMesh[]
): { lower: number[]; upper: number[]; total: number } {
    const cells = weightWindowCellCount(set, meshes) ?? 1;
    const total = cells * weightWindowEnergyGroups(set);
    const lower = expandWeightWindowBound(set.lowerBound, total);
    const upper = set.upperBound === undefined ? lower.map((value) => value * 2) : expandWeightWindowBound(set.upperBound, total);
    return { lower, upper, total };
}

/** Next unused weight-window set ID (IDs start at 1). */
export function nextWeightWindowId(sets: OpenMCWeightWindows[] | undefined): number {
    const used = new Set((sets ?? []).map((set) => set.id).filter((id): id is number => typeof id === 'number'));
    let id = 1;
    while (used.has(id)) {
        id += 1;
    }
    return id;
}

/**
 * Build a fresh weight-window set against a mesh.
 * @param meshId - Mesh the set applies to.
 * @param sets - Existing sets (used to pick a unique ID).
 * @returns A new set with one energy group.
 */
export function defaultWeightWindowSet(meshId: number, sets?: OpenMCWeightWindows[]): OpenMCWeightWindows {
    return {
        id: nextWeightWindowId(sets),
        meshId,
        particleType: 'neutron',
        energyBounds: [...DEFAULT_WEIGHT_WINDOW_ENERGY_BOUNDS],
        lowerBound: DEFAULT_WEIGHT_WINDOW_LOWER_BOUND
    };
}

/** One-line summary for the weight-window list header. */
export function summarizeWeightWindows(sets: OpenMCWeightWindows[] | undefined): string {
    const list = sets ?? [];
    if (list.length === 0) {
        return 'No sets';
    }
    const meshIds = new Set(list.map((set) => set.meshId));
    const groups = list.reduce((total, set) => total + weightWindowEnergyGroups(set), 0);
    const setLabel = list.length === 1 ? '1 set' : `${list.length} sets`;
    const meshLabel = meshIds.size === 1 ? '1 mesh' : `${meshIds.size} meshes`;
    const groupLabel = groups === 1 ? '1 energy group' : `${groups} energy groups`;
    return `${setLabel} · ${meshLabel} · ${groupLabel}`;
}

/**
 * Normalize the legacy single weight-window object and any missing IDs into a
 * list. Explicit duplicate IDs are preserved so validation can flag them.
 * @param value - Weight windows from a project file or WWINP import.
 * @returns Normalized list, or undefined when nothing is configured.
 */
export function normalizeWeightWindowSets(value: unknown): OpenMCWeightWindows[] | undefined {
    if (!value) {
        return undefined;
    }
    const list = (Array.isArray(value) ? value : [value]).filter(
        (entry): entry is OpenMCWeightWindows => !!entry && typeof entry === 'object' && !Array.isArray(entry)
    );
    if (list.length === 0) {
        return undefined;
    }
    const used = new Set<number>();
    let next = 1;
    return list.map((entry) => {
        let id = typeof entry.id === 'number' && Number.isFinite(entry.id) && entry.id > 0 ? Math.trunc(entry.id) : undefined;
        if (id === undefined) {
            while (used.has(next)) {
                next += 1;
            }
            id = next;
        }
        used.add(id);
        return { ...entry, id };
    });
}

/**
 * Migrate legacy variance-reduction fields on load:
 * - old single `weightWindows` object → list;
 * - `sourceBiasing` → first independent source energy bias where the shape is
 *   representable, otherwise a warning;
 * - default `weightWindowsOn` to true when sets or a file are configured.
 *
 * @param varianceReduction - Variance reduction from the project file.
 * @param sources - Sources from the same project.
 * @returns Normalized variance reduction, sources, and migration warnings.
 */
export function migrateLegacyVarianceReduction(
    varianceReduction: OpenMCVarianceReduction | undefined,
    sources: OpenMCSource[]
): VarianceReductionMigration {
    if (!varianceReduction) {
        return { sources, warnings: [] };
    }
    const warnings: string[] = [];
    const nextSources = [...sources];
    const next: OpenMCVarianceReduction = { ...varianceReduction };
    const weightWindows = normalizeWeightWindowSets(varianceReduction.weightWindows);
    if (weightWindows) {
        next.weightWindows = weightWindows;
    } else {
        delete next.weightWindows;
    }

    const legacy = varianceReduction.sourceBiasing;
    if (legacy) {
        delete next.sourceBiasing;
        const sourceIndex = nextSources.findIndex((source) => (source.type ?? 'independent') === 'independent');
        const migrated = sourceIndex >= 0 ? migrateLegacyEnergyBias(nextSources[sourceIndex], legacy.energyBias) : undefined;
        if (sourceIndex >= 0 && migrated) {
            nextSources[sourceIndex] = migrated;
            warnings.push(
                `Retired source-biasing control migrated to the energy bias of source ${sourceIndex + 1}; adjust it in the source editor.`
            );
        } else if (legacy.energyBias || legacy.strengthBias !== undefined) {
            warnings.push('Retired source-biasing control had no representable per-distribution bias; it was dropped.');
        }
        if (legacy.spatialBias) {
            warnings.push(
                'Retired spatial source-biasing distribution was dropped: OpenMC biases point-cloud/mesh element probabilities, not box/sphere/cylinder distributions.'
            );
        }
        if (legacy.strengthBias !== undefined) {
            warnings.push('Retired strength-bias factor was dropped: OpenMC biases distributions, not source strength.');
        }
    }

    const hasWindows = (next.weightWindows?.length ?? 0) > 0;
    const hasFile = !!next.weightWindowsFile;
    if (next.weightWindowsOn === undefined && (hasWindows || hasFile)) {
        next.weightWindowsOn = true;
    }
    const isEmpty =
        !next.survivalBiasing &&
        !hasWindows &&
        !hasFile &&
        !next.weightWindowGenerator &&
        next.cutoff?.weight === undefined &&
        next.cutoff?.weightAvg === undefined &&
        !next.ufs?.enabled;
    return { varianceReduction: isEmpty ? undefined : next, sources: nextSources, warnings };
}

/**
 * Attach a legacy energy-bias distribution to an independent source when the
 * source's energy distribution can carry that bias shape.
 * @param source - Source to update.
 * @param energyBias - Legacy energy bias distribution.
 * @returns Updated source, or undefined when the shape cannot be migrated.
 */
function migrateLegacyEnergyBias(source: OpenMCSource, energyBias: OpenMCSourceEnergy | undefined): OpenMCSource | undefined {
    if (!energyBias || (source.type ?? 'independent') !== 'independent') {
        return undefined;
    }
    const independent = source as Extract<OpenMCSource, { spatial: unknown }>;
    if (independent.energy.bias) {
        return undefined;
    }
    if (independent.energy.type === 'decay-spectrum') {
        return undefined;
    }
    const bias =
        independent.energy.type === 'discrete' || independent.energy.type === 'mixture'
            ? probabilitiesFromLegacyBias(energyBias, independent.energy)
            : { distribution: stripBias(energyBias) };
    if (!bias) {
        return undefined;
    }
    return { ...independent, energy: { ...independent.energy, bias } } as OpenMCSource;
}

/** Map a legacy discrete bias distribution onto alternative probabilities. */
function probabilitiesFromLegacyBias(energyBias: OpenMCSourceEnergy, parent: OpenMCSourceEnergy): OpenMCBiasProbabilities | undefined {
    const length = parent.type === 'discrete' ? parent.energies.length : parent.type === 'mixture' ? parent.distributions.length : 0;
    if (length === 0) {
        return undefined;
    }
    if (energyBias.type === 'discrete' && energyBias.probabilities && energyBias.probabilities.length === length) {
        return { probabilities: [...energyBias.probabilities] };
    }
    if (energyBias.type === 'discrete' && energyBias.energies.length === length) {
        return { probabilities: energyBias.energies.map(() => 1 / length) };
    }
    return undefined;
}

/** Remove a bias from a distribution before nesting it as a bias. */
export function stripBias(distribution: OpenMCUnivariate): OpenMCUnivariate {
    const next = { ...distribution } as OpenMCUnivariate & { bias?: unknown };
    delete next.bias;
    if (next.type === 'mixture') {
        const mixture = next as OpenMCMixtureUnivariate;
        return { ...mixture, distributions: mixture.distributions.map(stripBias) } as OpenMCUnivariate;
    }
    return next;
}

/**
 * Remove every source-distribution bias from an independent source. Used when
 * the probed OpenMC environment predates source biasing; the unbiased model
 * still runs and validation explains the dropped feature.
 * @param source - Source to strip.
 * @returns Source without bias fields.
 */
export function stripSourceBias(source: OpenMCSource): OpenMCSource {
    if ((source.type ?? 'independent') !== 'independent') {
        return source;
    }
    const independent = source as Extract<OpenMCSource, { spatial: unknown }>;
    const energy = stripBias(independent.energy);
    const time =
        independent.time && independent.time.type !== 'delta' && 'bias' in independent.time && independent.time.bias
            ? (stripBias(independent.time) as typeof independent.time)
            : independent.time;
    const angle =
        independent.angle?.type === 'isotropic' && independent.angle.bias
            ? ({ type: 'isotropic' } as typeof independent.angle)
            : independent.angle;
    const spatial =
        (independent.spatial.type === 'pointcloud' || independent.spatial.type === 'mesh') && independent.spatial.bias
            ? ({ ...independent.spatial, bias: undefined } as typeof independent.spatial)
            : independent.spatial;
    return { ...independent, energy, time, angle, spatial };
}

/**
 * Reconcile a distribution's bias with its current type after the user changes
 * the type selector: discrete/mixture keep probability bias, continuous keep a
 * nested distribution, and decay spectra drop bias entirely.
 * @param distribution - Distribution that may carry a stale bias shape.
 * @returns Distribution with a compatible bias shape.
 */
export function reconcileUnivariateBias(distribution: OpenMCSourceEnergy): OpenMCSourceEnergy {
    if (!distribution.bias) {
        return distribution;
    }
    if (distribution.type === 'decay-spectrum') {
        return { ...distribution, bias: undefined };
    }
    if (distribution.type === 'discrete' || distribution.type === 'mixture') {
        return 'probabilities' in distribution.bias ? distribution : { ...distribution, bias: defaultUnivariateBias(distribution) };
    }
    return 'probabilities' in distribution.bias ? { ...distribution, bias: defaultUnivariateBias(distribution) } : distribution;
}

/**
 * Default bias for a continuous distribution: a copy of the parent with its
 * own bias removed. The distributions share support (OpenMC requirement), and
 * the user then edits the bias shape.
 */
export function defaultUnivariateBias(distribution: OpenMCSourceEnergy): OpenMCSourceEnergy['bias'] {
    if (distribution.type === 'decay-spectrum') {
        return undefined;
    }
    if (distribution.type === 'discrete') {
        const probabilities =
            distribution.probabilities && distribution.probabilities.length === distribution.energies.length
                ? [...distribution.probabilities]
                : distribution.energies.map(() => 1 / Math.max(1, distribution.energies.length));
        return { probabilities };
    }
    if (distribution.type === 'mixture') {
        return { probabilities: [...distribution.probability] };
    }
    return { distribution: stripBias(distribution) };
}

/** Default biased probabilities for a point-cloud/mesh array bias. */
export function defaultArrayBias(length: number): OpenMCArrayBias {
    return { probabilities: Array.from({ length: Math.max(0, length) }, () => 1) };
}

/** Default isotropic angle bias: full-range mu/phi (support must match OpenMC). */
export function defaultAngleBias(): OpenMCAngleBias {
    return {
        distribution: {
            type: 'mu-phi',
            mu: { type: 'uniform', min: -1, max: 1 },
            phi: { type: 'uniform', min: 0, max: 2 * Math.PI }
        }
    };
}

/** Whether a source distribution carries any bias. */
export function sourceHasBias(source: OpenMCSource): boolean {
    if ((source.type ?? 'independent') !== 'independent') {
        return false;
    }
    const independent = source as Extract<OpenMCSource, { spatial: unknown }>;
    return !!(
        independent.energy.bias ||
        (independent.time?.type !== 'delta' && independent.time && 'bias' in independent.time && independent.time.bias) ||
        (independent.angle?.type === 'isotropic' && independent.angle.bias) ||
        (independent.spatial.type === 'pointcloud' && independent.spatial.bias) ||
        (independent.spatial.type === 'mesh' && independent.spatial.bias)
    );
}

/** Human-readable list of biased distributions on a source. */
export function summarizeSourceBias(source: OpenMCSource): string[] {
    if ((source.type ?? 'independent') !== 'independent') {
        return [];
    }
    const independent = source as Extract<OpenMCSource, { spatial: unknown }>;
    const labels: string[] = [];
    if (independent.energy.bias) {
        labels.push('energy bias');
    }
    if (independent.time && independent.time.type !== 'delta' && 'bias' in independent.time && independent.time.bias) {
        labels.push('time bias');
    }
    if (independent.angle?.type === 'isotropic' && independent.angle.bias) {
        labels.push('angle bias');
    }
    if (independent.spatial.type === 'pointcloud' && independent.spatial.bias) {
        labels.push('point-cloud bias');
    }
    if (independent.spatial.type === 'mesh' && independent.spatial.bias) {
        labels.push('mesh bias');
    }
    return labels;
}

/**
 * Explain whether OpenMC supports biasing a distribution-level spatial
 * distribution. Only point-cloud and mesh spatial models expose per-element
 * probabilities; the convenience point/box/sphere/cylinder distributions do not.
 * @param type - Spatial distribution type.
 * @returns 'array' when bias is available, 'none' otherwise.
 */
export function spatialBiasSupport(type: string): 'array' | 'none' {
    return type === 'pointcloud' || type === 'mesh' ? 'array' : 'none';
}

/**
 * Validate weight windows, the weight-window file, checkpoints, the generator,
 * and UFS. Source distribution bias is validated by the source helpers.
 * @param vr - Variance reduction state.
 * @param meshes - State meshes.
 * @param runMode - Current run mode (UFS is eigenvalue-only).
 * @returns Validation findings.
 */
export function validateVarianceReduction(
    vr: OpenMCVarianceReduction | undefined,
    meshes: OpenMCMesh[],
    runMode: string
): VarianceReductionIssue[] {
    const issues: VarianceReductionIssue[] = [];
    if (!vr) {
        return issues;
    }
    const sets = vr.weightWindows ?? [];
    const usedIds = new Set<number>();
    for (let index = 0; index < sets.length; index++) {
        const set = sets[index];
        const label = `Weight-window set ${set.id ?? index + 1}`;
        if (set.id !== undefined) {
            if (usedIds.has(set.id)) {
                issues.push({
                    severity: 'error',
                    field: 'weight-windows',
                    message: `${label} repeats an existing set ID`,
                    suggestion: 'Give every weight-window set a unique ID'
                });
            }
            usedIds.add(set.id);
        }
        if (!Number.isFinite(set.meshId)) {
            issues.push({
                severity: 'error',
                field: 'weight-windows',
                message: `${label} has no mesh selected`,
                suggestion: 'Select a mesh for the set or delete it'
            });
        } else {
            const mesh = meshes.find((candidate) => candidate.id === set.meshId);
            if (!mesh) {
                issues.push({
                    severity: 'error',
                    field: 'weight-windows',
                    message: `${label} references mesh ${set.meshId}, which does not exist`,
                    suggestion: 'Select an existing mesh or create one in the Tallies tab'
                });
            }
        }
        const energyBounds = set.energyBounds ?? [];
        if (energyBounds.length < 2) {
            issues.push({
                severity: 'error',
                field: 'weight-windows',
                message: `${label} needs at least two energy bounds`,
                suggestion: 'Set a lower and upper energy bound in eV (for example 0 and 20e6)'
            });
        } else {
            for (let i = 1; i < energyBounds.length; i++) {
                if (!(energyBounds[i] > energyBounds[i - 1])) {
                    issues.push({
                        severity: 'error',
                        field: 'weight-windows',
                        message: `${label} energy bounds must strictly increase`,
                        suggestion: `Fix the boundary at position ${i + 1} so it is greater than the previous value`
                    });
                    break;
                }
            }
        }
        const cells = weightWindowCellCount(set, meshes);
        const total = (cells ?? 1) * weightWindowEnergyGroups(set);
        const lower = set.lowerBound;
        if (Array.isArray(lower)) {
            if (lower.length === 0) {
                issues.push({
                    severity: 'error',
                    field: 'weight-windows',
                    message: `${label} has an empty lower-bound array`,
                    suggestion: 'Enter a scalar lower bound or one value per mesh cell and energy group'
                });
            } else if (cells !== undefined && lower.length !== total) {
                issues.push({
                    severity: 'error',
                    field: 'weight-windows',
                    message: `${label} has ${lower.length} lower bounds but the mesh needs ${total} (${cells} cells × ${
                        total / Math.max(1, cells)
                    } groups)`,
                    suggestion: 'Use a scalar lower bound or provide exactly one value per mesh cell and energy group'
                });
            }
        } else if (!Number.isFinite(lower) || lower <= 0) {
            issues.push({
                severity: 'error',
                field: 'weight-windows',
                message: `${label} lower bound must be a positive number`,
                suggestion: 'Enter a lower weight bound greater than zero'
            });
        }
        if (set.upperBound !== undefined) {
            if (Array.isArray(set.upperBound)) {
                if (set.upperBound.length === 0) {
                    issues.push({
                        severity: 'error',
                        field: 'weight-windows',
                        message: `${label} has an empty upper-bound array`,
                        suggestion: 'Enter a scalar upper bound or one value per mesh cell and energy group'
                    });
                } else if (cells !== undefined && set.upperBound.length !== total) {
                    issues.push({
                        severity: 'error',
                        field: 'weight-windows',
                        message: `${label} has ${set.upperBound.length} upper bounds but the mesh needs ${total}`,
                        suggestion: 'Use a scalar upper bound or match the lower-bound array length'
                    });
                }
            } else if (!Number.isFinite(set.upperBound) || set.upperBound <= 0) {
                issues.push({
                    severity: 'error',
                    field: 'weight-windows',
                    message: `${label} upper bound must be a positive number`,
                    suggestion: 'Enter an upper weight bound greater than zero'
                });
            }
        }
        if (set.survivalWeight !== undefined && (!Number.isFinite(set.survivalWeight) || set.survivalWeight <= 0)) {
            issues.push({
                severity: 'error',
                field: 'weight-windows',
                message: `${label} survival ratio must be positive`,
                suggestion: 'Enter the survival-ratio multiplier (OpenMC default 3.0)'
            });
        }
        if (set.maxSplit !== undefined && (!Number.isInteger(set.maxSplit) || set.maxSplit <= 0)) {
            issues.push({
                severity: 'error',
                field: 'weight-windows',
                message: `${label} max split must be a positive integer`,
                suggestion: 'Enter a whole number of splits (OpenMC default 10)'
            });
        }
        if (set.weightCutoff !== undefined && (!Number.isFinite(set.weightCutoff) || set.weightCutoff <= 0)) {
            issues.push({
                severity: 'error',
                field: 'weight-windows',
                message: `${label} weight cutoff must be positive`,
                suggestion: 'Enter a cutoff greater than zero (OpenMC default 1e-38)'
            });
        }
    }

    const configured = sets.length > 0 || !!vr.weightWindowsFile || !!vr.weightWindowGenerator;
    const enabled = vr.weightWindowsOn ?? configured;
    const generatorOnTheFly = !!vr.weightWindowGenerator && (vr.weightWindowGenerator.onTheFly ?? true);
    if (!enabled && generatorOnTheFly) {
        issues.push({
            severity: 'warning',
            field: 'weight-window-generator',
            message: 'The weight-window generator applies windows on the fly and overrides the disabled enable flag',
            suggestion: 'Turn off the generator or enable weight windows explicitly'
        });
    }
    if (enabled && sets.length > 0 && vr.weightWindowsFile) {
        issues.push({
            severity: 'warning',
            field: 'weight-windows-file',
            message: 'Both weight-window sets and a weight-window file are configured; OpenMC loads both',
            suggestion: 'Use the file for a generated bootstrap run and keep the sets only if you intend both to apply'
        });
    }
    if (enabled && vr.weightWindowGenerator && vr.weightWindowsFile) {
        issues.push({
            severity: 'warning',
            field: 'weight-window-generator',
            message: 'A weight-window generator may overwrite the configured weight-window file',
            suggestion: 'After the generation run, turn the generator off and keep the generated file for production runs'
        });
    }
    if (enabled || generatorOnTheFly) {
        const checkpoints = vr.weightWindowCheckpoints ?? {};
        if (checkpoints.collision === false && checkpoints.surface === false) {
            issues.push({
                severity: 'error',
                field: 'weight-window-checkpoints',
                message: 'Weight windows are enabled but both collision and surface checkpoints are off',
                suggestion: 'Enable at least one checkpoint (collision is the OpenMC default)'
            });
        }
    }
    if (vr.weightWindowGenerator) {
        const generatorMesh = resolveWeightWindowGeneratorMesh(vr);
        if (generatorMesh === undefined) {
            issues.push({
                severity: 'error',
                field: 'weight-window-generator',
                message: 'Weight-window generator has no mesh',
                suggestion: 'Select a generator mesh or create a weight-window set with a mesh'
            });
        }
    }
    if (vr.ufs?.enabled) {
        const ufs = vr.ufs;
        if (ufs.meshId === undefined) {
            issues.push({
                severity: 'error',
                field: 'ufs',
                message: 'Uniform fission site is enabled without a mesh',
                suggestion: 'Select a regular UFS mesh that covers all fissionable material'
            });
        } else {
            const mesh = meshes.find((candidate) => candidate.id === ufs.meshId);
            if (!mesh) {
                issues.push({
                    severity: 'error',
                    field: 'ufs',
                    message: `Uniform fission site references mesh ${ufs.meshId}, which does not exist`,
                    suggestion: 'Select an existing regular mesh or create one in the Tallies tab'
                });
            } else if (mesh.type !== 'regular') {
                issues.push({
                    severity: 'error',
                    field: 'ufs',
                    message: 'Uniform fission site requires a regular mesh',
                    suggestion: 'Select a regular (Cartesian) mesh; OpenMC rejects cylindrical/spherical UFS meshes'
                });
            }
        }
        if (runMode !== 'eigenvalue') {
            issues.push({
                severity: 'warning',
                field: 'ufs',
                message: 'Uniform fission site applies to fission sites in eigenvalue runs and is ignored here',
                suggestion: 'Switch the run mode to eigenvalue or disable UFS'
            });
        }
    }
    return issues;
}

/** Resolve the mesh used by the weight-window generator. */
export function resolveWeightWindowGeneratorMesh(vr: OpenMCVarianceReduction | undefined): number | undefined {
    if (!vr?.weightWindowGenerator) {
        return undefined;
    }
    return vr.weightWindowGenerator.meshId ?? vr.weightWindows?.[0]?.meshId ?? vr.ufs?.meshId;
}

/** Resolve the mesh used by UFS (explicit mesh only). */
export function resolveUfsMeshId(ufs: OpenMCUFS | undefined): number | undefined {
    return ufs?.enabled ? ufs.meshId : undefined;
}

/**
 * Whether weight windows are effectively enabled (explicit flag wins when set;
 * otherwise sets, a file, or a generator enable them).
 */
export function resolveWeightWindowsEnabled(vr: OpenMCVarianceReduction | undefined): boolean {
    if (!vr) {
        return false;
    }
    if (vr.weightWindowsOn !== undefined) {
        return vr.weightWindowsOn;
    }
    return (vr.weightWindows?.length ?? 0) > 0 || !!vr.weightWindowsFile || !!vr.weightWindowGenerator;
}
