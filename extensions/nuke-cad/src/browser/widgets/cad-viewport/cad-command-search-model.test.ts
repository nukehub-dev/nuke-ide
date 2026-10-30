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

import { describe, expect, it } from 'vitest';
import { CAD_COMMAND_SEARCH_MAX_RESULTS, filterCadCommandActions, type CadCommandSearchAction } from './cad-command-search-model';

const action = (id: string, label: string, group: string, shortLabel?: string): CadCommandSearchAction => ({
    id,
    label,
    shortLabel,
    icon: 'codicon-search',
    group,
    onClick: () => undefined
});

const ACTIONS: readonly CadCommandSearchAction[] = [
    action('newDocument', 'New Document', 'Document', 'New'),
    action('fillet', 'Fillet', 'Dress-up'),
    action('chamfer', 'Chamfer', 'Dress-up'),
    action('exportPython', 'Export as Python', 'Document')
];

describe('filterCadCommandActions', () => {
    it('matches label, short label, and group case-insensitively', () => {
        expect(filterCadCommandActions(ACTIONS, 'FILLET').map((item) => item.id)).toEqual(['fillet']);
        expect(filterCadCommandActions(ACTIONS, 'new').map((item) => item.id)).toEqual(['newDocument']);
        expect(filterCadCommandActions(ACTIONS, 'dress').map((item) => item.id)).toEqual(['fillet', 'chamfer']);
        expect(filterCadCommandActions(ACTIONS, 'python').map((item) => item.id)).toEqual(['exportPython']);
    });

    it('returns the first page in ribbon order for a blank query', () => {
        expect(filterCadCommandActions(ACTIONS, '  ').map((item) => item.id)).toEqual(['newDocument', 'fillet', 'chamfer', 'exportPython']);
    });

    it('caps the result row count', () => {
        const many = Array.from({ length: CAD_COMMAND_SEARCH_MAX_RESULTS + 5 }, (_, index) =>
            action(`command-${index}`, `Command ${index}`, 'Document')
        );
        expect(filterCadCommandActions(many, 'command')).toHaveLength(CAD_COMMAND_SEARCH_MAX_RESULTS);
        expect(filterCadCommandActions(many, 'command').at(-1)?.id).toBe(`command-${CAD_COMMAND_SEARCH_MAX_RESULTS - 1}`);
    });

    it('returns nothing when no field contains the query', () => {
        expect(filterCadCommandActions(ACTIONS, 'does-not-exist')).toEqual([]);
    });

    it('preserves disabled reasons on filtered rows so the popover can explain them', () => {
        const pad: CadCommandSearchAction = {
            ...action('pad', 'Pad (extrude add)', 'Additive', 'Pad'),
            disabled: true,
            disabledReason: 'Select a sketch first.'
        };
        const matches = filterCadCommandActions([pad], 'pad');
        expect(matches).toHaveLength(1);
        expect(matches[0].disabled).toBe(true);
        expect(matches[0].disabledReason).toBe('Select a sketch first.');
    });
});
