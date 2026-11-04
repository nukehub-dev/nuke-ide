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
 * CAD script authoring audit journal.
 *
 * Every script inspection, sandbox preview, apply, and undo appends one JSON
 * line to `<workspace>/.nuke-ide/ai/cad-script-audit.jsonl`. Entries are built
 * from a fixed field allow-list, so script text, absolute paths, stdout/stderr,
 * and error messages can never reach the file even if a caller supplies them.
 * Writes are serialized, bounded to one 1 MiB file plus a `.1` backup, and never
 * reject into the capability that is being audited.
 *
 * @module nuke-cad/browser/capabilities
 */

import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';

/** Workspace folder that holds the CAD script audit journal. */
export const NUKE_CAD_SCRIPT_AUDIT_DIR = '.nuke-ide/ai';

/** Current audit journal file name. */
export const NUKE_CAD_SCRIPT_AUDIT_FILE = 'cad-script-audit.jsonl';

/** Single rotated audit backup; overwritten on the next rotation. */
export const NUKE_CAD_SCRIPT_AUDIT_BACKUP_FILE = 'cad-script-audit.jsonl.1';

/** Byte cap before the current audit file rotates to its single backup. */
export const NUKE_CAD_SCRIPT_AUDIT_MAX_BYTES = 1024 * 1024;

/** Sandbox resource limits recorded with a preview or apply. */
export interface ScriptAuditLimits {
    readonly timeoutSeconds: number;
    readonly memoryMb: number;
    readonly processLimit: number;
    readonly fileSizeMb: number;
}

/** One persisted script-authoring audit line. */
export interface ScriptAuditEntry {
    readonly timestamp: string;
    readonly auditId: string;
    readonly capabilityId: string;
    readonly outcome: 'preview-ok' | 'preview-failed' | 'timeout' | 'apply-ok' | 'apply-failed' | 'undo-ok' | 'undo-failed';
    readonly scriptHash?: string;
    readonly baseHash?: string;
    readonly proposedHash?: string;
    readonly durationMs?: number;
    readonly exitCode?: number | null;
    readonly timedOut?: boolean;
    readonly solidCount?: number;
    readonly warningCount?: number;
    readonly sandboxVersion?: string;
    readonly limits?: ScriptAuditLimits;
}

/** Optional byte cap used by tests. */
export interface NukeCadScriptAuditOptions {
    readonly maxBytes?: number;
}

const OUTCOMES: readonly ScriptAuditEntry['outcome'][] = [
    'preview-ok',
    'preview-failed',
    'timeout',
    'apply-ok',
    'apply-failed',
    'undo-ok',
    'undo-failed'
];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTF8_ENCODER = new TextEncoder();

/** Serialized, bounded CAD script audit journal. */
@injectable()
export class NukeCadScriptAuditService {
    protected queue: Promise<void> = Promise.resolve();
    protected noWorkspaceLogged = false;

    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(ILogger) protected readonly logger: ILogger,
        @unmanaged() protected readonly options: NukeCadScriptAuditOptions = {}
    ) {}

    /**
     * Append one audit entry after earlier writes finish.
     *
     * Invalid identifiers or outcomes are skipped, and persistence failures are
     * logged but never rejected, so auditing cannot fail a preview or apply.
     *
     * @param entry - Fixed-shape audit fields; no script text or paths.
     */
    record(entry: ScriptAuditEntry): Promise<void> {
        const sanitized = sanitizeEntry(entry);
        if (sanitized === undefined) {
            this.logger.warn('[NukeCad] Ignored an invalid CAD script audit entry.');
            return Promise.resolve();
        }
        const line = `${JSON.stringify(sanitized)}\n`;
        const run = this.queue.then(
            () => this.append(line),
            () => this.append(line)
        );
        this.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    protected async append(line: string): Promise<void> {
        const root = this.workspaceRoot();
        if (root === undefined) {
            if (!this.noWorkspaceLogged) {
                this.noWorkspaceLogged = true;
                this.logger.warn('[NukeCad] CAD script auditing is disabled because no workspace folder is open.');
            }
            return;
        }
        if (utf8Length(line) > this.maxBytes()) {
            this.logger.warn('[NukeCad] Dropped a CAD script audit entry larger than the audit file cap.');
            return;
        }
        try {
            const dirUri = URI.fromFilePath(root).resolve(NUKE_CAD_SCRIPT_AUDIT_DIR);
            const currentUri = dirUri.resolve(NUKE_CAD_SCRIPT_AUDIT_FILE);
            const backupUri = dirUri.resolve(NUKE_CAD_SCRIPT_AUDIT_BACKUP_FILE);
            await this.fileService.createFolder(dirUri, { fromUserGesture: false });
            const existing = await this.readIfExists(currentUri);
            if (existing !== undefined && utf8Length(existing) + utf8Length(line) > this.maxBytes()) {
                await this.fileService.write(backupUri, existing);
                await this.fileService.write(currentUri, line);
            } else {
                const separator = existing !== undefined && existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
                await this.fileService.write(currentUri, `${existing ?? ''}${separator}${line}`);
            }
        } catch (error) {
            this.logger.warn('[NukeCad] Failed to append the CAD script audit entry:', error);
        }
    }

    /** Absolute first workspace root, or `undefined` when no workspace is open. */
    protected workspaceRoot(): string | undefined {
        try {
            const root = this.workspaceService.tryGetRoots()[0]?.resource.path.toString();
            return root !== undefined && root.length > 0 && path.isAbsolute(root) ? root : undefined;
        } catch (error) {
            this.logger.warn('[NukeCad] Failed to read the workspace root for CAD script auditing:', error);
            return undefined;
        }
    }

    protected async readIfExists(uri: URI): Promise<string | undefined> {
        if (!(await this.fileService.exists(uri))) {
            return undefined;
        }
        return (await this.fileService.readFile(uri)).value.toString();
    }

    protected maxBytes(): number {
        return this.options.maxBytes ?? NUKE_CAD_SCRIPT_AUDIT_MAX_BYTES;
    }
}

