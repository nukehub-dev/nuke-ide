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
 * ENDF-6 reaction names used by `openmc.ReactionFilter`.
 *
 * OpenMC's `ReactionFilter` normalizes integer MT numbers and aliases to the
 * canonical `REACTION_NAME` strings from `openmc/data/reaction.py`; the same
 * normalization is used here so the UI, XML, and Python export agree.
 *
 * @module openmc-studio/common
 */

/** One selectable reaction. */
export interface OpenMCReactionEntry {
    /** ENDF-6 MT number. */
    mt: number;
    /** Canonical OpenMC reaction name (e.g. `(n,gamma)`). */
    name: string;
    /** Human label shown by pickers (e.g. `(n,gamma) · MT 102`). */
    label: string;
}

/**
 * Canonical OpenMC reaction names keyed by MT. The explicit table matches
 * `openmc/data/reaction.py`; the generated ranges below cover the MT number
 * families OpenMC expands programmatically.
 */
const REACTION_NAMES: Record<number, string> = {
    1: '(n,total)',
    2: '(n,elastic)',
    3: '(n,nonelastic)',
    4: '(n,level)',
    5: '(n,misc)',
    11: '(n,2nd)',
    16: '(n,2n)',
    17: '(n,3n)',
    18: '(n,fission)',
    19: '(n,f)',
    20: '(n,nf)',
    21: '(n,2nf)',
    22: '(n,na)',
    23: '(n,n3a)',
    24: '(n,2na)',
    25: '(n,3na)',
    27: '(n,absorption)',
    28: '(n,np)',
    29: '(n,n2a)',
    30: '(n,2n2a)',
    32: '(n,nd)',
    33: '(n,nt)',
    34: '(n,n3He)',
    35: '(n,nd2a)',
    36: '(n,nt2a)',
    37: '(n,4n)',
    38: '(n,3nf)',
    41: '(n,2np)',
    42: '(n,3np)',
    44: '(n,n2p)',
    45: '(n,npa)',
    91: '(n,nc)',
    101: '(n,disappear)',
    102: '(n,gamma)',
    103: '(n,p)',
    104: '(n,d)',
    105: '(n,t)',
    106: '(n,3He)',
    107: '(n,a)',
    108: '(n,2a)',
    109: '(n,3a)',
    111: '(n,2p)',
    112: '(n,pa)',
    113: '(n,t2a)',
    114: '(n,d2a)',
    115: '(n,pd)',
    116: '(n,pt)',
    117: '(n,da)',
    152: '(n,5n)',
    153: '(n,6n)',
    154: '(n,2nt)',
    155: '(n,ta)',
    156: '(n,4np)',
    157: '(n,3nd)',
    158: '(n,nda)',
    159: '(n,2npa)',
    160: '(n,7n)',
    161: '(n,8n)',
    162: '(n,5np)',
    163: '(n,6np)',
    164: '(n,7np)',
    165: '(n,4na)',
    166: '(n,5na)',
    167: '(n,6na)',
    168: '(n,7na)',
    169: '(n,4nd)',
    170: '(n,5nd)',
    171: '(n,6nd)',
    172: '(n,3nt)',
    173: '(n,4nt)',
    174: '(n,5nt)',
    175: '(n,6nt)',
    176: '(n,2n3He)',
    177: '(n,3n3He)',
    178: '(n,4n3He)',
    179: '(n,3n2p)',
    180: '(n,3n2a)',
    181: '(n,3npa)',
    182: '(n,dt)',
    183: '(n,npd)',
    184: '(n,npt)',
    185: '(n,ndt)',
    186: '(n,np3He)',
    187: '(n,nd3He)',
    188: '(n,nt3He)',
    189: '(n,nta)',
    190: '(n,2n2p)',
    191: '(n,p3He)',
    192: '(n,d3He)',
    193: '(n,3Hea)',
    194: '(n,4n2p)',
    195: '(n,4n2a)',
    196: '(n,4npa)',
    197: '(n,3p)',
    198: '(n,n3p)',
    199: '(n,3n2pa)',
    200: '(n,5n2p)',
    203: '(n,Xp)',
    204: '(n,Xd)',
    205: '(n,Xt)',
    206: '(n,X3He)',
    207: '(n,Xa)',
    301: 'heating',
    444: 'damage-energy',
    501: 'photon-total',
    502: 'coherent-scatter',
    504: 'incoherent-scatter',
    515: 'pair-production-electron',
    516: 'pair-production',
    517: 'pair-production-nuclear',
    522: 'photoelectric',
    649: '(n,pc)',
    699: '(n,dc)',
    749: '(n,tc)',
    799: '(n,3Hec)',
    849: '(n,ac)',
    891: '(n,2nc)',
    901: 'heating-local'
};

