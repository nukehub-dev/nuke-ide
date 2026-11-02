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
 * Nuke Tool Result
 *
 * Renders a {@link NukeCapabilityResult} as bounded Theia tool content. The
 * model always receives a short human-readable summary, an error block for
 * failures, at most 32 KiB of compact JSON, and one caption block per preview.
 * Strings are capped at 8 KiB and inline base64 payloads are omitted from the
 * JSON block so a capability cannot flood the model context with logs or
 * binary data. Structured change sets and their undo tokens travel in the same
 * bounded JSON block. Preview images become Theia image blocks; path previews are
 * read through {@link FileService} and fall back to a text link when the read
 * fails or the file is too large.
 *
 * @module nuke-ai/browser/capabilities
 */

import { ToolCallContent, ToolCallContentResult } from '@theia/ai-core/lib/common/language-model';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import * as path from 'path';
import { NukeArtifact, NukeCapabilityResult, NukeChange, NukeChangeSet, NukePreview } from 'nuke-core/lib/common/nuke-capability-protocol';
import { isReferenceableFilePath } from '../preview/preview-path-policy';
import {
    MAX_RENDERED_PREVIEW_BYTES,
    baseMimeType,
    bytesToBase64,
    parsePreviewDataUri,
    previewMimeForExtension,
    previewText
} from '../../common/nuke-preview-protocol';

const MAX_STRING_BYTES = 8 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_ARTIFACT_LINES = 50;
const MAX_FALLBACK_CHANGES = 8;
const MAX_FALLBACK_FIELD_LENGTH = 512;
const MAX_VALUE_ENTRIES = 500;
const MAX_VALUE_DEPTH = 8;
const TRUNCATION_MARKER = '[truncated]';
const BASE64_OMITTED = '[base64 omitted]';
const PREVIEW_OMITTED = '[preview omitted]';
const BINARY_OMITTED = '[binary omitted]';
const CIRCULAR_MARKER = '[circular]';
const BASE64_LIKE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_DATA_URI = /^data:[^,]*;base64,/i;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** Extra capture metadata passed by the bridge without mutating the result. */
export interface NukeToolResultMetadata {
    readonly previewPath?: string;
    readonly workspaceRoots?: readonly string[];
}

/**
 * Convert a capability result to bounded Theia tool call content.
 *
 * @param result capability envelope returned by the domain handler.
 * @param fileService optional reader for path-based previews; without it path
 *   previews render as text links.
 * @param metadata optional persisted preview path used only in the JSON block.
 */
export async function toToolCallContent(
    result: NukeCapabilityResult,
    fileService?: FileService,
    metadata?: NukeToolResultMetadata
): Promise<ToolCallContent> {
    const message = messageOf(result);
    const content: ToolCallContentResult[] = [];
    if (!result.ok) {
        content.push({ type: 'error', data: truncateString(message) });
    }
    content.push({ type: 'text', text: truncateString(message) });
    if (result.preview) {
        content.push(await renderPreview(result.preview, fileService, metadata));
        content.push({ type: 'text', text: previewSummary(result.preview) });
    }
    if (result.data !== undefined || result.preview !== undefined || result.changeSet !== undefined || result.undoToken !== undefined) {
        content.push({ type: 'text', text: buildJson(result, metadata) });
    }
    if (result.artifacts && result.artifacts.length > 0) {
        const lines = result.artifacts.slice(0, MAX_ARTIFACT_LINES).map(artifactLine);
        if (result.artifacts.length > MAX_ARTIFACT_LINES) {
            lines.push(`[${result.artifacts.length - MAX_ARTIFACT_LINES} more artifacts]`);
        }
        content.push({ type: 'text', text: lines.join('\n') });
    }
    return { content };
}

function messageOf(result: NukeCapabilityResult): string {
    if (typeof result.message === 'string' && result.message.length > 0) {
        return result.message;
    }
    return result.ok ? 'Done.' : 'Failed.';
}

