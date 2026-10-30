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
        features: [padA, padB, booleanCut, fillet, pattern, hole],
        curves: []
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
            ],
            curves: []
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

function curveDocument(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'curves',
        parameters: {},
        datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
        bodies: [],
        sketches: [],
        features: [],
        curves: [
            {
                id: 'c1',
                name: 'Helix',
                source: {
                    kind: 'parametric',
                    x: 'cos(t)',
                    y: 'sin(t)',
                    z: 't',
                    tStart: 0,
                    tEnd: 1,
                    sampleCount: 8
                },
                samples: [
                    [1, 0, 0],
                    [0, 1, 0.125],
                    [-1, 0, 0.25],
                    [0, -1, 0.375],
                    [1, 0, 0.5]
                ]
            },
            {
                id: 'c2',
                name: 'W7X coil',
                source: { kind: 'points' },
                samples: [
                    [0, 0, 0],
                    [1, 0, 0],
                    [1, 1, 0],
                    [0, 1, 0]
                ]
            }
        ]
    };
}

describe('generatePythonScript curve emission', () => {
    it('emits a Spline for each curve', () => {
        const script = generatePythonScript(curveDocument());
        expect(script).toContain('# Curves');
        expect(script).toContain('curve_Helix = bd.Spline(*curve_Helix_points)');
        expect(script).toContain('curve_W7X_coil = bd.Spline(*curve_W7X_coil_points)');
    });

    it('emits the sample point list as a Python list of tuples', () => {
        const script = generatePythonScript(curveDocument());
        expect(script).toContain('curve_Helix_points = [');
        expect(script).toContain('(1, 0, 0)');
    });

    it('includes a source comment for parametric and fourier curves', () => {
        const script = generatePythonScript(curveDocument());
        expect(script).toContain('# source: parametric x=cos(t) y=sin(t) z=t');
    });

    it('does not include a source comment for points curves', () => {
        const script = generatePythonScript(curveDocument());
        expect(script).not.toMatch(/source:.*points/);
    });

    it('emits the no-curves comment when the curves array is empty', () => {
        const doc = curveDocument();
        doc.curves = [];
        const script = generatePythonScript(doc);
        expect(script).toContain('# No curves defined.');
    });

    it('emits curves before features so sweep paths are defined first', () => {
        const doc = sweepDocument();
        const script = generatePythonScript(doc);
        expect(script.indexOf('# Curves')).toBeLessThan(script.indexOf('# Features'));
        expect(script.indexOf('curve_W7X_coil = bd.Spline')).toBeLessThan(script.indexOf('bd.sweep('));
    });
});

function sweepDocument(): NukeCadDocument {
    const base = curveDocument();
    return {
        ...base,
        name: 'sweep export',
        bodies: [{ id: 'b1', name: 'Rail' }],
        sketches: [
            {
                id: 'sk_sq',
                name: 'Square',
                datumId: 'xy',
                constraints: [],
                primitives: [
                    { id: 'q1', type: 'point', x: 0, y: 0 },
                    { id: 'q2', type: 'point', x: 1, y: 0 },
                    { id: 'q3', type: 'point', x: 1, y: 1 },
                    { id: 'q4', type: 'point', x: 0, y: 1 },
                    { id: 'ql1', type: 'line', p1_id: 'q1', p2_id: 'q2' },
                    { id: 'ql2', type: 'line', p1_id: 'q2', p2_id: 'q3' },
                    { id: 'ql3', type: 'line', p1_id: 'q3', p2_id: 'q4' },
                    { id: 'ql4', type: 'line', p1_id: 'q4', p2_id: 'q1' }
                ]
            }
        ],
        features: [
            {
                id: 'sw_1',
                name: 'Rail sweep',
                type: 'sweep',
                body: 'b1',
                sketchId: 'sk_sq',
                params: { pathCurveId: 'c2', orientation: 'frenet' } as FeatureDef['params'],
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'pp_1',
                name: 'Conduit',
                type: 'pipe',
                body: 'b1',
                params: { pathCurveId: 'c1', radius: 0.25, orientation: 'fixedBinormal', binormal: [0, 0, 1] } as FeatureDef['params'],
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'pat_1',
                name: 'Rail pattern',
                type: 'circularPattern',
                body: 'b1',
                params: { source: 'sw_1', count: 4, angle: 360, axis: 'z' } as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['sw_1']
            }
        ]
    };
}

describe('generatePythonScript sweep/pipe emission', () => {
    it('emits sweep with the sketch section and curve path repositioned to the path start', () => {
        const script = generatePythonScript(sweepDocument());
        expect(script).toContain('_sweep_plane_sw_1 = bd.Plane(curve_W7X_coil @ 0, z_dir=curve_W7X_coil.tangent_at(0))');
        expect(script).toContain(
            'bd.sweep(sketch_Square_sk_sq().moved(_sweep_plane_sw_1.location * datum_XY_xy.location.inverse), path=curve_W7X_coil)'
        );
    });

    it('emits pipe as a circle-section sweep and marks fixedBinormal as a manual TODO', () => {
        const script = generatePythonScript(sweepDocument());
        expect(script).toContain('# TODO(manual): binormal-locked orientation');
        expect(script).toContain('bd.sweep(bd.Circle(0.25).moved(_sweep_plane_pp_1.location), path=curve_Helix)');
    });

    it('accepts sweep and pipe as pattern sources', () => {
        const script = generatePythonScript(sweepDocument());
        expect(script).toContain('_tool_pat_1 = bd.sweep(sketch_Square_sk_sq().moved(');
        expect(script).toContain('body_Rail = body_Rail + _tool_pat_1.rotate(bd.Axis.Z, _k * 90)');
    });

    it('marks a sweep with an unknown path curve as a manual TODO', () => {
        const doc = sweepDocument();
        (doc.features[0].params as Record<string, unknown>).pathCurveId = 'missing';
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): sweep feature "Rail sweep"');
    });

    it('matches the snapshot for the sweep/pipe document', () => {
        expect(generatePythonScript(sweepDocument())).toMatchSnapshot();
    });
});

