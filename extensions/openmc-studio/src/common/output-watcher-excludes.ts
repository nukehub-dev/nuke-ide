// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
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
 * Pure helper computing `files.watcherExclude` glob patterns for a project's
 * OpenMC run-output directory. OpenMC runs write huge numbers of small files
 * (lost-particle restart files, track files) under the output directory;
 * excluding it from Theia's recursive parcel watcher keeps the file manager
 * responsive during long runs.
 *
 * Patterns are workspace-root-RELATIVE (`output/**`) — parcel's native ignore
 * matches globs against paths relative to the watched folder, and absolute
 * globs only post-filter events without pruning the watch tree (so the
 * inotify cost would remain).
 *
 * @module openmc-studio/common
 */

import * as path from 'path';

/**
 * Compute watcher-exclude patterns for a run-output directory.
 *
 * @param outputDirectory - Absolute effective output directory (the working
 *   directory itself when the model sets no `settings.output.path`).
 * @param projectDirectory - Absolute directory holding the `.nuke-openmc` file.
 * @param workspaceRoots - Absolute paths of the workspace roots.
 * @returns Root-relative glob patterns to add to `files.watcherExclude`;
 *   empty when the output directory is outside every workspace root.
 */
export function computeOutputWatcherExcludes(outputDirectory: string, projectDirectory: string, workspaceRoots: string[]): string[] {
    const patterns: string[] = [];
    const outputIsProjectDir = path.resolve(outputDirectory) === path.resolve(projectDirectory);

    for (const root of workspaceRoots) {
        const rel = path.relative(root, outputDirectory);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            continue; // output directory lives outside this root
        }
        const relPosix = rel.split(path.sep).join('/');
        if (outputIsProjectDir || relPosix === '') {
            // Run files land directly in the project/workspace directory — the
            // directory itself cannot be excluded without unwatching the
            // project, so only the churn subfolders are covered (the runner's
            // output watcher moves restart/track files into them within seconds).
            const prefix = relPosix ? `${relPosix}/` : '';
            patterns.push(`${prefix}particles/**`, `${prefix}tracks/**`);
        } else {
            // Dedicated output subdirectory: exclude it wholesale, including
            // the restart files that briefly accumulate at its top level.
            patterns.push(`${relPosix}/**`);
        }
    }
    return patterns;
}
