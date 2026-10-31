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
    MCP_AUDIT_LIMIT,
    MCP_AUDIT_SUMMARY_LIMIT,
    NukeMcpAuditEntry,
    NukeMcpAuditLog,
    redactMcpInput,
    summarizeMcpInput
} from './nuke-mcp-audit';

function entry(index: number): NukeMcpAuditEntry {
    return {
        timestamp: 1_000 + index,
        sessionId: 'session',
        tool: `tool_${index}`,
        durationMs: index,
        ok: true,
        inputHash: `hash_${index}`,
        inputSummary: `summary_${index}`
    };
}

describe('NukeMcpAuditLog', () => {
    it(`keeps only the last ${MCP_AUDIT_LIMIT} entries`, () => {
        const audit = new NukeMcpAuditLog();
        for (let index = 0; index < MCP_AUDIT_LIMIT + 5; index += 1) {
            audit.record(entry(index));
        }

        expect(audit.size).toBe(MCP_AUDIT_LIMIT);
        expect(audit.recent(1)[0].tool).toBe(`tool_${MCP_AUDIT_LIMIT + 4}`);
        expect(audit.recent(MCP_AUDIT_LIMIT)).toHaveLength(MCP_AUDIT_LIMIT);
        expect(audit.recent(MCP_AUDIT_LIMIT).some((row) => row.tool === 'tool_0')).toBe(false);
    });

    it('returns newest rows first and caps the requested window', () => {
        const audit = new NukeMcpAuditLog();
        audit.record(entry(1));
        audit.record(entry(2));
        audit.record(entry(3));

        expect(audit.recent(2).map((row) => row.tool)).toEqual(['tool_3', 'tool_2']);
        expect(audit.recent(0)).toEqual([]);
        expect(audit.recent(100)).toHaveLength(3);
    });
});

describe('MCP audit input summaries', () => {
    it('redacts credentials and hashes the bounded summary', () => {
        const summary = summarizeMcpInput({
            authorization: 'Bearer secret',
            token: 'secret',
            nested: { apiKey: 'secret', password: 'secret', filePath: '/workspace/model.nuke-cad' }
        });

        expect(summary.inputHash).toMatch(/^[0-9a-f]{16}$/);
        expect(summary.inputSummary).not.toContain('secret');
        expect(summary.inputSummary).toContain('[redacted]');
        expect(summary.inputSummary).toContain('/workspace/model.nuke-cad');
        expect(summary.inputSummary.length).toBeLessThanOrEqual(MCP_AUDIT_SUMMARY_LIMIT);
    });

    it('caps long and deeply nested inputs', () => {
        const summary = summarizeMcpInput({ long: 'a'.repeat(5_000), nested: { deep: { deeper: { deepest: 'x' } } } });

        expect(summary.inputSummary.length).toBeLessThanOrEqual(MCP_AUDIT_SUMMARY_LIMIT);
        expect(summary.inputSummary).toContain('[truncated]');
        expect(redactMcpInput({ long: 'a'.repeat(300) })).toContain('[truncated]');
    });
});
