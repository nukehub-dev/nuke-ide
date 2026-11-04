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
 * Filesystem policy for CAD import sources.
 *
 * An import source must be an absolute path inside a workspace root, use an
 * exchange-file extension, stay below the size cap, and resolve through a chain
 * of non-symlink filesystem entries ending in a regular file. The policy also
 * classifies document-owned `<stem>.parts/` sources, which an AI session may
 * inspect without asking the user to pick the file again.
 *
 * @module nuke-cad/browser/capabilities
 */

import { URI } from '@theia/core/lib/common/uri';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import * as path from 'path';

/** Maximum accepted import source size. */
export const MAX_IMPORT_SOURCE_BYTES = 256 * 1024 * 1024;

/** Exchange formats accepted as import sources. */
export const IMPORT_SOURCE_EXTENSIONS = ['step', 'stp', 'iges', 'igs', 'brep'] as const;

/** A validated import source path and its document ownership classification. */
export interface ValidatedImportSource {
    /** Canonical lexical path. */
    readonly path: string;
    /** File size from the filesystem stat. */
    readonly size: number;
    /** True when the source lives inside the document-owned `<stem>.parts/` folder. */
    readonly implicitPartsSource: boolean;
}

/** Validation result for an import source. */
export type ImportSourceValidation =
    { readonly ok: true; readonly value: ValidatedImportSource } | { readonly ok: false; readonly message: string };

/** Folder that owns a document's copied import sources. */
export function documentPartsFolder(documentPath: string): string | undefined {
    if (!documentPath.endsWith('.nuke-cad')) {
        return undefined;
    }
    return `${path.resolve(documentPath).slice(0, -'.nuke-cad'.length)}.parts`;
}

/**
 * Validate a user- or model-supplied CAD import source.
 *
 * The lexical checks run before any stat call so unsafe paths are rejected
 * without touching the filesystem; the component walk then rejects symlinks
 * (including a symlinked final file), directories, and missing entries.
 */
export async function validateImportSourcePath(
    fileService: Pick<FileService, 'resolve'>,
    sourcePath: string,
    workspaceRoots: readonly string[],
    documentPath: string
): Promise<ImportSourceValidation> {
    if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
        return { ok: false, message: 'Enter a CAD import source path.' };
    }
    if (!path.isAbsolute(sourcePath)) {
        return { ok: false, message: 'The CAD import source path must be absolute.' };
    }
    const canonical = path.resolve(sourcePath);
    if (!isWithinWorkspace(canonical, workspaceRoots)) {
        return { ok: false, message: 'The CAD import source is outside every workspace root.' };
    }
    const extension = path.extname(canonical).slice(1).toLowerCase();
    if (!(IMPORT_SOURCE_EXTENSIONS as readonly string[]).includes(extension)) {
        return {
            ok: false,
            message: `Unsupported CAD import source type '.${extension || '(none)'}'. Use STEP, IGES, or BREP.`
        };
    }
    const root = containingRoot(canonical, workspaceRoots);
    if (root === undefined) {
        return { ok: false, message: 'The CAD import source is outside every workspace root.' };
    }
    const relative = path.relative(root, canonical);
    const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
    if (segments.length === 0) {
        return { ok: false, message: 'The CAD import source must be a file, not a workspace folder.' };
    }

    let current = root;
    let finalStat: FileStat | undefined;
    try {
        for (const segment of segments) {
            current = path.join(current, segment);
            const stat = await fileService.resolve(new URI(current));
            if (stat.isSymbolicLink) {
                return { ok: false, message: 'The CAD import source path contains a symbolic link.' };
            }
            finalStat = stat;
        }
    } catch {
        return { ok: false, message: 'The CAD import source does not exist or cannot be read.' };
    }
    if (finalStat === undefined || finalStat.isDirectory || finalStat.isSymbolicLink) {
        return { ok: false, message: 'The CAD import source must be a regular file, not a directory.' };
    }
    if (finalStat.size === undefined || !Number.isFinite(finalStat.size) || finalStat.size < 0) {
        return { ok: false, message: 'The CAD import source size could not be determined.' };
    }
    if (finalStat.size > MAX_IMPORT_SOURCE_BYTES) {
        return {
            ok: false,
            message: 'The CAD import source is larger than the 256 MiB import limit.'
        };
    }
    return {
        ok: true,
        value: {
            path: canonical,
            size: finalStat.size,
            implicitPartsSource: isInsidePartsFolder(canonical, documentPath)
        }
    };
}

/** Deepest workspace root containing the candidate. */
function containingRoot(candidate: string, workspaceRoots: readonly string[]): string | undefined {
    return workspaceRoots
        .filter((root) => typeof root === 'string' && root.length > 0 && isWithinWorkspace(candidate, [root]))
        .map((root) => path.resolve(root))
        .sort((left, right) => right.length - left.length)[0];
}

/** Whether a canonical path is a file inside the document-owned parts folder. */
function isInsidePartsFolder(candidate: string, documentPath: string): boolean {
    const parts = documentPartsFolder(documentPath);
    if (parts === undefined) {
        return false;
    }
    const relative = path.relative(parts, candidate);
    return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
