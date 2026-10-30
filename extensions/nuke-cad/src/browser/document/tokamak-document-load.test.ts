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
import * as fs from 'fs';
import * as path from 'path';
import { CadDocumentStore } from './cad-document-store';
import { validateNukeCadDocument } from '../../common/cad-document';

/**
 * Headless reproduction of the frontend document-load path for the tokamak
 * fixture. The open handler reads the file, parses JSON, and feeds it to the
 * document store. This test proves that path is not where the large-document
 * failure occurs; the bottleneck is later, in the backend build and the
 * synchronous tessellation parse/render.
 */

describe('tokamak document load', () => {
    const fixturePath = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'assets', 'tokamak_with_divertor.nuke-cad');

    it('loads and validates the committed tokamak fixture', () => {
        expect(fs.existsSync(fixturePath)).toBe(true);
        const content = fs.readFileSync(fixturePath, 'utf-8');
        expect(content.length).toBeGreaterThan(400_000);

        const json = JSON.parse(content) as unknown;
        const store = new CadDocumentStore();
        const loadResult = store.loadDocument(json);
        expect(loadResult.success).toBe(true);

        const doc = store.document!;
        expect(doc.bodies.length).toBe(23);
        expect(doc.sketches.length).toBe(23);
        expect(doc.features.length).toBe(26);

        const validation = validateNukeCadDocument(doc);
        expect(validation.valid).toBe(true);
        expect(validation.issues).toHaveLength(0);

        const totalPrimitives = doc.sketches.reduce((sum, s) => sum + s.primitives.length, 0);
        const totalConstraints = doc.sketches.reduce((sum, s) => sum + s.constraints.length, 0);
        expect(totalPrimitives).toBe(1992);
        expect(totalConstraints).toBe(36);
    });
});
