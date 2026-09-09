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
    DAGMC_OUTLINE_WIDGET_IDS,
    dagmcOutlineVolumeMatches,
    describeDagmcOutlineCounts,
    formatDagmcOutlineVolumeLabel,
    isDagmcOutlineWidgetId,
    matchesDagmcOutlineQuery,
    resolveDagmcOutlineTargetId
} from './dagmc-outline-model';
import { parseDagmcModelInfo } from '../plugins/openmc/widgets/dagmc/dagmc-toggle-model';

describe('dagmc-outline-model binding', () => {
    it('matches every bound viewer base id', () => {
        for (const id of DAGMC_OUTLINE_WIDGET_IDS) {
            expect(isDagmcOutlineWidgetId(id)).toBe(true);
        }
    });

    it('matches per-file instance ids carrying a path suffix', () => {
        expect(isDagmcOutlineWidgetId('dagmc-viewer-widget:/tmp/native-volumes.vtm')).toBe(true);
    });

    it('rejects other viewers and near-miss prefixes', () => {
        expect(isDagmcOutlineWidgetId('native-vtk-viewer-widget:/tmp/native-polydata.vtp')).toBe(false);
        expect(isDagmcOutlineWidgetId('nuke-visualizer-dagmc-outline-widget')).toBe(false);
        expect(isDagmcOutlineWidgetId('dagmc-viewer-widget-extra')).toBe(false);
        expect(isDagmcOutlineWidgetId('')).toBe(false);
    });

    it('prefers the active tab over the current tab', () => {
        expect(resolveDagmcOutlineTargetId('dagmc-viewer-widget:/tmp/a.vtm', 'dagmc-viewer-widget:/tmp/b.vtm')).toBe(
            'dagmc-viewer-widget:/tmp/a.vtm'
        );
    });

    it('falls back to the current tab when the active tab is not a DAGMC viewer', () => {
        expect(resolveDagmcOutlineTargetId('code-editor-widget', 'dagmc-viewer-widget:/tmp/b.vtm')).toBe('dagmc-viewer-widget:/tmp/b.vtm');
    });

    it('resolves to nothing when no tab is a DAGMC viewer', () => {
        expect(resolveDagmcOutlineTargetId('native-vtk-viewer-widget:/tmp/a.vtp', 'explorer-widget')).toBe(undefined);
        expect(resolveDagmcOutlineTargetId(undefined, undefined)).toBe(undefined);
    });
});

describe('dagmc-outline-model main-area fallback', () => {
    it('binds the main-area viewer when focus sits in the panel itself', () => {
        expect(
            resolveDagmcOutlineTargetId(
                'nuke-visualizer-dagmc-outline-widget',
                'nuke-visualizer-dagmc-outline-widget',
                'dagmc-viewer-widget:/data/fuel_pin_volumes.vtm'
            )
        ).toBe('dagmc-viewer-widget:/data/fuel_pin_volumes.vtm');
    });

    it('binds the active viewer when two DAGMC viewers are open', () => {
        expect(resolveDagmcOutlineTargetId('dagmc-viewer-widget:/data/fuel_pin_volumes.vtm', 'dagmc-viewer-widget')).toBe(
            'dagmc-viewer-widget:/data/fuel_pin_volumes.vtm'
        );
    });

    it('binds a realistic per-file instance id', () => {
        expect(isDagmcOutlineWidgetId('dagmc-viewer-widget:/data/fuel_pin_volumes.vtm')).toBe(true);
    });

    it('prefers active, then current, then the main-area tab', () => {
        expect(
            resolveDagmcOutlineTargetId(
                'dagmc-viewer-widget:/data/other.vtm',
                'dagmc-viewer-widget:/data/fuel_pin_volumes.vtm',
                'dagmc-viewer-widget:/data/third.vtm'
            )
        ).toBe('dagmc-viewer-widget:/data/other.vtm');
        expect(
            resolveDagmcOutlineTargetId(
                'code-editor-widget',
                'dagmc-viewer-widget:/data/fuel_pin_volumes.vtm',
                'dagmc-viewer-widget:/data/third.vtm'
            )
        ).toBe('dagmc-viewer-widget:/data/fuel_pin_volumes.vtm');
    });

    it('resolves to nothing when no candidate is a DAGMC viewer', () => {
        expect(resolveDagmcOutlineTargetId('code-editor-widget', 'explorer-widget', 'terminal-widget')).toBe(undefined);
        expect(resolveDagmcOutlineTargetId(undefined, undefined, undefined)).toBe(undefined);
    });
});

describe('dagmc-outline-model search filter', () => {
    it('matches case-insensitively and blank queries match everything', () => {
        expect(matchesDagmcOutlineQuery('Volume 12', 'volume 12')).toBe(true);
        expect(matchesDagmcOutlineQuery('Volume 12', 'VOLUME')).toBe(true);
        expect(matchesDagmcOutlineQuery('Volume 12', '  ')).toBe(true);
        expect(matchesDagmcOutlineQuery('Volume 12', '')).toBe(true);
        expect(matchesDagmcOutlineQuery('Volume 12', 'clad')).toBe(false);
    });

    it('searches volume labels, materials, and groups', () => {
        const entry = { id: 2, label: 'Volume 2', material: 'clad', groups: ['blanket'], visible: true, selected: false };
        expect(dagmcOutlineVolumeMatches(entry, 'volume 2')).toBe(true);
        expect(dagmcOutlineVolumeMatches(entry, 'CLAD')).toBe(true);
        expect(dagmcOutlineVolumeMatches(entry, 'blanket')).toBe(true);
        expect(dagmcOutlineVolumeMatches(entry, 'fuel')).toBe(false);
    });

    it('matches material-less block rows by label only', () => {
        const entry = { id: 1, label: 'Volume 1', material: undefined, groups: [], visible: true, selected: false };
        expect(dagmcOutlineVolumeMatches(entry, 'volume')).toBe(true);
        expect(dagmcOutlineVolumeMatches(entry, 'graveyard')).toBe(false);
    });
});

describe('dagmc-outline-model volume labels', () => {
    it('shows the human name once with no material repetition', () => {
        expect(formatDagmcOutlineVolumeLabel(1)).toBe('Volume 1');
        expect(formatDagmcOutlineVolumeLabel(22)).toBe('Volume 22');
    });
});

describe('dagmc-outline-model status line', () => {
    it('reports counts with model info', () => {
        const info = parseDagmcModelInfo({
            volumes: [{ id: 1, material: 'fuel', numTriangles: 10, numSurfaces: 1, boundingBox: null }],
            materials: { fuel: { volumeCount: 1, volumeIds: [1] } },
            groups: { core: { volumeCount: 1, volumeIds: [1] } }
        });
        expect(describeDagmcOutlineCounts(info, 2, 1)).toBe('1 of 2 volumes (1 materials, 1 groups)');
    });

    it('reports block counts without model info', () => {
        expect(describeDagmcOutlineCounts(undefined, 2, 2)).toBe('2 of 2 volumes (no model info)');
    });
});
