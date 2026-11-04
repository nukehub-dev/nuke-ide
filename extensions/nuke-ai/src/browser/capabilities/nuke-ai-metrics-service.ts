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
 * NukeAI Tool Metrics
 *
 * Local-only invocation journal. Every capability tool call appends one line to
 * `<workspace>/.nuke-ide/ai/metrics.jsonl` with identity and timing only: no
 * inputs, file contents, paths, or tokens. Writes are serialized and bounded to
 * one 1 MiB file plus one rotated backup. Without a workspace the entries stay
 * in memory and persistence is disabled with a single log message.
 *
 * @module nuke-ai/browser/capabilities
 */

import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { NukeCapabilityRisk } from 'nuke-core/lib/common/nuke-capability-protocol';
import { NUKE_AI_LOCAL_LOG_MAX_BYTES, NUKE_AI_LOCAL_LOG_ROOT, NukeLocalJsonlLog } from './nuke-local-log';

/** Current metrics file inside the workspace config folder. */
export const NUKE_AI_METRICS_FILE = 'metrics.jsonl';

/** Single rotated metrics backup; overwritten on the next rotation. */
export const NUKE_AI_METRICS_BACKUP_FILE = 'metrics.1.jsonl';

/** Default number of entries shown by the metrics command. */
export const NUKE_AI_METRICS_RECENT_LIMIT = 20;

/** Upper bound on entries kept in memory when no workspace is open. */
const MAX_IN_MEMORY_ENTRIES = 200;

const METRIC_RISKS: readonly NukeCapabilityRisk[] = ['read', 'write', 'execute', 'destructive'];

/** One persisted tool-invocation metric line. */
export interface NukeAiMetricEntry {
    readonly timestamp: string;
    readonly capabilityId: string;
    readonly version: number;
    readonly risk: NukeCapabilityRisk;
    readonly ok: boolean;
    readonly durationMs: number;
}

/** Input to {@link NukeAiMetricsService.record}; the timestamp is added on append. */
export interface NukeAiMetricRecord {
    readonly capabilityId: string;
    readonly version?: number;
    readonly risk: NukeCapabilityRisk;
    readonly ok: boolean;
    readonly durationMs: number;
}

/** Aggregate counters for one capability, used by the read-only metrics command. */
export interface NukeAiMetricSummary {
    readonly capabilityId: string;
    readonly count: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly averageDurationMs: number;
    readonly lastTimestamp: string;
}

/** Optional byte cap for tests; production uses {@link NUKE_AI_LOCAL_LOG_MAX_BYTES}. */
export interface NukeAiMetricsOptions {
    readonly maxBytes?: number;
}

/** Append local tool metrics; never throws into a tool call. */
@injectable()
export class NukeAiMetricsService {
    protected readonly log: NukeLocalJsonlLog;
    protected readonly inMemoryEntries: NukeAiMetricEntry[] = [];
    protected noWorkspaceLogged = false;

    constructor(
        @inject(FileService) fileService: FileService,
        @inject(WorkspaceService) workspaceService: WorkspaceService,
        @inject(ILogger) protected readonly logger: ILogger,
        @unmanaged() options: NukeAiMetricsOptions = {}
    ) {
        this.log = new NukeLocalJsonlLog(fileService, workspaceService, logger, {
            dir: NUKE_AI_LOCAL_LOG_ROOT,
            fileName: NUKE_AI_METRICS_FILE,
            backupFileName: NUKE_AI_METRICS_BACKUP_FILE,
            maxBytes: options.maxBytes ?? NUKE_AI_LOCAL_LOG_MAX_BYTES
        });
    }

    /** Record one invocation. A failed write is logged and never rejects. */
    async record(record: NukeAiMetricRecord): Promise<void> {
        const entry = buildMetricEntry(record);
        if (!entry) {
            this.logger.warn('[NukeAi] Ignored an invalid tool metric entry.');
            return;
        }
        if (!this.log.workspaceRoot()) {
            this.remember(entry);
            this.logNoWorkspace();
            return;
        }
        await this.log.append(entry);
    }