/**
 * Build a fixed-shape record from known fields only.
 *
 * Unknown runtime properties (script text, stdout, error text, paths) are
 * dropped, hashes must be lowercase SHA-256 hex, and numeric fields must be
 * finite non-negative values.
 */
function sanitizeEntry(entry: ScriptAuditEntry): Record<string, unknown> | undefined {
    if (entry === null || typeof entry !== 'object') {
        return undefined;
    }
    const auditId = nonEmptyString(entry.auditId);
    const capabilityId = nonEmptyString(entry.capabilityId);
    if (auditId === undefined || capabilityId === undefined || !OUTCOMES.includes(entry.outcome)) {
        return undefined;
    }
    const sanitized: Record<string, unknown> = {
        timestamp: timestampOrNow(entry.timestamp),
        auditId,
        capabilityId,
        outcome: entry.outcome
    };
    addHash(sanitized, 'scriptHash', entry.scriptHash);
    addHash(sanitized, 'baseHash', entry.baseHash);
    addHash(sanitized, 'proposedHash', entry.proposedHash);
    addNonNegativeNumber(sanitized, 'durationMs', entry.durationMs);
    if (entry.exitCode === null || isNonNegativeInteger(entry.exitCode)) {
        sanitized.exitCode = entry.exitCode;
    }
    if (typeof entry.timedOut === 'boolean') {
        sanitized.timedOut = entry.timedOut;
    }
    addNonNegativeInteger(sanitized, 'solidCount', entry.solidCount);
    addNonNegativeInteger(sanitized, 'warningCount', entry.warningCount);
    const version = nonEmptyString(entry.sandboxVersion);
    if (version !== undefined) {
        sanitized.sandboxVersion = version;
    }
    if (isLimits(entry.limits)) {
        sanitized.limits = {
            timeoutSeconds: entry.limits.timeoutSeconds,
            memoryMb: entry.limits.memoryMb,
            processLimit: entry.limits.processLimit,
            fileSizeMb: entry.limits.fileSizeMb
        };
    }
    return sanitized;
}

function addHash(target: Record<string, unknown>, key: string, value: unknown): void {
    if (typeof value === 'string' && SHA256_PATTERN.test(value)) {
        target[key] = value;
    }
}

function addNonNegativeNumber(target: Record<string, unknown>, key: string, value: unknown): void {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        target[key] = value;
    }
}

function addNonNegativeInteger(target: Record<string, unknown>, key: string, value: unknown): void {
    if (isNonNegativeInteger(value)) {
        target[key] = value;
    }
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isLimits(value: unknown): value is ScriptAuditLimits {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const limits = value as Partial<ScriptAuditLimits>;
    return (
        isNonNegativeNumber(limits.timeoutSeconds) &&
        isNonNegativeNumber(limits.memoryMb) &&
        isNonNegativeNumber(limits.processLimit) &&
        isNonNegativeNumber(limits.fileSizeMb)
    );
}

function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestampOrNow(value: unknown): string {
    return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}

function utf8Length(value: string): number {
    return UTF8_ENCODER.encode(value).byteLength;
}