for (let mt = 51; mt <= 90; mt++) {
    REACTION_NAMES[mt] = `(n,n${mt - 50})`;
}
for (let mt = 600; mt <= 648; mt++) {
    REACTION_NAMES[mt] = `(n,p${mt - 600})`;
}
for (let mt = 650; mt <= 698; mt++) {
    REACTION_NAMES[mt] = `(n,d${mt - 650})`;
}
for (let mt = 700; mt <= 748; mt++) {
    REACTION_NAMES[mt] = `(n,t${mt - 700})`;
}
for (let mt = 750; mt <= 798; mt++) {
    REACTION_NAMES[mt] = `(n,3He${mt - 750})`;
}
for (let mt = 800; mt <= 848; mt++) {
    REACTION_NAMES[mt] = `(n,a${mt - 800})`;
}
for (let mt = 875; mt <= 890; mt++) {
    REACTION_NAMES[mt] = `(n,2n${mt - 875})`;
}

/** Photon subshells (openmc/data/photon.py `_SUBSHELLS[1:]`). */
const PHOTON_SUBSHELLS = [
    'K',
    'L1',
    'L2',
    'L3',
    'M1',
    'M2',
    'M3',
    'M4',
    'M5',
    'N1',
    'N2',
    'N3',
    'N4',
    'N5',
    'N6',
    'N7',
    'O1',
    'O2',
    'O3',
    'O4',
    'O5',
    'O6',
    'O7',
    'O8',
    'O9',
    'P1',
    'P2',
    'P3',
    'P4',
    'P5',
    'P6',
    'P7',
    'P8',
    'P9',
    'P10',
    'P11',
    'Q1',
    'Q2',
    'Q3'
];
PHOTON_SUBSHELLS.forEach((shell, index) => {
    REACTION_NAMES[534 + index] = `photoelectric-${shell}`;
});

/** Short aliases accepted by OpenMC's `REACTION_MT` map. */
const REACTION_ALIASES: Record<string, number> = {
    total: 1,
    elastic: 2,
    fission: 18,
    absorption: 27,
    capture: 102
};

const REACTION_MTS: Record<string, number> = Object.fromEntries(Object.entries(REACTION_NAMES).map(([mt, name]) => [name, Number(mt)]));

function labelFor(mt: number, name: string): string {
    return `${name} · MT ${mt}`;
}

/** Complete selectable reaction list, ascending by MT. */
export const OPENMC_REACTIONS: OpenMCReactionEntry[] = Object.keys(REACTION_NAMES)
    .map(Number)
    .sort((a, b) => a - b)
    .map((mt) => ({ mt, name: REACTION_NAMES[mt], label: labelFor(mt, REACTION_NAMES[mt]) }));

/** Reactions pinned in the picker (common transport/depletion reactions). */
export const PINNED_REACTIONS: OpenMCReactionEntry[] = [1, 2, 18, 102, 103, 16, 17, 107, 27]
    .map((mt) => OPENMC_REACTIONS.find((entry) => entry.mt === mt))
    .filter((entry): entry is OpenMCReactionEntry => entry !== undefined);

/**
 * Resolve an MT number or name/alias to OpenMC's canonical reaction name.
 *
 * @param value - Integer MT (or numeric string) or reaction name/alias.
 * @returns Canonical reaction name, or undefined when OpenMC would reject it.
 */
export function normalizeReactionBin(value: string | number): string | undefined {
    if (typeof value === 'number') {
        return REACTION_NAMES[value];
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (/^\d+$/.test(trimmed)) {
        return REACTION_NAMES[Number(trimmed)];
    }
    const aliasMt = REACTION_ALIASES[trimmed];
    if (aliasMt !== undefined) {
        return REACTION_NAMES[aliasMt];
    }
    if (REACTION_MTS[trimmed] !== undefined) {
        return trimmed;
    }
    return undefined;
}

/**
 * Look up the MT number for a canonical reaction name.
 *
 * @param name - Canonical reaction name.
 * @returns MT number, or undefined for unknown names.
 */
export function getReactionMt(name: string): number | undefined {
    return REACTION_MTS[name];
}

/**
 * Format a reaction for display with its MT number when known.
 *
 * @param name - Canonical reaction name.
 */
export function getReactionLabel(name: string): string {
    const mt = REACTION_MTS[name];
    return mt !== undefined ? labelFor(mt, name) : name;
}

/**
 * Search the reaction catalog by name or MT prefix.
 *
 * @param query - Free-text search.
 * @param limit - Maximum number of results (default 8).
 * @returns Matching reactions, ascending by MT.
 */
export function searchReactions(query: string, limit = 8): OpenMCReactionEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
        return PINNED_REACTIONS;
    }
    const matches = OPENMC_REACTIONS.filter((entry) => entry.name.toLowerCase().includes(needle) || String(entry.mt).startsWith(needle));
    return matches.slice(0, limit);
}
