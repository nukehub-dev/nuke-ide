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

import { describe, expect, it, vi } from 'vitest';

vi.mock('@theia/core/lib/common/preferences', () => ({ PreferenceService: Symbol('PreferenceService') }));

import { Emitter } from '@theia/core/lib/common/event';
import type { PreferenceService } from '@theia/core/lib/common/preferences';
import { NukeCadAuthoringContextContribution } from './nuke-cad-authoring-context';

function createPreferences(): { preferences: PreferenceService; fire: (name: string) => void } {
    const emitter = new Emitter<{ preferenceName: string }>();
    return {
        preferences: {
            onPreferenceChanged: emitter.event
        } as unknown as PreferenceService,
        fire: (name: string) => emitter.fire({ preferenceName: name })
    };
}

describe('NukeCadAuthoringContextContribution', () => {
    it('emits a context change when either authoring switch changes', () => {
        const { preferences, fire } = createPreferences();
        const contribution = new NukeCadAuthoringContextContribution(preferences);
        const listener = vi.fn();

        contribution.onDidChangeContext(listener);

        fire('nukeCad.rebuildOnEdit');
        expect(listener).not.toHaveBeenCalled();

        fire('nukeCad.aiAuthoringEnabled');
        expect(listener).toHaveBeenCalledTimes(1);

        fire('nukeCad.scriptAuthoringEnabled');
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('returns no ambient fields of its own', () => {
        const { preferences } = createPreferences();
        const contribution = new NukeCadAuthoringContextContribution(preferences);
        expect(contribution.getContext()).toEqual({});
    });
});
