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

import { describe, it, expect } from 'vitest';
import { DOCUMENT_TEMPLATES, getDocumentTemplate, createEmptyNukeCadDocument, applyDocumentTemplate } from './document-templates';
import { validateNukeCadDocument } from './cad-document';

describe('document-templates', () => {
    it('ships the expected built-in templates', () => {
        const ids = DOCUMENT_TEMPLATES.map((t) => t.id);
        expect(ids).toEqual(['empty', 'pincell', 'tokamak']);
    });

    it('looks up templates by id', () => {
        expect(getDocumentTemplate('empty')?.name).toBe('Empty document');
        expect(getDocumentTemplate('pincell')?.parameters).toEqual({
            fuelRadius: 0.4,
            cladRadius: 0.5,
            pitch: 1.26
        });
        expect(getDocumentTemplate('tokamak')?.parameters).toEqual({
            major_radius: 450,
            minor_radius: 150
        });
        expect(getDocumentTemplate('missing')).toBeUndefined();
    });

    it('creates a valid empty v2 document', () => {
        const doc = createEmptyNukeCadDocument('Test');
        const validation = validateNukeCadDocument(doc);
        expect(validation.valid).toBe(true);
        expect(doc.name).toBe('Test');
        expect(doc.parameters).toEqual({});
        expect(doc.datums).toHaveLength(3);
        expect(doc.bodies).toHaveLength(0);
        expect(doc.sketches).toHaveLength(0);
        expect(doc.features).toHaveLength(0);
    });

    it('empty template is a no-op', () => {
        const doc = createEmptyNukeCadDocument('Test');
        const applied = applyDocumentTemplate(doc, 'empty');
        expect(applied.parameters).toEqual({});
        expect(applied).not.toBe(doc);
    });

    it('merges pincell parameters over an empty document', () => {
        const doc = createEmptyNukeCadDocument('Pincell');
        const applied = applyDocumentTemplate(doc, 'pincell');
        const validation = validateNukeCadDocument(applied);
        expect(validation.valid).toBe(true);
        expect(applied.parameters).toEqual({
            fuelRadius: 0.4,
            cladRadius: 0.5,
            pitch: 1.26
        });
    });

    it('merges tokamak parameters over an empty document', () => {
        const doc = createEmptyNukeCadDocument('Tokamak');
        const applied = applyDocumentTemplate(doc, 'tokamak');
        const validation = validateNukeCadDocument(applied);
        expect(validation.valid).toBe(true);
        expect(applied.parameters).toEqual({
            major_radius: 450,
            minor_radius: 150
        });
    });

    it('ignores an unknown template id', () => {
        const doc = createEmptyNukeCadDocument('Test');
        const applied = applyDocumentTemplate(doc, 'unknown');
        expect(applied.parameters).toEqual({});
        expect(validateNukeCadDocument(applied).valid).toBe(true);
    });
});
