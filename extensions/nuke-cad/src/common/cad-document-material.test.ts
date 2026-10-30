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
import {
    BODY_MATERIAL_MAX_LENGTH,
    NUKE_CAD_SCHEMA_VERSION,
    migrateNukeCadDocument,
    normalizeBodyMaterialInput,
    validateBodyMaterialTag,
    validateNukeCadDocument,
    type BodyDef,
    type NukeCadDocument
} from './cad-document';

function makeDocumentWithBodies(bodies: BodyDef[]): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'tagging',
        parameters: {},
        datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
        bodies,
        sketches: [],
        features: [],
        curves: []
    };
}

describe('BodyDef.material schema validation', () => {
    it('accepts a bare material tag beside the label', () => {
        const doc = makeDocumentWithBodies([{ id: 'body-1', name: 'Fuel', label: 'fuel', material: 'UO2' }]);
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('treats absent material as untagged (v3-additive, no migration)', () => {
        expect(NUKE_CAD_SCHEMA_VERSION).toBe(3);
        const doc = makeDocumentWithBodies([{ id: 'body-1', name: 'Base', label: 'base' }]);
        expect(validateNukeCadDocument(doc).valid).toBe(true);
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(validateNukeCadDocument(round).valid).toBe(true);
        expect(migrateNukeCadDocument(round).migratedFrom).toBeUndefined();
    });

    it('keeps a tagged document migration-free with an intact tag', () => {
        const doc = makeDocumentWithBodies([{ id: 'body-1', name: 'Fuel', label: 'fuel', material: 'UO2' }]);
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        expect(validateNukeCadDocument(round).valid).toBe(true);
        expect(migrateNukeCadDocument(round).migratedFrom).toBeUndefined();
        expect(round.bodies[0].material).toBe('UO2');
    });

    it('rejects a non-string material', () => {
        const doc = makeDocumentWithBodies([{ id: 'body-1', name: 'Base' }]);
        (doc.bodies[0] as unknown as { material: number }).material = 7;
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'bodies[0].material')).toBe(true);
    });

    it('rejects empty and whitespace-only tags', () => {
        for (const material of ['', '   ']) {
            const doc = makeDocumentWithBodies([{ id: 'body-1', name: 'Base', material }]);
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === 'bodies[0].material')).toBe(true);
        }
    });

    it('rejects tags over the length bound', () => {
        const doc = makeDocumentWithBodies([{ id: 'body-1', name: 'Base', material: 'x'.repeat(BODY_MATERIAL_MAX_LENGTH + 1) }]);
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'bodies[0].material')).toBe(true);
    });

    it('rejects DAGMC separators and the mat: prefix', () => {
        for (const material of ['fuel:pin', 'fuel/pin', 'mat:UO2']) {
            const doc = makeDocumentWithBodies([{ id: 'body-1', name: 'Base', material }]);
            const result = validateNukeCadDocument(doc);
            expect(result.valid).toBe(false);
            expect(result.issues.some((i) => i.path === 'bodies[0].material')).toBe(true);
        }
    });
});

describe('validateBodyMaterialTag', () => {
    it('accepts bare names and trims surrounding whitespace', () => {
        expect(validateBodyMaterialTag('UO2')).toBeUndefined();
        expect(validateBodyMaterialTag('  UO2  ')).toBeUndefined();
        expect(validateBodyMaterialTag('D2O-moderator_2')).toBeUndefined();
    });

    it('treats empty input as a clear (valid)', () => {
        expect(validateBodyMaterialTag('')).toBeUndefined();
        expect(validateBodyMaterialTag('   ')).toBeUndefined();
    });

    it('rejects the mat: prefix with a drop-the-prefix hint', () => {
        const hint = validateBodyMaterialTag('mat:UO2');
        expect(hint).toContain('mat:');
        expect(validateBodyMaterialTag('mat:')).toBeDefined();
    });

    it('rejects DAGMC separators', () => {
        expect(validateBodyMaterialTag('a:b')).toContain(':');
        expect(validateBodyMaterialTag('a/b')).toContain('/');
    });

    it('rejects tags over 64 characters', () => {
        expect(validateBodyMaterialTag('x'.repeat(64))).toBeUndefined();
        expect(validateBodyMaterialTag('x'.repeat(65))).toContain('64');
    });
});

describe('normalizeBodyMaterialInput', () => {
    it('clears on empty input', () => {
        expect(normalizeBodyMaterialInput('')).toEqual({});
        expect(normalizeBodyMaterialInput('   ')).toEqual({});
    });

    it('trims and returns a valid tag', () => {
        expect(normalizeBodyMaterialInput('  UO2  ')).toEqual({ material: 'UO2' });
    });

    it('returns the hint on invalid input', () => {
        const result = normalizeBodyMaterialInput('mat:UO2');
        expect('error' in result && result.error).toContain('mat:');
    });
});
