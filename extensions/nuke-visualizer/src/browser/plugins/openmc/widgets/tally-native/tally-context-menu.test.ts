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
import type { NukeContextAction } from 'nuke-core/lib/common/nuke-context-action-protocol';
import { buildTallyContextActionsMenuItems, tallyContextActionMenuId } from './tally-context-menu';

const actions: readonly NukeContextAction[] = [
    {
        id: 'nuke-ai.visualizer.tally.explainStatepoint',
        scope: 'visualizer.tally',
        label: 'Explain Statepoint',
        commandId: 'nuke.ai.explainStatepoint'
    },
    {
        id: 'nuke-ai.visualizer.tally.diagnoseStatepoint',
        scope: 'visualizer.tally',
        label: 'Diagnose Statepoint',
        commandId: 'nuke.ai.diagnoseStatepoint'
    }
];

describe('buildTallyContextActionsMenuItems', () => {
    it('omits the group without a loaded tally', () => {
        expect(buildTallyContextActionsMenuItems(false, actions)).toEqual([]);
    });

    it('appends one row per action with a leading separator', () => {
        const items = buildTallyContextActionsMenuItems(true, actions);

        expect(items.map((item) => item.id)).toEqual(actions.map((action) => tallyContextActionMenuId(action)));
        expect(items.map((item) => item.label)).toEqual(['Explain Statepoint', 'Diagnose Statepoint']);
        expect(items[0]).toMatchObject({ icon: 'codicon-beaker', separatorAbove: true });
        expect(items[1].separatorAbove).toBeUndefined();
    });

    it('renders no rows when the registry has no tally actions', () => {
        expect(buildTallyContextActionsMenuItems(true, [])).toEqual([]);
    });
});
