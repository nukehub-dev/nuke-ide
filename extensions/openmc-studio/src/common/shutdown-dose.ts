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
 * Shutdown-dose (R2S / D1S) configuration helpers.
 *
 * Pure model-level logic shared by the wizard, the Python exporter, and tests:
 * default configuration, schedule normalization, domain/tally readiness, and
 * dose-tally construction. The actual calculation is driven by the Python
 * backends; none of this state is represented in settings.xml.
 *
 * @module openmc-studio/common
 */

import {
    OpenMCCell,
    OpenMCMesh,
    OpenMCRegularMesh,
    OpenMCShutdownDoseBoundingBox,
    OpenMCShutdownDoseConfig,
    OpenMCShutdownDoseTallyTemplate,
    OpenMCState,
    OpenMCTally,
    OpenMCTallyFilter
} from './openmc-state-schema';

/** One normalized schedule interval. */
export interface ShutdownDoseScheduleStep {
    /** Raw value in the configured unit */
    value: number;
    /** Time unit */
    unit: 's' | 'min' | 'h' | 'd' | 'a';
    /** Interval length in seconds */
    seconds: number;
    /** Source rate for the interval in neutrons/s */
    sourceRate: number;
}

/** Readiness issue for a shutdown-dose configuration. */
export interface ShutdownDoseIssue {
    /** Blocking (`error`) or advisory (`warning`) */
    severity: 'error' | 'warning';
    /** Configuration field or area */
    field: string;
    /** What is wrong */
    message: string;
    /** How to fix it */
    suggestion: string;
}

/** Overall readiness summary used by the wizard. */
export interface ShutdownDoseReadiness {
    /** No blocking issues */
    ready: boolean;
    /** Blocking issues */
    errors: ShutdownDoseIssue[];
    /** Non-blocking issues */
    warnings: ShutdownDoseIssue[];
    /** Normalized schedule (empty when the schedule is invalid) */
    schedule: ShutdownDoseScheduleStep[];
}

/** Supported timestep units and their length in seconds. */
export const SHUTDOWN_DOSE_TIMESTEP_UNITS: Record<'s' | 'min' | 'h' | 'd' | 'a', number> = {
    s: 1,
    min: 60,
    h: 3600,
    d: 86400,
    a: 365.25 * 86400
};

/** Default dose-response template (ICRP-116 effective dose, AP). */
export const DEFAULT_SHUTDOWN_DOSE_TALLY_TEMPLATE: OpenMCShutdownDoseTallyTemplate = {
    dataSource: 'icrp116',
    doseQuantity: 'effective',
    geometry: 'AP',
    interpolation: 'log-log'
};

/**
 * Create a new shutdown-dose configuration with safe defaults.
 * @param state - Optional project state used to seed tally/chain selections.
 * @returns A complete configuration.
 */
export function createDefaultShutdownDoseConfig(state?: OpenMCState): OpenMCShutdownDoseConfig {
    const photonTallies = state ? getPhotonTallies(state) : [];
    return {
        method: 'r2s',
        domainType: 'cell',
        cellIds: [],
        meshIds: [],
        timesteps: [1, 1],
        timestepUnits: 'd',
        sourceRates: [1.0e12, 0],
        chainFile: state?.depletion?.chainFile,
        photonTimeIndices: undefined,
        byParentNuclide: false,
        photonTallyIds: photonTallies.length > 0 ? photonTallies.map((tally) => tally.id) : [],
        d1sTimeIndex: -1,
        d1sSumNuclides: true,
        matVolSamples: 100000,
        runNeutron: true,
        runPhoton: true,
        wizardStep: 'method',
        doseTallyTemplate: { ...DEFAULT_SHUTDOWN_DOSE_TALLY_TEMPLATE }
    };
}

/**
 * Whether a tally scores photons (particle filter with a photon bin).
 * @param tally - Tally to inspect.
 * @returns True when the tally targets photons.
 */
export function isPhotonTally(tally: OpenMCTally): boolean {
    return tally.filters.some((filter) => filter.type === 'particle' && (filter.bins ?? []).includes(2));
}

/**
 * Photon tallies available for R2S copying or D1S correction.
 * @param state - Current project state.
 * @returns Tally list.
 */
export function getPhotonTallies(state: OpenMCState): OpenMCTally[] {
    return state.tallies.filter(isPhotonTally);
}

/**
 * Next free tally ID in a project.
 * @param state - Current project state.
 * @returns One greater than the largest existing tally ID.
 */
export function getNextShutdownDoseTallyId(state: OpenMCState): number {
    return state.tallies.reduce((max, tally) => Math.max(max, tally.id), 0) + 1;
}

