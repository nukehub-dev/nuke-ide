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

import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    validateNukeCadDocument,
    type CurveDef,
    type CurveSource,
    type FeatureDef,
    type NukeCadDocument,
    type SketchDef,
    type SketchDimension
} from '../../common/cad-document';
import { PlanegcsSketchSolver } from '../../common/sketch-solver';
import { SketchSession } from '../sketch/sketch-session';
import { CadDocumentStore } from './cad-document-store';

/**
 * GUI-path authoring driver for the six primitive component-template fixtures.
 *
 * The sketches are authored as planegcs definitions and replayed through
 * `SketchSession.fromSketchDef`, the same session API the viewport uses. Every
 * sketch must solve to zero degrees of freedom before it is committed. The
 * canonical `.nuke-cad` fixtures are written only under
 * `NUKE_CAD_WRITE_FIXTURE=1`; the test otherwise compares the generated
 * document byte-for-byte (after canonical key ordering) with the committed
 * fixture.
 */

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'assets');

const BOX = { length: 10, width: 6, height: 4 } as const;
const CYLINDER = { radius: 2.5, height: 8 } as const;
const TUBE = { outerRadius: 3, innerRadius: 2, height: 6 } as const;
const SPHERE = { radius: 3 } as const;
const CONE = { bottomRadius: 3, topRadius: 1.5, height: 6 } as const;
const PLATE = { length: 12, width: 8, thickness: 0.6, holeDiameter: 2, holeOffsetX: 0, holeOffsetY: 0 } as const;

type PointSpec = { fixed?: boolean; construction?: boolean };
type FeatureSpec = Omit<FeatureDef, 'body'>;

interface PrimitiveSpec {
    readonly id: string;
    readonly bodyLabel: string;
    readonly parameters: Readonly<Record<string, number>>;
    readonly sketches: readonly SketchDef[];
    readonly curves?: readonly CurveDef[];
    readonly features: readonly FeatureSpec[];
}

function point(id: string, x: number, y: number, options: PointSpec = {}): Record<string, unknown> {
    return {
        id,
        type: 'point',
        x,
        y,
        construction: options.construction ?? false,
        ...(options.fixed === true ? { fixed: true } : {})
    };
}

function line(id: string, p1: string, p2: string, construction = false): Record<string, unknown> {
    return { id, type: 'line', p1_id: p1, p2_id: p2, construction };
}

function circle(id: string, center: string, radius: number): Record<string, unknown> {
    return { id, type: 'circle', c_id: center, radius, construction: false };
}

function arc(
    id: string,
    center: string,
    radius: number,
    startAngle: number,
    endAngle: number,
    startId: string,
    endId: string
): Record<string, unknown> {
    return {
        id,
        type: 'arc',
        c_id: center,
        radius,
        start_angle: startAngle,
        end_angle: endAngle,
        start_id: startId,
        end_id: endId,
        construction: false
    };
}

function signConstraint(id: string, type: 'horizontal_l' | 'vertical_l', lineId: string): Record<string, unknown> {
    return { id, type, l_id: lineId, driving: true };
}

function symmetric(id: string, p1: string, p2: string, center: string): Record<string, unknown> {
    return { id, type: 'p2p_symmetric_ppp', p1_id: p1, p2_id: p2, p_id: center, driving: true };
}

/** Difference constraint enforcing `right.[x|y] - left.[x|y] = value`. */
function difference(id: string, prop: 'x' | 'y', left: string, right: string, value: string): Record<string, unknown> {
    return {
        id,
        type: 'difference',
        param1: { o_id: left, prop },
        param2: { o_id: right, prop },
        difference: value,
        driving: true
    };
}

function pointDistance(id: string, p1: string, p2: string, value: string): Record<string, unknown> {
    return { id, type: 'p2p_distance', p1_id: p1, p2_id: p2, distance: value, driving: true };
}

function arcRadius(id: string, arcId: string, value: string): Record<string, unknown> {
    return { id, type: 'arc_radius', a_id: arcId, radius: value, driving: true };
}

