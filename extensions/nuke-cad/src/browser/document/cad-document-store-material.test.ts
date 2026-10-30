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
import { CadDocumentStore } from './cad-document-store';
import { validateNukeCadDocument } from '../../common/cad-document';

function materialStore(): CadDocumentStore {
    const store = new CadDocumentStore();
    store.createDocument('test');
    const add = store.addBody('Fuel', 'fuel');
    expect(add.success).toBe(true);
    return store;
}

describe('CadDocumentStore.setBodyMaterial', () => {
    it('sets and clears the material tag', () => {
        const store = materialStore();
        const bodyId = store.document!.bodies[0].id;
        expect(store.document?.bodies[0].material).toBeUndefined();

        expect(store.setBodyMaterial(bodyId, 'UO2').success).toBe(true);
        expect(store.document?.bodies[0].material).toBe('UO2');
        expect(store.dirty).toBe(true);

        expect(store.setBodyMaterial(bodyId, undefined).success).toBe(true);
        expect(store.document?.bodies[0].material).toBeUndefined();
        expect('material' in store.document!.bodies[0]).toBe(false);
    });

    it('rejects unknown bodies', () => {
        const store = materialStore();
        const result = store.setBodyMaterial('ghost', 'UO2');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ghost');
    });

    it('rejects invalid tags at commit time without touching the document', () => {
        const store = materialStore();
        const bodyId = store.document!.bodies[0].id;
        for (const material of ['mat:UO2', 'fuel/pin', 'fuel:pin', 'x'.repeat(65)]) {
            const result = store.setBodyMaterial(bodyId, material);
            expect(result.success).toBe(false);
            expect(result.error).toContain('bodies[0].material');
            expect(store.document?.bodies[0].material).toBeUndefined();
        }
    });

    it('keeps the tag on the body across a label rename (selector re-keys)', () => {
        const store = materialStore();
        const bodyId = store.document!.bodies[0].id;
        expect(store.setBodyMaterial(bodyId, 'UO2').success).toBe(true);
        expect(store.setBodyLabel(bodyId, 'fuel_pin').success).toBe(true);
        expect(store.document?.bodies[0].label).toBe('fuel_pin');
        expect(store.document?.bodies[0].material).toBe('UO2');
    });

    it('round-trips a tag edit through undo/redo', () => {
        const store = materialStore();
        const bodyId = store.document!.bodies[0].id;
        expect(store.setBodyMaterial(bodyId, 'UO2').success).toBe(true);
        expect(store.canUndo).toBe(true);

        expect(store.undo().success).toBe(true);
        expect(store.document?.bodies[0].material).toBeUndefined();
        expect(validateNukeCadDocument(store.document!).valid).toBe(true);
        expect(store.canRedo).toBe(true);

        expect(store.redo().success).toBe(true);
        expect(store.document?.bodies[0].material).toBe('UO2');
        expect(validateNukeCadDocument(store.document!).valid).toBe(true);
        expect(store.canRedo).toBe(false);
    });

    it('round-trips a tag clear through undo/redo', () => {
        const store = materialStore();
        const bodyId = store.document!.bodies[0].id;
        expect(store.setBodyMaterial(bodyId, 'UO2').success).toBe(true);
        expect(store.setBodyMaterial(bodyId, undefined).success).toBe(true);
        expect(store.document?.bodies[0].material).toBeUndefined();

        expect(store.undo().success).toBe(true);
        expect(store.document?.bodies[0].material).toBe('UO2');

        expect(store.redo().success).toBe(true);
        expect(store.document?.bodies[0].material).toBeUndefined();
    });
});
