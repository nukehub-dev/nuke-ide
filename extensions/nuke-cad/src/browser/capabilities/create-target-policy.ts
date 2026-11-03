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
 * Target-path policy for new `.nuke-cad` documents.
 *
 * A new document must land on a fresh `.nuke-cad` path inside a workspace
 * root whose parent folder already exists, stays below the path-length cap,
 * carries no control characters, and reaches the target through a chain of
 * non-symlink filesystem entries. The policy is strict about the extension:
 * the save dialog is responsible for appending `.nuke-cad`, so anything that
 * already has a different extension is rejected rather than rewritten.
 *
 * @module nuke-cad/browser/capabilities
 */

import { URI } from '@theia/core/lib/common/uri';
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import { isWithinWorkspace } from 'nuke-core/lib/browser/capabilities/nuke-capability-registry';
import * as path from 'path';

/** Maximum accepted length of a new-document target path. */
export const MAX_CREATE_TARGET_PATH_LENGTH = 1024;

/** Extension every new CAD document carries. */
export const CREATE_TARGET_EXTENSION = '.nuke-cad';

/** Control characters rejected in every new-document target path. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Result of validating a new-document target path. */
export interface CreateTargetSuccess {
    readonly ok: true;
    /** Canonical absolute path with the `.nuke-cad` extension. */
    readonly path: string;
}

/** Rejection of a new-document target path. */
export interface CreateTargetFailure {
    readonly ok: false;
    readonly message: string;
}

/** Validation result for a new-document target path. */
export type CreateTargetResult = CreateTargetSuccess | CreateTargetFailure;

/**
 * A resolved filesystem entry plus the real path a provider may report for it.
 * Theia's `FileStat` has no `realPath`, but filesystem providers that follow a
 * link surface the destination there, which catches links the provider does
 * not flag with `isSymbolicLink`.
 */
type ResolvedTargetStat = FileStat & { readonly realPath?: string };

/**
 * Validate a target path for a new `.nuke-cad` document.
 * `requested` may be absolute or relative to the first workspace root.
 */
export async function validateCreateTarget(
    fileService: FileService,
    requested: string,
    workspaceRoots: readonly string[]
): Promise<CreateTargetResult> {
    const input = typeof requested === 'string' ? requested.trim() : '';
    if (input.length === 0) {
        return failure('Enter a name for the new CAD document.');
    }
    if (input.includes('\u0000')) {
        return failure('The CAD document path must not contain NUL characters.');
    }
    if (CONTROL_CHARACTERS.test(input)) {
        return failure('The CAD document path must not contain control characters.');
    }
    if (input.length > MAX_CREATE_TARGET_PATH_LENGTH) {
        return failure(longPathMessage());
    }
    const roots = (Array.isArray(workspaceRoots) ? workspaceRoots : []).filter(
        (root): root is string => typeof root === 'string' && root.length > 0 && path.isAbsolute(root)
    );
    if (roots.length === 0) {
        return failure('Open a folder or workspace before creating a CAD document.');
    }

    const canonical = path.resolve(roots[0], input);
    if (!path.isAbsolute(input) && !isWithinWorkspace(canonical, [roots[0]])) {
        return failure('The CAD document path must stay inside the workspace folder.');
    }
    if (path.extname(canonical).toLowerCase() !== CREATE_TARGET_EXTENSION) {
        return failure(`New CAD documents must use the ${CREATE_TARGET_EXTENSION} file extension.`);
    }
    if (!isWithinWorkspace(canonical, roots)) {
        return failure('The CAD document path is outside every workspace root.');
    }
    if (canonical.length > MAX_CREATE_TARGET_PATH_LENGTH) {
        return failure(longPathMessage());
    }

    let targetExists: boolean;
    try {
        targetExists = await fileService.exists(new URI(canonical));
    } catch {
        return failure('The CAD document path cannot be read.');
    }
    if (targetExists) {
        return failure('A file or folder already exists at that path.');
    }

    const root = containingRoot(canonical, roots);
    if (root === undefined) {
        return failure('The CAD document path is outside every workspace root.');
    }
    const segments = path
        .relative(root, canonical)
        .split(path.sep)
        .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
        return failure('A file or folder already exists at that path.');
    }
    let current = root;
    for (let index = 0; index < segments.length; index++) {
        current = path.join(current, segments[index]);
        const isTarget = index === segments.length - 1;
        let stat: ResolvedTargetStat;
        try {
            stat = await fileService.resolve(new URI(current));
        } catch {
            if (isTarget) {
                return { ok: true, path: canonical };
            }
            return failure('The CAD document folder does not exist.');
        }
        if (stat.isSymbolicLink || resolvedElsewhere(stat, current)) {
            return failure('The CAD document path must not contain symbolic links.');
        }
        if (isTarget) {
            return failure('A file or folder already exists at that path.');
        }
        if (!stat.isDirectory) {
            return failure('The CAD document folder is not a directory.');
        }
    }
    return { ok: true, path: canonical };
}

function failure(message: string): CreateTargetFailure {
    return { ok: false, message };
}

function longPathMessage(): string {
    return `The CAD document path is longer than ${MAX_CREATE_TARGET_PATH_LENGTH} characters.`;
}

/** True when a provider-reported real path points away from the logical entry. */
function resolvedElsewhere(stat: ResolvedTargetStat, logicalPath: string): boolean {
    return typeof stat.realPath === 'string' && stat.realPath.length > 0 && path.resolve(stat.realPath) !== path.resolve(logicalPath);
}

/** Deepest workspace root containing the candidate. */
function containingRoot(candidate: string, roots: readonly string[]): string | undefined {
    return roots
        .filter((root) => isWithinWorkspace(candidate, [root]))
        .map((root) => path.resolve(root))
        .sort((left, right) => right.length - left.length)[0];
}
