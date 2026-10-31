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
import { NUKE_DIAGNOSTICS_AGENT_ID, NUKE_DIAGNOSTICS_TOOL_NAMES, NukeDiagnosticsAgent } from './nuke-diagnostics-agent';

const CAPABILITY_IDS = [
    'nuke.cad.diagnoseModel',
    'nuke.openmc.diagnoseProject',
    'nuke.openmc.diagnoseRun',
    'nuke.viz.diagnoseStatepoint',
    'nuke.cad.summarizeDocument',
    'nuke.cad.inspectSelection',
    'nuke.openmc.summarizeProject',
    'nuke.openmc.validateProject',
    'nuke.openmc.getRunStatus',
    'nuke.viz.summarizeStatepoint'
];

const WRITE_TOOL_NAMES = [
    'nuke_cad_exportDagmc',
    'nuke_openmc_applySettings',
    'nuke_openmc_importCad',
    'nuke_openmc_runSimulation',
    'nuke_viz_openStatepoint'
];

function promptTemplate(): string {
    return new NukeDiagnosticsAgent().prompts[0].defaultVariant.template;
}

describe('NukeDiagnosticsAgent', () => {
    it('identifies itself as the Nuke Diagnostics panel agent', () => {
        const agent = new NukeDiagnosticsAgent();

        expect(NUKE_DIAGNOSTICS_AGENT_ID).toBe('NukeDiagnostics');
        expect(agent.id).toBe('NukeDiagnostics');
        expect(agent.name).toBe('Nuke Diagnostics');
        expect(agent.iconClass).toBe('codicon codicon-checklist');
        expect(agent.locations).toEqual([ChatAgentLocation.Panel]);
        expect(agent.tags).toEqual(['nuke', 'diagnostics', 'cad', 'openmc', 'visualizer']);
        expect(agent.languageModelRequirements).toEqual([{ purpose: 'chat' }]);
    });

    it('exposes the nukeContext variable and the diagnostics plus support tools', () => {
        const agent = new NukeDiagnosticsAgent();

        expect(agent.variables).toEqual(['nuke.context']);
        expect(agent.functions).toEqual([...NUKE_DIAGNOSTICS_TOOL_NAMES]);
        expect(agent.functions).toHaveLength(10);
        expect(NUKE_DIAGNOSTICS_TOOL_NAMES).toEqual(
            expect.arrayContaining([
                'nuke_cad_diagnoseModel',
                'nuke_openmc_diagnoseProject',
                'nuke_openmc_diagnoseRun',
                'nuke_viz_diagnoseStatepoint'
            ])
        );
    });

    it('uses the nuke-diagnostics-system prompt and includes the active context', () => {
        const agent = new NukeDiagnosticsAgent();

        expect(agent.prompts).toHaveLength(1);
        expect(agent.prompts[0].id).toBe('nuke-diagnostics-system');
        expect(agent.prompts[0].defaultVariant.id).toBe('nuke-diagnostics-system-default');
        expect(promptTemplate()).toContain('{{nukeContext}}');
    });

    it('references every diagnostic and support tool by its sanitized name', () => {
        const prompt = promptTemplate();

        for (const [index, toolName] of NUKE_DIAGNOSTICS_TOOL_NAMES.entries()) {
            expect(prompt).toContain(toolName);
            expect(prompt).toContain(`~{${toolName}}`);
            expect(prompt).toContain(CAPABILITY_IDS[index]);
        }
        expect(prompt).not.toMatch(/~\{nuke\./);
    });

    it('documents the statepoint metadata limitation', () => {
        const prompt = promptTemplate();

        expect(prompt).toMatch(/does not read raw tally values/i);
        expect(prompt).toMatch(/per-bin\s+uncertainties/i);
    });

    it('keeps the agent strictly read-only and cites evidence', () => {
        const prompt = promptTemplate();

        expect(prompt).toMatch(/strictly read-only/i);
        expect(prompt).toMatch(/Never call a write, execute, or destructive tool/i);
        expect(prompt).toMatch(/Order findings by severity/i);
        expect(prompt).toMatch(/Separate observation from hypothesis/i);
        expect(prompt).toMatch(/at most three safe next steps/i);
        expect(prompt).toMatch(/If a diagnosis tool is unavailable/i);
        expect(prompt).toMatch(/Never invent solid counts/i);
    });

    it('never names a write or execute tool', () => {
        const prompt = promptTemplate();

        for (const toolName of WRITE_TOOL_NAMES) {
            expect(prompt).not.toContain(toolName);
        }
        expect(prompt).not.toContain('nuke_openmc_previewSettings');
        expect(prompt).not.toContain('nuke.openmc.previewSettings');
    });
});
