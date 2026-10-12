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
 * Pure geometry auto-detection behind the overlay "Select Geometry File"
 * fallback (DAGMC Outline parity: no Theia, DOM, or FileService imports —
 * the contribution adapts its services onto {@link GeometryDiscoveryStore}).
 *
 * Resolution order, closest directory first, walking up toward the workspace
 * root (the common layout keeps the model in the project folder and outputs
 * in a subfolder): at each level the owning `.nuke-openmc` project's
 * `settings.dagmcFile` is resolved first — an explicit pin outranks the
 * generic well-known names, since a DAGMC project often keeps a stray
 * geometry.xml beside the real `.h5m` — then the well-known names. A lone
 * `*.h5m` anywhere on the walk is a last
 * resort (backup-like names only count when nothing else exists);
 * anything ambiguous resolves to undefined so the caller keeps its manual
 * picker.
 */

/** Well-known geometry names checked per directory, closest first. */
export const AUTO_DETECT_WELL_KNOWN_NAMES: readonly string[] = ['geometry.h5m', 'dagmc.h5m', 'geometry.xml'];

/** Parent-walk depth cap for geometry auto-detection. */
export const AUTO_DETECT_MAX_WALK_LEVELS = 6;

/** Backup-like model names (only count toward the lone-file fallback when nothing else exists). */
export const AUTO_DETECT_BACKUP_NAME_RE = /(\.orig|backup|bak)(?=\.h5m$)/i;

/** Minimal file access the auto-detection needs (adapted from FileService by the contribution). */
export interface GeometryDiscoveryStore {
    /** File names directly inside `dir`, or undefined when unreadable. */
    listFiles(dir: string): Promise<string[] | undefined>;
    /** Text content of `path`, or undefined when unreadable. */
    readText(path: string): Promise<string | undefined>;
    /** Whether `path` names an existing file. */
    fileExists(path: string): Promise<boolean>;
}

/**
 * The `settings.dagmcFile` pinned by a `.nuke-openmc` project document, or
 * undefined for anything else (wrong shape, missing field, unparseable).
 * Pure.
 */
export function dagmcFileFromProjectDoc(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const settings = (value as { state?: { settings?: { dagmcFile?: unknown } } }).state?.settings;
    return typeof settings?.dagmcFile === 'string' && settings.dagmcFile.length > 0 ? settings.dagmcFile : undefined;
}

/** Parent directory of a `/a/b`-style path, or undefined at the root. Pure. */
export function parentDir(path: string): string | undefined {
    const cut = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
    const slash = cut.lastIndexOf('/');
    if (slash <= 0) {
        return undefined;
    }
    return cut.slice(0, slash);
}

/** Join a directory and a file name with exactly one `/`. Pure. */
export function joinPath(dir: string, name: string): string {
    return `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${name}`;
}

/** Whether `value` is an absolute URI (scheme-prefixed) rather than a project-relative path. Pure. */
export function isAbsoluteUri(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/**
 * A `file://` URI (or a bare absolute path) as a path string, or undefined
 * for anything else. Pure.
 */
export function uriToPath(value: string): string | undefined {
    if (value.startsWith('/')) {
        return value;
    }
    const match = /^file:\/\/(\/.*)$/.exec(value);
    return match ? match[1] : undefined;
}

/**
 * Resolve the geometry for a statepoint directory: project pinning,
 * then well-known names, then the lone-file fallback, walking up to `stopAt`
 * (exclusive of nothing — `stopAt` itself is still searched) or the
 * filesystem root. Every lookup failure falls through silently; detection
 * must never fail an open flow. Pure apart from the store.
 */
export async function autoDetectGeometryPath(
    startDir: string,
    store: GeometryDiscoveryStore,
    stopAt?: string
): Promise<string | undefined> {
    const h5mCandidates: string[] = [];
    let current: string | undefined = startDir;
    for (let level = 0; level <= AUTO_DETECT_MAX_WALK_LEVELS && current !== undefined; level++) {
        const files = await store.listFiles(current);
        if (files !== undefined) {
            // An explicit `.nuke-openmc` `settings.dagmcFile` pin wins over the
            // generic well-known names in the same directory: a DAGMC project
            // routinely keeps a stray geometry.xml (CSG preview) beside the
            // actual `.h5m`, and the pin is the user's declared intent.
            const projects = files.filter((entry) => entry.toLowerCase().endsWith('.nuke-openmc')).sort();
            for (const project of projects) {
                const text = await store.readText(joinPath(current, project));
                if (text === undefined) {
                    continue;
                }
                let dagmcFile: string | undefined;
                try {
                    dagmcFile = dagmcFileFromProjectDoc(JSON.parse(text));
                } catch {
                    continue;
                }
                if (!dagmcFile) {
                    continue;
                }
                const candidate = isAbsoluteUri(dagmcFile) ? uriToPath(dagmcFile) : joinPath(current, dagmcFile);
                if (candidate !== undefined && (await store.fileExists(candidate))) {
                    return candidate;
                }
            }
            const lowered = new Map(files.map((entry) => [entry.toLowerCase(), entry] as const));
            for (const name of AUTO_DETECT_WELL_KNOWN_NAMES) {
                const exact = lowered.get(name);
                if (exact !== undefined) {
                    return joinPath(current, exact);
                }
            }
            h5mCandidates.push(
                ...files.filter((entry) => entry.toLowerCase().endsWith('.h5m')).map((entry) => joinPath(current as string, entry))
            );
        }
        if (current === stopAt) {
            break;
        }
        current = parentDir(current);
    }
    const viable = h5mCandidates.filter((path) => !AUTO_DETECT_BACKUP_NAME_RE.test(path.split('/').pop() ?? ''));
    const pool = viable.length > 0 ? viable : h5mCandidates;
    const unique = [...new Set(pool)];
    return unique.length === 1 ? unique[0] : undefined;
}
