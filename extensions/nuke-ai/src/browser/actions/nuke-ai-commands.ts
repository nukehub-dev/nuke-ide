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

/**
 * NukeAI Commands
 *
 * Registers the read-only contextual actions available from the command palette
 * and the Nuke Tools sidebar. Each prompt names the sanitized tool it needs and
 * explicitly forbids writes or execution.
 *
 * @module nuke-ai/browser/actions
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { NUKE_DIAGNOSTICS_AGENT_ID } from '../agent/nuke-diagnostics-agent';
import { NukeAiActionService } from './nuke-ai-action-service';

/** Contextual commands owned by NukeAI. */
export const NukeAiCommands = {
    ASK: {
        id: 'nuke.ai.ask',
        label: 'NukeAI: Ask About Active Context',
        category: 'NukeAI'
    } as Command,
    ATTACH_CONTEXT: {
        id: 'nuke.ai.attachContext',
        label: 'NukeAI: Attach Active Context',
        category: 'NukeAI'
    } as Command,
    CHECK_CAD: {
        id: 'nuke.ai.checkCad',
        label: 'NukeAI: Check Active CAD Model',
        category: 'NukeAI'
    } as Command,
    DIAGNOSE_CAD: {
        id: 'nuke.ai.diagnoseCad',
        label: 'NukeAI: Diagnose Active CAD Model',
        category: 'NukeAI'
    } as Command,
    EXPLAIN_SELECTION: {
        id: 'nuke.ai.explainSelection',
        label: 'NukeAI: Explain CAD Selection',
        category: 'NukeAI'
    } as Command,
    VALIDATE_OPENMC: {
        id: 'nuke.ai.validateOpenMc',
        label: 'NukeAI: Validate OpenMC Project',
        category: 'NukeAI'
    } as Command,
    DIAGNOSE_OPENMC: {
        id: 'nuke.ai.diagnoseOpenMc',
        label: 'NukeAI: Diagnose OpenMC Project',
        category: 'NukeAI'
    } as Command,
    EXPLAIN_RUN: {
        id: 'nuke.ai.explainRun',
        label: 'NukeAI: Explain OpenMC Run',
        category: 'NukeAI'
    } as Command,
    DIAGNOSE_RUN: {
        id: 'nuke.ai.diagnoseRun',
        label: 'NukeAI: Diagnose OpenMC Run',
        category: 'NukeAI'
    } as Command,
    EXPLAIN_STATEPOINT: {
        id: 'nuke.ai.explainStatepoint',
        label: 'NukeAI: Explain Active Statepoint',
        category: 'NukeAI'
    } as Command,
    DIAGNOSE_STATEPOINT: {
        id: 'nuke.ai.diagnoseStatepoint',
        label: 'NukeAI: Diagnose Active Statepoint',
        category: 'NukeAI'
    } as Command,
    PREVIEW_SETTINGS: {
        id: 'nuke.ai.previewSettings',
        label: 'NukeAI: Review OpenMC Settings',
        category: 'NukeAI'
    } as Command,
    REFRESH_RUN: {
        id: 'nuke.ai.refreshRun',
        label: 'NukeAI: Refresh Active Run Status',
        category: 'NukeAI'
    } as Command,
    CAPTURE_VIEW: {
        id: 'nuke.ai.captureView',
        label: 'NukeAI: Capture DAGMC View',
        category: 'NukeAI'
    } as Command
};

/** Prompt and display text for one NukeAI action. */
export interface NukeAiActionDefinition {
    command: Command;
    /** Short request label shown in the chat transcript. */
    displayText: string;
    /** Read-only prompt; undefined for the context-chip action. */
    prompt?: string;
    /** Chat agent that owns the request; defaults to NukeAI when omitted. */
    agentId?: string;
}

