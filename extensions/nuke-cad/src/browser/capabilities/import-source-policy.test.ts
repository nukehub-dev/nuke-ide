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
import type { FileStat } from '@theia/filesystem/lib/common/files';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import {
    MAX_IMPORT_SOURCE_BYTES,
    documentPartsFolder,
    validateImportSourcePath,
    type ImportSourceValidation,
    type ValidatedImportSource
} from './import-source-policy';

const ROOT = '/workspace/project';
const DOCUMENT = `${ROOT}/pincell.nuke-cad`;
const SECOND_ROOT = '/workspace/other';
const ROOTS = [ROOT, SECOND_ROOT];

interface StatSpec {
    readonly isFile?: boolean;
    readonly isDirectory?: boolean;
    readonly isSymbolicLink?: boolean;
    readonly size?: number;
}

function stat(spec: StatSpec = {}): FileStat {
    return {
        resource: new URI(''),
        name: '',
        isFile: spec.isFile ?? false,
        isDirectory: spec.isDirectory ?? false,
        isSymbolicLink: spec.isSymbolicLink ?? false,
        isReadonly: false,
        size: spec.size
    };
}

function file(size = 1024): StatSpec {
    return { isFile: true, size };
}

function folder(): StatSpec {
    return { isDirectory: true };
}

function fakeFileService(entries: Readonly<Record<string, StatSpec>>): {
    resolve: ReturnType<typeof vi.fn>;
    service: Pick<FileService, 'resolve'>;
} {
    const resolve = vi.fn(async (uri: URI) => {
        const entry = entries[uri.path.toString()];
        if (entry === undefined) {
            throw new Error('ENOENT');
        }
        return stat(entry);
    });
    return { resolve, service: { resolve } as unknown as Pick<FileService, 'resolve'> };
}

async function validate(
    entries: Readonly<Record<string, StatSpec>>,
    sourcePath: string,
    documentPath = DOCUMENT
): Promise<ImportSourceValidation> {
    return validateImportSourcePath(fakeFileService(entries).service, sourcePath, ROOTS, documentPath);
}

