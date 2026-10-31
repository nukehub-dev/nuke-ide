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
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import { NukeCapabilityResult } from 'nuke-core/lib/common/nuke-capability-protocol';
import { MAX_PERSISTED_PREVIEW_BYTES, NukePreviewSession, bytesToBase64 } from '../../common/nuke-preview-protocol';
import { NukePreviewStore } from './nuke-preview-store';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));

interface FakeEntry {
    readonly directory: boolean;
    readonly bytes?: Uint8Array;
    readonly mtime: number;
}

class FakeFileService {
    readonly entries = new Map<string, FakeEntry>();
    readonly calls: string[] = [];
    failWrites = false;

    constructor() {
        this.entries.set('/', { directory: true, mtime: 0 });
    }

    addFile(target: string, bytes: Uint8Array): void {
        this.ensureDirectory(path.dirname(target));
        this.entries.set(target, { directory: false, bytes, mtime: 0 });
    }

    textAt(target: string): string {
        const entry = this.entries.get(target);
        if (!entry?.bytes) {
            throw new Error(`missing file: ${target}`);
        }
        return new TextDecoder().decode(entry.bytes);
    }

    bytesAt(target: string): Uint8Array | undefined {
        return this.entries.get(target)?.bytes;
    }

    async exists(uri: URI): Promise<boolean> {
        return this.entries.has(key(uri));
    }

    async createFolder(uri: URI): Promise<FileStat> {
        if (this.failWrites) {
            throw new Error('write failed');
        }
        const target = key(uri);
        this.calls.push(`createFolder:${target}`);
        this.ensureDirectory(target);
        return this.statFor(target, uri);
    }

    async write(uri: URI, value: string): Promise<FileStat> {
        if (this.failWrites) {
            throw new Error('write failed');
        }
        const target = key(uri);
        this.calls.push(`write:${target}`);
        this.ensureDirectory(path.dirname(target));
        this.entries.set(target, { directory: false, bytes: new TextEncoder().encode(value), mtime: 0 });
        return this.statFor(target, uri);
    }

    async writeFile(uri: URI, value: BinaryBuffer): Promise<FileStat> {
        if (this.failWrites) {
            throw new Error('write failed');
        }
        const target = key(uri);
        this.calls.push(`writeFile:${target}`);
        this.ensureDirectory(path.dirname(target));
        this.entries.set(target, { directory: false, bytes: new Uint8Array(value.buffer), mtime: 0 });
        return this.statFor(target, uri);
    }

    async read(uri: URI): Promise<{ value: string }> {
        return { value: this.textAt(key(uri)) };
    }

    async readFile(uri: URI): Promise<{ value: BinaryBuffer }> {
        const entry = this.entries.get(key(uri));
        if (!entry?.bytes) {
            throw new Error(`missing file: ${key(uri)}`);
        }
        return { value: BinaryBuffer.wrap(entry.bytes) };
    }

    async resolve(uri: URI): Promise<FileStat> {
        const target = key(uri);
        const entry = this.entries.get(target);
        if (!entry) {
            throw new Error(`missing: ${target}`);
        }
        const children = entry.directory ? this.childrenOf(target) : undefined;
        return {
            resource: uri,
            name: path.basename(target),
            isFile: !entry.directory,
            isDirectory: entry.directory,
            isSymbolicLink: false,
            isReadonly: false,
            mtime: entry.mtime,
            size: entry.bytes?.byteLength ?? 0,
            ...(children ? { children } : {})
        } as FileStat;
    }

    protected childrenOf(parent: string): FileStat[] {
        const prefix = parent.endsWith('/') ? parent : `${parent}/`;
        const children: FileStat[] = [];
        for (const [candidate, entry] of this.entries) {
            if (!candidate.startsWith(prefix)) {
                continue;
            }
            const relative = candidate.slice(prefix.length);
            if (relative.length === 0 || relative.includes('/')) {
                continue;
            }
            children.push({
                resource: URI.fromFilePath(candidate),
                name: relative,
                isFile: !entry.directory,
                isDirectory: entry.directory,
                isSymbolicLink: false,
                isReadonly: false,
                mtime: entry.mtime,
                size: entry.bytes?.byteLength ?? 0
            } as FileStat);
        }
        return children;
    }

