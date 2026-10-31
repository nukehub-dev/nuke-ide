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
 * NukeAI Nuke Tools Contribution
 *
 * Adds the NukeAI contextual actions and external MCP controls as the first
 * section of the shared Nuke Tools sidebar. The widget, grouping, and search
 * behavior stay owned by `nuke-core`.
 *
 * @module nuke-ai/browser/actions
 */

import { injectable } from '@theia/core/shared/inversify';
import { NukeToolsContribution, NukeToolsItem, NukeToolsRegistry } from 'nuke-core/lib/common/nuke-tools-protocol';
import { NukeMcpCommands } from '../mcp/nuke-mcp-commands';
import { NukeAiCommands } from './nuke-ai-commands';

/** Sidebar items owned by NukeAI, in display order. */
const NUKE_AI_TOOL_ITEMS: readonly Omit<NukeToolsItem, 'sectionOrder'>[] = [
    {
        id: NukeAiCommands.ASK.id,
        label: 'Ask About Active Context',
        commandId: NukeAiCommands.ASK.id,
        category: ['NukeAI'],
        order: 'a',
        icon: 'comment-discussion',
        description: 'Explain what the active CAD, OpenMC, and dataset context makes possible without changing anything.',
        keywords: ['ai', 'ask', 'context', 'summary', 'help']
    },
    {
        id: NukeAiCommands.ATTACH_CONTEXT.id,
        label: 'Attach Active Context',
        commandId: NukeAiCommands.ATTACH_CONTEXT.id,
        category: ['NukeAI'],
        order: 'b',
        icon: 'link',
        description: 'Add #nukeContext to the active AI chat session.',
        keywords: ['ai', 'context', 'chip', 'attach', 'nukeContext']
    },
    {
        id: NukeAiCommands.CHECK_CAD.id,
        label: 'Check Active CAD Model',
        commandId: NukeAiCommands.CHECK_CAD.id,
        category: ['NukeAI'],
        order: 'c',
        icon: 'beaker',
        description: 'Summarize the active CAD document: counts, selection, warnings, and next steps.',
        keywords: ['ai', 'cad', 'model', 'summary', 'warnings']
    },
    {
        id: NukeAiCommands.EXPLAIN_SELECTION.id,
        label: 'Explain CAD Selection',
        commandId: NukeAiCommands.EXPLAIN_SELECTION.id,
        category: ['NukeAI'],
        order: 'd',
        icon: 'selection',
        description: 'Explain the current CAD selection and any hidden solids.',
        keywords: ['ai', 'cad', 'selection', 'solid', 'inspect']
    },
    {
        id: NukeAiCommands.VALIDATE_OPENMC.id,
        label: 'Validate OpenMC Project',
        commandId: NukeAiCommands.VALIDATE_OPENMC.id,
        category: ['NukeAI'],
        order: 'e',
        icon: 'checklist',
        description: 'Validate the active OpenMC project and group issues by severity.',
        keywords: ['ai', 'openmc', 'validate', 'issues', 'project']
    },
    {
        id: NukeAiCommands.EXPLAIN_RUN.id,
        label: 'Explain OpenMC Run',
        commandId: NukeAiCommands.EXPLAIN_RUN.id,
        category: ['NukeAI'],
        order: 'f',
        icon: 'debug-alt',
        description: 'Summarize the active OpenMC run status and its recent log tail.',
        keywords: ['ai', 'openmc', 'run', 'status', 'log']
    },
    {
        id: NukeAiCommands.EXPLAIN_STATEPOINT.id,
        label: 'Explain Active Statepoint',
        commandId: NukeAiCommands.EXPLAIN_STATEPOINT.id,
        category: ['NukeAI'],
        order: 'g',
        icon: 'graph',
        description: 'Explain k-effective, batches, tallies, and uncertainty in the active dataset.',
        keywords: ['ai', 'visualizer', 'statepoint', 'k-eff', 'tallies']
    },
    {
        id: NukeAiCommands.CAPTURE_VIEW.id,
        label: 'Capture DAGMC View',
        commandId: NukeAiCommands.CAPTURE_VIEW.id,
        category: ['NukeAI'],
        order: 'h',
        icon: 'device-camera',
        description: 'Capture the active DAGMC viewport and describe the preview.',
        keywords: ['ai', 'visualizer', 'dagmc', 'capture', 'preview']
    },
    {
        id: NukeAiCommands.DIAGNOSE_CAD.id,
        label: 'Diagnose Active CAD Model',
        commandId: NukeAiCommands.DIAGNOSE_CAD.id,
        category: ['NukeAI', 'Diagnostics'],
        categoryOrder: 'a',
        order: 'a',
        icon: 'checklist',
        description: 'Triage the active CAD model and report severity-coded findings with evidence.',
        keywords: ['ai', 'diagnostics', 'cad', 'model', 'findings', 'severity']
    },
    {
        id: NukeAiCommands.DIAGNOSE_OPENMC.id,
        label: 'Diagnose OpenMC Project',
        commandId: NukeAiCommands.DIAGNOSE_OPENMC.id,
        category: ['NukeAI', 'Diagnostics'],
        categoryOrder: 'a',
        order: 'b',
        icon: 'checklist',
        description: 'Triage OpenMC project validation, environment readiness, and cross-section state.',
        keywords: ['ai', 'diagnostics', 'openmc', 'project', 'validation', 'findings']
    },
    {
        id: NukeAiCommands.DIAGNOSE_RUN.id,
        label: 'Diagnose OpenMC Run',
        commandId: NukeAiCommands.DIAGNOSE_RUN.id,
        category: ['NukeAI', 'Diagnostics'],
        categoryOrder: 'a',
        order: 'c',
        icon: 'debug-alt',
        description: 'Triage the active OpenMC run log for errors, warnings, and lost particles.',
        keywords: ['ai', 'diagnostics', 'openmc', 'run', 'log', 'errors']
    },
    {
        id: NukeAiCommands.DIAGNOSE_STATEPOINT.id,
        label: 'Diagnose Active Statepoint',
        commandId: NukeAiCommands.DIAGNOSE_STATEPOINT.id,
        category: ['NukeAI', 'Diagnostics'],
        categoryOrder: 'a',
        order: 'd',
        icon: 'graph',
        description: 'Triage the loaded statepoint metadata: uncertainty, batches, and tally coverage.',
        keywords: ['ai', 'diagnostics', 'visualizer', 'statepoint', 'k-eff', 'tallies']
    },
    {
        id: NukeMcpCommands.ENABLE.id,
        label: 'Enable MCP Endpoint',
        commandId: NukeMcpCommands.ENABLE.id,
        category: ['NukeAI', 'External MCP'],
        categoryOrder: 'a',
        order: 'a',
        icon: 'plug',
        description: 'Start the token-protected, loopback-only MCP endpoint for external clients.',
        keywords: ['ai', 'mcp', 'enable', 'external', 'endpoint']
    },
    {
        id: NukeMcpCommands.DISABLE.id,
        label: 'Disable MCP Endpoint',
        commandId: NukeMcpCommands.DISABLE.id,
        category: ['NukeAI', 'External MCP'],
        categoryOrder: 'a',
        order: 'b',
        icon: 'debug-disconnect',
        description: 'Stop the external MCP endpoint and remove its token and config.',
        keywords: ['ai', 'mcp', 'disable', 'external', 'endpoint']
    }
];

/** Register NukeAI's entries in the shared Nuke Tools sidebar. */
@injectable()
export class NukeAiToolsContribution implements NukeToolsContribution {
    registerTools(registry: NukeToolsRegistry): void {
        for (const item of NUKE_AI_TOOL_ITEMS) {
            registry.registerItem({
                ...item,
                sectionOrder: '0',
                categoryOrder: item.categoryOrder ?? 'a'
            });
        }
    }
}
