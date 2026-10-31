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
 * Nuke MCP Protocol
 *
 * Stable names, the explicit read-only capability allowlist, resource scopes,
 * and prompt builders shared by the external MCP backend. The catalog itself
 * is built per session from the live frontend capability registry; this module
 * only decides which capability IDs may ever cross the endpoint.
 *
 * @module nuke-ai/common
 */

import type { NukeCapabilityDescriptor } from './nuke-capability-delegate';

/** MCP tool names must satisfy the MCP SDK's portable identifier rules. */
export const MCP_TOOL_NAME_PATTERN = /^[a-z0-9_]{1,128}$/;

/** Maximum number of tools advertised by one MCP session. */
export const MCP_MAX_TOOLS = 24;

/** Maximum number of resources advertised by one MCP session. */
export const MCP_MAX_RESOURCES = 64;

/** Maximum characters in a generated tool description, including its example. */
export const MCP_TOOL_DESCRIPTION_LIMIT = 800;

/** Maximum characters in a serialized tool example. */
export const MCP_TOOL_EXAMPLE_LIMIT = 240;

/** Read-only capability IDs allowed to cross the external MCP boundary. */
export const MCP_READ_ONLY_CAPABILITY_IDS = [
    'nuke.cad.summarizeDocument',
    'nuke.cad.inspectSelection',
    'nuke.cad.diagnoseModel',
    'nuke.openmc.summarizeProject',
    'nuke.openmc.validateProject',
    'nuke.openmc.getRunStatus',
    'nuke.openmc.diagnoseProject',
    'nuke.openmc.diagnoseRun',
    'nuke.viz.summarizeStatepoint',
    'nuke.viz.diagnoseStatepoint',
    'nuke.viz.captureView'
] as const;

/** MCP resource URI for the active IDE context snapshot. */
export const MCP_CONTEXT_RESOURCE_URI = 'nuke://context';

/** MCP resource URI for the active CAD document summary. */
export const MCP_CAD_RESOURCE_URI = 'nuke://cad/document';

/** MCP resource URI for the active OpenMC project summary. */
export const MCP_OPENMC_RESOURCE_URI = 'nuke://openmc/project';

/** MCP resource URI for the active visualizer dataset summary. */
export const MCP_VISUALIZER_RESOURCE_URI = 'nuke://visualizer/dataset';

/** Prefix for one resource per discovered NukeAI skill. */
export const MCP_SKILL_RESOURCE_PREFIX = 'nuke://skills/';

/** Fixed resource URIs the external endpoint may expose. */
export const MCP_RESOURCE_URIS = [
    MCP_CONTEXT_RESOURCE_URI,
    MCP_CAD_RESOURCE_URI,
    MCP_OPENMC_RESOURCE_URI,
    MCP_VISUALIZER_RESOURCE_URI
] as const;

/** MCP prompt that describes the CAD to OpenMC workflow. */
export const NUKE_WORKFLOW_PROMPT_NAME = 'nuke-workflow';

/** MCP prompt that triages findings with read-only diagnostics tools. */
export const NUKE_DIAGNOSTICS_PROMPT_NAME = 'nuke-diagnostics';

/** Minimal tool projection used to generate prompts without stale IDs. */
export interface NukeMcpToolSummary {
    readonly name: string;
    readonly capabilityId: string;
    readonly title: string;
}

/**
 * Preserve the original CAD summary name and map every other capability ID to
 * a portable snake_case tool name.
 */
export function toMcpToolName(capabilityId: string): string {
    if (capabilityId === 'nuke.cad.summarizeDocument') {
        return 'nuke_cad_summarize_document';
    }
    const name = capabilityId
        .replace(/[.-]+/g, '_')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
        throw new Error(`Capability id ${capabilityId} cannot be mapped to a valid MCP tool name.`);
    }
    return name;
}

/** True when a capability ID is explicitly allowlisted for external MCP. */
export function isAllowedMcpCapability(capabilityId: string): boolean {
    return (MCP_READ_ONLY_CAPABILITY_IDS as readonly string[]).includes(capabilityId);
}

/**
 * True only for a live descriptor that is read-only, unconfirmed, and free of
 * contradictory write, execute, or destructive annotations.
 */