function loftHelixDocument(): NukeCadDocument {
    const rectangle = (id: string, name: string): import('./cad-document').SketchDef => ({
        id,
        name,
        datumId: 'xy',
        constraints: [],
        primitives: [
            { id: `${id}_p1`, type: 'point', x: 0, y: 0 },
            { id: `${id}_p2`, type: 'point', x: 2, y: 0 },
            { id: `${id}_p3`, type: 'point', x: 2, y: 1 },
            { id: `${id}_p4`, type: 'point', x: 0, y: 1 },
            { id: `${id}_l1`, type: 'line', p1_id: `${id}_p1`, p2_id: `${id}_p2` },
            { id: `${id}_l2`, type: 'line', p1_id: `${id}_p2`, p2_id: `${id}_p3` },
            { id: `${id}_l3`, type: 'line', p1_id: `${id}_p3`, p2_id: `${id}_p4` },
            { id: `${id}_l4`, type: 'line', p1_id: `${id}_p4`, p2_id: `${id}_p1` }
        ]
    });
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'loft helix export',
        parameters: {},
        datums: [{ id: 'xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'b1', name: 'Transition' }],
        sketches: [rectangle('sk_lo_a', 'Loft A'), rectangle('sk_lo_b', 'Loft B'), rectangle('sk_sec', 'Spring section')],
        features: [
            {
                id: 'loft_1',
                name: 'Transition loft',
                type: 'loft',
                body: 'b1',
                params: { sectionSketchIds: ['sk_lo_a', 'sk_lo_b'], ruled: true } as FeatureDef['params'],
                suppressed: false,
                dependsOn: []
            },
            {
                id: 'helix_1',
                name: 'Spring sweep',
                type: 'helicalSweep',
                body: 'b1',
                sketchId: 'sk_sec',
                params: {
                    axis: 'Z',
                    startRadius: 5,
                    pitch: 2,
                    turns: 3,
                    leftHanded: false,
                    orientation: 'fixedBinormal',
                    binormal: [0, 0, 1]
                } as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['loft_1']
            },
            {
                id: 'helix_frenet',
                name: 'Twisted sweep',
                type: 'helicalSweep',
                body: 'b1',
                sketchId: 'sk_sec',
                params: {
                    axis: 'Y',
                    startRadius: 2,
                    pitch: 1,
                    turns: 2,
                    leftHanded: true,
                    orientation: 'frenet'
                } as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['helix_1']
            }
        ],
        curves: []
    };
}

describe('generatePythonScript loft/helicalSweep emission', () => {
    it('emits a loft over its ordered section sketches with the ruled flag', () => {
        const script = generatePythonScript(loftHelixDocument());
        expect(script).toContain(
            'body_Transition = body_Transition + bd.loft([sketch_Loft_A_sk_lo_a(), sketch_Loft_B_sk_lo_b()], ruled=True) ' +
                'if body_Transition is not None else bd.loft([sketch_Loft_A_sk_lo_a(), sketch_Loft_B_sk_lo_b()], ruled=True)  # Transition loft'
        );
    });

    it('emits a helical sweep as bd.Helix plus the sweep plane and bd.sweep', () => {
        const script = generatePythonScript(loftHelixDocument());
        expect(script).toContain('_helix_helix_1 = bd.Helix(pitch=2, height=6, radius=5, direction=(0, 0, 1), lefthand=False)');
        expect(script).toContain('_sweep_plane_helix_1 = bd.Plane(_helix_helix_1 @ 0, z_dir=_helix_helix_1.tangent_at(0))');
        expect(script).toContain(
            'bd.sweep(sketch_Spring_section_sk_sec().moved(' +
                '_sweep_plane_helix_1.location * datum_XY_xy.location.inverse), path=_helix_helix_1)'
        );
    });

    it('keeps the fixedBinormal TODO hatch for helical sweeps', () => {
        const script = generatePythonScript(loftHelixDocument());
        const hatch = '# TODO(manual): binormal-locked orientation — "Spring sweep" sweeps with a fixed binormal [0,0,1];';
        expect(script).toContain(hatch);
    });

    it('emits a left-handed frenet helical sweep without a binormal hatch', () => {
        const script = generatePythonScript(loftHelixDocument());
        expect(script).toContain('_helix_helix_frenet = bd.Helix(pitch=1, height=2, radius=2, direction=(0, 1, 0), lefthand=True)');
        expect(script).toContain('path=_helix_helix_frenet)');
        const frenetSection = script.slice(script.indexOf('Twisted sweep'));
        expect(frenetSection).not.toContain('binormal-locked orientation');
    });

    it('degrades a loft with a face-datum section to a manual TODO', () => {
        const doc = loftHelixDocument();
        doc.sketches[1] = {
            ...doc.sketches[1],
            datumId: 'face-datum'
        };
        doc.datums.push({
            id: 'face-datum',
            kind: 'face',
            name: 'Face datum',
            reference: {
                featureId: 'loft_1',
                kind: 'face',
                fingerprint: { surfaceType: 'plane', area: 4, center: [0, 0, 0], normal: [0, 0, 1] }
            }
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): loft feature "Transition loft"');
        expect(script).not.toContain('bd.loft(');
    });

    it('accepts loft and helicalSweep as pattern/mirror sources', () => {
        const doc = loftHelixDocument();
        doc.features.push(
            {
                id: 'pat_loft',
                name: 'Loft pattern',
                type: 'circularPattern',
                body: 'b1',
                params: { source: 'loft_1', count: 3, angle: 360, axis: 'z' } as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['helix_frenet']
            },
            {
                id: 'mir_helix',
                name: 'Helix mirror',
                type: 'mirror',
                body: 'b1',
                params: { source: 'helix_1', plane: 'XZ' } as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['helix_frenet']
            }
        );
        const script = generatePythonScript(doc);
        // Loft source: re-derived in section order, additive op.
        expect(script).toContain('_tool_pat_loft = bd.loft([sketch_Loft_A_sk_lo_a(), sketch_Loft_B_sk_lo_b()], ruled=True)');
        expect(script).toContain('body_Transition = body_Transition + _tool_pat_loft.rotate(bd.Axis.Z, _k * 120)');
        // Helical sweep source: the helix lines precede the tool assignment.
        expect(script).toContain('_helix_helix_1 = bd.Helix(');
        expect(script).toContain(
            'body_Transition = body_Transition + bd.sweep(sketch_Spring_section_sk_sec().moved(' +
                '_sweep_plane_helix_1.location * datum_XY_xy.location.inverse), path=_helix_helix_1).mirror(bd.Plane.XZ)'
        );
    });

    it('matches the snapshot for the loft/helicalSweep document', () => {
        expect(generatePythonScript(loftHelixDocument())).toMatchSnapshot();
    });
});

describe('generatePythonScript ellipse/B-spline emission', () => {
    function curvesDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'curves',
            parameters: {},
            datums: [{ id: 'dxy', kind: 'XY', name: 'XY' }],
            bodies: [{ id: 'b1', name: 'B1' }],
            sketches: [
                {
                    id: 'sk_ellipse',
                    name: 'Ellipse',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 'ec', type: 'point', x: 1, y: 2 },
                        { id: 'ef', type: 'point', x: 4, y: 2 },
                        { id: 'e1', type: 'ellipse', c_id: 'ec', focus1_id: 'ef', radmin: 4 }
                    ]
                },
                {
                    id: 'sk_mixed',
                    name: 'Mixed',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 'm1', type: 'point', x: 0, y: 0 },
                        { id: 'm2', type: 'point', x: 10, y: 0 },
                        { id: 'm3', type: 'point', x: 10, y: 10 },
                        { id: 'm4', type: 'point', x: 5, y: 15 },
                        { id: 'm5', type: 'point', x: 0, y: 10 },
                        { id: 'ml1', type: 'line', p1_id: 'm1', p2_id: 'm2' },
                        { id: 'ml2', type: 'line', p1_id: 'm2', p2_id: 'm3' },
                        {
                            id: 'mb1',
                            type: 'bspline',
                            pole_ids: ['m3', 'm4', 'm5'],
                            weights: [1, 1, 1],
                            knots: [0, 1],
                            mult: [3, 3],
                            degree: 2,
                            periodic: false
                        },
                        { id: 'ml3', type: 'line', p1_id: 'm5', p2_id: 'm1' }
                    ]
                },
                {
                    id: 'sk_pure',
                    name: 'PureBSpline',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 's1', type: 'point', x: 0, y: 0 },
                        { id: 's2', type: 'point', x: 5, y: 8 },
                        { id: 's3', type: 'point', x: 10, y: 0 },
                        {
                            id: 'sb1',
                            type: 'bspline',
                            pole_ids: ['s1', 's2', 's3'],
                            weights: [1, 1, 1],
                            knots: [0, 1],
                            mult: [3, 3],
                            degree: 2,
                            periodic: false
                        }
                    ]
                },
                {
                    id: 'sk_periodic',
                    name: 'Periodic',
                    datumId: 'dxy',
                    constraints: [],
                    primitives: [
                        { id: 'q1', type: 'point', x: 0, y: 0 },
                        { id: 'q2', type: 'point', x: 5, y: 8 },
                        { id: 'q3', type: 'point', x: 10, y: 0 },
                        {
                            id: 'qb1',
                            type: 'bspline',
                            pole_ids: ['q1', 'q2', 'q3'],
                            weights: [1, 1, 1],
                            knots: [0, 1],
                            mult: [3, 3],
                            degree: 2,
                            periodic: true
                        }
                    ]
                }
            ],
            features: [
                {
                    id: 'pad_1',
                    name: 'Pad',
                    type: 'pad',
                    body: 'b1',
                    sketchId: 'sk_mixed',
                    params: { length: 2 } as FeatureDef['params'],
                    suppressed: false,
                    dependsOn: []
                }
            ],
            curves: []
        };
    }

    it('emits an ellipse via analytic axes under bd.Locations', () => {
        const script = generatePythonScript(curvesDocument());
        // center (1,2), focus (4,2): major = 5 (3-4-5), minor = 4, rotation 0.
        expect(script).toContain('with bd.Locations((1, 2)):');
        expect(script).toContain('bd.Ellipse(5, 4, rotation=0)');
    });

    it('emits a mixed line/B-spline loop as an explicit make_face edge list', () => {
        const script = generatePythonScript(curvesDocument());
        expect(script).toContain('bd.make_face([');
        expect(script).toContain('bd.Line((0, 0), (10, 0)),');
        expect(script).toContain('_bspline_edge([(10, 10), (5, 15), (0, 10)], [0, 1], [3, 3], 2),');
        // The B-spline loop must not use the BuildLine capture pattern.
        const mixedStart = script.indexOf('def sketch_Mixed_sk_mixed():');
        const mixedEnd = script.indexOf('def sketch_PureBSpline_sk_pure():');
        const mixedBody = script.slice(mixedStart, mixedEnd);
        expect(mixedBody).not.toContain('with bd.BuildLine():');
        expect(mixedBody).not.toContain('bd.make_face()');
    });

    it('emits the _bspline_edge helper exactly once at module level', () => {
        const script = generatePythonScript(curvesDocument());
        const occurrences = script.split('\n').filter((line) => line.startsWith('def _bspline_edge('));
        expect(occurrences).toHaveLength(1);
        expect(script.indexOf('def _bspline_edge(')).toBeLessThan(script.indexOf('def sketch_Mixed_sk_mixed():'));
        expect(script).not.toContain('bd.Spline(*');
    });

    it('marks a periodic B-spline sketch as manually unbuildable', () => {
        const script = generatePythonScript(curvesDocument());
        expect(script).toContain('# TODO(manual): sketch "Periodic" has no exportable solved geometry.');
    });

    it('classifies an ellipse inside a loop as a hole with SUBTRACT mode', () => {
        const doc = curvesDocument();
        doc.sketches.push({
            id: 'sk_hole',
            name: 'Hole',
            datumId: 'dxy',
            constraints: [],
            primitives: [
                { id: 'h1', type: 'point', x: 0, y: 0 },
                { id: 'h2', type: 'point', x: 20, y: 0 },
                { id: 'h3', type: 'point', x: 20, y: 20 },
                { id: 'h4', type: 'point', x: 0, y: 20 },
                { id: 'hl1', type: 'line', p1_id: 'h1', p2_id: 'h2' },
                { id: 'hl2', type: 'line', p1_id: 'h2', p2_id: 'h3' },
                { id: 'hl3', type: 'line', p1_id: 'h3', p2_id: 'h4' },
                { id: 'hl4', type: 'line', p1_id: 'h4', p2_id: 'h1' },
                { id: 'hc', type: 'point', x: 10, y: 10 },
                { id: 'hf', type: 'point', x: 13, y: 10 },
                { id: 'he', type: 'ellipse', c_id: 'hc', focus1_id: 'hf', radmin: 4 }
            ]
        });
        doc.features.push({
            id: 'pad_2',
            name: 'Pad hole',
            type: 'pad',
            body: 'b1',
            sketchId: 'sk_hole',
            params: { length: 1 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: []
        });
        const script = generatePythonScript(doc);
        const holeStart = script.indexOf('def sketch_Hole_sk_hole():');
        const holeBody = script.slice(holeStart);
        expect(holeBody).toContain('bd.Ellipse(5, 4, rotation=0, mode=bd.Mode.SUBTRACT)');
    });
});

