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

import { describe, it, expect, beforeEach } from 'vitest';
import {
    PlanegcsSketchSolver,
    type SketchPoint,
    type SketchLine,
    type SketchArc,
    type SketchCircle,
    type SketchEllipse,
    type SketchBSpline
} from '../../common/sketch-solver';
import { SketchSession, type ConstraintKind, type SketchTool, type SketchPreview } from './sketch-session';
import { type SketchDef } from '../../common/cad-document';
import { type TopologyRef } from '../../common/topology-refs';

describe('SketchSession', () => {
    async function makeSession(tool: SketchTool = 'select'): Promise<SketchSession> {
        const solver = await PlanegcsSketchSolver.create();
        const session = await SketchSession.create(solver, {
            id: 'sketch-test',
            name: 'Test Sketch',
            datumId: 'xy',
            snap: { radius: 0.25, gridPitch: 1 }
        });
        session.setTool(tool);
        return session;
    }

    function point(session: SketchSession, id: string): SketchPoint {
        return session.getPrimitive(id) as SketchPoint;
    }

    function expectPoint(session: SketchSession, id: string, x: number, y: number): void {
        const p = point(session, id);
        expect(p.x).toBeCloseTo(x, 10);
        expect(p.y).toBeCloseTo(y, 10);
    }

    function faceRef(featureId: string): TopologyRef {
        return {
            featureId,
            kind: 'face',
            fingerprint: {
                surfaceType: 'plane',
                area: 10,
                center: [0, 0, 0],
                normal: [0, 0, 1]
            }
        };
    }

    beforeEach(() => {
        // Each test creates its own solver via makeSession.
    });

    describe('tool click sequences', () => {
        it('places a point with the point tool', async () => {
            const session = await makeSession('point');
            await session.click({ x: 3, y: 4 });
            expect(session.getPrimitives().filter((p) => p.type === 'point')).toHaveLength(1);
            const id = session.getPrimitiveIds()[0];
            expectPoint(session, id, 3, 4);
        });

        it('places a line with two clicks', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const lines = session.getPrimitives().filter((p) => p.type === 'line');
            expect(lines).toHaveLength(1);
            const l = lines[0] as SketchLine;
            expectPoint(session, l.p1Id, 0, 0);
            expectPoint(session, l.p2Id, 10, 0);
        });

        it('cancels an in-progress line', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            expect(session.getPrimitives().filter((p) => p.type === 'point')).toHaveLength(1);
            session.cancel();
            expect(session.getPrimitives()).toHaveLength(0);
            expect(session.getTool()).toBe('line');
        });

        it('places a circle with center + radius click', async () => {
            const session = await makeSession('circle');
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 10, y: 0 });
            const circles = session.getPrimitives().filter((p) => p.type === 'circle');
            expect(circles).toHaveLength(1);
            expect(circles[0].radius).toBeCloseTo(5, 10);
        });

        it('cancels an in-progress circle', async () => {
            const session = await makeSession('circle');
            await session.click({ x: 0, y: 0 });
            session.cancel();
            expect(session.getPrimitives()).toHaveLength(0);
        });

        it('places a 3-point arc', async () => {
            const session = await makeSession('arc3');
            await session.click({ x: 5, y: 0 }); // start
            await session.click({ x: 2.5, y: 2.5 }); // mid
            await session.click({ x: 0, y: 0 }); // end
            const arcs = session.getPrimitives().filter((p) => p.type === 'arc');
            expect(arcs).toHaveLength(1);
        });

        it('cancels an in-progress arc', async () => {
            const session = await makeSession('arc3');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 5 });
            session.cancel();
            expect(session.getPrimitives()).toHaveLength(0);
        });

        it('places a rectangle with two corner clicks', async () => {
            const session = await makeSession('rectangle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 5 });
            const lines = session.getPrimitives().filter((p) => p.type === 'line');
            expect(lines).toHaveLength(4);
            const points = session.getPrimitives().filter((p) => p.type === 'point');
            expect(points).toHaveLength(4);
        });

        it('cancels an in-progress rectangle', async () => {
            const session = await makeSession('rectangle');
            await session.click({ x: 0, y: 0 });
            session.cancel();
            expect(session.getPrimitives()).toHaveLength(0);
        });
    });

    describe('hover previews', () => {
        it('previews a line after the first click', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            const preview = session.hover({ x: 10, y: 5 });
            expect(preview.type).toBe('line');
            const linePreview = preview as Extract<SketchPreview, { type: 'line' }>;
            expect(linePreview.p1).toEqual({ x: 0, y: 0 });
            expect(linePreview.p2).toEqual({ x: 10, y: 5 });
        });

        it('previews a circle after the center click', async () => {
            const session = await makeSession('circle');
            await session.click({ x: 0, y: 0 });
            const preview = session.hover({ x: 5, y: 0 });
            expect(preview.type).toBe('circle');
            const circlePreview = preview as Extract<SketchPreview, { type: 'circle' }>;
            expect(circlePreview.radius).toBeCloseTo(5, 10);
        });

        it('previews a rectangle after the first corner click', async () => {
            const session = await makeSession('rectangle');
            await session.click({ x: 0, y: 0 });
            const preview = session.hover({ x: 10, y: 5 });
            expect(preview.type).toBe('rectangle');
        });
    });

    describe('snap and auto-constraints', () => {
        it('adds a coincident auto-constraint when placing near an existing point', async () => {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 0.1, y: 0.1 });
            const coincident = session.getConstraints().filter((c) => c.kind === 'coincident');
            expect(coincident).toHaveLength(1);
            expect(session.getStatus().lastAutoConstraints.some((a) => a.kind === 'coincident')).toBe(true);
        });

        it('does not add coincident when snapping is disabled', async () => {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 0.1, y: 0.1 }, { disableSnap: true });
            const coincident = session.getConstraints().filter((c) => c.kind === 'coincident');
            expect(coincident).toHaveLength(0);
        });

        it('auto-adds horizontal constraint for near-horizontal lines', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0.05 });
            const horizontals = session.getConstraints().filter((c) => c.kind === 'horizontal');
            expect(horizontals).toHaveLength(1);
            expect(session.getStatus().lastAutoConstraints.some((a) => a.kind === 'horizontal')).toBe(true);
        });

        it('auto-adds vertical constraint for near-vertical lines', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 0.05, y: 10 });
            const verticals = session.getConstraints().filter((c) => c.kind === 'vertical');
            expect(verticals).toHaveLength(1);
        });

        it('auto-adds a point-on-object constraint when snapping to a line', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });

            await session.setTool('point');
            // Click near the line but away from the midpoint so on-curve wins
            // over midpoint snap (snap radius is 0.25).
            await session.click({ x: 3, y: 0.1 });

            const po = session.getConstraints().filter((c) => c.kind === 'pointOnObject');
            expect(po).toHaveLength(1);
            expect(session.getStatus().lastAutoConstraints.some((a) => a.kind === 'pointOnObject')).toBe(true);

            const point = session
                .getPrimitives()
                .filter((p) => p.type === 'point')
                .pop() as SketchPoint;
            expect(point.y).toBeCloseTo(0, 10);
        });
    });

    describe('constraint arity validation', () => {
        async function setupForConstraint(kind: ConstraintKind): Promise<SketchSession> {
            const session = await makeSession('select');
            if (kind === 'coincident' || kind === 'fix' || kind === 'distance') {
                await session.setTool('point');
                await session.click({ x: 0, y: 0 });
                await session.click({ x: 10, y: 0 });
            } else if (
                kind === 'horizontal' ||
                kind === 'vertical' ||
                kind === 'parallel' ||
                kind === 'perpendicular' ||
                kind === 'angle'
            ) {
                await session.setTool('line');
                await session.click({ x: 0, y: 0 });
                await session.click({ x: 10, y: 0 });
                await session.click({ x: 0, y: 0 });
                await session.click({ x: 0, y: 10 });
            } else if (kind === 'radius' || kind === 'concentric' || kind === 'equal' || kind === 'tangent') {
                await session.setTool('circle');
                await session.click({ x: 0, y: 0 });
                await session.click({ x: 5, y: 0 });
                await session.setTool('circle');
                await session.click({ x: 10, y: 0 });
                await session.click({ x: 14, y: 0 });
            }
            if (kind === 'symmetry') {
                await session.setTool('point');
                await session.click({ x: -1, y: 0 });
                await session.click({ x: 1, y: 0 });
                await session.setTool('line');
                await session.click({ x: 0, y: -1 });
                await session.click({ x: 0, y: 1 });
            }
            return session;
        }

        const cases: Array<{ kind: ConstraintKind; wrongIds: string[]; expected: string }> = [
            { kind: 'coincident', wrongIds: ['point-1'], expected: 'requires exactly 2' },
            { kind: 'fix', wrongIds: ['point-1', 'point-2'], expected: 'requires exactly 1' },
            { kind: 'horizontal', wrongIds: ['point-1', 'point-2'], expected: 'requires exactly 1' },
            { kind: 'vertical', wrongIds: ['point-1', 'point-2'], expected: 'requires exactly 1' },
            { kind: 'parallel', wrongIds: ['line-1'], expected: 'requires exactly 2' },
            { kind: 'perpendicular', wrongIds: ['line-1'], expected: 'requires exactly 2' },
            { kind: 'angle', wrongIds: ['line-1'], expected: 'requires exactly 2' },
            { kind: 'distance', wrongIds: ['point-1'], expected: 'requires exactly 2' },
            { kind: 'radius', wrongIds: ['circle-1', 'circle-2'], expected: 'requires exactly 1' },
            { kind: 'concentric', wrongIds: ['circle-1'], expected: 'requires exactly 2' },
            { kind: 'equal', wrongIds: ['circle-1'], expected: 'requires exactly 2' },
            { kind: 'tangent', wrongIds: ['circle-1'], expected: 'requires exactly 2' },
            { kind: 'symmetry', wrongIds: ['point-1', 'point-2'], expected: 'requires exactly 3' }
        ];

        it.each(cases)('rejects $kind with wrong arity', async ({ kind, wrongIds, expected }) => {
            const session = await setupForConstraint(kind);
            const result = await session.addConstraint(kind, wrongIds, kind === 'distance' || kind === 'radius' ? 5 : undefined);
            expect(result.success).toBe(false);
            expect(result.error).toContain(expected);
        });

        it('rejects distance without a value', async () => {
            const session = await setupForConstraint('distance');
            const result = await session.addConstraint('distance', ['point-1', 'point-2']);
            expect(result.success).toBe(false);
            expect(result.error).toContain('value');
        });

        it('rejects radius without a value', async () => {
            const session = await setupForConstraint('radius');
            const result = await session.addConstraint('radius', ['circle-1']);
            expect(result.success).toBe(false);
            expect(result.error).toContain('value');
        });

        it('rejects a constraint referencing an unknown primitive', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const result = await session.addConstraint('horizontal', ['missing']);
            expect(result.success).toBe(false);
            expect(result.error).toContain('Unknown');
        });
    });

    describe('fully constrained rectangle', () => {
        it('reaches DOF 0 with rectangle, coincident corners, and driving distances', async () => {
            const session = await makeSession('rectangle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 5 });

            // Auto-constraints already added horizontal/vertical for sides.
            const horizontals = session
                .getConstraints()
                .filter((c) => c.kind === 'horizontal')
                .map((c) => c.id);
            const verticals = session
                .getConstraints()
                .filter((c) => c.kind === 'vertical')
                .map((c) => c.id);
            expect(horizontals.length).toBeGreaterThanOrEqual(2);
            expect(verticals.length).toBeGreaterThanOrEqual(2);

            const points = session.getPrimitives().filter((p) => p.type === 'point');
            const lines = session.getPrimitives().filter((p) => p.type === 'line');
            expect(points).toHaveLength(4);
            expect(lines).toHaveLength(4);

            // Identify bottom-left and bottom-right-ish points by solved coords.
            const sortedByX = [...points].sort((a, b) => (a as SketchPoint).x - (b as SketchPoint).x);
            const leftIds = sortedByX.slice(0, 2).map((p) => p.id);
            const rightIds = sortedByX.slice(2).map((p) => p.id);
            const bottomLeft = leftIds.map((id) => point(session, id)).sort((a, b) => a.y - b.y)[0];
            const bottomRight = rightIds.map((id) => point(session, id)).sort((a, b) => a.y - b.y)[0];
            const topLeft = leftIds.map((id) => point(session, id)).sort((a, b) => b.y - a.y)[0];

            // Fix the bottom-left corner.
            await session.addConstraint('fix', [bottomLeft.id]);

            // Constrain width and height.
            await session.addConstraint('distance', [bottomLeft.id, bottomRight.id], 10);
            await session.addConstraint('distance', [bottomLeft.id, topLeft.id], 5, { direction: 'vertical' });

            expect(session.getStatus().dof).toBe(0);
            expect(session.getStatus().fullyConstrained).toBe(true);
        });
    });

    describe('drag solving', () => {
        it('moves a point during drag and commits on endDrag', async () => {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            const id = session.getPrimitiveIds()[0];

            session.beginDrag([id]);
            await session.dragTo({ x: 3, y: 4 });
            let during = point(session, id);
            expect(during.x).toBeCloseTo(3, 10);
            expect(during.y).toBeCloseTo(4, 10);

            await session.endDrag();
            const after = point(session, id);
            expect(after.x).toBeCloseTo(3, 10);
            expect(after.y).toBeCloseTo(4, 10);
        });

        it('leaves committed geometry untouched when a drag solve fails', async () => {
            const session = await makeSession('select');
            // Two points locked 5 units apart.
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            const ids = session.getPrimitiveIds();
            await session.addConstraint('fix', [ids[0]]);
            await session.addConstraint('distance', [ids[0], ids[1]], 5);

            // Dragging the second point to (10,0) conflicts with the distance constraint.
            session.beginDrag([ids[1]]);
            await session.dragTo({ x: 10, y: 0 });
            await session.endDrag();

            expectPoint(session, ids[1], 5, 0);
        });

        it('does not pin a dropped point after drag commit', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            const lines = session.getPrimitives().filter((p) => p.type === 'line') as SketchLine[];
            expect(lines).toHaveLength(1);
            const lineId = lines[0].id;
            const p1Id = lines[0].p1Id;
            const p2Id = lines[0].p2Id;

            await session.addConstraint('horizontal', [lineId]);
            await session.addConstraint('distance', [p1Id, p2Id], 5);

            // Drag the first endpoint and commit; it should land at (3, 4).
            session.beginDrag([p1Id]);
            await session.dragTo({ x: 3, y: 4 });
            await session.endDrag();
            expectPoint(session, p1Id, 3, 4);

            // Drag the second endpoint horizontally. The first endpoint must
            // move to maintain the distance constraint; it is no longer pinned.
            session.beginDrag([p2Id]);
            await session.dragTo({ x: 10, y: 4 });
            await session.endDrag();

            const a = point(session, p1Id);
            const b = point(session, p2Id);
            expect(b.x).toBeCloseTo(10, 10);
            expect(b.y).toBeCloseTo(4, 10);
            expect(Math.abs(b.x - a.x)).toBeCloseTo(5, 10);
            expect(a.y).toBeCloseTo(4, 10);
            // A moved away from its committed x=3 to satisfy the distance.
            expect(Math.abs(a.x - 3)).toBeGreaterThan(0.01);
        });

        it('preserves DOF across a SketchDef round-trip after drag', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            const lines = session.getPrimitives().filter((p) => p.type === 'line') as SketchLine[];
            const lineId = lines[0].id;
            const p1Id = lines[0].p1Id;
            const p2Id = lines[0].p2Id;

            await session.addConstraint('horizontal', [lineId]);
            await session.addConstraint('fix', [p1Id]);

            // Drag the free endpoint and commit.
            session.beginDrag([p2Id]);
            await session.dragTo({ x: 7, y: 0 });
            await session.endDrag();

            const beforeDof = session.getStatus().dof;

            const def = session.toSketchDef();
            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);

            expect(restored.getStatus().dof).toBe(beforeDof);
            expect(restored.getStatus().dof).toBeGreaterThanOrEqual(0);
        });
    });

    describe('delete', () => {
        it('removes a primitive and cascades attached constraints', async () => {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            const id = session.getPrimitiveIds()[0];
            await session.addConstraint('fix', [id]);
            expect(session.getConstraints()).toHaveLength(1);

            await session.deletePrimitive(id);
            expect(session.getPrimitive(id)).toBeUndefined();
            expect(session.getConstraints()).toHaveLength(0);
        });

        it('removes a constraint by id', async () => {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            const result = await session.addConstraint('fix', [session.getPrimitiveIds()[0]]);
            expect(result.success).toBe(true);

            await session.deleteConstraint(result.constraintId!);
            expect(session.getConstraints()).toHaveLength(0);
        });
    });

    describe('serialization', () => {
        it('round-trips coordinates through SketchDef', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 5 });

            const def = session.toSketchDef();
            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);

            const originalPoints = session.getPrimitives().filter((p) => p.type === 'point');
            const restoredPoints = restored.getPrimitives().filter((p) => p.type === 'point');
            expect(restoredPoints).toHaveLength(originalPoints.length);

            for (const original of originalPoints) {
                const rp = restored.getPrimitive(original.id) as SketchPoint;
                expect(rp.x).toBeCloseTo((original as SketchPoint).x, 10);
                expect(rp.y).toBeCloseTo((original as SketchPoint).y, 10);
            }
        });

        it('produces a SketchDef that validates as a document', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 5 });
            const validation = session.validateDocument();
            expect(validation.valid).toBe(true);
            expect(validation.issues).toHaveLength(0);
        });

        it('preserves construction flag through round-trip', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const lineId = session.getPrimitives().filter((p) => p.type === 'line')[0].id;
            await session.setConstruction(lineId, true);
            expect(session.getPrimitive(lineId)?.construction).toBe(true);

            const def = session.toSketchDef();
            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);
            expect(restored.getPrimitive(lineId)?.construction).toBe(true);
        });

        it('preserves fixed points through round-trip', async () => {
            const session = await makeSession('point');
            await session.click({ x: 2, y: 3 });
            const id = session.getPrimitiveIds()[0];
            await session.addConstraint('fix', [id]);

            const def = session.toSketchDef();
            expect(def.primitives.find((p) => p.id === id)?.fixed).toBe(true);

            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);
            expect(restored.getConstraints().some((c) => c.kind === 'fix' && c.targetIds[0] === id)).toBe(true);
        });

        it('round-trips external geometry references through SketchDef', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 5 });

            const ref = faceRef('base');
            session.addExternalRef(ref);
            expect(session.getExternalRefs()).toHaveLength(1);

            const def = session.toSketchDef();
            expect(def.externalRefs).toHaveLength(1);
            expect(def.externalRefs?.[0].featureId).toBe('base');

            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);
            expect(restored.getExternalRefs()).toHaveLength(1);

            restored.removeExternalRef(0);
            expect(restored.getExternalRefs()).toHaveLength(0);
        });
    });

    describe('change events', () => {
        it('emits a change event after adding geometry', async () => {
            const session = await makeSession('point');
            let count = 0;
            session.onChange(() => {
                count++;
            });
            await session.click({ x: 1, y: 1 });
            expect(count).toBeGreaterThan(0);
        });
    });

    describe('dimensions', () => {
        it('creates a dimension when adding a driving distance constraint', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();

            const result = await session.addConstraint('distance', [ids[0], ids[1]], 5);
            expect(result.success).toBe(true);
            expect(result.dimensionId).toBeDefined();

            const dimensions = session.getDimensions();
            expect(dimensions).toHaveLength(1);
            expect(dimensions[0].kind).toBe('distance');
            expect(dimensions[0].value).toBeCloseTo(5, 10);
            expect(dimensions[0].driving).toBe(true);
        });

        it('auto-dimension flow: line completion followed by distance constraint creates a driving length dimension', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const line = session.getPrimitives().filter((p) => p.type === 'line')[0] as SketchLine;

            expect(session.getDimensions()).toHaveLength(0);

            const result = await session.addConstraint('distance', [line.p1Id, line.p2Id], 7, { direction: 'point-point' });
            expect(result.success).toBe(true);

            const dimensions = session.getDimensions();
            expect(dimensions).toHaveLength(1);
            expect(dimensions[0].kind).toBe('distance');
            expect(dimensions[0].value).toBeCloseTo(7, 10);
            expect(dimensions[0].driving).toBe(true);
        });

        it('auto-dimension flow: circle completion followed by radius constraint creates a driving radius dimension', async () => {
            const session = await makeSession('circle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            const circleId = session.getPrimitives().filter((p) => p.type === 'circle')[0].id;

            expect(session.getDimensions()).toHaveLength(0);

            const result = await session.addConstraint('radius', [circleId], 3);
            expect(result.success).toBe(true);

            const dimensions = session.getDimensions();
            expect(dimensions).toHaveLength(1);
            expect(dimensions[0].kind).toBe('radius');
            expect(dimensions[0].value).toBeCloseTo(3, 10);
            expect(dimensions[0].driving).toBe(true);
        });

        it('auto-dimension flow: no dimension is created when the input is dismissed', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });

            // Simulate the dismiss path: the entity exists but no constraint was applied.
            expect(session.getPrimitives().filter((p) => p.type === 'line')).toHaveLength(1);
            expect(session.getDimensions()).toHaveLength(0);
        });

        it('creates a diameter dimension via addDimension', async () => {
            const session = await makeSession('circle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            const circleId = session.getPrimitives().filter((p) => p.type === 'circle')[0].id;

            const result = await session.addDimension('diameter', [circleId], 12);
            expect(result.success).toBe(true);

            const dimension = session.getDimension(result.dimensionId!);
            expect(dimension).toBeDefined();
            expect(dimension!.kind).toBe('diameter');
            expect(dimension!.value).toBe(12);

            const circle = session.getPrimitive(circleId) as import('../../common/sketch-solver').SketchCircle;
            expect(circle.radius).toBeCloseTo(6, 10);
        });

        it('edits a dimension value and re-solves', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            await session.addConstraint('fix', [ids[0]]);
            const result = await session.addDimension('distance', [ids[0], ids[1]], 5);
            expect(result.success).toBe(true);

            const edit = await session.editDimension(result.dimensionId!, { value: 8 });
            expect(edit.success).toBe(true);

            const b = session.getPrimitive(ids[1]) as SketchPoint;
            expect(b.x).toBeCloseTo(8, 10);
        });

        it('toggles a dimension between driving and reference', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            await session.addConstraint('fix', [ids[0]]);
            const result = await session.addDimension('distance', [ids[0], ids[1]], 5);
            const dimensionId = result.dimensionId!;

            const reference = await session.editDimension(dimensionId, { driving: false });
            expect(reference.success).toBe(true);
            expect(session.getDimension(dimensionId)!.driving).toBe(false);

            const driving = await session.editDimension(dimensionId, { driving: true });
            expect(driving.success).toBe(true);
            expect(session.getDimension(dimensionId)!.driving).toBe(true);
        });

        it('binds a dimension to a parameter and re-solves on parameter change', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            await session.addConstraint('fix', [ids[0]]);
            const result = await session.addDimension('distance', [ids[0], ids[1]], 5);

            await session.addParameter('width', 5);
            const bind = await session.editDimension(result.dimensionId!, { parameter: 'width' });
            expect(bind.success).toBe(true);

            await session.setParameter('width', 9);
            const b = session.getPrimitive(ids[1]) as SketchPoint;
            expect(b.x).toBeCloseTo(9, 10);
            expect(session.getDimension(result.dimensionId!)!.value).toBeCloseTo(9, 10);
        });

        it('rejects binding to an unknown parameter', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            const result = await session.addDimension('distance', [ids[0], ids[1]], 5);

            const bind = await session.editDimension(result.dimensionId!, { parameter: 'missing' });
            expect(bind.success).toBe(false);
            expect(bind.error).toContain("Unknown parameter 'missing'");
        });

        it('deletes a dimension and its constraint', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            const result = await session.addDimension('distance', [ids[0], ids[1]], 5);

            const deleted = await session.deleteDimension(result.dimensionId!);
            expect(deleted.success).toBe(true);
            expect(session.getDimensions()).toHaveLength(0);
            expect(session.getConstraints().some((c) => c.id === result.constraintId)).toBe(false);
        });

        it('round-trips dimension metadata through SketchDef', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            await session.addParameter('width', 5);
            const result = await session.addDimension('distance', [ids[0], ids[1]], 'width', {
                driving: true,
                labelOffset: [1, 2]
            });

            const def = session.toSketchDef();
            expect(def.dimensions).toHaveLength(1);
            expect(def.dimensions![0].parameter).toBe('width');
            expect(def.dimensions![0].labelOffset).toEqual([1, 2]);

            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);
            const dimension = restored.getDimension(result.dimensionId!);
            expect(dimension).toBeDefined();
            expect(dimension!.parameter).toBe('width');
            expect(dimension!.labelOffset).toEqual([1, 2]);
            expect(dimension!.driving).toBe(true);
        });
    });

    describe('parameters', () => {
        it('creates and updates a parameter', async () => {
            const session = await makeSession('select');
            const add = await session.addParameter('width', 10);
            expect(add.success).toBe(true);

            const update = await session.setParameter('width', 20);
            expect(update.success).toBe(true);
            expect(session.getParameters().width).toBe(20);
        });

        it('rejects non-finite parameter values', async () => {
            const session = await makeSession('select');
            const result = await session.setParameter('bad', NaN);
            expect(result.success).toBe(false);
        });

        it('rejects removing a parameter used by a driving dimension', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            await session.addParameter('width', 5);
            const result = await session.addDimension('distance', [ids[0], ids[1]], 'width');

            const removed = session.removeParameter('width');
            expect(removed.success).toBe(false);
            expect(removed.error).toContain(result.dimensionId);
        });

        it('allows removing a parameter used only by reference dimensions', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const ids = session.getPrimitiveIds();
            await session.addParameter('width', 5);
            const result = await session.addDimension('distance', [ids[0], ids[1]], 'width', { driving: false });

            const removed = session.removeParameter('width');
            expect(removed.success).toBe(true);
            expect(session.getDimension(result.dimensionId!)!.parameter).toBeUndefined();
        });
    });

    describe('symmetry constraint arity', () => {
        it('rejects symmetry with fewer than three primitives', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: -1, y: 0 });
            await session.click({ x: 1, y: 0 });
            const ids = session.getPrimitiveIds();

            const result = await session.addConstraint('symmetry', [ids[0], ids[1]]);
            expect(result.success).toBe(false);
            expect(result.error).toContain('requires exactly 3');
        });

        it('accepts symmetry with a line mirror', async () => {
            const session = await makeSession('select');
            await session.setTool('point');
            await session.click({ x: -1, y: 0 });
            await session.click({ x: 1, y: 0 });
            await session.setTool('line');
            await session.click({ x: 0, y: -1 });
            await session.click({ x: 0, y: 1 });
            const pointIds = session
                .getPrimitives()
                .filter((p) => p.type === 'point')
                .map((p) => p.id);
            const lineId = session.getPrimitives().filter((p) => p.type === 'line')[0].id;

            const result = await session.addConstraint('symmetry', [pointIds[0], pointIds[1], lineId]);
            expect(result.success).toBe(true);
        });
    });

    describe('snap toggles', () => {
        it('defaults to enabled with the default pixel radius', async () => {
            const session = await makeSession('point');
            expect(session.isSnapEnabled()).toBe(true);
            expect(session.getSnapRadiusPx()).toBe(SketchSession.DEFAULT_SNAP_RADIUS_PX);
        });

        it('places points freely when disabled', async () => {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            session.setSnapEnabled(false);
            expect(session.isSnapEnabled()).toBe(false);
            // With snap on, this click would land on the existing point via
            // endpoint snap and add a coincident auto-constraint.
            await session.click({ x: 0.05, y: 0.05 });
            const points = session.getPrimitives().filter((p) => p.type === 'point') as SketchPoint[];
            expect(points).toHaveLength(2);
            expect(points[1].x).toBeCloseTo(0.05, 10);
            expect(points[1].y).toBeCloseTo(0.05, 10);
            expect(session.getConstraints().filter((c) => c.kind === 'coincident')).toHaveLength(0);
        });

        it('keeps grid snapping inert while disabled', async () => {
            const session = await makeSession('point');
            session.setSnapEnabled(false);
            await session.click({ x: 0.42, y: 0.77 });
            const placed = point(session, session.getPrimitiveIds()[0]);
            // Grid pitch is 1; grid snapping would round both coordinates.
            expect(placed.x).toBeCloseTo(0.42, 10);
            expect(placed.y).toBeCloseTo(0.77, 10);
        });

        it('restores snapping when re-enabled', async () => {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            session.setSnapEnabled(false);
            await session.click({ x: 0.1, y: 0.1 });
            expect(session.getConstraints().filter((c) => c.kind === 'coincident')).toHaveLength(0);

            session.setSnapEnabled(true);
            await session.click({ x: -0.08, y: 0.08 });
            expect(session.getConstraints().filter((c) => c.kind === 'coincident')).toHaveLength(1);
            const points = session.getPrimitives().filter((p) => p.type === 'point') as SketchPoint[];
            const last = points[points.length - 1];
            expect(last.x).toBeCloseTo(0, 10);
            expect(last.y).toBeCloseTo(0, 10);
        });

        it('scales the effective snap reach with the pixel radius', async () => {
            const session = await makeSession('point');
            // Seed a non-grid-aligned point; disableSnap bypasses the engine.
            await session.click({ x: 3.6, y: 0.2 }, { disableSnap: true });

            // Default 12px maps to a 0.25 model-unit reach: 0.28 away stays
            // free and falls through to the integer grid.
            const far = session.hover({ x: 3.88, y: 0.2 }) as Extract<SketchPreview, { type: 'point' }>;
            expect(far.point.x).toBeCloseTo(4, 10);
            expect(far.point.y).toBeCloseTo(0, 10);

            session.setSnapRadius(24); // double reach: the same probe now snaps
            expect(session.getSnapRadiusPx()).toBe(24);
            const near = session.hover({ x: 3.88, y: 0.2 }) as Extract<SketchPreview, { type: 'point' }>;
            expect(near.point.x).toBeCloseTo(3.6, 10);
            expect(near.point.y).toBeCloseTo(0.2, 10);

            session.setSnapRadius(SketchSession.DEFAULT_SNAP_RADIUS_PX);
            const back = session.hover({ x: 3.88, y: 0.2 }) as Extract<SketchPreview, { type: 'point' }>;
            expect(back.point.x).toBeCloseTo(4, 10);
            expect(back.point.y).toBeCloseTo(0, 10);
        });

        it('rejects invalid radii and keeps the previous value', async () => {
            const session = await makeSession('select');
            expect(() => session.setSnapRadius(0)).toThrow();
            expect(() => session.setSnapRadius(-3)).toThrow();
            expect(() => session.setSnapRadius(Number.NaN)).toThrow();
            expect(session.getSnapRadiusPx()).toBe(SketchSession.DEFAULT_SNAP_RADIUS_PX);
        });

        it('notifies listeners when snap state changes', async () => {
            const session = await makeSession('select');
            let changes = 0;
            session.onChange(() => changes++);
            session.setSnapEnabled(false);
            session.setSnapEnabled(false); // same value: no duplicate emit
            session.setSnapRadius(24);
            session.setSnapEnabled(true);
            expect(changes).toBe(3);
        });
    });

    describe('ellipse tool', () => {
        it('places an ellipse with three clicks', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 }); // center
            await session.click({ x: 5, y: 0 }); // major axis endpoint
            await session.click({ x: 2, y: 3 }); // minor radius via perpendicular distance

            const ellipses = session.getPrimitives().filter((p) => p.type === 'ellipse');
            expect(ellipses).toHaveLength(1);
            const ellipse = ellipses[0] as SketchEllipse;
            expect(ellipse.radmin).toBeCloseTo(3, 10);
            // major = 5, minor = 3 -> focal distance 4 along +x.
            const focus1 = point(session, ellipse.focus1Id);
            expectPoint(session, ellipse.centerId, 0, 0);
            expect(focus1.x).toBeCloseTo(4, 10);
            expect(focus1.y).toBeCloseTo(0, 10);
        });

        it('rejects an equal-radius third click and hints at the circle tool', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 2, y: 5 }); // perpendicular distance 5 == major radius

            expect(session.getPrimitives().filter((p) => p.type === 'ellipse')).toHaveLength(0);
            expect(session.getStatus().hint).toContain('Circle tool');
            // The gesture stays alive: a corrected click completes the ellipse.
            await session.click({ x: 2, y: 4 });
            expect(session.getPrimitives().filter((p) => p.type === 'ellipse')).toHaveLength(1);
            expect(session.getStatus().hint).toBeUndefined();
        });

        it('clamps a minor radius above the major radius with a hint', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 2, y: 9 }); // perpendicular distance 9 > major 5

            const ellipses = session.getPrimitives().filter((p) => p.type === 'ellipse');
            expect(ellipses).toHaveLength(1);
            const ellipse = ellipses[0] as SketchEllipse;
            expect(ellipse.radmin).toBeLessThan(5);
            expect(ellipse.radmin).toBeCloseTo(5 * (1 - 1e-9), 12);
            expect(session.getStatus().hint).toContain('clamped');
        });

        it('cancels an in-progress ellipse', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            session.cancel();
            expect(session.getPrimitives()).toHaveLength(0);
        });

        it('round-trips an ellipse through SketchDef (snake and camel aliases)', async () => {
            for (const camel of [false, true]) {
                const session = await makeSession('ellipse');
                await session.click({ x: 0, y: 0 });
                await session.click({ x: 5, y: 0 });
                await session.click({ x: 2, y: 3 });
                const def = session.toSketchDef();

                const ellipseRow = def.primitives.find((p) => p.type === 'ellipse')!;
                expect(ellipseRow).toBeDefined();
                if (camel) {
                    const { c_id, focus1_id, ...rest } = ellipseRow as Record<string, unknown>;
                    def.primitives = def.primitives.map((p) =>
                        p.type === 'ellipse' ? { ...rest, centerId: c_id, focus1Id: focus1_id } : p
                    );
                }

                const solver = await PlanegcsSketchSolver.create();
                const restored = await SketchSession.fromSketchDef(def, solver);
                const restoredEllipses = restored.getPrimitives().filter((p) => p.type === 'ellipse');
                expect(restoredEllipses).toHaveLength(1);
                const ellipse = restoredEllipses[0] as SketchEllipse;
                expect(ellipse.radmin).toBeCloseTo(3, 10);
                expect(restored.getPrimitive(ellipse.centerId)).toBeDefined();
                expect(restored.getPrimitive(ellipse.focus1Id)).toBeDefined();
            }
        });
    });

    describe('bspline tool', () => {
        it('places a B-spline through placed poles on finish', async () => {
            const session = await makeSession('bspline');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 3, y: 6 });
            await session.click({ x: 6, y: 0 });
            await session.finish();

            const curves = session.getPrimitives().filter((p) => p.type === 'bspline');
            expect(curves).toHaveLength(1);
            const curve = curves[0] as SketchBSpline;
            expect(curve.poleIds).toHaveLength(3);
            expect(curve.degree).toBe(2);
            expect(curve.weights).toEqual([1, 1, 1]);
            expect(curve.periodic).toBe(false);
            expect(curve.knots).toEqual([0, 1]);
            expect(curve.mult).toEqual([3, 3]);
        });

        it('uses degree 3 for four or more poles', async () => {
            const session = await makeSession('bspline');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 2, y: 4 });
            await session.click({ x: 4, y: 4 });
            await session.click({ x: 6, y: 0 });
            await session.finish();

            const curve = session.getPrimitives().filter((p) => p.type === 'bspline')[0] as SketchBSpline;
            expect(curve.degree).toBe(3);
            expect(curve.poleIds).toHaveLength(4);
        });

        it('discards a lone pole on finish', async () => {
            const session = await makeSession('bspline');
            await session.click({ x: 1, y: 1 });
            await session.finish();
            expect(session.getPrimitives()).toHaveLength(0);
        });

        it('cancels an in-progress B-spline and removes its poles', async () => {
            const session = await makeSession('bspline');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 3, y: 6 });
            session.cancel();
            expect(session.getPrimitives()).toHaveLength(0);
        });

        it('previews the control polygon while placing poles', async () => {
            const session = await makeSession('bspline');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 3, y: 6 });
            const preview = session.hover({ x: 6, y: 0 });
            expect(preview.type).toBe('bspline');
            const bsplinePreview = preview as Extract<SketchPreview, { type: 'bspline' }>;
            expect(bsplinePreview.poles).toHaveLength(3);
            expect(bsplinePreview.poles[2]).toEqual({ x: 6, y: 0 });
        });

        it('round-trips a B-spline through SketchDef (snake and camel aliases)', async () => {
            for (const camel of [false, true]) {
                const session = await makeSession('bspline');
                await session.click({ x: 0, y: 0 });
                await session.click({ x: 3, y: 6 });
                await session.click({ x: 6, y: 0 });
                await session.finish();
                const def = session.toSketchDef();

                const row = def.primitives.find((p) => p.type === 'bspline')!;
                expect(row).toBeDefined();
                if (camel) {
                    const { pole_ids, ...rest } = row as Record<string, unknown>;
                    def.primitives = def.primitives.map((p) => (p.type === 'bspline' ? { ...rest, poleIds: pole_ids } : p));
                }

                const solver = await PlanegcsSketchSolver.create();
                const restored = await SketchSession.fromSketchDef(def, solver);
                const curves = restored.getPrimitives().filter((p) => p.type === 'bspline');
                expect(curves).toHaveLength(1);
                const curve = curves[0] as SketchBSpline;
                expect(curve.degree).toBe(2);
                expect(curve.poleIds).toHaveLength(3);
                expect(curve.knots).toEqual([0, 1]);
                expect(curve.mult).toEqual([3, 3]);
            }
        });
    });

    describe('curve constraint conservatism', () => {
        it('rejects curve-level constraints on ellipses and B-splines', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 2, y: 3 });
            const ellipseId = session.getPrimitives().filter((p) => p.type === 'ellipse')[0].id;

            const horizontal = await session.addConstraint('horizontal', [ellipseId]);
            expect(horizontal.success).toBe(false);
            const radius = await session.addConstraint('radius', [ellipseId]);
            expect(radius.success).toBe(false);

            const bsplineSession = await makeSession('bspline');
            await bsplineSession.click({ x: 0, y: 0 });
            await bsplineSession.click({ x: 3, y: 6 });
            await bsplineSession.finish();
            const bsplineId = bsplineSession.getPrimitives().filter((p) => p.type === 'bspline')[0].id;

            const bsplineHorizontal = await bsplineSession.addConstraint('horizontal', [bsplineId]);
            expect(bsplineHorizontal.success).toBe(false);
        });

        it('still allows point-level constraints on ellipse and B-spline points', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 2, y: 3 });
            const ellipse = session.getPrimitives().filter((p) => p.type === 'ellipse')[0] as SketchEllipse;

            const fix = await session.addConstraint('fix', [ellipse.centerId]);
            expect(fix.success).toBe(true);
            const distance = await session.addConstraint('distance', [ellipse.centerId, ellipse.focus1Id], 4);
            expect(distance.success).toBe(true);
        });
    });

    describe('solver diagnostics channel', () => {
        async function twoPointSession(): Promise<SketchSession> {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            return session;
        }

        it('exposes partially-redundant tags and diagnostics on every status', async () => {
            const session = await twoPointSession();
            const status = session.getStatus();
            expect(Array.isArray(status.partiallyRedundant)).toBe(true);
            expect(Array.isArray(status.diagnostics)).toBe(true);
            // Two free points: under-constrained info entry, no errors.
            expect(status.diagnostics!.some((d) => d.code === 'under-constrained')).toBe(true);
            expect(status.diagnostics!.some((d) => d.severity === 'error')).toBe(false);
        });

        it('reports conflicting constraints with messages and clears fully-constrained', async () => {
            const session = await twoPointSession();
            const points = session.getPrimitives().filter((p) => p.type === 'point');
            const first = await session.addConstraint('distance', [points[0].id, points[1].id], 5);
            expect(first.success).toBe(true);
            const second = await session.addConstraint('distance', [points[0].id, points[1].id], 6);
            expect(second.success).toBe(true);

            const status = session.getStatus();
            expect(status.conflicting).toContain(first.constraintId!);
            expect(status.conflicting).toContain(second.constraintId!);
            expect(status.fullyConstrained).toBe(false);
            const error = status.diagnostics!.find((d) => d.code === 'conflicting');
            expect(error).toBeDefined();
            expect(error!.severity).toBe('error');
            expect(error!.constraintIds).toEqual(expect.arrayContaining([first.constraintId!, second.constraintId!]));
            expect(error!.message).toContain('Conflicting constraints');
        });

        it('reports fully-constrained through the diagnostics channel', async () => {
            const session = await makeSession('rectangle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 5 });
            const points = session.getPrimitives().filter((p) => p.type === 'point') as SketchPoint[];
            const byHeight = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
            const bottomLeft = byHeight[0];
            const bottomRight = byHeight[1];
            const topLeft = [...points].sort((a, b) => b.y - a.y || a.x - b.x).find((p) => Math.abs(p.x) < 1e-9)!;
            await session.addConstraint('fix', [bottomLeft.id]);
            await session.addConstraint('distance', [bottomLeft.id, bottomRight.id], 10);
            await session.addConstraint('distance', [bottomLeft.id, topLeft.id], 5, { direction: 'vertical' });
            expect(session.getStatus().fullyConstrained).toBe(true);
            const info = session.getStatus().diagnostics!.find((d) => d.code === 'fully-constrained');
            expect(info).toBeDefined();
            expect(info!.severity).toBe('info');
        });
    });

    describe('validators', () => {
        it('detects missing coincident constraints and clears them once added', async () => {
            const session = await makeSession('point');
            session.setSnapEnabled(false);
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5e-7, y: 0 });

            const missing = session.detectMissingCoincidents();
            expect(missing).toHaveLength(1);
            expect(missing[0].distance).toBeCloseTo(5e-7, 12);
            expect(session.getStatus().diagnostics!.some((d) => d.code === 'missing-coincident')).toBe(true);

            const points = session.getPrimitives().filter((p) => p.type === 'point');
            const added = await session.addConstraint('coincident', [points[0].id, points[1].id]);
            expect(added.success).toBe(true);
            expect(session.detectMissingCoincidents()).toHaveLength(0);
        });

        it('ignores coincident pairs and distant points', async () => {
            const session = await makeSession('point');
            session.setSnapEnabled(false);
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            expect(session.detectMissingCoincidents()).toHaveLength(0);
        });

        it('finds open wire ends and accepts closed rectangles', async () => {
            const session = await makeSession('line');
            session.setSnapEnabled(false);
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const open = session.findOpenVertices();
            expect(open).toHaveLength(2);
            expect(session.getStatus().diagnostics!.some((d) => d.code === 'open-profile')).toBe(true);

            const closed = await makeSession('rectangle');
            await closed.click({ x: 0, y: 0 });
            await closed.click({ x: 10, y: 5 });
            expect(closed.findOpenVertices()).toHaveLength(0);
        });

        it('merges coincident-joined corners before counting open vertices', async () => {
            const session = await makeSession('line');
            session.setSnapEnabled(false);
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            await session.click({ x: 10, y: 0 });
            await session.click({ x: 10, y: 10 });
            // Four distinct points, no coincident yet: four open ends.
            expect(session.findOpenVertices()).toHaveLength(4);

            const points = session.getPrimitives().filter((p) => p.type === 'point') as SketchPoint[];
            const joint = points.find((p) => Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y) < 1e-9)!;
            const joint2 = points.filter((p) => Math.abs(p.x - 10) < 1e-9 && Math.abs(p.y) < 1e-9)[1];
            await session.addConstraint('coincident', [joint.id, joint2.id]);
            // The joined corner closes; the two far ends stay open.
            expect(session.findOpenVertices()).toHaveLength(2);
        });
    });

    describe('block-as-freeze', () => {
        it('freezes all points of a line to DOF 0', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const line = session.getPrimitives().filter((p) => p.type === 'line')[0] as SketchLine;

            const result = await session.blockPrimitives([line.id]);
            expect(result.success).toBe(true);
            expect(result.constraintIds).toHaveLength(2);
            expect(session.getStatus().dof).toBe(0);
            expect(session.getStatus().fullyConstrained).toBe(true);
            const fixes = session.getConstraints().filter((c) => c.kind === 'fix');
            expect(fixes).toHaveLength(2);
        });

        it('is idempotent and rejects unknown primitives', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const line = session.getPrimitives().filter((p) => p.type === 'line')[0] as SketchLine;

            const first = await session.blockPrimitives([line.id]);
            expect(first.success).toBe(true);
            const second = await session.blockPrimitives([line.id]);
            expect(second.success).toBe(true);
            expect(second.constraintIds).toHaveLength(0);

            const missing = await session.blockPrimitives(['nope']);
            expect(missing.success).toBe(false);
            expect(missing.error).toContain('Unknown primitive');
        });

        it('freezes ellipse focus points (point-level only)', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 2, y: 3 });
            const ellipse = session.getPrimitives().filter((p) => p.type === 'ellipse')[0] as SketchEllipse;

            const result = await session.blockPrimitives([ellipse.id]);
            expect(result.success).toBe(true);
            expect(result.constraintIds).toHaveLength(2);
            expectPoint(session, ellipse.centerId, 0, 0);
        });
    });

    describe('signed distances and diameter', () => {
        async function twoPoints(): Promise<{ session: SketchSession; a: string; b: string }> {
            const session = await makeSession('point');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const points = session.getPrimitives().filter((p) => p.type === 'point');
            return { session, a: points[0].id, b: points[1].id };
        }

        it('enforces signed horizontal distance (DistanceX)', async () => {
            const { session, a, b } = await twoPoints();
            await session.addConstraint('fix', [a]);
            // Contract: value is first.x - second.x, so [b, a] puts b right of a.
            const created = await session.addDimension('distanceH', [b, a], 5);
            expect(created.dimensionId).toBeDefined();
            expectPoint(session, b, 5, 0);

            await session.editDimension(created.dimensionId!, { value: -3 });
            expectPoint(session, b, -3, 0);
        });

        it('enforces signed vertical distance (DistanceY)', async () => {
            const { session, a, b } = await twoPoints();
            await session.addConstraint('fix', [a]);
            await session.addDimension('distanceV', [b, a], 4);
            expectPoint(session, b, 10, 4);
        });

        it('creates a diameter dimension driving half the radius', async () => {
            const session = await makeSession('circle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            const circle = session.getPrimitives().filter((p) => p.type === 'circle')[0] as SketchCircle;

            const created = await session.addDimension('diameter', [circle.id], 10);
            expect(created.dimensionId).toBeDefined();
            expect((session.getPrimitive(circle.id) as SketchCircle).radius).toBeCloseTo(5, 8);
            expect(session.getDimension(created.dimensionId!)?.kind).toBe('diameter');

            const def = session.toSketchDef();
            expect(def.constraints.some((c) => (c as Record<string, unknown>).type === 'circle_diameter')).toBe(true);

            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);
            expect((restored.getPrimitive(circle.id) as SketchCircle).radius).toBeCloseTo(5, 8);
            const record = restored.getConstraints().find((c) => c.kind === 'radius');
            expect(record?.diameter).toBe(true);
        });

        it('supports the radius-as-diameter option on addConstraint', async () => {
            const session = await makeSession('circle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            const circle = session.getPrimitives().filter((p) => p.type === 'circle')[0] as SketchCircle;

            const result = await session.addConstraint('radius', [circle.id], 8, { diameter: true });
            expect(result.success).toBe(true);
            expect((session.getPrimitive(circle.id) as SketchCircle).radius).toBeCloseTo(4, 8);
        });
    });

    describe('point-on-object constraint', () => {
        it('constrains a free point onto a line and round-trips', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const line = session.getPrimitives().filter((p) => p.type === 'line')[0] as SketchLine;
            // Anchor the line so the free point does the moving.
            await session.addConstraint('fix', [line.p1Id]);
            await session.addConstraint('fix', [line.p2Id]);
            await session.setTool('point');
            await session.click({ x: 5, y: 5 });
            const free = session
                .getPrimitives()
                .filter((p) => p.type === 'point')
                .at(-1)!;

            const result = await session.addConstraint('pointOnObject', [free.id, line.id]);
            expect(result.success).toBe(true);
            expect((session.getPrimitive(free.id) as SketchPoint).y).toBeCloseTo(0, 6);

            const def = session.toSketchDef();
            expect(def.constraints.some((c) => (c as Record<string, unknown>).type === 'point_on_line_pl')).toBe(true);
            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(def, solver);
            expect(restored.getConstraints().some((c) => c.kind === 'pointOnObject')).toBe(true);
        });

        it('rejects ellipse and B-spline curve targets', async () => {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 2, y: 3 });
            const ellipse = session.getPrimitives().filter((p) => p.type === 'ellipse')[0] as SketchEllipse;
            const rejected = await session.addConstraint('pointOnObject', [ellipse.centerId, ellipse.id]);
            expect(rejected.success).toBe(false);
        });

        it('accepts either pick order (relation popover passes selection order)', async () => {
            for (const order of ['point-first', 'curve-first'] as const) {
                const session = await makeSession('line');
                await session.click({ x: 0, y: 0 });
                await session.click({ x: 10, y: 0 });
                const line = session.getPrimitives().filter((p) => p.type === 'line')[0] as SketchLine;
                await session.addConstraint('fix', [line.p1Id]);
                await session.addConstraint('fix', [line.p2Id]);
                await session.setTool('point');
                await session.click({ x: 5, y: 5 });
                const free = session
                    .getPrimitives()
                    .filter((p) => p.type === 'point')
                    .at(-1)!;

                const ids = order === 'point-first' ? [free.id, line.id] : [line.id, free.id];
                const result = await session.addConstraint('pointOnObject', ids);
                expect(result.success).toBe(true);
                expect((session.getPrimitive(free.id) as SketchPoint).y).toBeCloseTo(0, 6);
            }
        });
    });

    describe('slot tool', () => {
        it('builds two lines and two tangent arcs from three clicks', async () => {
            const session = await makeSession('slot');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            await session.click({ x: 10, y: 2 });

            const lines = session.getPrimitives().filter((p) => p.type === 'line');
            const arcs = session.getPrimitives().filter((p) => p.type === 'arc') as SketchArc[];
            expect(lines).toHaveLength(2);
            expect(arcs).toHaveLength(2);
            for (const arc of arcs) {
                expect(arc.radius).toBeCloseTo(2, 6);
            }
            const kinds = session.getConstraints().map((c) => c.kind);
            expect(kinds.filter((k) => k === 'tangent')).toHaveLength(4);
            expect(kinds.filter((k) => k === 'equal')).toHaveLength(1);
            expect(session.isInProgress()).toBe(false);
        });

        it('rejects a zero-width third click with a hint', async () => {
            const session = await makeSession('slot');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            await session.click({ x: 5, y: 0 });
            expect(session.getPrimitives().filter((p) => p.type === 'arc')).toHaveLength(0);
            expect(session.getStatus().hint).toContain('width');
        });

        it('cancels staged slot centers', async () => {
            const session = await makeSession('slot');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            session.cancel();
            expect(session.getPrimitives()).toHaveLength(0);
            expect(session.isInProgress()).toBe(false);
        });

        it('previews the centerline while placing', async () => {
            const session = await makeSession('slot');
            await session.click({ x: 0, y: 0 });
            const preview = session.hover({ x: 7, y: 1 });
            expect(preview.type).toBe('line');
        });
    });

    describe('sketch fillet', () => {
        async function rectangleSession(): Promise<{ session: SketchSession; lines: SketchLine[] }> {
            const session = await makeSession('rectangle');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 5 });
            const lines = session.getPrimitives().filter((p) => p.type === 'line') as SketchLine[];
            expect(lines).toHaveLength(4);
            return { session, lines };
        }

        function adjacentPair(lines: SketchLine[]): [SketchLine, SketchLine] {
            for (const a of lines) {
                for (const b of lines) {
                    if (a.id === b.id) {
                        continue;
                    }
                    const shared = [a.p1Id, a.p2Id].find((e) => e === b.p1Id || e === b.p2Id);
                    if (shared !== undefined) {
                        return [a, b];
                    }
                }
            }
            throw new Error('no adjacent pair');
        }

        it('trims a corner and inserts a tangent arc preserving line constraints', async () => {
            const { session, lines } = await rectangleSession();
            const [a, b] = adjacentPair(lines);
            const corner = [a.p1Id, a.p2Id].find((e) => e === b.p1Id || e === b.p2Id)!;
            const horizontalsBefore = session.getConstraints().filter((c) => c.kind === 'horizontal').length;

            const result = await session.filletCorner(a.id, b.id, 1);
            expect(result.success).toBe(true);
            expect(result.arcId).toBeDefined();
            expect(result.dimensionId).toBeDefined();

            const arc = session.getPrimitive(result.arcId!) as SketchArc;
            expect(arc.radius).toBeCloseTo(1, 6);
            // Line ids survive so line-level constraints are preserved.
            expect(session.getPrimitive(a.id)).toBeDefined();
            expect(session.getPrimitive(b.id)).toBeDefined();
            expect(session.getPrimitive(corner)).toBeUndefined();
            expect(session.getConstraints().filter((c) => c.kind === 'horizontal')).toHaveLength(horizontalsBefore);
            const tangents = session.getConstraints().filter((c) => c.kind === 'tangent' && c.targetIds.includes(result.arcId!));
            expect(tangents).toHaveLength(2);
            expect(session.getDimension(result.dimensionId!)?.kind).toBe('radius');
        });

        it('binds a parameter radius', async () => {
            const { session, lines } = await rectangleSession();
            const [a, b] = adjacentPair(lines);
            await session.setParameter('filletR', 1.5);
            const result = await session.filletCorner(a.id, b.id, 'filletR');
            expect(result.success).toBe(true);
            expect((session.getPrimitive(result.arcId!) as SketchArc).radius).toBeCloseTo(1.5, 6);
            expect(session.getDimension(result.dimensionId!)?.parameter).toBe('filletR');
        });

        it('rejects lines without a shared corner', async () => {
            const { session, lines } = await rectangleSession();
            const shared = new Set<string>();
            for (const a of lines) {
                for (const b of lines) {
                    if (a.id !== b.id && [a.p1Id, a.p2Id].some((e) => e === b.p1Id || e === b.p2Id)) {
                        shared.add([a.id, b.id].sort().join('|'));
                    }
                }
            }
            const disjoint = lines.filter((l) => ![...shared].some((s) => s.includes(l.id)));
            // Opposite sides of a rectangle share no corner.
            const opposite = lines.filter(
                (l) => ![l.p1Id, l.p2Id].some((e) => e === lines[0].p1Id || e === lines[0].p2Id) && l.id !== lines[0].id
            );
            const target = (opposite.length > 0 ? opposite : disjoint)[0] ?? lines[2];
            const result = await session.filletCorner(lines[0].id, target.id, 1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('corner');
        });

        it('rejects an oversized radius', async () => {
            const { session, lines } = await rectangleSession();
            const [a, b] = adjacentPair(lines);
            const result = await session.filletCorner(a.id, b.id, 100);
            expect(result.success).toBe(false);
            expect(result.error).toContain('too large');
        });

        it('rejects a constrained corner', async () => {
            const { session, lines } = await rectangleSession();
            const [a, b] = adjacentPair(lines);
            const corner = [a.p1Id, a.p2Id].find((e) => e === b.p1Id || e === b.p2Id)!;
            await session.addConstraint('fix', [corner]);
            const result = await session.filletCorner(a.id, b.id, 1);
            expect(result.success).toBe(false);
            expect(result.error).toContain('constrained');
        });
    });

    describe('carbonCopyFrom', () => {
        async function makeSourceDef(): Promise<SketchDef> {
            const solver = await PlanegcsSketchSolver.create();
            const source = await SketchSession.create(solver, {
                id: 'sketch-source',
                name: 'Source Sketch',
                datumId: 'xy',
                snap: { radius: 0.25, gridPitch: 1 }
            });
            source.setTool('point');
            await source.click({ x: 0, y: 0 });
            await source.click({ x: 10, y: 0 });
            const pointIds = source.getPrimitiveIds();
            await source.addConstraint('fix', [pointIds[0]]);
            await source.addParameter('span', 10);
            await source.addDimension('distance', [pointIds[0], pointIds[1]], 'span');

            source.setTool('line');
            await source.click({ x: 20, y: 0 });
            await source.click({ x: 20, y: 10 });
            const lineId = source.getPrimitives().filter((p) => p.type === 'line')[0].id;
            await source.setConstruction(lineId, true);

            source.setTool('circle');
            await source.click({ x: 30, y: 0 });
            await source.click({ x: 35, y: 0 });
            const circleId = source.getPrimitives().filter((p) => p.type === 'circle')[0].id;
            await source.setConstruction(circleId, true);

            source.addExternalRef(faceRef('base'));
            return source.toSketchDef();
        }

        it('copies geometry with fresh namespaced ids', async () => {
            const def = await makeSourceDef();
            const sourceIds = new Set(def.primitives.map((p) => String(p.id)));
            const session = await makeSession();
            const result = await session.carbonCopyFrom(def);
            expect(result.error).toBeUndefined();
            expect(result.addedPrimitiveIds).toHaveLength(def.primitives.length);
            for (const id of result.addedPrimitiveIds) {
                expect(sourceIds.has(id)).toBe(false);
                expect(id.startsWith('cc1-')).toBe(true);
            }
            // Coordinates survive the copy.
            const positions = session
                .getPrimitives()
                .filter((p) => p.type === 'point')
                .map((p) => point(session, p.id));
            for (const [x, y] of [
                [0, 0],
                [10, 0],
                [20, 0],
                [20, 10],
                [30, 0]
            ]) {
                expect(positions.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-9)).toBe(true);
            }
        });

        it('remaps constraints and dimensions onto the copied ids', async () => {
            const def = await makeSourceDef();
            const session = await makeSession();
            await session.carbonCopyFrom(def);
            const added = new Set(session.getPrimitiveIds());
            for (const record of session.getConstraints()) {
                for (const targetId of record.targetIds) {
                    expect(added.has(targetId)).toBe(true);
                }
            }
            // Fix (restored from the fixed flag) + distance + auto-vertical.
            expect(
                session
                    .getConstraints()
                    .map((c) => c.kind)
                    .sort()
            ).toEqual(['distance', 'fix', 'vertical']);

            const dimensions = session.getDimensions();
            expect(dimensions).toHaveLength(1);
            const dimension = dimensions[0];
            expect(dimension.parameter).toBe('span');
            expect(dimension.value).toBeCloseTo(10, 10);
            const constraintIds = new Set(session.getConstraints().map((c) => c.id));
            expect(constraintIds.has(dimension.constraintId)).toBe(true);
            const distance = session.getConstraints().find((c) => c.id === dimension.constraintId)!;
            expect(distance.targetIds).toEqual(dimension.targetIds);
            expect(session.getParameters().span).toBe(10);
        });

        it('preserves construction flags and external refs', async () => {
            const def = await makeSourceDef();
            const session = await makeSession();
            await session.carbonCopyFrom(def);
            const lines = session.getPrimitives().filter((p) => p.type === 'line');
            expect(lines).toHaveLength(1);
            expect(lines[0].construction).toBe(true);
            const circles = session.getPrimitives().filter((p) => p.type === 'circle');
            expect(circles).toHaveLength(1);
            expect(circles[0].construction).toBe(true);
            for (const p of session.getPrimitives().filter((p) => p.type === 'point')) {
                expect(p.construction).toBe(false);
            }
            expect(session.getExternalRefs()).toHaveLength(1);
            expect(session.getExternalRefs()[0].featureId).toBe('base');
        });

        it('rejects copying a sketch onto itself', async () => {
            const session = await makeSession();
            session.setTool('point');
            await session.click({ x: 1, y: 1 });
            const before = session.getPrimitiveIds().length;
            const result = await session.carbonCopyFrom(session.toSketchDef());
            expect(result.error).toContain('itself');
            expect(result.addedPrimitiveIds).toHaveLength(0);
            expect(session.getPrimitiveIds()).toHaveLength(before);
        });

        it('namespaces repeat copies so they never collide', async () => {
            const def = await makeSourceDef();
            const session = await makeSession();
            const first = await session.carbonCopyFrom(def);
            const second = await session.carbonCopyFrom(def);
            expect(first.error).toBeUndefined();
            expect(second.error).toBeUndefined();
            expect(second.addedPrimitiveIds.every((id) => id.startsWith('cc2-'))).toBe(true);
            const overlap = first.addedPrimitiveIds.filter((id) => second.addedPrimitiveIds.includes(id));
            expect(overlap).toHaveLength(0);
        });

        it('round-trips copied geometry through SketchDef and re-validates', async () => {
            const def = await makeSourceDef();
            const session = await makeSession();
            const result = await session.carbonCopyFrom(def);
            expect(result.error).toBeUndefined();
            const validation = session.validateDocument();
            expect(validation.issues).toEqual([]);
            expect(validation.valid).toBe(true);

            const solver = await PlanegcsSketchSolver.create();
            const restored = await SketchSession.fromSketchDef(session.toSketchDef(), solver);
            expect(restored.getPrimitiveIds().sort()).toEqual(session.getPrimitiveIds().sort());
            expect(
                restored
                    .getConstraints()
                    .map((c) => c.kind)
                    .sort()
            ).toEqual(
                session
                    .getConstraints()
                    .map((c) => c.kind)
                    .sort()
            );
        });
    });

    describe('exposeEllipseInternals', () => {
        async function makeEllipseSession(): Promise<{ session: SketchSession; ellipse: SketchEllipse }> {
            const session = await makeSession('ellipse');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 5, y: 0 });
            await session.click({ x: 2, y: 3 });
            const ellipse = session.getPrimitives().filter((p) => p.type === 'ellipse')[0] as SketchEllipse;
            return { session, ellipse };
        }

        it('adds the mirrored focus and axis construction lines', async () => {
            const { session, ellipse } = await makeEllipseSession();
            const constraintsBefore = session.getConstraints().length;
            const result = await session.exposeEllipseInternals(ellipse.id);
            expect(result.success).toBe(true);

            // focus2 = 2c - f1 = (-4, 0).
            const focus2 = point(session, result.focus2Id!);
            expect(focus2.x).toBeCloseTo(-4, 10);
            expect(focus2.y).toBeCloseTo(0, 10);
            expect(session.getPrimitive(result.focus2Id!)?.construction).toBe(true);

            // The major axis reuses focus1/focus2 and runs through the center.
            const major = session.getPrimitive(result.majorAxisLineId!) as SketchLine & { construction: boolean };
            expect(major.construction).toBe(true);
            expect(new Set([major.p1Id, major.p2Id])).toEqual(new Set([ellipse.focus1Id, result.focus2Id]));
            const center = point(session, ellipse.centerId);
            const f1 = point(session, ellipse.focus1Id);
            const cross = (f1.x - center.x) * (focus2.y - center.y) - (f1.y - center.y) * (focus2.x - center.x);
            expect(cross).toBeCloseTo(0, 10);

            // The minor axis is centered on c, perpendicular, radmin half-length.
            const minor = session.getPrimitive(result.minorAxisLineId!) as SketchLine & { construction: boolean };
            expect(minor.construction).toBe(true);
            const m1 = point(session, minor.p1Id);
            const m2 = point(session, minor.p2Id);
            expect((m1.x + m2.x) / 2).toBeCloseTo(center.x, 10);
            expect((m1.y + m2.y) / 2).toBeCloseTo(center.y, 10);
            const dot = (m2.x - m1.x) * (f1.x - center.x) + (m2.y - m1.y) * (f1.y - center.y);
            expect(dot).toBeCloseTo(0, 10);
            expect(Math.hypot(m2.x - m1.x, m2.y - m1.y)).toBeCloseTo(2 * ellipse.radmin, 10);

            // Non-driving: no constraints are added.
            expect(session.getConstraints()).toHaveLength(constraintsBefore);
        });

        it('rejects non-ellipse primitives with a clear error', async () => {
            const session = await makeSession('line');
            await session.click({ x: 0, y: 0 });
            await session.click({ x: 10, y: 0 });
            const lineId = session.getPrimitives().filter((p) => p.type === 'line')[0].id;
            const result = await session.exposeEllipseInternals(lineId);
            expect(result.success).toBe(false);
            expect(result.error).toContain('not an ellipse');

            const unknown = await session.exposeEllipseInternals('no-such-primitive');
            expect(unknown.success).toBe(false);
            expect(unknown.error).toContain('Unknown primitive');
        });
    });
});
