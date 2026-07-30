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
 * OpenMC Tally Score Catalog
 *
 * Typed data catalog of every score OpenMC accepts, used by the tally
 * configurator's score selector. Score names are ground-truthed against the
 * OpenMC source: special scores and reaction names from
 * `src/reaction.cpp` (REACTION_NAME_MAP / REACTION_TYPE_MAP) and MT numbers
 * from `openmc/data/reaction.py` (REACTION_NAME).
 *
 * Note: the legacy `scatter-N` / `nu-fission-N` moment scores are deprecated
 * upstream (openmc/tallies.py rejects them) and are intentionally absent —
 * Legendre moments are produced with a LegendreFilter instead. Custom integer
 * MT numbers remain supported (any MT ≥ 1).
 *
 * @module openmc-studio/common
 */

/** Score category identifiers */
export type OpenMCScoreCategory = 'basic' | 'neutron-reaction' | 'photon' | 'particle-production' | 'kinetics-ifp' | 'advanced';

/** A single tally score entry in the catalog */
export interface OpenMCScoreEntry {
    /** Score name exactly as accepted by OpenMC (also the tallies.xml text) */
    name: string;
    /** Human-readable label */
    label: string;
    /** Category for grouping in the UI */
    category: OpenMCScoreCategory;
    /** ENDF MT number for reaction scores */
    mt?: number;
    /** Particle the score applies to (omit when particle-agnostic) */
    requiresParticle?: 'neutron' | 'photon';
}

/** Display labels for score categories */
export const OPENMC_SCORE_CATEGORY_LABELS: Record<OpenMCScoreCategory, string> = {
    basic: 'Basic',
    'neutron-reaction': 'Neutron Reactions',
    photon: 'Photon Physics',
    'particle-production': 'Particle Production',
    'kinetics-ifp': 'Kinetics (IFP)',
    advanced: 'Advanced'
};

/** Category display order */
export const OPENMC_SCORE_CATEGORY_ORDER: OpenMCScoreCategory[] = [
    'basic',
    'neutron-reaction',
    'photon',
    'particle-production',
    'kinetics-ifp',
    'advanced'
];

