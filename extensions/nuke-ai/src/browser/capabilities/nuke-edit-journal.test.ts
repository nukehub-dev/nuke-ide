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

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import { NukeCapabilityResult, NukeChangeSet } from 'nuke-core/lib/common/nuke-capability-protocol';
import { NukeEditJournal, hashUndoToken } from './nuke-edit-journal';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));

const JOURNAL_PATH = '/workspace/.nuke-ide/ai/edits.jsonl';
const BACKUP_PATH = '/workspace/.nuke-ide/ai/edits.1.jsonl';

class FakeFileService {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>(['/']);
    failWrites = false;
    writeDelayMs = 0;
    activeWrites = 0;
    maxActiveWrites = 0;

    async exists(uri: URI): Promise<boolean> {
        const target = key(uri);
        return this.files.has(target) || this.directories.has(target);
    }

    async createFolder(uri: URI): Promise<FileStat> {
        if (this.failWrites) {
            throw new Error('write failed');
        }
        this.ensureDirectory(key(uri));
        return this.statFor(key(uri), uri);
    }

    async write(uri: URI, value: string): Promise<FileStat> {
        this.activeWrites++;
        this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
        try {
            if (this.writeDelayMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, this.writeDelayMs));
            }
            if (this.failWrites) {
                throw new Error('write failed');
            }
            const target = key(uri);
            this.ensureDirectory(path.dirname(target));
            this.files.set(target, value);
            return this.statFor(target, uri);
        } finally {
            this.activeWrites--;
        }
    }

    async resolve(uri: URI): Promise<FileStat> {
        const target = key(uri);
        if (!this.files.has(target) && !this.directories.has(target)) {
            throw new Error(`missing: ${target}`);
        }
        return this.statFor(target, uri);
    }

    async read(uri: URI): Promise<{ value: string }> {
        const value = this.files.get(key(uri));
        if (value === undefined) {
            throw new Error(`missing file: ${key(uri)}`);
        }
        return { value };
    }

    protected ensureDirectory(target: string): void {
        if (target === '/' || this.directories.has(target)) {
            return;
        }
        this.ensureDirectory(path.dirname(target));
        this.directories.add(target);
    }

    protected statFor(target: string, uri: URI): FileStat {
        return {
            resource: uri,
            name: path.basename(target),
            isFile: !this.directories.has(target),
            isDirectory: this.directories.has(target),
            isSymbolicLink: false,
            isReadonly: false
        } as FileStat;
    }
}

class FakeWorkspaceService {
    constructor(readonly roots: string[]) {}

    tryGetRoots(): FileStat[] {
        return this.roots.map(
            (root) =>
                ({
                    resource: URI.fromFilePath(root),
                    name: path.basename(root),
                    isFile: false,
                    isDirectory: true,
                    isSymbolicLink: false,
                    isReadonly: false
                }) as FileStat
        );
    }
}

function createLogger(): ILogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn()
    } as unknown as ILogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function setup(options: { roots?: string[]; maxBytes?: number } = {}): {
    fileService: FakeFileService;
    logger: ILogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    journal: NukeEditJournal;
} {
    const fileService = new FakeFileService();
    const logger = createLogger();
    const journal = new NukeEditJournal(
        fileService as unknown as FileService,
        new FakeWorkspaceService(options.roots ?? ['/workspace']) as unknown as WorkspaceService,
        logger,
        { maxBytes: options.maxBytes }
    );
    return { fileService, logger, journal };
}

function key(uri: URI): string {
    return uri.path.toString();
}

