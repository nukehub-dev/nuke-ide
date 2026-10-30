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
 * Tessellation parse client: owns the parse worker and the main-thread
 * fallback. Worker construction failure or a worker transport failure logs
 * once and degrades to parsing on the calling thread — the feature must
 * degrade, not break (Electron file-protocol quirks are the known risk). A
 * worker-reported parse error rejects instead: a corrupt payload fails
 * identically on the main thread.
 *
 * @module nuke-cad/browser/widgets
 */

import { parseTessellationText, type ParsedTessData } from './tess-reuse';

interface PendingParse {
    readonly text: string;
    readonly resolve: (data: ParsedTessData) => void;
    readonly reject: (error: Error) => void;
}

let worker: Worker | undefined;
let workerUnavailable = false;
let nextSeq = 1;
const pending = new Map<number, PendingParse>();

/** Parse on the calling thread; resolves or rejects exactly once. */
function parseOnMainThread(text: string, resolve: (data: ParsedTessData) => void, reject: (error: Error) => void): void {
    try {
        resolve(parseTessellationText(text));
    } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
    }
}

/** Disable the worker and re-home every in-flight parse to the main thread. */
function handleWorkerFailure(message: string): void {
    workerUnavailable = true;
    console.warn(`[CadViewport] Tessellation parse worker unavailable (${message}); parsing on the main thread.`);
    worker?.terminate();
    worker = undefined;
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
        parseOnMainThread(entry.text, entry.resolve, entry.reject);
    }
}

function ensureWorker(): Worker | undefined {
    if (worker !== undefined) {
        return worker;
    }
    try {
        // Webpack 5 natively bundles `new Worker(new URL(..., import.meta.url))`
        // as a worker entry; tsc emits CommonJS for this package, so the
        // meta-property needs a local suppression (webpack sees the real thing).
        // The `.js` specifier maps to the `.ts` source here and exists verbatim
        // in the compiled `lib/` output, which is where webpack resolves it.
        // @ts-ignore TS1470 — import.meta requires ESM emit; webpack handles it.
        const created = new Worker(new URL('./tess-parse.worker.js', import.meta.url));
        created.onmessage = (event: MessageEvent<{ seq: number; data?: ParsedTessData; error?: string }>) => {
            const entry = pending.get(event.data.seq);
            if (entry === undefined) {
                return;
            }
            pending.delete(event.data.seq);
            if (event.data.error !== undefined) {
                entry.reject(new Error(event.data.error));
            } else {
                entry.resolve(event.data.data as ParsedTessData);
            }
        };
        created.onerror = (event) => {
            handleWorkerFailure(event.message || 'worker error');
        };
        worker = created;
        return created;
    } catch (error) {
        handleWorkerFailure(error instanceof Error ? error.message : String(error));
        return undefined;
    }
}

/**
 * Parse tessellation text off the UI thread when the worker is available,
 * on the calling thread otherwise. Either way the resolved value has the
 * {@link ParsedTessData} shape.
 */
export async function parseTessellationAsync(text: string): Promise<ParsedTessData> {
    const activeWorker = workerUnavailable ? undefined : ensureWorker();
    if (activeWorker === undefined) {
        return parseTessellationText(text);
    }
    const seq = nextSeq++;
    return new Promise<ParsedTessData>((resolve, reject) => {
        pending.set(seq, { text, resolve, reject });
        activeWorker.postMessage({ seq, text });
    });
}
