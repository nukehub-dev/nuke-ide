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
 * Tests the pure OpenMC tally edit helpers.
 */

import { describe, expect, it } from 'vitest';
import type { OpenMCTally } from '../../common/openmc-state-schema';
import {
    cloneTallies,
    MAX_TALLY_ACTIONS,
    OpenMCTallyAction,
    previewTallyActions,
    tallyEquals,
    tallyValue,
    validateTallyActions
} from './openmc-tally-edit';

function buildTallies(): OpenMCTally[] {
    return [
        {
            id: 1,
            name: 'flux-cube',
            scores: ['flux'],
            nuclides: ['total'],
            filters: [{ type: 'cell', bins: [1, 2] }],
            estimator: 'tracklength',
            multiplyDensity: false,
            triggers: [{ type: 'rel_err', threshold: 0.05 }],
            derivative: { id: 7, variable: 'density', materialId: 1 }
        },
        {
            id: 4,
            scores: ['fission'],
            nuclides: ['U235'],
            filters: [{ type: 'energy', bins: [0, 20_000_000] }]
        }
    ];
}

describe('OpenMC tally edit validation', () => {
    it('accepts catalog scores and numeric MT scores', () => {
        const actions: OpenMCTallyAction[] = [
            { action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating', '102'] } },
            { action: 'add', tally: { scores: ['fission', '18'], nuclides: ['U235'], name: 'fission-rate' } }
        ];

        expect(validateTallyActions(buildTallies(), actions)).toEqual([]);
    });

    it('accepts an add with defaults, structured filters, and optional fields', () => {
        const actions: OpenMCTallyAction[] = [
            {
                action: 'add',
                tally: {
                    scores: ['flux'],
                    filters: [
                        { type: 'cellinstance', bins: [1, 0], pairs: [{ first: 1, second: 0 }] },
                        { type: 'energy', bins: [0, 20_000_000] }
                    ],
                    estimator: 'analog',
                    multiplyDensity: true,
                    higherMoments: true
                }
            }
        ];

        expect(validateTallyActions(buildTallies(), actions)).toEqual([]);
    });

    it('rejects empty, oversized, and malformed action sets', () => {
        expect(validateTallyActions(buildTallies(), [])).toEqual(['Provide at least one tally action.']);

        const tooMany: OpenMCTallyAction[] = Array.from({ length: MAX_TALLY_ACTIONS + 1 }, (_, index) => ({
            action: 'add',
            tally: { scores: ['flux'], name: `tally-${index}` }
        }));
        expect(validateTallyActions(buildTallies(), tooMany)).toEqual([`Provide at most ${MAX_TALLY_ACTIONS} tally actions.`]);

        const malformed = [{ action: 'rename' }] as unknown as OpenMCTallyAction[];
        expect(validateTallyActions(buildTallies(), malformed)[0]).toContain('update, add, or remove');
    });

    it('rejects bad scores', () => {
        const cases: Array<{ updates: Record<string, unknown>; message: string }> = [
            { updates: { scores: [] }, message: 'non-empty array of OpenMC score names' },
            { updates: { scores: ['not-a-score'] }, message: 'not an OpenMC catalog score' },
            { updates: { scores: [''] }, message: 'non-empty strings' },
            { updates: { scores: [102] }, message: 'non-empty strings' }
        ];

        for (const testCase of cases) {
            const errors = validateTallyActions(buildTallies(), [{ action: 'update', tallyId: 1, updates: testCase.updates }]);
            expect(errors.join(' ')).toContain(testCase.message);
        }

        const addErrors = validateTallyActions(buildTallies(), [{ action: 'add', tally: { scores: ['MT102'], nuclides: ['total'] } }]);
        expect(addErrors.join(' ')).toContain('not an OpenMC catalog score');
    });

    it('rejects empty or malformed nuclides', () => {
        for (const nuclides of [[], [''], ['U235', 5], 'total']) {
            const errors = validateTallyActions(buildTallies(), [{ action: 'update', tallyId: 1, updates: { nuclides } }]);
            expect(errors.join(' ')).toContain('nuclides');
        }

        const addErrors = validateTallyActions(buildTallies(), [{ action: 'add', tally: { scores: ['flux'], nuclides: [] } }]);
        expect(addErrors.join(' ')).toContain('nuclide names');
    });

    it('rejects a bad estimator and non-boolean flags', () => {
        const estimatorErrors = validateTallyActions(buildTallies(), [
            { action: 'update', tallyId: 1, updates: { estimator: 'next-event' } }
        ]);
        expect(estimatorErrors.join(' ')).toContain('analog, tracklength, or collision');

        const booleanErrors = validateTallyActions(buildTallies(), [
            { action: 'update', tallyId: 1, updates: { multiplyDensity: 'yes', higherMoments: 1 } }
        ]);
        expect(booleanErrors.join(' ')).toContain('multiplyDensity must be a boolean');
        expect(booleanErrors.join(' ')).toContain('higherMoments must be a boolean');
    });

    it('rejects bad filters on an add', () => {
        const cases: Array<{ filters: unknown; message: string }> = [
            { filters: [{ type: 'bogus', bins: [1] }], message: 'unknown tally filter type' },
            { filters: [{ type: 'cell', bins: [1.5] }], message: 'array of integers' },
            { filters: [{ type: 'cell', bins: '[1]' }], message: 'array of integers' },
            { filters: [{ type: 'cell' }], message: 'array of integers' },
            { filters: 'cell', message: 'must be an array of tally filters' }
        ];

        for (const testCase of cases) {
            const errors = validateTallyActions(buildTallies(), [
                { action: 'add', tally: { scores: ['flux'], filters: testCase.filters } }
            ]);
            expect(errors.join(' ')).toContain(testCase.message);
        }
    });

    it('rejects duplicate names, actions, and empty updates', () => {
        expect(
            validateTallyActions(buildTallies(), [{ action: 'add', tally: { scores: ['flux'], name: 'flux-cube' } }]).join(' ')
        ).toContain('already used by another tally');
        expect(
            validateTallyActions(buildTallies(), [{ action: 'update', tallyId: 4, updates: { name: 'flux-cube' } }]).join(' ')
        ).toContain('already used by another tally');
        expect(
            validateTallyActions(buildTallies(), [
                { action: 'add', tally: { scores: ['flux'], name: 'new' } },
                { action: 'add', tally: { scores: ['flux'], name: 'new' } }
            ]).join(' ')
        ).toContain('already used by another tally');
        expect(
            validateTallyActions(buildTallies(), [
                { action: 'update', tallyId: 1, updates: { scores: ['heating'] } },
                { action: 'update', tallyId: 1, updates: { estimator: 'analog' } }
            ]).join(' ')
        ).toContain('can only be updated or removed once');
        expect(
            validateTallyActions(buildTallies(), [
                { action: 'update', tallyId: 1, updates: { scores: ['heating'] } },
                { action: 'remove', tallyId: 1 }
            ]).join(' ')
        ).toContain('can only be updated or removed once');
        expect(validateTallyActions(buildTallies(), [{ action: 'update', tallyId: 1, updates: {} }]).join(' ')).toContain(
            'at least one field'
        );
        expect(validateTallyActions(buildTallies(), [{ action: 'remove', tallyId: 99 }]).join(' ')).toContain('does not exist');
    });

    it('rejects no-op updates', () => {
        const errors = validateTallyActions(buildTallies(), [
            { action: 'update', tallyId: 1, updates: { scores: ['flux'], estimator: 'tracklength', name: 'flux-cube' } }
        ]);

        expect(errors).toContain('Tally 1 already has the requested values.');
    });

    it('rejects filters, triggers, derivatives, and unknown update fields', () => {
        const cases = [
            { field: 'filters', message: 'filters, triggers, and derivatives are preserved' },
            { field: 'triggers', message: 'filters, triggers, and derivatives are preserved' },
            { field: 'derivative', message: 'filters, triggers, and derivatives are preserved' },
            { field: 'meshId', message: 'not an editable tally field' }
        ];

        for (const testCase of cases) {
            const errors = validateTallyActions(buildTallies(), [{ action: 'update', tallyId: 1, updates: { [testCase.field]: [] } }]);
            expect(errors.join(' ')).toContain(testCase.message);
        }
    });

    it('rejects a caller-supplied id and out-of-scope add fields', () => {
        expect(validateTallyActions(buildTallies(), [{ action: 'add', tally: { id: 9, scores: ['flux'] } }]).join(' ')).toContain(
            'cannot set an id'
        );
        expect(validateTallyActions(buildTallies(), [{ action: 'add', tally: { scores: ['flux'], triggers: [] } }]).join(' ')).toContain(
            'triggers and derivatives are out of scope'
        );
        expect(validateTallyActions(buildTallies(), [{ action: 'add', tally: { scores: ['flux'], sparse: true } }]).join(' ')).toContain(
            'not a supported tally field'
        );
    });
});

describe('OpenMC tally preview', () => {
    it('diffs update, add, and remove actions without mutating the input', () => {
        const tallies = buildTallies();
        const original = cloneTallies(tallies);

        const preview = previewTallyActions(
            tallies,
            [
                { action: 'update', tallyId: 1, updates: { scores: ['flux', 'heating'], estimator: 'analog' } },
                {
                    action: 'add',
                    tally: {
                        name: 'fission-rate',
                        scores: ['fission'],
                        filters: [{ type: 'cellinstance', bins: [1, 0], pairs: [{ first: 1, second: 0 }] }]
                    }
                },
                { action: 'remove', tallyId: 4 }
            ],
            5
        );

        expect(preview.addedIds).toEqual([5]);
        expect(preview.changes.map((change) => [change.path, change.kind])).toEqual([
            ['tallies.1.scores', 'update'],
            ['tallies.1.estimator', 'update'],
            ['tallies.5', 'add'],
            ['tallies.4', 'remove']
        ]);
        expect(preview.changes[0]).toMatchObject({ before: ['flux'], after: ['flux', 'heating'] });
        expect(preview.changes[3]).toMatchObject({ before: original[1] });
        expect(preview.after.map((tally) => tally.id)).toEqual([1, 5]);
        expect(preview.after[0]).toMatchObject({
            scores: ['flux', 'heating'],
            estimator: 'analog',
            filters: [{ type: 'cell', bins: [1, 2] }],
            triggers: [{ type: 'rel_err', threshold: 0.05 }],
            derivative: { id: 7, variable: 'density', materialId: 1 }
        });
        expect(preview.after[1]).toEqual({
            id: 5,
            name: 'fission-rate',
            scores: ['fission'],
            nuclides: ['total'],
            filters: [{ type: 'cellinstance', bins: [1, 0], pairs: [{ first: 1, second: 0 }] }]
        });
        expect(tallies).toEqual(original);
    });

    it('assigns sequential ids and add defaults', () => {
        const preview = previewTallyActions(
            buildTallies(),
            [
                { action: 'add', tally: { scores: ['flux'] } },
                { action: 'add', tally: { scores: ['heating'], higherMoments: true } }
            ],
            5
        );

        expect(preview.addedIds).toEqual([5, 6]);
        expect(preview.after.slice(2)).toEqual([
            { id: 5, scores: ['flux'], nuclides: ['total'], filters: [] },
            { id: 6, scores: ['heating'], nuclides: ['total'], filters: [], higherMoments: true }
        ]);
    });

    it('only emits changed update fields', () => {
        const preview = previewTallyActions(buildTallies(), [
            { action: 'update', tallyId: 1, updates: { scores: ['flux'], estimator: 'analog' } }
        ]);

        expect(preview.changes).toEqual([
            {
                path: 'tallies.1.estimator',
                label: 'Tally 1 (flux-cube) estimator',
                kind: 'update',
                before: 'tracklength',
                after: 'analog'
            }
        ]);
    });

    it('throws on invalid actions', () => {
        expect(() => previewTallyActions(buildTallies(), [{ action: 'update', tallyId: 1, updates: { scores: ['nope'] } }])).toThrow(
            /not an OpenMC catalog score/
        );
    });
});

describe('OpenMC tally helpers', () => {
    it('clones tallies so edits stay detached', () => {
        const tallies = buildTallies();
        const clone = cloneTallies(tallies);
        clone[0].scores.push('heating');
        clone[0].filters[0].bins.push(3);

        expect(tallies[0].scores).toEqual(['flux']);
        expect(tallies[0].filters[0].bins).toEqual([1, 2]);
    });

    it('compares values independent of key order and undefined keys', () => {
        expect(tallyEquals({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
        expect(tallyEquals({ a: 1 }, { a: 1, b: undefined })).toBe(true);
        expect(tallyEquals({ a: 1 }, { a: 2 })).toBe(false);
        expect(tallyEquals([1, 2], [1, 2, 3])).toBe(false);
        expect(tallyEquals(undefined, undefined)).toBe(true);
    });

    it('reads editable tally values and treats a missing tally as undefined', () => {
        const tallies = buildTallies();

        expect(tallyValue(tallies[0], 'name')).toBe('flux-cube');
        expect(tallyValue(tallies[0], 'scores')).toEqual(['flux']);
        expect(tallyValue(undefined, 'scores')).toBeUndefined();
    });
});
