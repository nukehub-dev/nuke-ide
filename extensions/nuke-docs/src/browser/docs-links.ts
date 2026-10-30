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
// *****************************************************************************

/** A documentation target split into its navigable path and fragment. */
export interface DocTarget {
    path: string;
    fragment: string;
}

/** Split `path#fragment` without treating URL fragments as file names. */
export function splitDocTarget(target: string): DocTarget {
    const hashIndex = target.indexOf('#');
    if (hashIndex < 0) {
        return { path: target, fragment: '' };
    }
    return {
        path: target.slice(0, hashIndex),
        fragment: target.slice(hashIndex)
    };
}

/** Collapse `.`/`..` segments into an absolute POSIX-style path. */
function normalizeAbsolute(target: string): string {
    const stack: string[] = [];
    for (const part of target.split('/')) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    return '/' + stack.join('/');
}

/** Directory part of the current document path, with a trailing slash. */
function documentBase(currentPath: string): string {
    return currentPath.substring(0, currentPath.lastIndexOf('/') + 1);
}

/** Last path segment contains an extension (e.g. `.png`, `.md`). */
function hasFileExtension(target: string): boolean {
    const segment = target.slice(target.lastIndexOf('/') + 1);
    return segment.includes('.') && !segment.startsWith('.');
}

/**
 * Resolve a Markdown link relative to the document currently displayed.
 *
 * Extension docs live under `extensions/<name>/docs/` on disk but are served
 * under `/<name>/`. Links written portably (with `../../<name>/docs/...`) are
 * therefore rewritten to the served route. Link targets without a file
 * extension are treated as Markdown pages.
 */
export function resolveDocPath(currentPath: string, href: string): string {
    const { path: hrefPath, fragment } = splitDocTarget(href);
    if (!hrefPath) {
        return currentPath + fragment;
    }

    const absolute = hrefPath.startsWith('/') ? hrefPath : documentBase(currentPath) + hrefPath;
    let resolved = normalizeAbsolute(absolute);

    // `extensions/<name>/docs/<page>` is served as `/<name>/<page>`.
    resolved = resolved.replace(/^\/extensions\/([^/]+)\/docs\//, '/$1/');
    resolved = resolved.replace(/^\/([^/]+)\/docs\//, '/$1/');
    // Portable product-docs paths (`.../docs/<page>`) are served as `/product/<page>`.
    resolved = resolved.replace(/^\/docs\//, '/product/');

    if (!hasFileExtension(resolved)) {
        resolved = resolved.endsWith('/') ? resolved + 'index.md' : resolved + '.md';
    }
    if (resolved.endsWith('/README.md')) {
        resolved = resolved.replace(/\/README\.md$/, '/index.md');
    }
    return resolved + fragment;
}

/**
 * Resolve an image or downloadable asset relative to the current document.
 * Asset paths keep their original extension and are never rewritten to `.md`.
 */
export function resolveDocAsset(currentPath: string, src: string): string {
    if (/^(https?:|data:|blob:)/i.test(src)) {
        return src;
    }
    const { path: srcPath, fragment } = splitDocTarget(src);
    if (!srcPath || srcPath.startsWith('/')) {
        return src;
    }
    return normalizeAbsolute(documentBase(currentPath) + srcPath) + fragment;
}
