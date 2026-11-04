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
import { NUKE_PREVIEW_GALLERY_LIMIT, NukePreviewGalleryService } from './nuke-preview-gallery-service';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/workspace/lib/browser', () => ({ WorkspaceService: class WorkspaceService {} }));

const WORKSPACE = '/workspace';
const PREVIEW_ROOT = `${WORKSPACE}/.nuke-ide/ai/previews`;

interface FakeEntry {
    readonly directory: boolean;
    readonly text?: string;
    readonly mtime: number;
    readonly symlink?: boolean;
}

interface BundleOptions {
    readonly bundleId: string;
    readonly capabilityId?: string;
    readonly caption?: string;
    readonly previewPath?: string;
    readonly resultRaw?: string;
    readonly mtime?: number;
}

class FakeFileService {
    readonly entries = new Map<string, FakeEntry>();
    readonly reads: string[] = [];
    readonly deletes: string[] = [];

    addDirectory(target: string, mtime = 0): void {
        this.ensureParents(target);
        this.entries.set(target, { directory: true, mtime });
    }

    addText(target: string, text: string, mtime = 0): void {
        this.ensureParents(path.dirname(target));
        this.entries.set(target, { directory: false, text, mtime });
    }

    addSymlink(target: string): void {
        this.ensureParents(path.dirname(target));
        this.entries.set(target, { directory: false, mtime: 0, symlink: true });
    }

    async delete(uri: URI): Promise<void> {
        const target = key(uri);
        this.deletes.push(target);
        for (const candidate of [...this.entries.keys()]) {
            if (candidate === target || candidate.startsWith(`${target}/`)) {
                this.entries.delete(candidate);
            }
        }
    }

