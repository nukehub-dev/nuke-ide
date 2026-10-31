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
 * OpenMC Settings Edit
 *
 * Pure validation, diff, and application helpers for the basic run/settings
 * paths that NukeAI may edit. The whitelist deliberately excludes sources,
 * output, random ray, CMFD, geometry, materials, and tallies: those edits need
 * dedicated validation and remain out of scope for the safe settings loop.
 *
 * @module openmc-studio/browser/capabilities
 */

import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import { OpenMCSettings } from '../../common/openmc-state-schema';

/** One requested settings path/value pair. */
export interface OpenMCSettingsEdit {
    readonly path: string;
    readonly value: unknown;
}

/** Supported basic run/settings paths. */
export const SUPPORTED_SETTINGS_PATHS = [
    'run.particles',
    'run.inactive',
    'run.batches',
    'seed',
    'threads',
    'verbosity',
    'energyMode',
    'photonTransport',
    'electronTreatment',
    'atomicRelaxation',
    'sourceRejectionFraction'
] as const;

/** A path from {@link SUPPORTED_SETTINGS_PATHS}. */
export type OpenMCSettingsPath = (typeof SUPPORTED_SETTINGS_PATHS)[number];

/** Human labels for the settings diff card. */
const SETTINGS_LABELS: Record<OpenMCSettingsPath, string> = {
    'run.particles': 'Particles per batch',
    'run.inactive': 'Inactive batches',
    'run.batches': 'Batches',
    seed: 'Random number seed',
    threads: 'OpenMP threads',
    verbosity: 'Verbosity',
    energyMode: 'Energy mode',
    photonTransport: 'Photon transport',
    electronTreatment: 'Electron treatment',
    atomicRelaxation: 'Atomic relaxation',
    sourceRejectionFraction: 'Source rejection fraction'
};

/** Loose run record used for path reads and mode checks. */
interface RunSettingsRecord {
    mode?: string;
    particles?: number;
    inactive?: number;
    batches?: number;
}

/** Read the run settings through a narrow record. */
function runSettings(settings: OpenMCSettings): RunSettingsRecord {
    return settings.run as unknown as RunSettingsRecord;
}

/** True when the current run settings support an inactive-batch value. */
function runSupportsInactive(settings: OpenMCSettings): boolean {
    const run = runSettings(settings);
    return run.mode === 'eigenvalue' || (run.mode === 'fixed source' && typeof run.inactive === 'number');
}

/** True for a finite numeric value. */
function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** True for a numeric integer value. */
function isInteger(value: unknown): value is number {
    return isFiniteNumber(value) && Number.isInteger(value);
}

/** True when the string is one of the supported settings paths. */
export function isSettingsPath(path: string): path is OpenMCSettingsPath {
    return (SUPPORTED_SETTINGS_PATHS as readonly string[]).includes(path);
}

/**
 * Validate a proposed settings edit against the current settings.
 *
 * @param path - Dot-separated settings path.
 * @param value - Proposed value.
 * @param settings - Current settings, used for mode-dependent paths.
 * @returns An error message, or `undefined` when the edit is valid.
 */
export function validateSettingsChange(path: string, value: unknown, settings: OpenMCSettings): string | undefined {
    if (!isSettingsPath(path)) {
        return `${path} is not a supported OpenMC settings path.`;
    }
    switch (path) {
        case 'run.particles':
        case 'run.batches':
        case 'threads':
            return isInteger(value) && value >= 1 ? undefined : `${path} must be an integer greater than or equal to 1.`;
        case 'run.inactive':
            if (!runSupportsInactive(settings)) {
                return 'run.inactive is not available in the current run mode.';
            }
            return isInteger(value) && value >= 0 ? undefined : `${path} must be an integer greater than or equal to 0.`;
        case 'seed':
            return isInteger(value) && value >= 0 ? undefined : `${path} must be an integer greater than or equal to 0.`;
        case 'verbosity':
            return isInteger(value) && value >= 1 && value <= 10 ? undefined : `${path} must be an integer from 1 to 10.`;
        case 'energyMode':
            return value === 'continuous-energy' || value === 'multigroup'
                ? undefined
                : `${path} must be 'continuous-energy' or 'multigroup'.`;
        case 'photonTransport':
        case 'atomicRelaxation':
            return typeof value === 'boolean' ? undefined : `${path} must be a boolean.`;
        case 'electronTreatment':
            return value === 'led' || value === 'ttb' ? undefined : `${path} must be 'led' or 'ttb'.`;
        case 'sourceRejectionFraction':
            return isFiniteNumber(value) && value >= 0 && value <= 1 ? undefined : `${path} must be a number from 0 to 1.`;
    }
}