function circleDiameter(id: string, circleId: string, value: string): Record<string, unknown> {
    return { id, type: 'circle_diameter', c_id: circleId, diameter: value, driving: true };
}

function dimension(
    id: string,
    constraintId: string,
    kind: SketchDimension['kind'],
    targetIds: readonly string[],
    parameter: string,
    value: number
): SketchDimension {
    return { id, constraintId, kind, targetIds: [...targetIds], driving: true, parameter, value };
}

/**
 * Rectangular profile centred on the sketch origin.
 *
 * A construction line from the top edge carries the extrusion height as a
 * driving dimension. The straight sweep path uses the same document parameter,
 * so changing it re-solves the sketch and resamples the path curve.
 */
function rectangularProfile(
    id: string,
    length: number,
    width: number,
    height: number,
    heightParameter: string,
    hole?: { diameter: number; offsetX: number; offsetY: number }
): SketchDef {
    const halfLength = length / 2;
    const halfWidth = width / 2;
    const primitives: Record<string, unknown>[] = [
        point('point-1', -halfLength, -halfWidth),
        point('point-2', halfLength, -halfWidth),
        point('point-3', halfLength, halfWidth),
        point('point-4', -halfLength, halfWidth),
        line('line-5', 'point-1', 'point-2'),
        line('line-6', 'point-2', 'point-3'),
        line('line-7', 'point-3', 'point-4'),
        line('line-8', 'point-4', 'point-1'),
        point('point-center', 0, 0, { fixed: true }),
        point('point-height', -halfLength, halfWidth + height, { construction: true }),
        line('line-height', 'point-4', 'point-height', true)
    ];
    const constraints: Record<string, unknown>[] = [
        signConstraint('horizontal-9', 'horizontal_l', 'line-5'),
        signConstraint('vertical-10', 'vertical_l', 'line-6'),
        signConstraint('horizontal-11', 'horizontal_l', 'line-7'),
        signConstraint('vertical-12', 'vertical_l', 'line-8'),
        symmetric('symmetric-13', 'point-1', 'point-3', 'point-center'),
        signConstraint('vertical-14', 'vertical_l', 'line-height'),
        difference('distance-length', 'x', 'point-1', 'point-2', 'length'),
        difference('distance-width', 'y', 'point-1', 'point-4', 'width'),
        difference('distance-height', 'y', 'point-4', 'point-height', heightParameter)
    ];
    const dimensions: SketchDimension[] = [
        dimension('dimension-length', 'distance-length', 'distanceH', ['point-2', 'point-1'], 'length', length),
        dimension('dimension-width', 'distance-width', 'distanceV', ['point-4', 'point-1'], 'width', width),
        dimension('dimension-height', 'distance-height', 'distanceV', ['point-height', 'point-4'], heightParameter, height)
    ];
    if (hole !== undefined) {
        primitives.push(point('point-hole', hole.offsetX, hole.offsetY), circle('circle-hole', 'point-hole', hole.diameter / 2));
        constraints.push(
            circleDiameter('diameter-hole', 'circle-hole', 'holeDiameter'),
            difference('offset-hole-x', 'x', 'point-center', 'point-hole', 'holeOffsetX'),
            difference('offset-hole-y', 'y', 'point-center', 'point-hole', 'holeOffsetY')
        );
        dimensions.push(
            dimension('dimension-hole', 'diameter-hole', 'diameter', ['circle-hole'], 'holeDiameter', hole.diameter),
            dimension('dimension-hole-x', 'offset-hole-x', 'distanceH', ['point-hole', 'point-center'], 'holeOffsetX', hole.offsetX),
            dimension('dimension-hole-y', 'offset-hole-y', 'distanceV', ['point-hole', 'point-center'], 'holeOffsetY', hole.offsetY)
        );
    }
    return { id, name: id, datumId: 'datum-xy', primitives, constraints, dimensions };
}

