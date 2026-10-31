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
 * Nuke Preview Store
 *
 * Persists truthful capability previews under
 * `<workspace>/.nuke-ide/ai/previews/<session-id>/` and appends one trajectory
 * line per capture. Sessions are created without touching disk; the first
 * capture that has a preview or artifacts creates the folder. Without a
 * workspace the store keeps bundles in memory and only logs once that
 * persistence is disabled.
 *
 * @module nuke-ai/browser/preview
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat, FileStatWithMetadata } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import { NukeArtifact, NukeCapabilityResult, NukePreview } from 'nuke-core/lib/common/nuke-capability-protocol';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import {
    MAX_PERSISTED_PREVIEW_BYTES,
    MAX_TRAJECTORY_INPUT_STRING_LENGTH,
    NukePreviewBundle,
    NukePreviewSession,
    NukeTrajectoryEntry,
    parsePreviewDataUri,
    previewExtensionForMime,
    previewMimeForExtension
} from '../../common/nuke-preview-protocol';

const PREVIEW_ROOT = '.nuke-ide/ai/previews';
const BUNDLE_DIRECTORY_PATTERN = /^bundle-(\d+)$/;
const PREVIEW_FILE_PATTERN = /^preview\.([A-Za-z0-9]+)$/;
const INLINE_DATA_URI = /^data:[^,]*,/i;
const SECRET_KEY = /(?:api[-_]?key|token|secret|password|authorization|credential)/i;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET = /\b(api[-_]?key|token|secret|password|authorization)\b(\s*[:=]\s*)(["']?)(?!\[redacted\]|Bearer\b)[^\s"',;}]+/gi;
const UTF8_ENCODER = new TextEncoder();

interface PreviewStorage {
    readonly previewPath?: string;
    readonly previewMimeType?: string;
    readonly warning?: string;
}

interface SessionState {
    readonly workspaceRoots: readonly string[];
    nextBundleIndex: number;
    queue: Promise<unknown>;
    readonly inMemoryBundles: NukePreviewBundle[];
    trajectoryText?: string;
    trajectoryLoaded: boolean;
}

/** Persist preview bundles and the command-to-preview trajectory. */
@injectable()
export class NukePreviewStore {
    protected readonly sessions = new Map<string, SessionState>();
    protected persistenceDisabledLogged = false;

    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(WorkspaceService) protected readonly workspaceService: WorkspaceService,
        @inject(ILogger) protected readonly logger: ILogger
    ) {}

    /**
     * Create a session handle. The session directory is created lazily by the
     * first capture, so an unused session never leaves empty folders behind.
     */
    async createSession(): Promise<NukePreviewSession> {
        const workspaceRoots = this.readWorkspaceRoots();
        const createdAt = new Date().toISOString();
        const session: NukePreviewSession = {
            id: createSessionId(new Date(createdAt)),
            createdAt,
            ...(workspaceRoots.length > 0 ? { rootDir: workspaceRoots[0] } : {})
        };
        this.sessions.set(session.id, {
            workspaceRoots,
            nextBundleIndex: 1,
            queue: Promise.resolve(),
            inMemoryBundles: [],
            trajectoryLoaded: false
        });
        if (workspaceRoots.length === 0) {
            this.logPersistenceDisabled();
        }
        return session;
    }

    /**
     * Capture one capability invocation. Returns `undefined` when the result
     * has neither a preview nor artifacts, or when persistence fails. Failures
     * are logged and never throw into the tool call.
     */
    async capture(
        session: NukePreviewSession,
        capabilityId: string,
        input: unknown,
        result: NukeCapabilityResult
    ): Promise<NukePreviewBundle | undefined> {
        if (!result.preview && (!result.artifacts || result.artifacts.length === 0)) {
            return undefined;
        }
        const state = this.stateFor(session);
        return this.enqueue(state, () => this.performCapture(session, state, capabilityId, input, result));
    }

    /** Return the most recent bundle, or `undefined` when none exist. */
    async latest(session: NukePreviewSession): Promise<NukePreviewBundle | undefined> {
        const bundles = await this.list(session);
        return bundles[bundles.length - 1];
    }

    /** Return every bundle for a session, oldest first. */
    async list(session: NukePreviewSession): Promise<NukePreviewBundle[]> {
        const state = this.stateFor(session);
        if (!session.rootDir) {
            return [...state.inMemoryBundles];
        }
        return this.enqueue(state, () => this.readBundles(session));
    }

    protected async performCapture(
        session: NukePreviewSession,
        state: SessionState,
        capabilityId: string,
        input: unknown,
        result: NukeCapabilityResult
    ): Promise<NukePreviewBundle | undefined> {
        const createdAt = new Date().toISOString();
        const bundleId = bundleName(state.nextBundleIndex);
        if (!session.rootDir) {
            const storage = result.preview ? this.inMemoryPreview(result.preview) : {};
            const bundle: NukePreviewBundle = {
                id: bundleId,
                sessionId: session.id,
                createdAt,
                ...(storage.previewMimeType ? { previewMimeType: storage.previewMimeType } : {}),
                warning: 'Preview persistence is disabled because no workspace folder is open.'
            };
            state.nextBundleIndex++;
            state.inMemoryBundles.push(bundle);
            this.logPersistenceDisabled();
            return bundle;
        }
        try {
            const sessionUri = this.sessionUri(session);
            await this.fileService.createFolder(sessionUri, { fromUserGesture: false });
            await this.writeSessionJson(session, sessionUri, createdAt);
            const bundleUri = sessionUri.resolve(bundleId);
            await this.fileService.createFolder(bundleUri, { fromUserGesture: false });
            const storage = result.preview ? await this.storePreview(state, result.preview, bundleUri) : {};
            const persisted = this.persistedResult(result, storage);
            await this.fileService.write(bundleUri.resolve('result.json'), JSON.stringify(persisted, null, 2));
            await this.appendTrajectory(sessionUri, state, this.trajectoryEntry(capabilityId, input, result, bundleId, storage));
            state.nextBundleIndex++;
            return {
                id: bundleId,
                sessionId: session.id,
                createdAt,
                ...(storage.previewPath !== undefined ? { previewPath: storage.previewPath } : {}),
                ...(storage.previewMimeType !== undefined ? { previewMimeType: storage.previewMimeType } : {}),
                ...(storage.warning !== undefined ? { warning: storage.warning } : {})
            };
        } catch (error) {
            this.logger.error(`[NukeAi] Failed to persist preview for ${capabilityId}:`, error);
            return undefined;
        }
    }

    protected inMemoryPreview(preview: NukePreview): PreviewStorage {
        const mimeType = preview.mimeType ?? parsePreviewDataUri(preview.data)?.mimeType;
        return mimeType ? { previewMimeType: mimeType } : {};
    }

    protected async storePreview(state: SessionState, preview: NukePreview, bundleUri: URI): Promise<PreviewStorage> {
        if (preview.data !== undefined && preview.data.length > 0) {
            const parsed = parsePreviewDataUri(preview.data);
            if (parsed) {
                const extension = previewExtensionForMime(parsed.mimeType);
                if (!extension) {
                    return { warning: `Preview mime type ${parsed.mimeType} is not supported; no preview file was written.` };
                }
                if (parsed.bytes.byteLength > MAX_PERSISTED_PREVIEW_BYTES) {
                    return this.oversizeWarning();
                }
                const target = bundleUri.resolve(`preview.${extension}`);
                await this.fileService.writeFile(target, BinaryBuffer.wrap(parsed.bytes));
                return { previewPath: target.path.toString(), previewMimeType: parsed.mimeType };
            }
            if (preview.kind === 'markdown') {
                const bytes = UTF8_ENCODER.encode(preview.data);
                if (bytes.byteLength > MAX_PERSISTED_PREVIEW_BYTES) {
                    return this.oversizeWarning();
                }
                const target = bundleUri.resolve('preview.txt');
                await this.fileService.writeFile(target, BinaryBuffer.wrap(bytes));
                return { previewPath: target.path.toString(), previewMimeType: 'text/plain' };
            }
            return {
                warning: preview.data.startsWith('data:')
                    ? 'Preview data URI is malformed or not base64; no preview file was written.'
                    : 'Inline preview data is only persisted for markdown; no preview file was written.'
            };
        }
        if (preview.path !== undefined && preview.path.length > 0) {
            if (!isWithinWorkspace(preview.path, state.workspaceRoots)) {
                return { warning: 'Preview path is outside the workspace; it was not referenced.' };
            }
            if (!(await this.isReferenceablePath(preview.path, state.workspaceRoots))) {
                return { warning: 'Preview path is a symlink or is not a file; it was not referenced.' };
            }
            const mimeType = preview.mimeType ?? previewMimeForPath(preview.path);
            return {
                previewPath: preview.path,
                ...(mimeType !== undefined ? { previewMimeType: mimeType } : {})
            };
        }
        return { warning: 'Preview has no data or path; no preview file was written.' };
    }

    /**
     * Reject symlinked path components and non-files. Theia's file service does
     * not expose realpath, so every component from the workspace root down is
     * resolved and checked instead.
     */
    protected async isReferenceablePath(candidate: string, roots: readonly string[]): Promise<boolean> {
        const normalized = path.resolve(candidate);
        const root = roots
            .map((entry) => path.resolve(entry))
            .filter((entry) => isWithinWorkspace(normalized, [entry]))
            .sort((left, right) => right.length - left.length)[0];
        if (!root) {
            return false;
        }
        const relative = path.relative(root, normalized);
        const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
        if (segments.length === 0) {
            return false;
        }
        let current = root;
        try {
            for (const segment of segments) {
                current = path.join(current, segment);
                const stat = await this.fileService.resolve(URI.fromFilePath(current));
                if (stat.isSymbolicLink) {
                    return false;
                }
                if (current === normalized && !stat.isFile) {
                    return false;
                }
            }
            return true;
        } catch {
            return false;
        }
    }

    protected oversizeWarning(): PreviewStorage {
        return { warning: 'Preview is larger than 8 MiB and was not saved; the preview is still shown in the chat.' };
    }

    protected persistedResult(result: NukeCapabilityResult, storage: PreviewStorage): Record<string, unknown> {
        const persisted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(result)) {
            if (key === 'preview') {
                continue;
            }
            persisted[key] = sanitizeForDisk(value);
        }
        if (result.preview) {
            const preview: Record<string, unknown> = {
                kind: result.preview.kind,
                truthful: result.preview.truthful
            };
            if (result.preview.caption !== undefined) {
                preview.caption = result.preview.caption;
            }
            if (result.preview.limitations !== undefined) {
                preview.limitations = [...result.preview.limitations];
            }
            const mimeType = storage.previewMimeType ?? result.preview.mimeType;
            if (mimeType !== undefined) {
                preview.mimeType = mimeType;
            }
            if (storage.previewPath !== undefined) {
                preview.path = storage.previewPath;
            }
            persisted.preview = preview;
        }
        if (storage.warning !== undefined) {
            persisted.warnings = [...(result.warnings ?? []), storage.warning].map((warning) => sanitizeForDisk(warning));
        }
        return persisted;
    }

    protected trajectoryEntry(
        capabilityId: string,
        input: unknown,
        result: NukeCapabilityResult,
        bundleId: string,
        storage: PreviewStorage
    ): NukeTrajectoryEntry {
        const artifacts = (result.artifacts ?? []).map(artifactTarget).filter((target): target is string => target !== undefined);
        return {
            timestamp: new Date().toISOString(),
            capabilityId,
            input: redactTrajectoryInput(input),
            ok: result.ok,
            bundleId,
            ...(storage.previewPath !== undefined ? { previewPath: storage.previewPath } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {})
        };
    }

    protected async appendTrajectory(sessionUri: URI, state: SessionState, entry: NukeTrajectoryEntry): Promise<void> {
        const target = sessionUri.resolve('trajectory.jsonl');
        if (!state.trajectoryLoaded) {
            state.trajectoryLoaded = true;
            try {
                if (await this.fileService.exists(target)) {
                    state.trajectoryText = (await this.fileService.read(target)).value;
                }
            } catch (error) {
                this.logger.warn('[NukeAi] Failed to read the existing preview trajectory; starting a new one:', error);
            }
        }
        const existing = state.trajectoryText ?? '';
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        state.trajectoryText = `${existing}${separator}${JSON.stringify(entry)}\n`;
        await this.fileService.write(target, state.trajectoryText);
    }

    protected async writeSessionJson(session: NukePreviewSession, sessionUri: URI, updatedAt: string): Promise<void> {
        const content = {
            id: session.id,
            createdAt: session.createdAt,
            updatedAt,
            rootDir: session.rootDir
        };
        await this.fileService.write(sessionUri.resolve('session.json'), JSON.stringify(content, null, 2));
    }

    protected async readBundles(session: NukePreviewSession): Promise<NukePreviewBundle[]> {
        if (!session.rootDir) {
            return [];
        }
        const sessionUri = this.sessionUri(session);
        let stat: FileStat;
        try {
            stat = await this.fileService.resolve(sessionUri, { resolveMetadata: true });
        } catch {
            return [];
        }
        const children = (stat.children ?? [])
            .filter((child) => child.isDirectory && BUNDLE_DIRECTORY_PATTERN.test(child.name))
            .sort((left, right) => bundleIndex(left.name) - bundleIndex(right.name));
        const bundles: NukePreviewBundle[] = [];
        for (const child of children) {
            let bundleStat = child;
            try {
                bundleStat = await this.fileService.resolve(child.resource, { resolveMetadata: true });
            } catch {
                // Keep the directory entry; the preview link is simply absent.
            }
            bundles.push(this.bundleFromStat(session, bundleStat));
        }
        return bundles;
    }

    protected bundleFromStat(session: NukePreviewSession, stat: FileStat): NukePreviewBundle {
        const preview = (stat.children ?? []).find((child) => child.isFile && PREVIEW_FILE_PATTERN.test(child.name));
        const extension = preview ? PREVIEW_FILE_PATTERN.exec(preview.name)?.[1] : undefined;
        const mtime = (stat as FileStatWithMetadata).mtime;
        return {
            id: stat.name,
            sessionId: session.id,
            createdAt: typeof mtime === 'number' ? new Date(mtime).toISOString() : new Date().toISOString(),
            ...(preview ? { previewPath: preview.resource.path.toString() } : {}),
            ...(extension ? { previewMimeType: previewMimeForExtension(extension) } : {})
        };
    }

    protected sessionUri(session: NukePreviewSession): URI {
        return URI.fromFilePath(session.rootDir as string).resolve(`${PREVIEW_ROOT}/${session.id}`);
    }

    protected stateFor(session: NukePreviewSession): SessionState {
        let state = this.sessions.get(session.id);
        if (!state) {
            state = {
                workspaceRoots: session.rootDir ? [session.rootDir] : [],
                nextBundleIndex: 1,
                queue: Promise.resolve(),
                inMemoryBundles: [],
                trajectoryLoaded: false
            };
            this.sessions.set(session.id, state);
        }
        return state;
    }

    protected enqueue<T>(state: SessionState, task: () => Promise<T>): Promise<T> {
        const run = state.queue.then(task, task);
        state.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    protected readWorkspaceRoots(): string[] {
        try {
            return this.workspaceService
                .tryGetRoots()
                .map((root) => root.resource.path.toString())
                .filter((root) => root.length > 0 && path.isAbsolute(root));
        } catch (error) {
            this.logger.error('[NukeAi] Failed to read workspace roots for preview persistence:', error);
            return [];
        }
    }

    protected logPersistenceDisabled(): void {
        if (this.persistenceDisabledLogged) {
            return;
        }
        this.persistenceDisabledLogged = true;
        this.logger.warn('[NukeAi] Preview persistence is disabled because no workspace folder is open.');
    }
}

/** Build the `YYYYMMDD-HHmmss-<short-random>` session id. */
function createSessionId(date: Date): string {
    const iso = date.toISOString();
    const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
    return `${stamp}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

function bundleName(index: number): string {
    return `bundle-${String(index).padStart(3, '0')}`;
}

function bundleIndex(name: string): number {
    const match = BUNDLE_DIRECTORY_PATTERN.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function previewMimeForPath(candidate: string): string | undefined {
    const extension = path.extname(candidate).replace(/^\./, '');
    return extension.length > 0 ? previewMimeForExtension(extension) : undefined;
}

function artifactTarget(artifact: NukeArtifact): string | undefined {
    const target = artifact.path ?? artifact.uri ?? artifact.label;
    return target.length > 0 ? capTrajectoryString(redactSecret(target)) : undefined;
}

/** Deep-copy trajectory input with secrets removed and strings capped. */
export function redactTrajectoryInput(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === 'string') {
        return capTrajectoryString(redactSecret(value));
    }
    if (value === null || typeof value !== 'object') {
        return typeof value === 'bigint' ? capTrajectoryString(value.toString()) : value;
    }
    if (seen.has(value)) {
        return '[circular]';
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((entry) => redactTrajectoryInput(entry, seen));
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        const record: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            record[key] = SECRET_KEY.test(key) ? '[redacted]' : redactTrajectoryInput(entry, seen);
        }
        return record;
    } finally {
        seen.delete(value);
    }
}

function redactSecret(value: string): string {
    return value.replace(BEARER_SECRET, 'Bearer [redacted]').replace(KEY_VALUE_SECRET, '$1$2$3[redacted]');
}

function capTrajectoryString(value: string): string {
    return value.length > MAX_TRAJECTORY_INPUT_STRING_LENGTH ? value.slice(0, MAX_TRAJECTORY_INPUT_STRING_LENGTH) : value;
}

/** Remove inline data before persisting a result snapshot. */
function sanitizeForDisk(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === 'string') {
        return INLINE_DATA_URI.test(value) ? '[inline data omitted]' : value;
    }
    if (value === null || typeof value !== 'object') {
        return typeof value === 'bigint' ? value.toString() : value;
    }
    if (seen.has(value)) {
        return '[circular]';
    }
    seen.add(value);
    try {
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            return '[binary omitted]';
        }
        if (Array.isArray(value)) {
            return value.map((entry) => sanitizeForDisk(entry, seen));
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        const record: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            record[key] = sanitizeForDisk(entry, seen);
        }
        return record;
    } finally {
        seen.delete(value);
    }
}
