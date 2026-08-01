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
 * Pure formatting helpers for the ENDF tab. No DI/DOM dependencies.
 */

const YEAR_S = 365.25 * 24 * 3600;
const DAY_S = 24 * 3600;

/** Format a half-life with a human unit (y, d, h, min, s). */
export function formatHalfLife(seconds: number): string {
    if (seconds >= YEAR_S) {
        return `${(seconds / YEAR_S).toPrecision(3)} y`;
    }
    if (seconds >= DAY_S) {
        return `${(seconds / DAY_S).toPrecision(3)} d`;
    }
    if (seconds >= 3600) {
        return `${(seconds / 3600).toPrecision(3)} h`;
    }
    if (seconds >= 60) {
        return `${(seconds / 60).toPrecision(3)} min`;
    }
    return `${seconds.toPrecision(3)} s`;
}

/** Format an energy in eV with eV/keV/MeV units. */
export function formatEnergyEeV(energyEV: number): string {
    if (energyEV >= 1e6) {
        return `${(energyEV / 1e6).toPrecision(3)} MeV`;
    }
    if (energyEV >= 1e3) {
        return `${(energyEV / 1e3).toPrecision(3)} keV`;
    }
    return `${energyEV.toPrecision(3)} eV`;
}

/** Format a fission yield (dimensionless) with sensible precision. */
export function formatYield(value: number): string {
    if (value === 0) {
        return '0';
    }
    if (Math.abs(value) < 1e-3) {
        return value.toExponential(2);
    }
    return value.toPrecision(4);
}
