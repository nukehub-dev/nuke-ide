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
import {
    MCP_READ_ONLY_CAPABILITY_IDS,
    NUKE_CAPABILITY_CATALOG,
    NUKE_CAPABILITY_IDS,
    NUKE_CAPABILITY_TOOL_NAMES,
    NUKE_DIAGNOSTICS_CAPABILITY_IDS,
    NUKE_DIAGNOSTICS_TOOL_NAMES,
    NukeCapabilityCatalogEntry,
    groupNukeCapabilitiesByRisk,
    validateNukeCapabilityCatalog
} from '../../common/nuke-capability-catalog';
import { isAllowedMcpCapability } from '../../common/nuke-mcp-protocol';
import { toToolName } from '../capabilities/nuke-tool-schema';
import { NukeChatAgent } from './nuke-chat-agent';
import { NukeDiagnosticsAgent } from './nuke-diagnostics-agent';
import { NUKE_DIAGNOSTICS_SYSTEM_PROMPT } from './nuke-diagnostics-system-prompt';
import { NUKE_SYSTEM_PROMPT, buildNukeSystemPrompt } from './nuke-system-prompt';

function sameOrder(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/**
 * Report every mismatch between a catalog and its consumers. The real catalog
 * must produce no errors; filtering one entry out must produce at least one.
 */
function consistencyErrors(entries: readonly NukeCapabilityCatalogEntry[]): string[] {
    const errors = validateNukeCapabilityCatalog(entries);
    const chatEntries = entries.filter((entry) => entry.chat);
    const diagnosticsEntries = entries.filter((entry) => entry.diagnostics === true);
    const mcpEntries = entries
        .filter((entry) => entry.mcpReadOnly === true && entry.risk === 'read')
        .sort((left, right) => (left.mcpOrder ?? Number.MAX_SAFE_INTEGER) - (right.mcpOrder ?? Number.MAX_SAFE_INTEGER));

    if (
        !sameOrder(
            chatEntries.map((entry) => entry.toolName),
            NUKE_CAPABILITY_TOOL_NAMES
        )
    ) {
        errors.push('Chat tool names differ from the catalog chat entries.');
    }
    if (
        !sameOrder(
            chatEntries.map((entry) => entry.id),
            NUKE_CAPABILITY_IDS
        )
    ) {
        errors.push('Chat capability ids differ from the catalog chat entries.');
    }
    if (
        !sameOrder(
            diagnosticsEntries.map((entry) => entry.toolName),
            NUKE_DIAGNOSTICS_TOOL_NAMES
        )
    ) {
        errors.push('Diagnostics tool names differ from the catalog diagnostics entries.');
    }
    if (
        !sameOrder(
            diagnosticsEntries.map((entry) => entry.id),
            NUKE_DIAGNOSTICS_CAPABILITY_IDS
        )
    ) {
        errors.push('Diagnostics capability ids differ from the catalog diagnostics entries.');
    }
    if (
        !sameOrder(
            mcpEntries.map((entry) => entry.id),
            MCP_READ_ONLY_CAPABILITY_IDS
        )
    ) {
        errors.push('MCP allowlist differs from the catalog mcpReadOnly read entries.');
    }

    const chatAgent = new NukeChatAgent();
    if (!sameOrder(chatAgent.functions, NUKE_CAPABILITY_TOOL_NAMES)) {
        errors.push('NukeAI functions differ from the catalog chat tool names.');
    }
    const diagnosticsAgent = new NukeDiagnosticsAgent();
    if (!sameOrder(diagnosticsAgent.functions, NUKE_DIAGNOSTICS_TOOL_NAMES)) {
        errors.push('Nuke Diagnostics functions differ from the catalog diagnostics tool names.');
    }

    const prompt = buildNukeSystemPrompt(entries);
    if (prompt !== NUKE_SYSTEM_PROMPT) {
        errors.push('The exported chat prompt differs from the prompt built from the catalog.');
    }
    if (chatAgent.prompts[0].defaultVariant.template !== prompt) {
        errors.push('The NukeAI agent prompt differs from the prompt built from the catalog.');
    }
    for (const entry of chatEntries) {
        if (!prompt.includes(entry.toolName)) {
            errors.push(`Chat prompt is missing tool name ${entry.toolName}.`);
        }
        if (!prompt.includes(`~{${entry.toolName}}`)) {
            errors.push(`Chat prompt is missing ~{${entry.toolName}}.`);
        }
        if (!prompt.includes(entry.id)) {
            errors.push(`Chat prompt is missing capability id ${entry.id}.`);
        }
    }
    for (const entry of entries.filter((candidate) => !candidate.chat)) {
        if (prompt.includes(entry.toolName) || prompt.includes(`~{${entry.toolName}}`) || prompt.includes(entry.id)) {
            errors.push(`Chat prompt advertises diagnostics-only capability ${entry.id}.`);
        }
    }
    for (const entry of diagnosticsEntries) {
        if (!NUKE_DIAGNOSTICS_SYSTEM_PROMPT.includes(entry.toolName)) {
            errors.push(`Diagnostics prompt is missing tool name ${entry.toolName}.`);
        }
        if (!NUKE_DIAGNOSTICS_SYSTEM_PROMPT.includes(`~{${entry.toolName}}`)) {
            errors.push(`Diagnostics prompt is missing ~{${entry.toolName}}.`);
        }
        if (!NUKE_DIAGNOSTICS_SYSTEM_PROMPT.includes(entry.id)) {
            errors.push(`Diagnostics prompt is missing capability id ${entry.id}.`);
        }
    }
    for (const id of MCP_READ_ONLY_CAPABILITY_IDS) {
        if (!isAllowedMcpCapability(id)) {
            errors.push(`MCP allowlist entry ${id} is not allowed by the runtime guard.`);
        }
    }
    return errors;
}

describe('NukeCapabilityCatalog', () => {
    it('keeps the catalog and every consumer aligned', () => {
        expect(consistencyErrors(NUKE_CAPABILITY_CATALOG)).toEqual([]);
    });

    it('fails when one chat or diagnostics entry is removed', () => {
        const withoutChat = NUKE_CAPABILITY_CATALOG.filter((entry) => entry.id !== 'nuke.cad.summarizeDocument');
        const withoutDiagnosticsOnly = NUKE_CAPABILITY_CATALOG.filter((entry) => entry.id !== 'nuke.viz.compareStatepoints');

        expect(consistencyErrors(withoutChat).length).toBeGreaterThan(0);
        expect(consistencyErrors(withoutDiagnosticsOnly).length).toBeGreaterThan(0);
    });

    it('uses unique capability ids and sanitized tool names', () => {
        expect(validateNukeCapabilityCatalog(NUKE_CAPABILITY_CATALOG)).toEqual([]);
        const ids = NUKE_CAPABILITY_CATALOG.map((entry) => entry.id);
        const toolNames = NUKE_CAPABILITY_CATALOG.map((entry) => entry.toolName);

        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(toolNames).size).toBe(toolNames.length);
        for (const entry of NUKE_CAPABILITY_CATALOG) {
            expect(entry.toolName).toBe(toToolName(entry.id));
        }
    });

    it('groups every entry by its declared risk', () => {
        const grouped = groupNukeCapabilitiesByRisk();
        const groupedEntries = [...grouped.read, ...grouped.write, ...grouped.execute, ...grouped.destructive];

        expect(groupedEntries).toHaveLength(NUKE_CAPABILITY_CATALOG.length);
        for (const entry of NUKE_CAPABILITY_CATALOG) {
            expect(grouped[entry.risk]).toContainEqual(entry);
        }
    });

    it('rejects duplicate, unsanitized, and non-read entries', () => {
        const base = NUKE_CAPABILITY_CATALOG[0];
        expect(validateNukeCapabilityCatalog([base, base])).toEqual(
            expect.arrayContaining([expect.stringContaining('Duplicate capability id'), expect.stringContaining('Duplicate tool name')])
        );
        expect(validateNukeCapabilityCatalog([{ ...base, toolName: 'nuke_wrong_name' }])).toEqual(
            expect.arrayContaining([expect.stringContaining('must be the sanitized form')])
        );
        expect(validateNukeCapabilityCatalog([{ ...base, risk: 'write', mcpReadOnly: true }])).toEqual(
            expect.arrayContaining([expect.stringContaining('must be risk read')])
        );
        expect(validateNukeCapabilityCatalog([{ ...base, risk: 'execute', diagnostics: true }])).toEqual(
            expect.arrayContaining([expect.stringContaining('must be risk read')])
        );
    });

    it('allowlists only explicit read-risk entries for MCP', () => {
        for (const id of MCP_READ_ONLY_CAPABILITY_IDS) {
            const entry = NUKE_CAPABILITY_CATALOG.find((candidate) => candidate.id === id);
            expect(entry).toBeDefined();
            expect(entry?.risk).toBe('read');
            expect(entry?.mcpReadOnly).toBe(true);
            expect(isAllowedMcpCapability(id)).toBe(true);
        }
        expect(isAllowedMcpCapability('nuke.openmc.previewSettings')).toBe(false);
        expect(isAllowedMcpCapability('nuke.cad.exportDagmc')).toBe(false);
        expect(isAllowedMcpCapability('nuke.viz.compareStatepoints')).toBe(false);
    });

    it('keeps diagnostics entries read-only and out of the chat tool list', () => {
        expect(NUKE_DIAGNOSTICS_TOOL_NAMES).toEqual(expect.arrayContaining(['nuke_viz_compareStatepoints', 'nuke_viz_analyzeTallySeries']));
        for (const id of NUKE_DIAGNOSTICS_CAPABILITY_IDS) {
            const entry = NUKE_CAPABILITY_CATALOG.find((candidate) => candidate.id === id);
            expect(entry?.risk).toBe('read');
            expect(entry?.diagnostics).toBe(true);
            expect(NUKE_CAPABILITY_IDS.includes(id)).toBe(entry?.chat === true);
        }
    });

    it('keeps the generated chat prompt within its line budget', () => {
        const lines = NUKE_SYSTEM_PROMPT.split('\n');
        expect(lines.length).toBeGreaterThanOrEqual(80);
        expect(lines.length).toBeLessThanOrEqual(240);
        expect(NUKE_SYSTEM_PROMPT).toContain('{{nukeContext}}');
    });
});