export function isReadOnlyMcpCapability(descriptor: NukeCapabilityDescriptor): boolean {
    if (descriptor.risk !== 'read' || descriptor.requiresConfirmation === true) {
        return false;
    }
    const annotations = descriptor.annotations;
    if (!annotations) {
        return true;
    }
    if (annotations.readOnlyHint === false || annotations.destructiveHint === true) {
        return false;
    }
    return true;
}

/** True when a resource URI is inside the fixed read-only resource scope. */
export function isAllowedMcpResourceUri(uri: string): boolean {
    if ((MCP_RESOURCE_URIS as readonly string[]).includes(uri)) {
        return true;
    }
    if (!uri.startsWith(MCP_SKILL_RESOURCE_PREFIX)) {
        return false;
    }
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(uri.slice(MCP_SKILL_RESOURCE_PREFIX.length));
}

/** Build a bounded description with one worked example. */
export function buildMcpToolDescription(descriptor: NukeCapabilityDescriptor): string {
    const description = typeof descriptor.description === 'string' ? descriptor.description.trim() : '';
    const title = typeof descriptor.title === 'string' ? descriptor.title.trim() : '';
    const base = description || title || descriptor.id;
    const example = Array.isArray(descriptor.examples) ? descriptor.examples[0] : undefined;
    if (!example || typeof example !== 'object' || typeof example.description !== 'string') {
        return capText(`${base} Example input: {}.`, MCP_TOOL_DESCRIPTION_LIMIT);
    }
    const exampleText = `${capText(example.description, 160)} Input: ${capText(safeJson(example.input), MCP_TOOL_EXAMPLE_LIMIT)}`;
    const prefix = capText(base, Math.max(0, MCP_TOOL_DESCRIPTION_LIMIT - exampleText.length - ' Example: '.length));
    return capText(`${prefix} Example: ${exampleText}`, MCP_TOOL_DESCRIPTION_LIMIT);
}

/** Generate the workflow prompt from the tools the session actually exposes. */
export function buildWorkflowPrompt(tools: readonly NukeMcpToolSummary[]): string {
    const lines = [
        'Walk through the NukeIDE CAD to DAGMC to OpenMC to visualizer workflow using only the read-only MCP tools exposed by this endpoint.',
        '',
        'Exposed read-only tools:',
        ...toolLines(tools),
        '',
        '1. Read the active CAD document with the exposed CAD summary, selection, or diagnosis tool when one is available.',
        '2. DAGMC export and OpenMC CAD import are not exposed. Ask the user to run those NukeIDE commands and confirm them in the IDE.',
        '3. Inspect the active OpenMC project with the exposed validation, run-status, or diagnosis tools. Never start a run.',
        '4. Summarize the loaded statepoint or capture the current DAGMC viewport with the exposed visualizer tools.',
        '5. Explain the findings and suggest only read-only follow-up checks. Do not export, import, write, or execute anything.'
    ];
    return lines.join('\n');
}

/** Generate the diagnostics prompt from the exposed read-only diagnostic tools. */
export function buildDiagnosticsPrompt(tools: readonly NukeMcpToolSummary[]): string {
    const diagnosticTools = tools.filter(
        (tool) => /\.diagnose[A-Z]/.test(tool.capabilityId) || tool.capabilityId.endsWith('.getRunStatus')
    );
    const lines = [
        'Triage the active NukeIDE workspace using only read-only diagnostic tools. Never write files, export, import, or start a run.',
        '',
        'Exposed read-only diagnostics tools:',
        ...(diagnosticTools.length > 0
            ? toolLines(diagnosticTools)
            : ['- None in this session. Report the missing diagnostics surface instead of guessing.']),
        '',
        '1. Start with the CAD model diagnosis when a CAD document is active.',
        '2. Validate the OpenMC project, then diagnose the active run when one exists.',
        '3. Diagnose the loaded statepoint before summarizing its results.',
        '4. Prioritize findings by severity: error, then warning, then info.',
        '5. For each finding report its code, affected object, evidence, and the next read-only check.'
    ];
    return lines.join('\n');
}

function toolLines(tools: readonly NukeMcpToolSummary[]): string[] {
    if (tools.length === 0) {
        return ['- None in this session.'];
    }
    return tools.map((tool) => `- \`${tool.name}\` (capability \`${tool.capabilityId}\`): ${tool.title}`);
}

function capText(value: string, limit: number): string {
    const text = typeof value === 'string' ? value : String(value ?? '');
    if (text.length <= limit) {
        return text;
    }
    return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '{}';
    } catch {
        return '{}';
    }
}
