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
 * Nuke Preview Gallery Service
 *
 * Read-only view over the persisted preview history. It scans
 * `<workspace>/.nuke-ide/ai/previews` with the Theia `FileService`, reads the
 * session metadata, bundle result snapshots, and trajectory lines defensively,
 * and returns the newest bundles first. Malformed entries are skipped, the
 * result is capped at {@link NUKE_PREVIEW_GALLERY_LIMIT}, and nothing is ever
 * written or read outside the open workspace.
 *
 * @module nuke-ai/browser/preview
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat, FileStatWithMetadata } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';

/** Preview history location inside the workspace config folder. */
export const NUKE_PREVIEW_GALLERY_ROOT = '.nuke-ide/ai/previews';

/** Maximum number of gallery entries returned by one scan. */
export const NUKE_PREVIEW_GALLERY_LIMIT = 100;

/** Session folders created by the preview store, plus defensive extras. */
const SESSION_DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Bundle folders created by the preview store. */
const BUNDLE_DIRECTORY_PATTERN = /^bundle-(\d+)$/;

/** Preview files written by the preview store. */
const PREVIEW_FILE_PATTERN = /^preview\.[A-Za-z0-9]+$/;

/** One preview bundle shown in the gallery. */
export interface NukePreviewGalleryEntry {
    readonly sessionId: string;
    readonly bundleId: string;
    readonly createdAt: string;
    readonly previewPath?: string;
    readonly caption?: string;
    readonly capabilityId?: string;
    readonly resultPath?: string;
}

interface TrajectoryInfo {
    readonly capabilityId?: string;
    readonly previewPath?: string;
}

/** Read-only scanner for the persisted NukeAI preview history. */
@injectable()
export class NukePreviewGalleryService {
    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    /** Return preview bundles sorted newest first, capped at the gallery limit. */
    async list(): Promise<NukePreviewGalleryEntry[]> {
        const roots = this.readWorkspaceRoots();
        if (roots.length === 0) {
            return [];
        }
        const previewRoot = URI.fromFilePath(roots[0]).resolve(NUKE_PREVIEW_GALLERY_ROOT);
        const rootStat = await this.resolve(previewRoot);
        if (!rootStat?.isDirectory || rootStat.isSymbolicLink) {
            return [];
        }
        const entries: NukePreviewGalleryEntry[] = [];
        for (const sessionDir of rootStat.children ?? []) {
            if (!sessionDir.isDirectory || sessionDir.isSymbolicLink || !SESSION_DIRECTORY_PATTERN.test(sessionDir.name)) {
                continue;
            }
            entries.push(...(await this.readSession(sessionDir, roots)));
        }
        entries.sort(compareEntries);
        return entries.slice(0, NUKE_PREVIEW_GALLERY_LIMIT);
    }

    protected async readSession(sessionDir: FileStat, roots: readonly string[]): Promise<NukePreviewGalleryEntry[]> {
        const sessionUri = sessionDir.resource;
        const sessionJsonUri = sessionUri.resolve('session.json');
        const sessionJsonStat = await this.resolve(sessionJsonUri);
        if (!sessionJsonStat || sessionJsonStat.isSymbolicLink) {
            return [];
        }
        const session = await this.readJson(sessionJsonUri);
        const sessionCreatedAt = isoDate(session?.createdAt);
        if (!session || sessionCreatedAt === undefined) {
            this.logger.debug(`[NukeAI] Skipping malformed preview session at ${sessionUri.path.toString()}.`);
            return [];
        }
        const sessionStat = (await this.resolve(sessionUri)) ?? sessionDir;
        if (sessionStat.isSymbolicLink) {
            return [];
        }
        const trajectory = await this.readTrajectory(sessionUri, roots);
        const entries: NukePreviewGalleryEntry[] = [];
        for (const bundleDir of sessionStat.children ?? []) {
            if (!bundleDir.isDirectory || bundleDir.isSymbolicLink || !BUNDLE_DIRECTORY_PATTERN.test(bundleDir.name)) {
                continue;
            }
            const entry = await this.readBundle(sessionDir.name, sessionCreatedAt, bundleDir, trajectory, roots);
            if (entry) {
                entries.push(entry);
            }
        }
        return entries;
    }

