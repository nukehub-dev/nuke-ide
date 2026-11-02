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
 * Preview path policy.
 *
 * NukeAI reads path previews and writes local preview/journal files. Both
 * directions stay inside the active workspace and reject symlinked path
 * components so a workspace cannot redirect a read or write outside its roots.
 *
 * @module nuke-ai/browser/preview
 */

import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import { URI } from '@theia/core/lib/common/uri';
import * as path from 'path';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';

/** Return the deepest workspace root containing `candidate`, if any. */
function containingRoot(candidate: string, roots: readonly string[]): string | undefined {
    const normalized = path.resolve(candidate);
    return roots
        .map((entry) => path.resolve(entry))
        .filter((entry) => isWithinWorkspace(normalized, [entry]))
        .sort((left, right) => right.length - left.length)[0];
}

/**
 * True when every existing path component from the workspace root to
 * `candidate` is a real directory and no component is a symlink. Missing
 * components are allowed so callers can create a new private directory.
 */
export async function isSafeDirectoryPath(
    fileService: Pick<FileService, 'resolve'>,
    candidate: string,
    roots: readonly string[]
): Promise<boolean> {
    const normalized = path.resolve(candidate);
    const root = containingRoot(normalized, roots);
    if (!root) {
        return false;
    }
    const segments = path
        .relative(root, normalized)
        .split(path.sep)
        .filter((segment) => segment.length > 0);
    let current = root;
    try {
        for (const segment of segments) {
            current = path.join(current, segment);
            try {
                const stat = await fileService.resolve(URI.fromFilePath(current));
                if (stat.isSymbolicLink || !stat.isDirectory) {
                    return false;
                }
            } catch {
                // The first missing component means the remaining path will be
                // created by FileService; no existing symlink can redirect it.
                return true;
            }
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * True when `candidate` is inside a workspace root, its parent directory is
 * symlink-free, and the target is either absent or a regular non-symlink file.
 */
export async function isSafeFileTarget(
    fileService: Pick<FileService, 'resolve'>,
    candidate: string,
    roots: readonly string[]
): Promise<boolean> {
    const normalized = path.resolve(candidate);
    if (!containingRoot(normalized, roots)) {
        return false;
    }
    if (!(await isSafeDirectoryPath(fileService, path.dirname(normalized), roots))) {
        return false;
    }
    try {
        const stat = await fileService.resolve(URI.fromFilePath(normalized));
        return !stat.isSymbolicLink && stat.isFile;
    } catch {
        // A missing target is safe; the caller creates it inside the checked
        // parent directory.
        return true;
    }
}

/**
 * True when `candidate` is an existing regular file inside a workspace root and
 * every component from the root down is a real, non-symlinked path.
 */
export async function isReferenceableFilePath(
    fileService: Pick<FileService, 'resolve'>,
    candidate: string,
    roots: readonly string[]
): Promise<boolean> {
    if (!(await isSafeFileTarget(fileService, candidate, roots))) {
        return false;
    }
    try {
        const stat = await fileService.resolve(URI.fromFilePath(path.resolve(candidate)));
        return stat.isFile && !stat.isSymbolicLink;
    } catch {
        return false;
    }
}
