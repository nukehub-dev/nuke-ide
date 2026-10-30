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
 * Exchange-file path rendering for one-click CAD import.
 *
 * The assembly builder resolves an instance `part` relative to the
 * `.nuke-cad` document's directory, so an imported STEP/IGES/BREP file that
 * lives in (or below) the document folder is stored as `./model.step` /
 * `./sub/model.step`. Files outside that folder fall back to an absolute
 * path, which the builder accepts too. `importedPartStorage` additionally
 * plans a copy into `<document-stem>.parts/` for self-contained samples.
 * Pure string logic so it stays testable without Theia or a filesystem.
 *
 * @module nuke-cad/browser/widgets
 */

interface NormalizedPath {
    /** `''` (relative), `/` (POSIX), `/c:/` or `c:/` (Windows drive). */
    readonly root: string;
    /** Normalized path segments, `.`/empty removed and `..` resolved. */
    readonly segments: readonly string[];
}

function normalizePath(path: string): NormalizedPath {
    const raw = path.replace(/\\/g, '/');
    let root = '';
    let rest = raw;
    const drive = /^\/?([A-Za-z]):(?:\/|$)/.exec(raw);
    if (drive !== null) {
        const prefix = raw.startsWith('/') ? '/' : '';
        root = `${prefix}${drive[1].toLowerCase()}:/`;
        rest = raw.slice(drive[0].length);
    } else if (raw.startsWith('/')) {
        root = '/';
        rest = raw.slice(1);
    }
    const segments: string[] = [];
    for (const segment of rest.split('/')) {
        if (segment === '' || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (segments.length > 0 && segments[segments.length - 1] !== '..') {
                segments.pop();
            } else if (root === '') {
                segments.push('..');
            }
            continue;
        }
        segments.push(segment);
    }
    return { root, segments };
}

function formatPath(path: NormalizedPath): string {
    const body = path.segments.join('/');
    if (path.root === '') {
        return body;
    }
    return path.root === '/' ? `/${body}` : `${path.root}${body}`;
}

function sameRoot(a: NormalizedPath, b: NormalizedPath): boolean {
    return a.root.toLowerCase() === b.root.toLowerCase();
}

function isWindowsRoot(root: string): boolean {
    return /^\/?[a-z]:\/$/i.test(root);
}

function isDirectoryPrefix(directory: readonly string[], candidate: readonly string[], caseInsensitive: boolean): boolean {
    if (directory.length > candidate.length) {
        return false;
    }
    return directory.every(
        (segment, index) =>
            (caseInsensitive ? segment.toLowerCase() : segment) === (caseInsensitive ? candidate[index].toLowerCase() : candidate[index])
    );
}

/**
 * Render the assembly `part` string for an external CAD file imported into a
 * `.nuke-cad` document.
 *
 * Both paths are expected in Theia URI-path form (`uri.path.toString()`);
 * separators are normalized to `/`, `.` segments are dropped, and `..` is
 * resolved before comparison. Same-directory and nested files become
 * document-relative (`./model.step`, `./sub/model.step`); files outside the
 * document directory keep an absolute path because the assembly builder
 * accepts absolute sources and `../` traversal would couple the document to
 * a location it does not own.
 */
export function documentRelativeAssemblyPart(documentPath: string, importedPath: string): string {
    const document = normalizePath(documentPath);
    const imported = normalizePath(importedPath);
    const documentDirectory = document.segments.slice(0, Math.max(0, document.segments.length - 1));
    const caseInsensitive = isWindowsRoot(document.root) || isWindowsRoot(imported.root);
    if (sameRoot(document, imported) && isDirectoryPrefix(documentDirectory, imported.segments, caseInsensitive)) {
        const relative = imported.segments.slice(documentDirectory.length).join('/');
        return relative.length > 0 ? `./${relative}` : './';
    }
    return formatPath(imported);
}

/** Planned storage for an exchange file imported into a self-contained project. */
export interface ImportedPartStorage {
    /** True when the source must be copied into the project parts folder. */
    readonly copy: boolean;
    /** Absolute folder that receives the copied source (only when `copy` is true). */
    readonly folder?: string;
    /** Absolute path the document should reference (source or copied destination). */
    readonly target: string;
}

/**
 * Decide where an imported exchange file should live for a self-contained
 * project.
 *
 * A source already inside the document's directory is referenced in place.
 * Anything outside is copied into `<document-stem>.parts/` beside the
 * `.nuke-cad`, so the saved document and its source can move as one project
 * folder without needing the original absolute path.
 */
export function importedPartStorage(documentPath: string, importedPath: string): ImportedPartStorage {
    if (documentRelativeAssemblyPart(documentPath, importedPath).startsWith('./')) {
        return { copy: false, target: importedPath };
    }
    const imported = normalizePath(importedPath);
    const base = imported.segments[imported.segments.length - 1] ?? 'part.step';
    return {
        copy: true,
        folder: projectPartsFolder(documentPath),
        target: projectPartPath(documentPath, base)
    };
}

/**
 * Absolute `<document-stem>.parts/` folder beside a `.nuke-cad` document.
 * Imported exchange sources live here so the project folder stays portable.
 */
export function projectPartsFolder(documentPath: string): string {
    const document = normalizePath(documentPath);
    const documentDirectory = document.segments.slice(0, Math.max(0, document.segments.length - 1));
    const fileName = document.segments[document.segments.length - 1] ?? 'assembly.nuke-cad';
    const stem = fileName.replace(/\.nuke-cad$/i, '') || 'assembly';
    return formatPath({ root: document.root, segments: [...documentDirectory, `${stem}.parts`] });
}

/** Absolute path for one source file stored in the project parts folder. */
export function projectPartPath(documentPath: string, fileName: string): string {
    const folder = normalizePath(projectPartsFolder(documentPath));
    const file = normalizePath(fileName);
    const base = file.segments[file.segments.length - 1] ?? 'part.step';
    return formatPath({ root: folder.root, segments: [...folder.segments, base] });
}