/** Read-only prompts shown in the chat for each contextual action. */
export const NukeAiPrompts = {
    ASK: [
        'Using the attached active context, summarize what the user can do next with the active CAD document,',
        'OpenMC project, and dataset. Prefer the read-only capability tools for live details. This is a read-only',
        'request: do not write files, export DAGMC, import geometry, open viewers, or start, stop, or cancel runs.'
    ].join(' '),
    CHECK_CAD: [
        'Call nuke_cad_summarizeDocument for the active CAD document and report the build status, solid, face, and',
        'triangle counts, current selection, warnings, and sensible next steps. This is read-only: do not rebuild,',
        'export, or modify the document.'
    ].join(' '),
    DIAGNOSE_CAD: [
        'Call nuke_cad_diagnoseModel for the active CAD document. Report every error, warning, and info finding with',
        'its code, message, and suggestion, cite the document path and counts as evidence, and give at most three safe',
        'next steps. This is read-only: do not rebuild, export, or modify the document, and do not invent findings.'
    ].join(' '),
    EXPLAIN_SELECTION: [
        'Call nuke_cad_summarizeDocument and nuke_cad_inspectSelection for the active CAD document, then explain the',
        'selected solid or solids, their counts, and what is hidden. This is read-only: do not change the selection',
        'or modify the document.'
    ].join(' '),
    VALIDATE_OPENMC: [
        'Call nuke_openmc_validateProject for the active OpenMC project, group the reported issues by severity, and',
        'suggest concrete fixes. This is read-only: do not edit the project, import geometry, or start a run.'
    ].join(' '),
    DIAGNOSE_OPENMC: [
        'Call nuke_openmc_diagnoseProject for the active OpenMC project. Group the error, warning, and info findings',
        'by severity, cite the project path, environment readiness, and cross-section state as evidence, and give at',
        'most three safe next steps. This is read-only: do not edit the project, import geometry, or start a run, and',
        'do not invent findings.'
    ].join(' '),
    EXPLAIN_RUN: [
        'Call nuke_openmc_getRunStatus for the active OpenMC run, summarize its state, working directory, and recent',
        'log tail, and explain what the status means. This is read-only: do not start, cancel, or restart the run.'
    ].join(' '),
    DIAGNOSE_RUN: [
        'Call nuke_openmc_diagnoseRun for the active OpenMC run. Report the run state and every error and warning',
        'finding with its evidence from the log tail, then give at most three safe next steps. If more than one run',
        'is active, ask which working directory to diagnose instead of guessing. This is read-only: do not start,',
        'cancel, restart, or modify the run.'
    ].join(' '),
    EXPLAIN_STATEPOINT: [
        'Call nuke_viz_summarizeStatepoint for the active dataset and explain k-effective, batches, tallies, and',
        'uncertainty in plain language. This is read-only: do not open, overwrite, or delete files.'
    ].join(' '),
    DIAGNOSE_STATEPOINT: [
        'Call nuke_viz_diagnoseStatepoint for the loaded statepoint. Report k-effective uncertainty, batch and',
        'generation counts, tally coverage, and every error, warning, and info finding with its evidence, then give',
        'at most three safe next steps. Note that this diagnoses statepoint metadata, not raw tally values or per-bin',
        'uncertainties. This is read-only: do not open, overwrite, or delete files.'
    ].join(' '),
    PREVIEW_SETTINGS: [
        'Call nuke_openmc_summarizeProject for the active OpenMC project and review its current run settings. Call',
        'nuke_openmc_previewSettings only when the user supplies a concrete proposed change, show the before/after',
        'diff, and ask for confirmation before anything is applied. This is read-only until the user confirms: do not',
        'apply settings, edit files, or start a run.'
    ].join(' '),
    REFRESH_RUN: [
        'Call nuke_openmc_getRunStatus for the active OpenMC run and summarize the current state, working directory,',
        'and recent log tail. Explain what the status means and name the next safe check. This is read-only: do not',
        'start, cancel, or restart the run.'
    ].join(' '),
    CAPTURE_VIEW: [
        'Call nuke_viz_captureView for the active DAGMC viewport, then describe what the preview shows and its',
        'limitations. This is read-only: do not change the camera, open files, or write or modify any other files.'
    ].join(' ')
};

