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
 * Tests the serialized, bounded CAD script audit journal.
 */

import { describe, expect, it, vi } from 'vitest';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import type { FileContent, FileStat } from '@theia/filesystem/lib/common/files';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import {
    NUKE_CAD_SCRIPT_AUDIT_BACKUP_FILE,
    NUKE_CAD_SCRIPT_AUDIT_FILE,
    NUKE_CAD_SCRIPT_AUDIT_MAX_BYTES,
    NukeCadScriptAuditOptions,
    NukeCadScriptAuditService,
    ScriptAuditEntry
} from './script-audit-service';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));

const WORKSPACE = '/workspace';
const AUDIT_PATH = '/workspace/.nuke-ide/ai/cad-script-audit.jsonl';
const BACKUP_PATH = '/workspace/.nuke-ide/ai/cad-script-audit.jsonl.1';

class FakeAuditFileService {
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

    async readFile(uri: URI): Promise<FileContent> {
        const value = this.files.get(key(uri));
        if (value === undefined) {
            throw new Error(`missing file: ${key(uri)}`);
        }
        return { value: BinaryBuffer.fromString(value) } as FileContent;
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
            size: this.files.get(target)?.length ?? 0,
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
                    size: 0,
                    isFile: false,
                    isDirectory: true,
                    isSymbolicLink: false,
                    isReadonly: false
                }) as FileStat
        );
    }
}

type FakeLogger = ILogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

function createLogger(): FakeLogger {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn()
    } as unknown as FakeLogger;
}

function setup(options: { roots?: string[]; maxBytes?: number } = {}): {
    fileService: FakeAuditFileService;
    logger: FakeLogger;
    service: NukeCadScriptAuditService;
} {
    const fileService = new FakeAuditFileService();
    const logger = createLogger();
    const service = new NukeCadScriptAuditService(
        fileService as unknown as FileService,
        new FakeWorkspaceService(options.roots ?? [WORKSPACE]) as unknown as WorkspaceService,
        logger,
        { maxBytes: options.maxBytes } as NukeCadScriptAuditOptions
    );
    return { fileService, logger, service };
}

function key(uri: URI): string {
    return uri.path.toString();
}

