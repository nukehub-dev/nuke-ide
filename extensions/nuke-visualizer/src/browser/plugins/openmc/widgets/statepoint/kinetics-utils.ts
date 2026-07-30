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
 * Pure helpers for the IFP kinetics section of the statepoint viewer:
 * IFP tally detection, uncertainty formatting, and CSV serialization.
 * Kept free of DOM/DI dependencies so they are unit-testable in node.
 */

import type { OpenMCKineticsResult, OpenMCKineticsValue } from '../../../../../common/openmc-protocol';

/** Minimal tally shape needed for IFP detection (scores list). */
export interface TallyScores {
    scores: string[];
}

/** True when any tally carries an IFP score (`ifp-denominator`, `ifp-*-numerator`). */
export function hasIfpTallies(tallies: readonly TallyScores[]): boolean {
    return tallies.some((tally) => tally.scores.some((score) => score.startsWith('ifp-')));
}

/** Format a scalar for display: fixed for moderate magnitudes, exponential otherwise. */
export function formatValue(value: number, significantDigits = 6): string {
    if (value === 0) {
        return '0';
    }
    const magnitude = Math.abs(value);
    if (magnitude >= 1e-3 && magnitude < 1e6) {
        return String(Number(value.toPrecision(significantDigits)));
    }
    return value.toExponential(significantDigits - 1);
}

/** Format a measured value as `mean ± std` (2 significant digits on the uncertainty). */
export function formatUncertainty(value: OpenMCKineticsValue, significantDigits = 6): string {
    // Render the uncertainty in the same notation as the mean so the pair reads naturally
    const magnitude = Math.abs(value.mean);
    if (magnitude >= 1e-3 && magnitude < 1e6) {
        return `${formatValue(value.mean, significantDigits)} ± ${String(Number(value.stdDev.toPrecision(2)))}`;
    }
    return `${formatValue(value.mean, significantDigits)} ± ${formatValue(value.stdDev, 2)}`;
}

/**
 * Serialize kinetics parameters to CSV: one row per quantity
 * (β_eff total, β_eff per delayed group, Λ_eff, k_eff reference).
 * Values are written at full precision.
 */
export function kineticsToCsv(result: OpenMCKineticsResult): string {
    const rows: string[][] = [['parameter', 'group', 'mean', 'std_dev']];

    if (result.betaEffective) {
        rows.push(['beta_eff', 'total', String(result.betaEffective.mean), String(result.betaEffective.stdDev)]);
    }
    for (const [index, group] of (result.betaEffectiveGroups ?? []).entries()) {
        rows.push(['beta_eff', `group_${index + 1}`, String(group.mean), String(group.stdDev)]);
    }
    if (result.generationTime) {
        rows.push(['lambda_eff', '', String(result.generationTime.mean), String(result.generationTime.stdDev)]);
    }
    if (result.keff) {
        rows.push(['k_eff', '', String(result.keff.mean), String(result.keff.stdDev)]);
    }

    return rows.map((row) => row.join(',')).join('\n') + '\n';
}
