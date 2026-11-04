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
 * Pure validation, diff, and application helpers for the run/settings paths
 * that NukeAI may edit. The whitelist covers basic run controls, output
 * toggles and path, particle cutoffs, and kinetics (IFP) options. Sources,
 * random ray, CMFD, geometry, materials, and tallies stay out of scope: those
 * edits need dedicated validation and remain in their own flows.
 *
 * Nested paths write only the addressed leaf and preserve every unrelated key.
 *
 * @module openmc-studio/browser/capabilities
 */

import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import { getAutoIfpTallies } from '../../common/kinetics-ifp';
import { OpenMCSettings, OpenMCTally } from '../../common/openmc-state-schema';

/** One requested settings path/value pair. */
export interface OpenMCSettingsEdit {
    readonly path: string;
    readonly value: unknown;
}

/** Extra state used for cross-field settings checks. */
export interface OpenMCSettingsValidationContext {
    /** Current project tallies, used when enabling kinetics. */
    readonly tallies?: readonly OpenMCTally[];
    /** Set false at apply time to skip the IFP tally presence check. */
    readonly requireKineticsTallies?: boolean;
}

/** Largest precursor-group count offered by the dashboard's Precursor Groups select (2-8 group-wise; 1 means total-only). */
export const MAX_PRECURSOR_GROUPS = 8;

/** Longest accepted `output.path` value. */
export const MAX_OUTPUT_PATH_LENGTH = 255;

/** Supported run/settings paths. */
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
    'sourceRejectionFraction',
    'output.summary',
    'output.tallies',
    'output.path',
    'cutoff.energyNeutron',
    'cutoff.energyPhoton',
    'cutoff.time',
    'cutoff.timePhoton',
    'cutoff.weight',
    'cutoff.weightAvg',
    'kinetics.enabled',
    'kinetics.ifpNGenerations',
    'kinetics.numPrecursorGroups',
    'kinetics.computeBetaEff'
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
    sourceRejectionFraction: 'Source rejection fraction',
    'output.summary': 'Write summary.h5',
    'output.tallies': 'Write tallies.out',
    'output.path': 'Output path',
    'cutoff.energyNeutron': 'Neutron energy cutoff',
    'cutoff.energyPhoton': 'Photon energy cutoff',
    'cutoff.time': 'Neutron time cutoff',
    'cutoff.timePhoton': 'Photon time cutoff',
    'cutoff.weight': 'Weight cutoff',
    'cutoff.weightAvg': 'Average survival weight',
    'kinetics.enabled': 'Kinetics (IFP)',
    'kinetics.ifpNGenerations': 'IFP generations',
    'kinetics.numPrecursorGroups': 'Precursor groups',
    'kinetics.computeBetaEff': 'Compute beta-effective'
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