    protected ensureDirectory(target: string): void {
        if (target === '/' || this.entries.has(target)) {
            return;
        }
        this.ensureDirectory(path.dirname(target));
        this.entries.set(target, { directory: true, mtime: 0 });
    }

    protected statFor(target: string, uri: URI): FileStat {
        const entry = this.entries.get(target) as FakeEntry;
        return {
            resource: uri,
            name: path.basename(target),
            isFile: !entry.directory,
            isDirectory: entry.directory,
            isSymbolicLink: false,
            isReadonly: false,
            mtime: entry.mtime,
            size: entry.bytes?.byteLength ?? 0
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

function setup(roots: string[] = ['/workspace']): {
    fileService: FakeFileService;
    logger: ILogger & { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
    store: NukePreviewStore;
} {
    const fileService = new FakeFileService();
    const logger = createLogger();
    const store = new NukePreviewStore(
        fileService as unknown as FileService,
        new FakeWorkspaceService(roots) as unknown as WorkspaceService,
        logger
    );
    return { fileService, logger, store };
}

function bundlePath(session: NukePreviewSession, relative: string): string {
    return `/workspace/.nuke-ide/ai/previews/${session.id}/${relative}`;
}

function trajectoryLines(fileService: FakeFileService, session: NukePreviewSession): Record<string, unknown>[] {
    return fileService
        .textAt(bundlePath(session, 'trajectory.jsonl'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function imageResult(base64 = bytesToBase64(new Uint8Array([137, 80, 78, 71]))): NukeCapabilityResult {
    return {
        ok: true,
        message: 'Captured.',
        preview: {
            kind: 'image',
            data: `data:image/png;base64,${base64}`,
            mimeType: 'image/png',
            caption: 'Viewport',
            truthful: true,
            limitations: ['Current camera.']
        }
    };
}

function key(uri: URI): string {
    return uri.path.toString();
}

describe('NukePreviewStore', () => {
    it('creates the session lazily and writes a bundle, result, and trajectory line', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();

        expect(session.id).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/);
        expect(session.rootDir).toBe('/workspace');
        expect(fileService.calls).toEqual([]);

        const bytes = new Uint8Array([137, 80, 78, 71]);
        const result = imageResult(bytesToBase64(bytes));
        const bundle = await store.capture(session, 'nuke.viz.captureView', { path: '/workspace/model.h5m' }, result);

        expect(bundle?.id).toBe('bundle-001');
        expect(bundle?.previewPath).toBe(bundlePath(session, 'bundle-001/preview.png'));
        expect(bundle?.previewMimeType).toBe('image/png');
        expect(fileService.bytesAt(bundlePath(session, 'bundle-001/preview.png'))).toEqual(bytes);

        const sessionJson = JSON.parse(fileService.textAt(bundlePath(session, 'session.json'))) as Record<string, unknown>;
        expect(sessionJson.id).toBe(session.id);
        expect(sessionJson.rootDir).toBe('/workspace');
        expect(typeof sessionJson.createdAt).toBe('string');
        expect(typeof sessionJson.updatedAt).toBe('string');

        const resultJson = JSON.parse(fileService.textAt(bundlePath(session, 'bundle-001/result.json'))) as Record<string, unknown>;
        const preview = resultJson.preview as Record<string, unknown>;
        expect(preview.path).toBe(bundlePath(session, 'bundle-001/preview.png'));
        expect(preview.data).toBeUndefined();
        expect(JSON.stringify(resultJson)).not.toContain(bytesToBase64(bytes));

        const lines = trajectoryLines(fileService, session);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
            capabilityId: 'nuke.viz.captureView',
            input: { path: '/workspace/model.h5m' },
            ok: true,
            bundleId: 'bundle-001',
            previewPath: bundlePath(session, 'bundle-001/preview.png')
        });
        expect(typeof lines[0].timestamp).toBe('string');
    });

    it('preserves data URI bytes and mime type', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();
        const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
        const result: NukeCapabilityResult = {
            ok: true,
            preview: {
                kind: 'image',
                data: `data:image/webp;base64,${bytesToBase64(bytes)}`,
                mimeType: 'image/webp',
                truthful: true
            }
        };

        const bundle = await store.capture(session, 'nuke.viz.captureView', {}, result);

        expect(bundle?.previewMimeType).toBe('image/webp');
        expect(fileService.bytesAt(bundlePath(session, 'bundle-001/preview.webp'))).toEqual(bytes);
    });

    it('increments bundle ids and appends one trajectory line per capture', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();

        const first = await store.capture(session, 'nuke.viz.captureView', { scale: 1 }, imageResult());
        const second = await store.capture(session, 'nuke.viz.captureView', { scale: 2 }, imageResult());

        expect(first?.id).toBe('bundle-001');
        expect(second?.id).toBe('bundle-002');
        expect(fileService.bytesAt(bundlePath(session, 'bundle-002/preview.png'))).toBeDefined();
        expect(trajectoryLines(fileService, session).map((line) => line.bundleId)).toEqual(['bundle-001', 'bundle-002']);
    });

    it('keeps an in-memory bundle and writes nothing when no workspace is open', async () => {
        const { fileService, logger, store } = setup([]);
        const session = await store.createSession();

        const first = await store.capture(session, 'nuke.viz.captureView', {}, imageResult());
        const second = await store.capture(session, 'nuke.viz.captureView', {}, imageResult());

        expect(first?.previewPath).toBeUndefined();
        expect(first?.warning).toContain('persistence is disabled');
        expect(second?.id).toBe('bundle-002');
        expect(fileService.calls).toEqual([]);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect((await store.list(session)).map((bundle) => bundle.id)).toEqual(['bundle-001', 'bundle-002']);
        expect((await store.latest(session))?.id).toBe('bundle-002');
    });

    it('rejects a preview path outside the workspace', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();

        const bundle = await store.capture(
            session,
            'nuke.viz.captureView',
            {},
            {
                ok: true,
                preview: { kind: 'image', path: '/outside/preview.png', truthful: true }
            }
        );

        expect(bundle?.previewPath).toBeUndefined();
        expect(bundle?.warning).toContain('outside the workspace');
        expect(fileService.entries.has(bundlePath(session, 'bundle-001/preview.png'))).toBe(false);
        const resultJson = JSON.parse(fileService.textAt(bundlePath(session, 'bundle-001/result.json'))) as Record<string, unknown>;
        expect((resultJson.preview as Record<string, unknown>).path).toBeUndefined();
    });

    it('references an in-workspace path without copying it', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();
        const target = '/workspace/preview.png';
        fileService.addFile(target, new Uint8Array([1, 2, 3]));

        const bundle = await store.capture(
            session,
            'nuke.viz.captureView',
            {},
            {
                ok: true,
                preview: { kind: 'image', path: target, mimeType: 'image/png', truthful: true }
            }
        );

        expect(bundle?.previewPath).toBe(target);
        expect(fileService.calls.some((call) => call.startsWith('writeFile:') && call.includes('/bundle-001/preview'))).toBe(false);
    });

