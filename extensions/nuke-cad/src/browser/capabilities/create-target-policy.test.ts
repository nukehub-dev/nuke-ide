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
import { MAX_CREATE_TARGET_PATH_LENGTH, validateCreateTarget, type CreateTargetResult } from './create-target-policy';

const ROOT = '/workspace/project';
const SECOND_ROOT = '/workspace/other';
const ROOTS = [ROOT, SECOND_ROOT];

interface EntrySpec {
    readonly isFile?: boolean;
    readonly isDirectory?: boolean;
    readonly isSymbolicLink?: boolean;
    /** Destination of a symlink, as a filesystem provider reports it. */
    readonly realPath?: string;
}

function stat(uriPath: string, spec: EntrySpec): FileStat & { readonly realPath?: string } {
    return {
        resource: new URI(uriPath),
        name: '',
        isFile: spec.isFile ?? false,
        isDirectory: spec.isDirectory ?? false,
        isSymbolicLink: spec.isSymbolicLink ?? false,
        isReadonly: false,
        realPath: spec.realPath
    };
}

function file(): EntrySpec {
    return { isFile: true };
}

function folder(): EntrySpec {
    return { isDirectory: true };
}

function symlink(realPath: string, spec: EntrySpec = {}): EntrySpec {
    return { ...spec, isSymbolicLink: true, realPath };
}

interface FakeFileService {
    readonly service: FileService;
    readonly exists: ReturnType<typeof vi.fn>;
    readonly resolve: ReturnType<typeof vi.fn>;
}

/**
 * In-memory filesystem for the policy. `exists` reports plain existence like
 * Theia's `FileService.exists`, which also stats dangling links; `resolve`
 * reports the symlink flag plus the destination real path.
 */
function fakeFileService(entries: Readonly<Record<string, EntrySpec>>): FakeFileService {
    const exists = vi.fn(async (uri: URI) => entries[uri.path.toString()] !== undefined);
    const resolve = vi.fn(async (uri: URI) => {
        const logical = uri.path.toString();
        const spec = entries[logical];
        if (spec === undefined) {
            throw new Error('ENOENT');
        }
        return stat(logical, spec);
    });
    return { service: { exists, resolve } as unknown as FileService, exists, resolve };
}

async function validate(
    entries: Readonly<Record<string, EntrySpec>>,
    requested: string,
    roots: readonly string[] = ROOTS
): Promise<CreateTargetResult> {
    return validateCreateTarget(fakeFileService(entries).service, requested, roots);
}