function lines(fileService: FakeAuditFileService, target = AUDIT_PATH): Record<string, unknown>[] {
    const content = fileService.files.get(target);
    if (content === undefined) {
        throw new Error(`missing file: ${target}`);
    }
    return content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function entry(overrides: Partial<ScriptAuditEntry> = {}): ScriptAuditEntry {
    return {
        timestamp: '2026-01-01T00:00:00.000Z',
        auditId: 'audit-1',
        capabilityId: 'nuke.cad.previewScriptChange',
        outcome: 'preview-ok',
        ...overrides
    };
}

describe('NukeCadScriptAuditService', () => {
    it('writes the complete fixed-shape entry as one JSON line', async () => {
        const { fileService, service } = setup();

        await service.record({
            ...entry(),
            scriptHash: 'a'.repeat(64),
            baseHash: 'b'.repeat(64),
            proposedHash: 'c'.repeat(64),
            durationMs: 321,
            exitCode: 0,
            timedOut: false,
            solidCount: 1,
            warningCount: 2,
            sandboxVersion: 'bubblewrap 0.8.0',
            limits: { timeoutSeconds: 120, memoryMb: 2048, processLimit: 64, fileSizeMb: 128 }
        });

        const [row] = lines(fileService);
        expect(Object.keys(row)).toEqual([
            'timestamp',
            'auditId',
            'capabilityId',
            'outcome',
            'scriptHash',
            'baseHash',
            'proposedHash',
            'durationMs',
            'exitCode',
            'timedOut',
            'solidCount',
            'warningCount',
            'sandboxVersion',
            'limits'
        ]);
        expect(row).toEqual({
            timestamp: '2026-01-01T00:00:00.000Z',
            auditId: 'audit-1',
            capabilityId: 'nuke.cad.previewScriptChange',
            outcome: 'preview-ok',
            scriptHash: 'a'.repeat(64),
            baseHash: 'b'.repeat(64),
            proposedHash: 'c'.repeat(64),
            durationMs: 321,
            exitCode: 0,
            timedOut: false,
            solidCount: 1,
            warningCount: 2,
            sandboxVersion: 'bubblewrap 0.8.0',
            limits: { timeoutSeconds: 120, memoryMb: 2048, processLimit: 64, fileSizeMb: 128 }
        });
    });

    it('never persists script text, paths, stdout/stderr, or error strings', async () => {
        const { fileService, service } = setup();
        const unsafe = {
            ...entry(),
            scriptText: 'model = open("/etc/passwd").read()',
            proposedScript: 'model = Box(1, 2, 3)',
            path: '/workspace/secret.py',
            stdout: 'BUILD OK',
            stderr: 'traceback',
            error: 'boom'
        } as unknown as ScriptAuditEntry;

        await service.record(unsafe);

        const content = fileService.files.get(AUDIT_PATH)!;
        expect(content).not.toContain('model =');
        expect(content).not.toContain('/workspace/secret.py');
        expect(content).not.toContain('BUILD OK');
        expect(content).not.toContain('traceback');
        expect(content).not.toContain('boom');
        expect(lines(fileService)[0]).toEqual({
            timestamp: '2026-01-01T00:00:00.000Z',
            auditId: 'audit-1',
            capabilityId: 'nuke.cad.previewScriptChange',
            outcome: 'preview-ok'
        });
    });

    it('omits malformed hashes and numeric fields instead of widening the record', async () => {
        const { fileService, service } = setup();

        await service.record({
            ...entry(),
            scriptHash: 'not-a-hash',
            baseHash: 'A'.repeat(64),
            exitCode: -1,
            durationMs: Number.NaN,
            solidCount: 1.5,
            limits: { timeoutSeconds: 120, memoryMb: 2048, processLimit: 64, fileSizeMb: -1 }
        });

        expect(lines(fileService)[0]).toEqual({
            timestamp: '2026-01-01T00:00:00.000Z',
            auditId: 'audit-1',
            capabilityId: 'nuke.cad.previewScriptChange',
            outcome: 'preview-ok'
        });
    });

    it('skips invalid identifiers and outcomes', async () => {
        const { fileService, logger, service } = setup();

        await service.record(entry({ auditId: '' }));
        await service.record(entry({ capabilityId: '' }));
        await service.record(entry({ outcome: 'made-up' as ScriptAuditEntry['outcome'] }));

        expect(fileService.files.has(AUDIT_PATH)).toBe(false);
        expect(logger.warn).toHaveBeenCalledTimes(3);
        expect(logger.warn).toHaveBeenCalledWith('[NukeCad] Ignored an invalid CAD script audit entry.');
    });

    it('serializes concurrent writes', async () => {
        const { fileService, service } = setup();
        fileService.writeDelayMs = 5;

        await Promise.all([
            service.record(entry({ auditId: 'audit-1' })),
            service.record(entry({ auditId: 'audit-2' })),
            service.record(entry({ auditId: 'audit-3' }))
        ]);

        expect(fileService.maxActiveWrites).toBe(1);
        expect(lines(fileService).map((row) => row.auditId)).toEqual(['audit-1', 'audit-2', 'audit-3']);
    });

    it('rotates the current file to a single .1 backup at the byte cap', async () => {
        const { fileService, service } = setup({ maxBytes: 200 });

        await service.record(entry({ auditId: 'audit-1' }));
        await service.record(entry({ auditId: 'audit-2' }));
        await service.record(entry({ auditId: 'audit-3' }));

        expect(lines(fileService).map((row) => row.auditId)).toEqual(['audit-3']);
        expect(lines(fileService, BACKUP_PATH).map((row) => row.auditId)).toEqual(['audit-2']);
        expect(BACKUP_PATH.endsWith(NUKE_CAD_SCRIPT_AUDIT_BACKUP_FILE)).toBe(true);
        expect(new TextEncoder().encode(fileService.files.get(AUDIT_PATH)!).byteLength).toBeLessThanOrEqual(200);
    });

    it('drops a single entry larger than the byte cap', async () => {
        const { fileService, logger, service } = setup({ maxBytes: 50 });

        await service.record(entry());

        expect(fileService.files.has(AUDIT_PATH)).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith('[NukeCad] Dropped a CAD script audit entry larger than the audit file cap.');
    });

    it('logs a write failure and resolves without throwing', async () => {
        const { fileService, logger, service } = setup();
        fileService.failWrites = true;

        await expect(service.record(entry())).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledWith('[NukeCad] Failed to append the CAD script audit entry:', expect.any(Error));
        expect(fileService.files.has(AUDIT_PATH)).toBe(false);
    });

    it('warns once and skips persistence without a workspace', async () => {
        const { fileService, logger, service } = setup({ roots: [] });

        await service.record(entry({ auditId: 'audit-1' }));
        await service.record(entry({ auditId: 'audit-2' }));

        expect(fileService.files.size).toBe(0);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('[NukeCad] CAD script auditing is disabled because no workspace folder is open.');
    });

    it('uses the workspace-local audit path and 1 MiB default cap', () => {
        expect(AUDIT_PATH).toBe(`/workspace/.nuke-ide/ai/${NUKE_CAD_SCRIPT_AUDIT_FILE}`);
        expect(BACKUP_PATH).toBe(`/workspace/.nuke-ide/ai/${NUKE_CAD_SCRIPT_AUDIT_BACKUP_FILE}`);
        expect(NUKE_CAD_SCRIPT_AUDIT_FILE).toBe('cad-script-audit.jsonl');
        expect(NUKE_CAD_SCRIPT_AUDIT_BACKUP_FILE).toBe('cad-script-audit.jsonl.1');
        expect(NUKE_CAD_SCRIPT_AUDIT_MAX_BYTES).toBe(1024 * 1024);
    });
});
