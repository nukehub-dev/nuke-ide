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
 * Integrity tests for the tally score and filter catalogs
 * (src/common/scores-catalog.ts, src/common/filters-catalog.ts).
 */

import { describe, it, expect } from 'vitest';

import { OPENMC_SCORES, OPENMC_SCORE_CATEGORY_ORDER, getScoresByCategory, getScoreEntry, isCustomMtScore } from './scores-catalog';
import { OPENMC_FILTERS, getFilterDescriptor, createDefaultFilter } from './filters-catalog';
import { OpenMCTallyFilterType } from './openmc-state-schema';

/** Well-known ENDF MT numbers (openmc/data/reaction.py REACTION_NAME) */
const KNOWN_MTS: Record<string, number> = {
    total: 1,
    elastic: 2,
    '(n,2n)': 16,
    '(n,3n)': 17,
    fission: 18,
    '(n,gamma)': 102,
    '(n,p)': 103,
    '(n,d)': 104,
    '(n,t)': 105,
    '(n,3He)': 106,
    '(n,a)': 107,
    '(n,Xn)': 201,
    '(n,Xgamma)': 202
};

/** Filter types the schema supports (must stay in sync with OpenMCTallyFilterType) */
const SCHEMA_FILTER_TYPES: OpenMCTallyFilterType[] = [
    'universe',
    'material',
    'cell',
    'cellborn',
    'cellfrom',
    'surface',
    'mesh',
    'meshsurface',
    'pre-collision',
    'post-collision',
    'energy',
    'energyout',
    'energyfunction',
    'mu',
    'polar',
    'azimuthal',
    'distribcell',
    'delayedgroup',
    'time',
    'legendre',
    'spatiallegendre',
    'sphericalharmonics',
    'particle',
    'zernike',
    'zernikeradial'
];

describe('scores catalog integrity', () => {
    it('has unique score names', () => {
        const names = OPENMC_SCORES.map((s) => s.name);
        expect(new Set(names).size).toBe(names.length);
    });

    it('has a label and valid category for every entry', () => {
        for (const entry of OPENMC_SCORES) {
            expect(entry.label.length).toBeGreaterThan(0);
            expect(OPENMC_SCORE_CATEGORY_ORDER).toContain(entry.category);
        }
    });

    it('has integer MT numbers ≥ 1 for reaction scores', () => {
        for (const entry of OPENMC_SCORES) {
            if (entry.mt !== undefined) {
                expect(Number.isInteger(entry.mt)).toBe(true);
                expect(entry.mt).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it('matches well-known ENDF MT numbers', () => {
        for (const [name, mt] of Object.entries(KNOWN_MTS)) {
            expect(getScoreEntry(name)?.mt, `MT of ${name}`).toBe(mt);
        }
    });

    it('groups every score into exactly one category', () => {
        const grouped = getScoresByCategory();
        const total = grouped.reduce((sum, g) => sum + g.scores.length, 0);
        expect(total).toBe(OPENMC_SCORES.length);
        for (const group of grouped) {
            expect(group.scores.length).toBeGreaterThan(0);
        }
    });

    it('contains the scores required by downstream workstreams', () => {
        for (const required of [
            'ifp-time-numerator',
            'ifp-beta-numerator',
            'ifp-denominator',
            'fission-q-prompt',
            'fission-q-recoverable',
            'pulse-height',
            'current',
            'events',
            'H1-production',
            'He3-production'
        ]) {
            expect(getScoreEntry(required), `missing score ${required}`).toBeDefined();
        }
    });

    it('rejects deprecated moment scores (scatter-N) but accepts custom MTs', () => {
        expect(getScoreEntry('scatter-1')).toBeUndefined();
        expect(isCustomMtScore('102')).toBe(true);
        expect(isCustomMtScore('0')).toBe(false);
        expect(isCustomMtScore('flux')).toBe(false);
    });
});

describe('filters catalog integrity', () => {
    it('has unique filter types', () => {
        const types = OPENMC_FILTERS.map((f) => f.type);
        expect(new Set(types).size).toBe(types.length);
    });

    it('only uses schema-supported filter types', () => {
        for (const descriptor of OPENMC_FILTERS) {
            expect(SCHEMA_FILTER_TYPES).toContain(descriptor.type);
        }
    });

    it('has a descriptor for every real OpenMC filter type in the schema', () => {
        // pre-collision/post-collision are legacy schema entries with no
        // OpenMC equivalent and are intentionally not in the catalog
        const withoutDescriptor = SCHEMA_FILTER_TYPES.filter(
            (t) => !getFilterDescriptor(t) && t !== 'pre-collision' && t !== 'post-collision'
        );
        expect(withoutDescriptor).toEqual([]);
    });

    it('has label, tooltip, and editor for every descriptor', () => {
        for (const descriptor of OPENMC_FILTERS) {
            expect(descriptor.label.length).toBeGreaterThan(0);
            expect(descriptor.tooltip.length).toBeGreaterThan(0);
            expect(descriptor.editor.length).toBeGreaterThan(0);
        }
    });

    it('creates default filters matching the descriptors', () => {
        for (const descriptor of OPENMC_FILTERS) {
            const filter = createDefaultFilter(descriptor.type, 7);
            expect(filter.type).toBe(descriptor.type);
            if (descriptor.requiresMesh) {
                expect(filter.meshId).toBe(7);
                expect(filter.bins).toEqual([7]);
            } else {
                expect(filter.bins).toEqual(descriptor.defaultBins ?? []);
            }
            for (const [key, value] of Object.entries(descriptor.defaultValues ?? {})) {
                expect(filter[key as keyof typeof filter], `default ${key} of ${descriptor.type}`).toEqual(value);
            }
        }
    });
});