    async read(uri: URI): Promise<{ value: string }> {
        const target = key(uri);
        this.reads.push(target);
        const entry = this.entries.get(target);
        if (!entry || entry.directory) {
            throw new Error(`missing file: ${target}`);
        }
        return { value: entry.text ?? '' };
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
            isFile: !entry.directory && entry.symlink !== true,
            isDirectory: entry.directory && entry.symlink !== true,
            isSymbolicLink: entry.symlink === true,
            isReadonly: false,
            mtime: entry.mtime,
            size: entry.text?.length ?? 0,
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
                isFile: !entry.directory && entry.symlink !== true,
                isDirectory: entry.directory && entry.symlink !== true,
                isSymbolicLink: entry.symlink === true,
                isReadonly: false,
                mtime: entry.mtime,
                size: entry.text?.length ?? 0
            } as FileStat);
        }
        return children;
    }

    protected ensureParents(target: string): void {
        if (target === '/' || target === WORKSPACE || this.entries.has(target)) {
            return;
        }
        this.ensureParents(path.dirname(target));
        this.entries.set(target, { directory: true, mtime: 0 });
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

function createLogger(): ILogger {
    return {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        log: vi.fn()
    } as unknown as ILogger;
}

function setup(roots: string[] = [WORKSPACE]): { fileService: FakeFileService; service: NukePreviewGalleryService } {
    const fileService = new FakeFileService();
    fileService.addDirectory(WORKSPACE);
    fileService.addDirectory(PREVIEW_ROOT);
    const service = new NukePreviewGalleryService(
        fileService as unknown as FileService,
        new FakeWorkspaceService(roots) as unknown as WorkspaceService,
        createLogger()
    );
    return { fileService, service };
}

function addSession(fileService: FakeFileService, sessionId: string, createdAt: string, bundles: readonly BundleOptions[]): void {
    const sessionUri = `${PREVIEW_ROOT}/${sessionId}`;
    fileService.addDirectory(sessionUri);
    fileService.addText(
        `${sessionUri}/session.json`,
        JSON.stringify({ id: sessionId, createdAt, updatedAt: createdAt, rootDir: WORKSPACE })
    );
    const trajectory: string[] = [];
    for (const bundle of bundles) {
        const bundleUri = `${sessionUri}/${bundle.bundleId}`;
        fileService.addDirectory(bundleUri);
        const preview = {
            kind: 'image',
            truthful: true,
            ...(bundle.caption !== undefined ? { caption: bundle.caption } : {}),
            ...(bundle.previewPath !== undefined ? { path: bundle.previewPath } : {})
        };
        fileService.addText(`${bundleUri}/result.json`, bundle.resultRaw ?? JSON.stringify({ ok: true, preview }), bundle.mtime ?? 0);
        if (bundle.previewPath !== undefined) {
            fileService.addText(bundle.previewPath, 'preview');
        }
        if (bundle.capabilityId !== undefined) {
            trajectory.push(
                JSON.stringify({
                    timestamp: createdAt,
                    capabilityId: bundle.capabilityId,
                    input: {},
                    ok: true,
                    bundleId: bundle.bundleId,
                    ...(bundle.previewPath !== undefined ? { previewPath: bundle.previewPath } : {})
                })
            );
        }
    }
    if (trajectory.length > 0) {
        fileService.addText(`${sessionUri}/trajectory.jsonl`, `${trajectory.join('\n')}\n`);
    }
}

function key(uri: URI): string {
    return uri.path.toString();
}

describe('NukePreviewGalleryService', () => {
    it('scans sessions and bundles newest first with caption, capability, and preview paths', async () => {
        const { fileService, service } = setup();
        addSession(fileService, '20260101-010101-aaaaaa', '2026-01-01T01:01:01.000Z', [
            {
                bundleId: 'bundle-001',
                capabilityId: 'nuke.viz.captureView',
                caption: 'First view',
                previewPath: `${PREVIEW_ROOT}/20260101-010101-aaaaaa/bundle-001/preview.png`,
                mtime: Date.parse('2026-01-01T01:01:02.000Z')
            },
            {
                bundleId: 'bundle-002',
                capabilityId: 'nuke.cad.preview',
                caption: 'Second view',
                previewPath: `${PREVIEW_ROOT}/20260101-010101-aaaaaa/bundle-002/preview.svg`,
                mtime: Date.parse('2026-01-01T01:01:03.000Z')
            }
        ]);
        addSession(fileService, '20260201-010101-bbbbbb', '2026-02-01T01:01:01.000Z', [
            {
                bundleId: 'bundle-001',
                capabilityId: 'nuke.viz.captureView',
                caption: 'Newest view',
                previewPath: `${PREVIEW_ROOT}/20260201-010101-bbbbbb/bundle-001/preview.png`,
                mtime: Date.parse('2026-02-01T01:01:02.000Z')
            }
        ]);

        const entries = await service.list();

        expect(entries.map((entry) => `${entry.sessionId}/${entry.bundleId}`)).toEqual([
            '20260201-010101-bbbbbb/bundle-001',
            '20260101-010101-aaaaaa/bundle-002',
            '20260101-010101-aaaaaa/bundle-001'
        ]);
        expect(entries[0]).toMatchObject({
            sessionId: '20260201-010101-bbbbbb',
            bundleId: 'bundle-001',
            createdAt: '2026-02-01T01:01:02.000Z',
            caption: 'Newest view',
            capabilityId: 'nuke.viz.captureView',
            previewPath: `${PREVIEW_ROOT}/20260201-010101-bbbbbb/bundle-001/preview.png`,
            resultPath: `${PREVIEW_ROOT}/20260201-010101-bbbbbb/bundle-001/result.json`
        });
    });

    it('clears the preview history after validating the workspace path', async () => {
        const { fileService, service } = setup();
        addSession(fileService, '20260101-010101-aaaaaa', '2026-01-01T01:01:01.000Z', [
            { bundleId: 'bundle-001', capabilityId: 'nuke.viz.captureView', caption: 'First view' }
        ]);

        expect(await service.clear()).toEqual({ cleared: true, message: 'Preview history cleared.' });
        expect(fileService.deletes).toContain(PREVIEW_ROOT);
        expect([...fileService.entries.keys()].some((entry) => entry.startsWith(`${PREVIEW_ROOT}/`))).toBe(false);
    });

    it('refuses to clear a symlinked preview root', async () => {
        const { fileService, service } = setup();
        fileService.addSymlink(PREVIEW_ROOT);

        const result = await service.clear();

        expect(result.cleared).toBe(false);
        expect(result.message).toContain('symlinked');
        expect(fileService.deletes).toEqual([]);
    });

    it('reports when there is no preview history', async () => {
        const { fileService, service } = setup();
        fileService.entries.delete(PREVIEW_ROOT);

        const result = await service.clear();

        expect(result.cleared).toBe(false);
        expect(result.message).toContain('no saved preview history');
        expect(fileService.deletes).toEqual([]);
    });

    it('does not read a symlinked result.json', async () => {
        const { fileService, service } = setup();
        addSession(fileService, '20260101-010101-aaaaaa', '2026-01-01T01:01:01.000Z', [
            { bundleId: 'bundle-001', capabilityId: 'nuke.viz.captureView', caption: 'First view' }
        ]);
        const resultPath = `${PREVIEW_ROOT}/20260101-010101-aaaaaa/bundle-001/result.json`;
        fileService.addSymlink(resultPath);
        fileService.reads.length = 0;

        const entries = await service.list();

        expect(entries).toEqual([]);
        expect(fileService.reads).not.toContain(resultPath);
    });

    it('skips malformed sessions, results, and trajectory lines', async () => {
        const { fileService, service } = setup();
        fileService.addDirectory(`${PREVIEW_ROOT}/broken-session`);
        fileService.addText(`${PREVIEW_ROOT}/broken-session/session.json`, '{ not json');
        addSession(fileService, '20260101-010101-aaaaaa', '2026-01-01T01:01:01.000Z', [
            { bundleId: 'bundle-001', resultRaw: '{' },
            { bundleId: 'bundle-002', capabilityId: 'nuke.viz.captureView', caption: 'Valid', mtime: 10 }
        ]);
        fileService.addText(
            `${PREVIEW_ROOT}/20260101-010101-aaaaaa/trajectory.jsonl`,
            `not json\n${JSON.stringify({ capabilityId: 'nuke.viz.captureView' })}\n${JSON.stringify({
                bundleId: 'bundle-002',
                capabilityId: 'nuke.viz.captureView'
            })}\n`
        );

        const entries = await service.list();

        expect(entries).toHaveLength(1);
        expect(entries[0].bundleId).toBe('bundle-002');
        expect(entries[0].capabilityId).toBe('nuke.viz.captureView');
        expect(entries[0].caption).toBe('Valid');
    });

    it(`returns at most ${NUKE_PREVIEW_GALLERY_LIMIT} entries, newest first`, async () => {
        const { fileService, service } = setup();
        const bundles: BundleOptions[] = [];
        for (let index = 1; index <= NUKE_PREVIEW_GALLERY_LIMIT + 5; index++) {
            bundles.push({
                bundleId: `bundle-${String(index).padStart(3, '0')}`,
                capabilityId: 'nuke.viz.captureView',
                mtime: index * 1000
            });
        }
        addSession(fileService, '20260101-010101-aaaaaa', '2026-01-01T01:01:01.000Z', bundles);

        const entries = await service.list();

        expect(entries).toHaveLength(NUKE_PREVIEW_GALLERY_LIMIT);
        expect(entries[0].bundleId).toBe('bundle-105');
        expect(entries[entries.length - 1].bundleId).toBe('bundle-006');
    });

    it('drops preview paths outside the workspace', async () => {
        const { fileService, service } = setup();
        addSession(fileService, '20260101-010101-aaaaaa', '2026-01-01T01:01:01.000Z', [
            { bundleId: 'bundle-001', previewPath: '/outside/secret.png', mtime: 10 },
            { bundleId: 'bundle-002', previewPath: `${WORKSPACE}/../outside/secret.png`, mtime: 20 }
        ]);

        const entries = await service.list();

        expect(entries).toHaveLength(2);
        expect(entries[0].previewPath).toBeUndefined();
        expect(entries[1].previewPath).toBeUndefined();
    });

    it('returns nothing without a workspace or before the preview folder exists', async () => {
        const noWorkspace = setup([]);
        expect(await noWorkspace.service.list()).toEqual([]);
        expect(noWorkspace.fileService.reads).toEqual([]);

        const missing = setup();
        missing.fileService.entries.delete(PREVIEW_ROOT);
        expect(await missing.service.list()).toEqual([]);
    });

    it('only reads files inside the workspace preview root', async () => {
        const { fileService, service } = setup();
        addSession(fileService, '20260101-010101-aaaaaa', '2026-01-01T01:01:01.000Z', [
            { bundleId: 'bundle-001', capabilityId: 'nuke.viz.captureView', mtime: 10 }
        ]);

        await service.list();

        expect(fileService.reads.length).toBeGreaterThan(0);
        for (const read of fileService.reads) {
            expect(read.startsWith(`${PREVIEW_ROOT}/`)).toBe(true);
        }
    });
});
