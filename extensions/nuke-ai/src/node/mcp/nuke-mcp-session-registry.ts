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
 * Nuke MCP Session Registry
 *
 * Owns active MCP sessions, idle eviction, and the per-session tool-call rate
 * limit. The sweep timer is unref'd so an idle IDE can still exit, and every
 * removal closes the session's server and transport.
 *
 * @module nuke-ai/node/mcp
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** Maximum concurrent MCP sessions held by one contribution build. */
export const MAX_MCP_SESSIONS = 16;

/** Sessions idle for this long are evicted. */
export const MCP_SESSION_IDLE_MS = 30 * 60 * 1000;

/** How often idle sessions are checked. */
export const MCP_SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

/** Maximum tool calls per session in one rate-limit window. */
export const MCP_TOOL_RATE_LIMIT = 60;

/** Rate-limit window in milliseconds. */
export const MCP_TOOL_RATE_WINDOW_MS = 60 * 1000;

/** Minimal session shape managed by the registry. */
export interface NukeMcpManagedSession {
    readonly server: McpServer;
    readonly transport: StreamableHTTPServerTransport;
}

/** Outcome of admitting one tool call against the session rate limit. */
export type NukeMcpToolCallAdmission = 'accepted' | 'rate-limited' | 'unknown-session';

interface RegistryEntry<T extends NukeMcpManagedSession> {
    readonly session: T;
    lastActivity: number;
    readonly calls: number[];
}

/** Close servers/transports removed by eviction or disposal. */
export type NukeMcpSessionCloser<T extends NukeMcpManagedSession> = (session: T) => Promise<void>;

/** Bounded session map with idle eviction and a per-session rate limit. */
export class NukeMcpSessionRegistry<T extends NukeMcpManagedSession = NukeMcpManagedSession> {
    protected readonly entries = new Map<string, RegistryEntry<T>>();
    protected idleTimer: ReturnType<typeof setInterval> | undefined;

    constructor(
        protected readonly closeSession: NukeMcpSessionCloser<T>,
        protected readonly now: () => number = Date.now,
        protected readonly maxSessions: number = MAX_MCP_SESSIONS,
        protected readonly idleMs: number = MCP_SESSION_IDLE_MS,
        protected readonly sweepIntervalMs: number = MCP_SESSION_SWEEP_INTERVAL_MS,
        protected readonly rateLimit: number = MCP_TOOL_RATE_LIMIT,
        protected readonly rateWindowMs: number = MCP_TOOL_RATE_WINDOW_MS
    ) {}

    /** Number of active sessions. */
    get size(): number {
        return this.entries.size;
    }

    /** Register a session. Returns false when the session cap is reached. */
    open(sessionId: string, session: T): boolean {
        if (this.entries.size >= this.maxSessions) {
            return false;
        }
        this.entries.set(sessionId, { session, lastActivity: this.now(), calls: [] });
        this.ensureTimer();
        return true;
    }

    /** Look up a session and mark it active. */
    get(sessionId: string): T | undefined {
        const entry = this.entries.get(sessionId);
        if (!entry) {
            return undefined;
        }
        entry.lastActivity = this.now();
        return entry.session;
    }

    /** Drop a session without closing it; the transport owns its own close. */
    delete(sessionId: string): boolean {
        const deleted = this.entries.delete(sessionId);
        if (this.entries.size === 0) {
            this.stopTimer();
        }
        return deleted;
    }

    /** Admit one tool call or report that the session is missing or over budget. */
    beginToolCall(sessionId: string): NukeMcpToolCallAdmission {
        const entry = this.entries.get(sessionId);
        if (!entry) {
            return 'unknown-session';
        }
        const now = this.now();
        entry.lastActivity = now;
        const cutoff = now - this.rateWindowMs;
        while (entry.calls.length > 0 && entry.calls[0] <= cutoff) {
            entry.calls.shift();
        }
        if (entry.calls.length >= this.rateLimit) {
            return 'rate-limited';
        }
        entry.calls.push(now);
        return 'accepted';
    }

    /** Evict sessions idle for at least the configured timeout. */
    async sweep(): Promise<number> {
        const now = this.now();
        const expired: T[] = [];
        for (const [sessionId, entry] of Array.from(this.entries.entries())) {
            if (now - entry.lastActivity >= this.idleMs) {
                this.entries.delete(sessionId);
                expired.push(entry.session);
            }
        }
        if (this.entries.size === 0) {
            this.stopTimer();
        }
        await Promise.allSettled(expired.map((session) => this.closeSession(session)));
        return expired.length;
    }

    /** Close every session and stop the sweep timer. */
    async dispose(): Promise<void> {
        this.stopTimer();
        const sessions = Array.from(this.entries.values(), (entry) => entry.session);
        this.entries.clear();
        await Promise.allSettled(sessions.map((session) => this.closeSession(session)));
    }

    protected ensureTimer(): void {
        if (this.idleTimer !== undefined) {
            return;
        }
        this.idleTimer = setInterval(() => {
            void this.sweep();
        }, this.sweepIntervalMs);
        const timer = this.idleTimer as ReturnType<typeof setInterval> & { unref?: () => void };
        timer.unref?.();
    }

    protected stopTimer(): void {
        if (this.idleTimer === undefined) {
            return;
        }
        clearInterval(this.idleTimer);
        this.idleTimer = undefined;
    }
}
