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
 * Nuke Edit Journal
 *
 * Audit trail for applied capability edits. When a result carries a
 * `changeSet` or `undoToken`, one line is appended to
 * `<workspace>/.nuke-ide/ai/edits.jsonl` with the proposal identity, path list,
 * and a SHA-256 hash of the undo token. Before/after values and raw inputs are
 * never written; full previews remain in the preview store. The journal is an
 * audit trail, not an undo source: undo handlers stay in memory and the token
 * itself is never persisted.
 *
 * @module nuke-ai/browser/capabilities
 */

import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';
import { NUKE_AI_LOCAL_LOG_MAX_BYTES, NUKE_AI_LOCAL_LOG_ROOT, NukeLocalJsonlLog } from './nuke-local-log';

/** Applied-edit journal file inside the workspace config folder. */
export const NUKE_AI_EDIT_JOURNAL_FILE = 'edits.jsonl';

/** Single rotated edit journal backup; overwritten on the next rotation. */
export const NUKE_AI_EDIT_JOURNAL_BACKUP_FILE = 'edits.1.jsonl';

const MAX_JOURNAL_TEXT_LENGTH = 500;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET = /\b(api[-_]?key|token|secret|password|authorization)\b(\s*[:=]\s*)(["']?)(?!\[redacted\]|Bearer\b)[^\s"',;}]+/gi;
const UTF8_ENCODER = new TextEncoder();

/** One applied-edit journal line; it never contains before/after values. */
export interface NukeEditJournalEntry {
    readonly timestamp: string;
    readonly capabilityId: string;
    readonly changeSetId: string;
    readonly title: string;
    readonly summary: string;
    readonly paths: readonly string[];
    /** SHA-256 hex of the undo token; the raw token is never persisted. */
    readonly undoTokenHash?: string;
}

/** Optional byte cap for tests; production uses {@link NUKE_AI_LOCAL_LOG_MAX_BYTES}. */
export interface NukeEditJournalOptions {
    readonly maxBytes?: number;
}

/** Append an audit trail for applied edits; never throws into a tool call. */
@injectable()
export class NukeEditJournal {
    protected readonly log: NukeLocalJsonlLog;
    protected noWorkspaceLogged = false;
    protected hashFailureLogged = false;

    constructor(
        @inject(FileService) fileService: FileService,
        @inject(WorkspaceService) workspaceService: WorkspaceService,
        @inject(ILogger) protected readonly logger: ILogger,
        @unmanaged() options: NukeEditJournalOptions = {}
    ) {
        this.log = new NukeLocalJsonlLog(fileService, workspaceService, logger, {
            dir: NUKE_AI_LOCAL_LOG_ROOT,
            fileName: NUKE_AI_EDIT_JOURNAL_FILE,
            backupFileName: NUKE_AI_EDIT_JOURNAL_BACKUP_FILE,
            maxBytes: options.maxBytes ?? NUKE_AI_LOCAL_LOG_MAX_BYTES
        });
    }

    /**
     * Journal one result that carries a change set or an undo token. Results
     * without either are ignored. A failed write is logged and never rejects.
     */
    async record(capabilityId: string, result: NukeCapabilityResult): Promise<void> {
        if (!result.changeSet && !result.undoToken) {
            return;
        }
        if (!this.log.workspaceRoot()) {
            this.logNoWorkspace();
            return;
        }
        const undoTokenHash = result.undoToken ? await this.hashToken(result.undoToken) : undefined;
        await this.log.append(buildEntry(capabilityId, result, undoTokenHash));
    }

    /** Read persisted journal entries oldest first. */
    async readEntries(): Promise<NukeEditJournalEntry[]> {
        if (!this.log.workspaceRoot()) {
            return [];
        }
        const entries = await this.log.read();
        return entries.filter(isJournalEntry);
    }

    protected async hashToken(token: string): Promise<string | undefined> {
        const hash = await hashUndoToken(token);
        if (!hash && !this.hashFailureLogged) {
            this.hashFailureLogged = true;
            this.logger.warn('[NukeAi] Could not hash an undo token for the edit journal; the hash was omitted.');
        }
        return hash;
    }

    protected logNoWorkspace(): void {
        if (this.noWorkspaceLogged) {
            return;
        }
        this.noWorkspaceLogged = true;
        this.logger.warn('[NukeAi] Edit journaling is disabled because no workspace folder is open.');
    }
}

/** SHA-256 hex digest of an undo token, or `undefined` when Web Crypto is unavailable. */
export async function hashUndoToken(token: string): Promise<string | undefined> {
    try {
        const digest = await globalThis.crypto.subtle.digest('SHA-256', UTF8_ENCODER.encode(token));
        return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return undefined;
    }
}

function buildEntry(capabilityId: string, result: NukeCapabilityResult, undoTokenHash: string | undefined): NukeEditJournalEntry {
    const changeSet = result.changeSet;
    const paths = [...new Set((changeSet?.changes ?? []).map((change) => redactText(change.path)))].filter((path) => path.length > 0);
    return {
        timestamp: new Date().toISOString(),
        capabilityId,
        changeSetId: redactText(changeSet?.id ?? ''),
        title: redactText(changeSet?.title ?? ''),
        summary: redactText(changeSet?.summary ?? ''),
        paths,
        ...(undoTokenHash !== undefined ? { undoTokenHash } : {})
    };
}

function redactText(value: string): string {
    const redacted = value.replace(BEARER_SECRET, 'Bearer [redacted]').replace(KEY_VALUE_SECRET, '$1$2$3[redacted]');
    return redacted.length > MAX_JOURNAL_TEXT_LENGTH ? redacted.slice(0, MAX_JOURNAL_TEXT_LENGTH) : redacted;
}

function isJournalEntry(value: unknown): value is NukeEditJournalEntry {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const record = value as Partial<NukeEditJournalEntry>;
    return (
        typeof record.timestamp === 'string' &&
        typeof record.capabilityId === 'string' &&
        typeof record.changeSetId === 'string' &&
        typeof record.title === 'string' &&
        typeof record.summary === 'string' &&
        Array.isArray(record.paths) &&
        record.paths.every((path) => typeof path === 'string')
    );
}