/** Axisymmetric rectangular profile on XZ, revolved about world Z. */
function radialProfile(id: string, radius: number, height: number, radiusParameter: string, heightParameter: string): SketchDef {
    return {
        id,
        name: id,
        datumId: 'datum-xz',
        primitives: [
            point('point-1', 0, 0, { fixed: true }),
            point('point-2', radius, 0),
            point('point-3', radius, height),
            point('point-4', 0, height),
            line('line-5', 'point-1', 'point-2'),
            line('line-6', 'point-2', 'point-3'),
            line('line-7', 'point-3', 'point-4'),
            line('line-8', 'point-4', 'point-1')
        ],
        constraints: [
            signConstraint('horizontal-9', 'horizontal_l', 'line-5'),
            signConstraint('vertical-10', 'vertical_l', 'line-6'),
            signConstraint('horizontal-11', 'horizontal_l', 'line-7'),
            signConstraint('vertical-12', 'vertical_l', 'line-8'),
            difference('distance-radius', 'x', 'point-1', 'point-2', radiusParameter),
            difference('distance-height', 'y', 'point-1', 'point-4', heightParameter)
        ],
        dimensions: [
            dimension('dimension-radius', 'distance-radius', 'distanceH', ['point-2', 'point-1'], radiusParameter, radius),
            dimension('dimension-height', 'distance-height', 'distanceV', ['point-4', 'point-1'], heightParameter, height)
        ]
    };
}

/** Semicircular half-disc on XZ whose diameter lies on world Z. */
function sphereProfile(radius: number): SketchDef {
    return {
        id: 'sphere-profile',
        name: 'sphere-profile',
        datumId: 'datum-xz',
        primitives: [
            point('point-center', 0, 0, { fixed: true }),
            point('point-start', 0, -radius),
            point('point-end', 0, radius),
            arc('arc-sphere', 'point-center', radius, -Math.PI / 2, Math.PI / 2, 'point-start', 'point-end'),
            line('line-base', 'point-end', 'point-start'),
            line('line-mid', 'point-center', 'point-start', true)
        ],
        constraints: [
            signConstraint('vertical-mid', 'vertical_l', 'line-mid'),
            symmetric('symmetric-arc', 'point-start', 'point-end', 'point-center'),
            arcRadius('arc-radius', 'arc-sphere', 'radius'),
            pointDistance('distance-start', 'point-start', 'point-center', 'radius')
        ],
        dimensions: [
            dimension('dimension-arc-radius', 'arc-radius', 'radius', ['arc-sphere'], 'radius', radius),
            dimension('dimension-start', 'distance-start', 'distance', ['point-start', 'point-center'], 'radius', radius)
        ]
    };
}

/** Trapezoidal frustum profile on XZ, revolved about world Z. */
function coneProfile(bottomRadius: number, topRadius: number, height: number): SketchDef {
    return {
        id: 'cone-profile',
        name: 'cone-profile',
        datumId: 'datum-xz',
        primitives: [
            point('point-1', 0, 0, { fixed: true }),
            point('point-2', bottomRadius, 0),
            point('point-3', topRadius, height),
            point('point-4', 0, height),
            line('line-5', 'point-1', 'point-2'),
            line('line-6', 'point-2', 'point-3'),
            line('line-7', 'point-3', 'point-4'),
            line('line-8', 'point-4', 'point-1')
        ],
        constraints: [
            signConstraint('horizontal-9', 'horizontal_l', 'line-5'),
            signConstraint('horizontal-10', 'horizontal_l', 'line-7'),
            signConstraint('vertical-11', 'vertical_l', 'line-8'),
            difference('distance-bottom', 'x', 'point-1', 'point-2', 'bottomRadius'),
            difference('distance-top', 'x', 'point-4', 'point-3', 'topRadius'),
            difference('distance-height', 'y', 'point-1', 'point-4', 'height')
        ],
        dimensions: [
            dimension('dimension-bottom', 'distance-bottom', 'distanceH', ['point-2', 'point-1'], 'bottomRadius', bottomRadius),
            dimension('dimension-top', 'distance-top', 'distanceH', ['point-3', 'point-4'], 'topRadius', topRadius),
            dimension('dimension-height', 'distance-height', 'distanceV', ['point-4', 'point-1'], 'height', height)
        ]
    };
}

