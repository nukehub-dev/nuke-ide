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
import { ensureNukeCadExtension, NUKE_CAD_EXTENSION } from './cad-save-path';

describe('ensureNukeCadExtension', () => {
    it('appends the extension when missing', () => {
        expect(ensureNukeCadExtension('/mnt/data/my-test')).toBe('/mnt/data/my-test.nuke-cad');
    });

    it('appends the extension when a different one is present', () => {
        expect(ensureNukeCadExtension('/mnt/data/model.step')).toBe('/mnt/data/model.step.nuke-cad');
    });

    it('keeps a path that already ends with the extension', () => {
        expect(ensureNukeCadExtension('/mnt/data/model.nuke-cad')).toBe('/mnt/data/model.nuke-cad');
    });

    it('keeps the extension case-insensitively', () => {
        expect(ensureNukeCadExtension('/mnt/data/MODEL.NUKE-CAD')).toBe('/mnt/data/MODEL.NUKE-CAD');
    });

    it('ignores dots in directory names', () => {
        expect(ensureNukeCadExtension('/mnt/v1.2.3/my.model')).toBe('/mnt/v1.2.3/my.model.nuke-cad');
        expect(ensureNukeCadExtension('/mnt/v1.2.3/parts.nuke-cad')).toBe('/mnt/v1.2.3/parts.nuke-cad');
    });

    it('collapses an empty trailing extension', () => {
        expect(ensureNukeCadExtension('/mnt/data/model.')).toBe('/mnt/data/model.nuke-cad');
    });

    it('handles bare file names without directories', () => {
        expect(ensureNukeCadExtension(`untitled${NUKE_CAD_EXTENSION}`)).toBe('untitled.nuke-cad');
    });
});
