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

import { describe, it, expect } from 'vitest';
import { NukeToolsItem } from '../../common/nuke-tools-protocol';
import { sortItems, matchesQuery, groupItems } from './nuke-tools-sidebar-model';

function item(overrides: Partial<NukeToolsItem> & { id: string; label: string; commandId: string }): NukeToolsItem {
    return {
        category: ['Category'],
        ...overrides
    };
}

describe('sortItems', () => {
    it('sorts by category path first', () => {
        const items = [
            item({ id: 'b', label: 'B', commandId: 'cmd.b', category: ['Zoo'] }),
            item({ id: 'a', label: 'A', commandId: 'cmd.a', category: ['Aaa'] })
        ];
        sortItems(items);
        expect(items.map((i) => i.label)).toEqual(['A', 'B']);
    });

    it('sorts by order when categories match', () => {
        const items = [
            item({ id: 'b', label: 'B', commandId: 'cmd.b', category: ['Cat'], order: 'b' }),
            item({ id: 'a', label: 'A', commandId: 'cmd.a', category: ['Cat'], order: 'a' })
        ];
        sortItems(items);
        expect(items.map((i) => i.label)).toEqual(['A', 'B']);
    });

    it('falls back to label order when order is unset', () => {
        const items = [
            item({ id: 'b', label: 'B', commandId: 'cmd.b', category: ['Cat'] }),
            item({ id: 'a', label: 'A', commandId: 'cmd.a', category: ['Cat'] })
        ];
        sortItems(items);
        expect(items.map((i) => i.label)).toEqual(['A', 'B']);
    });
});

describe('matchesQuery', () => {
    it('matches label', () => {
        const i = item({ id: 'x', label: 'Install Package', commandId: 'cmd.x', description: 'desc' });
        expect(matchesQuery(i, 'package')).toBe(true);
    });

    it('matches description', () => {
        const i = item({ id: 'x', label: 'X', commandId: 'cmd.x', description: 'Install with pip' });
        expect(matchesQuery(i, 'pip')).toBe(true);
    });

    it('matches keywords', () => {
        const i = item({ id: 'x', label: 'X', commandId: 'cmd.x', keywords: ['conda', 'environment'] });
        expect(matchesQuery(i, 'conda')).toBe(true);
    });

    it('matches category path', () => {
        const i = item({ id: 'x', label: 'X', commandId: 'cmd.x', category: ['OpenMC Studio', 'Geometry'] });
        expect(matchesQuery(i, 'geometry')).toBe(true);
    });

    it('is case-insensitive', () => {
        const i = item({ id: 'x', label: 'Health Check', commandId: 'cmd.x' });
        expect(matchesQuery(i, 'HEALTH')).toBe(true);
    });

    it('returns false for non-matches', () => {
        const i = item({ id: 'x', label: 'Health Check', commandId: 'cmd.x' });
        expect(matchesQuery(i, 'package')).toBe(false);
    });
});

describe('groupItems', () => {
    it('groups by top-level category', () => {
        const items = [
            item({ id: 'env', label: 'Switch', commandId: 'cmd.env', category: ['Environment'] }),
            item({ id: 'health', label: 'Check', commandId: 'cmd.health', category: ['Health'] })
        ];
        const groups = groupItems(items);
        expect(Array.from(groups.keys())).toEqual(['environment', 'health']);
        expect(groups.get('environment')!.items).toHaveLength(1);
        expect(groups.get('health')!.items).toHaveLength(1);
    });

    it('uses "Other" for items without a category', () => {
        const items = [item({ id: 'x', label: 'X', commandId: 'cmd.x', category: [] })];
        const groups = groupItems(items);
        expect(groups.has('other')).toBe(true);
    });

    it('filters by query', () => {
        const items = [
            item({ id: 'a', label: 'Alpha', commandId: 'cmd.a', category: ['Cat'] }),
            item({ id: 'b', label: 'Beta', commandId: 'cmd.b', category: ['Cat'] })
        ];
        const groups = groupItems(items, 'alpha');
        expect(groups.get('cat')!.items.map((i) => i.id)).toEqual(['a']);
    });

    it('returns empty map when nothing matches', () => {
        const items = [item({ id: 'a', label: 'Alpha', commandId: 'cmd.a', category: ['Cat'] })];
        const groups = groupItems(items, 'zzz');
        expect(groups.size).toBe(0);
    });
});
