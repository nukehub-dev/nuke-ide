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

import { DoseCoefficientsResult } from '../../../../../common/openmc-protocol';

export const DOSE_PARTICLE_LABELS: Record<string, string> = {
    photon: 'Photon',
    neutron: 'Neutron',
    electron: 'Electron',
    positron: 'Positron',
    proton: 'Proton',
    helium: 'Helium ion',
    'photon kerma': 'Photon kerma',
    'mu-': 'Negative muon',
    'mu+': 'Positive muon',
    'pi-': 'Negative pion',
    'pi+': 'Positive pion'
};

export function doseParticleLabel(particle: string): string {
    return DOSE_PARTICLE_LABELS[particle] ?? particle;
}

export function doseQuantityLabel(quantity: 'effective' | 'ambient'): string {
    return quantity === 'ambient' ? 'Ambient dose equivalent H*(10)' : 'Effective dose';
}

/** Chart y-axis label carrying the coefficient unit. */
export function doseCoefficientAxisLabel(units: string | undefined): string {
    return `Dose coefficient (${units ?? 'pSv cm²'})`;
}

/** Plotly trace for the coefficient curve (energy in MeV). */
export function buildDoseCoefficientTrace(result: DoseCoefficientsResult): Array<Record<string, unknown>> {
    if (!result.energyEv?.length || !result.response?.length) {
        return [];
    }
    return [
        {
            x: result.energyEv.map((energy) => energy / 1e6),
            y: result.response,
            type: 'scatter',
            mode: 'lines',
            name: doseParticleLabel(result.particle ?? 'photon'),
            line: { color: '#4da3ff', width: 2 },
            hovertemplate: `%{x:.6g} MeV<br>%{y:.6g} ${result.units ?? ''}<extra></extra>`
        }
    ];
}

export interface DoseCoefficientRow {
    energyMeV: number;
    coefficient: number;
}

/** Table rows for the coefficient energy grid. */
export function doseCoefficientRows(result: DoseCoefficientsResult): DoseCoefficientRow[] {
    if (!result.energyEv?.length || !result.response?.length) {
        return [];
    }
    return result.energyEv.map((energy, index) => ({
        energyMeV: energy / 1e6,
        coefficient: result.response![index]
    }));
}

/** Default geometry for a particle when the previous choice is unavailable. */
export function resolveGeometry(available: string[] | undefined, current: string): string {
    if (!available?.length) {
        return current;
    }
    return available.includes(current) ? current : available[0];
}

/** Effective dose uses geometry; ambient H*(10) has a single AP table. */
export function geometryOptions(quantity: 'effective' | 'ambient', available: string[] | undefined): string[] {
    if (quantity === 'ambient') {
        return ['AP'];
    }
    return available?.length ? available : ['AP', 'PA', 'LLAT', 'RLAT', 'ROT', 'ISO'];
}
