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
 * GUI-path authoring driver for the nuclear component-template fixtures.
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

const HEX_CELL = { pitch: 1.26, fuelRadius: 0.4, cladRadius: 0.47, height: 1.0 } as const;
const GUIDE_TUBE = { outerRadius: 0.6, innerRadius: 0.54, length: 30, wallThickness: 0.06 } as const;
const GRID_PLATE = {
    width: 4.2,
    height: 4.2,
    plateThickness: 0.3,
    cellPitch: 1.26,
    cellCount: 3,
    cellDiameter: 0.95
} as const;

type PointSpec = { fixed?: boolean; construction?: boolean };
type FeatureSpec = Omit<FeatureDef, 'body'>;

interface NuclearSpec {
    readonly id: string;
    readonly bodyLabels: readonly string[];
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

function symmetricPoint(id: string, p1: string, p2: string, center: string): Record<string, unknown> {
    return { id, type: 'p2p_symmetric_ppp', p1_id: p1, p2_id: p2, p_id: center, driving: true };
}

function symmetricLine(id: string, p1: string, p2: string, mirrorLine: string): Record<string, unknown> {
    return { id, type: 'p2p_symmetric_ppl', p1_id: p1, p2_id: p2, l_id: mirrorLine, driving: true };
}

function equalLength(id: string, l1: string, l2: string): Record<string, unknown> {
    return { id, type: 'equal_length', l1_id: l1, l2_id: l2, driving: true };
}

function pointOnLine(id: string, pointId: string, lineId: string): Record<string, unknown> {
    return { id, type: 'point_on_line_pl', p_id: pointId, l_id: lineId, driving: true };
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

function circleRadius(id: string, circleId: string, value: string): Record<string, unknown> {
    return { id, type: 'circle_radius', c_id: circleId, radius: value, driving: true };
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

/** Fixed sketch center plus a vertical construction handle carrying the extrusion height. */
function heightGauge(
    prefix: string,
    centerId: string,
    value: number,
    parameter: string
): { readonly primitives: Record<string, unknown>[]; readonly constraints: Record<string, unknown>[] } {
    return {
        primitives: [
            point(`${prefix}-point-height`, 0, value, { construction: true }),
            line(`${prefix}-line-height`, centerId, `${prefix}-point-height`, true)
        ],
        constraints: [
            signConstraint(`${prefix}-vertical-height`, 'vertical_l', `${prefix}-line-height`),
            difference(`${prefix}-distance-height`, 'y', centerId, `${prefix}-point-height`, parameter)
        ]
    };
}

/** Single fixed-center circle profile with a construction height handle. */
function circularProfile(id: string, radius: number, radiusParameter: string, height: number, heightParameter: string): SketchDef {
    const gauge = heightGauge('profile', 'point-center', height, heightParameter);
    return {
        id,
        name: id,
        datumId: 'datum-xy',
        primitives: [point('point-center', 0, 0, { fixed: true }), circle('circle-profile', 'point-center', radius), ...gauge.primitives],
        constraints: [circleRadius('radius-profile', 'circle-profile', radiusParameter), ...gauge.constraints],
        dimensions: [
            dimension('dimension-radius', 'radius-profile', 'radius', ['circle-profile'], radiusParameter, radius),
            dimension(
                'dimension-height',
                'profile-distance-height',
                'distanceV',
                ['profile-point-height', 'point-center'],
                heightParameter,
                height
            )
        ]
    };
}

/** Concentric two-circle profile (annulus) with a construction height handle. */
function annularProfile(
    id: string,
    innerRadius: number,
    innerParameter: string,
    outerRadius: number,
    outerParameter: string,
    height: number,
    heightParameter: string
): SketchDef {
    const gauge = heightGauge('profile', 'point-center', height, heightParameter);
    return {
        id,
        name: id,
        datumId: 'datum-xy',
        primitives: [
            point('point-center', 0, 0, { fixed: true }),
            circle('circle-inner', 'point-center', innerRadius),
            circle('circle-outer', 'point-center', outerRadius),
            ...gauge.primitives
        ],
        constraints: [
            circleRadius('radius-inner', 'circle-inner', innerParameter),
            circleRadius('radius-outer', 'circle-outer', outerParameter),
            ...gauge.constraints
        ],
        dimensions: [
            dimension('dimension-inner', 'radius-inner', 'radius', ['circle-inner'], innerParameter, innerRadius),
            dimension('dimension-outer', 'radius-outer', 'radius', ['circle-outer'], outerParameter, outerRadius),
            dimension(
                'dimension-height',
                'profile-distance-height',
                'distanceV',
                ['profile-point-height', 'point-center'],
                heightParameter,
                height
            )
        ]
    };
}

/**
 * Regular hexagon on XY with flats at the top and bottom, a concentric hole,
 * and a vertical construction handle for the sweep height.
 *
 * `pitch` is the flat-to-flat distance: the vertical dimension between the
 * midpoints of the top and bottom flats, which is also the center-to-center
 * distance of a hex lattice. The hexagon is regular because every vertex is
 * equidistant from the fixed center, adjacent sides are equal, and both the
 * vertical and point symmetries are driving constraints.
 */
function hexProfile(
    id: string,
    pitch: number,
    holeRadius: number,
    holeParameter: string,
    height: number,
    heightParameter: string,
    withHole: boolean
): SketchDef {
    const apothem = pitch / 2;
    const circumradius = pitch / Math.sqrt(3);
    const halfHeight = Math.sqrt(3) * circumradius * 0.5;
    const gauge = heightGauge('profile', 'point-center', height, heightParameter);
    const primitives: Record<string, unknown>[] = [
        point('point-1', circumradius, 0),
        point('point-2', circumradius / 2, halfHeight),
        point('point-3', -circumradius / 2, halfHeight),
        point('point-4', -circumradius, 0),
        point('point-5', -circumradius / 2, -halfHeight),
        point('point-6', circumradius / 2, -halfHeight),
        line('line-1', 'point-1', 'point-2'),
        line('line-2', 'point-2', 'point-3'),
        line('line-3', 'point-3', 'point-4'),
        line('line-4', 'point-4', 'point-5'),
        line('line-5', 'point-5', 'point-6'),
        line('line-6', 'point-6', 'point-1'),
        point('point-center', 0, 0, { fixed: true }),
        point('point-axis-top', 0, 1, { construction: true, fixed: true }),
        line('line-axis-v', 'point-center', 'point-axis-top', true),
        line('line-axis-h', 'point-center', 'point-1', true),
        line('line-radius-1', 'point-center', 'point-1', true),
        line('line-radius-2', 'point-center', 'point-2', true),
        point('point-mid-top', 0, apothem, { construction: true }),
        point('point-mid-bottom', 0, -apothem, { construction: true }),
        line('line-mid-top-axis', 'point-center', 'point-mid-top', true),
        line('line-mid-bottom-axis', 'point-center', 'point-mid-bottom', true),
        ...gauge.primitives
    ];
    const constraints: Record<string, unknown>[] = [
        signConstraint('axis-h-horizontal', 'horizontal_l', 'line-axis-h'),
        signConstraint('mid-top-vertical', 'vertical_l', 'line-mid-top-axis'),
        signConstraint('mid-bottom-vertical', 'vertical_l', 'line-mid-bottom-axis'),
        pointOnLine('mid-top-on-flat', 'point-mid-top', 'line-2'),
        pointOnLine('mid-bottom-on-flat', 'point-mid-bottom', 'line-5'),
        symmetricLine('symmetric-2-3', 'point-2', 'point-3', 'line-axis-v'),
        symmetricLine('symmetric-5-6', 'point-5', 'point-6', 'line-axis-v'),
        symmetricPoint('symmetric-1-4', 'point-1', 'point-4', 'point-center'),
        symmetricPoint('symmetric-2-5', 'point-2', 'point-5', 'point-center'),
        equalLength('equal-radius', 'line-radius-1', 'line-radius-2'),
        equalLength('equal-sides', 'line-1', 'line-2'),
        difference('pitch', 'y', 'point-mid-bottom', 'point-mid-top', 'pitch'),
        ...gauge.constraints
    ];
    const dimensions: SketchDimension[] = [
        dimension('dimension-pitch', 'pitch', 'distanceV', ['point-mid-top', 'point-mid-bottom'], 'pitch', pitch),
        dimension(
            'dimension-height',
            'profile-distance-height',
            'distanceV',
            ['profile-point-height', 'point-center'],
            heightParameter,
            height
        )
    ];
    if (withHole) {
        primitives.push(circle('circle-hole', 'point-center', holeRadius));
        constraints.push(circleRadius('radius-hole', 'circle-hole', holeParameter));
        dimensions.push(dimension('dimension-hole', 'radius-hole', 'radius', ['circle-hole'], holeParameter, holeRadius));
    }
    return { id, name: id, datumId: 'datum-xy', primitives, constraints, dimensions };
}

/**
 * Rectangular grid plate profile on XY with the canonical 3x3 through-hole
 * array and a vertical sweep-height handle.
 *
 * `cellPitch` drives the hole spacing through adjacent-center dimensions and
 * `cellDiameter` drives every hole. The template's configure hook rebuilds the
 * sketch for a different creation-time cell count.
 */
function gridPlateProfile(width: number, height: number, thickness: number, cellPitch: number, cellDiameter: number): SketchDef {
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const gauge = heightGauge('profile', 'point-center', thickness, 'plateThickness');
    const primitives: Record<string, unknown>[] = [
        point('point-1', -halfWidth, -halfHeight),
        point('point-2', halfWidth, -halfHeight),
        point('point-3', halfWidth, halfHeight),
        point('point-4', -halfWidth, halfHeight),
        line('line-1', 'point-1', 'point-2'),
        line('line-2', 'point-2', 'point-3'),
        line('line-3', 'point-3', 'point-4'),
        line('line-4', 'point-4', 'point-1'),
        point('point-center', 0, 0, { fixed: true }),
        ...gauge.primitives
    ];
    const constraints: Record<string, unknown>[] = [
        signConstraint('horizontal-1', 'horizontal_l', 'line-1'),
        signConstraint('vertical-2', 'vertical_l', 'line-2'),
        signConstraint('horizontal-3', 'horizontal_l', 'line-3'),
        signConstraint('vertical-4', 'vertical_l', 'line-4'),
        symmetricPoint('symmetric-corners', 'point-1', 'point-3', 'point-center'),
        difference('distance-width', 'x', 'point-1', 'point-2', 'width'),
        difference('distance-height', 'y', 'point-1', 'point-4', 'height'),
        ...gauge.constraints
    ];
    const dimensions: SketchDimension[] = [
        dimension('dimension-width', 'distance-width', 'distanceH', ['point-2', 'point-1'], 'width', width),
        dimension('dimension-height', 'distance-height', 'distanceV', ['point-4', 'point-1'], 'height', height),
        dimension(
            'dimension-thickness',
            'profile-distance-height',
            'distanceV',
            ['profile-point-height', 'point-center'],
            'plateThickness',
            thickness
        )
    ];

    const holes: string[][] = [];
    for (let row = 0; row < 3; row++) {
        holes[row] = [];
        for (let col = 0; col < 3; col++) {
            const id = `point-hole-${row}${col}`;
            holes[row][col] = id;
            primitives.push(point(id, (col - 1) * cellPitch, (row - 1) * cellPitch));
            primitives.push(circle(`circle-hole-${row}${col}`, id, cellDiameter / 2));
            constraints.push(circleDiameter(`diameter-hole-${row}${col}`, `circle-hole-${row}${col}`, 'cellDiameter'));
            dimensions.push(
                dimension(
                    `dimension-hole-${row}${col}`,
                    `diameter-hole-${row}${col}`,
                    'diameter',
                    [`circle-hole-${row}${col}`],
                    'cellDiameter',
                    cellDiameter
                )
            );
        }
    }
    primitives.find((primitive) => primitive.id === 'point-hole-11')!.fixed = true;

    for (let row = 0; row < 3; row++) {
        constraints.push(difference(`pitch-x-${row}0`, 'x', holes[row][0], holes[row][1], 'cellPitch'));
        constraints.push(difference(`pitch-x-${row}1`, 'x', holes[row][1], holes[row][2], 'cellPitch'));
    }
    for (let col = 0; col < 3; col++) {
        constraints.push(difference(`pitch-y-0${col}`, 'y', holes[0][col], holes[1][col], 'cellPitch'));
        constraints.push(difference(`pitch-y-1${col}`, 'y', holes[1][col], holes[2][col], 'cellPitch'));
    }
    primitives.push(
        line('line-align-x-0', holes[0][1], holes[1][1], true),
        line('line-align-x-2', holes[2][1], holes[1][1], true),
        line('line-align-y-0', holes[1][0], holes[1][1], true),
        line('line-align-y-2', holes[1][2], holes[1][1], true)
    );
    constraints.push(
        signConstraint('align-x-0', 'vertical_l', 'line-align-x-0'),
        signConstraint('align-x-2', 'vertical_l', 'line-align-x-2'),
        signConstraint('align-y-0', 'horizontal_l', 'line-align-y-0'),
        signConstraint('align-y-2', 'horizontal_l', 'line-align-y-2')
    );

    return { id: 'grid-plate-profile', name: 'grid-plate-profile', datumId: 'datum-xy', primitives, constraints, dimensions };
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

function nuclearSpecs(): readonly NuclearSpec[] {
    const hexPitch = HEX_CELL.pitch;
    return [
        {
            id: 'hex-cell',
            bodyLabels: ['fuel', 'clad', 'moderator'],
            parameters: HEX_CELL,
            sketches: [
                circularProfile('hex-fuel-profile', HEX_CELL.fuelRadius, 'fuelRadius', HEX_CELL.height, 'height'),
                annularProfile(
                    'hex-clad-profile',
                    HEX_CELL.fuelRadius,
                    'fuelRadius',
                    HEX_CELL.cladRadius,
                    'cladRadius',
                    HEX_CELL.height,
                    'height'
                ),
                hexProfile('hex-moderator-profile', hexPitch, HEX_CELL.cladRadius, 'cladRadius', HEX_CELL.height, 'height', true)
            ],
            curves: [verticalPath('hex-cell-height-path', 'hex-cell height path', 'height', HEX_CELL.height)],
            features: [
                sweepFeature('hex-fuel-sweep', 'Fuel', 'hex-fuel-profile', 'hex-cell-height-path'),
                sweepFeature('hex-clad-sweep', 'Clad', 'hex-clad-profile', 'hex-cell-height-path'),
                sweepFeature('hex-moderator-sweep', 'Moderator', 'hex-moderator-profile', 'hex-cell-height-path')
            ]
        },
        {
            id: 'control-rod-guide-tube',
            bodyLabels: ['guide-tube'],
            parameters: GUIDE_TUBE,
            sketches: [
                (() => {
                    const sketch = annularProfile(
                        'guide-tube-profile',
                        GUIDE_TUBE.innerRadius,
                        'innerRadius',
                        GUIDE_TUBE.outerRadius,
                        'outerRadius',
                        GUIDE_TUBE.length,
                        'length'
                    );
                    sketch.primitives.push(
                        point('point-wall', GUIDE_TUBE.wallThickness, 0, { construction: true }),
                        line('line-wall', 'point-center', 'point-wall', true)
                    );
                    sketch.constraints.push(
                        signConstraint('wall-horizontal', 'horizontal_l', 'line-wall'),
                        difference('distance-wall', 'x', 'point-center', 'point-wall', 'wallThickness')
                    );
                    sketch.dimensions = [
                        ...(sketch.dimensions ?? []),
                        dimension(
                            'dimension-wall',
                            'distance-wall',
                            'distanceH',
                            ['point-wall', 'point-center'],
                            'wallThickness',
                            GUIDE_TUBE.wallThickness
                        )
                    ];
                    return sketch;
                })()
            ],
            curves: [verticalPath('guide-tube-length-path', 'guide-tube length path', 'length', GUIDE_TUBE.length)],
            features: [sweepFeature('guide-tube-sweep', 'Guide tube', 'guide-tube-profile', 'guide-tube-length-path')]
        },
        {
            id: 'assembly-grid-plate',
            bodyLabels: ['grid-plate'],
            parameters: GRID_PLATE,
            sketches: [
                gridPlateProfile(
                    GRID_PLATE.width,
                    GRID_PLATE.height,
                    GRID_PLATE.plateThickness,
                    GRID_PLATE.cellPitch,
                    GRID_PLATE.cellDiameter
                )
            ],
            curves: [verticalPath('grid-plate-thickness-path', 'grid-plate thickness path', 'plateThickness', GRID_PLATE.plateThickness)],
            features: [sweepFeature('grid-plate-sweep', 'Grid plate', 'grid-plate-profile', 'grid-plate-thickness-path')]
        }
    ];
}

async function buildDocument(spec: NuclearSpec): Promise<NukeCadDocument> {
    const store = new CadDocumentStore();
    expect(store.createDocument(spec.id).success, spec.id).toBe(true);
    expect(store.setUnits('cm').success, spec.id).toBe(true);
    for (const [name, value] of Object.entries(spec.parameters)) {
        if (name === 'cellCount') {
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

    const bodies: string[] = [];
    for (const label of spec.bodyLabels) {
        const body = store.addBody(label, label);
        expect(body.success, `${spec.id}: ${body.error ?? label}`).toBe(true);
        bodies.push(body.value!);
    }

    for (const curve of spec.curves ?? []) {
        const result = store.addCurve(curve);
        expect(result.success, `${spec.id}/${curve.id}: ${result.error ?? ''}`).toBe(true);
    }

    for (const [index, feature] of spec.features.entries()) {
        const result = store.addFeature({ ...feature, body: bodies[index] });
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

describe('GUI build nuclear', () => {
    const documents = new Map<string, NukeCadDocument>();

    beforeAll(async () => {
        for (const spec of nuclearSpecs()) {
            documents.set(spec.id, await buildDocument(spec));
        }
    });

    it('builds three validated nuclear documents with zero-DOF sketches', () => {
        expect([...documents.keys()]).toEqual(['hex-cell', 'control-rod-guide-tube', 'assembly-grid-plate']);
        for (const [id, document] of documents) {
            const validation = validateNukeCadDocument(document);
            expect(validation.valid, `${id}: ${JSON.stringify(validation.issues)}`).toBe(true);
            expect(document.units, id).toBe('cm');
            expect(document.bodies.length, id).toBeGreaterThan(0);
            for (const body of document.bodies) {
                expect(body.label, id).toBeTruthy();
            }
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
                expect(status.redundant, `${id}/${sketchId}`).toEqual([]);
                expect(status.dof, `${id}/${sketchId}`).toBe(0);
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

        const fuel = await solveWith('hex-cell', 'hex-fuel-profile', { fuelRadius: 0.45 });
        expect(primitive(fuel, 'circle-profile').radius).toBeCloseTo(0.45);
        const clad = await solveWith('hex-cell', 'hex-clad-profile', { fuelRadius: 0.42, cladRadius: 0.5 });
        expect(primitive(clad, 'circle-inner').radius).toBeCloseTo(0.42);
        expect(primitive(clad, 'circle-outer').radius).toBeCloseTo(0.5);
        const moderator = await solveWith('hex-cell', 'hex-moderator-profile', { pitch: 1.5, cladRadius: 0.52 });
        expect(primitive(moderator, 'circle-hole').radius).toBeCloseTo(0.52);
        const midTop = primitive(moderator, 'point-mid-top').y as number;
        const midBottom = primitive(moderator, 'point-mid-bottom').y as number;
        expect(Math.abs(midTop - midBottom)).toBeCloseTo(1.5);

        const guide = await solveWith('control-rod-guide-tube', 'guide-tube-profile', {
            outerRadius: 0.7,
            innerRadius: 0.62,
            length: 40,
            wallThickness: 0.08
        });
        expect(primitive(guide, 'circle-outer').radius).toBeCloseTo(0.7);
        expect(primitive(guide, 'circle-inner').radius).toBeCloseTo(0.62);
        expect(primitive(guide, 'point-wall').x).toBeCloseTo(0.08);

        const grid = await solveWith('assembly-grid-plate', 'grid-plate-profile', {
            width: 5,
            height: 4.5,
            plateThickness: 0.4,
            cellPitch: 1.4,
            cellDiameter: 1.0
        });
        expect(primitive(grid, 'point-2').x).toBeCloseTo(2.5);
        expect(primitive(grid, 'point-4').y).toBeCloseTo(2.25);
        expect(primitive(grid, 'profile-point-height').y).toBeCloseTo(0.4);
        expect(primitive(grid, 'point-hole-00').x).toBeCloseTo(-1.4);
        expect(primitive(grid, 'point-hole-00').y).toBeCloseTo(-1.4);
        expect(primitive(grid, 'circle-hole-22').radius).toBeCloseTo(0.5);
    });
});
