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
 * Filesystem and size policy for AI-authored Python model scripts.
 *
 * A script source must be an absolute `.py` file inside a workspace root,
 * resolve through a chain of non-symlink filesystem entries, and stay within
 * the byte and line caps. The returned snapshot is complete: oversized sources
 * are rejected rather than truncated, so a proposal can never be built against
 * a partial base. Only the import list is bounded, and `truncated` reports
 * that bound.
 *
 * Script text is untrusted data. It is read, hashed, and passed to the sandbox;
 * it is never rendered as HTML or executed outside the sandboxed build path.
 *
 * @module nuke-cad/browser/capabilities
 */

import { URI } from '@theia/core/lib/common/uri';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import * as path from 'path';

/** Maximum accepted script size. */
export const MAX_SCRIPT_BYTES = 64 * 1024;

/** Maximum accepted script line count. */
export const MAX_SCRIPT_LINES = 2000;

/** Maximum number of imports reported for one script. */
export const MAX_SCRIPT_IMPORTS = 50;

/** Maximum unified-diff size shown to the user. */
export const MAX_DIFF_BYTES = 32 * 1024;

/** Maximum unified-diff line count shown to the user. */
export const MAX_DIFF_LINES = 200;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const IMPORT_PATTERN = /^[ \t]*((?:from|import)\s+[^\n#]+)/gm;
const MODEL_ASSIGNMENT_PATTERN = /^model[ \t]*=/m;

/** Bounded, read-only view of the active model script. */
export interface ScriptSourceSnapshot {
    /** Canonical lexical path. */
    readonly path: string;
    /** Complete UTF-8 source text. */
    readonly content: string;
    /** Lowercase SHA-256 of {@link content}. */
    readonly hash: string;
    /** UTF-8 byte length of {@link content}. */
    readonly bytes: number;
    /** Logical line count, ignoring a single trailing newline. */
    readonly lines: number;
    /** Leading import statements, capped at {@link MAX_SCRIPT_IMPORTS}. */
    readonly imports: readonly string[];
    /** Whether the source assigns a top-level `model`. */
    readonly hasModelAssignment: boolean;
    /** True when more imports exist than the returned bounded list. */
    readonly truncated: boolean;
}

/** Result of reading the active model script. */
export type ScriptSourceReadResult =
    { readonly ok: true; readonly value: ScriptSourceSnapshot } | { readonly ok: false; readonly message: string };

/** Result of validating a model-proposed script body. */
export type ProposedScriptValidation =
    | {
          readonly ok: true;
          readonly content: string;
          readonly hash?: string;
          readonly bytes: number;
          readonly lines: number;
          readonly imports: readonly string[];
          readonly hasModelAssignment: boolean;
      }
    | { readonly ok: false; readonly message: string };

/**
 * Read the active Python model script under the source policy.
 *
 * Lexical checks run before the filesystem is touched. The component walk then
 * rejects symlinks, directories, and missing entries, after which the file is
 * decoded as strict UTF-8. No path outside the workspace is ever read.
 *
 * @param fileService - File service used for path resolution and reading.
 * @param scriptPath - Active script path from the CAD context.
 * @param workspaceRoots - Workspace roots the script must stay inside.
 * @returns The complete snapshot, or a user-facing rejection message.
 */
export async function readActiveScript(
    fileService: Pick<FileService, 'resolve' | 'readFile'>,
    scriptPath: string | undefined,
    workspaceRoots: readonly string[]
): Promise<ScriptSourceReadResult> {
    if (typeof scriptPath !== 'string' || scriptPath.trim().length === 0) {
        return { ok: false, message: 'Open a saved Python model script before asking NukeAI to inspect or change it.' };
    }
    if (!path.isAbsolute(scriptPath)) {
        return { ok: false, message: 'The active CAD script path must be absolute.' };
    }
    const canonical = path.resolve(scriptPath);
    if (!isWithinWorkspace(canonical, workspaceRoots)) {
        return { ok: false, message: 'The active CAD script is outside every workspace root.' };
    }
    if (path.extname(canonical).toLowerCase() !== '.py') {
        return { ok: false, message: 'Script authoring applies only to Python (.py) model scripts.' };
    }
    const root = containingRoot(canonical, workspaceRoots);
    if (root === undefined) {
        return { ok: false, message: 'The active CAD script is outside every workspace root.' };
    }
    const relative = path.relative(root, canonical);
    const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
    if (segments.length === 0) {
        return { ok: false, message: 'The active CAD script must be a file, not a workspace folder.' };
    }

    let current = root;
    let finalStat: FileStat | undefined;
    try {
        for (const segment of segments) {
            current = path.join(current, segment);
            const stat = await fileService.resolve(new URI(current));
            if (stat.isSymbolicLink) {
                return { ok: false, message: 'The active CAD script path contains a symbolic link.' };
            }
            finalStat = stat;
        }
    } catch {
        return { ok: false, message: 'The active CAD script does not exist or cannot be read.' };
    }
    if (finalStat === undefined || !finalStat.isFile || finalStat.isDirectory || finalStat.isSymbolicLink) {
        return { ok: false, message: 'The active CAD script must be a regular file, not a directory.' };
    }
    if (finalStat.size !== undefined && finalStat.size > MAX_SCRIPT_BYTES) {
        return { ok: false, message: 'The active CAD script is larger than the 64 KiB script limit.' };
    }

    let content: string;
    try {
        const file = await fileService.readFile(new URI(canonical));
        content = UTF8_DECODER.decode(file.value.buffer);
    } catch {
        return { ok: false, message: 'The active CAD script could not be read as UTF-8 text.' };
    }
    if (content.includes('\u0000')) {
        return { ok: false, message: 'The active CAD script contains a NUL byte and is not a text file.' };
    }
    const bytes = utf8Length(content);
    if (bytes > MAX_SCRIPT_BYTES) {
        return { ok: false, message: 'The active CAD script is larger than the 64 KiB script limit.' };
    }
    const lines = countScriptLines(content);
    if (lines > MAX_SCRIPT_LINES) {
        return { ok: false, message: 'The active CAD script has more than 2,000 lines.' };
    }

    const imports = scanImports(content);
    let hash: string;
    try {
        hash = await hashScriptContent(content);
    } catch {
        return { ok: false, message: 'The active CAD script could not be hashed in this browser.' };
    }
    return {
        ok: true,
        value: {
            path: canonical,
            content,
            hash,
            bytes,
            lines,
            imports: imports.statements,
            hasModelAssignment: MODEL_ASSIGNMENT_PATTERN.test(content),
            truncated: imports.truncated
        }
    };
}

/**
 * Validate a full script body proposed by the model.
 *
 * This is a pure, synchronous policy check over the proposed text. Hashing is
 * deliberately separate ({@link hashScriptContent}) so the caller can report a
 * hash only after the proposal is accepted.
 *
 * @param base - Snapshot the change is resolved against.
 * @param proposedScript - Full replacement body.
 * @returns The accepted content and derived metadata, or a rejection message.
 */
export function validateProposedScript(base: ScriptSourceSnapshot, proposedScript: string): ProposedScriptValidation {
    if (typeof proposedScript !== 'string') {
        return { ok: false, message: 'The proposed script must be a text body.' };
    }
    if (proposedScript.includes('\u0000')) {
        return { ok: false, message: 'The proposed script contains a NUL byte and is not a text file.' };
    }
    const bytes = utf8Length(proposedScript);
    if (bytes > MAX_SCRIPT_BYTES) {
        return { ok: false, message: 'The proposed script is larger than the 64 KiB script limit.' };
    }
    const lines = countScriptLines(proposedScript);
    if (lines > MAX_SCRIPT_LINES) {
        return { ok: false, message: 'The proposed script has more than 2,000 lines.' };
    }
    if (proposedScript === base.content) {
        return { ok: false, message: 'The proposed script does not change the active script.' };
    }
    return {
        ok: true,
        content: proposedScript,
        bytes,
        lines,
        imports: scanImports(proposedScript).statements,
        hasModelAssignment: MODEL_ASSIGNMENT_PATTERN.test(proposedScript)
    };
}

/**
 * Lowercase SHA-256 hex digest of script text.
 *
 * @param content - UTF-8 script text.
 * @returns A 64-character lowercase hexadecimal digest.
 */
export async function hashScriptContent(content: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', UTF8_ENCODER.encode(content));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Deepest workspace root containing the candidate. */
function containingRoot(candidate: string, workspaceRoots: readonly string[]): string | undefined {
    return workspaceRoots
        .filter((root) => typeof root === 'string' && root.length > 0 && isWithinWorkspace(candidate, [root]))
        .map((root) => path.resolve(root))
        .sort((left, right) => right.length - left.length)[0];
}

/** Count logical lines; a single trailing newline does not add an empty line. */
function countScriptLines(content: string): number {
    if (content.length === 0) {
        return 0;
    }
    let lines = 1;
    for (let index = 0; index < content.length; index++) {
        if (content.charCodeAt(index) === 10) {
            lines++;
        }
    }
    if (content.charCodeAt(content.length - 1) === 10) {
        lines--;
    }
    return lines;
}

interface ImportScan {
    readonly statements: readonly string[];
    readonly truncated: boolean;
}

/** Collect leading import statements, bounded to the public import cap. */
function scanImports(content: string): ImportScan {
    if (!content.includes('import')) {
        return { statements: [], truncated: false };
    }
    const pattern = new RegExp(IMPORT_PATTERN.source, 'gm');
    const statements: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
        if (statements.length >= MAX_SCRIPT_IMPORTS) {
            return { statements, truncated: true };
        }
        statements.push(match[1].trim());
    }
    return { statements, truncated: false };
}

function utf8Length(value: string): number {
    return UTF8_ENCODER.encode(value).byteLength;
}
