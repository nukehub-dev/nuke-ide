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

import { inject, injectable, unmanaged } from '@theia/core/shared/inversify';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ILogger } from '@theia/core/lib/common/logger';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileStat, FileStatWithMetadata } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import * as path from 'path';
import { NukeArtifact, NukeCapabilityResult, NukePreview } from 'nuke-core/lib/common/nuke-capability-protocol';
import {
    MAX_PERSISTED_PREVIEW_BYTES,
    MAX_PERSISTED_RESULT_BYTES,
    MAX_TRAJECTORY_INPUT_STRING_LENGTH,
    NukePreviewBundle,
    NukePreviewSession,
    NukeTrajectoryEntry,
    parsePreviewDataUri,
    previewExtensionForMime,
    previewMimeForExtension
} from '../../common/nuke-preview-protocol';
import { isReferenceableFilePath, isSafeDirectoryPath, isSafeFileTarget } from './preview-path-policy';

const PREVIEW_ROOT = '.nuke-ide/ai/previews';
const BUNDLE_DIRECTORY_PATTERN = /^bundle-(\d+)$/;
const PREVIEW_FILE_PATTERN = /^preview\.([A-Za-z0-9]+)$/;
const INLINE_DATA_URI = /^data:[^,]*,/i;
const SECRET_KEY = /(?:api[-_]?key|token|secret|password|authorization|credential)/i;
const BEARER_SECRET = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET = /\b(api[-_]?key|token|secret|password|authorization)\b(\s*[:=]\s*)(["']?)(?!\[redacted\]|Bearer\b)[^\s"',;}]+/gi;
const UTF8_ENCODER = new TextEncoder();
const DEFAULT_MAX_TRAJECTORY_BYTES = 1024 * 1024;
const DEFAULT_MAX_IN_MEMORY_BUNDLES = 100;

/** Optional bounds used by tests; production uses the defaults above. */
export interface NukePreviewStoreOptions {
    readonly maxTrajectoryBytes?: number;
    readonly maxInMemoryBundles?: number;
}

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
        @inject(ILogger) protected readonly logger: ILogger,
        @unmanaged() protected readonly options: NukePreviewStoreOptions = {}
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

    /** Drop the in-memory state for a session that will not be reused. */
    releaseSession(sessionId: string): void {
        this.sessions.delete(sessionId);
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
            const maxInMemory = this.options.maxInMemoryBundles ?? DEFAULT_MAX_IN_MEMORY_BUNDLES;
            if (state.inMemoryBundles.length > maxInMemory) {
                state.inMemoryBundles.splice(0, state.inMemoryBundles.length - maxInMemory);
            }
            this.logPersistenceDisabled();
            return bundle;
        }
        try {
            const sessionUri = this.sessionUri(session);
            if (!(await isSafeDirectoryPath(this.fileService, sessionUri.path.toString(), state.workspaceRoots))) {
                throw new Error('Preview session directory is symlinked or outside the workspace.');
            }
            await this.fileService.createFolder(sessionUri, { fromUserGesture: false });
            if (!(await isSafeFileTarget(this.fileService, sessionUri.resolve('session.json').path.toString(), state.workspaceRoots))) {
                throw new Error('Preview session metadata target is symlinked or outside the workspace.');
            }
            await this.writeSessionJson(session, sessionUri, createdAt);
            const bundleUri = sessionUri.resolve(bundleId);
            if (!(await isSafeDirectoryPath(this.fileService, bundleUri.path.toString(), state.workspaceRoots))) {
                throw new Error('Preview bundle directory is symlinked or outside the workspace.');
            }
            await this.fileService.createFolder(bundleUri, { fromUserGesture: false });
            const storage = result.preview ? await this.storePreview(state, result.preview, bundleUri) : {};
            const persisted = this.persistedResult(result, storage);
            const resultUri = bundleUri.resolve('result.json');
            if (!(await isSafeFileTarget(this.fileService, resultUri.path.toString(), state.workspaceRoots))) {
                throw new Error('Preview result target is symlinked or outside the workspace.');
            }
            await this.fileService.write(resultUri, this.serializePersistedResult(persisted));
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
            if (preview.data.length > Math.ceil((MAX_PERSISTED_PREVIEW_BYTES * 4) / 3) + 1024) {
                return this.oversizeWarning();
            }
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
                if (!(await isSafeFileTarget(this.fileService, target.path.toString(), state.workspaceRoots))) {
                    return { warning: 'Preview target is symlinked or outside the workspace; no preview file was written.' };
                }
                await this.fileService.writeFile(target, BinaryBuffer.wrap(parsed.bytes));
                return { previewPath: target.path.toString(), previewMimeType: parsed.mimeType };
            }
            if (preview.kind === 'markdown') {
                const bytes = UTF8_ENCODER.encode(preview.data);
                if (bytes.byteLength > MAX_PERSISTED_PREVIEW_BYTES) {
                    return this.oversizeWarning();
                }
                const target = bundleUri.resolve('preview.txt');
                if (!(await isSafeFileTarget(this.fileService, target.path.toString(), state.workspaceRoots))) {
                    return { warning: 'Preview target is symlinked or outside the workspace; no preview file was written.' };
                }
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
            if (!(await isReferenceableFilePath(this.fileService, preview.path, state.workspaceRoots))) {
                return { warning: 'Preview path is outside the workspace or is a symlink; it was not referenced.' };
            }
            const mimeType = preview.mimeType ?? previewMimeForPath(preview.path);
            return {
                previewPath: preview.path,
                ...(mimeType !== undefined ? { previewMimeType: mimeType } : {})
            };
        }
        return { warning: 'Preview has no data or path; no preview file was written.' };
    }

    protected oversizeWarning(): PreviewStorage {
        return { warning: 'Preview is larger than 8 MiB and was not saved; the preview is still shown in the chat.' };
    }

    protected persistedResult(result: NukeCapabilityResult, storage: PreviewStorage): Record<string, unknown> {
        const persisted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(result)) {
            if (key === 'preview' || key === 'undoToken') {
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
                preview.caption = sanitizeForDisk(result.preview.caption);
            }
            if (result.preview.limitations !== undefined) {
                preview.limitations = result.preview.limitations.map((limitation) => sanitizeForDisk(limitation));
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

    /** Keep the snapshot bounded; a huge result keeps only preview metadata. */
    protected serializePersistedResult(persisted: Record<string, unknown>): string {
        const json = JSON.stringify(persisted, null, 2);
        if (utf8Length(json) <= MAX_PERSISTED_RESULT_BYTES) {
            return json;
        }
        const preview = isRecord(persisted.preview) ? persisted.preview : undefined;
        return JSON.stringify(
            {
                ok: persisted.ok === true,
                truncated: true,
                note: `Result snapshot exceeded ${MAX_PERSISTED_RESULT_BYTES} bytes; only preview metadata was kept.`,
                ...(preview ? { preview } : {})
            },
            null,
            2
        );
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
        if (!(await isSafeFileTarget(this.fileService, target.path.toString(), state.workspaceRoots))) {
            this.logger.warn('[NukeAi] Preview trajectory target is symlinked or outside the workspace; skipping the write.');
            return;
        }
        if (!state.trajectoryLoaded) {
            state.trajectoryLoaded = true;
            try {
                if (await this.fileService.exists(target)) {
                    state.trajectoryText = trimTrajectory(
                        (await this.fileService.read(target)).value,
                        this.options.maxTrajectoryBytes ?? DEFAULT_MAX_TRAJECTORY_BYTES
                    );
                }
            } catch (error) {
                this.logger.warn('[NukeAi] Failed to read the existing preview trajectory; starting a new one:', error);
            }
        }
        const existing = state.trajectoryText ?? '';
        const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
        const next = `${existing}${separator}${JSON.stringify(entry)}\n`;
        state.trajectoryText = trimTrajectory(next, this.options.maxTrajectoryBytes ?? DEFAULT_MAX_TRAJECTORY_BYTES);
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
        return INLINE_DATA_URI.test(value) ? '[inline data omitted]' : redactSecret(value);
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
            record[key] = SECRET_KEY.test(key) ? '[redacted]' : sanitizeForDisk(entry, seen);
        }
        return record;
    } finally {
        seen.delete(value);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep the newest complete JSONL records within the byte cap. */
function trimTrajectory(text: string, maxBytes: number): string {
    if (utf8Length(text) <= maxBytes) {
        return text;
    }
    const lines = text.split('\n').filter((line) => line.length > 0);
    const kept: string[] = [];
    let size = 0;
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = `${lines[index]}\n`;
        const lineBytes = utf8Length(line);
        if (lineBytes > maxBytes) {
            break;
        }
        if (kept.length > 0 && size + lineBytes > maxBytes) {
            break;
        }
        kept.unshift(lines[index]);
        size += lineBytes;
    }
    return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

function utf8Length(value: string): number {
    return UTF8_ENCODER.encode(value).byteLength;
}
