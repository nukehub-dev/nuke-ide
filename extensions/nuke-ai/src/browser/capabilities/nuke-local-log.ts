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
 * Nuke Local JSONL Log
 *
 * Serialized, bounded append-only log under the workspace config folder. One
 * backup file is kept: when the current file would exceed the byte cap, its
 * content moves to the backup and the new line starts a fresh current file.
 * The backup is overwritten on the next rotation. Writes never reject into the
 * caller; a failure is logged instead.
 *
 * @module nuke-ai/browser/capabilities
 */

import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';

/** Workspace folder that holds NukeAI local logs. */
export const NUKE_AI_LOCAL_LOG_ROOT = '.nuke-ide/ai';

/** Byte cap before the current log rotates to its single backup. */
export const NUKE_AI_LOCAL_LOG_MAX_BYTES = 1024 * 1024;

const UTF8_ENCODER = new TextEncoder();

/** File names and byte cap for one local append-only log. */
export interface NukeLocalLogOptions {
    readonly dir: string;
    readonly fileName: string;
    readonly backupFileName: string;
    readonly maxBytes?: number;
}

/** Serialized JSON-lines log with one rotated backup. */
export class NukeLocalJsonlLog {
    protected queue: Promise<void> = Promise.resolve();

    constructor(
        protected readonly fileService: FileService,
        protected readonly workspaceService: WorkspaceService,
        protected readonly logger: ILogger,
        protected readonly options: NukeLocalLogOptions
    ) {}

    /** Absolute first workspace root, or `undefined` when no workspace is open. */
    workspaceRoot(): string | undefined {
        try {
            const root = this.workspaceService.tryGetRoots()[0]?.resource.path.toString();
            return root !== undefined && root.length > 0 && path.isAbsolute(root) ? root : undefined;
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to read the workspace root for ${this.options.fileName}:`, error);
            return undefined;
        }
    }

    /**
     * Append one JSON line after earlier writes finish.
     *
     * @returns `true` when the line was persisted; `false` without a workspace
     * or after a logged write failure.
     */
    append(entry: unknown): Promise<boolean> {
        const line = `${JSON.stringify(entry)}\n`;
        const run = this.queue.then(
            () => this.performAppend(line),
            () => this.performAppend(line)
        );
        this.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    /** Read every parseable line from the backup and current file, oldest first. */
    read(): Promise<unknown[]> {
        const run = this.queue.then(
            () => this.performRead(),
            () => this.performRead()
        );
        this.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    protected async performAppend(line: string): Promise<boolean> {
        const root = this.workspaceRoot();
        if (!root) {
            return false;
        }
        const dirUri = URI.fromFilePath(root).resolve(this.options.dir);
        const currentUri = dirUri.resolve(this.options.fileName);
        try {
            await this.fileService.createFolder(dirUri, { fromUserGesture: false });
            const existing = await this.readIfExists(currentUri);
            if (existing !== undefined && utf8Length(existing) + utf8Length(line) > this.maxBytes()) {
                await this.fileService.write(dirUri.resolve(this.options.backupFileName), existing);
                await this.fileService.write(currentUri, line);
            } else {
                const separator = existing !== undefined && existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
                await this.fileService.write(currentUri, `${existing ?? ''}${separator}${line}`);
            }
            return true;
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to write ${this.options.fileName}:`, error);
            return false;
        }
    }

    protected async performRead(): Promise<unknown[]> {
        const root = this.workspaceRoot();
        if (!root) {
            return [];
        }
        const dirUri = URI.fromFilePath(root).resolve(this.options.dir);
        const entries: unknown[] = [];
        try {
            for (const name of [this.options.backupFileName, this.options.fileName]) {
                const text = await this.readIfExists(dirUri.resolve(name));
                if (text === undefined) {
                    continue;
                }
                for (const line of text.split('\n')) {
                    if (line.trim().length === 0) {
                        continue;
                    }
                    try {
                        entries.push(JSON.parse(line));
                    } catch {
                        // A malformed line is skipped; it never hides later entries.
                    }
                }
            }
        } catch (error) {
            this.logger.warn(`[NukeAi] Failed to read ${this.options.fileName}:`, error);
        }
        return entries;
    }

    protected async readIfExists(uri: URI): Promise<string | undefined> {
        if (!(await this.fileService.exists(uri))) {
            return undefined;
        }
        return (await this.fileService.read(uri)).value;
    }

    protected maxBytes(): number {
        return this.options.maxBytes ?? NUKE_AI_LOCAL_LOG_MAX_BYTES;
    }
}

function utf8Length(value: string): number {
    return UTF8_ENCODER.encode(value).byteLength;
}
