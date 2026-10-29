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
 * Depletion configuration helpers shared by XML generation, XML import, the
 * runner, the validation service, and the depletion tab.
 *
 * Depletion is driven by the Python API, not by OpenMC's own settings.xml
 * parser. The `<depletion>` block below is a NukeIDE extension: the runner
 * consumes it and the standalone `openmc` binary ignores it. Fields that only
 * the driver understands (substeps, reactivity control, external source rates,
 * continuation) are serialized as JSON inside that block and flagged as
 * driver-only in XML export warnings.
 *
 * @module openmc-studio/common
 */

import {
    OpenMCDepletion,
    OpenMCExternalSourceComposition,
    OpenMCExternalSourceRate,
    OpenMCReactivityControl,
    OpenMCState
} from './openmc-state-schema';
import { resolveDepletionSolver } from './depletion-solvers';
import { OpenMCCompat, DEFAULT_OPENMC_COMPAT } from './openmc-studio-protocol';

/** Minimum accepted substep count. */
export const DEPLETION_MIN_SUBSTEPS = 1;

/** Allowed external source rate units (OpenMC `set_external_source_rate`). */
export const EXTERNAL_SOURCE_RATE_UNITS: OpenMCExternalSourceRate['units'][] = ['g/s', 'g/min', 'g/h', 'g/d', 'g/a'];

/** A depletion configuration issue surfaced by the backend and the tab. */
export interface DepletionSettingIssue {
    /** Stable field identifier (e.g. `reactivityControl.cellId`). */
    field: string;
    /** Severity; errors block a run. */
    severity: 'error' | 'warning';
    /** What is wrong. */
    message: string;
    /** How to fix it. */
    suggestion: string;
}

/** Parsed custom `<depletion>` block plus non-fatal parse warnings. */
export interface ParsedDepletionBlock {
    /** Parsed depletion configuration. */
    depletion: OpenMCDepletion;
    /** Non-fatal parse warnings (invalid JSON, unknown values, …). */
    warnings: string[];
}

/** External feed/removal totals grouped by unit. */
export interface ExternalSourceRateTotals {
    /** Number of configured rate rows. */
    count: number;
    /** Positive (feed) rates grouped by unit. */
    feed: Record<string, number>;
    /** Absolute values of negative (removal) rates grouped by unit. */
    removal: Record<string, number>;
}

/**
 * Extract the custom `<depletion>` block from a settings.xml document.
 * @param settingsXml - settings.xml contents.
 * @returns The block contents, or undefined when absent.
 */
export function extractDepletionBlock(settingsXml: string): string | undefined {
    return settingsXml.match(/<depletion>[\s\S]*?<\/depletion>/)?.[0];
}

/**
 * Parse the custom `<depletion>` block emitted by XML generation.
 *
 * The parser uses only string/regex handling so it can run in the runner,
 * the XML import service, and tests without an XML dependency.
 *
 * @param settingsXml - settings.xml contents.
 * @returns Parsed configuration and warnings, or undefined when the block is absent.
 */
