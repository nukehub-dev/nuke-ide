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

import { describe, expect, it, vi } from 'vitest';
import { URI } from '@theia/core/lib/common/uri';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import type { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import type { NukeCadDocument } from '../../common/cad-document';
import type { CadDocumentStore } from './cad-document-store';

vi.mock('@theia/filesystem/lib/browser/file-service', () => ({ FileService: class FileService {} }));
vi.mock('@theia/filesystem/lib/browser/file-dialog', () => ({ FileDialogService: class FileDialogService {} }));

import { CadDocumentSaveService } from './cad-document-save-service';

const DOCUMENT = { name: 'bracket' } as unknown as NukeCadDocument;
const JSON_BODY = '{\n  "name": "bracket"\n}';

class FakeStore {
    document: NukeCadDocument | undefined = DOCUMENT;
    uri: string | undefined;
    json: string | undefined = JSON_BODY;
    readonly setUri = vi.fn((uri: string) => {
        this.uri = uri;
    });
    readonly markSaved = vi.fn(() => ({ success: true }));
    readonly toJson = vi.fn(() => this.json);

    asStore(): CadDocumentStore {
        return this as unknown as CadDocumentStore;
    }
}

function createHarness(): {
    service: CadDocumentSaveService;
    store: FakeStore;
    fileService: { write: ReturnType<typeof vi.fn> };
    fileDialogService: { showSaveDialog: ReturnType<typeof vi.fn> };
} {
    const store = new FakeStore();
    const fileService = { write: vi.fn(async () => undefined) };
    const fileDialogService = { showSaveDialog: vi.fn(async () => undefined as URI | undefined) };
    const service = new CadDocumentSaveService(
        fileService as unknown as FileService,
        fileDialogService as unknown as FileDialogService,
        store.asStore()
    );
    return { service, store, fileService, fileDialogService };
}

describe('CadDocumentSaveService', () => {
    it('reports no-document when nothing is active', async () => {
        const { service, store, fileService, fileDialogService } = createHarness();
        store.document = undefined;

        const result = await service.save();

        expect(result).toEqual({ ok: false, reason: 'no-document' });
        expect(fileDialogService.showSaveDialog).not.toHaveBeenCalled();
        expect(fileService.write).not.toHaveBeenCalled();
        expect(store.setUri).not.toHaveBeenCalled();
    });

    it('returns cancelled without writing when the dialog is dismissed', async () => {
        const { service, store, fileService, fileDialogService } = createHarness();

        const result = await service.save();

        expect(result).toEqual({ ok: false, reason: 'cancelled' });
        expect(fileDialogService.showSaveDialog).toHaveBeenCalledWith({
            title: 'Save CAD Document',
            inputValue: 'bracket.nuke-cad',
            filters: { 'CAD Document': ['nuke-cad'] }
        });
        expect(fileService.write).not.toHaveBeenCalled();
        expect(store.setUri).not.toHaveBeenCalled();
        expect(store.markSaved).not.toHaveBeenCalled();
    });

    it('appends .nuke-cad to a dialog path and writes the store body', async () => {
        const { service, store, fileService, fileDialogService } = createHarness();
        fileDialogService.showSaveDialog.mockResolvedValue(new URI('file:///work/project/bracket'));

        const result = await service.save();

        expect(result).toEqual({
            ok: true,
            uri: 'file:///work/project/bracket.nuke-cad',
            path: '/work/project/bracket.nuke-cad'
        });
        expect(fileService.write).toHaveBeenCalledTimes(1);
        const [target, content] = fileService.write.mock.calls[0];
        expect(target.toString()).toBe('file:///work/project/bracket.nuke-cad');
        expect(content).toBe(JSON_BODY);
        expect(store.setUri).toHaveBeenCalledWith('file:///work/project/bracket.nuke-cad');
        expect(store.markSaved).toHaveBeenCalledTimes(1);
    });

    it('writes an existing backing URI without opening the dialog', async () => {
        const { service, store, fileService, fileDialogService } = createHarness();
        store.uri = 'file:///work/project/bracket.nuke-cad';

        const result = await service.save();

        expect(result.ok).toBe(true);
        expect(fileDialogService.showSaveDialog).not.toHaveBeenCalled();
        const [target] = fileService.write.mock.calls[0];
        expect(target.toString()).toBe('file:///work/project/bracket.nuke-cad');
    });

    it('opens the dialog for forceDialog even when a backing URI exists', async () => {
        const { service, store, fileDialogService } = createHarness();
        store.uri = 'file:///work/project/bracket.nuke-cad';
        fileDialogService.showSaveDialog.mockResolvedValue(new URI('file:///work/project/bracket-copy.nuke-cad'));

        const result = await service.save({ forceDialog: true, title: 'Save Copy' });

        expect(result.ok).toBe(true);
        expect(fileDialogService.showSaveDialog).toHaveBeenCalledWith({
            title: 'Save Copy',
            inputValue: 'bracket.nuke-cad',
            filters: { 'CAD Document': ['nuke-cad'] }
        });
    });

    it('writes an explicit targetPath without opening the dialog', async () => {
        const { service, store, fileService, fileDialogService } = createHarness();

        const result = await service.save({ targetPath: 'file:///templates/pincell.nuke-cad' });

        expect(result).toEqual({
            ok: true,
            uri: 'file:///templates/pincell.nuke-cad',
            path: '/templates/pincell.nuke-cad'
        });
        expect(fileDialogService.showSaveDialog).not.toHaveBeenCalled();
        const [target] = fileService.write.mock.calls[0];
        expect(target.toString()).toBe('file:///templates/pincell.nuke-cad');
        expect(store.setUri).toHaveBeenCalledWith('file:///templates/pincell.nuke-cad');
    });

    it('reports a write error and leaves the URI unset', async () => {
        const { service, store, fileService, fileDialogService } = createHarness();
        fileDialogService.showSaveDialog.mockResolvedValue(new URI('file:///work/project/bracket'));
        fileService.write.mockRejectedValue(new Error('disk full'));

        const result = await service.save();

        expect(result).toEqual({ ok: false, reason: 'error', message: 'disk full' });
        expect(store.setUri).not.toHaveBeenCalled();
        expect(store.markSaved).not.toHaveBeenCalled();
        expect(store.uri).toBeUndefined();
    });
});
