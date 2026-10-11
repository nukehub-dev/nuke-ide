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

import { describe, expect, it } from 'vitest';
import {
    csgOutlineCellMatches,
    describeCsgOutlineCounts,
    isCsgOutlineWidgetId,
    matchesCsgOutlineQuery,
    resolveCsgOutlineTargetId,
    type CsgOutlineCellEntry
} from './csg-outline-model';

describe('csg-outline-model binding', () => {
    it('matches the bound viewer base ids', () => {
        expect(isCsgOutlineWidgetId('geometry-native-viewer-widget')).toBe(true);
        expect(isCsgOutlineWidgetId('tally-native-viewer-widget')).toBe(true);
    });

    it('matches per-file instance ids carrying a path suffix', () => {
        expect(isCsgOutlineWidgetId('geometry-native-viewer-widget:/ws/model.json')).toBe(true);
        expect(isCsgOutlineWidgetId('tally-native-viewer-widget:mesh:123')).toBe(true);
    });

    it('rejects other viewers and near-miss prefixes', () => {
        expect(isCsgOutlineWidgetId('dagmc-viewer-widget')).toBe(false);
        expect(isCsgOutlineWidgetId('geometry-native-viewer-widget-extra')).toBe(false);
        expect(isCsgOutlineWidgetId('')).toBe(false);
    });

    it('prefers the active tab over the current tab', () => {
        expect(resolveCsgOutlineTargetId('geometry-native-viewer-widget', 'dagmc-viewer-widget')).toBe('geometry-native-viewer-widget');
    });

    it('falls back to the current tab when the active tab is not a geometry viewer', () => {
        expect(resolveCsgOutlineTargetId('explorer', 'geometry-native-viewer-widget')).toBe('geometry-native-viewer-widget');
    });

    it('resolves to nothing when no tab is a geometry viewer', () => {
        expect(resolveCsgOutlineTargetId('explorer', 'editor')).toBeUndefined();
        expect(resolveCsgOutlineTargetId(undefined, undefined, undefined)).toBeUndefined();
    });
});

describe('csg-outline-model main-area fallback', () => {
    it('binds the main-area viewer when focus sits in the panel itself', () => {
        expect(resolveCsgOutlineTargetId('nuke-visualizer-csg-outline-widget', 'explorer', 'geometry-native-viewer-widget')).toBe(
            'geometry-native-viewer-widget'
        );
    });

    it('prefers active, then current, then the main-area tab', () => {
        const main = 'geometry-native-viewer-widget:/ws/model.json';
        expect(resolveCsgOutlineTargetId(main, 'explorer', 'explorer')).toBe(main);
        expect(resolveCsgOutlineTargetId('explorer', main, 'explorer')).toBe(main);
        expect(resolveCsgOutlineTargetId('explorer', 'explorer', main)).toBe(main);
    });
});

describe('csg-outline-model search filter', () => {
    it('matches case-insensitively and blank queries match everything', () => {
        expect(matchesCsgOutlineQuery('Cell 1 fuel', '')).toBe(true);
        expect(matchesCsgOutlineQuery('Cell 1 fuel', '  ')).toBe(true);
        expect(matchesCsgOutlineQuery('Cell 1 fuel', 'FUEL')).toBe(true);
        expect(matchesCsgOutlineQuery('Cell 1 fuel', 'zzz')).toBe(false);
    });

    it('searches cell labels and materials', () => {
        const entry: CsgOutlineCellEntry = { id: 1, label: 'Cell 1 fuel', material: 'fuel', visible: true, selected: false };
        expect(csgOutlineCellMatches(entry, 'fuel')).toBe(true);
        expect(csgOutlineCellMatches(entry, 'cell 1')).toBe(true);
        expect(csgOutlineCellMatches(entry, 'clad')).toBe(false);
    });
});

describe('csg-outline-model status line', () => {
    it('counts visible cells and materials', () => {
        expect(describeCsgOutlineCounts(7, 9, 4)).toBe('7 of 9 cells (4 materials)');
    });
});
