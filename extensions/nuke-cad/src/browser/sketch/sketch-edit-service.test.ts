// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { PlanegcsSketchSolver, type SketchCircle } from '../../common/sketch-solver';
import {
    NUKE_CAD_SCHEMA_VERSION,
    validateNukeCadDocument,
    type CurveDef,
    type NukeCadDocument,
    type SketchDef
} from '../../common/cad-document';
import { CadDocumentStore } from '../document/cad-document-store';
import { SketchSession } from './sketch-session';
import { NukeCadSketchEditService, sketchDefinitionsEqual } from './sketch-edit-service';
import type { PreparedSketchEdit, SketchEditPrepareResult, SketchEditRequest, SketchSolveStatus } from './sketch-edit-types';

function makeDocument(overrides: Partial<NukeCadDocument> = {}): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'test',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [],
        sketches: [],
        features: [],
        curves: [],
        ...overrides
    };
}

async function buildCircleSketch(options: { id: string; name: string; radius: number; parameterName?: string }): Promise<SketchDef> {
    const solver = await PlanegcsSketchSolver.create();
    const session = await SketchSession.create(solver, {
        id: options.id,
        name: options.name,
        datumId: 'datum-xy'
    });
    try {
        session.setTool('circle');
        await session.click({ x: 0, y: 0 });
        await session.click({ x: options.radius, y: 0 });
        const circle = session.getPrimitives().find((primitive) => primitive.type === 'circle');
        if (circle === undefined) {
            throw new Error('circle was not created');
        }
        const dimension = await session.addDimension('radius', [circle.id], options.radius);
        if (!dimension.success || dimension.dimensionId === undefined) {
            throw new Error(dimension.error ?? 'radius dimension was not created');
        }
        if (options.parameterName !== undefined) {
            const parameter = await session.setParameter(options.parameterName, options.radius);
            if (!parameter.success) {
                throw new Error(parameter.error ?? 'parameter was not created');
            }
            const bound = await session.editDimension(dimension.dimensionId, { parameter: options.parameterName });
            if (!bound.success) {
                throw new Error(bound.error ?? 'dimension was not bound');
            }
        }
        const definition = session.toSketchDef();
        delete definition.parameters;
        return JSON.parse(JSON.stringify(definition)) as SketchDef;
    } finally {
        session.destroy();
    }
}

function newService(): NukeCadSketchEditService {
    return new NukeCadSketchEditService(() => PlanegcsSketchSolver.create());
}

function expectOk(result: SketchEditPrepareResult): PreparedSketchEdit {
    if (!result.ok) {
        throw new Error(`Expected a prepared edit, got ${result.code}: ${result.message}`);
    }
    return result.result;
}

async function expectCode(document: NukeCadDocument, requests: readonly SketchEditRequest[], code: string): Promise<void> {
    const result = await newService().prepare(document, requests);
    expect(result.ok).toBe(false);
    if (!result.ok) {
        expect(result.code).toBe(code);
    }
}

function circleRadius(definition: SketchDef): number {
    const circle = definition.primitives.find((primitive) => primitive.type === 'circle');
    return (circle as unknown as SketchCircle).radius;
}

function dimensionValue(definition: SketchDef, dimensionId: string): number {
    const dimension = (definition.dimensions ?? []).find((entry) => entry.id === dimensionId);
    if (dimension === undefined) {
        throw new Error(`missing dimension ${dimensionId}`);
    }
    return dimension.value;
}

function parametricCurve(): CurveDef {
    return {
        id: 'curve-1',
        name: 'Curve 1',
        source: {
            kind: 'parametric',
            x: 'amp*cos(t)',
            y: 'amp*sin(t)',
            z: '0',
            tStart: 0,
            tEnd: 2 * Math.PI,
            sampleCount: 16
        },
        samples: [
            [2, 0, 0],
            [0, 2, 0],
            [-2, 0, 0],
            [0, -2, 0]
        ]
    };
}

