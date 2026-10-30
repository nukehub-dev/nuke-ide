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

import { describe, expect, it } from 'vitest';
import { type BodyDef } from '../../../common/cad-document';
import { collectMaterialTags } from './outline-materials';

function body(id: string, material?: string): BodyDef {
    return { id, name: id, material };
}

describe('collectMaterialTags', () => {
    it('skips untagged and blank bodies', () => {
        expect(collectMaterialTags([body('a'), body('b', '   '), body('c', '\t')])).toEqual([]);
    });

    it('trims tags and dedupes case-insensitively, keeping the first spelling', () => {
        const tags = collectMaterialTags([body('a', '  UO2 '), body('b', 'uo2'), body('c', 'Steel'), body('d', 'steel')]);
        expect(tags).toEqual(['UO2', 'Steel']);
    });

    it('preserves body order', () => {
        expect(collectMaterialTags([body('a', 'clad'), body('b', 'fuel'), body('c', 'moderator')])).toEqual(['clad', 'fuel', 'moderator']);
    });
});
