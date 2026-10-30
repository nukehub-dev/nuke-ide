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
 * Pure Python-generation helpers for runtime and advanced OpenMC settings.
 * Kept free of Theia/browser imports so the exported attribute names can be
 * snapshot-tested in the node vitest environment.
 *
 * @module openmc-studio/common
 */

import type { OpenMCMaterial, OpenMCSettings } from './openmc-state-schema';
import type { OpenMCCompat } from './openmc-studio-protocol';

/**
 * Python boolean literal.
 * @param value - Boolean value.
 * @returns `True` or `False`.
 */
function bool(value: boolean): string {
    return value ? 'True' : 'False';
}

/**
 * Generate Python assignments for temperature and cutoff settings.
 * @param settings - Simulation settings.
 * @returns Python statement lines.
 */
export function generateTemperatureCutoffPython(settings: OpenMCSettings): string[] {
    const lines: string[] = [];
    if (settings.temperature) {
        if (settings.temperature.default !== undefined) {
            lines.push(`settings.temperature['default'] = ${settings.temperature.default}`);
        }
        if (settings.temperature.method) {
            lines.push(`settings.temperature['method'] = ${JSON.stringify(settings.temperature.method)}`);
        }
        if (settings.temperature.tolerance !== undefined) {
            lines.push(`settings.temperature['tolerance'] = ${settings.temperature.tolerance}`);
        }
        if (settings.temperature.multipole !== undefined) {
            lines.push(`settings.temperature['multipole'] = ${bool(settings.temperature.multipole)}`);
        }
    }
    if (settings.cutoff) {
        const cutoffKeys: [keyof NonNullable<OpenMCSettings['cutoff']>, string][] = [
            ['weight', 'weight'],
            ['weightAvg', 'weight_avg'],
            ['energyNeutron', 'energy_neutron'],
            ['energyPhoton', 'energy_photon'],
            ['time', 'time_neutron'],
            ['timePhoton', 'time_photon']
        ];
        for (const [key, attribute] of cutoffKeys) {
            const value = settings.cutoff[key];
            if (value !== undefined) {
                lines.push(`settings.cutoff['${attribute}'] = ${value}`);
            }
        }
    }
    return lines;
}

/**
 * Generate Python assignments for convergence, physics, limit, and diagnostic
 * settings. Runtime launch controls (threads, MPI) are intentionally absent —
 * they are applied by the runner, not by `openmc.Settings`.
 * @param settings - Simulation settings.
 * @param compat - Probed capabilities; 0.16-only fields are omitted with a
 *   comment when the environment lacks them (undefined = emit as configured).
 * @returns Python statement lines.
 */
export function generateRuntimeSettingsPython(settings: OpenMCSettings, compat?: OpenMCCompat): string[] {
    const lines: string[] = [];
    const addBoolean = (attribute: string, value: boolean | undefined): void => {
        if (value !== undefined) {
            lines.push(`settings.${attribute} = ${bool(value)}`);
        }
    };
    const addNumber = (attribute: string, value: number | undefined): void => {
        if (value !== undefined) {
            lines.push(`settings.${attribute} = ${value}`);
        }
    };

    if (settings.trace !== undefined) {
        lines.push(`settings.trace = (${settings.trace.join(', ')})`);
    }
    if (settings.keffTrigger !== undefined) {
        lines.push(
            `settings.keff_trigger = {'type': ${JSON.stringify(settings.keffTrigger.type)}, 'threshold': ${settings.keffTrigger.threshold}}`
        );
    }
    addBoolean('confidence_intervals', settings.confidenceIntervals);
    addNumber('free_gas_threshold', settings.freeGasThreshold);
    if (settings.sharedSecondaryBank !== undefined) {
        if (compat?.sharedSecondaryBank === false) {
            lines.push('# shared_secondary_bank requires OpenMC 0.16.0+; omitted with this environment');
        } else {
            addBoolean('shared_secondary_bank', settings.sharedSecondaryBank);
        }
    }
    if (settings.surfaceGrazingCutoff !== undefined || settings.surfaceGrazingRatio !== undefined) {
        if (compat?.surfaceGrazing === false) {
            lines.push('# Surface grazing cutoffs require OpenMC 0.16.0+; omitted with this environment');
        } else {
            addNumber('surface_grazing_cutoff', settings.surfaceGrazingCutoff);
            addNumber('surface_grazing_ratio', settings.surfaceGrazingRatio);
        }
    }
    addNumber('max_particle_events', settings.maxParticleEvents);
    addNumber('max_particles_in_flight', settings.maxParticlesInFlight);
    addNumber('max_secondaries', settings.maxSecondaries);
    addNumber('max_history_splits', settings.maxHistorySplits);
    if (settings.maxWriteLostParticles !== undefined) {
        if (settings.maxWriteLostParticles > 0) {
            addNumber('max_write_lost_particles', settings.maxWriteLostParticles);
        } else {
            lines.push('# max_write_lost_particles=0 disables restart files but has no Python Settings equivalent; omitted');
        }
    }
    addBoolean('no_reduce', settings.noReduce);
    addNumber('stride', settings.stride);
    addNumber('plot_seed', settings.plotSeed);
    if (settings.propertiesFile) {
        lines.push(`settings.properties_file = ${JSON.stringify(settings.propertiesFile)}`);
    }
    addNumber('verbosity', settings.verbosity);
    addBoolean('material_cell_offsets', settings.materialCellOffsets);

    if (settings.resonanceScattering) {
        const resonance = settings.resonanceScattering;
        const entries: string[] = [];
        if (resonance.enable !== undefined) {
            entries.push(`'enable': ${bool(resonance.enable)}`);
        }
        if (resonance.method) {
            entries.push(`'method': ${JSON.stringify(resonance.method)}`);
        }
        if (resonance.energyMin !== undefined) {
            entries.push(`'energy_min': ${resonance.energyMin}`);
        }
        if (resonance.energyMax !== undefined) {
            entries.push(`'energy_max': ${resonance.energyMax}`);
        }
        if (entries.length > 0) {
            lines.push(`settings.resonance_scattering = {${entries.join(', ')}}`);
        }
    }
    return lines;
}

/**
 * Generate the `Material.isotropic` assignment for one material.
 * @param material - Material definition.
 * @param variableName - Python variable name for the material.
 * @returns Python statement lines (empty when no nuclides are listed).
 */
export function generateMaterialIsotropicPython(material: OpenMCMaterial, variableName: string): string[] {
    const isotropic = (material.isotropic ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
    if (isotropic.length === 0) {
        return [];
    }
    return [`${variableName}.isotropic = [${isotropic.map((name) => JSON.stringify(name)).join(', ')}]`];
}