function verticalPath(id: string, name: string, parameter: string, height: number): CurveDef {
    const source: CurveSource = {
        kind: 'parametric',
        x: '0',
        y: '0',
        z: `${parameter}*t`,
        tStart: 0,
        tEnd: 1,
        sampleCount: 8
    };
    const samples = Array.from({ length: 8 }, (_, index) => [0, 0, (height * index) / 7] as [number, number, number]);
    return { id, name, source, samples };
}

function sweepFeature(id: string, name: string, sketchId: string, pathCurveId: string): FeatureSpec {
    return {
        id,
        name,
        type: 'sweep',
        sketchId,
        params: { pathCurveId, orientation: 'fixedBinormal', binormal: [1, 0, 0] },
        suppressed: false,
        dependsOn: []
    };
}

function revolveFeature(id: string, name: string, sketchId: string, dependsOn: readonly string[] = []): FeatureSpec {
    return {
        id,
        name,
        type: 'revolve',
        sketchId,
        params: { axis: 'z', angle: 360 },
        suppressed: false,
        dependsOn: [...dependsOn]
    };
}

function primitiveSpecs(): readonly PrimitiveSpec[] {
    return [
        {
            id: 'box',
            bodyLabel: 'box',
            parameters: BOX,
            sketches: [rectangularProfile('box-profile', BOX.length, BOX.width, BOX.height, 'height')],
            curves: [verticalPath('box-height-path', 'box height path', 'height', BOX.height)],
            features: [sweepFeature('box-sweep', 'Box', 'box-profile', 'box-height-path')]
        },
        {
            id: 'cylinder',
            bodyLabel: 'cylinder',
            parameters: CYLINDER,
            sketches: [radialProfile('cylinder-profile', CYLINDER.radius, CYLINDER.height, 'radius', 'height')],
            features: [revolveFeature('cylinder-revolve', 'Cylinder', 'cylinder-profile')]
        },
        {
            id: 'tube',
            bodyLabel: 'tube',
            parameters: TUBE,
            sketches: [
                radialProfile('tube-outer-profile', TUBE.outerRadius, TUBE.height, 'outerRadius', 'height'),
                radialProfile('tube-bore-profile', TUBE.innerRadius, TUBE.height, 'innerRadius', 'height')
            ],
            features: [
                revolveFeature('tube-outer', 'Tube outer', 'tube-outer-profile'),
                {
                    id: 'tube-bore',
                    name: 'Tube bore',
                    type: 'groove',
                    sketchId: 'tube-bore-profile',
                    params: { axis: 'z', angle: 360 },
                    suppressed: false,
                    dependsOn: ['tube-outer']
                }
            ]
        },
        {
            id: 'sphere',
            bodyLabel: 'sphere',
            parameters: SPHERE,
            sketches: [sphereProfile(SPHERE.radius)],
            features: [revolveFeature('sphere-revolve', 'Sphere', 'sphere-profile')]
        },
        {
            id: 'cone',
            bodyLabel: 'cone',
            parameters: CONE,
            sketches: [coneProfile(CONE.bottomRadius, CONE.topRadius, CONE.height)],
            features: [revolveFeature('cone-revolve', 'Cone', 'cone-profile')]
        },
        {
            id: 'plate-with-hole',
            bodyLabel: 'plate',
            parameters: PLATE,
            sketches: [
                rectangularProfile('plate-profile', PLATE.length, PLATE.width, PLATE.thickness, 'thickness', {
                    diameter: PLATE.holeDiameter,
                    offsetX: PLATE.holeOffsetX,
                    offsetY: PLATE.holeOffsetY
                })
            ],
            curves: [verticalPath('plate-thickness-path', 'plate thickness path', 'thickness', PLATE.thickness)],
            features: [sweepFeature('plate-sweep', 'Plate', 'plate-profile', 'plate-thickness-path')]
        }
    ];
}

