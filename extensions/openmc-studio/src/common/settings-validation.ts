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
 * Runtime and advanced-settings validation shared by the Settings UI and the
 * run-readiness check. Every OpenMC bound here mirrors openmc/settings.py
 * setters so the UI cannot configure a value the binary rejects.
 *
 * @module openmc-studio/common
 */

import type { OpenMCSettings } from './openmc-state-schema';
import type { OpenMCCompat } from './openmc-studio-protocol';

/** Collapsible Advanced group owning a setting. */
export type AdvancedSettingsGroup = 'execution' | 'convergence' | 'physics' | 'limits' | 'diagnostics';

/** A single settings validation finding. */
export interface SettingsValidationIssue {
    /** Advanced group for inline display. */
    group: AdvancedSettingsGroup;
    /** Error blocks the run; warning is advisory. */
    severity: 'error' | 'warning';
    /** What is wrong and why. */
    message: string;
    /** How to fix it. */
    suggestion: string;
}

/**
 * Whether a value is an integer >= 1.
 * @param value - Candidate number.
 * @returns True for positive integers.
 */
function isPositiveInteger(value: number | undefined): boolean {
    return value !== undefined && Number.isInteger(value) && value >= 1;
}

/**
 * Validate runtime, convergence, physics, limit, and diagnostic settings.
 * @param settings - Current simulation settings.
 * @param compat - Probed OpenMC capabilities (undefined skips version gating).
 * @returns Findings in group order.
 */