    /** Read persisted metrics oldest first, or the in-memory tail without a workspace. */
    async readEntries(): Promise<NukeAiMetricEntry[]> {
        if (!this.log.workspaceRoot()) {
            return [...this.inMemoryEntries];
        }
        const entries = await this.log.read();
        return entries.filter(isMetricEntry);
    }

    /** Return the newest `limit` entries in chronological order. */
    async recent(limit: number = NUKE_AI_METRICS_RECENT_LIMIT): Promise<NukeAiMetricEntry[]> {
        if (limit <= 0) {
            return [];
        }
        const entries = await this.readEntries();
        return entries.slice(-limit);
    }

    protected remember(entry: NukeAiMetricEntry): void {
        this.inMemoryEntries.push(entry);
        if (this.inMemoryEntries.length > MAX_IN_MEMORY_ENTRIES) {
            this.inMemoryEntries.splice(0, this.inMemoryEntries.length - MAX_IN_MEMORY_ENTRIES);
        }
    }

    protected logNoWorkspace(): void {
        if (this.noWorkspaceLogged) {
            return;
        }
        this.noWorkspaceLogged = true;
        this.logger.warn('[NukeAi] Tool metrics stay in memory because no workspace folder is open.');
    }
}

/** Aggregate entries by capability, most-used first. */
export function summarizeMetrics(entries: readonly NukeAiMetricEntry[]): NukeAiMetricSummary[] {
    interface Aggregate {
        count: number;
        succeeded: number;
        failed: number;
        totalDurationMs: number;
        lastTimestamp: string;
    }
    const byId = new Map<string, Aggregate>();
    for (const entry of entries) {
        const aggregate = byId.get(entry.capabilityId) ?? {
            count: 0,
            succeeded: 0,
            failed: 0,
            totalDurationMs: 0,
            lastTimestamp: entry.timestamp
        };
        aggregate.count++;
        if (entry.ok) {
            aggregate.succeeded++;
        } else {
            aggregate.failed++;
        }
        aggregate.totalDurationMs += entry.durationMs;
        if (entry.timestamp > aggregate.lastTimestamp) {
            aggregate.lastTimestamp = entry.timestamp;
        }
        byId.set(entry.capabilityId, aggregate);
    }
    return [...byId.entries()]
        .map(([capabilityId, aggregate]) => ({
            capabilityId,
            count: aggregate.count,
            succeeded: aggregate.succeeded,
            failed: aggregate.failed,
            averageDurationMs: Math.round(aggregate.totalDurationMs / aggregate.count),
            lastTimestamp: aggregate.lastTimestamp
        }))
        .sort((left, right) => right.count - left.count || (left.capabilityId < right.capabilityId ? -1 : 1));
}

function buildMetricEntry(record: NukeAiMetricRecord): NukeAiMetricEntry | undefined {
    if (!record || typeof record.capabilityId !== 'string' || record.capabilityId.trim().length === 0) {
        return undefined;
    }
    if (!METRIC_RISKS.includes(record.risk)) {
        return undefined;
    }
    const version = Number.isInteger(record.version) && (record.version as number) >= 1 ? (record.version as number) : 1;
    const durationMs = Number.isFinite(record.durationMs) ? Math.max(0, Math.round(record.durationMs)) : 0;
    return {
        timestamp: new Date().toISOString(),
        capabilityId: record.capabilityId,
        version,
        risk: record.risk,
        ok: record.ok === true,
        durationMs
    };
}

function isMetricEntry(value: unknown): value is NukeAiMetricEntry {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const record = value as Partial<NukeAiMetricEntry>;
    return (
        typeof record.timestamp === 'string' &&
        typeof record.capabilityId === 'string' &&
        Number.isInteger(record.version) &&
        (record.version as number) >= 1 &&
        typeof record.risk === 'string' &&
        METRIC_RISKS.includes(record.risk as NukeCapabilityRisk) &&
        typeof record.ok === 'boolean' &&
        typeof record.durationMs === 'number' &&
        Number.isFinite(record.durationMs) &&
        record.durationMs >= 0
    );
}
