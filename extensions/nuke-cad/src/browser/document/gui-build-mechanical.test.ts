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
 * GUI-path authoring driver for the five mechanical component-template fixtures.
 *
 * The sketches are authored as planegcs definitions and replayed through
 * `SketchSession.fromSketchDef`, the same session API the viewport uses. Every
 * sketch must solve to zero degrees of freedom before it is committed. The
 * canonical `.nuke-cad` fixtures are written only under
 * `NUKE_CAD_WRITE_FIXTURE=1`; the test otherwise compares the generated
 * document byte-for-byte (after canonical key ordering) with the committed
 * fixture.
 *
 * Circular-pattern counts are numeric-only in the document schema, so the
 * shipped bolt-hole patterns are representative fixed patterns at the default
 * count. Each count parameter still drives a real construction dimension in
 * the pattern sketch, so changing it re-solves the sketch and the creation flow
 * accepts the override; the solid keeps the default number of holes.
 */

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'assets');

const L_BRACKET = { legLength: 8, legWidth: 2.5, thickness: 0.6, holeDiameter: 0.8, holeCount: 2 } as const;
const FLANGE = { outerRadius: 6, innerRadius: 3.5, thickness: 1, boltCircleRadius: 4.8, boltHoleDiameter: 1, boltCount: 6 } as const;
const STEPPED_SHAFT = { stepRadius: 1.2, shaftRadius: 2, stepLength: 3, totalLength: 12 } as const;
const PIPE = { outerRadius: 3, boreRadius: 2.4, length: 10 } as const;
const PLATE = { radius: 5, thickness: 0.8, holeDiameter: 0.9, holeCount: 4, holeCircleRadius: 3.5 } as const;
const TEMPLATE_ONLY_PARAMETERS = new Set(['holeCount', 'boltCount']);

type PointSpec = { fixed?: boolean; construction?: boolean };
type FeatureSpec = Omit<FeatureDef, 'body'>;

