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
import { generatePythonScript } from './python-codegen';
import { NUKE_CAD_SCHEMA_VERSION, type NukeCadDocument, type FeatureDef } from './cad-document';
import { type TopologyRef } from './topology-refs';

function sampleDocument(): NukeCadDocument {
    const faceRef: TopologyRef = {
        featureId: 'pad_a',
        kind: 'face',
        fingerprint: { surfaceType: 'plane', area: 4, center: [0, 0, 1], normal: [0, 0, 1] }
    };
    const edgeRef: TopologyRef = {
        featureId: 'pad_a',
        kind: 'edge',
        fingerprint: { curveType: 'line', length: 2, start: [0, 0, 0], end: [1, 0, 0] }
    };
    const sketchA = {
        id: 'sketch_a',
        name: 'Block profile',
        datumId: 'datum-xy',
        primitives: [
            { id: 'p1', type: 'point', x: 0, y: 0 },
            { id: 'p2', type: 'point', x: 2, y: 0 },
            { id: 'p3', type: 'point', x: 2, y: 1 },
            { id: 'p4', type: 'point', x: 0, y: 1 },
            { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' },
            { id: 'l2', type: 'line', p1_id: 'p2', p2_id: 'p3' },
            { id: 'l3', type: 'line', p1_id: 'p3', p2_id: 'p4' },
            { id: 'l4', type: 'line', p1_id: 'p4', p2_id: 'p1' }
        ],
        constraints: [],
        externalRefs: [
            {
                featureId: 'pad_a',
                kind: 'edge',
                fingerprint: { curveType: 'line', length: 2, start: [0, 0, 0], end: [2, 0, 0] }
            }
        ] as import('./topology-refs').TopologyRef[]
    };
    const sketchB = {
        id: 'sketch_b',
        name: 'Pin profile',
        datumId: 'datum-xy',
        primitives: [
            { id: 'c1', type: 'circle', c_id: 'p5', radius: 0.3 },
            { id: 'p5', type: 'point', x: 0, y: 0 }
        ],
        constraints: []
    };

    const padA: FeatureDef = {
        id: 'pad_a',
        name: 'Base block',
        type: 'pad',
        body: 'body_a',
        sketchId: 'sketch_a',
        params: { length: 2, axis: 'z' },
        suppressed: false,
        dependsOn: []
    };
    const padB: FeatureDef = {
        id: 'pad_b',
        name: 'Pin',
        type: 'pad',
        body: 'body_b',
        sketchId: 'sketch_b',
        params: { length: 2, axis: 'z' },
        suppressed: false,
        dependsOn: []
    };
    const fillet: FeatureDef = {
        id: 'fillet_1',
        name: 'Round edges',
        type: 'fillet',
        body: 'body_a',
        params: { edges: [edgeRef], radius: 0.1 },
        suppressed: false,
        dependsOn: ['pad_a']
    };
    const booleanCut: FeatureDef = {
        id: 'bool_cut_1',
        name: 'Cut pin',
        type: 'booleanCut',
        body: 'body_a',
        params: { targetBody: 'body_a', toolBodies: ['body_b'], keepTools: true },
        suppressed: false,
        dependsOn: ['pad_a', 'pad_b']
    };
    const pattern: FeatureDef = {
        id: 'lin_pattern_1',
        name: 'Pattern pin',
        type: 'linearPattern',
        body: 'body_b',
        params: { source: 'pad_b', count: 3, spacing: 1.5, axis: 'x' },
        suppressed: false,
        dependsOn: ['pad_b']
    };
    const hole: FeatureDef = {
        id: 'hole_1',
        name: 'Mounting hole',
        type: 'hole',
        body: 'body_a',
        params: { face: faceRef, center: [0.5, 0.5], diameter: 0.2 },
        suppressed: false,
        dependsOn: ['pad_a']
    };

    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'Export fixture',
        parameters: { pitch: 1.26, pinRadius: 0.3, blockHeight: 2 },
        datums: [
            { id: 'datum-xy', kind: 'XY', name: 'XY' },
            { id: 'datum-offset', kind: 'offset', name: 'Offset', offset: 0.5 },
            { id: 'datum-face', kind: 'face', name: 'Face', reference: faceRef }
        ],
        bodies: [
            { id: 'body_a', name: 'Block', label: 'block' },
            { id: 'body_b', name: 'Pin', label: 'pin' }
        ],
        sketches: [sketchA, sketchB],
        features: [padA, padB, booleanCut, fillet, pattern, hole]
    };
}

