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
 * Nuke MCP Audit
 *
 * In-memory audit ring for external MCP tool calls. Entries keep only a
 * redacted, bounded input summary and a hash, never file or resource content,
 * result payloads, or tokens. The ring is process-local and intentionally not
 * persisted.
 *
 * @module nuke-ai/node/mcp
 */

import { createHash } from 'crypto';

/** Maximum audit entries kept in memory. */
export const MCP_AUDIT_LIMIT = 200;

/** Maximum characters stored in one redacted input summary. */
export const MCP_AUDIT_SUMMARY_LIMIT = 400;

const SENSITIVE_KEY = /(authorization|token|api[_-]?key|secret|password)/i;
const MAX_LOG_STRING = 200;
const TRUNCATION_SUFFIX = '... [truncated]';
const MAX_LOG_DEPTH = 5;
const MAX_LOG_ENTRIES = 50;

/** One tool-call audit row. */
export interface NukeMcpAuditEntry {
    readonly timestamp: number;
    readonly sessionId: string;
    readonly tool: string;
    readonly durationMs: number;
    readonly ok: boolean;
    readonly inputHash: string;
    readonly inputSummary: string;
}

/** Redacted input summary and stable hash for one tool invocation. */
export interface NukeMcpInputSummary {
    readonly inputHash: string;
    readonly inputSummary: string;
}

/** Bounded, process-local audit ring. */
export class NukeMcpAuditLog {
    protected readonly entries: NukeMcpAuditEntry[] = [];

    constructor(protected readonly limit: number = MCP_AUDIT_LIMIT) {}

    /** Append one row, dropping the oldest entries beyond the ring size. */
    record(entry: NukeMcpAuditEntry): void {
        this.entries.push(entry);
        while (this.entries.length > this.limit) {
            this.entries.shift();
        }
    }

    /** Return the newest entries first, capped at `limit`. */
    recent(limit = 20): readonly NukeMcpAuditEntry[] {
        const count = Math.max(0, Math.min(limit, this.entries.length));
        return this.entries.slice(this.entries.length - count).reverse();
    }

    /** Total rows currently held. */
    get size(): number {
        return this.entries.length;
    }
}

/** Hash and redact one tool input without exposing its content. */
export function summarizeMcpInput(input: unknown): NukeMcpInputSummary {
    const redacted = redactMcpInput(input);
    return {
        inputHash: createHash('sha256').update(redacted).digest('hex').slice(0, 16),
        inputSummary: capText(redacted, MCP_AUDIT_SUMMARY_LIMIT)
    };
}

/**
 * Redact secrets and cap long strings before an invocation input reaches an
 * audit row or the IDE log. Never log the bearer token or any nested credential.
 */
export function redactMcpInput(input: unknown): string {
    try {
        return JSON.stringify(redactValue(input, 0, new WeakSet<object>())) ?? '[undefined input]';
    } catch {
        return '[unserializable input]';
    }
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return capLogString(value);
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (typeof value !== 'object') {
        return String(value);
    }
    if (depth >= MAX_LOG_DEPTH) {
        return '[truncated]';
    }
    if (seen.has(value)) {
        return '[circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.slice(0, MAX_LOG_ENTRIES).map((entry) => redactValue(entry, depth + 1, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_LOG_ENTRIES)) {
        result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redactValue(entry, depth + 1, seen);
    }
    return result;
}

function capLogString(value: string): string {
    if (value.length <= MAX_LOG_STRING) {
        return value;
    }
    return value.slice(0, MAX_LOG_STRING - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function capText(value: string, limit: number): string {
    if (value.length <= limit) {
        return value;
    }
    return `${value.slice(0, Math.max(0, limit - 3))}...`;
}
