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
import { NUKE_CAD_SCHEMA_VERSION, validateNukeCadDocument, migrateNukeCadDocument, type NukeCadDocument } from './cad-document';

function makeDocument(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'L-bracket',
        parameters: { width: 10, height: 5 },
        datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
        sketches: [
            {
                id: 'sketch1',
                name: 'Profile',
                datumId: 'xy',
                primitives: [
                    { id: 'p1', type: 'point', x: 0, y: 0 },
                    { id: 'p2', type: 'point', x: 10, y: 0 },
                    { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' }
                ],
                constraints: [{ id: 'c1', type: 'horizontal_l', l_id: 'l1' }],
                parameters: { localAngle: 0 }
            }
        ],
        features: [
            {
                id: 'pad1',
                name: 'Base',
                type: 'pad',
                sketchId: 'sketch1',
                params: { length: 2 },
                suppressed: false,
                label: 'base',
                dependsOn: []
            }
        ]
    };
}

describe('validateNukeCadDocument', () => {
    it('accepts a valid document', () => {
        const result = validateNukeCadDocument(makeDocument());
        expect(result.valid).toBe(true);
        expect(result.issues).toHaveLength(0);
    });

    it('round-trips through JSON', () => {
        const doc = makeDocument();
        const round = JSON.parse(JSON.stringify(doc)) as NukeCadDocument;
        const result = validateNukeCadDocument(round);
        expect(result.valid).toBe(true);
        expect(round.version).toBe(NUKE_CAD_SCHEMA_VERSION);
    });

    it('reports duplicate ids across top-level collections', () => {
        const doc = makeDocument();
        doc.features[0].id = 'sketch1';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("duplicate id 'sketch1'"))).toBe(true);
    });

    it('reports duplicate primitive ids within a sketch', () => {
        const doc = makeDocument();
        doc.sketches[0].primitives.push({ id: 'p1', type: 'point', x: 1, y: 1 });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'sketches[0].primitives[3].id')).toBe(true);
    });

    it('reports duplicate constraint ids and collisions with primitive ids', () => {
        const doc = makeDocument();
        doc.sketches[0].constraints.push({ id: 'p1', type: 'vertical_l', l_id: 'l1' });
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes('collides with a primitive id'))).toBe(true);
    });

    it('reports dangling sketch datum references', () => {
        const doc = makeDocument();
        doc.sketches[0].datumId = 'missing';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown datum 'missing'"))).toBe(true);
    });

    it('reports dangling feature sketch references', () => {
        const doc = makeDocument();
        doc.features[0].sketchId = 'missing';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown sketch 'missing'"))).toBe(true);
    });

    it('reports dangling feature dependency references', () => {
        const doc = makeDocument();
        doc.features[0].dependsOn = ['missing'];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown feature 'missing'"))).toBe(true);
    });

    it('reports parameter name collisions between document and sketch', () => {
        const doc = makeDocument();
        doc.sketches[0].parameters = { width: 1 };
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes('collides with a document parameter'))).toBe(true);
    });

    it('reports out-of-range feature parameters', () => {
        const doc = makeDocument();
        doc.features[0].params = { length: -1 };
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.length')).toBe(true);
    });

    it('reports non-finite parameter values', () => {
        const doc = makeDocument();
        doc.parameters.width = NaN;
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'parameters.width')).toBe(true);
    });

    it('reports unknown feature types', () => {
        const doc = makeDocument();
        (doc.features[0] as unknown as { type: string }).type = 'unknownFeature';
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes("unknown feature type 'unknownFeature'"))).toBe(true);
    });

    it('reports missing required parameters per feature type', () => {
        const doc = makeDocument();
        doc.features = [
            { id: 'pad1', name: 'Pad', type: 'pad', params: {}, suppressed: false, dependsOn: [] },
            { id: 'rev1', name: 'Revolve', type: 'revolve', params: { axis: 'z' }, suppressed: false, dependsOn: [] },
            { id: 'fil1', name: 'Fillet', type: 'fillet', params: {}, suppressed: false, dependsOn: [] },
            { id: 'hole1', name: 'Hole', type: 'hole', params: {}, suppressed: false, dependsOn: [] }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path === 'features[0].params.length')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[1].params.angle')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[2].params.edges')).toBe(true);
        expect(result.issues.some((i) => i.path === 'features[3].params.diameter')).toBe(true);
    });

    it('reports self-dependencies and duplicate dependencies', () => {
        const doc = makeDocument();
        doc.features = [
            { id: 'a', name: 'A', type: 'pad', params: { length: 1 }, suppressed: false, dependsOn: ['a'] },
            { id: 'b', name: 'B', type: 'pad', params: { length: 1 }, suppressed: false, dependsOn: ['a', 'a'] }
        ];
        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.message.includes('cannot depend on itself'))).toBe(true);
        expect(result.issues.some((i) => i.message.includes('duplicate dependency'))).toBe(true);
    });

    it('recursively validates TopologyRefs in feature params and datums', () => {
        const badRef = {
            featureId: '',
            kind: 'face',
            fingerprint: { surfaceType: 'plane', area: 1, center: [0, 0, 0] }
        };
        const doc = makeDocument();
        doc.datums.push({ id: 'faceDatum', kind: 'face', name: 'Face', reference: badRef as never });
        doc.features.push({
            id: 'fil1',
            name: 'Fillet',
            type: 'fillet',
            params: { edges: [badRef] },
            suppressed: false,
            dependsOn: []
        });
        doc.features.push({
            id: 'shell1',
            name: 'Shell',
            type: 'shell',
            params: { faces: [badRef], thickness: 1 },
            suppressed: false,
            dependsOn: []
        });
        doc.features.push({
            id: 'draft1',
            name: 'Draft',
            type: 'draft',
            params: { faces: [badRef], angle: 5, pullDirection: [0, 0, 1] },
            suppressed: false,
            dependsOn: []
        });
        doc.features[0].params = { length: 1, upToFace: badRef };

        const result = validateNukeCadDocument(doc);
        expect(result.valid).toBe(false);
        expect(result.issues.some((i) => i.path.startsWith('datums[1].reference'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[1].params.edges'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[2].params.faces'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[3].params.faces'))).toBe(true);
        expect(result.issues.some((i) => i.path.startsWith('features[0].params.upToFace'))).toBe(true);
    });
});

describe('migrateNukeCadDocument', () => {
    it('passes through a document already at the current version', () => {
        const doc = makeDocument();
        const result = migrateNukeCadDocument(doc);
        expect(result.document).toBe(doc);
        expect(result.migratedFrom).toBeUndefined();
    });

    it('rejects a future schema version', () => {
        const doc = makeDocument();
        doc.version = 99;
        expect(() => migrateNukeCadDocument(doc)).toThrow(/Unsupported .nuke-cad schema version 99/);
    });

    it('rejects a non-object document', () => {
        expect(() => migrateNukeCadDocument(null)).toThrow('.nuke-cad document must be an object');
    });

    it('rejects a missing or invalid version', () => {
        expect(() => migrateNukeCadDocument({})).toThrow(/version must be an integer/);
    });
});
