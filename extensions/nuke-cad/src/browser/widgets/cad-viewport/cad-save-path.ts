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
 * Save-path enforcement for `.nuke-cad` documents.
 *
 * Theia's save dialog returns whatever file name the user typed without
 * appending the selected filter's extension, so a new document saved as
 * "my-test" would land on disk without `.nuke-cad` and never reopen in the
 * CAD viewport. Pure string logic so it stays testable without Theia.
 *
 * @module nuke-cad/browser/widgets
 */

export const NUKE_CAD_EXTENSION = '.nuke-cad';

/**
 * Append the `.nuke-cad` extension to a save path unless its base name
 * already carries it (case-insensitive). A trailing dot is treated as an
 * empty extension and collapsed so `model.` becomes `model.nuke-cad`
 * rather than `model..nuke-cad`. Directory segments are untouched, even
 * when they contain dots.
 */
export function ensureNukeCadExtension(path: string): string {
    const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const base = path.slice(lastSeparator + 1);
    if (base.toLowerCase().endsWith(NUKE_CAD_EXTENSION)) {
        return path;
    }
    const stem = base.endsWith('.') ? base.slice(0, -1) : base;
    return `${path.slice(0, lastSeparator + 1)}${stem}${NUKE_CAD_EXTENSION}`;
}