describe('validateImportSourcePath', () => {
    it('accepts a regular exchange file inside a workspace root', async () => {
        const result = await validate({ [`${ROOT}/pincell.step`]: file(4096) }, `${ROOT}/pincell.step`);

        expect(result).toEqual({
            ok: true,
            value: { path: `${ROOT}/pincell.step`, size: 4096, implicitPartsSource: false }
        });
    });

    it('canonicalizes dot segments lexically', async () => {
        const result = await validate(
            {
                [`${ROOT}/sub`]: folder(),
                [`${ROOT}/sub/model.igs`]: file(10)
            },
            `${ROOT}/sub/../sub/model.igs`
        );

        expect(result).toMatchObject({
            ok: true,
            value: { path: `${ROOT}/sub/model.igs`, size: 10 }
        });
    });

    it('accepts a file in a second workspace root', async () => {
        const result = await validate({ [`${SECOND_ROOT}/part.brep`]: file(5) }, `${SECOND_ROOT}/part.brep`);

        expect(result).toMatchObject({ ok: true, value: { path: `${SECOND_ROOT}/part.brep` } });
    });

    it('rejects relative paths before touching the filesystem', async () => {
        const fake = fakeFileService({});
        const result = await validateImportSourcePath(fake.service, 'models/pincell.step', ROOTS, DOCUMENT);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('absolute') });
        expect(fake.resolve).not.toHaveBeenCalled();
    });

    it('rejects a path outside every workspace root', async () => {
        const fake = fakeFileService({ '/elsewhere/pincell.step': file() });
        const result = await validateImportSourcePath(fake.service, '/elsewhere/pincell.step', ROOTS, DOCUMENT);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('outside every workspace root') });
        expect(fake.resolve).not.toHaveBeenCalled();
    });

    it('rejects a sibling folder that only shares a string prefix', async () => {
        const fake = fakeFileService({ [`${ROOT}-evil/pincell.step`]: file() });
        const result = await validateImportSourcePath(fake.service, `${ROOT}-evil/pincell.step`, ROOTS, DOCUMENT);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('outside every workspace root') });
        expect(fake.resolve).not.toHaveBeenCalled();
    });

    it('rejects unsupported extensions before touching the filesystem', async () => {
        const fake = fakeFileService({ [`${ROOT}/notes.txt`]: file() });
        const result = await validateImportSourcePath(fake.service, `${ROOT}/notes.txt`, ROOTS, DOCUMENT);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Unsupported') });
        expect(fake.resolve).not.toHaveBeenCalled();
    });

    it('rejects a directory even when its name has an exchange extension', async () => {
        const result = await validate({ [`${ROOT}/bundle.step`]: folder() }, `${ROOT}/bundle.step`);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('regular file') });
    });

    it('rejects a symlinked path component', async () => {
        const result = await validate(
            {
                [`${ROOT}/linked`]: { isSymbolicLink: true },
                [`${ROOT}/linked/pincell.step`]: file()
            },
            `${ROOT}/linked/pincell.step`
        );

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('symbolic link') });
    });

    it('rejects a symlinked final file', async () => {
        const result = await validate({ [`${ROOT}/pincell.step`]: { isSymbolicLink: true } }, `${ROOT}/pincell.step`);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('symbolic link') });
    });

    it('rejects a missing file', async () => {
        const result = await validate({}, `${ROOT}/missing.step`);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('does not exist') });
    });

    it('rejects a source larger than the cap and accepts the exact cap', async () => {
        const oversized = await validate({ [`${ROOT}/large.step`]: file(MAX_IMPORT_SOURCE_BYTES + 1) }, `${ROOT}/large.step`);
        expect(oversized).toMatchObject({ ok: false, message: expect.stringContaining('256 MiB') });

        const exact = await validate({ [`${ROOT}/large.step`]: file(MAX_IMPORT_SOURCE_BYTES) }, `${ROOT}/large.step`);
        expect(exact).toMatchObject({ ok: true, value: { size: MAX_IMPORT_SOURCE_BYTES } });
    });

    it('rejects a file whose size cannot be determined', async () => {
        const result = await validate({ [`${ROOT}/pincell.step`]: { isFile: true } }, `${ROOT}/pincell.step`);

        expect(result).toMatchObject({ ok: false, message: expect.stringContaining('size could not be determined') });
    });

    it('classifies a source inside <stem>.parts as a document-owned source', async () => {
        const source = `${ROOT}/pincell.parts/import.step`;
        const result = await validate(
            {
                [`${ROOT}/pincell.parts`]: folder(),
                [source]: file(3)
            },
            source
        );

        expect(result).toMatchObject({ ok: true, value: { path: source, implicitPartsSource: true } });
    });

    it('does not classify sibling, nested, or non-document folders as parts sources', async () => {
        const sibling = `${ROOT}/pincell.parts-extra/import.step`;
        const nested = `${ROOT}/pincell.parts/nested/import.step`;
        const plainDocument = `${ROOT}/pincell.nuke-cad.bak`;

        const siblingResult = await validate(
            {
                [`${ROOT}/pincell.parts-extra`]: folder(),
                [sibling]: file()
            },
            sibling
        );
        expect(siblingResult).toMatchObject({ ok: true, value: { implicitPartsSource: false } });

        const nestedResult = await validate(
            {
                [`${ROOT}/pincell.parts`]: folder(),
                [`${ROOT}/pincell.parts/nested`]: folder(),
                [nested]: file()
            },
            nested
        );
        expect(nestedResult).toMatchObject({ ok: true, value: { implicitPartsSource: true } });

        const plainResult = await validate(
            {
                [`${ROOT}/pincell.parts-extra`]: folder(),
                [sibling]: file()
            },
            sibling,
            plainDocument
        );
        expect(plainResult).toMatchObject({ ok: true, value: { implicitPartsSource: false } });
    });

    it('exposes the document parts folder only for .nuke-cad documents', () => {
        expect(documentPartsFolder('/workspace/project/pincell.nuke-cad')).toBe('/workspace/project/pincell.parts');
        expect(documentPartsFolder('/workspace/project/pincell.cad')).toBeUndefined();
    });

    it('returns only detached validation data', async () => {
        const result = await validate({ [`${ROOT}/pincell.step`]: file(7) }, `${ROOT}/pincell.step`);
        if (!result.ok) {
            throw new Error('expected a valid source');
        }
        const value: ValidatedImportSource = result.value;
        expect(value.path).toBe(`${ROOT}/pincell.step`);
        expect(value.size).toBe(7);
    });
});