    protected async readBundle(
        sessionId: string,
        sessionCreatedAt: string,
        bundleDir: FileStat,
        trajectory: ReadonlyMap<string, TrajectoryInfo>,
        roots: readonly string[]
    ): Promise<NukePreviewGalleryEntry | undefined> {
        const resultUri = bundleDir.resource.resolve('result.json');
        const [result, resultStat] = await Promise.all([this.readJson(resultUri), this.resolve(resultUri)]);
        if (!result || !resultStat || resultStat.isSymbolicLink) {
            return undefined;
        }
        const bundleStat = (await this.resolve(bundleDir.resource)) ?? bundleDir;
        if (bundleStat.isSymbolicLink) {
            return undefined;
        }
        const info = trajectory.get(bundleDir.name);
        const preview = isRecord(result.preview) ? result.preview : undefined;
        const previewPath =
            this.withinWorkspace(preview?.path, roots) ??
            info?.previewPath ??
            (bundleStat.children ?? [])
                .find((child) => child.isFile && !child.isSymbolicLink && PREVIEW_FILE_PATTERN.test(child.name))
                ?.resource.path.toString();
        const caption = typeof preview?.caption === 'string' && preview.caption.trim().length > 0 ? preview.caption : undefined;
        const capabilityId = info?.capabilityId;
        return {
            sessionId,
            bundleId: bundleDir.name,
            createdAt: mtimeIso(resultStat) ?? sessionCreatedAt,
            ...(previewPath !== undefined ? { previewPath } : {}),
            ...(caption !== undefined ? { caption } : {}),
            ...(capabilityId !== undefined ? { capabilityId } : {}),
            resultPath: resultUri.path.toString()
        };
    }

    protected async readTrajectory(sessionUri: URI, roots: readonly string[]): Promise<Map<string, TrajectoryInfo>> {
        const trajectory = new Map<string, TrajectoryInfo>();
        const trajectoryUri = sessionUri.resolve('trajectory.jsonl');
        const trajectoryStat = await this.resolve(trajectoryUri);
        if (!trajectoryStat || trajectoryStat.isSymbolicLink) {
            return trajectory;
        }
        let text: string;
        try {
            text = (await this.fileService.read(trajectoryUri)).value;
        } catch {
            return trajectory;
        }
        for (const line of text.split('\n')) {
            if (line.trim().length === 0) {
                continue;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(line);
            } catch {
                continue;
            }
            if (!isRecord(parsed) || typeof parsed.bundleId !== 'string' || parsed.bundleId.length === 0) {
                continue;
            }
            const capabilityId =
                typeof parsed.capabilityId === 'string' && parsed.capabilityId.trim().length > 0 ? parsed.capabilityId : undefined;
            const previewPath = this.withinWorkspace(parsed.previewPath, roots);
            trajectory.set(parsed.bundleId, {
                ...(capabilityId !== undefined ? { capabilityId } : {}),
                ...(previewPath !== undefined ? { previewPath } : {})
            });
        }
        return trajectory;
    }

    protected async readJson(uri: URI): Promise<Record<string, unknown> | undefined> {
        let text: string;
        try {
            text = (await this.fileService.read(uri)).value;
        } catch {
            return undefined;
        }
        try {
            const parsed: unknown = JSON.parse(text);
            return isRecord(parsed) ? parsed : undefined;
        } catch {
            this.logger.debug(`[NukeAI] Skipping malformed preview metadata at ${uri.path.toString()}.`);
            return undefined;
        }
    }

    protected async resolve(uri: URI): Promise<FileStat | undefined> {
        try {
            return await this.fileService.resolve(uri, { resolveMetadata: true });
        } catch {
            return undefined;
        }
    }

    protected withinWorkspace(value: unknown, roots: readonly string[]): string | undefined {
        return typeof value === 'string' && value.length > 0 && isWithinWorkspace(value, roots) ? value : undefined;
    }

    protected readWorkspaceRoots(): string[] {
        try {
            return this.workspaceService
                .tryGetRoots()
                .map((root) => root.resource.path.toString())
                .filter((root) => root.length > 0 && path.isAbsolute(root));
        } catch (error) {
            this.logger.error('[NukeAI] Failed to read workspace roots for the preview gallery:', error);
            return [];
        }
    }
}

function compareEntries(left: NukePreviewGalleryEntry, right: NukePreviewGalleryEntry): number {
    const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (byTime !== 0 && !Number.isNaN(byTime)) {
        return byTime;
    }
    const bySession = right.sessionId.localeCompare(left.sessionId);
    if (bySession !== 0) {
        return bySession;
    }
    return bundleIndex(right.bundleId) - bundleIndex(left.bundleId);
}

function bundleIndex(bundleId: string): number {
    const match = BUNDLE_DIRECTORY_PATTERN.exec(bundleId);
    return match ? Number(match[1]) : -1;
}

function isoDate(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function mtimeIso(stat: FileStat | undefined): string | undefined {
    const mtime = stat ? (stat as FileStatWithMetadata).mtime : undefined;
    return typeof mtime === 'number' && Number.isFinite(mtime) && mtime > 0 ? new Date(mtime).toISOString() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