export function validateRuntimeSettings(settings: OpenMCSettings, compat?: OpenMCCompat): SettingsValidationIssue[] {
    const issues: SettingsValidationIssue[] = [];
    const error = (group: AdvancedSettingsGroup, message: string, suggestion: string): void => {
        issues.push({ group, severity: 'error', message, suggestion });
    };
    const warning = (group: AdvancedSettingsGroup, message: string, suggestion: string): void => {
        issues.push({ group, severity: 'warning', message, suggestion });
    };

    // Execution
    if (settings.threads !== undefined && !isPositiveInteger(settings.threads)) {
        error(
            'execution',
            'OpenMP threads must be a whole number of at least 1',
            'Set threads to 1 or more, or leave it empty for OpenMC default'
        );
    }
    if (settings.mpi?.enabled) {
        if (!isPositiveInteger(settings.mpi.processes)) {
            error('execution', 'MPI is enabled but the process count is missing or below 1', 'Set the MPI process count to 1 or more');
        } else if (settings.mpi.processes === 1) {
            warning(
                'execution',
                'MPI process count is 1, so the runner launches OpenMC serially',
                'Set 2 or more ranks to use MPI, or turn MPI off'
            );
        }
        const hosts = settings.mpi.hosts ?? [];
        if (hosts.some((host) => host.trim().length === 0)) {
            error('execution', 'MPI host list contains an empty entry', 'Remove the empty host or enter a hostname such as node1');
        }
    } else if ((settings.mpi?.hosts ?? []).some((host) => host.trim().length > 0)) {
        warning('execution', 'MPI hosts are configured while MPI is disabled', 'Enable MPI to use the host list, or clear it');
    }
    if (settings.trace !== undefined) {
        const valid = settings.trace.length === 3 && settings.trace.every((value) => isPositiveInteger(value));
        if (!valid) {
            error(
                'execution',
                'Trace needs three positive integers: batch, generation, and particle',
                'Enter the particle coordinates as batch generation particle (all >= 1)'
            );
        }
        if (settings.run.mode !== 'eigenvalue') {
            warning(
                'execution',
                'Tracing a particle is normally used with eigenvalue runs',
                'Use trace for lost-particle debugging in an eigenvalue model'
            );
        }
    }

    // Convergence
    if (settings.keffTrigger !== undefined) {
        if (settings.keffTrigger.threshold <= 0) {
            error(
                'convergence',
                'k-eff trigger threshold must be greater than 0',
                'Set a positive threshold, for example 0.001 for 1E-3 relative error'
            );
        }
        if (!['variance', 'std_dev', 'rel_err'].includes(settings.keffTrigger.type)) {
            error(
                'convergence',
                'k-eff trigger type must be variance, std_dev, or rel_err',
                'Choose one of the three OpenMC trigger metrics'
            );
        }
        if (settings.run.mode !== 'eigenvalue') {
            warning(
                'convergence',
                'OpenMC ignores the k-eff trigger outside eigenvalue mode',
                'Switch to eigenvalue mode or remove the trigger'
            );
        }
    }

    // Physics
    if (settings.temperature) {
        const temperature = settings.temperature;
        if (temperature.default !== undefined && !(temperature.default > 0)) {
            error('physics', 'Default temperature must be greater than 0 K', 'Set a positive temperature in Kelvin');
        }
        if (temperature.tolerance !== undefined && !(temperature.tolerance >= 0)) {
            error('physics', 'Temperature tolerance cannot be negative', 'Use 0 or a positive tolerance in Kelvin');
        }
        if (temperature.method !== undefined && temperature.method !== 'nearest' && temperature.method !== 'interpolation') {
            error('physics', 'Temperature method must be nearest or interpolation', 'Choose one of the two OpenMC temperature methods');
        }
        if (temperature.multipole && settings.photonTransport) {
            error(
                'physics',
                'Windowed multipole cannot be combined with photon transport',
                'Turn off multipole or disable photon transport (OpenMC aborts on this combination)'
            );
        }
    }
    if (settings.resonanceScattering) {
        const resonance = settings.resonanceScattering;
        if (resonance.energyMin !== undefined && !(resonance.energyMin >= 0)) {
            error('physics', 'Resonance-scattering minimum energy cannot be negative', 'Set energy_min to 0 or a positive energy in eV');
        }
        if (resonance.energyMax !== undefined && !(resonance.energyMax > 0)) {
            error('physics', 'Resonance-scattering maximum energy must be positive', 'Set energy_max above 0 eV');
        }
        if (resonance.method !== undefined && resonance.method !== 'rvs' && resonance.method !== 'dbrc') {
            error(
                'physics',
                'Resonance-scattering method must be rvs or dbrc',
                'OpenMC accepts only relative-velocity sampling or Doppler-broadening rejection'
            );
        }
        if (resonance.energyMin !== undefined && resonance.energyMax !== undefined && resonance.energyMax <= resonance.energyMin) {
            error('physics', 'Resonance-scattering maximum energy must exceed the minimum', 'Raise energy_max or lower energy_min');
        }
        if (settings.energyMode === 'multigroup') {
            warning(
                'physics',
                'OpenMC ignores resonance scattering in multi-group mode',
                'Remove the resonance-scattering settings or switch to continuous energy'
            );
        }
    }
    if (settings.freeGasThreshold !== undefined && !(settings.freeGasThreshold > 0)) {
        error('physics', 'Free-gas threshold must be greater than 0', 'Set the threshold in units of kT (OpenMC default is 400)');
    }
    if (settings.cutoff) {
        const cutoff = settings.cutoff;
        for (const [label, value] of [
            ['Neutron energy cutoff', cutoff.energyNeutron],
            ['Photon energy cutoff', cutoff.energyPhoton],
            ['Neutron time cutoff', cutoff.time],
            ['Photon time cutoff', cutoff.timePhoton],
            ['Weight cutoff', cutoff.weight],
            ['Average survival weight', cutoff.weightAvg]
        ] as const) {
            if (value !== undefined && !(value > 0)) {
                error(
                    'physics',
                    `${label} must be greater than 0`,
                    'Set a positive cutoff value, or leave the field empty to use the OpenMC default'
                );
            }
        }
    }
    if (settings.surfaceGrazingCutoff !== undefined && !(settings.surfaceGrazingCutoff > 0 && settings.surfaceGrazingCutoff < 1)) {
        error('physics', 'Surface grazing cutoff must be between 0 and 1 (exclusive)', 'Use a cosine cutoff such as 0.001');
    }
    if (settings.surfaceGrazingRatio !== undefined && !(settings.surfaceGrazingRatio > 0)) {
        error('physics', 'Surface grazing ratio must be greater than 0', 'Use a positive substitution ratio such as 0.5');
    }
    if (compat && settings.sharedSecondaryBank !== undefined && !compat.sharedSecondaryBank) {
        warning(
            'physics',
            'Shared secondary bank requires OpenMC 0.16.0+ and is omitted with this environment',
            'Upgrade OpenMC or clear the setting'
        );
    }
    if (compat && (settings.surfaceGrazingCutoff !== undefined || settings.surfaceGrazingRatio !== undefined) && !compat.surfaceGrazing) {
        warning(
            'physics',
            'Surface grazing cutoffs require OpenMC 0.16.0+ and are omitted with this environment',
            'Upgrade OpenMC or clear the settings'
        );
    }

    // Limits
    for (const [label, value] of [
        ['Maximum particle events', settings.maxParticleEvents],
        ['Maximum particles in flight', settings.maxParticlesInFlight],
        ['Maximum secondaries', settings.maxSecondaries],
        ['Maximum history splits', settings.maxHistorySplits],
        ['Maximum lost-particle files', settings.maxWriteLostParticles],
        ['Maximum lost particles', settings.maxLostParticles]
    ] as const) {
        if (value !== undefined && !isPositiveInteger(value)) {
            error(
                'limits',
                `${label} must be a whole number of at least 1`,
                'Enter a positive integer, or leave the field empty for the OpenMC default'
            );
        }
    }
    if (settings.relLostParticleRate !== undefined && !(settings.relLostParticleRate >= 0)) {
        error('limits', 'Relative lost-particle rate cannot be negative', 'Use 0 or a positive fraction');
    }
    if (settings.maxParticlesInFlight !== undefined && !settings.eventBased) {
        warning(
            'limits',
            'Maximum particles in flight only applies to event-based parallelism',
            'Enable event-based parallelism or clear the limit'
        );
    }

    // Diagnostics
    if (settings.verbosity !== undefined && (!isPositiveInteger(settings.verbosity) || settings.verbosity < 1 || settings.verbosity > 10)) {
        error(
            'diagnostics',
            'Verbosity must be an integer from 1 to 10',
            'Choose a verbosity level between 1 (quiet) and 10 (event diagnostics)'
        );
    }
    if (settings.stride !== undefined && !isPositiveInteger(settings.stride)) {
        error(
            'diagnostics',
            'Random-number stride must be a whole number of at least 1',
            'Enter a positive stride, or clear it for the OpenMC default'
        );
    }
    if (settings.plotSeed !== undefined && !isPositiveInteger(settings.plotSeed)) {
        error(
            'diagnostics',
            'Plot seed must be a whole number of at least 1',
            'Enter a positive integer, or clear it for the OpenMC default'
        );
    }
    if (settings.propertiesFile !== undefined && settings.propertiesFile.trim().length === 0) {
        error('diagnostics', 'Properties file path is empty', 'Choose a properties HDF5 file or clear the field');
    }
    if (settings.generationsPerBatch !== undefined && !isPositiveInteger(settings.generationsPerBatch)) {
        error('diagnostics', 'Generations per batch must be a whole number of at least 1', 'Enter 1 or more generations per batch');
    }
    if (settings.logGridBins !== undefined && !isPositiveInteger(settings.logGridBins)) {
        error('diagnostics', 'Log grid bins must be a whole number of at least 1', 'Enter a positive bin count');
    }
    if (settings.maxOrder !== undefined && (!Number.isInteger(settings.maxOrder) || settings.maxOrder < 0)) {
        error('diagnostics', 'Maximum scattering order cannot be negative', 'Enter 0 or a positive scattering order');
    }

    return issues;
}