/** Read a nested settings value by dotted path. */
function readSettingsPath(settings: OpenMCSettings, path: string): unknown {
    let current: unknown = settings;
    for (const part of path.split('.')) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

/** Write one dotted path into a settings record, creating nested objects as needed. */
function writeSettingsPath(target: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split('.');
    let current = target;
    for (const part of parts.slice(0, -1)) {
        const child = current[part];
        if (child === null || typeof child !== 'object' || Array.isArray(child)) {
            current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
}

/** Validate only the value rule for a supported path. */
function validateSettingsValue(path: OpenMCSettingsPath, value: unknown, settings: OpenMCSettings): string | undefined {
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
        case 'output.summary':
        case 'output.tallies':
        case 'kinetics.enabled':
        case 'kinetics.computeBetaEff':
            return typeof value === 'boolean' ? undefined : `${path} must be a boolean.`;
        case 'electronTreatment':
            return value === 'led' || value === 'ttb' ? undefined : `${path} must be 'led' or 'ttb'.`;
        case 'sourceRejectionFraction':
            return isFiniteNumber(value) && value >= 0 && value <= 1 ? undefined : `${path} must be a number from 0 to 1.`;
        case 'output.path':
            if (typeof value !== 'string' || value.trim().length === 0) {
                return `${path} must be a non-empty string.`;
            }
            if (/[\u0000-\u001f\u007f]/.test(value)) {
                return `${path} must not contain control characters.`;
            }
            if (value.length > MAX_OUTPUT_PATH_LENGTH) {
                return `${path} must be at most ${MAX_OUTPUT_PATH_LENGTH} characters.`;
            }
            return undefined;
        case 'cutoff.energyNeutron':
        case 'cutoff.energyPhoton':
        case 'cutoff.time':
        case 'cutoff.timePhoton':
        case 'cutoff.weight':
        case 'cutoff.weightAvg':
            return isFiniteNumber(value) && value > 0 ? undefined : `${path} must be a finite number greater than 0.`;
        case 'kinetics.ifpNGenerations':
            return isInteger(value) && value > 0 ? undefined : `${path} must be an integer greater than 0.`;
        case 'kinetics.numPrecursorGroups':
            return isInteger(value) && value >= 1 && value <= MAX_PRECURSOR_GROUPS
                ? undefined
                : `${path} must be an integer from 1 to ${MAX_PRECURSOR_GROUPS}.`;
    }
}

/** IFP scores the dashboard would have to generate because the project lacks them. */
function missingIfpScores(tallies: readonly OpenMCTally[], kinetics: OpenMCSettings['kinetics']): string[] {
    const generated = getAutoIfpTallies([...tallies], kinetics, 1);
    return [...new Set(generated.flatMap((tally) => tally.scores))];
}

/**
 * Cross-field checks over the settings that would result from a request.
 *
 * The IFP generation count must not exceed the inactive batches, and enabling
 * kinetics requires the IFP tallies the dashboard generates to already exist
 * in the project so a settings edit never adds tallies as a side effect.
 */
function validateSettingsCompatibility(
    settings: OpenMCSettings,
    touchedPaths: ReadonlySet<string>,
    context?: OpenMCSettingsValidationContext
): string | undefined {
    const kinetics = settings.kinetics;
    const touchesIfpLimit =
        touchedPaths.has('kinetics.ifpNGenerations') ||
        touchedPaths.has('run.inactive') ||
        (touchedPaths.has('kinetics.enabled') && kinetics?.enabled === true);
    if (touchesIfpLimit && kinetics?.ifpNGenerations !== undefined) {
        const inactive = runSettings(settings).inactive ?? 0;
        if (kinetics.ifpNGenerations > inactive) {
            return `kinetics.ifpNGenerations (${kinetics.ifpNGenerations}) must not exceed run.inactive (${inactive}).`;
        }
    }
    if (touchedPaths.has('kinetics.enabled') && kinetics?.enabled && (context?.requireKineticsTallies ?? true)) {
        const tallies = context?.tallies ?? [];
        const missing = missingIfpScores(tallies, kinetics);
        if (missing.length > 0) {
            return `kinetics.enabled requires the IFP tallies the dashboard generates (missing ${missing.join(
                ', '
            )}); add them in the Tallies tab before enabling kinetics.`;
        }
    }
    return undefined;
}

/**
 * Validate a proposed settings edit against the current settings.
 *
 * @param path - Dot-separated settings path.
 * @param value - Proposed value.
 * @param settings - Current settings, used for mode-dependent paths.
 * @param context - Current tallies for cross-field kinetics checks.
 * @returns An error message, or `undefined` when the edit is valid.
 */
export function validateSettingsChange(
    path: string,
    value: unknown,
    settings: OpenMCSettings,
    context?: OpenMCSettingsValidationContext
): string | undefined {
    if (!isSettingsPath(path)) {
        return `${path} is not a supported OpenMC settings path.`;
    }
    const error = validateSettingsValue(path, value, settings);
    if (error) {
        return error;
    }
    return validateSettingsCompatibility(applySettingsChanges(settings, [{ path, value }]), new Set([path]), context);
}

/**
 * Validate a group of proposed edits as one request.
 *
 * Every value is checked against the current settings, then the cross-field
 * rules run over the settings that would result from applying all edits, so a
 * request cannot satisfy each rule separately but violate them together.
 *
 * @param settings - Current settings.
 * @param changes - Path/value edits.
 * @param context - Current tallies for cross-field kinetics checks.
 * @returns An error message, or `undefined` when every edit is valid.
 */
export function validateSettingsChanges(
    settings: OpenMCSettings,
    changes: readonly OpenMCSettingsEdit[],
    context?: OpenMCSettingsValidationContext
): string | undefined {
    for (const change of changes) {
        if (!isSettingsPath(change.path)) {
            return `${change.path} is not a supported OpenMC settings path.`;
        }
        const error = validateSettingsValue(change.path, change.value, settings);
        if (error) {
            return error;
        }
    }
    return validateSettingsCompatibility(applySettingsChanges(settings, changes), new Set(changes.map((change) => change.path)), context);
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
    return readSettingsPath(settings, path);
}

/**
 * Deep-clone settings and apply the requested paths.
 *
 * Nested paths update only their leaf; every unrelated key in the same nested
 * object is preserved.
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
        writeSettingsPath(next as unknown as Record<string, unknown>, change.path, change.value);
    }
    return next;
}

/**
 * Build a minimal top-level settings update for a set of path edits.
 *
 * The state manager shallow-merges top-level keys, so every touched nested
 * object is included whole from the merged result, preserving its unrelated
 * fields.
 *
 * @param current - Current settings.
 * @param changes - Path/value edits.
 * @returns A partial settings object containing only the touched top-level keys.
 */
export function settingsUpdatePatch(current: OpenMCSettings, changes: readonly OpenMCSettingsEdit[]): Partial<OpenMCSettings> {
    const next = applySettingsChanges(current, changes);
    const patch: Record<string, unknown> = {};
    for (const change of changes) {
        const root = change.path.split('.')[0];
        patch[root] = (next as unknown as Record<string, unknown>)[root];
    }
    return patch as Partial<OpenMCSettings>;
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
 * @param context - Current tallies for cross-field kinetics checks.
 * @returns One labelled change per edit.
 * @throws Error when a path, value, or no-op edit is invalid.
 */
export function settingsChanges(
    settings: OpenMCSettings,
    changes: readonly OpenMCSettingsEdit[],
    context?: OpenMCSettingsValidationContext
): NukeChange[] {
    const error = validateSettingsChanges(settings, changes, context);
    if (error) {
        throw new Error(error);
    }
    return changes.map((change) => {
        const path = change.path as OpenMCSettingsPath;
        const before = settingsValue(settings, path);
        if (settingsEqual(before, change.value)) {
            throw new Error(`${SETTINGS_LABELS[path]} is already set to the requested value.`);
        }
        return {
            path: change.path,
            label: SETTINGS_LABELS[path],
            kind: 'update' as const,
            before,
            after: change.value
        };
    });
}