function extendedDocument(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'extended export',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [{ id: 'b1', name: 'B1' }],
        sketches: [
            {
                id: 'sk1',
                name: 'Square',
                datumId: 'datum-xy',
                constraints: [],
                primitives: [
                    { id: 'p1', type: 'point', x: 0, y: 0 },
                    { id: 'p2', type: 'point', x: 2, y: 0 },
                    { id: 'p3', type: 'point', x: 2, y: 1 },
                    { id: 'p4', type: 'point', x: 0, y: 1 },
                    { id: 'l1', type: 'line', p1_id: 'p1', p2_id: 'p2' },
                    { id: 'l2', type: 'line', p1_id: 'p2', p2_id: 'p3' },
                    { id: 'l3', type: 'line', p1_id: 'p3', p2_id: 'p4' },
                    { id: 'l4', type: 'line', p1_id: 'p4', p2_id: 'p1' }
                ]
            }
        ],
        features: [
            {
                id: 'pad1',
                name: 'Base',
                type: 'pad',
                body: 'b1',
                sketchId: 'sk1',
                params: { length: 2 } as FeatureDef['params'],
                suppressed: false,
                dependsOn: []
            }
        ],
        curves: []
    };
}

function pushExtendedFeature(doc: NukeCadDocument, feature: FeatureDef): void {
    doc.features.push(feature);
}

