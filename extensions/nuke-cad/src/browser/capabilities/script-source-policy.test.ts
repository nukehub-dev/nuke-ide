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
 * Tests the CAD script source policy and proposal validation.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { URI } from '@theia/core/lib/common/uri';
import type { FileContent, FileStat } from '@theia/filesystem/lib/common/files';
import type { FileService } from '@theia/filesystem/lib/browser/file-service';
import * as path from 'path';
import {
    MAX_SCRIPT_BYTES,
    MAX_SCRIPT_IMPORTS,
    MAX_SCRIPT_LINES,
    ScriptSourceSnapshot,
    hashScriptContent,
    readActiveScript,
    validateProposedScript
} from './script-source-policy';

const WORKSPACE = '/workspace';
const PROJECT = '/workspace/project';
const SCRIPT_PATH = '/workspace/project/model.py';

class FakeScriptFileService {
    readonly files = new Map<string, string>();
    readonly rawFiles = new Map<string, Uint8Array>();
    readonly directories = new Set<string>(['/', WORKSPACE, PROJECT]);
    readonly symlinks = new Set<string>();

    addFile(filePath: string, content: string): void {
        this.files.set(filePath, content);
        this.directories.add(path.dirname(filePath));
    }

    addRawFile(filePath: string, content: Uint8Array): void {
        this.rawFiles.set(filePath, content);
        this.directories.add(path.dirname(filePath));
    }

    async resolve(uri: URI): Promise<FileStat> {
        const target = uri.path.toString();
        if (!this.files.has(target) && !this.rawFiles.has(target) && !this.directories.has(target) && !this.symlinks.has(target)) {
            throw new Error(`missing: ${target}`);
        }
        const content = this.files.get(target);
        const raw = this.rawFiles.get(target);
        const isDirectory = this.directories.has(target) && content === undefined && raw === undefined;
        return {
            resource: uri,
            name: path.basename(target),
            size: content !== undefined ? utf8Length(content) : (raw?.byteLength ?? 0),
            isFile: !isDirectory,
            isDirectory,
            isSymbolicLink: this.symlinks.has(target),
            isReadonly: false
        } as FileStat;
    }

    async readFile(uri: URI): Promise<FileContent> {
        const target = uri.path.toString();
        const content = this.files.get(target);
        if (content !== undefined) {
            return { value: BinaryBuffer.fromString(content) } as FileContent;
        }
        const raw = this.rawFiles.get(target);
        if (raw !== undefined) {
            return { value: BinaryBuffer.wrap(raw) } as FileContent;
        }
        throw new Error(`missing: ${target}`);
    }
}

function fileService(fake: FakeScriptFileService): Pick<FileService, 'resolve' | 'readFile'> {
    return fake as unknown as Pick<FileService, 'resolve' | 'readFile'>;
}

function knownHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

async function snapshot(content = 'from build123d import *\nmodel = Box(1, 2, 3)\n'): Promise<ScriptSourceSnapshot> {
    const fake = new FakeScriptFileService();
    fake.addFile(SCRIPT_PATH, content);
    const result = await readActiveScript(fileService(fake), SCRIPT_PATH, [WORKSPACE]);
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result.value;
}