export function parseDepletionBlock(settingsXml: string): ParsedDepletionBlock | undefined {
    const block = extractDepletionBlock(settingsXml);
    if (!block) {
        return undefined;
    }

    const warnings: string[] = [];
    const tag = (name: string): string | undefined => {
        const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
        return match ? match[1] : undefined;
    };
    const unescape = (text: string): string =>
        text
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
    const numberValue = (name: string): number | undefined => {
        const value = tag(name);
        if (value === undefined) {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    };
    const jsonValue = <T>(name: string): T | undefined => {
        const value = tag(name);
        if (value === undefined) {
            return undefined;
        }
        try {
            return JSON.parse(unescape(value)) as T;
        } catch {
            warnings.push(`Could not parse <${name}> JSON in the depletion block`);
            return undefined;
        }
    };

    const timeStepsText = tag('time_steps');
    const timeSteps = timeStepsText
        ? timeStepsText
              .trim()
              .split(/\s+/)
              .map(Number)
              .filter((n) => Number.isFinite(n))
        : [];

    const depletion: OpenMCDepletion = {
        enabled: true,
        timeSteps
    };

    const chainFile = tag('chain_file');
    if (chainFile) {
        depletion.chainFile = chainFile;
    }
    const power = numberValue('power');
    if (power !== undefined) {
        depletion.power = power;
    }
    const powerDensity = numberValue('power_density');
    if (powerDensity !== undefined) {
        depletion.powerDensity = powerDensity;
    }
    const operator = tag('operator');
    if (operator === 'coupled' || operator === 'independent' || operator === 'openmc') {
        depletion.operator = operator;
    }
    const solver = tag('solver');
    if (solver) {
        depletion.solver = resolveDepletionSolver(solver);
    }
    const normalization = tag('normalization');
    if (normalization === 'source-rate' || normalization === 'fission-q' || normalization === 'energy-deposition') {
        depletion.normalizationMode = normalization;
    }
    if (tag('diff_burnable_mats') === 'true') {
        depletion.diffBurnableMats = true;
    }
    const diffVolumeMethod = tag('diff_volume_method');
    if (diffVolumeMethod === 'divide equally' || diffVolumeMethod === 'match cell') {
        depletion.diffVolumeMethod = diffVolumeMethod;
    }
    const fluxFiles = tag('flux_files');
    if (fluxFiles) {
        depletion.fluxFiles = fluxFiles.split(',').filter((f) => f.length > 0);
    }
    const microxsFiles = tag('microxs_files');
    if (microxsFiles) {
        depletion.microxsFiles = microxsFiles.split(',').filter((f) => f.length > 0);
    }
    if (tag('generate_microxs') === 'true') {
        depletion.generateFromModel = true;
    }
    const transferRates = jsonValue<OpenMCDepletion['transferRates']>('transfer_rates');
    if (transferRates) {
        depletion.transferRates = transferRates;
    }
    const fissionQ = jsonValue<Record<string, number>>('fission_q');
    if (fissionQ) {
        depletion.fissionQ = fissionQ;
    }
    const substeps = numberValue('substeps');
    if (substeps !== undefined) {
        depletion.substeps = substeps;
    }
    const decayOnlySteps = tag('decay_only_steps');
    if (decayOnlySteps) {
        const indices = decayOnlySteps
            .split(',')
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isInteger(value) && value >= 0);
        if (indices.length > 0) {
            depletion.decayOnlySteps = indices;
        }
    }
    const reactivityControl = jsonValue<OpenMCReactivityControl>('reactivity_control');
    if (reactivityControl && typeof reactivityControl === 'object') {
        depletion.reactivityControl = reactivityControl;
    }
    const externalSourceRates = jsonValue<OpenMCExternalSourceRate[]>('external_source_rates');
    if (Array.isArray(externalSourceRates)) {
        depletion.externalSourceRates = externalSourceRates;
    }
    const continueFromResults = tag('continue_from_results');
    if (continueFromResults) {
        depletion.continueFromResults = continueFromResults;
    }
    if (tag('continue_timesteps') === 'true') {
        depletion.continueTimesteps = true;
    }

    return { depletion, warnings };
}

/**
 * Whether a depletion configuration carries settings that only the NukeIDE
 * driver applies (not OpenMC's own settings.xml parser).
 * @param depletion - Depletion configuration.
 * @returns True when a driver-only field is active.
 */
export function hasDriverOnlyDepletionSettings(depletion: OpenMCDepletion): boolean {
    if ((depletion.substeps ?? 1) > 1) {
        return true;
    }
    if (depletion.reactivityControl?.enabled !== false && depletion.reactivityControl) {
        return true;
    }
    if ((depletion.externalSourceRates?.length ?? 0) > 0) {
        return true;
    }
    if ((depletion.decayOnlySteps?.length ?? 0) > 0) {
        return true;
    }
    if (depletion.continueFromResults || depletion.continueTimesteps) {
        return true;
    }
    if ((depletion.transferRates?.length ?? 0) > 0) {
        return true;
    }
    if (depletion.diffBurnableMats || depletion.generateFromModel) {
        return true;
    }
    if ((depletion.fluxFiles?.length ?? 0) > 0 || (depletion.microxsFiles?.length ?? 0) > 0) {
        return true;
    }
    return false;
}

