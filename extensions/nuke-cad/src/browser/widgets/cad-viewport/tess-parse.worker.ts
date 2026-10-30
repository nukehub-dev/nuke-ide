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
 * Web Worker that parses tessellation JSON off the UI thread.
 *
 * Thin shell over {@link parseTessellationText}: the text comes in, the parsed
 * payload goes back with its ArrayBuffers transferred (zero-copy). Must not
 * import `@theia/*` or three.js — the parse module is pure. Webpack 5 bundles
 * this entry natively via `new Worker(new URL('./tess-parse.worker.ts',
 * import.meta.url))`; no generated-file edits.
 *
 * @module nuke-cad/browser/widgets
 */

import { collectTransferables, parseTessellationText } from './tess-reuse';

interface ParseRequest {
    readonly seq: number;
    readonly text: string;
}

interface ParseSuccess {
    readonly seq: number;
    readonly data: unknown;
}

interface ParseFailure {
    readonly seq: number;
    readonly error: string;
}

const ctx = self as unknown as {
    onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
    postMessage(message: ParseSuccess | ParseFailure, transfer: Transferable[]): void;
};

ctx.onmessage = (event) => {
    const { seq, text } = event.data;
    try {
        const data = parseTessellationText(text);
        ctx.postMessage({ seq, data }, collectTransferables(data));
    } catch (error) {
        ctx.postMessage({ seq, error: error instanceof Error ? error.message : String(error) }, []);
    }
};