/** NukeAI sidebar actions in display order, with their chat prompts. */
export const NUKE_AI_ACTIONS: readonly NukeAiActionDefinition[] = [
    { command: NukeAiCommands.ASK, displayText: 'Ask About Active Context', prompt: NukeAiPrompts.ASK },
    { command: NukeAiCommands.ATTACH_CONTEXT, displayText: 'Attach Active Context' },
    { command: NukeAiCommands.CHECK_CAD, displayText: 'Check Active CAD Model', prompt: NukeAiPrompts.CHECK_CAD },
    { command: NukeAiCommands.EXPLAIN_SELECTION, displayText: 'Explain CAD Selection', prompt: NukeAiPrompts.EXPLAIN_SELECTION },
    { command: NukeAiCommands.VALIDATE_OPENMC, displayText: 'Validate OpenMC Project', prompt: NukeAiPrompts.VALIDATE_OPENMC },
    { command: NukeAiCommands.EXPLAIN_RUN, displayText: 'Explain OpenMC Run', prompt: NukeAiPrompts.EXPLAIN_RUN },
    { command: NukeAiCommands.EXPLAIN_STATEPOINT, displayText: 'Explain Active Statepoint', prompt: NukeAiPrompts.EXPLAIN_STATEPOINT },
    { command: NukeAiCommands.REFRESH_RUN, displayText: 'Refresh Run Status', prompt: NukeAiPrompts.REFRESH_RUN },
    { command: NukeAiCommands.CAPTURE_VIEW, displayText: 'Capture DAGMC View', prompt: NukeAiPrompts.CAPTURE_VIEW },
    {
        command: NukeAiCommands.DIAGNOSE_CAD,
        displayText: 'Diagnose Active CAD Model',
        prompt: NukeAiPrompts.DIAGNOSE_CAD,
        agentId: NUKE_DIAGNOSTICS_AGENT_ID
    },
    {
        command: NukeAiCommands.DIAGNOSE_OPENMC,
        displayText: 'Diagnose OpenMC Project',
        prompt: NukeAiPrompts.DIAGNOSE_OPENMC,
        agentId: NUKE_DIAGNOSTICS_AGENT_ID
    },
    {
        command: NukeAiCommands.DIAGNOSE_RUN,
        displayText: 'Diagnose OpenMC Run',
        prompt: NukeAiPrompts.DIAGNOSE_RUN,
        agentId: NUKE_DIAGNOSTICS_AGENT_ID
    },
    {
        command: NukeAiCommands.DIAGNOSE_STATEPOINT,
        displayText: 'Diagnose Active Statepoint',
        prompt: NukeAiPrompts.DIAGNOSE_STATEPOINT,
        agentId: NUKE_DIAGNOSTICS_AGENT_ID
    }
];

/** Register the NukeAI contextual commands. */
@injectable()
export class NukeAiCommandContribution implements CommandContribution {
    constructor(@inject(NukeAiActionService) protected readonly actions: NukeAiActionService) {}

    registerCommands(commands: CommandRegistry): void {
        for (const action of NUKE_AI_ACTIONS) {
            const prompt = action.prompt;
            if (prompt === undefined) {
                commands.registerCommand(action.command, { execute: () => this.actions.attachContext() });
            } else if (action.agentId === undefined) {
                commands.registerCommand(action.command, { execute: () => this.actions.ask(prompt, action.displayText) });
            } else {
                const agentId = action.agentId;
                commands.registerCommand(action.command, { execute: () => this.actions.ask(prompt, action.displayText, agentId) });
            }
        }
        commands.registerCommand(NukeAiCommands.PREVIEW_SETTINGS, {
            execute: () => this.actions.ask(NukeAiPrompts.PREVIEW_SETTINGS, 'Review OpenMC Settings')
        });
    }
}
