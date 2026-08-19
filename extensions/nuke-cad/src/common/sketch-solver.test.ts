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
});
