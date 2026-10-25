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

import { describe, expect, it } from 'vitest';
import { documentRelativeAssemblyPart, importedPartStorage, projectPartPath, projectPartsFolder } from './cad-import-path';

const DOCUMENT = '/work/project/assembly.nuke-cad';

describe('documentRelativeAssemblyPart', () => {
    it('stores a file in the document directory as ./<name>', () => {
        expect(documentRelativeAssemblyPart(DOCUMENT, '/work/project/model.step')).toBe('./model.step');
    });

    it('stores files nested under the document directory with a relative path', () => {
        expect(documentRelativeAssemblyPart(DOCUMENT, '/work/project/parts/model.iges')).toBe('./parts/model.iges');
        expect(documentRelativeAssemblyPart(DOCUMENT, '/work/project/a/b/model.brep')).toBe('./a/b/model.brep');
    });

    it('falls back to an absolute path outside the document directory', () => {
        expect(documentRelativeAssemblyPart(DOCUMENT, '/work/shared/model.step')).toBe('/work/shared/model.step');
        expect(documentRelativeAssemblyPart('/work/project/sub/assembly.nuke-cad', '/work/project/model.step')).toBe(
            '/work/project/model.step'
        );
    });

    it('does not treat a same-prefix sibling directory as nested', () => {
        expect(documentRelativeAssemblyPart(DOCUMENT, '/work/project-other/model.step')).toBe('/work/project-other/model.step');
    });

    it('normalizes separators and redundant segments', () => {
        expect(documentRelativeAssemblyPart(DOCUMENT, '/work/project/./parts//model.step')).toBe('./parts/model.step');
        expect(documentRelativeAssemblyPart(DOCUMENT, '/work/project/parts/../model.step')).toBe('./model.step');
        expect(documentRelativeAssemblyPart('/work/project/sub/assembly.nuke-cad', '/work/project/parts/../sub/./model.step')).toBe(
            './model.step'
        );
    });

    it('normalizes Windows separators and drive letters', () => {
        expect(documentRelativeAssemblyPart('C:\\work\\project\\assembly.nuke-cad', 'C:\\work\\project\\parts\\model.step')).toBe(
            './parts/model.step'
        );
        expect(documentRelativeAssemblyPart('/c:/work/project/assembly.nuke-cad', '/c:/work/project/model.step')).toBe('./model.step');
        expect(documentRelativeAssemblyPart('C:\\work\\project\\assembly.nuke-cad', 'D:\\shared\\model.step')).toBe('d:/shared/model.step');
    });

    it('resolves parent traversal before choosing the relative form', () => {
        expect(documentRelativeAssemblyPart('/work/project/sub/assembly.nuke-cad', '/work/project/sub/../model.step')).toBe(
            '/work/project/model.step'
        );
    });
});

describe('importedPartStorage', () => {
    it('copies an outside source into <document-stem>.parts', () => {
        expect(importedPartStorage(DOCUMENT, '/work/shared/model.step')).toEqual({
            copy: true,
            folder: '/work/project/assembly.parts',
            target: '/work/project/assembly.parts/model.step'
        });
    });

    it('references a source already inside the document folder in place', () => {
        expect(importedPartStorage(DOCUMENT, '/work/project/parts/model.step')).toEqual({
            copy: false,
            target: '/work/project/parts/model.step'
        });
        expect(importedPartStorage('/work/project/sub/assembly.nuke-cad', '/work/project/sub/parts/model.step')).toEqual({
            copy: false,
            target: '/work/project/sub/parts/model.step'
        });
    });

    it('keeps dotted document names and strips only the .nuke-cad extension', () => {
        expect(importedPartStorage('/work/project/sub/my.model.nuke-cad', '/work/shared/model.step')).toEqual({
            copy: true,
            folder: '/work/project/sub/my.model.parts',
            target: '/work/project/sub/my.model.parts/model.step'
        });
    });

    it('normalizes Windows drive letters and stores on the document drive', () => {
        expect(importedPartStorage('C:\\work\\project\\assembly.nuke-cad', 'D:\\shared\\model.step')).toEqual({
            copy: true,
            folder: 'c:/work/project/assembly.parts',
            target: 'c:/work/project/assembly.parts/model.step'
        });
        expect(importedPartStorage('C:\\work\\project\\assembly.nuke-cad', 'C:\\work\\project\\model.step')).toEqual({
            copy: false,
            target: 'C:\\work\\project\\model.step'
        });
    });
});

describe('project part paths', () => {
    it('places sources in a folder named after the document', () => {
        expect(projectPartsFolder(DOCUMENT)).toBe('/work/project/assembly.parts');
        expect(projectPartPath(DOCUMENT, 'scaled_w7x_stellarator.step')).toBe('/work/project/assembly.parts/scaled_w7x_stellarator.step');
    });

    it('keeps dotted names and normalizes Windows paths', () => {
        expect(projectPartsFolder('/work/project/my.model.nuke-cad')).toBe('/work/project/my.model.parts');
        expect(projectPartsFolder('C:\\work\\project\\assembly.nuke-cad')).toBe('c:/work/project/assembly.parts');
        expect(projectPartPath('C:\\work\\project\\assembly.nuke-cad', 'C:\\shared\\model.step')).toBe(
            'c:/work/project/assembly.parts/model.step'
        );
    });
});