describe('generatePythonScript', () => {
    it('produces deterministic output for a representative document', () => {
        const doc = sampleDocument();
        const first = generatePythonScript(doc);
        const second = generatePythonScript(doc);
        expect(first).toBe(second);
        expect(first.length).toBeGreaterThan(0);
    });

    it('emits topology-reference-dependent features as TODO markers', () => {
        const doc = sampleDocument();
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): fillet feature "Round edges"');
        expect(script).toContain('# TODO(manual): hole feature "Mounting hole"');
        expect(script).toContain('# TODO(manual): datum "Face" (face datum)');
        expect(script).toContain('# TODO(manual): edge line length=2');
    });

    it('emits parameters, datums, sketches, bodies, and features', () => {
        const doc = sampleDocument();
        const script = generatePythonScript(doc);
        expect(script).toContain('pitch = 1.26');
        expect(script).toContain('blockHeight = 2');
        expect(script).toContain('bd.Plane.XY');
        expect(script).toContain('def sketch_Block_profile_sketch_a():');
        expect(script).toContain('body_Block = None');
        expect(script).toContain('body_Pin = None');
        expect(script).toContain('bd.extrude');
        expect(script).toContain('bd.Location');
    });

    it('orders features by dependency DAG before document order', () => {
        const doc = sampleDocument();
        const script = generatePythonScript(doc);
        const baseIdx = script.indexOf('Base block');
        const pinIdx = script.indexOf('Pin');
        const cutIdx = script.indexOf('Cut pin');
        expect(baseIdx).toBeLessThan(cutIdx);
        expect(pinIdx).toBeLessThan(cutIdx);
    });

    it('matches the snapshot for the representative document', () => {
        expect(generatePythonScript(sampleDocument())).toMatchSnapshot();
    });

    it('emits runtime-correct build123d for patterns and mirror', () => {
        const script = generatePythonScript(sampleDocument());
        // Linear pattern: count includes the original; instances 1..count-1 move
        // the re-derived source solid, not the sketch.
        expect(script).toContain('_tool_lin_pattern_1 = bd.extrude(sketch_Pin_profile_sketch_b(), amount=2, dir=(0, 0, 1))');
        expect(script).toContain('for _k in range(1, 3):');
        expect(script).toContain('body_Pin = body_Pin + _tool_lin_pattern_1.moved(bd.Location((1.5 * _k, 0 * _k, 0 * _k)))');
    });
});

