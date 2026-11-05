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
 * Parameter-driven sketch builders shared by the component-template fixtures
 * and the creation-time `configure` hooks.
 *
 * A pattern count is stored as a plain number in the document schema, so it
 * cannot be bound to a document parameter. Templates that expose a count use
 * `binding: 'template'`; the configure hook rebuilds the affected sketch or
 * feature with the resolved value before the build.
 *
 * @module nuke-cad/common
 */

import type { CurveDef, CurveSource, NukeCadDocument, SketchDef, SketchDimension } from '../cad-document';

/** Optional point construction/fixed flags. */
export interface SketchPointSpec {
    readonly fixed?: boolean;
    readonly construction?: boolean;
}

function point(id: string, x: number, y: number, options: SketchPointSpec = {}): Record<string, unknown> {
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

/** Difference constraint enforcing `right.[x|y] - left.[x|y] = value`. */
function difference(id: string, prop: 'x' | 'y', left: string, right: string, value: string | number): Record<string, unknown> {
    return {
        id,
        type: 'difference',
        param1: { o_id: left, prop },
        param2: { o_id: right, prop },
        difference: String(value),
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

function numberText(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)));
}

/** Inputs for the L-bracket profile builder. */
export interface LBracketProfileValues {
    readonly legLength: number;
    readonly legWidth: number;
    readonly thickness: number;
    readonly holeDiameter: number;
    readonly holeCount: number;
}

/**
 * L-shaped equal-leg profile on XY with `holeCount` through holes and a
 * thickness handle for the straight sweep.
 *
 * Hole positions for the shipped two-hole default preserve the original
 * template layout; other counts distribute the holes along the horizontal leg.
 */
export function buildLBracketProfile(values: LBracketProfileValues): SketchDef {
    const holeCount = Math.max(1, Math.round(values.holeCount));
    const holeRadius = values.holeDiameter / 2;
    const holeY = values.legWidth / 2;
    const positions: number[] = [];
    if (holeCount === 1) {
        positions.push(values.legLength / 2);
    } else if (holeCount === 2) {
        positions.push(values.legLength / 2, (values.legWidth + values.legLength) / 2);
    } else {
        const margin = holeRadius + Math.max(0.1, (values.legLength - values.legWidth) * 0.05);
        const start = values.legWidth + margin;
        const end = values.legLength - margin;
        const span = Math.max(end - start, 0);
        for (let index = 0; index < holeCount; index += 1) {
            positions.push(start + (span * index) / (holeCount - 1));
        }
    }

    const primitives: Record<string, unknown>[] = [
        point('point-1', 0, 0, { fixed: true }),
        point('point-2', values.legLength, 0),
        point('point-3', values.legLength, values.legWidth),
        point('point-4', values.legWidth, values.legWidth),
        point('point-5', values.legWidth, values.legLength),
        point('point-6', 0, values.legLength),
        line('line-7', 'point-1', 'point-2'),
        line('line-8', 'point-2', 'point-3'),
        line('line-9', 'point-3', 'point-4'),
        line('line-10', 'point-4', 'point-5'),
        line('line-11', 'point-5', 'point-6'),
        line('line-12', 'point-6', 'point-1'),
        point('point-height', 0, values.legLength + values.thickness, { construction: true }),
        line('line-height', 'point-6', 'point-height', true)
    ];
    const constraints: Record<string, unknown>[] = [
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
        difference('distance-thickness', 'y', 'point-6', 'point-height', 'thickness')
    ];
    const dimensions: SketchDimension[] = [
        dimension('dimension-length', 'distance-length', 'distanceH', ['point-2', 'point-1'], 'legLength', values.legLength),
        dimension('dimension-width', 'distance-width', 'distanceV', ['point-3', 'point-2'], 'legWidth', values.legWidth),
        dimension('dimension-inner', 'distance-inner', 'distanceH', ['point-4', 'point-1'], 'legWidth', values.legWidth),
        dimension('dimension-upper', 'distance-upper', 'distanceV', ['point-6', 'point-1'], 'legLength', values.legLength),
        dimension('dimension-thickness', 'distance-thickness', 'distanceV', ['point-height', 'point-6'], 'thickness', values.thickness)
    ];

    positions.forEach((x, index) => {
        const pointId = `point-hole-${index}`;
        const circleId = `circle-hole-${index}`;
        primitives.push(point(pointId, x, holeY), circle(circleId, pointId, holeRadius));
        constraints.push(
            difference(`hole-x-${index}`, 'x', 'point-1', pointId, numberText(x)),
            difference(`hole-y-${index}`, 'y', 'point-1', pointId, numberText(holeY)),
            circleDiameter(`diameter-hole-${index}`, circleId, 'holeDiameter')
        );
        dimensions.push(
            dimension(`dimension-hole-${index}`, `diameter-hole-${index}`, 'diameter', [circleId], 'holeDiameter', values.holeDiameter)
        );
    });

    return {
        id: 'l-bracket-profile',
        name: 'l-bracket-profile',
        datumId: 'datum-xy',
        primitives,
        constraints,
        dimensions
    };
}