/**
 * Build the XML-export warning for driver-only depletion settings.
 * @param depletion - Depletion configuration.
 * @returns Warning lines (empty when only simple fields are used).
 */
export function getDepletionXmlWarnings(depletion: OpenMCDepletion): string[] {
    if (!depletion.enabled) {
        return [];
    }
    const advanced = hasDriverOnlyDepletionSettings(depletion)
        ? ' Advanced controls (substeps, reactivity control, external feed/removal, continuation, ' +
          'transfer rates, or operator inputs) are driver-only as well.'
        : '';
    return [
        'Depletion is configured in a custom <depletion> block that only the NukeIDE depletion driver reads; ' +
            'the standalone `openmc` binary ignores it. Run depletion from OpenMC Studio.' +
            advanced
    ];
}

/**
 * Whether a reactivity control is configured and enabled.
 * @param control - Reactivity control settings.
 * @returns True when the search should run.
 */
export function isReactivityControlEnabled(control: OpenMCReactivityControl | undefined): boolean {
    return !!control && control.enabled !== false;
}

/**
 * Total configured substeps (defaults to 1).
 * @param depletion - Depletion configuration.
 * @returns Substep count.
 */
export function getDepletionSubsteps(depletion: OpenMCDepletion): number {
    return depletion.substeps ?? 1;
}

/**
 * Summarize external feed/removal rows for the table footer.
 * @param rates - Configured external source rates.
 * @returns Row count and per-unit feed/removal totals.
 */
export function summarizeExternalSourceRates(rates: OpenMCExternalSourceRate[] | undefined): ExternalSourceRateTotals {
    const totals: ExternalSourceRateTotals = { count: 0, feed: {}, removal: {} };
    for (const rate of rates ?? []) {
        totals.count += 1;
        const units = rate.units ?? 'g/s';
        if (rate.rate > 0) {
            totals.feed[units] = (totals.feed[units] ?? 0) + rate.rate;
        } else if (rate.rate < 0) {
            totals.removal[units] = (totals.removal[units] ?? 0) + Math.abs(rate.rate);
        }
    }
    return totals;
}

/**
 * Format one composition vector as `U235 100%, O16 5%`.
 * @param composition - Composition entries.
 * @returns Human-readable composition.
 */
export function formatComposition(composition: OpenMCExternalSourceComposition[] | undefined): string {
    if (!composition || composition.length === 0) {
        return 'No composition';
    }
    return composition.map((entry) => `${entry.name || '?'} ${entry.weightPercent}%`).join(', ');
}

/**
 * Summarize external source rates (feeds/removals) for run summaries.
 * @param rates - Configured external source rates.
 * @returns One-line description, or an empty string when none are configured.
 */
export function summarizeExternalSourceRatesText(rates: OpenMCExternalSourceRate[] | undefined): string {
    const totals = summarizeExternalSourceRates(rates);
    if (totals.count === 0) {
        return '';
    }
    const parts: string[] = [];
    for (const [units, value] of Object.entries(totals.feed)) {
        parts.push(`feed ${value.toLocaleString()} ${units}`);
    }
    for (const [units, value] of Object.entries(totals.removal)) {
        parts.push(`removal ${value.toLocaleString()} ${units}`);
    }
    return `${totals.count} rate${totals.count === 1 ? '' : 's'} (${parts.join(', ')})`;
}

/**
 * Summarize a reactivity control for the run summary and tab header.
 * @param control - Reactivity control settings.
 * @returns Human-readable summary.
 */
