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
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import { NukeAiMetricEntry, NukeAiMetricsService, summarizeMetrics } from './nuke-ai-metrics-service';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));

const METRICS_PATH = '/workspace/.nuke-ide/ai/metrics.jsonl';
const BACKUP_PATH = '/workspace/.nuke-ide/ai/metrics.1.jsonl';

class FakeFileService {
    readonly files = new Map<string, string>();
    readonly directories = new Set<string>(['/']);
    readonly symlinks = new Set<string>();
    failWrites = false;

    addSymlink(target: string): void {
        this.ensureDirectory(path.dirname(target));
        this.symlinks.add(target);
    }
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
        if (!this.files.has(target) && !this.directories.has(target) && !this.symlinks.has(target)) {
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
            isSymbolicLink: this.symlinks.has(target),
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
    service: NukeAiMetricsService;
} {
    const fileService = new FakeFileService();
    const logger = createLogger();
    const service = new NukeAiMetricsService(
        fileService as unknown as FileService,
        new FakeWorkspaceService(options.roots ?? ['/workspace']) as unknown as WorkspaceService,
        logger,
        { maxBytes: options.maxBytes }
    );
    return { fileService, logger, service };
}

function key(uri: URI): string {
    return uri.path.toString();
}

function lines(fileService: FakeFileService, target = METRICS_PATH): Record<string, unknown>[] {
    const content = fileService.files.get(target);
    if (content === undefined) {
        throw new Error(`missing file: ${target}`);
    }
    return content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function record(overrides: Partial<NukeAiMetricEntry> = {}): Parameters<NukeAiMetricsService['record']>[0] {
    return {
        capabilityId: 'nuke.example.describe',
        version: 2,
        risk: 'read',
        ok: true,
        durationMs: 12,
        ...overrides
    };
}

describe('NukeAiMetricsService', () => {
    it('writes the exact metric shape and rounds the duration', async () => {
        const { fileService, service } = setup();

        await service.record(record({ durationMs: 12.6 }));

        const [entry] = lines(fileService);
        expect(Object.keys(entry)).toEqual(['timestamp', 'capabilityId', 'version', 'risk', 'ok', 'durationMs']);
        expect(entry).toMatchObject({
            capabilityId: 'nuke.example.describe',
            version: 2,
            risk: 'read',
            ok: true,
            durationMs: 13
        });
        expect(typeof entry.timestamp).toBe('string');
        expect(Number.isNaN(Date.parse(entry.timestamp as string))).toBe(false);
    });

    it('drops inputs, paths, file contents, and tokens supplied at runtime', async () => {
        const { fileService, service } = setup();
        const unsafe = {
            ...record({ capabilityId: 'nuke.example.write', risk: 'write', ok: false }),
            input: { path: '/workspace/secret.model', contents: 'file-bytes' },
            path: '/workspace/secret.model',
            token: 'secret-token'
        } as unknown as Parameters<NukeAiMetricsService['record']>[0];

        await service.record(unsafe);

        const content = fileService.files.get(METRICS_PATH) as string;
        expect(content).not.toContain('secret.model');
        expect(content).not.toContain('file-bytes');
        expect(content).not.toContain('secret-token');
        expect(Object.keys(lines(fileService)[0])).toEqual(['timestamp', 'capabilityId', 'version', 'risk', 'ok', 'durationMs']);
    });

    it('defaults a missing or invalid version to 1', async () => {
        const { fileService, service } = setup();

        await service.record({ capabilityId: 'nuke.example.noVersion', risk: 'read', ok: true, durationMs: 1 });
        await service.record(record({ capabilityId: 'nuke.example.badVersion', version: 0 }));

        expect(lines(fileService).map((entry) => entry.version)).toEqual([1, 1]);
    });

    it('rotates the current file to one backup and overwrites the older backup', async () => {
        const { fileService, service } = setup({ maxBytes: 250 });

        await service.record(record({ capabilityId: 'nuke.example.first' }));
        await service.record(record({ capabilityId: 'nuke.example.second' }));
        expect(lines(fileService, BACKUP_PATH).map((entry) => entry.capabilityId)).toEqual(['nuke.example.first']);
        expect(lines(fileService).map((entry) => entry.capabilityId)).toEqual(['nuke.example.second']);

        await service.record(record({ capabilityId: 'nuke.example.third' }));
        expect(lines(fileService, BACKUP_PATH).map((entry) => entry.capabilityId)).toEqual(['nuke.example.second']);
        expect(lines(fileService).map((entry) => entry.capabilityId)).toEqual(['nuke.example.third']);

        const all = await service.readEntries();
        expect(all.map((entry) => entry.capabilityId)).toEqual(['nuke.example.second', 'nuke.example.third']);
    });

    it('refuses to write through a symlinked workspace log directory', async () => {
        const { fileService, logger, service } = setup();
        fileService.addSymlink('/workspace/.nuke-ide');

        await service.record(record());

        expect(fileService.files.has(METRICS_PATH)).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('symlinked'));
    });

    it('refuses to write a line larger than the journal cap', async () => {
        const { fileService, logger, service } = setup({ maxBytes: 50 });

        await service.record(record());

        expect(fileService.files.has(METRICS_PATH)).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('oversized'));
    });

    it('logs a failed write and never rejects', async () => {
        const { fileService, logger, service } = setup();
        fileService.failWrites = true;

        await expect(service.record(record())).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to write metrics.jsonl'), expect.any(Error));
    });

    it('keeps entries in memory and logs once without a workspace', async () => {
        const { fileService, logger, service } = setup({ roots: [] });

        await service.record(record({ capabilityId: 'nuke.example.one' }));
        await service.record(record({ capabilityId: 'nuke.example.two' }));

        expect(fileService.files.size).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect((await service.readEntries()).map((entry) => entry.capabilityId)).toEqual(['nuke.example.one', 'nuke.example.two']);
        expect(await service.recent(1)).toEqual([expect.objectContaining({ capabilityId: 'nuke.example.two' })]);
    });

    it('serializes concurrent appends and preserves order', async () => {
        const { fileService, service } = setup();
        fileService.writeDelayMs = 1;

        await Promise.all(Array.from({ length: 6 }, (_, index) => service.record(record({ capabilityId: `nuke.example.entry${index}` }))));

        expect(fileService.maxActiveWrites).toBe(1);
        expect(lines(fileService).map((entry) => entry.capabilityId)).toEqual(
            Array.from({ length: 6 }, (_, index) => `nuke.example.entry${index}`)
        );
    });

    it('skips malformed persisted lines when reading', async () => {
        const { fileService, service } = setup();
        fileService.files.set(METRICS_PATH, '{"timestamp":"2026-01-01T00:00:00.000Z"}\nnot-json\n');

        expect(await service.readEntries()).toEqual([]);
    });

    it('summarizes counts, failures, and average duration by capability', () => {
        const entries: NukeAiMetricEntry[] = [
            {
                timestamp: '2026-01-01T00:00:00.000Z',
                capabilityId: 'nuke.example.one',
                version: 1,
                risk: 'read',
                ok: true,
                durationMs: 10
            },
            {
                timestamp: '2026-01-01T00:00:01.000Z',
                capabilityId: 'nuke.example.one',
                version: 1,
                risk: 'read',
                ok: false,
                durationMs: 20
            },
            {
                timestamp: '2026-01-01T00:00:02.000Z',
                capabilityId: 'nuke.example.two',
                version: 2,
                risk: 'write',
                ok: true,
                durationMs: 5
            }
        ];

        expect(summarizeMetrics(entries)).toEqual([
            {
                capabilityId: 'nuke.example.one',
                count: 2,
                succeeded: 1,
                failed: 1,
                averageDurationMs: 15,
                lastTimestamp: '2026-01-01T00:00:01.000Z'
            },
            {
                capabilityId: 'nuke.example.two',
                count: 1,
                succeeded: 1,
                failed: 0,
                averageDurationMs: 5,
                lastTimestamp: '2026-01-01T00:00:02.000Z'
            }
        ]);
    });
});