/** Inputs for the assembly grid-plate profile builder. */
export interface GridPlateProfileValues {
    readonly width: number;
    readonly height: number;
    readonly thickness: number;
    readonly cellPitch: number;
    readonly cellCount: number;
    readonly cellDiameter: number;
}

/**
 * Rectangular grid-plate profile on XY with a `cellCount` x `cellCount`
 * through-hole array and a thickness handle for the straight sweep.
 */
export function buildGridPlateProfile(values: GridPlateProfileValues): SketchDef {
    const count = Math.max(1, Math.round(values.cellCount));
    const halfWidth = values.width / 2;
    const halfHeight = values.height / 2;
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
        point('profile-point-height', 0, values.thickness, { construction: true }),
        line('profile-line-height', 'point-center', 'profile-point-height', true)
    ];
    const constraints: Record<string, unknown>[] = [
        signConstraint('horizontal-1', 'horizontal_l', 'line-1'),
        signConstraint('vertical-2', 'vertical_l', 'line-2'),
        signConstraint('horizontal-3', 'horizontal_l', 'line-3'),
        signConstraint('vertical-4', 'vertical_l', 'line-4'),
        signConstraint('profile-vertical-height', 'vertical_l', 'profile-line-height'),
        difference('distance-width', 'x', 'point-1', 'point-2', 'width'),
        difference('distance-height', 'y', 'point-1', 'point-4', 'height'),
        difference('profile-distance-height', 'y', 'point-center', 'profile-point-height', 'plateThickness')
    ];
    const dimensions: SketchDimension[] = [
        dimension('dimension-width', 'distance-width', 'distanceH', ['point-2', 'point-1'], 'width', values.width),
        dimension('dimension-height', 'distance-height', 'distanceV', ['point-4', 'point-1'], 'height', values.height),
        dimension(
            'dimension-thickness',
            'profile-distance-height',
            'distanceV',
            ['profile-point-height', 'point-center'],
            'plateThickness',
            values.thickness
        )
    ];

    const offset = (count - 1) / 2;
    for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
            const x = (col - offset) * values.cellPitch;
            const y = (row - offset) * values.cellPitch;
            const pointId = `point-hole-${row}${col}`;
            const circleId = `circle-hole-${row}${col}`;
            primitives.push(point(pointId, x, y), circle(circleId, pointId, values.cellDiameter / 2));
            constraints.push(
                difference(`hole-x-${row}${col}`, 'x', 'point-center', pointId, numberText(x)),
                difference(`hole-y-${row}${col}`, 'y', 'point-center', pointId, numberText(y)),
                circleDiameter(`diameter-hole-${row}${col}`, circleId, 'cellDiameter')
            );
            dimensions.push(
                dimension(
                    `dimension-hole-${row}${col}`,
                    `diameter-hole-${row}${col}`,
                    'diameter',
                    [circleId],
                    'cellDiameter',
                    values.cellDiameter
                )
            );
        }
    }

    return {
        id: 'grid-plate-profile',
        name: 'grid-plate-profile',
        datumId: 'datum-xy',
        primitives,
        constraints,
        dimensions
    };
}

/** Rebuild one sketch in a detached document, preserving every other entry. */
export function replaceSketch(document: NukeCadDocument, sketch: SketchDef): NukeCadDocument {
    document.sketches = document.sketches.map((candidate) => (candidate.id === sketch.id ? sketch : candidate));
    return document;
}

/** Set one circular-pattern feature's count in a detached document. */
export function setCircularPatternCount(document: NukeCadDocument, featureId: string, count: number): NukeCadDocument {
    const normalized = Math.max(1, Math.round(count));
    document.features = document.features.map((feature) =>
        feature.id === featureId && feature.type === 'circularPattern'
            ? { ...feature, params: { ...feature.params, count: normalized } }
            : feature
    );
    return document;
}

/** Build a vertical parametric path for a swept extrusion height. */
export function verticalPath(id: string, name: string, parameter: string, height: number): CurveDef {
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