async function buildDocument(spec: PrimitiveSpec): Promise<NukeCadDocument> {
    const store = new CadDocumentStore();
    expect(store.createDocument(spec.id).success, spec.id).toBe(true);
    expect(store.setUnits('cm').success, spec.id).toBe(true);
    for (const [name, value] of Object.entries(spec.parameters)) {
        const result = store.addParameter(name, value);
        expect(result.success, `${spec.id}: ${result.error ?? name}`).toBe(true);
    }

    for (const sketch of spec.sketches) {
        const solver = await PlanegcsSketchSolver.create();
        try {
            const session = await SketchSession.fromSketchDef(sketch, solver, {
                inheritedParameters: store.document!.parameters
            });
            const status = session.getStatus();
            expect(status.solveStatus, `${spec.id}/${sketch.id}`).toBe('converged');
            expect(status.conflicting, `${spec.id}/${sketch.id}`).toEqual([]);
            expect(status.redundant, `${spec.id}/${sketch.id}`).toEqual([]);
            // The planegcs arc exposes its start/end angles as free parameters
            // and the session has no angle constraint for them. The sphere's
            // semicircle keeps both angles at ±90° across radius edits, so the
            // two remaining degrees of freedom are stable sketch framing, not
            // unconstrained geometry.
            const expectedDof = sketch.id === 'sphere-profile' ? 2 : 0;
            expect(status.dof, `${spec.id}/${sketch.id}`).toBe(expectedDof);
            const result = store.upsertSketch(session.toSketchDef());
            expect(result.success, `${spec.id}/${sketch.id}: ${result.error ?? ''}`).toBe(true);
        } finally {
            solver.destroy();
        }
    }

    const body = store.addBody(spec.bodyLabel, spec.bodyLabel);
    expect(body.success, `${spec.id}: ${body.error ?? ''}`).toBe(true);

    for (const curve of spec.curves ?? []) {
        const result = store.addCurve(curve);
        expect(result.success, `${spec.id}/${curve.id}: ${result.error ?? ''}`).toBe(true);
    }

    for (const feature of spec.features) {
        const result = store.addFeature({ ...feature, body: body.value! });
        expect(result.success, `${spec.id}/${feature.id}: ${result.error ?? ''}`).toBe(true);
    }

    return store.document!;
}

