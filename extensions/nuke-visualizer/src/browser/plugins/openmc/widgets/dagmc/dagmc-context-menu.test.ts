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
import { VIEWER_SHADING_MODES } from '../../../../viewer-core/shading-mode';
import { buildDagmcContextMenuItems } from './dagmc-context-menu';

describe('buildDagmcContextMenuItems', () => {
    it('keeps the shared view actions and inserts the volume group before shading', () => {
        const items = buildDagmcContextMenuItems({
            shading: 'shaded',
            clipChecked: false,
            selectedVolumeId: 7,
            hasHiddenVolumes: false
        });

        expect(items.map((item) => item.id)).toEqual([
            'fit',
            'screenshot',
            'clip',
            'hide-volume',
            'isolate-volume',
            'show-all-volumes',
            ...VIEWER_SHADING_MODES.map((mode) => `shading:${mode.id}`)
        ]);
    });

    it('labels the selected volume and enables hide/isolate', () => {
        const items = buildDagmcContextMenuItems({
            shading: 'shaded',
            clipChecked: false,
            selectedVolumeId: 12,
            hasHiddenVolumes: false
        });
        const hide = items.find((item) => item.id === 'hide-volume');
        const isolate = items.find((item) => item.id === 'isolate-volume');

        expect(hide?.label).toBe('Hide Volume 12');
        expect(hide?.disabled).toBe(false);
        expect(isolate?.label).toBe('Isolate Volume 12');
        expect(isolate?.disabled).toBe(false);
    });

    it('disables selection actions without a selected volume', () => {
        const items = buildDagmcContextMenuItems({
            shading: 'shaded',
            clipChecked: false,
            selectedVolumeId: null,
            hasHiddenVolumes: true
        });

        expect(items.find((item) => item.id === 'hide-volume')).toMatchObject({ label: 'Hide Volume', disabled: true });
        expect(items.find((item) => item.id === 'isolate-volume')).toMatchObject({ label: 'Isolate Volume', disabled: true });
        expect(items.find((item) => item.id === 'show-all-volumes')?.disabled).toBe(false);
    });

    it('disables Show All Volumes when nothing is hidden', () => {
        const items = buildDagmcContextMenuItems({
            shading: 'wireframe',
            clipChecked: true,
            selectedVolumeId: null,
            hasHiddenVolumes: false
        });

        expect(items.find((item) => item.id === 'show-all-volumes')?.disabled).toBe(true);
        expect(items.find((item) => item.id === 'show-all-volumes')?.separatorAbove).toBeFalsy();
        expect(items.find((item) => item.id === 'hide-volume')?.separatorAbove).toBe(true);
    });
});
