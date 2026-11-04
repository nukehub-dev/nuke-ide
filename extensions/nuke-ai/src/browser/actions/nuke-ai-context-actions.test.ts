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
import type {
    NukeContextAction,
    NukeContextActionRegistry,
    NukeContextActionScope
} from 'nuke-core/lib/common/nuke-context-action-protocol';
import { NukeAiCommands } from './nuke-ai-commands';
import { NUKE_AI_CONTEXT_ACTIONS, NukeAiContextActionContribution } from './nuke-ai-context-actions';

class FakeContextActionRegistry {
    readonly actions: NukeContextAction[] = [];

    register(action: NukeContextAction): void {
        this.actions.push(action);
    }

    getActions(scope: NukeContextActionScope): readonly NukeContextAction[] {
        return this.actions.filter((action) => action.scope === scope);
    }
}

function registeredActions(): NukeContextAction[] {
    const registry = new FakeContextActionRegistry();
    new NukeAiContextActionContribution().registerContextActions(registry as unknown as NukeContextActionRegistry);
    return registry.actions;
}

function labelsFor(scope: NukeContextActionScope): string[] {
    return registeredActions()
        .filter((action) => action.scope === scope)
        .map((action) => action.label);
}

describe('NukeAiContextActionContribution', () => {
    it('registers every action through the neutral registry', () => {
        expect(registeredActions()).toEqual(NUKE_AI_CONTEXT_ACTIONS);
    });

    it('uses unique action ids across every scope', () => {
        const ids = registeredActions().map((action) => action.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('covers the CAD viewport in menu order', () => {
        expect(labelsFor('cad.viewport')).toEqual([
            'Ask About Context',
            'Diagnose CAD Model',
            'Explain Selection',
            'Check Active CAD Model'
        ]);
        expect(
            registeredActions()
                .filter((action) => action.scope === 'cad.viewport')
                .map((action) => action.commandId)
        ).toEqual([
            NukeAiCommands.ASK.id,
            NukeAiCommands.DIAGNOSE_CAD.id,
            NukeAiCommands.EXPLAIN_SELECTION.id,
            NukeAiCommands.CHECK_CAD.id
        ]);
    });

    it('covers OpenMC validation and run scopes', () => {
        expect(labelsFor('openmc.validation')).toEqual([
            'Diagnose Project',
            'Validate and Explain',
            'Diagnose CSG Geometry',
            'Diagnose DAGMC Model'
        ]);
        expect(labelsFor('openmc.run')).toEqual(['Diagnose Run', 'Explain Run']);
        expect(
            registeredActions()
                .filter((action) => action.scope === 'openmc.validation')
                .map((action) => action.commandId)
        ).toEqual([
            NukeAiCommands.DIAGNOSE_OPENMC.id,
            NukeAiCommands.VALIDATE_OPENMC.id,
            NukeAiCommands.DIAGNOSE_CSG.id,
            NukeAiCommands.DIAGNOSE_DAGMC.id
        ]);
        expect(
            registeredActions()
                .filter((action) => action.scope === 'openmc.run')
                .map((action) => action.commandId)
        ).toEqual([NukeAiCommands.DIAGNOSE_RUN.id, NukeAiCommands.EXPLAIN_RUN.id]);
    });

    it('covers the DAGMC and tally visualizer scopes', () => {
        expect(labelsFor('visualizer.dagmc')).toEqual(['Capture View', 'Diagnose Statepoint']);
        expect(labelsFor('visualizer.tally')).toEqual(['Explain Statepoint', 'Diagnose Statepoint']);
        expect(
            registeredActions()
                .filter((action) => action.scope === 'visualizer.dagmc')
                .map((action) => action.commandId)
        ).toEqual([NukeAiCommands.CAPTURE_VIEW.id, NukeAiCommands.DIAGNOSE_STATEPOINT.id]);
        expect(
            registeredActions()
                .filter((action) => action.scope === 'visualizer.tally')
                .map((action) => action.commandId)
        ).toEqual([NukeAiCommands.EXPLAIN_STATEPOINT.id, NukeAiCommands.DIAGNOSE_STATEPOINT.id]);
    });

    it('reuses existing NukeAI command ids only', () => {
        const commandIds = new Set(Object.values(NukeAiCommands).map((command) => command.id));
        for (const action of registeredActions()) {
            expect(commandIds.has(action.commandId)).toBe(true);
            expect(action.description?.trim().length).toBeGreaterThan(0);
            expect(action.group).toBe('nuke-ai');
        }
    });
});