describe('generatePythonScript extended feature emission', () => {
    it('emits blind pads as today and twoSided pads with both=True', () => {
        const doc = extendedDocument();
        const script = generatePythonScript(doc);
        expect(script).toContain('body_B1 = body_B1 + bd.extrude(sketch_Square_sk1(), amount=2) if body_B1 is not None else bd.extrude(');

        const twoSided = extendedDocument();
        (twoSided.features[0].params as Record<string, unknown>).twoSided = true;
        const twoSidedScript = generatePythonScript(twoSided);
        expect(twoSidedScript).toContain('amount=2 / 2');
        expect(twoSidedScript).toContain('both=True');
    });

    it('degrades non-blind extrude ends to TODO(manual)', () => {
        for (const end of ['upToFirst', 'upToLast', 'throughAll']) {
            const doc = extendedDocument();
            (doc.features[0].params as Record<string, unknown>).end = end;
            const script = generatePythonScript(doc);
            expect(script).toContain('# TODO(manual): pad feature "Base"');
            expect(script).not.toContain('bd.extrude');
        }
        const faceEnd = extendedDocument();
        (faceEnd.features[0].params as Record<string, unknown>).end = 'upToFace';
        (faceEnd.features[0].params as Record<string, unknown>).upToFace = {
            featureId: 'pad1',
            kind: 'face',
            fingerprint: { surfaceType: 'plane', area: 2, center: [0, 0, 2], normal: [0, 0, 1] }
        };
        expect(generatePythonScript(faceEnd)).toContain('# TODO(manual): pad feature "Base"');
    });

    it('degrades new datum kinds to TODO(manual) and hatches sketches placed on them', () => {
        const doc = extendedDocument();
        doc.datums.push({
            id: 'd3',
            kind: 'threePoint',
            name: 'Three',
            points: [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0]
            ]
        });
        doc.sketches[0].datumId = 'd3';
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): datum "Three" (threePoint datum)');
        expect(script).toContain('# TODO(manual): sketch "Square" is on a threePoint datum');
        expect(script).toContain('# TODO(manual): pad feature "Base"');
    });

    it('emits exact bd.* primitives on the datum workplane', () => {
        const cases: [string, number[], string][] = [
            ['box', [2, 3, 4], 'bd.Box(2, 3, 4).moved(datum_XY_datum_xy.location)'],
            ['cylinder', [1, 5], 'bd.Cylinder(1, 5, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)).moved('],
            ['sphere', [2], 'bd.Sphere(2).moved(datum_XY_datum_xy.location)'],
            ['cone', [1, 5], 'bd.Cone(1, 0, 5, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN)).moved('],
            ['torus', [5, 1], 'bd.Torus(5, 1).moved(datum_XY_datum_xy.location)']
        ];
        for (const [shape, dimensions, snippet] of cases) {
            const doc = extendedDocument();
            doc.features.length = 0;
            pushExtendedFeature(doc, {
                id: 'prim1',
                name: 'Prim',
                type: 'primitive',
                body: 'b1',
                params: { shape, dimensions } as FeatureDef['params'],
                suppressed: false,
                dependsOn: []
            });
            const script = generatePythonScript(doc);
            expect(script).toContain(`body_B1 = body_B1 + ${snippet}`);
        }
    });

    it('hatches primitives on reference-dependent datums', () => {
        const doc = extendedDocument();
        doc.features.length = 0;
        doc.datums.push({
            id: 'df',
            kind: 'face',
            name: 'Face',
            reference: {
                featureId: 'pad1',
                kind: 'face',
                fingerprint: { surfaceType: 'plane', area: 2, center: [0, 0, 0], normal: [0, 0, 1] }
            }
        });
        pushExtendedFeature(doc, {
            id: 'prim1',
            name: 'Prim',
            type: 'primitive',
            body: 'b1',
            params: { shape: 'sphere', dimensions: [1], datumId: 'df' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: []
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): primitive feature "Prim"');
        expect(script).not.toContain('bd.Sphere');
    });

    it('emits scaled patterns through the bbox-center helper', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'lin1',
            name: 'Scaled rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'pad1', count: 3, spacing: 4, axis: 'x', scale: 2 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('def _scaled_about_center(shape, factor):');
        expect(script).toContain('center = shape.bounding_box().center()');
        expect(script).toContain('_scaled_about_center(_tool_lin1.moved(bd.Location((4 * _k, 0 * _k, 0 * _k))), 2)');
    });

    it('leaves unit-scale patterns byte-identical (no helper)', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'lin1',
            name: 'Rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'pad1', count: 2, spacing: 4, axis: 'x', scale: 1 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).not.toContain('_scaled_about_center');
        expect(script).toContain('body_B1 = body_B1 + _tool_lin1.moved(bd.Location((4 * _k, 0 * _k, 0 * _k)))');
    });

    it('emits a static axis for circular patterns on a line2Point datum', () => {
        const doc = extendedDocument();
        doc.datums.push({
            id: 'dl',
            kind: 'line2Point',
            name: 'Axis',
            points: [
                [1, 0, 0],
                [1, 0, 5]
            ]
        });
        pushExtendedFeature(doc, {
            id: 'circ1',
            name: 'Around',
            type: 'circularPattern',
            body: 'b1',
            params: { source: 'pad1', count: 4, axisDatumId: 'dl' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): datum "Axis" (line2Point datum)');
        expect(script).toContain('_tool_circ1.rotate(bd.Axis((1, 0, 0), (0, 0, 1)), _k * 90)');
    });

    it('emits a static plane for mirrors on a threePoint datum', () => {
        const doc = extendedDocument();
        doc.datums.push({
            id: 'd3',
            kind: 'threePoint',
            name: 'Three',
            points: [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0]
            ]
        });
        pushExtendedFeature(doc, {
            id: 'mir1',
            name: 'Flip',
            type: 'mirror',
            body: 'b1',
            params: { source: 'pad1', planeDatumId: 'd3' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('.mirror(bd.Plane((0, 0, 0), z_dir=(0, 0, 1)))');
    });

    it('emits primitive sources re-derived with instance transforms for linear patterns', () => {
        const doc = extendedDocument();
        doc.features.length = 0;
        pushExtendedFeature(doc, {
            id: 'prim1',
            name: 'Prim',
            type: 'primitive',
            body: 'b1',
            params: { shape: 'box', dimensions: [2, 3, 4] } as FeatureDef['params'],
            suppressed: false,
            dependsOn: []
        });
        pushExtendedFeature(doc, {
            id: 'linprim',
            name: 'Prim rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'prim1', count: 3, spacing: 4, axis: 'x' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['prim1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('_tool_linprim = bd.Box(2, 3, 4).moved(datum_XY_datum_xy.location)  # source: Prim');
        expect(script).toContain('for _k in range(1, 3):');
        expect(script).toContain('body_B1 = body_B1 + _tool_linprim.moved(bd.Location((4 * _k, 0 * _k, 0 * _k)))');
        expect(script).not.toContain('# TODO(manual): linearPattern feature "Prim rows"');
    });

    it('emits primitive sources re-derived with instance transforms for circular patterns', () => {
        const doc = extendedDocument();
        doc.features.length = 0;
        pushExtendedFeature(doc, {
            id: 'prim1',
            name: 'Prim',
            type: 'primitive',
            body: 'b1',
            params: { shape: 'cylinder', dimensions: [1, 5] } as FeatureDef['params'],
            suppressed: false,
            dependsOn: []
        });
        pushExtendedFeature(doc, {
            id: 'circprim',
            name: 'Prim ring',
            type: 'circularPattern',
            body: 'b1',
            params: { source: 'prim1', count: 3, angle: 360, axis: 'z' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['prim1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('_tool_circprim = bd.Cylinder(1, 5, align=(bd.Align.CENTER, bd.Align.CENTER, bd.Align.MIN))');
        expect(script).toContain('body_B1 = body_B1 + _tool_circprim.rotate(bd.Axis.Z, _k * 120)');
        expect(script).not.toContain('# TODO(manual): circularPattern feature "Prim ring"');
    });

    it('emits rectangular lattices as row/col loops with label comments', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'lat1',
            name: 'Pins',
            type: 'lattice',
            body: 'b1',
            params: { source: 'pad1', latticeType: 'rectangular', rows: 2, cols: 2, pitch: 10 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('_tool_lat1 = bd.extrude(sketch_Square_sk1(), amount=2)  # source: Base');
        expect(script).toContain('# cells Base_r0c0 through Base_r1c1 (row-major, odd-r)');
        expect(script).toContain('for _r in range(2):');
        expect(script).toContain('for _c in range(2):');
        expect(script).toContain(
            'body_B1 = body_B1 + _tool_lat1.moved(datum_XY_datum_xy.location * bd.Location(((_c - 0.5) * 10 + 0, (_r - 0.5) * 10 + 0, 0)))  # Pins'
        );
        expect(script).not.toContain('# TODO(manual): lattice feature "Pins"');
    });

    it('emits hexagonal ring lattices as axial loops', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'lat1',
            name: 'Hex pins',
            type: 'lattice',
            body: 'b1',
            params: { source: 'pad1', latticeType: 'hexagonal', rings: 1, pitch: 10 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('# cells Base_r<row>c<col> (axial enumeration, odd-r)');
        expect(script).toContain('for _q in range(-1, 2):');
        expect(script).toContain('for _r in range(max(-1, -_q - 1), min(1, -_q + 1) + 1):');
        expect(script).toContain('17.32050807568877 * (_q + _r / 2) + 0');
        expect(script).toContain('15 * _r + 0');
        expect(script).not.toContain('# TODO(manual): lattice feature "Hex pins"');
    });

    it('emits scaled lattices through the bbox-center helper', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'lat1',
            name: 'Big pins',
            type: 'lattice',
            body: 'b1',
            params: { source: 'pad1', latticeType: 'rectangular', rows: 1, cols: 2, pitch: 10, scale: 2 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('def _scaled_about_center(shape, factor):');
        expect(script).toContain('_scaled_about_center(_tool_lat1.moved(');
        expect(script).toContain(', 2)  # Big pins');
    });

    it('degrades nested lattices and mixed extents to TODO(manual), never faked', () => {
        const nested = extendedDocument();
        pushExtendedFeature(nested, {
            id: 'lat1',
            name: 'Pins',
            type: 'lattice',
            body: 'b1',
            params: { source: 'pad1', latticeType: 'rectangular', rows: 1, cols: 2, pitch: 10 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        pushExtendedFeature(nested, {
            id: 'lat2',
            name: 'Nested',
            type: 'lattice',
            body: 'b1',
            params: { source: 'lat1', latticeType: 'rectangular', rows: 1, cols: 2, pitch: 10 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['lat1']
        });
        expect(generatePythonScript(nested)).toContain('# TODO(manual): lattice feature "Nested"');

        const mixed = extendedDocument();
        pushExtendedFeature(mixed, {
            id: 'lat1',
            name: 'Mixed',
            type: 'lattice',
            body: 'b1',
            params: { source: 'pad1', latticeType: 'hexagonal', rows: 2, cols: 2, rings: 1, pitch: 10 } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const mixedScript = generatePythonScript(mixed);
        expect(mixedScript).toContain('# TODO(manual): lattice feature "Mixed"');
        expect(mixedScript).not.toContain('_tool_lat1');
    });

    it('hatches multiTransform, defeature, and taper/drill-point holes with their params', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'lin1',
            name: 'Rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'pad1', count: 2, spacing: 4, axis: 'x' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        pushExtendedFeature(doc, {
            id: 'mt1',
            name: 'Combined',
            type: 'multiTransform',
            body: 'b1',
            params: { first: 'lin1', second: 'lin1' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['lin1']
        });
        pushExtendedFeature(doc, {
            id: 'def1',
            name: 'Clean',
            type: 'defeature',
            body: 'b1',
            params: {
                faces: [
                    {
                        featureId: 'pad1',
                        kind: 'face',
                        fingerprint: { surfaceType: 'plane', area: 2, center: [0, 0, 2], normal: [0, 0, 1] }
                    }
                ]
            } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        pushExtendedFeature(doc, {
            id: 'hole1',
            name: 'Mounting hole',
            type: 'hole',
            body: 'b1',
            params: {
                face: {
                    featureId: 'pad1',
                    kind: 'face',
                    fingerprint: { surfaceType: 'plane', area: 2, center: [0, 0, 2], normal: [0, 0, 1] }
                },
                center: [0.5, 0.5],
                diameter: 0.2,
                taperAngle: 5,
                drillPointAngle: 118
            } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): multiTransform feature "Combined"');
        expect(script).toContain('# TODO(manual): defeature feature "Clean"');
        expect(script).toContain('# TODO(manual): hole feature "Mounting hole"');
        expect(script).toContain('#   taperAngle: 5');
        expect(script).toContain('#   drillPointAngle: 118');
    });
});

describe('generatePythonScript emission', () => {
    it('emits blind revolves as today and hatches throughAll revolves', () => {
        for (const params of [
            { axis: 'x', angle: 180 },
            { axis: 'x', angle: 180, end: 'blind' }
        ]) {
            const doc = extendedDocument();
            pushExtendedFeature(doc, {
                id: 'rev1',
                name: 'Spin',
                type: 'revolve',
                body: 'b1',
                sketchId: 'sk1',
                params: params as FeatureDef['params'],
                suppressed: false,
                dependsOn: ['pad1']
            });
            const script = generatePythonScript(doc);
            expect(script).toContain('bd.revolve(sketch_Square_sk1(), axis=bd.Axis.X, revolution_arc=180)');
            expect(script).not.toContain('# TODO(manual): revolve feature "Spin"');
        }

        const through = extendedDocument();
        pushExtendedFeature(through, {
            id: 'rev1',
            name: 'Spin',
            type: 'revolve',
            body: 'b1',
            sketchId: 'sk1',
            params: { axis: 'x', angle: 180, end: 'throughAll' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const throughScript = generatePythonScript(through);
        expect(throughScript).toContain('# TODO(manual): revolve feature "Spin"');
        expect(throughScript).not.toContain('bd.revolve');
    });

    it('hatches pads with upToBody (reference-dependent, never faked)', () => {
        const doc = extendedDocument();
        (doc.features[0].params as Record<string, unknown>).end = 'upToLast';
        (doc.features[0].params as Record<string, unknown>).upToBody = 'b1';
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): pad feature "Base"');
        expect(script).not.toContain('bd.extrude');
    });

    it('cuts subtractive primitives and helical sweeps instead of merging them', () => {
        const doc = extendedDocument();
        doc.features.length = 0;
        pushExtendedFeature(doc, {
            id: 'prim1',
            name: 'Cutout',
            type: 'primitive',
            body: 'b1',
            params: { shape: 'box', dimensions: [2, 3, 4], subtractive: true } as FeatureDef['params'],
            suppressed: false,
            dependsOn: []
        });
        pushExtendedFeature(doc, {
            id: 'hx1',
            name: 'Thread cut',
            type: 'helicalSweep',
            body: 'b1',
            sketchId: 'sk1',
            params: {
                axis: 'Z',
                startRadius: 2,
                pitch: 1,
                turns: 3,
                orientation: 'frenet',
                subtractive: true
            } as FeatureDef['params'],
            suppressed: false,
            dependsOn: []
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('body_B1 = body_B1 - bd.Box(2, 3, 4).moved(datum_XY_datum_xy.location)');
        expect(script).toContain('body_B1 = body_B1 - bd.sweep(');
        expect(script).not.toContain('# TODO(manual): primitive feature "Cutout"');
        expect(script).not.toContain('# TODO(manual): helicalSweep feature "Thread cut"');
    });

    it('cuts pattern instances of subtractive primitive sources', () => {
        const doc = extendedDocument();
        doc.features.length = 0;
        pushExtendedFeature(doc, {
            id: 'prim1',
            name: 'Cutout',
            type: 'primitive',
            body: 'b1',
            params: { shape: 'box', dimensions: [2, 3, 4], subtractive: true } as FeatureDef['params'],
            suppressed: false,
            dependsOn: []
        });
        pushExtendedFeature(doc, {
            id: 'lin1',
            name: 'Cut rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'prim1', count: 2, spacing: 4, axis: 'x' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['prim1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('body_B1 = body_B1 - _tool_lin1.moved(bd.Location((4 * _k, 0 * _k, 0 * _k)))');
    });

    it('emits a static direction for linear patterns on a line2Point datum', () => {
        const doc = extendedDocument();
        doc.datums.push({
            id: 'dl',
            kind: 'line2Point',
            name: 'Axis',
            points: [
                [1, 0, 0],
                [1, 0, 5]
            ]
        });
        pushExtendedFeature(doc, {
            id: 'lin1',
            name: 'Rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'pad1', count: 3, spacing: 4, axisDatumId: 'dl' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('body_B1 = body_B1 + _tool_lin1.moved(bd.Location((0 * _k, 0 * _k, 4 * _k)))');
        expect(script).not.toContain('# TODO(manual): linearPattern feature "Rows"');
    });

    it('rides the datum z_dir for linear patterns on plane datums, hatching face datums', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'lin1',
            name: 'Rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'pad1', count: 3, spacing: 4, axisDatumId: 'datum-xy' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('bd.Location(datum_XY_datum_xy.z_dir * 4 * _k)');

        const faceDoc = extendedDocument();
        faceDoc.datums.push({
            id: 'df',
            kind: 'face',
            name: 'Face',
            reference: {
                featureId: 'pad1',
                kind: 'face',
                fingerprint: { surfaceType: 'plane', area: 2, center: [0, 0, 0], normal: [0, 0, 1] }
            }
        });
        pushExtendedFeature(faceDoc, {
            id: 'lin1',
            name: 'Rows',
            type: 'linearPattern',
            body: 'b1',
            params: { source: 'pad1', count: 3, spacing: 4, axisDatumId: 'df' } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        expect(generatePythonScript(faceDoc)).toContain('# TODO(manual): linearPattern feature "Rows"');
    });

    it('hatches modeled-thread holes with their params (thread tables stay Python-side)', () => {
        const doc = extendedDocument();
        pushExtendedFeature(doc, {
            id: 'hole1',
            name: 'Threaded',
            type: 'hole',
            body: 'b1',
            params: {
                face: {
                    featureId: 'pad1',
                    kind: 'face',
                    fingerprint: { surfaceType: 'plane', area: 2, center: [0, 0, 2], normal: [0, 0, 1] }
                },
                center: [0.5, 0.5],
                diameter: 0.2,
                depth: 2,
                thread: 'modeled'
            } as FeatureDef['params'],
            suppressed: false,
            dependsOn: ['pad1']
        });
        const script = generatePythonScript(doc);
        expect(script).toContain('# TODO(manual): hole feature "Threaded"');
        expect(script).toContain('#   thread: modeled');
    });
});

describe('assembly emission', () => {
    function assemblyDocument(): NukeCadDocument {
        const doc = sampleDocument();
        doc.assembly = {
            instances: [
                {
                    id: 'base',
                    part: 'body:body_a',
                    placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] }
                },
                {
                    id: 'arm',
                    part: 'body:body_b',
                    placement: { position: [5, 0, 0], orientation: [0, 0, 0, 1] }
                },
                {
                    id: 'bracket',
                    part: 'bracket.step',
                    placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] }
                },
                {
                    id: 'panel',
                    part: 'panel.nuke-cad',
                    placement: { position: [0, 0, 0], orientation: [0, 0, 0, 1] }
                }
            ],
            connectors: [
                { id: 'c-base', instanceId: 'base', origin: [1, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] },
                { id: 'c-arm', instanceId: 'arm', origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] },
                { id: 'c-bracket', instanceId: 'bracket', origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }
            ],
            mates: [
                { id: 'm1', type: 'fixed', instanceA: 'base', connectorA: 'c-base', instanceB: 'arm', connectorB: 'c-arm' },
                {
                    id: 'm2',
                    type: 'revolute',
                    instanceA: 'base',
                    connectorA: 'c-base',
                    instanceB: 'bracket',
                    connectorB: 'c-bracket'
                }
            ],
            groundedInstanceId: 'base'
        };
        return doc;
    }

    it('emits per-source builds with resolveMatePlacement-equivalent placement code', () => {
        const script = generatePythonScript(assemblyDocument());
        expect(script).toContain('# Assembly');
        expect(script).toContain('def _mate_solve(frame_a, frame_b):');
        expect(script).toContain('R = Ra.RbT');
        expect(script).toContain('bd.import_step("bracket.step")');
        expect(script).toContain('_mate_place(');
        expect(script).toContain('# mate "m1" (fixed): base -> arm (first mate wins)');
    });

    it('degrades .nuke-cad sources and their mates to TODO comments, never faked', () => {
        const script = generatePythonScript(assemblyDocument());
        expect(script).toContain('# TODO(manual): instance "panel"');
        expect(script).toContain('.nuke-cad document');
        expect(script).not.toContain('asm_panel = _mate_place(');
    });

    it('emits no assembly section for single-part documents', () => {
        const plain = sampleDocument();
        expect(plain.assembly).toBeUndefined();
        expect(generatePythonScript(plain)).not.toContain('# Assembly');
        const ungrounded = assemblyDocument();
        ungrounded.assembly!.groundedInstanceId = '';
        expect(generatePythonScript(ungrounded)).not.toContain('# Assembly');
    });

    it('emits the placement helper and a final model for a mate-free assembly', () => {
        const doc = assemblyDocument();
        doc.assembly!.mates = [];
        doc.assembly!.connectors = [];
        const script = generatePythonScript(doc);
        expect(script).toContain('def _mate_place(shape, pos, rot):');
        expect(script).toContain('model = bd.Compound(children=[asm_base, asm_arm, asm_bracket])');
    });
});

describe('import emission', () => {
    function importDocument(): NukeCadDocument {
        return {
            version: NUKE_CAD_SCHEMA_VERSION,
            name: 'import-test',
            units: 'm',
            parameters: {},
            datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY Plane' }],
            sketches: [],
            bodies: [{ id: 'body_coil', name: 'coil', label: 'coil' }],
            features: [
                {
                    id: 'import-coil',
                    name: 'coil import',
                    type: 'import',
                    body: 'body_coil',
                    params: {
                        sourcePath: './parts/coil.step',
                        sourceHash: 'a'.repeat(64),
                        sourceSize: 1234,
                        sourceFormat: 'step',
                        sourceUnit: 'm',
                        selection: { mode: 'solids', solids: [{ index: 1, signature: { faceCount: 4, volume: 2.5 } }] },
                        maxSolids: 100
                    },
                    suppressed: false,
                    dependsOn: []
                }
            ],
            curves: []
        };
    }

    it('emits a runnable source read/select/placement body instead of a TODO', () => {
        const script = generatePythonScript(importDocument());
        expect(script).toContain('def _import_body(');
        expect(script).toContain('def _place_import(');
        expect(script).toContain('_import_body("./parts/coil.step", "step", "m", "m",');
        expect(script).toContain('body_coil = _place_import(');
        expect(script).not.toContain('TODO(manual): import feature');
        expect(script).toContain('model = bd.Compound(children=[shape for shape in [body_coil] if shape is not None])');
    });
});