describe('readActiveScript', () => {
    it('reads a workspace-contained .py file with a lowercase SHA-256 and derived metadata', async () => {
        const content = 'import math\nfrom build123d import *\n\nmodel = Box(1, 2, 3)\n';
        const fake = new FakeScriptFileService();
        fake.addFile(SCRIPT_PATH, content);

        const result = await readActiveScript(fileService(fake), SCRIPT_PATH, [WORKSPACE]);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.value).toEqual({
            path: SCRIPT_PATH,
            content,
            hash: knownHash(content),
            bytes: utf8Length(content),
            lines: 4,
            imports: ['import math', 'from build123d import *'],
            hasModelAssignment: true,
            truncated: false
        });
        expect(result.value.hash).toBe(result.value.hash.toLowerCase());
    });

    it('treats CRLF as one logical line ending and keeps the original content hash', async () => {
        const content = 'import math\r\nmodel = Box(1, 2, 3)\r\n';
        const fake = new FakeScriptFileService();
        fake.addFile(SCRIPT_PATH, content);

        const result = await readActiveScript(fileService(fake), SCRIPT_PATH, [WORKSPACE]);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value.lines).toBe(2);
            expect(result.value.hash).toBe(knownHash(content));
            expect(result.value.imports).toEqual(['import math']);
        }
    });

    it('reports no imports and no model assignment for a plain script', async () => {
        const value = await snapshot('print("hello")\n');
        expect(value.imports).toEqual([]);
        expect(value.hasModelAssignment).toBe(false);
        expect(value.lines).toBe(1);
    });

    it('caps the reported import list and marks the snapshot truncated', async () => {
        const imports = Array.from({ length: MAX_SCRIPT_IMPORTS + 1 }, (_, index) => `import module_${index}`);
        const value = await snapshot(`${imports.join('\n')}\nmodel = Box(1, 2, 3)\n`);

        expect(value.imports).toHaveLength(MAX_SCRIPT_IMPORTS);
        expect(value.imports[0]).toBe('import module_0');
        expect(value.imports[MAX_SCRIPT_IMPORTS - 1]).toBe(`import module_${MAX_SCRIPT_IMPORTS - 1}`);
        expect(value.truncated).toBe(true);
    });

    it('rejects a missing script path', async () => {
        const fake = new FakeScriptFileService();
        expect(await readActiveScript(fileService(fake), undefined, [WORKSPACE])).toEqual({
            ok: false,
            message: 'Open a saved Python model script before asking NukeAI to inspect or change it.'
        });
    });

    it('rejects relative, outside-workspace, and non-Python paths', async () => {
        const fake = new FakeScriptFileService();
        fake.addFile('/tmp/model.py', 'model = Box(1, 2, 3)\n');
        fake.addFile('/workspace/project/model.txt', 'model = Box(1, 2, 3)\n');

        expect(await readActiveScript(fileService(fake), 'project/model.py', [WORKSPACE])).toMatchObject({
            ok: false,
            message: 'The active CAD script path must be absolute.'
        });
        expect(await readActiveScript(fileService(fake), '/tmp/model.py', [WORKSPACE])).toMatchObject({
            ok: false,
            message: 'The active CAD script is outside every workspace root.'
        });
        expect(await readActiveScript(fileService(fake), '/workspace/project/model.txt', [WORKSPACE])).toMatchObject({
            ok: false,
            message: 'Script authoring applies only to Python (.py) model scripts.'
        });
    });

    it('rejects a symlink in any path component, including the final file', async () => {
        const fake = new FakeScriptFileService();
        fake.addFile(SCRIPT_PATH, 'model = Box(1, 2, 3)\n');
        fake.symlinks.add(PROJECT);

        expect(await readActiveScript(fileService(fake), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script path contains a symbolic link.'
        });

        fake.symlinks.clear();
        fake.symlinks.add(SCRIPT_PATH);
        expect(await readActiveScript(fileService(fake), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script path contains a symbolic link.'
        });
    });

    it('rejects a directory, a missing file, and an unreadable file', async () => {
        const fake = new FakeScriptFileService();
        fake.directories.add('/workspace/project/model.py');
        expect(await readActiveScript(fileService(fake), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script must be a regular file, not a directory.'
        });

        fake.directories.delete('/workspace/project/model.py');
        expect(await readActiveScript(fileService(fake), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script does not exist or cannot be read.'
        });
    });

    it('rejects an oversized file, too many lines, NUL bytes, and invalid UTF-8', async () => {
        const oversized = new FakeScriptFileService();
        oversized.addFile(SCRIPT_PATH, 'x'.repeat(MAX_SCRIPT_BYTES + 1));
        expect(await readActiveScript(fileService(oversized), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script is larger than the 64 KiB script limit.'
        });

        const tooManyLines = new FakeScriptFileService();
        tooManyLines.addFile(SCRIPT_PATH, `${'x\n'.repeat(MAX_SCRIPT_LINES)}\n`);
        expect(await readActiveScript(fileService(tooManyLines), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script has more than 2,000 lines.'
        });

        const nul = new FakeScriptFileService();
        nul.addFile(SCRIPT_PATH, 'model = Box(1, 2, 3)\u0000\n');
        expect(await readActiveScript(fileService(nul), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script contains a NUL byte and is not a text file.'
        });

        const invalidUtf8 = new FakeScriptFileService();
        invalidUtf8.addRawFile(SCRIPT_PATH, new Uint8Array([0xff, 0xfe, 0x00]));
        expect(await readActiveScript(fileService(invalidUtf8), SCRIPT_PATH, [WORKSPACE])).toEqual({
            ok: false,
            message: 'The active CAD script could not be read as UTF-8 text.'
        });
    });
});

describe('validateProposedScript', () => {
    it('accepts a changed full body and derives bytes, lines, imports, and model assignment', async () => {
        const base = await snapshot();
        const proposed = 'import math\nfrom build123d import *\n\nmodel = Box(2, 2, 2)\n';

        const result = validateProposedScript(base, proposed);

        expect(result).toEqual({
            ok: true,
            content: proposed,
            bytes: utf8Length(proposed),
            lines: 4,
            imports: ['import math', 'from build123d import *'],
            hasModelAssignment: true
        });
        expect('hash' in result).toBe(false);
    });

    it('rejects an unchanged body', async () => {
        const base = await snapshot();
        expect(validateProposedScript(base, base.content)).toEqual({
            ok: false,
            message: 'The proposed script does not change the active script.'
        });
    });

    it('rejects NUL bytes, oversized bodies, and too many lines', async () => {
        const base = await snapshot();
        expect(validateProposedScript(base, 'model = Box(1, 2, 3)\u0000\n')).toEqual({
            ok: false,
            message: 'The proposed script contains a NUL byte and is not a text file.'
        });
        expect(validateProposedScript(base, 'x'.repeat(MAX_SCRIPT_BYTES + 1))).toEqual({
            ok: false,
            message: 'The proposed script is larger than the 64 KiB script limit.'
        });
        expect(validateProposedScript(base, `${'x\n'.repeat(MAX_SCRIPT_LINES)}\n`)).toEqual({
            ok: false,
            message: 'The proposed script has more than 2,000 lines.'
        });
    });

    it('accepts a non-string body defensively and rejects it', async () => {
        const base = await snapshot();
        const result = validateProposedScript(base, 42 as unknown as string);
        expect(result).toEqual({ ok: false, message: 'The proposed script must be a text body.' });
    });
});

describe('hashScriptContent', () => {
    it('matches node:crypto for ASCII, Unicode, empty, and newline-heavy text', async () => {
        for (const content of ['', 'model = Box(1, 2, 3)\n', 'λ = 1\n', 'a\r\nb\n', 'x'.repeat(4096)]) {
            await expect(hashScriptContent(content)).resolves.toBe(knownHash(content));
        }
    });
});