describe('validateCreateTarget', () => {
    it('accepts a fresh absolute target whose parent folder exists', async () => {
        const target = `${ROOT}/models/plate.nuke-cad`;
        const result = await validate({ [`${ROOT}/models`]: folder() }, target);

        expect(result).toEqual({ ok: true, path: target });
    });

    it('resolves a relative path against the first workspace root', async () => {
        const fake = fakeFileService({ [`${ROOT}/models`]: folder() });
        const result = await validateCreateTarget(fake.service, 'models/plate.nuke-cad', ROOTS);

        expect(result).toEqual({ ok: true, path: `${ROOT}/models/plate.nuke-cad` });
        expect(fake.exists.mock.calls[0][0].path.toString()).toBe(`${ROOT}/models/plate.nuke-cad`);
        expect(fake.resolve.mock.calls.map((call) => call[0].path.toString())).toEqual([`${ROOT}/models`, `${ROOT}/models/plate.nuke-cad`]);
    });

    it('accepts a target in a second workspace root', async () => {
        const target = `${SECOND_ROOT}/parts/coil.nuke-cad`;
        const result = await validate({ [`${SECOND_ROOT}/parts`]: folder() }, target);

        expect(result).toEqual({ ok: true, path: target });
    });

    it('accepts the extension case-insensitively', async () => {
        const target = `${ROOT}/models/PLATE.NUKE-CAD`;
        const result = await validate({ [`${ROOT}/models`]: folder() }, target);

        expect(result).toEqual({ ok: true, path: target });
    });

    it('rejects a target outside every workspace root before any filesystem access', async () => {
        const fake = fakeFileService({ '/elsewhere/plate.nuke-cad': folder() });
        const result = await validateCreateTarget(fake.service, '/elsewhere/plate.nuke-cad', ROOTS);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('outside every workspace root') });
        expect(fake.exists).not.toHaveBeenCalled();
        expect(fake.resolve).not.toHaveBeenCalled();
    });

    it('rejects a sibling folder that only shares a string prefix with a root', async () => {
        const result = await validate({}, `${ROOT}-evil/plate.nuke-cad`);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('outside every workspace root') });
    });

    it('rejects a wrong or missing extension instead of appending one', async () => {
        const fake = fakeFileService({ [`${ROOT}/plate.step`]: folder(), [`${ROOT}/plate`]: folder() });

        const wrong = await validateCreateTarget(fake.service, `${ROOT}/plate.step`, ROOTS);
        expect(wrong).toEqual({ ok: false, message: expect.stringContaining('file extension') });

        const missing = await validateCreateTarget(fake.service, `${ROOT}/plate`, ROOTS);
        expect(missing).toEqual({ ok: false, message: expect.stringContaining('file extension') });

        expect(fake.exists).not.toHaveBeenCalled();
    });

    it('rejects a target that already exists as a file', async () => {
        const target = `${ROOT}/models/plate.nuke-cad`;
        const result = await validate({ [`${ROOT}/models`]: folder(), [target]: file() }, target);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('already exists') });
    });

    it('rejects a target that already exists as a folder', async () => {
        const target = `${ROOT}/models/bundle.nuke-cad`;
        const result = await validate({ [`${ROOT}/models`]: folder(), [target]: folder() }, target);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('already exists') });
    });

    it('rejects a workspace root used as the target', async () => {
        const root = '/workspace/project.nuke-cad';
        const result = await validate({}, root, [root]);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('already exists') });
    });

    it('rejects a missing parent folder', async () => {
        const result = await validate({}, `${ROOT}/missing/plate.nuke-cad`);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('does not exist') });
    });

    it('rejects a parent path that is a file', async () => {
        const result = await validate({ [`${ROOT}/models`]: file() }, `${ROOT}/models/plate.nuke-cad`);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('not a directory') });
    });

    it('rejects a symlinked parent folder', async () => {
        const result = await validate(
            { [`${ROOT}/linked`]: symlink('/workspace/outside', { isDirectory: true }) },
            `${ROOT}/linked/plate.nuke-cad`
        );

        expect(result).toEqual({ ok: false, message: expect.stringContaining('symbolic links') });
    });

    it('rejects a link reported only through a different real path', async () => {
        const result = await validate(
            {
                [`${ROOT}/linked`]: { isDirectory: true, isSymbolicLink: false, realPath: '/workspace/elsewhere' }
            },
            `${ROOT}/linked/plate.nuke-cad`
        );

        expect(result).toEqual({ ok: false, message: expect.stringContaining('symbolic links') });
    });

    it('rejects a symlink that occupies the target itself', async () => {
        const target = `${ROOT}/plate.nuke-cad`;
        const result = await validate({ [target]: symlink(`${ROOT}/missing-plate.nuke-cad`) }, target);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('already exists') });
    });

    it('rejects a relative path that escapes the workspace through dot segments', async () => {
        const fake = fakeFileService({ '/workspace/outside/plate.nuke-cad': folder() });
        const result = await validateCreateTarget(fake.service, '../outside/plate.nuke-cad', ROOTS);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('inside the workspace folder') });
        expect(fake.exists).not.toHaveBeenCalled();
        expect(fake.resolve).not.toHaveBeenCalled();
    });

    it('rejects an absolute path that escapes a root through dot segments', async () => {
        const result = await validate({}, `${ROOT}/../outside/plate.nuke-cad`);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('outside every workspace root') });
    });

    it('rejects empty and whitespace-only input', async () => {
        expect(await validate({}, '')).toEqual({ ok: false, message: expect.stringContaining('Enter a name') });
        expect(await validate({}, '   ')).toEqual({ ok: false, message: expect.stringContaining('Enter a name') });
    });

    it('rejects NUL bytes and other control characters with distinct messages', async () => {
        const nul = await validate({}, `${ROOT}/plate\u0000.nuke-cad`);
        expect(nul).toEqual({ ok: false, message: expect.stringContaining('NUL') });

        const control = await validate({}, `${ROOT}/plate\u0007.nuke-cad`);
        expect(control).toEqual({ ok: false, message: expect.stringContaining('control characters') });
        expect(control.ok).toBe(false);
    });

    it('rejects a path longer than the length cap before any filesystem access', async () => {
        const fake = fakeFileService({});
        const requested = `${ROOT}/${'a'.repeat(MAX_CREATE_TARGET_PATH_LENGTH)}.nuke-cad`;
        const result = await validateCreateTarget(fake.service, requested, ROOTS);

        expect(result).toEqual({ ok: false, message: expect.stringContaining(`longer than ${MAX_CREATE_TARGET_PATH_LENGTH}`) });
        expect(fake.exists).not.toHaveBeenCalled();
    });

    it('rejects every target when no workspace root is open', async () => {
        const fake = fakeFileService({ [`${ROOT}/plate.nuke-cad`]: file() });
        const result = await validateCreateTarget(fake.service, `${ROOT}/plate.nuke-cad`, []);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('Open a folder or workspace') });
        expect(fake.exists).not.toHaveBeenCalled();
    });

    it('reports an unreadable target path instead of accepting it', async () => {
        const service = {
            exists: vi.fn(async () => {
                throw new Error('EACCES');
            }),
            resolve: vi.fn()
        } as unknown as FileService;

        const result = await validateCreateTarget(service, `${ROOT}/plate.nuke-cad`, ROOTS);

        expect(result).toEqual({ ok: false, message: expect.stringContaining('cannot be read') });
    });
});