function buildJson(result: NukeCapabilityResult, metadata?: NukeToolResultMetadata): string {
    const payload: Record<string, unknown> = { ok: result.ok };
    if (result.data !== undefined) {
        payload.data = truncateValue(result.data);
    }
    if (result.preview) {
        payload.preview = boundedPreview(result.preview, metadata);
    }
    if (result.warnings && result.warnings.length > 0) {
        payload.warnings = result.warnings.map(truncateString);
    }
    if (result.changeSet) {
        payload.changeSet = boundedChangeSet(result.changeSet);
    }
    if (result.undoToken !== undefined) {
        payload.undoToken = truncateString(result.undoToken);
    }
    if (result.nextActions && result.nextActions.length > 0) {
        payload.nextActions = result.nextActions.map((action) => ({
            capability: truncateString(action.capability),
            reason: truncateString(action.reason)
        }));
    }
    if (result.handle !== undefined) {
        payload.handle = truncateString(result.handle);
    }
    if (result.artifacts && result.artifacts.length > 0) {
        payload.artifacts = result.artifacts.map(boundedArtifact);
    }
    const json = JSON.stringify(payload);
    if (utf8Length(json) <= MAX_JSON_BYTES) {
        return json;
    }
    const fallback: Record<string, unknown> = {
        ok: result.ok,
        truncated: true,
        note: `Result exceeded ${MAX_JSON_BYTES} bytes and was truncated. ${TRUNCATION_MARKER}`
    };
    if (result.changeSet) {
        fallback.changeSet = compactChangeSet(result.changeSet);
    }
    if (result.undoToken !== undefined) {
        fallback.undoToken = truncateString(result.undoToken);
    }
    const fallbackJson = JSON.stringify(fallback);
    if (utf8Length(fallbackJson) <= MAX_JSON_BYTES) {
        return fallbackJson;
    }
    return JSON.stringify({
        ok: result.ok,
        truncated: true,
        note: `Result exceeded ${MAX_JSON_BYTES} bytes and was truncated. ${TRUNCATION_MARKER}`,
        ...(result.undoToken !== undefined ? { undoToken: truncateString(result.undoToken) } : {})
    });
}

/** Describe the preview without exposing its payload. */
function boundedPreview(preview: NukePreview, metadata?: NukeToolResultMetadata): Record<string, unknown> {
    const bounded: Record<string, unknown> = {
        kind: preview.kind,
        truthful: preview.truthful
    };
    if (preview.mimeType !== undefined) {
        bounded.mimeType = truncateString(preview.mimeType);
    }
    if (preview.caption !== undefined) {
        bounded.caption = truncateString(preview.caption);
    }
    if (preview.limitations !== undefined) {
        bounded.limitations = preview.limitations.map(truncateString);
    }
    const reference = preview.path ?? metadata?.previewPath;
    if (reference !== undefined) {
        bounded.path = truncateString(reference);
        bounded.data = truncateString(reference);
    } else {
        bounded.data = PREVIEW_OMITTED;
    }
    return bounded;
}

/** Bound every string in a change set and never inline binary diff values. */
function boundedChangeSet(changeSet: NukeChangeSet): Record<string, unknown> {
    const bounded: Record<string, unknown> = {
        id: truncateString(changeSet.id),
        title: truncateString(changeSet.title),
        summary: truncateString(changeSet.summary),
        changes: changeSet.changes.map(boundedChange)
    };
    if (changeSet.applyCapability !== undefined) {
        bounded.applyCapability = truncateString(changeSet.applyCapability);
    }
    return bounded;
}

function compactChangeSet(changeSet: NukeChangeSet): Record<string, unknown> {
    return {
        id: field(changeSet.id),
        title: field(changeSet.title),
        summary: field(changeSet.summary),
        changes: changeSet.changes.slice(0, MAX_FALLBACK_CHANGES).map((change) => ({
            path: field(change.path),
            label: field(change.label),
            kind: change.kind
        })),
        ...(changeSet.applyCapability !== undefined ? { applyCapability: field(changeSet.applyCapability) } : {})
    };
}

function field(value: string): string {
    return truncateString(value).slice(0, MAX_FALLBACK_FIELD_LENGTH);
}

function boundedChange(change: NukeChange): Record<string, unknown> {
    const bounded: Record<string, unknown> = {
        path: truncateString(change.path),
        label: truncateString(change.label),
        kind: change.kind
    };
    if (change.before !== undefined) {
        bounded.before = truncateValue(change.before);
    }
    if (change.after !== undefined) {
        bounded.after = truncateValue(change.after);
    }
    return bounded;
}

async function renderPreview(
    preview: NukePreview,
    fileService?: FileService,
    metadata?: NukeToolResultMetadata
): Promise<ToolCallContentResult> {
    switch (preview.kind) {
        case 'image':
        case 'svg':
            return renderImagePreview(preview, fileService, metadata);
        case 'html':
            return renderHtmlPreview(preview);
        case 'markdown':
            return renderMarkdownPreview(preview);
        default:
            return { type: 'text', text: 'Preview unavailable: unsupported preview kind.' };
    }
}

