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

/**
 * Body-row material tagging contract (free-text input rules + store mutation).
 *
 * The row itself renders in the Theia widget layer; this suite pins the logic
 * it drives — `normalizeBodyMaterialInput` (trim, ≤64 chars, reject `:`/`/`
 * and the `mat:` prefix, empty clears) and the `setBodyMaterial` commit path
 * (metadata-only, validated, unknown bodies rejected).
 */

import { describe, it, expect } from 'vitest';
import { normalizeBodyMaterialInput, validateBodyMaterialTag } from '../../../common/cad-document';
import { CadDocumentStore } from '../../document/cad-document-store';

describe('feature-tree material tagging', () => {
    describe('input validation', () => {
        it('accepts a trimmed bare name', () => {
            expect(validateBodyMaterialTag('UO2')).toBeUndefined();
            expect(normalizeBodyMaterialInput('  UO2  ')).toEqual({ material: 'UO2' });
        });

        it('clears the tag on empty input', () => {
            expect(normalizeBodyMaterialInput('')).toEqual({});
            expect(normalizeBodyMaterialInput('   ')).toEqual({});
        });

        it('rejects overlong input', () => {
            expect(validateBodyMaterialTag('x'.repeat(65))).toContain('64');
            const result = normalizeBodyMaterialInput('x'.repeat(65));
            expect('error' in result).toBe(true);
        });

        it('rejects DAGMC separators with a hint', () => {
            expect(validateBodyMaterialTag('a:b')).toContain(':');
            expect(validateBodyMaterialTag('a/b')).toContain('/');
        });

        it('rejects the mat: prefix with a drop-the-prefix hint', () => {
            const hint = validateBodyMaterialTag('mat:UO2');
            expect(hint).toContain('mat:');
            const result = normalizeBodyMaterialInput('mat:UO2');
            expect('error' in result && result.error).toContain('mat:');
        });
    });

    describe('mutation', () => {
        function taggingStore(): { store: CadDocumentStore; bodyId: string } {
            const store = new CadDocumentStore();
            store.createDocument('test');
            const add = store.addBody('Fuel', 'fuel');
            expect(add.success).toBe(true);
            return { store, bodyId: add.value! };
        }

        it('commits a normalized tag to the body', () => {
            const { store, bodyId } = taggingStore();
            const input = normalizeBodyMaterialInput('  UO2  ');
            expect('material' in input && input.material).toBe('UO2');
            const result = store.setBodyMaterial(bodyId, 'material' in input ? input.material : undefined);
            expect(result.success).toBe(true);
            expect(store.document?.bodies[0].material).toBe('UO2');
        });

        it('clears the tag on empty input', () => {
            const { store, bodyId } = taggingStore();
            expect(store.setBodyMaterial(bodyId, 'UO2').success).toBe(true);
            const input = normalizeBodyMaterialInput('   ');
            expect(input).toEqual({});
            expect(store.setBodyMaterial(bodyId, 'material' in input ? input.material : undefined).success).toBe(true);
            expect(store.document?.bodies[0].material).toBeUndefined();
        });

        it('never commits invalid input (hint shown instead)', () => {
            const { store, bodyId } = taggingStore();
            const input = normalizeBodyMaterialInput('mat:UO2');
            expect('error' in input).toBe(true);
            // The row shows the hint and skips the mutation; the commit path
            // itself would also reject it.
            expect(store.setBodyMaterial(bodyId, 'mat:UO2').success).toBe(false);
            expect(store.document?.bodies[0].material).toBeUndefined();
        });

        it('allows the same tag on several bodies (shared material)', () => {
            const { store, bodyId } = taggingStore();
            const second = store.addBody('Fuel 2', 'fuel_2');
            expect(second.success).toBe(true);
            expect(store.setBodyMaterial(bodyId, 'UO2').success).toBe(true);
            expect(store.setBodyMaterial(second.value!, 'UO2').success).toBe(true);
            expect(store.document?.bodies.map((b) => b.material)).toEqual(['UO2', 'UO2']);
        });
    });
});