interface MechanicalSpec {
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

/**
 * L-shaped equal-leg profile on XY with two through holes and a thickness
 * handle for the straight sweep. The canonical fixture ships the default
 * two-hole layout; the template's configure hook rebuilds the sketch for a
 * different creation-time hole count.
 */
function lBracketProfile(legLength: number, legWidth: number, thickness: number, holeDiameter: number): SketchDef {
    const holeRadius = holeDiameter / 2;
    const firstHole: [number, number] = [legLength / 2, legWidth / 2];
    const secondHole: [number, number] = [(legWidth + legLength) / 2, legWidth / 2];
    return {
        id: 'l-bracket-profile',
        name: 'l-bracket-profile',
        datumId: 'datum-xy',
        primitives: [
            point('point-1', 0, 0, { fixed: true }),
            point('point-2', legLength, 0),
            point('point-3', legLength, legWidth),
            point('point-4', legWidth, legWidth),
            point('point-5', legWidth, legLength),
            point('point-6', 0, legLength),
            line('line-7', 'point-1', 'point-2'),
            line('line-8', 'point-2', 'point-3'),
            line('line-9', 'point-3', 'point-4'),
            line('line-10', 'point-4', 'point-5'),
            line('line-11', 'point-5', 'point-6'),
            line('line-12', 'point-6', 'point-1'),
            point('point-height', 0, legLength + thickness, { construction: true }),
            line('line-height', 'point-6', 'point-height', true),
            point('point-hole-1', firstHole[0], firstHole[1]),
            circle('circle-hole-1', 'point-hole-1', holeRadius),
            point('point-hole-2', secondHole[0], secondHole[1]),
            circle('circle-hole-2', 'point-hole-2', holeRadius)
        ],
        constraints: [
            signConstraint('horizontal-13', 'horizontal_l', 'line-7'),
            signConstraint('vertical-14', 'vertical_l', 'line-8'),
            signConstraint('horizontal-15', 'horizontal_l', 'line-9'),
            signConstraint('vertical-16', 'vertical_l', 'line-10'),
            signConstraint('horizontal-17', 'horizontal_l', 'line-11'),
            signConstraint('vertical-18', 'vertical_l', 'line-12'),
            signConstraint('vertical-height', 'vertical_l', 'line-height'),
            difference('distance-length', 'x', 'point-1', 'point-2', 'legLength'),
            difference('distance-width', 'y', 'point-2', 'point-3', 'legWidth'),
            difference('distance-inner', 'x', 'point-1', 'point-4', 'legWidth'),
            difference('distance-upper', 'y', 'point-1', 'point-6', 'legLength'),
            difference('distance-thickness', 'y', 'point-6', 'point-height', 'thickness'),
            symmetric('symmetric-hole-1', 'point-1', 'point-3', 'point-hole-1'),
            circleDiameter('diameter-hole-1', 'circle-hole-1', 'holeDiameter'),
            symmetric('symmetric-hole-2', 'point-4', 'point-2', 'point-hole-2'),
            circleDiameter('diameter-hole-2', 'circle-hole-2', 'holeDiameter')
        ],
        dimensions: [
            dimension('dimension-length', 'distance-length', 'distanceH', ['point-2', 'point-1'], 'legLength', legLength),
            dimension('dimension-width', 'distance-width', 'distanceV', ['point-3', 'point-2'], 'legWidth', legWidth),
            dimension('dimension-inner', 'distance-inner', 'distanceH', ['point-4', 'point-1'], 'legWidth', legWidth),
            dimension('dimension-upper', 'distance-upper', 'distanceV', ['point-6', 'point-1'], 'legLength', legLength),
            dimension('dimension-thickness', 'distance-thickness', 'distanceV', ['point-height', 'point-6'], 'thickness', thickness),
            dimension('dimension-hole-1', 'diameter-hole-1', 'diameter', ['circle-hole-1'], 'holeDiameter', holeDiameter),
            dimension('dimension-hole-2', 'diameter-hole-2', 'diameter', ['circle-hole-2'], 'holeDiameter', holeDiameter)
        ]
    };
}

/** Stepped shaft profile on XZ with a smaller step at the base. */
function steppedShaftProfile(stepRadius: number, shaftRadius: number, stepLength: number, totalLength: number): SketchDef {
    return {
        id: 'stepped-shaft-profile',
        name: 'stepped-shaft-profile',
        datumId: 'datum-xz',
        primitives: [
            point('point-1', 0, 0, { fixed: true }),
            point('point-2', stepRadius, 0),
            point('point-3', stepRadius, stepLength),
            point('point-4', shaftRadius, stepLength),
            point('point-5', shaftRadius, totalLength),
            point('point-6', 0, totalLength),
            line('line-7', 'point-1', 'point-2'),
            line('line-8', 'point-2', 'point-3'),
            line('line-9', 'point-3', 'point-4'),
            line('line-10', 'point-4', 'point-5'),
            line('line-11', 'point-5', 'point-6'),
            line('line-12', 'point-6', 'point-1')
        ],
        constraints: [
            signConstraint('horizontal-13', 'horizontal_l', 'line-7'),
            signConstraint('vertical-14', 'vertical_l', 'line-8'),
            signConstraint('horizontal-15', 'horizontal_l', 'line-9'),
            signConstraint('vertical-16', 'vertical_l', 'line-10'),
            signConstraint('horizontal-17', 'horizontal_l', 'line-11'),
            signConstraint('vertical-18', 'vertical_l', 'line-12'),
            difference('distance-step-radius', 'x', 'point-1', 'point-2', 'stepRadius'),
            difference('distance-step-length', 'y', 'point-1', 'point-3', 'stepLength'),
            difference('distance-shaft-radius', 'x', 'point-1', 'point-4', 'shaftRadius'),
            difference('distance-total-length', 'y', 'point-1', 'point-5', 'totalLength')
        ],
        dimensions: [
            dimension('dimension-step-radius', 'distance-step-radius', 'distanceH', ['point-2', 'point-1'], 'stepRadius', stepRadius),
            dimension('dimension-step-length', 'distance-step-length', 'distanceV', ['point-3', 'point-1'], 'stepLength', stepLength),
            dimension('dimension-shaft-radius', 'distance-shaft-radius', 'distanceH', ['point-4', 'point-1'], 'shaftRadius', shaftRadius),
            dimension('dimension-total-length', 'distance-total-length', 'distanceV', ['point-5', 'point-1'], 'totalLength', totalLength)
        ]
    };
}

/**
 * One through-hole on the bolt circle plus a construction count dimension.
 *
 * A circular pattern consumes this sketch; the pattern count stays numeric and
 * fixed at the default, while the count parameter re-solves the construction
 * dimension so the creation flow can apply a caller override.
 */
function boltPatternSketch(
    id: string,
    holeCircleRadiusParameter: string,
    holeDiameterParameter: string,
    holeCircleRadius: number,
    holeDiameter: number
): SketchDef {
    return {
        id,
        name: id,
        datumId: 'datum-xy',
        primitives: [
            point('point-center', 0, 0, { fixed: true }),
            point('point-hole', holeCircleRadius, 0),
            line('line-hole', 'point-center', 'point-hole', true),
            circle('circle-hole', 'point-hole', holeDiameter / 2)
        ],
        constraints: [
            signConstraint('horizontal-hole', 'horizontal_l', 'line-hole'),
            difference('distance-radius', 'x', 'point-center', 'point-hole', holeCircleRadiusParameter),
            circleDiameter('diameter-hole', 'circle-hole', holeDiameterParameter)
        ],
        dimensions: [
            dimension(
                'dimension-radius',
                'distance-radius',
                'distanceH',
                ['point-hole', 'point-center'],
                holeCircleRadiusParameter,
                holeCircleRadius
            ),
            dimension('dimension-hole', 'diameter-hole', 'diameter', ['circle-hole'], holeDiameterParameter, holeDiameter)
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

function grooveFeature(id: string, name: string, sketchId: string, dependsOn: readonly string[]): FeatureSpec {
    return {
        id,
        name,
        type: 'groove',
        sketchId,
        params: { axis: 'z', angle: 360 },
        suppressed: false,
        dependsOn: [...dependsOn]
    };
}

/**
 * Axial bolt-hole cut.
 *
 * The document preflight requires a positive blind length for every pocket, so
 * the cut uses a length beyond every thickness bound in this family (60 cm:
 * flange <= 20, plate <= 50) and is through by construction. The length is
 * fixed and independent of the profile thickness parameter.
 */
function pocketFeature(id: string, name: string, sketchId: string, dependsOn: readonly string[]): FeatureSpec {
    return {
        id,
        name,
        type: 'pocket',
        sketchId,
        params: { length: 60, axis: 'z' },
        suppressed: false,
        dependsOn: [...dependsOn]
    };
}

function circularPatternFeature(id: string, name: string, source: string, count: number): FeatureSpec {
    return {
        id,
        name,
        type: 'circularPattern',
        params: { source, count, angle: 360, axis: 'z' },
        suppressed: false,
        dependsOn: [source]
    };
}

function mechanicalSpecs(): readonly MechanicalSpec[] {
    return [
        {
            id: 'l-bracket',
            bodyLabel: 'l-bracket',
            parameters: L_BRACKET,
            sketches: [lBracketProfile(L_BRACKET.legLength, L_BRACKET.legWidth, L_BRACKET.thickness, L_BRACKET.holeDiameter)],
            curves: [verticalPath('l-bracket-thickness-path', 'l-bracket thickness path', 'thickness', L_BRACKET.thickness)],
            features: [sweepFeature('l-bracket-sweep', 'L bracket', 'l-bracket-profile', 'l-bracket-thickness-path')]
        },
        {
            id: 'flange',
            bodyLabel: 'flange',
            parameters: FLANGE,
            sketches: [
                radialProfile('flange-outer-profile', FLANGE.outerRadius, FLANGE.thickness, 'outerRadius', 'thickness'),
                radialProfile('flange-bore-profile', FLANGE.innerRadius, FLANGE.thickness, 'innerRadius', 'thickness'),
                boltPatternSketch(
                    'flange-bolt-profile',
                    'boltCircleRadius',
                    'boltHoleDiameter',
                    FLANGE.boltCircleRadius,
                    FLANGE.boltHoleDiameter
                )
            ],
            features: [
                revolveFeature('flange-outer', 'Flange outer', 'flange-outer-profile'),
                grooveFeature('flange-bore', 'Flange bore', 'flange-bore-profile', ['flange-outer']),
                pocketFeature('flange-bolt-hole', 'Flange bolt hole', 'flange-bolt-profile', ['flange-bore']),
                circularPatternFeature('flange-bolt-pattern', 'Flange bolt pattern', 'flange-bolt-hole', FLANGE.boltCount)
            ]
        },
        {
            id: 'stepped-shaft',
            bodyLabel: 'stepped-shaft',
            parameters: STEPPED_SHAFT,
            sketches: [
                steppedShaftProfile(
                    STEPPED_SHAFT.stepRadius,
                    STEPPED_SHAFT.shaftRadius,
                    STEPPED_SHAFT.stepLength,
                    STEPPED_SHAFT.totalLength
                )
            ],
            features: [revolveFeature('stepped-shaft-revolve', 'Stepped shaft', 'stepped-shaft-profile')]
        },
        {
            id: 'pipe-with-bore',
            bodyLabel: 'pipe',
            parameters: PIPE,
            sketches: [
                radialProfile('pipe-outer-profile', PIPE.outerRadius, PIPE.length, 'outerRadius', 'length'),
                radialProfile('pipe-bore-profile', PIPE.boreRadius, PIPE.length, 'boreRadius', 'length')
            ],
            features: [
                revolveFeature('pipe-outer', 'Pipe outer', 'pipe-outer-profile'),
                grooveFeature('pipe-bore', 'Pipe bore', 'pipe-bore-profile', ['pipe-outer'])
            ]
        },
        {
            id: 'bolt-circle-plate',
            bodyLabel: 'bolt-circle-plate',
            parameters: PLATE,
            sketches: [
                radialProfile('bolt-circle-plate-profile', PLATE.radius, PLATE.thickness, 'radius', 'thickness'),
                boltPatternSketch(
                    'bolt-circle-plate-bolt-profile',
                    'holeCircleRadius',
                    'holeDiameter',
                    PLATE.holeCircleRadius,
                    PLATE.holeDiameter
                )
            ],
            features: [
                revolveFeature('bolt-circle-plate-base', 'Bolt circle plate', 'bolt-circle-plate-profile'),
                pocketFeature('bolt-circle-plate-hole', 'Bolt circle plate hole', 'bolt-circle-plate-bolt-profile', [
                    'bolt-circle-plate-base'
                ]),
                circularPatternFeature('bolt-circle-plate-pattern', 'Bolt circle plate pattern', 'bolt-circle-plate-hole', PLATE.holeCount)
            ]
        }
    ];
}

async function buildDocument(spec: MechanicalSpec): Promise<NukeCadDocument> {
    const store = new CadDocumentStore();
    expect(store.createDocument(spec.id).success, spec.id).toBe(true);
    expect(store.setUnits('cm').success, spec.id).toBe(true);
    for (const [name, value] of Object.entries(spec.parameters)) {
        if (TEMPLATE_ONLY_PARAMETERS.has(name)) {
            continue;
        }
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
            expect(status.dof, `${spec.id}/${sketch.id}`).toBe(0);
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

describe('GUI build mechanical', () => {
    const documents = new Map<string, NukeCadDocument>();

    beforeAll(async () => {
        for (const spec of mechanicalSpecs()) {
            documents.set(spec.id, await buildDocument(spec));
        }
    });

    it('builds five validated mechanical documents with zero-DOF sketches', () => {
        expect([...documents.keys()]).toEqual(['l-bracket', 'flange', 'stepped-shaft', 'pipe-with-bore', 'bolt-circle-plate']);
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

        const bracket = await solveWith('l-bracket', 'l-bracket-profile', {
            legLength: 10,
            legWidth: 3,
            thickness: 0.9,
            holeDiameter: 1.2
        });
        expect(primitive(bracket, 'point-2').x).toBeCloseTo(10);
        expect(primitive(bracket, 'point-4').x).toBeCloseTo(3);
        expect(primitive(bracket, 'point-4').y).toBeCloseTo(3);
        expect(primitive(bracket, 'point-5').y).toBeCloseTo(10);
        expect(primitive(bracket, 'point-height').y).toBeCloseTo(10.9);
        expect(primitive(bracket, 'point-hole-1').x).toBeCloseTo(5);
        expect(primitive(bracket, 'point-hole-1').y).toBeCloseTo(1.5);
        expect(primitive(bracket, 'point-hole-2').x).toBeCloseTo(6.5);
        expect(primitive(bracket, 'point-hole-2').y).toBeCloseTo(1.5);
        expect(primitive(bracket, 'circle-hole-1').radius).toBeCloseTo(0.6);
        expect(primitive(bracket, 'circle-hole-2').radius).toBeCloseTo(0.6);

        const flangeOuter = await solveWith('flange', 'flange-outer-profile', { outerRadius: 7, thickness: 1.4 });
        const flangeBore = await solveWith('flange', 'flange-bore-profile', { innerRadius: 4, thickness: 1.4 });
        const flangeBolt = await solveWith('flange', 'flange-bolt-profile', {
            boltCircleRadius: 5.5,
            boltHoleDiameter: 1.2
        });
        expect(primitive(flangeOuter, 'point-2').x).toBeCloseTo(7);
        expect(primitive(flangeOuter, 'point-3').y).toBeCloseTo(1.4);
        expect(primitive(flangeBore, 'point-2').x).toBeCloseTo(4);
        expect(primitive(flangeBolt, 'point-hole').x).toBeCloseTo(5.5);
        expect(primitive(flangeBolt, 'circle-hole').radius).toBeCloseTo(0.6);

        const shaft = await solveWith('stepped-shaft', 'stepped-shaft-profile', {
            stepRadius: 1.5,
            shaftRadius: 2.5,
            stepLength: 5,
            totalLength: 16
        });
        expect(primitive(shaft, 'point-2').x).toBeCloseTo(1.5);
        expect(primitive(shaft, 'point-3').y).toBeCloseTo(5);
        expect(primitive(shaft, 'point-4').x).toBeCloseTo(2.5);
        expect(primitive(shaft, 'point-4').y).toBeCloseTo(5);
        expect(primitive(shaft, 'point-5').y).toBeCloseTo(16);

        const pipeOuter = await solveWith('pipe-with-bore', 'pipe-outer-profile', { outerRadius: 4, length: 12 });
        const pipeBore = await solveWith('pipe-with-bore', 'pipe-bore-profile', { boreRadius: 3.2, length: 12 });
        expect(primitive(pipeOuter, 'point-2').x).toBeCloseTo(4);
        expect(primitive(pipeOuter, 'point-3').y).toBeCloseTo(12);
        expect(primitive(pipeBore, 'point-2').x).toBeCloseTo(3.2);

        const plate = await solveWith('bolt-circle-plate', 'bolt-circle-plate-profile', { radius: 6, thickness: 1.1 });
        const plateBolt = await solveWith('bolt-circle-plate', 'bolt-circle-plate-bolt-profile', {
            holeCircleRadius: 4.2,
            holeDiameter: 1.4
        });
        expect(primitive(plate, 'point-2').x).toBeCloseTo(6);
        expect(primitive(plate, 'point-3').y).toBeCloseTo(1.1);
        expect(primitive(plateBolt, 'point-hole').x).toBeCloseTo(4.2);
        expect(primitive(plateBolt, 'circle-hole').radius).toBeCloseTo(0.7);
    });
});