async function renderImagePreview(
    preview: NukePreview,
    fileService?: FileService,
    metadata?: NukeToolResultMetadata
): Promise<ToolCallContentResult> {
    if (preview.data !== undefined && preview.data.length > 0) {
        if (preview.data.length > Math.ceil((MAX_RENDERED_PREVIEW_BYTES * 4) / 3) + 1024) {
            return { type: 'text', text: 'Preview unavailable: the inline preview is larger than 4 MiB.' };
        }
        const parsed = parsePreviewDataUri(preview.data);
        if (!parsed) {
            return { type: 'text', text: 'Preview unavailable: the preview data URI is malformed.' };
        }
        if (parsed.bytes.byteLength > MAX_RENDERED_PREVIEW_BYTES) {
            return { type: 'text', text: 'Preview unavailable: the inline preview is larger than 4 MiB.' };
        }
        const mimeType = baseMimeType(parsed.mimeType);
        if (preview.kind === 'svg' && mimeType !== 'image/svg+xml') {
            return { type: 'text', text: 'Preview unavailable: the SVG preview is not an image/svg+xml data URI.' };
        }
        if (preview.kind === 'image' && !mimeType.startsWith('image/')) {
            return { type: 'text', text: 'Preview unavailable: the image preview data URI has a non-image mime type.' };
        }
        return { type: 'image', base64data: parsed.base64, mimeType: parsed.mimeType };
    }
    if (preview.path !== undefined && preview.path.length > 0) {
        return renderImagePath(preview, preview.path, fileService, metadata?.workspaceRoots ?? []);
    }
    return { type: 'text', text: 'Preview unavailable: no preview data or path was provided.' };
}

async function renderImagePath(
    preview: NukePreview,
    imagePath: string,
    fileService: FileService | undefined,
    workspaceRoots: readonly string[]
): Promise<ToolCallContentResult> {
    if (!fileService) {
        return previewLink(preview, imagePath, 'no file service is available to read it.');
    }
    if (!path.isAbsolute(imagePath)) {
        return previewLink(preview, imagePath, 'the path is not absolute.');
    }
    if (!(await isReferenceableFilePath(fileService, imagePath, workspaceRoots))) {
        return previewLink(preview, imagePath, 'the path is outside the workspace or contains a symlink.');
    }
    const resource = URI.fromFilePath(imagePath);
    try {
        let size: number | undefined;
        try {
            size = (await fileService.resolve(resource, { resolveMetadata: true })).size;
        } catch {
            size = undefined;
        }
        if (typeof size === 'number' && size > MAX_RENDERED_PREVIEW_BYTES) {
            return previewLink(preview, imagePath, 'the file is larger than 4 MiB.');
        }
        const content = await fileService.readFile(resource, { limits: { size: MAX_RENDERED_PREVIEW_BYTES } });
        const bytes = content.value.buffer;
        if (bytes.byteLength > MAX_RENDERED_PREVIEW_BYTES) {
            return previewLink(preview, imagePath, 'the file is larger than 4 MiB.');
        }
        const mimeType = preview.mimeType ?? previewMimeForExtension(path.extname(imagePath));
        if (!mimeType || !baseMimeType(mimeType).startsWith('image/')) {
            return previewLink(preview, imagePath, 'its image type is unknown.');
        }
        return { type: 'image', base64data: bytesToBase64(bytes), mimeType };
    } catch (error) {
        return previewLink(preview, imagePath, errorMessage(error));
    }
}

function renderHtmlPreview(preview: NukePreview): ToolCallContentResult {
    if (preview.data !== undefined && preview.data.length > 0) {
        if (preview.data.length > MAX_RENDERED_PREVIEW_BYTES + 1024) {
            return { type: 'text', text: 'Preview unavailable: the inline HTML preview is larger than 4 MiB.' };
        }
        if (preview.data.length > Math.ceil((MAX_RENDERED_PREVIEW_BYTES * 4) / 3) + 1024) {
            return { type: 'text', text: 'Preview unavailable: the inline preview is larger than 4 MiB.' };
        }
        const parsed = parsePreviewDataUri(preview.data);
        if (parsed && baseMimeType(parsed.mimeType) !== 'text/html') {
            return { type: 'text', text: 'Preview unavailable: the HTML preview data URI is not text/html.' };
        }
        if (!parsed && preview.data.startsWith('data:')) {
            return { type: 'text', text: 'Preview unavailable: the preview data URI is malformed.' };
        }
        const html = parsed ? previewText(parsed) : preview.data;
        if (utf8Length(html) > MAX_RENDERED_PREVIEW_BYTES) {
            return { type: 'text', text: 'Preview unavailable: the inline HTML preview is larger than 4 MiB.' };
        }
        return {
            type: 'html',
            html,
            ...(preview.caption !== undefined ? { title: preview.caption } : {})
        };
    }
    if (preview.path !== undefined && preview.path.length > 0) {
        return previewLink(preview, preview.path, 'HTML previews must provide inline HTML.');
    }
    return { type: 'text', text: 'Preview unavailable: no preview data or path was provided.' };
}