export function summarizeReactivityControl(control: OpenMCReactivityControl | undefined): string {
    if (!isReactivityControlEnabled(control)) {
        return '';
    }
    if (control!.parameter === 'cell-translation') {
        return `Cell #${control!.cellId ?? '?'} ${control!.axis ?? '?'}-translation`;
    }
    return `Material #${control!.materialId ?? '?'} ${control!.nuclide ?? '?'} density`;
}

/**
 * Summarize continuation settings for the run summary.
 * @param depletion - Depletion configuration.
 * @returns Human-readable summary, or an empty string when not continuing.
 */
export function summarizeContinuation(depletion: OpenMCDepletion): string {
    if (!depletion.continueFromResults) {
        return '';
    }
    const file = depletion.continueFromResults.split(/[\\/]/).pop() ?? depletion.continueFromResults;
    return depletion.continueTimesteps ? `Continue timesteps from ${file}` : `Append steps to ${file}`;
}

/**
 * Capability warnings for depletion fields not supported by the detected
 * OpenMC environment. Never parses version strings — uses the probed compat.
 * @param depletion - Depletion configuration.
 * @param compat - Probed compatibility descriptor.
 * @returns Issues to show at the point of configuration.
 */
export function getDepletionCapabilityIssues(
    depletion: OpenMCDepletion,
    compat: OpenMCCompat = DEFAULT_OPENMC_COMPAT
): DepletionSettingIssue[] {
    const issues: DepletionSettingIssue[] = [];
    if ((depletion.substeps ?? 1) > 1 && !compat.depletionSubsteps) {
        issues.push({
            field: 'substeps',
            severity: 'warning',
            message: 'Substeps require OpenMC 0.16 or newer in the selected environment',
            suggestion: 'Set substeps to 1 or switch to an OpenMC 0.16+ environment.'
        });
    }
    if (isReactivityControlEnabled(depletion.reactivityControl) && !compat.depletionKeffSearch) {
        issues.push({
            field: 'reactivityControl',
            severity: 'warning',
            message: 'Reactivity control requires OpenMC 0.16 or newer in the selected environment',
            suggestion: 'Disable reactivity control or switch to an OpenMC 0.16+ environment.'
        });
    }
    if ((depletion.externalSourceRates?.length ?? 0) > 0 && !compat.depletionExternalSourceRate) {
        issues.push({
            field: 'externalSourceRates',
            severity: 'warning',
            message: 'External source rates require OpenMC 0.15.3 or newer in the selected environment',
            suggestion: 'Remove the external rates or switch environments.'
        });
    }
    if ((depletion.continueFromResults || depletion.continueTimesteps) && !compat.depletionContinuation) {
        issues.push({
            field: 'continuation',
            severity: 'warning',
            message: 'Continuation requires OpenMC 0.15.1 or newer in the selected environment',
            suggestion: 'Clear the continuation settings or switch environments.'
        });
    }
    return issues;
}

/**
 * Validate the advanced depletion fields against the current model state.
 *
 * Used by the backend validation service (errors block a run) and by the
 * depletion tab for inline messages. File existence for continuation is
 * checked by the backend, where filesystem access is available.
 *
 * @param state - Current OpenMC simulation state.
 * @returns Validation issues for the advanced fields.
 */