    it('skips a preview larger than 8 MiB with a warning', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();
        const bytes = new Uint8Array(MAX_PERSISTED_PREVIEW_BYTES + 1);
        const result = imageResult(bytesToBase64(bytes));

        const bundle = await store.capture(session, 'nuke.viz.captureView', {}, result);

        expect(bundle?.id).toBe('bundle-001');
        expect(bundle?.previewPath).toBeUndefined();
        expect(bundle?.warning).toContain('8 MiB');
        expect(fileService.entries.has(bundlePath(session, 'bundle-001/preview.png'))).toBe(false);
        const resultJson = JSON.parse(fileService.textAt(bundlePath(session, 'bundle-001/result.json'))) as Record<string, unknown>;
        expect((resultJson.warnings as string[]).join('\n')).toContain('8 MiB');
        expect(trajectoryLines(fileService, session)[0].previewPath).toBeUndefined();
    });

    it('rejects an unsupported data URI mime type without writing a preview', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();
        const result: NukeCapabilityResult = {
            ok: true,
            preview: {
                kind: 'image',
                data: `data:image/gif;base64,${bytesToBase64(new Uint8Array([71, 73, 70]))}`,
                mimeType: 'image/gif',
                truthful: true
            }
        };

        const bundle = await store.capture(session, 'nuke.viz.captureView', {}, result);

        expect(bundle?.previewPath).toBeUndefined();
        expect(bundle?.warning).toContain('not supported');
        expect(fileService.calls.some((call) => call.startsWith('writeFile:'))).toBe(false);
    });

    it('stores inline markdown as preview.txt only', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();

        const bundle = await store.capture(
            session,
            'nuke.example.markdown',
            {},
            {
                ok: true,
                preview: { kind: 'markdown', data: '# Report', caption: 'Report', truthful: true }
            }
        );

        expect(bundle?.previewPath).toBe(bundlePath(session, 'bundle-001/preview.txt'));
        expect(bundle?.previewMimeType).toBe('text/plain');
        expect(fileService.textAt(bundlePath(session, 'bundle-001/preview.txt'))).toBe('# Report');
    });

    it('serializes concurrent captures without interleaving trajectory lines', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();

        const bundles = await Promise.all([
            store.capture(session, 'nuke.viz.captureView', { scale: 1 }, imageResult()),
            store.capture(session, 'nuke.viz.captureView', { scale: 2 }, imageResult()),
            store.capture(session, 'nuke.viz.captureView', { scale: 4 }, imageResult())
        ]);

        expect(bundles.map((bundle) => bundle?.id)).toEqual(['bundle-001', 'bundle-002', 'bundle-003']);
        const lines = trajectoryLines(fileService, session);
        expect(lines).toHaveLength(3);
        expect(lines.map((line) => line.bundleId)).toEqual(['bundle-001', 'bundle-002', 'bundle-003']);
    });

    it('lists bundles ascending and latest returns the highest bundle', async () => {
        const { store } = setup();
        const session = await store.createSession();
        await store.capture(session, 'nuke.viz.captureView', {}, imageResult());
        await store.capture(session, 'nuke.viz.captureView', {}, imageResult());
        await store.capture(session, 'nuke.viz.captureView', {}, imageResult());

        expect((await store.list(session)).map((bundle) => bundle.id)).toEqual(['bundle-001', 'bundle-002', 'bundle-003']);
        expect((await store.latest(session))?.id).toBe('bundle-003');
    });

    it('returns undefined and logs when a write fails', async () => {
        const { fileService, logger, store } = setup();
        const session = await store.createSession();
        fileService.failWrites = true;

        const bundle = await store.capture(session, 'nuke.viz.captureView', {}, imageResult());

        expect(bundle).toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to persist preview'), expect.any(Error));
    });

    it('returns undefined without writing when there is no preview or artifact', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();

        const bundle = await store.capture(session, 'nuke.example.describe', { path: '/workspace/a' }, { ok: true, data: { count: 1 } });

        expect(bundle).toBeUndefined();
        expect(fileService.calls).toEqual([]);
    });

    it('redacts secrets and caps input strings in the trajectory', async () => {
        const { fileService, store } = setup();
        const session = await store.createSession();

        await store.capture(
            session,
            'nuke.example.describe',
            {
                query: 'q'.repeat(300),
                apiKey: 'sk-live-secret',
                nested: { token: 'abc123' },
                note: 'Authorization: Bearer abc.def.ghi',
                inline: 'token=super-secret'
            },
            imageResult()
        );

        const entry = trajectoryLines(fileService, session)[0] as {
            input: { query: string; apiKey: string; nested: { token: string }; note: string; inline: string };
        };
        expect(entry.input.query).toHaveLength(200);
        expect(entry.input.apiKey).toBe('[redacted]');
        expect(entry.input.nested.token).toBe('[redacted]');
        expect(entry.input.note).toContain('Bearer [redacted]');
        expect(entry.input.inline).toContain('token=[redacted]');
        expect(fileService.textAt(bundlePath(session, 'trajectory.jsonl'))).not.toContain('super-secret');
        expect(fileService.textAt(bundlePath(session, 'trajectory.jsonl'))).not.toContain('sk-live-secret');
    });
});
