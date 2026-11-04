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
 * Save pipeline for the active `.nuke-cad` document.
 *
 * Resolves the destination (an explicit path, the document's current backing
 * file, or a save dialog), writes the store's JSON body, and only then assigns
 * the new URI and clears the dirty flag. A failed write never changes the
 * store's URI, so a retry still targets the correct file.
 *
 * @module nuke-cad/browser/document
 */

import { inject, injectable } from '@theia/core/shared/inversify';
import { URI } from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { CadDocumentStore } from './cad-document-store';
import { ensureNukeCadExtension } from '../widgets/cad-viewport/cad-save-path';

/** Options for {@link CadDocumentSaveService.save}. */
export interface CadDocumentSaveOptions {
    /** Always open the save dialog, even when the document is already backed by a file. */
    readonly forceDialog?: boolean;
    /** Write exactly here instead of opening a dialog. Must already carry `.nuke-cad`. */
    readonly targetPath?: string;
    /** Dialog title override (default `Save CAD Document`). */
    readonly title?: string;
}

/** Outcome of {@link CadDocumentSaveService.save}. */
export type CadDocumentSaveResult =
    | { readonly ok: true; readonly uri: string; readonly path: string }
    | { readonly ok: false; readonly reason: 'no-document' | 'cancelled' | 'error'; readonly message?: string };

/** Default title used by the save dialog. */
export const CAD_DOCUMENT_SAVE_TITLE = 'Save CAD Document';

/** Resolves a save destination and writes the active document as JSON. */
@injectable()
export class CadDocumentSaveService {
    constructor(
        @inject(FileService) protected readonly fileService: FileService,
        @inject(FileDialogService) protected readonly fileDialogService: FileDialogService,
        @inject(CadDocumentStore) protected readonly store: CadDocumentStore
    ) {}

    /**
     * Save the active document.
     *
     * The URI is assigned only after the write succeeds; a write failure is
     * reported as `{ ok: false, reason: 'error' }` and leaves the store
     * unchanged.
     */
    async save(options: CadDocumentSaveOptions = {}): Promise<CadDocumentSaveResult> {
        if (this.store.document === undefined) {
            return { ok: false, reason: 'no-document' };
        }
        const target = await this.resolveTarget(options);
        if (target === 'cancelled') {
            return { ok: false, reason: 'cancelled' };
        }
        const json = this.store.toJson();
        if (json === undefined) {
            return { ok: false, reason: 'no-document' };
        }
        try {
            await this.fileService.write(target, json);
        } catch (error) {
            return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) };
        }
        const uri = target.toString();
        this.store.setUri(uri);
        this.store.markSaved();
        return { ok: true, uri, path: target.path.toString() };
    }

    /** Resolve the destination URI, asking the user when no path is available. */
    protected async resolveTarget(options: CadDocumentSaveOptions): Promise<URI | 'cancelled'> {
        if (options.targetPath !== undefined) {
            return new URI(options.targetPath);
        }
        const current = this.store.uri !== undefined ? new URI(this.store.uri) : undefined;
        if (current !== undefined && options.forceDialog !== true) {
            return current;
        }
        const requested = await this.fileDialogService.showSaveDialog({
            title: options.title ?? CAD_DOCUMENT_SAVE_TITLE,
            inputValue: current?.path.base ?? `${this.store.document?.name ?? 'document'}.nuke-cad`,
            filters: { 'CAD Document': ['nuke-cad'] }
        });
        if (requested === undefined) {
            return 'cancelled';
        }
        return requested.withPath(ensureNukeCadExtension(requested.path.toString()));
    }
}