function lines(fileService: FakeFileService, target = JOURNAL_PATH): Record<string, unknown>[] {
    const content = fileService.files.get(target);
    if (content === undefined) {
        throw new Error(`missing file: ${target}`);
    }
    return content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function changeSet(overrides: Partial<NukeChangeSet> = {}): NukeChangeSet {
    return {
        id: 'proposal-1',
        title: 'Run settings token: abc123',
        summary: 'Increase batches and particles.',
        changes: [
            { path: 'run.batches', label: 'Batches', kind: 'update', before: 'before-value', after: 'after-value' },
            { path: 'run.batches', label: 'Batches', kind: 'update' },
            { path: 'run.particles', label: 'Particles', kind: 'update' }
        ],
        ...overrides
    };
}

describe('NukeEditJournal', () => {
    it('writes the audit shape with a hashed token and no before/after values', async () => {
        const { fileService, journal } = setup();
        const result: NukeCapabilityResult = { ok: true, changeSet: changeSet(), undoToken: 'undo-secret-token' };

        await journal.record('nuke.openmc.applySettings', result);

        const [entry] = lines(fileService);
        expect(Object.keys(entry)).toEqual(['timestamp', 'capabilityId', 'changeSetId', 'title', 'summary', 'paths', 'undoTokenHash']);
        expect(entry).toMatchObject({
            capabilityId: 'nuke.openmc.applySettings',
            changeSetId: 'proposal-1',
            title: 'Run settings token: [redacted]',
            summary: 'Increase batches and particles.',
            paths: ['run.batches', 'run.particles']
        });
        expect(entry.undoTokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.undoTokenHash).not.toBe('undo-secret-token');

        const content = fileService.files.get(JOURNAL_PATH) as string;
        expect(content).not.toContain('undo-secret-token');
        expect(content).not.toContain('before-value');
        expect(content).not.toContain('after-value');
        expect(content).not.toContain('abc123');
    });

    it('hashes an undo token with SHA-256', async () => {
        const expected = createHash('sha256').update('undo-secret-token', 'utf8').digest('hex');

        await expect(hashUndoToken('undo-secret-token')).resolves.toBe(expected);
    });

    it('journals a token-only result with empty change set fields', async () => {
        const { fileService, journal } = setup();

        await journal.record('nuke.openmc.applySettings', { ok: true, undoToken: 'token-only' });

        const [entry] = lines(fileService);
        expect(entry).toMatchObject({
            capabilityId: 'nuke.openmc.applySettings',
            changeSetId: '',
            title: '',
            summary: '',
            paths: []
        });
        expect(entry.undoTokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not write a result without a change set or undo token', async () => {
        const { fileService, journal } = setup();

        await journal.record('nuke.example.read', { ok: true, message: 'Read.' });

        expect(fileService.files.size).toBe(0);
    });

    it('rotates the current file to one backup and overwrites the older backup', async () => {
        const { fileService, journal } = setup({ maxBytes: 300 });
        const makeResult = (id: string): NukeCapabilityResult => ({
            ok: true,
            changeSet: changeSet({ id, title: 'Settings', summary: 'A change.' })
        });

        await journal.record('nuke.openmc.applySettings', makeResult('proposal-1'));
        await journal.record('nuke.openmc.applySettings', makeResult('proposal-2'));
        expect(lines(fileService, BACKUP_PATH).map((entry) => entry.changeSetId)).toEqual(['proposal-1']);
        expect(lines(fileService).map((entry) => entry.changeSetId)).toEqual(['proposal-2']);

        await journal.record('nuke.openmc.applySettings', makeResult('proposal-3'));
        expect(lines(fileService, BACKUP_PATH).map((entry) => entry.changeSetId)).toEqual(['proposal-2']);
        expect(lines(fileService).map((entry) => entry.changeSetId)).toEqual(['proposal-3']);

        expect((await journal.readEntries()).map((entry) => entry.changeSetId)).toEqual(['proposal-2', 'proposal-3']);
    });

    it('logs a failed write and never rejects', async () => {
        const { fileService, logger, journal } = setup();
        fileService.failWrites = true;

        await expect(
            journal.record('nuke.openmc.applySettings', { ok: true, changeSet: changeSet(), undoToken: 'undo-1' })
        ).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to write edits.jsonl'), expect.any(Error));
    });

    it('skips journaling and logs once without a workspace', async () => {
        const { fileService, logger, journal } = setup({ roots: [] });

        await journal.record('nuke.openmc.applySettings', { ok: true, changeSet: changeSet() });
        await journal.record('nuke.openmc.applySettings', { ok: true, undoToken: 'undo-2' });

        expect(fileService.files.size).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(await journal.readEntries()).toEqual([]);
    });

    it('serializes concurrent appends', async () => {
        const { fileService, journal } = setup();
        fileService.writeDelayMs = 1;

        await Promise.all(
            Array.from({ length: 6 }, (_, index) =>
                journal.record('nuke.openmc.applySettings', {
                    ok: true,
                    changeSet: changeSet({ id: `proposal-${index}`, title: 'Settings', summary: 'A change.' })
                })
            )
        );

        expect(fileService.maxActiveWrites).toBe(1);
        expect(lines(fileService).map((entry) => entry.changeSetId)).toEqual(Array.from({ length: 6 }, (_, index) => `proposal-${index}`));
    });
});