describe('generatePythonScript runtime emission', () => {
    function emissionDocument(): NukeCadDocument {
        const pad = (
            id: string,
            body: string,
            sketchId: string,
            params: Record<string, unknown>,
            dependsOn: string[] = []
        ): FeatureDef => ({
            id,
            name: id,
            type: 'pad',
            body,
            sketchId,
            params: params as FeatureDef['params'],
            suppressed: false,
            dependsOn
        });
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'emission',
            parameters: {},
            datums: [{ id: 'dxy', kind: 'XY', name: 'XY' }],
            bodies: [
                { id: 'b1', name: 'B1' },
                { id: 'b2', name: 'B2' },
                { id: 'b3', name: 'B3' },
                { id: 'b4', name: 'B4' },
                { id: 'b5', name: 'B5' }
            ],
            sketches: [
                {
                    id: 'sk_arc',
                    name: 'Arc',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 'a', type: 'point', x: 0, y: 0 },
                        { id: 'b', type: 'point', x: 3, y: 0 },
                        { id: 'c', type: 'point', x: 4, y: 1 },
                        { id: 'd', type: 'point', x: 0, y: 1 },
                        { id: 'ctr', type: 'point', x: 3, y: 1 },
                        { id: 'l1', type: 'line', p1_id: 'a', p2_id: 'b' },
                        {
                            id: 'arc1',
                            type: 'arc',
                            c_id: 'ctr',
                            radius: 1,
                            start_angle: -Math.PI / 2,
                            end_angle: 0,
                            start_id: 'b',
                            end_id: 'c'
                        },
                        { id: 'l2', type: 'line', p1_id: 'c', p2_id: 'd' },
                        { id: 'l3', type: 'line', p1_id: 'd', p2_id: 'a' }
                    ]
                },
                {
                    id: 'sk_nest',
                    name: 'Nest',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 'n1c', type: 'point', x: 0, y: 0 },
                        { id: 'n1', type: 'circle', c_id: 'n1c', radius: 1 },
                        { id: 'n2', type: 'circle', c_id: 'n1c', radius: 0.7 },
                        { id: 'n3', type: 'circle', c_id: 'n1c', radius: 0.4 }
                    ]
                },
                {
                    id: 'sk_annulus',
                    name: 'Annulus',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 'o1', type: 'point', x: 0, y: 0 },
                        { id: 'o2', type: 'point', x: 4, y: 0 },
                        { id: 'o3', type: 'point', x: 4, y: 4 },
                        { id: 'o4', type: 'point', x: 0, y: 4 },
                        { id: 'ol1', type: 'line', p1_id: 'o1', p2_id: 'o2' },
                        { id: 'ol2', type: 'line', p1_id: 'o2', p2_id: 'o3' },
                        { id: 'ol3', type: 'line', p1_id: 'o3', p2_id: 'o4' },
                        { id: 'ol4', type: 'line', p1_id: 'o4', p2_id: 'o1' },
                        { id: 'i1', type: 'point', x: 1, y: 1 },
                        { id: 'i2', type: 'point', x: 3, y: 1 },
                        { id: 'i3', type: 'point', x: 3, y: 3 },
                        { id: 'i4', type: 'point', x: 1, y: 3 },
                        { id: 'il1', type: 'line', p1_id: 'i1', p2_id: 'i2' },
                        { id: 'il2', type: 'line', p1_id: 'i2', p2_id: 'i3' },
                        { id: 'il3', type: 'line', p1_id: 'i3', p2_id: 'i4' },
                        { id: 'il4', type: 'line', p1_id: 'i4', p2_id: 'i1' }
                    ]
                },
                {
                    id: 'sk_pin',
                    name: 'Pin',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 'pc', type: 'point', x: 5, y: 0 },
                        { id: 'pci', type: 'circle', c_id: 'pc', radius: 0.3 }
                    ]
                }
            ],
            features: [
                pad('pad_arc', 'b1', 'sk_arc', { length: 2, symmetric: true }),
                pad('pad_nest', 'b2', 'sk_nest', { length: 1 }),
                pad('pad_annulus', 'b3', 'sk_annulus', { length: 1 }),
                {
                    id: 'rev_1',
                    name: 'rev_1',
                    type: 'revolve',
                    body: 'b4',
                    sketchId: 'sk_pin',
                    params: { angle: 270, axis: 'z' } as FeatureDef['params'],
                    suppressed: false,
                    dependsOn: []
                },
                pad('pad_pin', 'b5', 'sk_pin', { length: 1 }),
                {
                    id: 'circ_partial',
                    name: 'circ_partial',
                    type: 'circularPattern',
                    body: 'b5',
                    params: { source: 'pad_pin', count: 3, angle: 180, axis: 'z' } as FeatureDef['params'],
                    suppressed: false,
                    dependsOn: ['pad_pin']
                },
                {
                    id: 'circ_full',
                    name: 'circ_full',
                    type: 'circularPattern',
                    body: 'b5',
                    params: { source: 'pad_pin', count: 6, angle: 360, axis: 'z' } as FeatureDef['params'],
                    suppressed: false,
                    dependsOn: ['circ_partial']
                },
                {
                    id: 'mir_1',
                    name: 'mir_1',
                    type: 'mirror',
                    body: 'b5',
                    params: { source: 'pad_pin', plane: 'XZ' } as FeatureDef['params'],
                    suppressed: false,
                    dependsOn: ['circ_full']
                }
            ]
        };
    }

    it('emits arcs as CenterArc with degree sweep', () => {
        const script = generatePythonScript(emissionDocument());
        expect(script).toContain('bd.CenterArc((3, 1), 1, -90, 90)');
    });

    it('emits symmetric pads with both=True and halved amount', () => {
        const script = generatePythonScript(emissionDocument());
        expect(script).toContain('bd.extrude(sketch_Arc_sk_arc(), amount=2 / 2, both=True)');
    });

    it('emits revolve with revolution_arc', () => {
        const script = generatePythonScript(emissionDocument());
        expect(script).toContain('bd.revolve(sketch_Pin_sk_pin(), axis=bd.Axis.Z, revolution_arc=270)');
    });

    it('emits contained profiles as holes, including nested loops', () => {
        const script = generatePythonScript(emissionDocument());
        // Backend pairing: every contained profile is a hole of its outer —
        // no island parity for nested circles.
        expect(script).toContain('bd.Circle(1)');
        expect(script).toContain('bd.Circle(0.7, mode=bd.Mode.SUBTRACT)');
        expect(script).toContain('bd.Circle(0.4, mode=bd.Mode.SUBTRACT)');
        // Nested line loops: the inner loop is subtracted via make_face mode.
        expect(script).toContain('bd.make_face()');
        expect(script).toContain('bd.make_face(mode=bd.Mode.SUBTRACT)');
    });

    it('emits circular pattern steps for partial and full sweeps', () => {
        const script = generatePythonScript(emissionDocument());
        // Partial sweep: step = angle / (count - 1) = 180 / 2 = 90.
        expect(script).toContain('_tool_circ_partial.rotate(bd.Axis.Z, _k * 90)');
        // Full sweep: step = 360 / count = 60.
        expect(script).toContain('_tool_circ_full.rotate(bd.Axis.Z, _k * 60)');
    });

    it('emits mirror with an about plane on the re-derived source solid', () => {
        const script = generatePythonScript(emissionDocument());
        expect(script).toContain('body_B5 = body_B5 + bd.extrude(sketch_Pin_sk_pin(), amount=1).mirror(bd.Plane.XZ)');
    });

    it('marks suppressed features as comments instead of geometry', () => {
        const doc = emissionDocument();
        doc.features[0].suppressed = true;
        const script = generatePythonScript(doc);
        expect(script).toContain('# suppressed: pad feature "pad_arc" (excluded from the build)');
        expect(script).not.toContain('bd.extrude(sketch_Arc_sk_arc()');
    });
});