/** Full OpenMC tally score catalog */
export const OPENMC_SCORES: OpenMCScoreEntry[] = [
    // Basic
    { name: 'flux', label: 'Flux', category: 'basic' },
    { name: 'total', label: 'Total (MT 1)', category: 'basic', mt: 1 },
    { name: 'absorption', label: 'Absorption', category: 'basic' },
    { name: 'fission', label: 'Fission (MT 18)', category: 'basic', mt: 18 },
    { name: 'nu-fission', label: 'nu-Fission', category: 'basic' },

    // Neutron reactions (names/MTs from openmc/data/reaction.py)
    { name: 'elastic', label: 'Elastic (MT 2)', category: 'neutron-reaction', mt: 2 },
    { name: '(n,nonelastic)', label: 'Nonelastic (MT 3)', category: 'neutron-reaction', mt: 3 },
    { name: '(n,level)', label: 'Level (MT 4)', category: 'neutron-reaction', mt: 4 },
    { name: '(n,misc)', label: 'Misc (MT 5)', category: 'neutron-reaction', mt: 5 },
    { name: '(n,2nd)', label: 'Second Chance (MT 11)', category: 'neutron-reaction', mt: 11 },
    { name: '(n,2n)', label: '(n,2n) — MT 16', category: 'neutron-reaction', mt: 16 },
    { name: '(n,3n)', label: '(n,3n) — MT 17', category: 'neutron-reaction', mt: 17 },
    { name: '(n,f)', label: '(n,f) — MT 19', category: 'neutron-reaction', mt: 19 },
    { name: '(n,nf)', label: '(n,nf) — MT 20', category: 'neutron-reaction', mt: 20 },
    { name: '(n,2nf)', label: '(n,2nf) — MT 21', category: 'neutron-reaction', mt: 21 },
    { name: '(n,na)', label: '(n,nα) — MT 22', category: 'neutron-reaction', mt: 22 },
    { name: '(n,n3a)', label: '(n,n3α) — MT 23', category: 'neutron-reaction', mt: 23 },
    { name: '(n,2na)', label: '(n,2nα) — MT 24', category: 'neutron-reaction', mt: 24 },
    { name: '(n,3na)', label: '(n,3nα) — MT 25', category: 'neutron-reaction', mt: 25 },
    { name: '(n,np)', label: '(n,np) — MT 28', category: 'neutron-reaction', mt: 28 },
    { name: '(n,n2a)', label: '(n,n2α) — MT 29', category: 'neutron-reaction', mt: 29 },
    { name: '(n,2n2a)', label: '(n,2n2α) — MT 30', category: 'neutron-reaction', mt: 30 },
    { name: '(n,nd)', label: '(n,nd) — MT 32', category: 'neutron-reaction', mt: 32 },
    { name: '(n,nt)', label: '(n,nt) — MT 33', category: 'neutron-reaction', mt: 33 },
    { name: '(n,n3He)', label: '(n,n³He) — MT 34', category: 'neutron-reaction', mt: 34 },
    { name: '(n,4n)', label: '(n,4n) — MT 37', category: 'neutron-reaction', mt: 37 },
    { name: '(n,2np)', label: '(n,2np) — MT 41', category: 'neutron-reaction', mt: 41 },
    { name: '(n,3np)', label: '(n,3np) — MT 42', category: 'neutron-reaction', mt: 42 },
    { name: '(n,n2p)', label: '(n,n2p) — MT 44', category: 'neutron-reaction', mt: 44 },
    { name: '(n,npa)', label: '(n,npα) — MT 45', category: 'neutron-reaction', mt: 45 },
    { name: '(n,nc)', label: '(n,nc) — MT 91', category: 'neutron-reaction', mt: 91 },
    { name: '(n,disappear)', label: '(n,disappear) — MT 101', category: 'neutron-reaction', mt: 101 },
    { name: '(n,gamma)', label: '(n,γ) Capture — MT 102', category: 'neutron-reaction', mt: 102 },
    { name: '(n,p)', label: '(n,p) — MT 103', category: 'neutron-reaction', mt: 103 },
    { name: '(n,d)', label: '(n,d) — MT 104', category: 'neutron-reaction', mt: 104 },
    { name: '(n,t)', label: '(n,t) — MT 105', category: 'neutron-reaction', mt: 105 },
    { name: '(n,3He)', label: '(n,³He) — MT 106', category: 'neutron-reaction', mt: 106 },
    { name: '(n,a)', label: '(n,α) — MT 107', category: 'neutron-reaction', mt: 107 },
    { name: '(n,2a)', label: '(n,2α) — MT 108', category: 'neutron-reaction', mt: 108 },
    { name: '(n,3a)', label: '(n,3α) — MT 109', category: 'neutron-reaction', mt: 109 },
    { name: '(n,2p)', label: '(n,2p) — MT 111', category: 'neutron-reaction', mt: 111 },
    { name: '(n,pa)', label: '(n,pα) — MT 112', category: 'neutron-reaction', mt: 112 },
    { name: '(n,t2a)', label: '(n,t2α) — MT 113', category: 'neutron-reaction', mt: 113 },
    { name: '(n,d2a)', label: '(n,d2α) — MT 114', category: 'neutron-reaction', mt: 114 },
    { name: '(n,pd)', label: '(n,pd) — MT 115', category: 'neutron-reaction', mt: 115 },
    { name: '(n,pt)', label: '(n,pt) — MT 116', category: 'neutron-reaction', mt: 116 },
    { name: '(n,da)', label: '(n,dα) — MT 117', category: 'neutron-reaction', mt: 117 },
    { name: '(n,Xn)', label: '(n,Xn) — MT 201', category: 'neutron-reaction', mt: 201 },
    { name: '(n,Xgamma)', label: '(n,Xγ) — MT 202', category: 'neutron-reaction', mt: 202 },

    // Photon physics (src/reaction.cpp: photon score names)
    { name: 'photon-total', label: 'Photon Total', category: 'photon', requiresParticle: 'photon' },
    { name: 'coherent-scatter', label: 'Coherent Scatter', category: 'photon', requiresParticle: 'photon' },
    { name: 'incoherent-scatter', label: 'Incoherent Scatter', category: 'photon', requiresParticle: 'photon' },
    { name: 'photoelectric', label: 'Photoelectric', category: 'photon', requiresParticle: 'photon' },
    { name: 'pair-production', label: 'Pair Production', category: 'photon', requiresParticle: 'photon' },
    { name: 'pair-production-electron', label: 'Pair Production (Electron)', category: 'photon', requiresParticle: 'photon' },
    { name: 'pair-production-nuclear', label: 'Pair Production (Nuclear)', category: 'photon', requiresParticle: 'photon' },

    // Particle production (src/reaction.cpp: alternate names)
    { name: 'H1-production', label: 'H1 Production', category: 'particle-production' },
    { name: 'H2-production', label: 'H2 Production', category: 'particle-production' },
    { name: 'H3-production', label: 'H3 Production', category: 'particle-production' },
    { name: 'He3-production', label: 'He3 Production', category: 'particle-production' },
    { name: 'He4-production', label: 'He4 Production', category: 'particle-production' },

    // Kinetics / iterated fission probability
    { name: 'ifp-time-numerator', label: 'IFP Time Numerator (Λ_eff)', category: 'kinetics-ifp' },
    { name: 'ifp-beta-numerator', label: 'IFP Beta Numerator (β_eff)', category: 'kinetics-ifp' },
    { name: 'ifp-denominator', label: 'IFP Denominator', category: 'kinetics-ifp' },
    { name: 'prompt-nu-fission', label: 'Prompt nu-Fission', category: 'kinetics-ifp' },
    { name: 'delayed-nu-fission', label: 'Delayed nu-Fission', category: 'kinetics-ifp' },
    { name: 'decay-rate', label: 'Decay Rate', category: 'kinetics-ifp' },

    // Advanced
    { name: 'scatter', label: 'Scatter', category: 'advanced' },
    { name: 'nu-scatter', label: 'nu-Scatter', category: 'advanced' },
    { name: 'kappa-fission', label: 'Kappa-Fission', category: 'advanced' },
    { name: 'fission-q-prompt', label: 'Fission Q (Prompt)', category: 'advanced' },
    { name: 'fission-q-recoverable', label: 'Fission Q (Recoverable)', category: 'advanced' },
    { name: 'current', label: 'Current', category: 'advanced' },
    { name: 'events', label: 'Events', category: 'advanced' },
    { name: 'pulse-height', label: 'Pulse Height', category: 'advanced' },
    { name: 'inverse-velocity', label: 'Inverse Velocity', category: 'advanced' },
    { name: 'heating', label: 'Heating', category: 'advanced' },
    { name: 'heating-local', label: 'Heating (Local)', category: 'advanced' },
    { name: 'damage-energy', label: 'Damage Energy', category: 'advanced' }
];

/**
 * Get catalog scores grouped by category, in display order.
 * @returns Category/scores groups ready for rendering.
 */
export function getScoresByCategory(): { category: OpenMCScoreCategory; label: string; scores: OpenMCScoreEntry[] }[] {
    return OPENMC_SCORE_CATEGORY_ORDER.map((category) => ({
        category,
        label: OPENMC_SCORE_CATEGORY_LABELS[category],
        scores: OPENMC_SCORES.filter((s) => s.category === category)
    }));
}

/**
 * Look up a catalog entry by score name.
 * @param name - Score name.
 * @returns The catalog entry, or undefined for custom/legacy scores.
 */
export function getScoreEntry(name: string): OpenMCScoreEntry | undefined {
    return OPENMC_SCORES.find((s) => s.name === name);
}

/**
 * Check whether a score name is a custom integer MT number (any MT ≥ 1).
 * @param name - Score name.
 * @returns Whether the name is a positive integer MT number.
 */
export function isCustomMtScore(name: string): boolean {
    return /^[1-9]\d*$/.test(name.trim());
}
