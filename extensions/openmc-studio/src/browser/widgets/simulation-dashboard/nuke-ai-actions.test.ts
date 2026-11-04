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
import type { Command } from '@theia/core/lib/common/command';
import type { NukeContextAction, NukeContextActionScope } from 'nuke-core/lib/common/nuke-context-action-protocol';
import { buildOpenMcNukeAiGroups } from './nuke-ai-actions';

const action = (scope: NukeContextActionScope, label: string, commandId: string): NukeContextAction => ({
    id: `nuke-ai.${scope}.${commandId}`,
    scope,
    label,
    commandId
});

const validationActions: NukeContextAction[] = [
    action('openmc.validation', 'Diagnose Project', 'nuke.ai.diagnoseOpenMc'),
    action('openmc.validation', 'Validate and Explain', 'nuke.ai.validateOpenMc')
];

const runActions: NukeContextAction[] = [
    action('openmc.run', 'Diagnose Run', 'nuke.ai.diagnoseRun'),
    action('openmc.run', 'Explain Run', 'nuke.ai.explainRun')
];

function fakeRegistry(actions: readonly NukeContextAction[]): {
    getActions: (scope: NukeContextActionScope) => readonly NukeContextAction[];
} {
    return { getActions: (scope) => actions.filter((entry) => entry.scope === scope) };
}

function fakeCommands(available: readonly string[]): { getCommand: (id: string) => Command | undefined } {
    return {
        getCommand: vi.fn((id: string) => (available.includes(id) ? ({ id } as Command) : undefined))
    };
}

describe('buildOpenMcNukeAiGroups', () => {
    it('builds validation and run groups from their scopes', () => {
        const groups = buildOpenMcNukeAiGroups(
            fakeRegistry([...validationActions, ...runActions]),
            fakeCommands(['nuke.ai.diagnoseOpenMc', 'nuke.ai.validateOpenMc', 'nuke.ai.diagnoseRun', 'nuke.ai.explainRun'])
        );

        expect(groups.map((group) => group.scope)).toEqual(['openmc.validation', 'openmc.run']);
        expect(groups.map((group) => group.label)).toEqual(['NukeAI · Validation', 'NukeAI · Run']);
        expect(groups[0].actions.map((entry) => entry.commandId)).toEqual(['nuke.ai.diagnoseOpenMc', 'nuke.ai.validateOpenMc']);
        expect(groups[1].actions.map((entry) => entry.commandId)).toEqual(['nuke.ai.diagnoseRun', 'nuke.ai.explainRun']);
    });

    it('omits groups and actions whose command is missing', () => {
        const groups = buildOpenMcNukeAiGroups(
            fakeRegistry([...validationActions, ...runActions]),
            fakeCommands(['nuke.ai.validateOpenMc'])
        );

        expect(groups).toHaveLength(1);
        expect(groups[0].scope).toBe('openmc.validation');
        expect(groups[0].actions.map((entry) => entry.commandId)).toEqual(['nuke.ai.validateOpenMc']);
    });

    it('returns no groups when the registry is empty or every command is missing', () => {
        expect(buildOpenMcNukeAiGroups(fakeRegistry([]), fakeCommands([]))).toEqual([]);
        expect(buildOpenMcNukeAiGroups(fakeRegistry([...validationActions, ...runActions]), fakeCommands([]))).toEqual([]);
    });
});
