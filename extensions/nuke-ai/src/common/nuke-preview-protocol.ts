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
 * Nuke Preview Protocol
 *
 * Append-only preview history persisted under the workspace config folder.
 * Sessions group bundles; each bundle is one capability invocation with a
 * preview file and its result snapshot. The trajectory records the command
 * that produced every bundle so a preview can be replayed later.
 *
 * @module nuke-ai/common
 */

/** Maximum decoded preview size persisted to disk. */
export const MAX_PERSISTED_PREVIEW_BYTES = 8 * 1024 * 1024;

/** Maximum preview image size embedded into a tool result. */
export const MAX_RENDERED_PREVIEW_BYTES = 4 * 1024 * 1024;

/** Maximum length of every string in the persisted trajectory input. */
export const MAX_TRAJECTORY_INPUT_STRING_LENGTH = 200;

/** One preview-store session, created lazily before the first capture. */
export interface NukePreviewSession {
    readonly id: string;
    readonly createdAt: string;
    readonly rootDir?: string;
}

/** One captured capability invocation. */
export interface NukePreviewBundle {
    readonly id: string;
    readonly sessionId: string;
    readonly createdAt: string;
    readonly previewPath?: string;
    readonly previewMimeType?: string;
    /** Human-readable note when persistence was skipped or rejected. */
    readonly warning?: string;
}

/** One command-to-preview line in `trajectory.jsonl`. */
export interface NukeTrajectoryEntry {
    readonly timestamp: string;
    readonly capabilityId: string;
    readonly input: unknown;
    readonly ok: boolean;
    readonly bundleId?: string;
    readonly previewPath?: string;
    readonly artifacts?: readonly string[];
}

/** A decoded `data:<mime>;base64,<payload>` preview. */
export interface ParsedPreviewDataUri {
    readonly mimeType: string;
    readonly base64: string;
    readonly bytes: Uint8Array;
}

const DATA_URI_PATTERN = /^data:([^,]*),([\s\S]*)$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const UTF8_DECODER = new TextDecoder();
const BASE64_CHUNK_SIZE = 0x8000;

/**
 * Parse a base64 data URI. Returns `undefined` for non-base64, malformed, or
 * empty payloads so callers can fall back to a text note without guessing.
 */
export function parsePreviewDataUri(value: string | undefined): ParsedPreviewDataUri | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const match = DATA_URI_PATTERN.exec(value);
    if (!match) {
        return undefined;
    }
    const mediaType = match[1];
    const parameters = mediaType.split(';').slice(1);
    if (!parameters.some((parameter) => parameter.trim().toLowerCase() === 'base64')) {
        return undefined;
    }
    const mimeType = mediaType.split(';')[0].trim();
    if (mimeType.length === 0) {
        return undefined;
    }
    const payload = match[2].replace(/\s+/g, '');
    if (payload.length === 0 || !BASE64_PATTERN.test(payload)) {
        return undefined;
    }
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    let binary: string;
    try {
        binary = atob(padded);
    } catch {
        return undefined;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return { mimeType, base64: padded, bytes };
}

/** Encode bytes as base64 without overflowing the argument stack. */
export function bytesToBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE)));
    }
    return btoa(chunks.join(''));
}

/** Decode UTF-8 bytes from a parsed preview. */
export function previewText(parsed: ParsedPreviewDataUri): string {
    return UTF8_DECODER.decode(parsed.bytes);
}

/** Map a supported preview mime type to its file extension. */
export function previewExtensionForMime(mimeType: string): string | undefined {
    switch (baseMimeType(mimeType)) {
        case 'image/png':
            return 'png';
        case 'image/jpeg':
        case 'image/jpg':
            return 'jpeg';
        case 'image/webp':
            return 'webp';
        case 'image/svg+xml':
            return 'svg';
        case 'text/html':
            return 'html';
        default:
            return undefined;
    }
}

/** Map a stored preview file extension back to a mime type. */
export function previewMimeForExtension(extension: string): string | undefined {
    switch (extension.trim().toLowerCase().replace(/^\./, '')) {
        case 'png':
            return 'image/png';
        case 'jpeg':
        case 'jpg':
            return 'image/jpeg';
        case 'webp':
            return 'image/webp';
        case 'svg':
            return 'image/svg+xml';
        case 'html':
            return 'text/html';
        case 'txt':
            return 'text/plain';
        default:
            return undefined;
    }
}

/** Strip parameters and casing from a mime type. */
export function baseMimeType(mimeType: string): string {
    return mimeType.split(';')[0].trim().toLowerCase();
}
