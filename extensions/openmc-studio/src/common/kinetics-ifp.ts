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
 * Kinetics (IFP) tally helpers.
 *
 * Shared logic for the Iterated Fission Probability method: which tallies to
 * auto-generate when kinetics are enabled (mirroring OpenMC's own
 * `Model.add_kinetics_parameters_tallies`, openmc/model/model.py:263), and how
 * to derive kinetics settings back from parsed tallies on import.
 *
 * @module openmc-studio/common
 */

import { OpenMCSettings, OpenMCTally } from './openmc-state-schema';

/** IFP score names accepted by OpenMC */
export const IFP_SCORES = {
    timeNumerator: 'ifp-time-numerator',
    betaNumerator: 'ifp-beta-numerator',
    denominator: 'ifp-denominator'
} as const;

/**
 * Check whether a tally carries any IFP score (i.e. is an IFP kinetics tally).
 * @param tally - Tally to check.
 * @returns Whether the tally contains an `ifp-*` score.
 */
export function isIfpTally(tally: OpenMCTally): boolean {
    return tally.scores.some((s) => s.startsWith('ifp-'));
}

/**
 * Compute the auto-generated IFP tallies to append for the given settings.
 * Returns an empty list when kinetics are disabled or every needed tally is
 * already present (mirrors `Model.add_kinetics_parameters_tallies`, which
 * skips scores that already exist).
 * @param tallies - User-defined tallies already on the state.
 * @param kinetics - Kinetics settings from `OpenMCSettings.kinetics`.
 * @param nextId - First free tally ID for the auto-generated tallies.
 * @returns The IFP tallies to append (may be empty).
 */
export function getAutoIfpTallies(tallies: OpenMCTally[], kinetics: OpenMCSettings['kinetics'], nextId: number): OpenMCTally[] {
    if (!kinetics?.enabled) {
        return [];
    }

    const result: OpenMCTally[] = [];
    const hasScore = (score: string): boolean =>
        tallies.some((t) => t.scores.includes(score)) || result.some((t) => t.scores.includes(score));

    if (kinetics.computeGenerationTime !== false && !hasScore(IFP_SCORES.timeNumerator)) {
        result.push({ id: nextId++, name: 'IFP time numerator', scores: [IFP_SCORES.timeNumerator], nuclides: [], filters: [] });
    }

    if (kinetics.computeBetaEff !== false && !hasScore(IFP_SCORES.betaNumerator)) {
        const numGroups = kinetics.numPrecursorGroups ?? 0;
        result.push({
            id: nextId++,
            name: 'IFP beta numerator',
            scores: [IFP_SCORES.betaNumerator],
            nuclides: [],
            filters: numGroups > 1 ? [{ type: 'delayedgroup', bins: Array.from({ length: numGroups }, (_, i) => i + 1) }] : []
        });
    }

    if (!hasScore(IFP_SCORES.denominator)) {
        result.push({ id: nextId, name: 'IFP denominator', scores: [IFP_SCORES.denominator], nuclides: [], filters: [] });
    }

    return result;
}

/**
 * Derive kinetics settings from parsed tallies (import path). Recognizes IFP
 * tallies in imported XML and reconstructs `OpenMCSettings.kinetics` so a
 * re-export does not duplicate them.
 * @param tallies - Tallies parsed from tallies.xml.
 * @param existing - Kinetics settings already parsed from settings.xml (carries `ifpNGenerations`).
 * @returns The derived kinetics settings, or the existing value when no IFP tally is present.
 */
export function deriveKineticsFromTallies(
    tallies: OpenMCTally[],
    existing: OpenMCSettings['kinetics']
): OpenMCSettings['kinetics'] | undefined {
    const hasTime = tallies.some((t) => t.scores.includes(IFP_SCORES.timeNumerator));
    const hasBeta = tallies.some((t) => t.scores.includes(IFP_SCORES.betaNumerator));
    const hasDenom = tallies.some((t) => t.scores.includes(IFP_SCORES.denominator));

    if (!hasTime && !hasBeta && !hasDenom) {
        return existing;
    }

    const betaTally = tallies.find((t) => t.scores.includes(IFP_SCORES.betaNumerator));
    const delayedGroupFilter = betaTally?.filters.find((f) => f.type === 'delayedgroup');

    return {
        enabled: true,
        ifpNGenerations: existing?.ifpNGenerations,
        numPrecursorGroups: delayedGroupFilter && delayedGroupFilter.bins.length > 1 ? delayedGroupFilter.bins.length : undefined,
        computeBetaEff: hasBeta,
        computeGenerationTime: hasTime
    };
}
