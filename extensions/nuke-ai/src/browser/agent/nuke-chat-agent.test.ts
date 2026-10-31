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
import { ChatAgentLocation } from '@theia/ai-chat/lib/common';
import { NUKE_CAPABILITY_TOOL_NAMES, NUKE_CHAT_AGENT_ID, NukeChatAgent } from './nuke-chat-agent';

const CAPABILITY_IDS = [
    'nuke.cad.summarizeDocument',
    'nuke.cad.inspectSelection',
    'nuke.cad.exportDagmc',
    'nuke.openmc.summarizeProject',
    'nuke.openmc.validateProject',
    'nuke.openmc.importCad',
    'nuke.openmc.runSimulation',
    'nuke.openmc.getRunStatus',
    'nuke.viz.summarizeStatepoint',
    'nuke.viz.openStatepoint',
    'nuke.viz.captureView'
];

function promptTemplate(): string {
    return new NukeChatAgent().prompts[0].defaultVariant.template;
}

describe('NukeChatAgent', () => {
    it('identifies itself as the NukeAI panel agent', () => {
        const agent = new NukeChatAgent();

        expect(NUKE_CHAT_AGENT_ID).toBe('NukeAI');
        expect(agent.id).toBe('NukeAI');
        expect(agent.name).toBe('NukeAI');
        expect(agent.iconClass).toBe('codicon codicon-beaker');
        expect(agent.locations).toEqual([ChatAgentLocation.Panel]);
        expect(agent.tags).toEqual(['nuke', 'nuclear', 'cad', 'openmc', 'visualizer']);
        expect(agent.languageModelRequirements).toEqual([{ purpose: 'chat' }]);
    });

    it('exposes the nukeContext variable and all eleven capability tool names', () => {
        const agent = new NukeChatAgent();

        expect(agent.variables).toEqual(['nuke.context']);
        expect(agent.functions).toEqual([...NUKE_CAPABILITY_TOOL_NAMES]);
        expect(agent.functions).toHaveLength(11);
    });

    it('uses the nuke-system prompt and includes the active context', () => {
        const agent = new NukeChatAgent();

        expect(agent.prompts).toHaveLength(1);
        expect(agent.prompts[0].id).toBe('nuke-system');
        expect(agent.prompts[0].defaultVariant.id).toBe('nuke-system-default');
        expect(promptTemplate()).toContain('{{nukeContext}}');
    });

    it('references every capability tool by its sanitized name', () => {
        const prompt = promptTemplate();

        for (const [index, toolName] of NUKE_CAPABILITY_TOOL_NAMES.entries()) {
            expect(prompt).toContain(toolName);
            expect(prompt).toContain(`~{${toolName}}`);
            expect(prompt).toContain(CAPABILITY_IDS[index]);
        }
        expect(prompt).not.toMatch(/~\{nuke\./);
    });

    it('requires explicit confirmation for write and execute tools', () => {
        const prompt = promptTemplate();

        expect(prompt).toMatch(/Export, import, run, and viewer-opening tools require explicit confirmation/i);
        expect(prompt).toMatch(/Never\s+invent a user confirmation/i);
        expect(prompt).toMatch(/do not write files/i);
    });

    it('stays within a concise prompt budget', () => {
        const lines = promptTemplate().split('\n');

        expect(lines.length).toBeGreaterThanOrEqual(80);
        expect(lines.length).toBeLessThanOrEqual(150);
    });
});
