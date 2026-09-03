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

import { describe, it, expect, beforeAll } from 'vitest';
import { PlanegcsSketchSolver, type SketchPoint, type SketchCircle } from './sketch-solver';

describe('PlanegcsSketchSolver', () => {
    let solver: PlanegcsSketchSolver;

    beforeAll(async () => {
        solver = await PlanegcsSketchSolver.create();
    });

    it('solves a rectangle from four lines, horizontals/verticals and driving distances', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('p1', 0, 0);
        solver.addPoint('p2', 10, 0);
        solver.addPoint('p3', 10, 5);
        solver.addPoint('p4', 0, 5);

        solver.addLine('l1', 'p1', 'p2');
        solver.addLine('l2', 'p2', 'p3');
        solver.addLine('l3', 'p3', 'p4');
        solver.addLine('l4', 'p4', 'p1');

        solver.addConstraintHorizontal('h1', 'l1');
        solver.addConstraintHorizontal('h2', 'l3');
        solver.addConstraintVertical('v1', 'l2');
        solver.addConstraintVertical('v2', 'l4');
        solver.addConstraintDistance('w', 'p1', 'p2', 10);
        solver.addConstraintDistance('h', 'p2', 'p3', 5);
        solver.addConstraintFix('origin', 'p1');

        const result = await solver.solve();
        expect(result.status).toBe('converged');
        expect(result.dof).toBe(0);

        const read = (id: string) => solver.getPrimitive(id) as SketchPoint;
        expect(read('p1').x).toBeCloseTo(0, 10);
        expect(read('p1').y).toBeCloseTo(0, 10);
        expect(read('p2').x).toBeCloseTo(10, 10);
        expect(read('p2').y).toBeCloseTo(0, 10);
        expect(read('p3').x).toBeCloseTo(10, 10);
        expect(read('p3').y).toBeCloseTo(5, 10);
        expect(read('p4').x).toBeCloseTo(0, 10);
        expect(read('p4').y).toBeCloseTo(5, 10);
    });

    it('solves a circle with radius and concentric constraints', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('center', 2, 3);
        solver.addCircle('c1', 'center', 1);
        solver.addCircle('c2', 'center', 2);

        solver.addConstraintRadius('r1', 'c1', 4);
        solver.addConstraintRadius('r2', 'c2', 7);
        solver.addConstraintConcentric('concentric', 'c1', 'c2');
        solver.addConstraintFix('fixCenter', 'center');

        const result = await solver.solve();
        expect(result.status).toBe('converged');
        expect(result.dof).toBe(0);

        const center = solver.getPrimitive('center') as SketchPoint;
        expect(center.x).toBeCloseTo(2, 10);
        expect(center.y).toBeCloseTo(3, 10);

        const c1 = solver.getPrimitive('c1') as SketchCircle;
        expect(c1.type).toBe('circle');
        expect(c1.radius).toBeCloseTo(4, 10);

        const c2 = solver.getPrimitive('c2') as SketchCircle;
        expect(c2.type).toBe('circle');
        expect(c2.radius).toBeCloseTo(7, 10);
    });

    it('solves an arc tangent to a line', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('arcCenter', 0, 0);
        solver.addPoint('arcStart', 1, 0);
        solver.addPoint('arcEnd', 0, 1);
        solver.addArc('arc', 'arcCenter', 1, 0, Math.PI / 2, 'arcStart', 'arcEnd');

        solver.addPoint('lp1', 2, -1);
        solver.addPoint('lp2', 2, 1);
        solver.addLine('line', 'lp1', 'lp2');

        solver.addConstraintTangent('tangent', 'arc', 'line');
        // Anchor the arc center and the line so the solver adjusts the arc radius.
        solver.addConstraintFix('fixCenter', 'arcCenter');
        solver.addConstraintFix('fixLp1', 'lp1');
        solver.addConstraintFix('fixLp2', 'lp2');

        const result = await solver.solve();
        expect(result.status).toBe('converged');

        const center = solver.getPrimitive('arcCenter') as SketchPoint;
        // After tangency the vertical line x=2 should touch the arc centered at (0,0).
        expect(center.x).toBeCloseTo(0, 10);
        expect(center.y).toBeCloseTo(0, 10);

        const arc = solver.getPrimitive('arc');
        expect(arc?.type).toBe('arc');
        if (arc?.type === 'arc') {
            // Distance from vertical line x=2 to center (0,0) equals the arc radius.
            expect(arc.radius).toBeCloseTo(2, 10);
        }
    });

    it('reports redundant constraints for an over-constrained sketch', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('a', 0, 0);
        solver.addPoint('b', 10, 0);
        solver.addLine('l', 'a', 'b');
        solver.addConstraintHorizontal('h', 'l');
        solver.addConstraintDistance('d1', 'a', 'b', 10);
        solver.addConstraintDistance('d2', 'a', 'b', 10);

        const result = await solver.solve();
        expect(result.status).toBe('converged');
        expect(result.redundant.length).toBeGreaterThan(0);
        expect(result.redundant).toContain('d2');
    });

    it('tracks decreasing DOF as constraints are added', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('a', 0, 0);
        solver.addPoint('b', 5, 2);
        const before = await solver.solve();
        expect(before.dof).toBe(4);

        solver.addConstraintDistance('d', 'a', 'b', 5);
        const afterDistance = await solver.solve();
        expect(afterDistance.dof).toBe(3);

        solver.addLine('l', 'a', 'b');
        solver.addConstraintHorizontal('h', 'l');
        const afterHorizontal = await solver.solve();
        expect(afterHorizontal.dof).toBe(2);

        solver.addConstraintFix('fixA', 'a');
        const afterFix = await solver.solve();
        expect(afterFix.dof).toBe(0);
    });

    it('reverts temporary constraints used for dragging', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('p', 0, 0);
        await solver.solve();

        const before = solver.getPrimitive('p') as SketchPoint;
        expect(before.x).toBeCloseTo(0, 10);
        expect(before.y).toBeCloseTo(0, 10);

        // Drag the point to (3, 4) with a temporary fix constraint.
        const dragResult = await solver.pushTemporaryConstraints([{ type: 'fix', id: 'dragFix', pointId: 'p', x: 3, y: 4 }]);
        expect(dragResult.status).toBe('converged');

        const during = solver.getPrimitive('p') as SketchPoint;
        expect(during.x).toBeCloseTo(3, 10);
        expect(during.y).toBeCloseTo(4, 10);

        await solver.popTemporaryConstraints();
        const after = solver.getPrimitive('p') as SketchPoint;
        expect(after.x).toBeCloseTo(0, 10);
        expect(after.y).toBeCloseTo(0, 10);
    });

    it('leaves committed geometry untouched when the solve fails', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('p1', 0, 0);
        solver.addPoint('p2', 10, 0);
        solver.addConstraintFix('fix', 'p1');
        solver.addConstraintDistance('d1', 'p2', 'p1', 10, { direction: 'horizontal' });

        const first = await solver.solve();
        expect(first.status).toBe('converged');
        expect((solver.getPrimitive('p2') as SketchPoint).x).toBeCloseTo(10, 10);
        const p2afterFirst = solver.getPrimitive('p2') as SketchPoint;

        // A second, conflicting horizontal distance makes the solve fail.
        solver.addConstraintDistance('d2', 'p2', 'p1', 5, { direction: 'horizontal' });
        const second = await solver.solve();
        expect(second.status).toBe('failed');

        // Committed geometry must not have moved.
        const p2afterFailure = solver.getPrimitive('p2') as SketchPoint;
        expect(p2afterFailure.x).toBeCloseTo(p2afterFirst.x, 10);
        expect(p2afterFailure.y).toBeCloseTo(p2afterFirst.y, 10);
    });

    it('rejects duplicate primitive ids', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('a', 0, 0);
        expect(() => solver.addPoint('a', 1, 1)).toThrow(/already in use/);
    });

    it('rejects id collisions between primitives, constraints, and temporaries', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('shared', 0, 0);
        solver.addLine('line', 'shared', 'shared');

        expect(() => solver.addConstraintHorizontal('shared', 'line')).toThrow(/already in use/);
        expect(() => solver.addConstraintFix('shared', 'shared')).toThrow(/already in use/);
        expect(() => solver.addConstraintFix('line', 'shared')).toThrow(/already in use/);
        await expect(solver.pushTemporaryConstraints([{ type: 'horizontal', id: 'shared', lineId: 'line' }])).rejects.toThrow(
            /already in use/
        );
    });

    it('rejects duplicate constraint ids', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('a', 0, 0);
        solver.addConstraintFix('fix', 'a');
        expect(() => solver.addConstraintFix('fix', 'a')).toThrow(/already in use/);
    });

    it('rejects adding constraints that reference unknown primitives', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('a', 0, 0);
        solver.addPoint('b', 1, 0);
        solver.addLine('l', 'a', 'b');

        expect(() => solver.addConstraintCoincident('c', 'missing', 'a')).toThrow(/unknown primitive/);
        expect(() => solver.addConstraintHorizontal('h', 'missing')).toThrow(/unknown primitive/);
        expect(() => solver.addConstraintParallel('p', 'missing', 'l')).toThrow(/unknown primitive/);
        expect(() => solver.addConstraintPerpendicular('pp', 'l', 'missing')).toThrow(/unknown primitive/);
        expect(() => solver.addConstraintAngle('ang', 'l', 'missing', 45)).toThrow(/unknown primitive/);
    });

    it('rejects constraints with the wrong primitive type', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('a', 0, 0);
        expect(() => solver.addConstraintHorizontal('h', 'a')).toThrow(/requires line/);
        expect(() => solver.addConstraintFix('f', 'missing')).toThrow(/unknown primitive/);
    });

    it('treats horizontal distance as signed', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('left', 0, 0);
        solver.addPoint('right', 0, 0);
        solver.addConstraintFix('fixLeft', 'left');

        solver.addConstraintDistance('dPos', 'right', 'left', 5, { direction: 'horizontal' });
        const pos = await solver.solve();
        expect(pos.status).toBe('converged');
        expect((solver.getPrimitive('right') as SketchPoint).x).toBeCloseTo(5, 10);

        solver.removeConstraint('dPos');
        solver.addConstraintDistance('dNeg', 'right', 'left', -3, { direction: 'horizontal' });
        const neg = await solver.solve();
        expect(neg.status).toBe('converged');
        expect((solver.getPrimitive('right') as SketchPoint).x).toBeCloseTo(-3, 10);
    });

    it('treats vertical distance as signed', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('bottom', 0, 0);
        solver.addPoint('top', 0, 0);
        solver.addConstraintFix('fixBottom', 'bottom');

        solver.addConstraintDistance('dPos', 'top', 'bottom', 4, { direction: 'vertical' });
        const pos = await solver.solve();
        expect(pos.status).toBe('converged');
        expect((solver.getPrimitive('top') as SketchPoint).y).toBeCloseTo(4, 10);

        solver.removeConstraint('dPos');
        solver.addConstraintDistance('dNeg', 'top', 'bottom', -2, { direction: 'vertical' });
        const neg = await solver.solve();
        expect(neg.status).toBe('converged');
        expect((solver.getPrimitive('top') as SketchPoint).y).toBeCloseTo(-2, 10);
    });

    it('rejects non-finite parameter values', async () => {
        solver = await PlanegcsSketchSolver.create();
        expect(() => solver.addParameter('x', NaN)).toThrow(/finite number/);
        expect(() => solver.addParameter('x', Infinity)).toThrow(/finite number/);
        solver.addParameter('y', 1);
        expect(() => solver.setParameter('y', NaN)).toThrow(/finite number/);
        expect(() => solver.setParameter('y', Infinity)).toThrow(/finite number/);
    });

    it('makes destroy idempotent', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.destroy();
        expect(() => solver.destroy()).not.toThrow();
    });

    it('removePrimitive removes the primitive and constraints that reference it', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('a', 0, 0);
        solver.addPoint('b', 10, 0);
        solver.addConstraintCoincident('coincident', 'a', 'b');
        solver.addConstraintFix('fix', 'a');
        await solver.solve();

        solver.removePrimitive('a');
        const result = await solver.solve();
        expect(result.status).toBe('converged');

        expect(solver.getPrimitive('a')).toBeUndefined();
        // Coincident and fix constraints attached to 'a' were cascaded away;
        // point b survives as an independent point.
        expect(solver.getPrimitive('b')).toBeDefined();
    });

    it('setPointCoordinates drives a point to new coordinates', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('p', 0, 0);
        await solver.solve();

        solver.setPointCoordinates('p', 3, 4);
        const result = await solver.solve();
        expect(result.status).toBe('converged');

        const point = solver.getPrimitive('p') as SketchPoint;
        expect(point.x).toBeCloseTo(3, 10);
        expect(point.y).toBeCloseTo(4, 10);
    });

    it('setPointCoordinates replaces prior coordinates without accumulating', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('p', 0, 0);
        await solver.solve();

        solver.setPointCoordinates('p', 1, 1);
        await solver.solve();
        solver.setPointCoordinates('p', 5, 5);
        const result = await solver.solve();

        const point = solver.getPrimitive('p') as SketchPoint;
        expect(point.x).toBeCloseTo(5, 10);
        expect(point.y).toBeCloseTo(5, 10);
        expect(result.dof).toBe(0);
    });

    it('addConstraintPointOnObject constrains a point to a line', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('p1', 0, 0);
        solver.addPoint('p2', 10, 0);
        solver.addLine('l', 'p1', 'p2');
        solver.addConstraintFix('fixP1', 'p1');
        solver.addConstraintFix('fixP2', 'p2');

        solver.addPoint('p', 5, 2);
        solver.addConstraintPointOnObject('po', 'p', 'l');
        const result = await solver.solve();
        expect(result.status).toBe('converged');

        const p = solver.getPrimitive('p') as SketchPoint;
        expect(p.y).toBeCloseTo(0, 10);
    });

    it('addConstraintPointOnObject constrains a point to a circle', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('c', 0, 0);
        solver.addCircle('circle', 'c', 5);
        solver.addConstraintFix('fixC', 'c');
        solver.addConstraintRadius('r', 'circle', 5);

        solver.addPoint('p', 7, 0);
        solver.addConstraintPointOnObject('po', 'p', 'circle');
        const result = await solver.solve();
        expect(result.status).toBe('converged');

        const p = solver.getPrimitive('p') as SketchPoint;
        expect(Math.hypot(p.x, p.y)).toBeCloseTo(5, 10);
    });

    it('setDrivingValue updates a distance constraint value', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('a', 0, 0);
        solver.addPoint('b', 0, 0);
        solver.addConstraintFix('fixA', 'a');
        // Use a signed horizontal distance (b.x - a.x) so the solve is determinate.
        solver.addConstraintDistance('d', 'b', 'a', 5, { direction: 'horizontal' });
        await solver.solve();
        expect((solver.getPrimitive('b') as SketchPoint).x).toBeCloseTo(5, 10);

        solver.setDrivingValue('d', 12);
        const result = await solver.solve();
        expect(result.status).toBe('converged');
        expect((solver.getPrimitive('b') as SketchPoint).x).toBeCloseTo(12, 10);
    });

    it('setDrivingValue updates a radius constraint value', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('c', 0, 0);
        solver.addCircle('circle', 'c', 1);
        solver.addConstraintFix('fixC', 'c');
        solver.addConstraintRadius('r', 'circle', 3);
        await solver.solve();
        expect((solver.getPrimitive('circle') as SketchCircle).radius).toBeCloseTo(3, 10);

        solver.setDrivingValue('r', 7);
        const result = await solver.solve();
        expect(result.status).toBe('converged');
        expect((solver.getPrimitive('circle') as SketchCircle).radius).toBeCloseTo(7, 10);
    });

    it('setDrivingValue updates a diameter constraint value', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('c', 0, 0);
        solver.addCircle('circle', 'c', 1);
        solver.addConstraintFix('fixC', 'c');
        solver.addConstraintDiameter('d', 'circle', 10);
        await solver.solve();
        expect((solver.getPrimitive('circle') as SketchCircle).radius).toBeCloseTo(5, 10);

        solver.setDrivingValue('d', 16);
        const result = await solver.solve();
        expect(result.status).toBe('converged');
        expect((solver.getPrimitive('circle') as SketchCircle).radius).toBeCloseTo(8, 10);
    });

    it('setDrivingValue updates an angle constraint value', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('a', 0, 0);
        solver.addPoint('b', 1, 0);
        solver.addPoint('c', 1, 1);
        solver.addLine('l1', 'a', 'b');
        solver.addLine('l2', 'a', 'c');
        solver.addConstraintFix('fixA', 'a');
        solver.addConstraintFix('fixB', 'b');
        solver.addConstraintAngle('ang', 'l1', 'l2', Math.PI / 4);
        await solver.solve();

        solver.setDrivingValue('ang', Math.PI / 2);
        const result = await solver.solve();
        expect(result.status).toBe('converged');

        const a = solver.getPrimitive('a') as SketchPoint;
        const b = solver.getPrimitive('b') as SketchPoint;
        const c = solver.getPrimitive('c') as SketchPoint;
        const v1 = { x: b.x - a.x, y: b.y - a.y };
        const v2 = { x: c.x - a.x, y: c.y - a.y };
        const angle = Math.atan2(v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y);
        expect(Math.abs(angle)).toBeCloseTo(Math.PI / 2, 10);
    });

    it('setDrivingValue rejects unknown constraint ids', async () => {
        solver = await PlanegcsSketchSolver.create();
        expect(() => solver.setDrivingValue('missing', 5)).toThrow(/Unknown constraint/);
    });

    it('round-trips an ellipse through solve and reads back the solved radii', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('center', 1, 2);
        solver.addPoint('focus1', 4, 2);
        solver.addEllipse('ellipse', 'center', 'focus1', 4);

        solver.addConstraintFix('fixCenter', 'center');
        solver.addConstraintFix('fixFocus', 'focus1');
        const result = await solver.solve();
        expect(result.status).toBe('converged');

        const center = solver.getPrimitive('center') as SketchPoint;
        const focus1 = solver.getPrimitive('focus1') as SketchPoint;
        expect(center.x).toBeCloseTo(1, 8);
        expect(center.y).toBeCloseTo(2, 8);
        // The focus sets the major-axis direction and focal distance.
        expect(focus1.x - center.x).toBeCloseTo(3, 8);
        expect(focus1.y - center.y).toBeCloseTo(0, 8);

        const ellipse = solver.getPrimitive('ellipse');
        expect(ellipse?.type).toBe('ellipse');
        if (ellipse?.type === 'ellipse') {
            expect(ellipse.centerId).toBe('center');
            expect(ellipse.focus1Id).toBe('focus1');
            // radmin is the minor semi-axis; major derives from the focus form.
            expect(ellipse.radmin).toBeCloseTo(4, 8);
            const major = Math.sqrt(ellipse.radmin * ellipse.radmin + 9);
            expect(major).toBeCloseTo(5, 8);
        }
    });

    it('solves a B-spline by its control polygon and reads back the poles', async () => {
        solver = await PlanegcsSketchSolver.create();

        solver.addPoint('p0', 0, 0);
        solver.addPoint('p1', 3, 6);
        solver.addPoint('p2', 6, 0);
        solver.addBSpline('curve', ['p0', 'p1', 'p2'], [1, 1, 1], [0, 1], [3, 3], 2, false);

        // Fixing two poles leaves the middle pole free: 2 DOF.
        solver.addConstraintFix('fix0', 'p0');
        solver.addConstraintFix('fix2', 'p2');
        const result = await solver.solve();
        expect(result.status).toBe('converged');
        expect(result.dof).toBe(2);

        const curve = solver.getPrimitive('curve');
        expect(curve?.type).toBe('bspline');
        if (curve?.type === 'bspline') {
            expect(curve.poleIds).toEqual(['p0', 'p1', 'p2']);
            expect(curve.weights).toEqual([1, 1, 1]);
            expect(curve.degree).toBe(2);
            expect(curve.periodic).toBe(false);
            const p1 = solver.getPrimitive('p1') as SketchPoint;
            expect(p1.x).toBeCloseTo(3, 8);
            expect(p1.y).toBeCloseTo(6, 8);
        }
    });

    it('addBSpline validates knot multiplicities and pole references', async () => {
        solver = await PlanegcsSketchSolver.create();
        solver.addPoint('p0', 0, 0);
        solver.addPoint('p1', 1, 1);
        solver.addPoint('p2', 2, 0);

        expect(() => solver.addBSpline('bad', ['p0', 'p1', 'p2'], [1, 1, 1], [0, 1], [3, 3], 3, false)).toThrow(/poles/);
        expect(() => solver.addBSpline('bad', ['p0', 'p1', 'p2'], [1, 1], [0, 1], [3, 3], 2, false)).toThrow(/weights/);
        expect(() => solver.addBSpline('bad', ['p0', 'p1', 'missing'], [1, 1, 1], [0, 1], [3, 3], 2, false)).toThrow(/unknown primitive/);
        expect(() => solver.addBSpline('bad', ['p0', 'p1', 'p2'], [1, 1, 1], [0, 1], [3, 3], 2, true)).toThrow(/periodic/);
        expect(() => solver.addBSpline('bad', ['p0', 'p1', 'p2'], [1, 1, 1], [0, 1, 2], [3, 3], 2, false)).toThrow(/knot/);
    });
});
