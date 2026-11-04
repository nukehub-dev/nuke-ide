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
import { Command, CommandHandler, CommandRegistry } from '@theia/core/lib/common/command';
import { Disposable } from '@theia/core/lib/common/disposable';
import { NUKE_DIAGNOSTICS_AGENT_ID } from '../agent/nuke-diagnostics-agent';
import type { NukeAiActionService } from './nuke-ai-action-service';
import { NUKE_AI_ACTIONS, NukeAiCommandContribution, NukeAiCommands, NukeAiPrompts } from './nuke-ai-commands';

class FakeCommandRegistry {
    readonly handlers = new Map<string, CommandHandler>();

    registerCommand(command: Command, handler?: CommandHandler): Disposable {
        if (handler) {
            this.handlers.set(command.id, handler);
        }
        return Disposable.NULL;
    }

    execute(commandId: string): Promise<unknown> {
        const handler = this.handlers.get(commandId);
        if (!handler) {
            throw new Error(`Command ${commandId} is not registered.`);
        }
        return Promise.resolve(handler.execute());
    }
}

function createHarness(): {
    registry: FakeCommandRegistry;
    actions: { ask: ReturnType<typeof vi.fn>; attachContext: ReturnType<typeof vi.fn> };
} {
    const actions = { ask: vi.fn(async () => undefined), attachContext: vi.fn(async () => undefined) };
    const registry = new FakeCommandRegistry();
    const contribution = new NukeAiCommandContribution(actions as unknown as NukeAiActionService);
    contribution.registerCommands(registry as unknown as CommandRegistry);
    return { registry, actions };
}

describe('NukeAI commands', () => {
    it('registers every contextual action, the settings review, and the context chip action', () => {
        const { registry } = createHarness();

        expect([...registry.handlers.keys()]).toEqual([
            ...NUKE_AI_ACTIONS.map((action) => action.command.id),
            NukeAiCommands.PREVIEW_SETTINGS.id
        ]);
        expect(registry.handlers.size).toBe(16);
    });

    it('uses unique command ids and the NukeAI category', () => {
        const ids = Object.values(NukeAiCommands).map((command) => command.id);

        expect(new Set(ids).size).toBe(ids.length);
        for (const command of Object.values(NukeAiCommands)) {
            expect(command.category).toBe('NukeAI');
            expect(command.label?.startsWith('NukeAI:')).toBe(true);
        }
    });

    it('calls ask with a non-empty read-only prompt and a short display text for every prompt action', async () => {
        const { registry, actions } = createHarness();

        for (const action of NUKE_AI_ACTIONS) {
            if (action.prompt === undefined) {
                continue;
            }
            await registry.execute(action.command.id);

            expect(actions.ask).toHaveBeenLastCalledWith(action.prompt, action.displayText, action.agentId, action.precondition);
            expect(action.prompt.trim().length).toBeGreaterThan(0);
            expect(action.prompt.toLowerCase()).toContain('read-only');
            expect(action.prompt).not.toContain('~{');
            expect(action.prompt).not.toMatch(/nuke\.(?:cad|openmc|viz)\./);
            expect(action.displayText.startsWith('NukeAI:')).toBe(false);
            expect(action.displayText.length).toBeLessThanOrEqual(30);
        }

        expect(actions.ask).toHaveBeenCalledTimes(14);
        expect(actions.attachContext).not.toHaveBeenCalled();
    });

    it('names the sanitized capability tool in each prompt', () => {
        expect(NukeAiPrompts.CHECK_CAD).toContain('nuke_cad_summarizeDocument');
        expect(NukeAiPrompts.DIAGNOSE_CAD).toContain('nuke_cad_diagnoseModel');
        expect(NukeAiPrompts.EXPLAIN_SELECTION).toContain('nuke_cad_summarizeDocument');
        expect(NukeAiPrompts.EXPLAIN_SELECTION).toContain('nuke_cad_inspectSelection');
        expect(NukeAiPrompts.VALIDATE_OPENMC).toContain('nuke_openmc_validateProject');
        expect(NukeAiPrompts.DIAGNOSE_OPENMC).toContain('nuke_openmc_diagnoseProject');
        expect(NukeAiPrompts.DIAGNOSE_CSG).toContain('nuke_openmc_validateProject');
        expect(NukeAiPrompts.DIAGNOSE_CSG).toContain('nuke_openmc_diagnoseProject');
        expect(NukeAiPrompts.DIAGNOSE_DAGMC).toContain('nuke_openmc_diagnoseProject');
        expect(NukeAiPrompts.EXPLAIN_RUN).toContain('nuke_openmc_getRunStatus');
        expect(NukeAiPrompts.DIAGNOSE_RUN).toContain('nuke_openmc_diagnoseRun');
        expect(NukeAiPrompts.EXPLAIN_STATEPOINT).toContain('nuke_viz_summarizeStatepoint');
        expect(NukeAiPrompts.DIAGNOSE_STATEPOINT).toContain('nuke_viz_diagnoseStatepoint');
        expect(NukeAiPrompts.PREVIEW_SETTINGS).toContain('nuke_openmc_previewSettings');
        expect(NukeAiPrompts.REFRESH_RUN).toContain('nuke_openmc_getRunStatus');
        expect(NukeAiPrompts.CAPTURE_VIEW).toContain('nuke_viz_captureView');
    });

    it('routes the settings review action through the read-only chat flow', async () => {
        const { registry, actions } = createHarness();

        await registry.execute(NukeAiCommands.PREVIEW_SETTINGS.id);

        expect(actions.ask).toHaveBeenCalledWith(
            NukeAiPrompts.PREVIEW_SETTINGS,
            'Review OpenMC Settings',
            undefined,
            expect.objectContaining({ kind: 'context', field: 'activeOpenmcProject' })
        );
        expect(NukeAiPrompts.PREVIEW_SETTINGS.toLowerCase()).toContain('read-only');
    });

    it('routes the four diagnostic actions to the Nuke Diagnostics agent', async () => {
        const { registry, actions } = createHarness();
        const diagnostics = NUKE_AI_ACTIONS.filter((action) => action.agentId === NUKE_DIAGNOSTICS_AGENT_ID);

        expect(diagnostics).toHaveLength(6);
        for (const action of diagnostics) {
            await registry.execute(action.command.id);

            expect(actions.ask).toHaveBeenLastCalledWith(action.prompt, action.displayText, NUKE_DIAGNOSTICS_AGENT_ID, action.precondition);
        }
    });

    it('routes the attach action to attachContext without sending a prompt', async () => {
        const { registry, actions } = createHarness();

        await registry.execute(NukeAiCommands.ATTACH_CONTEXT.id);

        expect(actions.attachContext).toHaveBeenCalledTimes(1);
        expect(actions.ask).not.toHaveBeenCalled();
    });
});
