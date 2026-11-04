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
 * NukeAI Context Actions
 *
 * Publishes the existing read-only NukeAI commands to the neutral context-action
 * registry owned by `nuke-core`. Domain menus render the descriptors; this
 * extension never imports a domain extension and the commands stay owned by
 * {@link NukeAiCommandContribution}.
 *
 * @module nuke-ai/browser/actions
 */

import { injectable } from '@theia/core/shared/inversify';
import {
    NukeContextAction,
    NukeContextActionContribution,
    NukeContextActionRegistry
} from 'nuke-core/lib/common/nuke-context-action-protocol';
import { NukeAiCommands } from './nuke-ai-commands';

/** NukeAI actions contributed to domain menu surfaces, in their menu order. */
export const NUKE_AI_CONTEXT_ACTIONS: readonly NukeContextAction[] = [
    {
        id: 'nuke-ai.cad.viewport.ask',
        scope: 'cad.viewport',
        label: 'Ask About Context',
        description: 'Open a focused NukeAI chat with the active CAD, OpenMC, and dataset context attached.',
        commandId: NukeAiCommands.ASK.id,
        group: 'nuke-ai',
        order: 'a'
    },
    {
        id: 'nuke-ai.cad.viewport.diagnose',
        scope: 'cad.viewport',
        label: 'Diagnose CAD Model',
        description: 'Triage the active CAD model and report severity-coded findings with evidence.',
        commandId: NukeAiCommands.DIAGNOSE_CAD.id,
        group: 'nuke-ai',
        order: 'b'
    },
    {
        id: 'nuke-ai.cad.viewport.explainSelection',
        scope: 'cad.viewport',
        label: 'Explain Selection',
        description: 'Explain the selected solids and any hidden solids in the active CAD document.',
        commandId: NukeAiCommands.EXPLAIN_SELECTION.id,
        group: 'nuke-ai',
        order: 'c'
    },
    {
        id: 'nuke-ai.cad.viewport.checkModel',
        scope: 'cad.viewport',
        label: 'Check Active CAD Model',
        description: 'Summarize the active CAD document: counts, selection, warnings, and next steps.',
        commandId: NukeAiCommands.CHECK_CAD.id,
        group: 'nuke-ai',
        order: 'd'
    },
    {
        id: 'nuke-ai.openmc.validation.diagnoseProject',
        scope: 'openmc.validation',
        label: 'Diagnose Project',
        description: 'Triage project validation, environment readiness, and cross-section state.',
        commandId: NukeAiCommands.DIAGNOSE_OPENMC.id,
        group: 'nuke-ai',
        order: 'a'
    },
    {
        id: 'nuke-ai.openmc.validation.validateAndExplain',
        scope: 'openmc.validation',
        label: 'Validate and Explain',
        description: 'Validate the active OpenMC project and group the issues by severity.',
        commandId: NukeAiCommands.VALIDATE_OPENMC.id,
        group: 'nuke-ai',
        order: 'b'
    },
    {
        id: 'nuke-ai.openmc.validation.diagnoseCsg',
        scope: 'openmc.validation',
        label: 'Diagnose CSG Geometry',
        description: 'Focus the project diagnosis on CSG surfaces, cells, universes, lattices, and geometry findings.',
        commandId: NukeAiCommands.DIAGNOSE_CSG.id,
        group: 'nuke-ai',
        order: 'c'
    },
    {
        id: 'nuke-ai.openmc.validation.diagnoseDagmc',
        scope: 'openmc.validation',
        label: 'Diagnose DAGMC Model',
        description: 'Focus the project diagnosis on DAGMC file state, volumes, materials, and graveyard findings.',
        commandId: NukeAiCommands.DIAGNOSE_DAGMC.id,
        group: 'nuke-ai',
        order: 'd'
    },
    {
        id: 'nuke-ai.openmc.run.diagnoseRun',
        scope: 'openmc.run',
        label: 'Diagnose Run',
        description: 'Triage the active OpenMC run log for errors, warnings, and lost particles.',
        commandId: NukeAiCommands.DIAGNOSE_RUN.id,
        group: 'nuke-ai',
        order: 'a'
    },
    {
        id: 'nuke-ai.openmc.run.explainRun',
        scope: 'openmc.run',
        label: 'Explain Run',
        description: 'Summarize the active run status, working directory, and recent log tail.',
        commandId: NukeAiCommands.EXPLAIN_RUN.id,
        group: 'nuke-ai',
        order: 'b'
    },
    {
        id: 'nuke-ai.visualizer.dagmc.captureView',
        scope: 'visualizer.dagmc',
        label: 'Capture View',
        description: 'Capture the active DAGMC viewport and describe the preview and its limitations.',
        commandId: NukeAiCommands.CAPTURE_VIEW.id,
        group: 'nuke-ai',
        order: 'a'
    },
    {
        id: 'nuke-ai.visualizer.dagmc.diagnoseStatepoint',
        scope: 'visualizer.dagmc',
        label: 'Diagnose Statepoint',
        description: 'Triage the loaded statepoint metadata: uncertainty, batches, and tally coverage.',
        commandId: NukeAiCommands.DIAGNOSE_STATEPOINT.id,
        group: 'nuke-ai',
        order: 'b'
    },
    {
        id: 'nuke-ai.visualizer.tally.explainStatepoint',
        scope: 'visualizer.tally',
        label: 'Explain Statepoint',
        description: 'Explain k-effective, batches, tallies, and uncertainty for the loaded statepoint.',
        commandId: NukeAiCommands.EXPLAIN_STATEPOINT.id,
        group: 'nuke-ai',
        order: 'a'
    },
    {
        id: 'nuke-ai.visualizer.tally.diagnoseStatepoint',
        scope: 'visualizer.tally',
        label: 'Diagnose Statepoint',
        description: 'Triage the loaded statepoint metadata without reading raw tally values.',
        commandId: NukeAiCommands.DIAGNOSE_STATEPOINT.id,
        group: 'nuke-ai',
        order: 'b'
    }
];

/** Register the NukeAI descriptors with the neutral context-action registry. */
@injectable()
export class NukeAiContextActionContribution implements NukeContextActionContribution {
    registerContextActions(registry: NukeContextActionRegistry): void {
        for (const action of NUKE_AI_CONTEXT_ACTIONS) {
            registry.register(action);
        }
    }
}