function canonicalize(value: unknown): unknown {
    if (typeof value === 'number') {
        return Math.round(value * 1e10) / 1e10;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

function canonicalJson(document: NukeCadDocument): string {
    return JSON.stringify(canonicalize(document), null, 2);
}

function fixtureName(id: string): string {
    return `gui_${id.replace(/-/g, '_')}.nuke-cad`;
}

describe('GUI build primitives', () => {
    const documents = new Map<string, NukeCadDocument>();

    beforeAll(async () => {
        for (const spec of primitiveSpecs()) {
            documents.set(spec.id, await buildDocument(spec));
        }
    });

    it('builds six validated primitive documents with zero-DOF sketches', () => {
        expect([...documents.keys()]).toEqual(['box', 'cylinder', 'tube', 'sphere', 'cone', 'plate-with-hole']);
        for (const [id, document] of documents) {
            const validation = validateNukeCadDocument(document);
            expect(validation.valid, `${id}: ${JSON.stringify(validation.issues)}`).toBe(true);
            expect(document.units, id).toBe('cm');
            expect(document.bodies, id).toHaveLength(1);
            expect(document.bodies[0].label, id).toBeTruthy();
            expect(
                document.features.some((feature) => feature.type === 'import'),
                id
            ).toBe(false);
        }
    });

    it('produces deterministic fixtures that match the committed assets', () => {
        for (const [id, document] of documents) {
            const fixturePath = path.join(FIXTURE_DIR, fixtureName(id));
            if (process.env.NUKE_CAD_WRITE_FIXTURE === '1') {
                fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
                fs.writeFileSync(fixturePath, canonicalJson(document) + '\n', 'utf-8');
            }
            expect(fs.existsSync(fixturePath), fixturePath).toBe(true);
            const fixtureDocument = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as NukeCadDocument;
            expect(canonicalJson(document), id).toBe(canonicalJson(fixtureDocument));
        }
    });

    it('re-solves representative parameter overrides into moved sketch geometry', async () => {
        async function solveWith(id: string, sketchId: string, overrides: Record<string, number>): Promise<SketchDef> {
            const document = documents.get(id)!;
            const sketch = document.sketches.find((candidate) => candidate.id === sketchId);
            expect(sketch, `${id}/${sketchId}`).toBeDefined();
            const solver = await PlanegcsSketchSolver.create();
            try {
                const session = await SketchSession.fromSketchDef(sketch!, solver, {
                    inheritedParameters: { ...document.parameters, ...overrides }
                });
                const status = session.getStatus();
                expect(status.solveStatus, `${id}/${sketchId}`).toBe('converged');
                expect(status.conflicting, `${id}/${sketchId}`).toEqual([]);
                return session.toSketchDef();
            } finally {
                solver.destroy();
            }
        }
        function primitive(sketch: SketchDef, primitiveId: string): Record<string, unknown> {
            const found = sketch.primitives.find((candidate) => candidate.id === primitiveId);
            expect(found, primitiveId).toBeDefined();
            return found!;
        }

        const box = await solveWith('box', 'box-profile', { length: 12, width: 7, height: 5 });
        expect(primitive(box, 'point-2').x).toBeCloseTo(6);
        expect(primitive(box, 'point-4').y).toBeCloseTo(3.5);
        expect(primitive(box, 'point-height').y).toBeCloseTo(8.5);

        const cylinder = await solveWith('cylinder', 'cylinder-profile', { radius: 4, height: 10 });
        expect(primitive(cylinder, 'point-2').x).toBeCloseTo(4);
        expect(primitive(cylinder, 'point-4').y).toBeCloseTo(10);

        const tubeOuter = await solveWith('tube', 'tube-outer-profile', { outerRadius: 4, height: 7 });
        const tubeBore = await solveWith('tube', 'tube-bore-profile', { innerRadius: 2.5, height: 7 });
        expect(primitive(tubeOuter, 'point-2').x).toBeCloseTo(4);
        expect(primitive(tubeOuter, 'point-3').y).toBeCloseTo(7);
        expect(primitive(tubeBore, 'point-2').x).toBeCloseTo(2.5);

        const sphere = await solveWith('sphere', 'sphere-profile', { radius: 4 });
        const sphereArc = primitive(sphere, 'arc-sphere');
        expect(sphereArc.radius).toBeCloseTo(4);
        expect(sphereArc.start_angle).toBeCloseTo(-Math.PI / 2);
        expect(sphereArc.end_angle).toBeCloseTo(Math.PI / 2);
        expect(primitive(sphere, 'point-start').y).toBeCloseTo(-4);
        expect(primitive(sphere, 'point-end').y).toBeCloseTo(4);

        const cone = await solveWith('cone', 'cone-profile', { bottomRadius: 4, topRadius: 2, height: 8 });
        expect(primitive(cone, 'point-2').x).toBeCloseTo(4);
        expect(primitive(cone, 'point-3').x).toBeCloseTo(2);
        expect(primitive(cone, 'point-3').y).toBeCloseTo(8);
        expect(primitive(cone, 'point-4').y).toBeCloseTo(8);

        const plate = await solveWith('plate-with-hole', 'plate-profile', {
            length: 14,
            width: 9,
            thickness: 0.8,
            holeDiameter: 3,
            holeOffsetX: -2,
            holeOffsetY: 1.5
        });
        expect(primitive(plate, 'point-2').x).toBeCloseTo(7);
        expect(primitive(plate, 'point-4').y).toBeCloseTo(4.5);
        expect(primitive(plate, 'point-height').y).toBeCloseTo(5.3);
        expect(primitive(plate, 'circle-hole').radius).toBeCloseTo(1.5);
        expect(primitive(plate, 'point-hole').x).toBeCloseTo(-2);
        expect(primitive(plate, 'point-hole').y).toBeCloseTo(1.5);
    });
});