export function validateDepletionAdvanced(state: OpenMCState): DepletionSettingIssue[] {
    const depletion = state.depletion;
    if (!depletion?.enabled) {
        return [];
    }

    const issues: DepletionSettingIssue[] = [];
    const cells = new Set(state.geometry.cells.map((cell) => cell.id));
    const materials = new Map(state.materials.map((material) => [material.id, material]));

    if (depletion.substeps !== undefined) {
        if (!Number.isInteger(depletion.substeps) || depletion.substeps < DEPLETION_MIN_SUBSTEPS) {
            issues.push({
                field: 'substeps',
                severity: 'error',
                message: `Substeps must be a whole number of at least ${DEPLETION_MIN_SUBSTEPS}`,
                suggestion: 'Enter 1 for no subdivision, or 2–10 to improve accuracy for short-lived nuclides.'
            });
        }
    }

    if (depletion.decayOnlySteps && depletion.decayOnlySteps.length > 0) {
        const stepCount = depletion.timeSteps?.length ?? 0;
        if (depletion.decayOnlySteps.some((step) => !Number.isInteger(step) || step < 0 || step >= stepCount)) {
            issues.push({
                field: 'decayOnlySteps',
                severity: 'error',
                message: 'Decay-only steps must be zero-based indices inside the timeline',
                suggestion: `Use indices 0–${Math.max(stepCount - 1, 0)} or clear the decay-only marks.`
            });
        }
    }

    const control = depletion.reactivityControl;
    if (isReactivityControlEnabled(control)) {
        const rc = control!;
        if (rc.parameter !== 'cell-translation' && rc.parameter !== 'nuclide-density') {
            issues.push({
                field: 'reactivityControl.parameter',
                severity: 'error',
                message: 'Choose a reactivity-control parameter type',
                suggestion: 'Select control-rod position or nuclide density.'
            });
        }

        if (rc.parameter === 'cell-translation') {
            if (!Number.isInteger(rc.cellId) || (rc.cellId ?? 0) <= 0) {
                issues.push({
                    field: 'reactivityControl.cellId',
                    severity: 'error',
                    message: 'Control-rod position needs a positive cell ID',
                    suggestion: 'Pick the cell that moves with the control rod.'
                });
            } else if (!cells.has(rc.cellId!)) {
                if (state.settings.dagmcFile) {
                    issues.push({
                        field: 'reactivityControl.cellId',
                        severity: 'warning',
                        message: `Cell #${rc.cellId} is not a CSG cell in this project`,
                        suggestion: 'For DAGMC models, use a DAGMC volume ID; it cannot be checked until the run starts.'
                    });
                } else {
                    issues.push({
                        field: 'reactivityControl.cellId',
                        severity: 'error',
                        message: `Cell #${rc.cellId} does not exist in the geometry`,
                        suggestion: 'Pick an existing cell in the CSG Builder.'
                    });
                }
            }
            if (rc.axis !== 'x' && rc.axis !== 'y' && rc.axis !== 'z') {
                issues.push({
                    field: 'reactivityControl.axis',
                    severity: 'error',
                    message: 'Control-rod position needs a translation axis',
                    suggestion: 'Select x, y, or z.'
                });
            }
        }

        if (rc.parameter === 'nuclide-density') {
            const material = rc.materialId !== undefined ? materials.get(rc.materialId) : undefined;
            if (!Number.isInteger(rc.materialId) || (rc.materialId ?? 0) <= 0) {
                issues.push({
                    field: 'reactivityControl.materialId',
                    severity: 'error',
                    message: 'Nuclide-density control needs a positive material ID',
                    suggestion: 'Pick the material whose nuclide density the search adjusts.'
                });
            } else if (!material) {
                issues.push({
                    field: 'reactivityControl.materialId',
                    severity: 'error',
                    message: `Material #${rc.materialId} does not exist`,
                    suggestion: 'Pick a material from the Materials tab.'
                });
            } else if (material.macroscopic) {
                issues.push({
                    field: 'reactivityControl.materialId',
                    severity: 'error',
                    message: `Material "${material.name}" is macroscopic and has no nuclide densities`,
                    suggestion: 'Pick a nuclide-decomposed material.'
                });
            } else if (!rc.nuclide || rc.nuclide.trim().length === 0) {
                issues.push({
                    field: 'reactivityControl.nuclide',
                    severity: 'error',
                    message: 'Nuclide-density control needs a nuclide',
                    suggestion: 'Enter a specific nuclide such as U235.'
                });
            } else if (material.nuclides.length > 0 && !material.nuclides.some((nuclide) => nuclide.name === rc.nuclide)) {
                issues.push({
                    field: 'reactivityControl.nuclide',
                    severity: 'error',
                    message: `Nuclide "${rc.nuclide}" is not in material "${material.name}"`,
                    suggestion: 'Use a nuclide present in the material (elements expand to isotopes, so enter a specific isotope).'
                });
            }
        }

        if (!Number.isFinite(rc.x0) || !Number.isFinite(rc.x1)) {
            issues.push({
                field: 'reactivityControl.x0',
                severity: 'error',
                message: 'Search guesses must be finite numbers',
                suggestion: 'Enter two distinct starting values for the searched parameter.'
            });
        } else if (rc.x0 === rc.x1) {
            issues.push({
                field: 'reactivityControl.x1',
                severity: 'error',
                message: 'Search guesses must differ',
                suggestion: 'Enter two distinct starting values for the searched parameter.'
            });
        }
        if (!Array.isArray(rc.bracket) || rc.bracket.length !== 2 || !rc.bracket.every(Number.isFinite)) {
            issues.push({
                field: 'reactivityControl.bracket',
                severity: 'error',
                message: 'Search bracket needs two finite bounds',
                suggestion: 'Enter a lower and an upper bound.'
            });
        } else if (rc.bracket[0] >= rc.bracket[1]) {
            issues.push({
                field: 'reactivityControl.bracket',
                severity: 'error',
                message: 'Search bracket must increase (lower bound < upper bound)',
                suggestion: 'Swap the bounds so the lower value comes first.'
            });
        } else {
            for (const [name, value] of [
                ['x0', rc.x0],
                ['x1', rc.x1]
            ] as const) {
                if (Number.isFinite(value) && (value < rc.bracket[0] || value > rc.bracket[1])) {
                    issues.push({
                        field: `reactivityControl.${name}`,
                        severity: 'error',
                        message: `Search guess ${name} lies outside the bracket`,
                        suggestion: 'Keep both guesses inside the lower/upper bracket.'
                    });
                }
            }
        }
        if (rc.targetKeff !== undefined && (!Number.isFinite(rc.targetKeff) || rc.targetKeff <= 0)) {
            issues.push({
                field: 'reactivityControl.targetKeff',
                severity: 'error',
                message: 'Target k-effective must be a positive number',
                suggestion: 'Use 1.0 for critical, or the desired target value.'
            });
        }
        if (rc.kTol !== undefined && (!Number.isFinite(rc.kTol) || rc.kTol <= 0)) {
            issues.push({
                field: 'reactivityControl.kTol',
                severity: 'error',
                message: 'k-effective tolerance must be positive',
                suggestion: 'Use a small positive value such as 1e-4.'
            });
        }
        if (rc.sigmaFinal !== undefined && (!Number.isFinite(rc.sigmaFinal) || rc.sigmaFinal <= 0)) {
            issues.push({
                field: 'reactivityControl.sigmaFinal',
                severity: 'error',
                message: 'Final k-effective uncertainty must be positive',
                suggestion: 'Use a small positive value such as 3e-4.'
            });
        }
        if (rc.maxIterations !== undefined && (!Number.isInteger(rc.maxIterations) || rc.maxIterations < 1)) {
            issues.push({
                field: 'reactivityControl.maxIterations',
                severity: 'error',
                message: 'Maximum iterations must be a whole number of at least 1',
                suggestion: 'Use 50 for the OpenMC default, or a larger value.'
            });
        }
        if (rc.onFailure !== undefined && rc.onFailure !== 'fail' && rc.onFailure !== 'warn') {
            issues.push({
                field: 'reactivityControl.onFailure',
                severity: 'error',
                message: 'Choose what happens when the search does not converge',
                suggestion: 'Select fail or warn.'
            });
        }
    }

    (depletion.externalSourceRates ?? []).forEach((rate, index) => {
        const field = `externalSourceRates.${index}`;
        const material = materials.get(rate.material);
        if (material === undefined) {
            issues.push({
                field: `${field}.material`,
                severity: 'error',
                message: `External rate ${index + 1} references missing material #${rate.material}`,
                suggestion: 'Pick a depletable material.'
            });
        } else if (!material.isDepletable) {
            issues.push({
                field: `${field}.material`,
                severity: 'error',
                message: `External rate ${index + 1} targets material "${material.name}", which is not depletable`,
                suggestion: 'Mark the material as depletable or pick a depletable material.'
            });
        }
        if (!Number.isFinite(rate.rate) || rate.rate === 0) {
            issues.push({
                field: `${field}.rate`,
                severity: 'error',
                message: `External rate ${index + 1} needs a non-zero rate`,
                suggestion: 'Use a positive value to feed and a negative value to remove material.'
            });
        }
        if (rate.units !== undefined && !EXTERNAL_SOURCE_RATE_UNITS.includes(rate.units)) {
            issues.push({
                field: `${field}.units`,
                severity: 'error',
                message: `External rate ${index + 1} has an unsupported unit`,
                suggestion: `Choose one of ${EXTERNAL_SOURCE_RATE_UNITS.join(', ')}.`
            });
        }
        if (!rate.composition || rate.composition.length === 0) {
            issues.push({
                field: `${field}.composition`,
                severity: 'error',
                message: `External rate ${index + 1} needs a composition`,
                suggestion: 'Add at least one element or nuclide with a weight percent.'
            });
        } else {
            const seen = new Set<string>();
            let total = 0;
            rate.composition.forEach((entry, entryIndex) => {
                if (!entry.name || entry.name.trim().length === 0) {
                    issues.push({
                        field: `${field}.composition.${entryIndex}.name`,
                        severity: 'error',
                        message: `External rate ${index + 1} has a blank composition entry`,
                        suggestion: 'Enter an element or nuclide name such as U235.'
                    });
                } else if (seen.has(entry.name)) {
                    issues.push({
                        field: `${field}.composition.${entryIndex}.name`,
                        severity: 'error',
                        message: `External rate ${index + 1} repeats "${entry.name}"`,
                        suggestion: 'Combine duplicate entries into one weight percent.'
                    });
                }
                seen.add(entry.name);
                if (!Number.isFinite(entry.weightPercent) || entry.weightPercent <= 0) {
                    issues.push({
                        field: `${field}.composition.${entryIndex}.weightPercent`,
                        severity: 'error',
                        message: `External rate ${index + 1} needs positive weight percents`,
                        suggestion: 'Use a value greater than 0; OpenMC normalizes the composition.'
                    });
                } else {
                    total += entry.weightPercent;
                }
            });
            if (total > 0 && Math.abs(total - 100) > 0.01) {
                issues.push({
                    field: `${field}.composition`,
                    severity: 'warning',
                    message: `External rate ${index + 1} totals ${total}%`,
                    suggestion: 'OpenMC normalizes the composition; use 100% if you expect exact percentages.'
                });
            }
        }
        if (rate.timesteps !== undefined) {
            if (rate.timesteps.some((step) => !Number.isInteger(step) || step < 0)) {
                issues.push({
                    field: `${field}.timesteps`,
                    severity: 'error',
                    message: `External rate ${index + 1} has invalid timestep indices`,
                    suggestion: 'Use zero-based whole numbers such as 0, 2.'
                });
            }
            if (new Set(rate.timesteps).size !== rate.timesteps.length) {
                issues.push({
                    field: `${field}.timesteps`,
                    severity: 'error',
                    message: `External rate ${index + 1} repeats a timestep index`,
                    suggestion: 'List each timestep index once.'
                });
            }
        }
    });

    if (depletion.continueTimesteps && !depletion.continueFromResults) {
        issues.push({
            field: 'continuation',
            severity: 'error',
            message: 'Continue timesteps needs a previous depletion results file',
            suggestion: 'Select the previous depletion_results.h5, or disable continuation.'
        });
    }
    if (depletion.continueFromResults !== undefined && depletion.continueFromResults.trim().length === 0) {
        issues.push({
            field: 'continuation',
            severity: 'error',
            message: 'The previous depletion results path is empty',
            suggestion: 'Select the previous depletion_results.h5 file.'
        });
    }

    return issues;
}