describe('NukeCadSketchEditService', () => {
    it('edits a literal driving dimension without touching unrelated sketches or parameters', async () => {
        const service = newService();
        const target = await buildCircleSketch({ id: 's1', name: 'Circle A', radius: 5 });
        const other = await buildCircleSketch({ id: 's2', name: 'Circle B', radius: 3 });
        const document = makeDocument({ parameters: { width: 12 }, sketches: [target, other] });
        const snapshot = JSON.parse(JSON.stringify(document)) as NukeCadDocument;
        const dimensionId = target.dimensions![0].id;

        const prepared = expectOk(await service.prepare(document, [{ sketchId: 's1', dimensionId, value: 8 }]));

        expect(prepared.affectedSketchIds).toEqual(['s1']);
        expect(prepared.afterDocument.parameters).toEqual({ width: 12 });
        expect(prepared.edits).toHaveLength(1);
        expect(prepared.edits[0].kind).toBe('dimension');
        expect(prepared.edits[0].dimensionId).toBe(dimensionId);
        expect(prepared.edits[0].dimensionKind).toBe('radius');
        expect(prepared.edits[0].before).toBeCloseTo(5, 10);
        expect(prepared.edits[0].after).toBeCloseTo(8, 10);
        expect(prepared.edits[0].affectedDimensionIds).toEqual([dimensionId]);

        expect(dimensionValue(prepared.afterSketches.s1, dimensionId)).toBeCloseTo(8, 10);
        expect(circleRadius(prepared.afterSketches.s1)).toBeCloseTo(8, 8);
        expect(prepared.afterSketches.s2).toBeUndefined();
        expect(prepared.afterDocument.sketches[1]).toEqual(document.sketches[1]);
        expect(prepared.beforeSketches.s1).toEqual(target);
        expect(sketchDefinitionsEqual(prepared.beforeSketches.s1, prepared.afterSketches.s1)).toBe(false);

        expect(prepared.changes).toHaveLength(1);
        expect(prepared.changes[0].path).toBe(`sketches.s1.dimensions.${dimensionId}`);
        expect(prepared.changes[0].before).toBeCloseTo(5, 10);
        expect(prepared.changes[0].after).toBeCloseTo(8, 10);

        expect(validateNukeCadDocument(prepared.afterDocument).valid).toBe(true);
        expect(JSON.stringify(document)).toBe(JSON.stringify(snapshot));
    });

    it('re-solves every sketch sharing a document parameter', async () => {
        const service = newService();
        const first = await buildCircleSketch({
            id: 's1',
            name: 'Circle A',
            radius: 5,
            parameterName: 'radius'
        });
        const second = await buildCircleSketch({
            id: 's2',
            name: 'Circle B',
            radius: 5,
            parameterName: 'radius'
        });
        const document = makeDocument({ parameters: { radius: 5 }, sketches: [first, second] });
        const firstDimensionId = first.dimensions![0].id;
        const secondDimensionId = second.dimensions![0].id;

        const prepared = expectOk(await service.prepare(document, [{ sketchId: 's1', parameterName: 'radius', value: 7 }]));

        expect(prepared.affectedSketchIds).toEqual(['s1', 's2']);
        expect(prepared.beforeParameters).toEqual({ radius: 5 });
        expect(prepared.afterParameters).toEqual({ radius: 7 });
        expect(prepared.afterDocument.parameters).toEqual({ radius: 7 });
        expect(dimensionValue(prepared.afterSketches.s1, firstDimensionId)).toBeCloseTo(7, 10);
        expect(dimensionValue(prepared.afterSketches.s2, secondDimensionId)).toBeCloseTo(7, 10);
        expect(circleRadius(prepared.afterSketches.s1)).toBeCloseTo(7, 8);
        expect(circleRadius(prepared.afterSketches.s2)).toBeCloseTo(7, 8);
        expect(Object.keys(prepared.afterSketches.s1.parameters ?? {})).toHaveLength(0);
        expect(Object.keys(prepared.afterSketches.s2.parameters ?? {})).toHaveLength(0);

        expect(prepared.edits).toHaveLength(1);
        expect(prepared.edits[0].kind).toBe('parameter');
        expect(prepared.edits[0].parameterName).toBe('radius');
        expect(prepared.edits[0].before).toBe(5);
        expect(prepared.edits[0].after).toBe(7);
        expect(prepared.edits[0].affectedDimensionIds).toEqual([firstDimensionId, secondDimensionId]);

        expect(prepared.changes.map((change) => change.path)).toEqual([
            'parameters.radius',
            `sketches.s1.dimensions.${firstDimensionId}`,
            `sketches.s2.dimensions.${secondDimensionId}`
        ]);

        const summaryStatuses = prepared.solver.sketches.map((status: SketchSolveStatus) => status.sketchId);
        expect(summaryStatuses).toEqual(['s1', 's2']);
        expect(prepared.solver.status).toBe('converged');
        expect(prepared.solver.conflicting).toEqual([]);
        expect(validateNukeCadDocument(prepared.afterDocument).valid).toBe(true);
    });

    it('treats a parameter-bound dimension request as a parameter edit', async () => {
        const service = newService();
        const first = await buildCircleSketch({
            id: 's1',
            name: 'Circle A',
            radius: 5,
            parameterName: 'radius'
        });
        const second = await buildCircleSketch({
            id: 's2',
            name: 'Circle B',
            radius: 5,
            parameterName: 'radius'
        });
        const document = makeDocument({ parameters: { radius: 5 }, sketches: [first, second] });
        const dimensionId = first.dimensions![0].id;

        const prepared = expectOk(await service.prepare(document, [{ sketchId: 's1', dimensionId, value: 6 }]));

        expect(prepared.edits).toHaveLength(1);
        expect(prepared.edits[0]).toMatchObject({
            kind: 'parameter',
            parameterName: 'radius',
            dimensionId,
            dimensionKind: 'radius',
            before: 5,
            after: 6
        });
        expect(prepared.afterParameters).toEqual({ radius: 6 });
        expect(prepared.changes[0].path).toBe('parameters.radius');
        expect(prepared.affectedSketchIds).toEqual(['s1', 's2']);
    });

    it('rejects reference dimensions', async () => {
        const definition = await buildCircleSketch({ id: 's1', name: 'Circle A', radius: 5 });
        definition.dimensions![0].driving = false;
        const document = makeDocument({ sketches: [definition] });
        const dimensionId = definition.dimensions![0].id;

        expect(await newService().prepare(document, [{ sketchId: 's1', dimensionId, value: 8 }])).toMatchObject({
            ok: false,
            code: 'dimension-not-driving'
        });
    });

    it('rejects invalid and unresolved requests with stable codes', async () => {
        const literal = await buildCircleSketch({ id: 's1', name: 'Circle A', radius: 5 });
        const bound = await buildCircleSketch({
            id: 's1',
            name: 'Circle A',
            radius: 5,
            parameterName: 'radius'
        });
        const other = await buildCircleSketch({ id: 's2', name: 'Circle B', radius: 4 });
        const dimensionId = literal.dimensions![0].id;
        const otherDimensionId = other.dimensions![0].id;
        const literalDocument = makeDocument({ sketches: [literal] });
        const boundDocument = makeDocument({ parameters: { radius: 5 }, sketches: [bound] });
        const unusedParameterDocument = makeDocument({ parameters: { unused: 1 }, sketches: [literal] });
        const twoSketchDocument = makeDocument({ sketches: [literal, other] });

        await expectCode(literalDocument, [], 'invalid-input');
        await expectCode(literalDocument, [{ sketchId: 's1', dimensionId, parameterName: 'radius', value: 8 }], 'invalid-input');
        await expectCode(literalDocument, [{ sketchId: 'missing', dimensionId, value: 8 }], 'sketch-not-found');
        await expectCode(literalDocument, [{ sketchId: 's1', dimensionId: 'missing', value: 8 }], 'dimension-not-found');
        await expectCode(literalDocument, [{ sketchId: 's1', dimensionId, value: Number.NaN }], 'value-not-finite');
        await expectCode(literalDocument, [{ sketchId: 's1', dimensionId, value: 5 }], 'value-unchanged');
        await expectCode(boundDocument, [{ sketchId: 's1', parameterName: 'missing', value: 8 }], 'parameter-not-found');
        await expectCode(boundDocument, [{ sketchId: 's1', parameterName: 'radius', value: 5 }], 'value-unchanged');
        await expectCode(
            boundDocument,
            [
                { sketchId: 's1', parameterName: 'radius', value: 6 },
                { sketchId: 's1', parameterName: 'radius', value: 7 }
            ],
            'parameter-conflict'
        );
        await expectCode(
            literalDocument,
            [
                { sketchId: 's1', dimensionId, value: 6 },
                { sketchId: 's1', dimensionId, value: 7 }
            ],
            'duplicate-edit'
        );
        await expectCode(unusedParameterDocument, [{ sketchId: 's1', parameterName: 'unused', value: 2 }], 'parameter-not-referenced');
        await expectCode(
            twoSketchDocument,
            [
                { sketchId: 's1', dimensionId, value: 6 },
                { sketchId: 's2', dimensionId: otherDimensionId, value: 6 }
            ],
            'multiple-sketches'
        );
        await expectCode(
            literalDocument,
            Array.from({ length: 9 }, () => ({ sketchId: 's1', dimensionId, value: 6 })),
            'too-many-edits'
        );

        const snapshot = JSON.parse(JSON.stringify(boundDocument)) as NukeCadDocument;
        await expectCode(
            boundDocument,
            [
                { sketchId: 's1', parameterName: 'radius', value: 6 },
                { sketchId: 's1', parameterName: 'radius', value: 7 }
            ],
            'parameter-conflict'
        );
        expect(JSON.stringify(boundDocument)).toBe(JSON.stringify(snapshot));
    });

    it('rejects a conflicting solve', async () => {
        const definition: SketchDef = {
            id: 's1',
            name: 'Conflict',
            datumId: 'datum-xy',
            primitives: [
                { id: 'a', type: 'point', x: 0, y: 0, fixed: true },
                { id: 'b', type: 'point', x: 5, y: 0 }
            ],
            constraints: [
                { id: 'd1', type: 'p2p_distance', p1_id: 'a', p2_id: 'b', distance: 5, driving: true },
                { id: 'd2', type: 'p2p_distance', p1_id: 'a', p2_id: 'b', distance: 6, driving: true }
            ],
            dimensions: [
                {
                    id: 'dim-1',
                    constraintId: 'd1',
                    kind: 'distance',
                    targetIds: ['a', 'b'],
                    driving: true,
                    value: 5
                }
            ]
        };
        const document = makeDocument({ sketches: [definition] });
        expect(validateNukeCadDocument(document).valid).toBe(true);

        const result = await newService().prepare(document, [{ sketchId: 's1', dimensionId: 'dim-1', value: 7 }]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(['solver-failed', 'solve-conflicting']).toContain(result.code);
        }
    });

    it('resamples parametric curves in the candidate document', async () => {
        const definition = await buildCircleSketch({ id: 's1', name: 'Circle A', radius: 5 });
        const document = makeDocument({
            parameters: { amp: 2 },
            sketches: [definition],
            curves: [parametricCurve()]
        });

        const prepared = expectOk(await newService().prepare(document, [{ sketchId: 's1', parameterName: 'amp', value: 4 }]));

        expect(prepared.afterDocument.parameters.amp).toBe(4);
        expect(prepared.afterDocument.curves[0].samples[0][0]).toBeCloseTo(4, 8);
        expect(prepared.afterDocument.curves[0].samples[0][1]).toBeCloseTo(0, 8);
        expect(prepared.changes.map((change) => change.path)).toContain('parameters.amp');
    });

    it('commits the prepared snapshots as one store revision and restores them with one undo', async () => {
        const service = newService();
        const first = await buildCircleSketch({
            id: 's1',
            name: 'Circle A',
            radius: 5,
            parameterName: 'radius'
        });
        const second = await buildCircleSketch({
            id: 's2',
            name: 'Circle B',
            radius: 5,
            parameterName: 'radius'
        });
        const document = makeDocument({ parameters: { radius: 5 }, sketches: [first, second] });
        const prepared = expectOk(await service.prepare(document, [{ sketchId: 's1', parameterName: 'radius', value: 9 }]));

        const store = new CadDocumentStore();
        expect(store.loadDocument(document).success).toBe(true);
        const revision = store.revision;
        let events = 0;
        store.onChange(() => events++);

        const result = service.commit(store, prepared);
        expect(result.success).toBe(true);
        expect(store.revision).toBe(revision + 1);
        expect(events).toBe(1);
        expect(store.dirty).toBe(true);
        expect(store.document?.parameters.radius).toBe(9);
        expect(dimensionValue(store.document!.sketches[0], first.dimensions![0].id)).toBeCloseTo(9, 10);
        expect(dimensionValue(store.document!.sketches[1], second.dimensions![0].id)).toBeCloseTo(9, 10);
        expect(circleRadius(store.document!.sketches[0])).toBeCloseTo(9, 8);
        expect(circleRadius(store.document!.sketches[1])).toBeCloseTo(9, 8);

        expect(store.undo().success).toBe(true);
        expect(store.document?.parameters.radius).toBe(5);
        expect(dimensionValue(store.document!.sketches[0], first.dimensions![0].id)).toBeCloseTo(5, 10);
        expect(dimensionValue(store.document!.sketches[1], second.dimensions![0].id)).toBeCloseTo(5, 10);
        expect(circleRadius(store.document!.sketches[0])).toBeCloseTo(5, 8);
        expect(circleRadius(store.document!.sketches[1])).toBeCloseTo(5, 8);
        expect(store.canUndo).toBe(false);
    });

    it('cascades a parameter-bound pincell dimension through every dependent sketch', async () => {
        const fixture = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'assets', 'gui_pincell.nuke-cad');
        const document = JSON.parse(fs.readFileSync(fixture, 'utf8')) as NukeCadDocument;
        const service = new NukeCadSketchEditService(() => PlanegcsSketchSolver.create());

        const result = await service.prepare(document, [{ sketchId: 'fuel-sketch', dimensionId: 'dimension-5', value: 0.44 }]);

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.result.affectedSketchIds).toEqual(['fuel-sketch', 'clad-sketch']);
        expect(result.result.afterParameters).toEqual({ fuelRadius: 0.44 });
        expect(result.result.afterDocument.parameters.fuelRadius).toBe(0.44);
        expect(validateNukeCadDocument(result.result.afterDocument).valid).toBe(true);
        expect(
            result.result.afterSketches['fuel-sketch'].dimensions?.find((dimension) => dimension.id === 'dimension-5')?.value
        ).toBeCloseTo(0.44, 6);
        expect(
            result.result.afterSketches['clad-sketch'].dimensions?.find((dimension) => dimension.id === 'dimension-9')?.value
        ).toBeCloseTo(0.44, 6);
        expect(result.result.changes.map((change) => change.path)).toEqual([
            'parameters.fuelRadius',
            'sketches.fuel-sketch.dimensions.dimension-5',
            'sketches.clad-sketch.dimensions.dimension-9'
        ]);
        expect(document.parameters.fuelRadius).toBe(0.4);
        expect(document.sketches.find((sketch) => sketch.id === 'fuel-sketch')?.dimensions?.[0].value).toBe(0.4);
    });

    it('compares detached sketch snapshots deterministically', async () => {
        const definition = await buildCircleSketch({ id: 's1', name: 'Circle A', radius: 5 });
        const clone = JSON.parse(JSON.stringify(definition)) as SketchDef;
        expect(sketchDefinitionsEqual(definition, clone)).toBe(true);
        expect(sketchDefinitionsEqual(undefined, undefined)).toBe(true);
        expect(sketchDefinitionsEqual(definition, undefined)).toBe(false);

        clone.name = 'Circle B';
        expect(sketchDefinitionsEqual(definition, clone)).toBe(false);
    });
});