/**
 * Read a supported settings value.
 *
 * @param settings - Settings to read.
 * @param path - Dot-separated settings path.
 * @returns The current value, or `undefined` for an optional unset field.
 */
export function settingsValue(settings: OpenMCSettings, path: string): unknown {
    if (!isSettingsPath(path)) {
        return undefined;
    }
    switch (path) {
        case 'run.particles':
            return runSettings(settings).particles;
        case 'run.inactive':
            return runSettings(settings).inactive;
        case 'run.batches':
            return runSettings(settings).batches;
        case 'seed':
            return settings.seed;
        case 'threads':
            return settings.threads;
        case 'verbosity':
            return settings.verbosity;
        case 'energyMode':
            return settings.energyMode;
        case 'photonTransport':
            return settings.photonTransport;
        case 'electronTreatment':
            return settings.electronTreatment;
        case 'atomicRelaxation':
            return settings.atomicRelaxation;
        case 'sourceRejectionFraction':
            return settings.sourceRejectionFraction;
    }
}

/**
 * Deep-clone settings and apply the requested paths.
 *
 * @param settings - Current settings; never mutated.
 * @param changes - Path/value edits.
 * @returns The updated settings.
 */
export function applySettingsChanges(settings: OpenMCSettings, changes: readonly OpenMCSettingsEdit[]): OpenMCSettings {
    const next = JSON.parse(JSON.stringify(settings)) as OpenMCSettings;
    for (const change of changes) {
        if (!isSettingsPath(change.path)) {
            throw new Error(`${change.path} is not a supported OpenMC settings path.`);
        }
        if (change.path.startsWith('run.')) {
            const run = next.run as unknown as Record<string, unknown>;
            run[change.path.slice('run.'.length)] = change.value;
        } else {
            (next as unknown as Record<string, unknown>)[change.path] = change.value;
        }
    }
    return next;
}

/**
 * Compare settings values for stale checks.
 *
 * Undefined object properties and missing properties compare equal so optional
 * unset settings never look changed. Arrays compare by index and objects by
 * key, independent of insertion order.
 *
 * @param left - First value.
 * @param right - Second value.
 * @returns Whether both values are equivalent.
 */
export function settingsEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => settingsEqual(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
    const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    return leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && settingsEqual(leftRecord[key], rightRecord[key])
    );
}

/**
 * Build the before/after diff for requested edits.
 *
 * @param settings - Current settings.
 * @param changes - Path/value edits.
 * @returns One labelled change per edit.
 * @throws Error when a path, value, or no-op edit is invalid.
 */
export function settingsChanges(settings: OpenMCSettings, changes: readonly OpenMCSettingsEdit[]): NukeChange[] {
    return changes.map((change) => {
        if (!isSettingsPath(change.path)) {
            throw new Error(`${change.path} is not a supported OpenMC settings path.`);
        }
        const error = validateSettingsChange(change.path, change.value, settings);
        if (error) {
            throw new Error(error);
        }
        const before = settingsValue(settings, change.path);
        if (settingsEqual(before, change.value)) {
            throw new Error(`${SETTINGS_LABELS[change.path]} is already set to the requested value.`);
        }
        return {
            path: change.path,
            label: SETTINGS_LABELS[change.path],
            kind: 'update' as const,
            before,
            after: change.value
        };
    });
}