/**
 * Parse a single timestep value (`3`, `"3 d"`, `"1.5 h"`) into value + unit.
 * @param value - Raw timestep.
 * @param defaultUnit - Unit applied to numeric values.
 * @returns Parsed value and unit, or undefined when invalid.
 */
export function parseShutdownDoseTimestep(
    value: number | string,
    defaultUnit: 's' | 'min' | 'h' | 'd' | 'a' = 's'
): { value: number; unit: 's' | 'min' | 'h' | 'd' | 'a' } | undefined {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? { value, unit: defaultUnit } : undefined;
    }
    const match = String(value)
        .trim()
        .match(/^([+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(s|min|h|d|a)?$/i);
    if (!match) {
        return undefined;
    }
    const parsed = parseFloat(match[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    const unit = (match[2]?.toLowerCase() ?? defaultUnit) as 's' | 'min' | 'h' | 'd' | 'a';
    if (!(unit in SHUTDOWN_DOSE_TIMESTEP_UNITS)) {
        return undefined;
    }
    return { value: parsed, unit };
}

/**
 * Normalize timesteps and source rates to per-interval schedule entries.
 * @param config - Shutdown-dose configuration.
 * @returns Schedule entries plus human-readable errors.
 */
export function normalizeShutdownDoseSchedule(config: OpenMCShutdownDoseConfig): {
    schedule: ShutdownDoseScheduleStep[];
    errors: string[];
} {
    const errors: string[] = [];
    const defaultUnit = config.timestepUnits ?? 's';
    const raw = config.timesteps ?? [];
    if (raw.length === 0) {
        errors.push('Add at least one timestep to the activation schedule.');
    }

    const rates = Array.isArray(config.sourceRates) ? config.sourceRates : [config.sourceRates];
    if (Array.isArray(config.sourceRates) && config.sourceRates.length !== raw.length) {
        errors.push(`Source rates (${config.sourceRates.length}) must match the ${raw.length} timestep(s).`);
    }

    const schedule: ShutdownDoseScheduleStep[] = [];
    raw.forEach((value, index) => {
        const parsed = parseShutdownDoseTimestep(value, defaultUnit);
        if (!parsed) {
            errors.push(`Timestep ${index + 1} must be a positive number with an optional unit (s, min, h, d, a).`);
            return;
        }
        const rate = typeof config.sourceRates === 'number' ? config.sourceRates : rates[index];
        if (!Number.isFinite(rate) || rate < 0) {
            errors.push(`Source rate ${index + 1} must be a non-negative number.`);
            return;
        }
        schedule.push({
            value: parsed.value,
            unit: parsed.unit,
            seconds: parsed.value * SHUTDOWN_DOSE_TIMESTEP_UNITS[parsed.unit],
            sourceRate: rate
        });
    });

    return { schedule, errors };
}

/**
 * Total number of photon time indices (steps + 1).
 * @param config - Shutdown-dose configuration.
 * @returns Time-index count.
 */
export function getShutdownDoseTimeIndexCount(config: OpenMCShutdownDoseConfig): number {
    return Math.max(0, (config.timesteps ?? []).length + 1);
}

/**
 * Human-readable timestep label (`3 d`).
 * @param value - Raw timestep.
 * @param defaultUnit - Unit for numeric values.
 * @returns Display label.
 */
export function formatShutdownDoseTimestep(value: number | string, defaultUnit: 's' | 'min' | 'h' | 'd' | 'a' = 's'): string {
    const parsed = parseShutdownDoseTimestep(value, defaultUnit);
    return parsed ? `${parsed.value} ${parsed.unit}` : String(value);
}

/**
 * AABB overlap test for two regular meshes.
 * @param a - First mesh.
 * @param b - Second mesh.
 * @returns True when the bounding boxes intersect.
 */
export function regularMeshesOverlap(a: OpenMCRegularMesh, b: OpenMCRegularMesh): boolean {
    const overlapOnAxis = (index: 0 | 1 | 2): boolean =>
        Math.min(a.upperRight[index], b.upperRight[index]) > Math.max(a.lowerLeft[index], b.lowerLeft[index]);
    return overlapOnAxis(0) && overlapOnAxis(1) && overlapOnAxis(2);
}

/**
 * Full validation and readiness for a shutdown-dose configuration.
 * @param state - Current project state.
 * @param config - Configuration to validate (defaults to `state.shutdownDose`).
 * @returns Readiness summary.
 */
export function assessShutdownDoseReadiness(state: OpenMCState, config?: OpenMCShutdownDoseConfig): ShutdownDoseReadiness {
    const cfg = config ?? state.shutdownDose;
    const issues: ShutdownDoseIssue[] = [];
    const { schedule, errors: scheduleErrors } = cfg
        ? normalizeShutdownDoseSchedule(cfg)
        : { schedule: [], errors: ['Configure a shutdown-dose method.'] };
    for (const message of scheduleErrors) {
        issues.push({ severity: 'error', field: 'schedule', message, suggestion: 'Edit the schedule in the previous step.' });
    }

    if (!cfg) {
        return {
            ready: false,
            errors: issues,
            warnings: [],
            schedule
        };
    }

    if (state.settings.run.mode !== 'fixed source') {
        issues.push({
            severity: 'error',
            field: 'method',
            message: 'Shutdown dose requires a fixed-source model.',
            suggestion: 'Switch the run mode to fixed source in the Simulation tab; eigenvalue mode cannot transport a decay photon source.'
        });
    }

    if (!cfg.chainFile) {
        issues.push({
            severity: 'error',
            field: 'chain',
            message: 'No depletion chain selected.',
            suggestion: 'Choose a chain XML in the Schedule step. The chain supplies activation cross sections and decay data.'
        });
    }

    if (!cfg.workingDirectory && !cfg.outputDirectory) {
        issues.push({
            severity: 'error',
            field: 'output',
            message: 'No run directory selected.',
            suggestion: 'Choose a run directory in the Review step; the generated XML and driver output are written there.'
        });
    }

    const runPhoton = cfg.runPhoton !== false;
    const photonTallies = getPhotonTallies(state);
    if (runPhoton) {
        const selected = cfg.photonTallyIds ?? [];
        if (selected.length === 0) {
            issues.push({
                severity: 'error',
                field: 'tallies',
                message: photonTallies.length === 0 ? 'No photon tallies defined yet.' : 'No photon tallies selected.',
                suggestion:
                    photonTallies.length === 0
                        ? 'Add a dose tally or define a photon tally in the Tally Configurator.'
                        : 'Select at least one photon tally in the Photon tallies step.'
            });
        }
        for (const id of selected) {
            const tally = state.tallies.find((candidate) => candidate.id === id);
            if (!tally) {
                issues.push({
                    severity: 'error',
                    field: 'tallies',
                    message: `Selected tally ${id} no longer exists.`,
                    suggestion: 'Reselect an existing photon tally.'
                });
            } else if (!isPhotonTally(tally)) {
                issues.push({
                    severity: 'error',
                    field: 'tallies',
                    message: `Tally ${id} does not target photons.`,
                    suggestion: 'Add a Particle Filter with the photon bin, or add the dose tally template.'
                });
            }
        }
    }

    if (cfg.method === 'r2s') {
        if (cfg.runNeutron === false) {
            issues.push({
                severity: 'error',
                field: 'method',
                message: 'Neutron transport cannot be skipped for a new R2S run.',
                suggestion: 'Leave neutron transport enabled or start from a previous R2S output tree.'
            });
        }
        if ((cfg.domainType ?? 'cell') === 'cell') {
            const cellIds = cfg.cellIds ?? [];
            if (cellIds.length === 0) {
                issues.push({
                    severity: 'error',
                    field: 'domains',
                    message: 'No activation cells selected.',
                    suggestion: 'Select one or more material-filled cells.'
                });
            }
            for (const id of cellIds) {
                const cell = state.geometry.cells.find((candidate) => candidate.id === id);
                if (!cell) {
                    issues.push({
                        severity: 'error',
                        field: 'domains',
                        message: `Activation cell ${id} no longer exists.`,
                        suggestion: 'Reselect the cell.'
                    });
                    continue;
                }
                if (cell.fillType !== 'material') {
                    issues.push({
                        severity: 'error',
                        field: 'domains',
                        message: `Cell ${id} is not filled with a material.`,
                        suggestion: 'R2S activation requires material-filled cells; select a different cell.'
                    });
                }
                if (!(cell.volume && cell.volume > 0)) {
                    issues.push({
                        severity: 'error',
                        field: 'domains',
                        message: `Cell ${id} has no volume.`,
                        suggestion: 'Enter the cell volume in cm³ (run a volume calculation if needed).'
                    });
                }
                const box = cfg.boundingBoxes?.[id];
                if (box && !validBoundingBox(box)) {
                    issues.push({
                        severity: 'error',
                        field: 'domains',
                        message: `Cell ${id} bounding box is invalid.`,
                        suggestion: 'Each upper-right coordinate must be greater than the lower-left coordinate.'
                    });
                } else if (!box) {
                    issues.push({
                        severity: 'warning',
                        field: 'domains',
                        message: `Cell ${id} will use its computed bounding box.`,
                        suggestion: 'If OpenMC cannot bound the CSG region at run time, set an explicit box override.'
                    });
                }
            }
        } else {
            const meshIds = cfg.meshIds ?? [];
            if (meshIds.length === 0) {
                issues.push({
                    severity: 'error',
                    field: 'domains',
                    message: 'No activation meshes selected.',
                    suggestion: 'Select one or more meshes. Multiple meshes must not overlap.'
                });
            }
            const meshes: OpenMCMesh[] = [];
            for (const id of meshIds) {
                const mesh = state.meshes.find((candidate) => candidate.id === id);
                if (!mesh) {
                    issues.push({
                        severity: 'error',
                        field: 'domains',
                        message: `Activation mesh ${id} no longer exists.`,
                        suggestion: 'Reselect the mesh.'
                    });
                } else {
                    meshes.push(mesh);
                }
            }
            const regular = meshes.filter((mesh): mesh is OpenMCRegularMesh => mesh.type === 'regular');
            for (let i = 0; i < regular.length; i++) {
                for (let j = i + 1; j < regular.length; j++) {
                    if (regularMeshesOverlap(regular[i], regular[j])) {
                        issues.push({
                            severity: 'warning',
                            field: 'domains',
                            message: `Meshes ${regular[i].id} and ${regular[j].id} have overlapping bounds.`,
                            suggestion:
                                'OpenMC treats mesh elements as independent activation regions; use non-overlapping meshes or verify the overlap is intended.'
                        });
                    }
                }
            }
        }
    } else {
        const count = getShutdownDoseTimeIndexCount(cfg);
        const index = cfg.d1sTimeIndex ?? -1;
        const normalized = index < 0 ? count + index : index;
        if (count === 0 || normalized < 0 || normalized >= count) {
            issues.push({
                severity: 'error',
                field: 'd1s',
                message: 'D1S correction time index is outside the schedule.',
                suggestion: `Choose an index between 0 and ${Math.max(0, count - 1)} (negative indices count from the end).`
            });
        }
    }

    return {
        ready: issues.every((issue) => issue.severity !== 'error'),
        errors: issues.filter((issue) => issue.severity === 'error'),
        warnings: issues.filter((issue) => issue.severity === 'warning'),
        schedule
    };
}

/**
 * Whether an explicit bounding box is well formed.
 * @param box - Bounding box override.
 * @returns True when every upper coordinate exceeds the lower coordinate.
 */
export function validBoundingBox(box: OpenMCShutdownDoseBoundingBox): boolean {
    return [0, 1, 2].every((index) => box.upperRight[index] > box.lowerLeft[index]);
}

/**
 * Create a dose tally from an OpenMC dose-response table.
 *
 * The response values come from `openmc.data.dose_coefficients` (through the
 * backend); the UI never invents a response function.
 *
 * @param id - New tally ID.
 * @param template - Dose-response selection.
 * @param energyValues - Energy grid in eV.
 * @param responseValues - Response at each energy.
 * @param meshId - Optional mesh filter.
 * @returns A photon flux tally with an energy-function response.
 */
export function createDoseTally(
    id: number,
    template: OpenMCShutdownDoseTallyTemplate,
    energyValues: number[],
    responseValues: number[],
    meshId?: number
): OpenMCTally {
    const filters: OpenMCTallyFilter[] = [
        { type: 'particle', bins: [2] },
        {
            type: 'energyfunction',
            bins: [],
            energyValues: [...energyValues],
            responseValues: [...responseValues],
            interpolation: template.interpolation
        }
    ];
    if (meshId !== undefined) {
        filters.push({ type: 'mesh', bins: [], meshId });
    }
    const quantity = template.doseQuantity === 'ambient' ? 'ambient dose' : 'effective dose';
    return {
        id,
        name: `Dose (${template.dataSource.toUpperCase()} ${quantity}${template.doseQuantity === 'effective' ? ` ${template.geometry}` : ''})`,
        scores: ['flux'],
        nuclides: ['total'],
        filters
    };
}

/**
 * A cell's readiness for R2S activation.
 * @param cell - Cell to inspect.
 * @param configuredVolume - State cell volume (may be absent).
 * @returns Short status label and whether the cell can be activated.
 */
export function describeCellActivationReadiness(cell: OpenMCCell): { ready: boolean; detail: string } {
    if (cell.fillType !== 'material') {
        return { ready: false, detail: 'Not material-filled' };
    }
    if (!(cell.volume && cell.volume > 0)) {
        return { ready: false, detail: 'Volume required' };
    }
    return { ready: true, detail: `Volume ${cell.volume.toPrecision(4)} cm³` };
}
