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
import { MCP_READ_ONLY_CAPABILITY_IDS } from '../../common/nuke-mcp-protocol';
import { NUKE_CAPABILITY_TOOL_NAMES, NUKE_CHAT_AGENT_ID, NukeChatAgent } from './nuke-chat-agent';

const CAPABILITY_IDS = [
    'nuke.cad.summarizeDocument',
    'nuke.cad.inspectSelection',
    'nuke.cad.diagnoseModel',
    'nuke.cad.previewFeatureChange',
    'nuke.cad.applyFeatureChange',
    'nuke.cad.listSketchDimensions',
    'nuke.cad.previewSketchChange',
    'nuke.cad.applySketchChange',
    'nuke.cad.previewTopologyChange',
    'nuke.cad.applyTopologyChange',
    'nuke.cad.inspectImportSource',
    'nuke.cad.previewImportBodies',
    'nuke.cad.applyImportBodies',
    'nuke.cad.summarizeAssembly',
    'nuke.cad.previewAssemblyChange',
    'nuke.cad.applyAssemblyChange',
    'nuke.cad.summarizeDrawing',
    'nuke.cad.previewDrawingChange',
    'nuke.cad.applyDrawingChange',
    'nuke.cad.inspectScriptSource',
    'nuke.cad.previewScriptChange',
    'nuke.cad.applyScriptChange',
    'nuke.cad.exportDagmc',
    'nuke.openmc.summarizeProject',
    'nuke.openmc.validateProject',
    'nuke.openmc.diagnoseProject',
    'nuke.openmc.diagnoseRun',
    'nuke.openmc.previewSettings',
    'nuke.openmc.applySettings',
    'nuke.openmc.previewMaterialChange',
    'nuke.openmc.applyMaterialChange',
    'nuke.openmc.previewTallyChange',
    'nuke.openmc.applyTallyChange',
    'nuke.openmc.importCad',
    'nuke.openmc.runSimulation',
    'nuke.openmc.getRunStatus',
    'nuke.viz.summarizeStatepoint',
    'nuke.viz.diagnoseStatepoint',
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

    it('exposes the nukeContext variable and all forty capability tool names', () => {
        const agent = new NukeChatAgent();

        expect(agent.variables).toEqual(['nuke.context']);
        expect(agent.functions).toEqual([...NUKE_CAPABILITY_TOOL_NAMES]);
        expect(agent.functions).toHaveLength(40);
    });

    it('never exposes the script authoring capabilities through MCP', () => {
        expect(MCP_READ_ONLY_CAPABILITY_IDS as readonly string[]).not.toContain('nuke.cad.inspectScriptSource');
        expect(MCP_READ_ONLY_CAPABILITY_IDS as readonly string[]).not.toContain('nuke.cad.previewScriptChange');
        expect(MCP_READ_ONLY_CAPABILITY_IDS as readonly string[]).not.toContain('nuke.cad.applyScriptChange');
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

    it('requires previews, shown diffs, explicit apply, and undo for settings, materials, tallies, and CAD edits', () => {
        const prompt = promptTemplate();

        expect(prompt).toContain('nuke_openmc_previewSettings');
        expect(prompt).toContain('nuke_openmc_applySettings');
        expect(prompt).toContain('nuke_openmc_previewMaterialChange');
        expect(prompt).toContain('nuke_openmc_applyMaterialChange');
        expect(prompt).toContain('nuke_cad_previewFeatureChange');
        expect(prompt).toContain('nuke_cad_applyFeatureChange');
        expect(prompt).toContain('nuke_openmc_previewTallyChange');
        expect(prompt).toContain('nuke_openmc_applyTallyChange');
        expect(prompt).toMatch(/Preview every change/);
        expect(prompt).toMatch(/Show the diff/);
        expect(prompt).toMatch(/Apply only after explicit confirmation/);
        expect(prompt).toContain('undoToken');
        expect(prompt).toContain('run.particles');
        expect(prompt).toContain('sourceRejectionFraction');
        expect(prompt).toMatch(/filters,\s+triggers, and derivatives are preserved/);
        expect(prompt).toMatch(
            /Applying a\s+previewed settings, material, tally, CAD feature, sketch, topology, import, assembly, or drawing\s+change also requires explicit confirmation/i
        );
    });

    it('covers sketch-dimension discovery, preview, apply, and the parameter cascade', () => {
        const prompt = promptTemplate();

        expect(prompt).toContain('nuke_cad_listSketchDimensions');
        expect(prompt).toContain('nuke_cad_previewSketchChange');
        expect(prompt).toContain('nuke_cad_applySketchChange');
        expect(prompt).toMatch(/nuke_cad_listSketchDimensions`; never guess a sketch, dimension, or parameter/);
        expect(prompt).toMatch(/only existing driving\s+dimensions and document parameters referenced by that sketch are editable/i);
        expect(prompt).toMatch(/A parameter-bound dimension updates every\s+affected sketch and curve/i);
        expect(prompt).toMatch(/Literal driving dimensions change only that sketch/);
        expect(prompt).toMatch(/show that diff and impact before asking to apply/i);
        expect(prompt).toMatch(/New sketch entities, constraints, or dimensions/);
        expect(prompt).toMatch(/document parameters not referenced by a\s+sketch/i);
    });

    it('covers topology-impact preview, region acknowledgement, apply, and blocked OpenMC references', () => {
        const prompt = promptTemplate();

        expect(prompt).toContain('nuke_cad_previewTopologyChange');
        expect(prompt).toContain('nuke_cad_applyTopologyChange');
        expect(prompt).toMatch(/review panel also requires the region\s+acknowledgement/i);
        expect(prompt).toContain('acknowledgeRegionChanges');
        expect(prompt).toMatch(/Topology edits change solid identity or region coverage/i);
        expect(prompt).toMatch(/never claim the edit is safe/i);
        expect(prompt).toMatch(/saved active OpenMC project/i);
        expect(prompt).toMatch(/blocks Apply/i);
        expect(prompt).toMatch(/not checked/i);
        expect(prompt).toMatch(/Apply never rewrites the OpenMC project/i);
        expect(prompt).toMatch(/patternCount.*including the original/i);
        expect(prompt).toMatch(/overlapping pattern may change only faces or volume/i);
        expect(prompt).toMatch(/Booleans, add, delete,\s+reorder, partial or unsandboxed scripts/);
        expect(prompt).not.toMatch(/Booleans, add, delete,\s+reorder, imports/);
        expect(prompt).not.toMatch(/assemblies, scripts/);
    });

    it('covers the user-chosen import source, plan-only preview, stale checks, and apply', () => {
        const prompt = promptTemplate();

        expect(prompt).toContain('nuke_cad_inspectImportSource');
        expect(prompt).toContain('nuke_cad_previewImportBodies');
        expect(prompt).toContain('nuke_cad_applyImportBodies');
        expect(prompt).toContain('## Import CAD as Body');
        expect(prompt).toMatch(/user chooses the STEP\/STP,?\s+IGES\/IGS, or BREP file/i);
        expect(prompt).toMatch(/path is only a hint/i);
        expect(prompt).toMatch(/opens the native picker/i);
        expect(prompt).toContain('`<stem>.parts/`');
        expect(prompt).toMatch(/outside-root,\s+symlink, unsupported-extension, and over-256-MiB sources/i);
        expect(prompt).toContain('strategy: "single" | "perSolid"');
        expect(prompt).toMatch(/plan-only import\s+proposal/i);
        expect(prompt).toMatch(/never builds geometry, shows a ghost, or mutates the document/i);
        expect(prompt).toMatch(/format, size, hash, units, solids, warnings, and material\/label plan/i);
        expect(prompt).toMatch(/not self-contained/i);
        expect(prompt).toMatch(/rejects a stale hash,\s+size, selection, or plan/i);
        expect(prompt).toContain('`addImportBodies`');
        expect(prompt).toMatch(/never downloads or copies the source/i);
        expect(prompt).toMatch(/exposes no import\s+tool through MCP/i);
    });

    it('covers assembly discovery, placement actions, candidate review, conditional acknowledgement, and apply', () => {
        const prompt = promptTemplate();

        expect(prompt).toContain('nuke_cad_summarizeAssembly');
        expect(prompt).toContain('nuke_cad_previewAssemblyChange');
        expect(prompt).toContain('nuke_cad_applyAssemblyChange');
        expect(prompt).toContain('## Assembly placement');
        expect(prompt).toMatch(/existing grounded assembly only/i);
        expect(prompt).toMatch(/one to sixteen `addInstance`, `removeInstance`, or `setPlacement`/);
        expect(prompt).toMatch(/an existing instance part plus a placement/);
        expect(prompt).toMatch(/non-grounded embedded-body instance with no connector or mate/);
        expect(prompt).toMatch(/`setPlacement` sets a placement \(position \+ orientation\) on a grounded or unmated instance/);
        expect(prompt).toMatch(/BOM count delta/);
        expect(prompt).toMatch(/exact overlap warnings/);
        expect(prompt).toMatch(/`overlapCheck: false` disclosure/);
        expect(prompt).toMatch(/Removing the last instance of a labeled embedded body requires region acknowledgement/);
        expect(prompt).toMatch(/saved active OpenMC reference to the removed group or material blocks Apply/);
        expect(prompt).toMatch(/Unsaved projects are not checked/);
        expect(prompt).toMatch(/Repeated body ids make the ghost approximate/);
        expect(prompt).toContain('acknowledgeRegionChanges');
        expect(prompt).toMatch(/one store batch/);
        expect(prompt).toMatch(/undo restores the previous instances in one commit/);
        expect(prompt).toMatch(/never rewrites the OpenMC project/);
        expect(prompt).toMatch(/Mates, connectors, grounding changes, new external sources/);
        expect(prompt).not.toMatch(/assemblies, scripts/);
    });

    it('covers drawing discovery, plan-only preview, sheet/view/dimension actions, refresh, and no rebuild', () => {
        const prompt = promptTemplate();

        expect(prompt).toContain('nuke_cad_summarizeDrawing');
        expect(prompt).toContain('nuke_cad_previewDrawingChange');
        expect(prompt).toContain('nuke_cad_applyDrawingChange');
        expect(prompt).toContain('## Drawing sheet settings');
        expect(prompt).toMatch(/Only existing sheets, views, and dimensions in a saved drawing are editable/i);
        expect(prompt).toMatch(/one to sixteen actions/i);
        expect(prompt).toContain('"action": "setSheetSize"');
        expect(prompt).toContain('"action": "setViewDisplay"');
        expect(prompt).toContain('"action": "setDimensionVisibility"');
        expect(prompt).toMatch(/Preview is plan-only: no geometry build, ghost, or write/i);
        expect(prompt).toMatch(/A3 to A4 is rejected when a view lies outside A4/);
        expect(prompt).toMatch(/views are\s+never moved/);
        expect(prompt).toContain('applyDrawingChanges');
        expect(prompt).toMatch(/never schedules `nuke\.cad\.rebuild`/);
        expect(prompt).toMatch(/Hidden dimensions leave SVG and DXF but stay listed; nothing is deleted/);
        expect(prompt).toMatch(/title block is fixed and read-only/i);
        expect(prompt).toMatch(/Adding or deleting sheets, views, or dimensions, moving a view/);
        expect(prompt).toMatch(/returns an undo token/);
        expect(prompt).toMatch(/Requires explicit confirmation/);
        expect(prompt).not.toMatch(/drawings, scripts/);
        expect(prompt).not.toMatch(/scripts, and drawings/);
    });

    it('covers Python script inspection, sandboxed preview, panel-only apply, and the privacy warning', () => {
        const prompt = promptTemplate();

        expect(prompt).toContain('nuke_cad_inspectScriptSource');
        expect(prompt).toContain('nuke_cad_previewScriptChange');
        expect(prompt).toContain('nuke_cad_applyScriptChange');
        expect(prompt).toContain('## Python script authoring');
        expect(prompt).toMatch(/nukeCad\.scriptAuthoringEnabled/);
        expect(prompt).toMatch(/Linux with bubblewrap/);
        expect(prompt).toMatch(/no network (?:and|or) (?:no )?workspace access/i);
        expect(prompt).toMatch(/script text goes to the configured model provider/i);
        expect(prompt).toMatch(/exact `baseScriptHash` and the full `proposedScript`/);
        expect(prompt).toMatch(/preview card has no Apply action/i);
        expect(prompt).toMatch(/Apply is panel-only/i);
        expect(prompt).toMatch(/never claim you can apply from chat/i);
        expect(prompt).toMatch(/overwrites the file with a hidden backup and undo/i);
        expect(prompt).toMatch(/exports stay blocked while the model is sandboxed/i);
    });

    it('stays within a bounded prompt budget', () => {
        const lines = promptTemplate().split('\n');

        expect(lines.length).toBeGreaterThanOrEqual(80);
        expect(lines.length).toBeLessThanOrEqual(230);
    });
});