function renderMarkdownPreview(preview: NukePreview): ToolCallContentResult {
    if (preview.data !== undefined && preview.data.length > 0) {
        if (preview.data.length > MAX_RENDERED_PREVIEW_BYTES + 1024) {
            return { type: 'text', text: 'Preview unavailable: the inline markdown preview is larger than 4 MiB.' };
        }
        if (preview.data.length > Math.ceil((MAX_RENDERED_PREVIEW_BYTES * 4) / 3) + 1024) {
            return { type: 'text', text: 'Preview unavailable: the inline preview is larger than 4 MiB.' };
        }
        const parsed = parsePreviewDataUri(preview.data);
        if (!parsed && preview.data.startsWith('data:')) {
            return { type: 'text', text: 'Preview unavailable: the preview data URI is malformed.' };
        }
        return { type: 'text', text: truncateString(parsed ? previewText(parsed) : preview.data) };
    }
    if (preview.path !== undefined && preview.path.length > 0) {
        return previewLink(preview, preview.path, 'markdown previews must provide inline text.');
    }
    return { type: 'text', text: 'Preview unavailable: no preview data or path was provided.' };
}

function previewLink(preview: NukePreview, target: string, reason: string): ToolCallContentResult {
    return {
        type: 'text',
        text: `Preview ${preview.kind}: ${truncateString(target)}\nPreview not embedded: ${reason}`
    };
}

/** Always state what the preview shows and where it is not exact. */
function previewSummary(preview: NukePreview): string {
    const caption = preview.caption?.trim();
    const lines = [`Preview: ${caption && caption.length > 0 ? truncateString(caption) : preview.kind}`];
    if (preview.limitations && preview.limitations.length > 0) {
        lines.push(`Limitations: ${truncateString(preview.limitations.join('; '))}`);
    }
    if (!preview.truthful) {
        lines.push('Preview is approximate');
    }
    return lines.join('\n');
}

function artifactLine(artifact: NukeArtifact): string {
    const label = truncateString(artifact.label);
    const target = artifact.path ?? artifact.uri;
    return target ? `${label}: ${truncateString(target)}` : label;
}

function boundedArtifact(artifact: NukeArtifact): Record<string, unknown> {
    const bounded: Record<string, unknown> = {
        kind: artifact.kind,
        label: truncateString(artifact.label)
    };
    if (artifact.path !== undefined) {
        bounded.path = truncateString(artifact.path);
    }
    if (artifact.uri !== undefined) {
        bounded.uri = truncateString(artifact.uri);
    }
    if (artifact.mimeType !== undefined) {
        bounded.mimeType = truncateString(artifact.mimeType);
    }
    return bounded;
}

function truncateValue(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
    if (typeof value === 'string') {
        return truncateString(value);
    }
    if (value === null || typeof value !== 'object') {
        return typeof value === 'bigint' ? value.toString() : value;
    }
    if (seen.has(value)) {
        return CIRCULAR_MARKER;
    }
    if (depth >= MAX_VALUE_DEPTH) {
        return '[truncated]';
    }
    seen.add(value);
    try {
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            return BINARY_OMITTED;
        }
        if (Array.isArray(value)) {
            return value.slice(0, MAX_VALUE_ENTRIES).map((entry) => truncateValue(entry, seen, depth + 1));
        }
        if (value instanceof Date) {
            return value.toISOString();
        }
        const bounded: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value).slice(0, MAX_VALUE_ENTRIES)) {
            bounded[key] = truncateValue(entry, seen, depth + 1);
        }
        return bounded;
    } finally {
        seen.delete(value);
    }
}

function truncateString(value: string): string {
    if (BASE64_DATA_URI.test(value)) {
        return BASE64_OMITTED;
    }
    if (utf8Length(value) <= MAX_STRING_BYTES) {
        return value;
    }
    if (BASE64_LIKE.test(value)) {
        return BASE64_OMITTED;
    }
    const markerBytes = utf8Length(TRUNCATION_MARKER);
    let truncated = UTF8_DECODER.decode(UTF8_ENCODER.encode(value).slice(0, MAX_STRING_BYTES - markerBytes));
    while (truncated.length > 0 && utf8Length(truncated + TRUNCATION_MARKER) > MAX_STRING_BYTES) {
        truncated = truncated.slice(0, -1);
    }
    return truncated + TRUNCATION_MARKER;
}

function utf8Length(value: string): number {
    return UTF8_ENCODER.encode(value).length;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
