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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
    MAX_MCP_SESSIONS,
    MCP_SESSION_IDLE_MS,
    MCP_TOOL_RATE_LIMIT,
    MCP_TOOL_RATE_WINDOW_MS,
    NukeMcpManagedSession,
    NukeMcpSessionRegistry
} from './nuke-mcp-session-registry';

function session(): NukeMcpManagedSession {
    return {
        server: { close: vi.fn(async () => undefined) } as unknown as McpServer,
        transport: { close: vi.fn(async () => undefined) } as unknown as StreamableHTTPServerTransport
    };
}

describe('NukeMcpSessionRegistry', () => {
    it(`caps active sessions at ${MAX_MCP_SESSIONS}`, async () => {
        const registry = new NukeMcpSessionRegistry<ReturnType<typeof session>>(async () => undefined);
        for (let index = 0; index < MAX_MCP_SESSIONS; index += 1) {
            expect(registry.open(`session-${index}`, session())).toBe(true);
        }

        expect(registry.size).toBe(MAX_MCP_SESSIONS);
        expect(registry.open('overflow', session())).toBe(false);
        expect(registry.size).toBe(MAX_MCP_SESSIONS);
        await registry.dispose();
    });

    it('evicts sessions after the idle timeout and closes them', async () => {
        let current = 1_000;
        const close = vi.fn(async () => undefined);
        const registry = new NukeMcpSessionRegistry<ReturnType<typeof session>>(
            close,
            () => current,
            MAX_MCP_SESSIONS,
            MCP_SESSION_IDLE_MS,
            MCP_SESSION_IDLE_MS
        );
        registry.open('idle', session());

        current += MCP_SESSION_IDLE_MS;
        registry.open('active', session());
        current += MCP_SESSION_IDLE_MS - 1;
        expect(await registry.sweep()).toBe(1);
        expect(registry.size).toBe(1);
        expect(close).toHaveBeenCalledTimes(1);

        current += 1;
        expect(await registry.sweep()).toBe(1);
        expect(close).toHaveBeenCalledTimes(2);
        expect(registry.size).toBe(0);
        await registry.dispose();
    });

    it('starts an unref\u2019d idle sweep timer', async () => {
        const registry = new NukeMcpSessionRegistry<ReturnType<typeof session>>(async () => undefined);
        registry.open('session', session());
        const timer = (registry as unknown as { idleTimer?: ReturnType<typeof setInterval> }).idleTimer;

        expect(timer).toBeDefined();
        expect((timer as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
        await registry.dispose();
    });

    it(`allows ${MCP_TOOL_RATE_LIMIT} calls per ${MCP_TOOL_RATE_WINDOW_MS / 1000} seconds`, async () => {
        let current = 0;
        const registry = new NukeMcpSessionRegistry<ReturnType<typeof session>>(
            async () => undefined,
            () => current
        );
        registry.open('session', session());

        for (let index = 0; index < MCP_TOOL_RATE_LIMIT; index += 1) {
            expect(registry.beginToolCall('session')).toBe('accepted');
        }
        expect(registry.beginToolCall('session')).toBe('rate-limited');
        expect(registry.beginToolCall('missing')).toBe('unknown-session');

        current += MCP_TOOL_RATE_WINDOW_MS;
        expect(registry.beginToolCall('session')).toBe('accepted');
        await registry.dispose();
    });

    it('closes every session on dispose', async () => {
        const close = vi.fn(async () => undefined);
        const registry = new NukeMcpSessionRegistry<ReturnType<typeof session>>(close);
        registry.open('one', session());
        registry.open('two', session());

        await registry.dispose();

        expect(close).toHaveBeenCalledTimes(2);
        expect(registry.size).toBe(0);
        expect((registry as unknown as { idleTimer?: unknown }).idleTimer).toBeUndefined();
    });
});
