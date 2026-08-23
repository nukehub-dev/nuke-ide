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
import * as fs from 'fs';
import * as path from 'path';
import { PlanegcsSketchSolver } from '../../common/sketch-solver';
import { SketchSession, type SketchPrimitive } from '../sketch/sketch-session';
import { CadDocumentStore } from './cad-document-store';
import { validateNukeCadDocument, type NukeCadDocument, type SketchDef } from '../../common/cad-document';
import { TOKAMAK_PROFILES } from './tokamak-profiles';

/**
 * GUI-path authoring driver for the tokamak_with_divertor demo model.
 *
 * Bodies with rectilinear boundaries use exact sketches; plasma-facing spline
 * boundaries are approximated with dense polylines sampled from the reference
 * STEP. Dense polylines are loaded through SketchSession.fromSketchDef so the
 * solver is exercised once per sketch instead of once per segment. The fixture
 * is written only under NUKE_CAD_WRITE_FIXTURE=1.
 */

const PLASMA_MAJOR = 450.0;
const PLASMA_MINOR = 150.0;
const PLASMA_ELONGATION = 2.1666666666666665;
const PLASMA_TRIANGULARITY = 0.55;
const PLASMA_X_SCALE = 0.9844633067693394;

function makePlasmaProfile(): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    const n = 200;
    for (let i = 0; i < n; i++) {
        const theta = (2 * Math.PI * i) / n;
        const r = PLASMA_MAJOR + PLASMA_MINOR * Math.cos(theta + PLASMA_TRIANGULARITY * Math.sin(theta));
        points.push({
            x: r * PLASMA_X_SCALE,
            y: PLASMA_ELONGATION * PLASMA_MINOR * Math.sin(theta)
        });
    }
    return points;
}

describe('GUI build tokamak', () => {
    async function makeSession(id: string, datumId = 'datum-xy'): Promise<SketchSession> {
        const sessionSolver = await PlanegcsSketchSolver.create();
        return SketchSession.create(sessionSolver, {
            id,
            name: id,
            datumId,
            snap: { radius: 0.25, gridPitch: 0.001 },
            autoConstraintAngleThresholdDeg: 0
        });
    }

    async function makePolylineSession(
        id: string,
        datumId: string,
        points: readonly { readonly x: number; readonly y: number }[]
    ): Promise<SketchSession> {
        let pts = points.slice();
        while (pts.length > 2 && Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) < 1e-6) {
            pts = pts.slice(0, -1);
        }
        if (pts.length < 3) {
            throw new Error(`Sketch '${id}' needs at least 3 distinct points`);
        }
        const primitives: Record<string, unknown>[] = [];
        const pids: string[] = [];
        for (let i = 0; i < pts.length; i++) {
            const pid = `${id}-p${i}`;
            pids.push(pid);
            primitives.push({
                id: pid,
                type: 'point',
                x: pts[i].x,
                y: pts[i].y,
                fixed: i === 0
            });
        }
        for (let i = 0; i < pts.length; i++) {
            primitives.push({
                id: `${id}-l${i}`,
                type: 'line',
                p1_id: pids[i],
                p2_id: pids[(i + 1) % pts.length]
            });
        }
        const def: SketchDef = {
            id,
            name: id,
            datumId,
            primitives,
            constraints: []
        };
        const sessionSolver = await PlanegcsSketchSolver.create();
        return SketchSession.fromSketchDef(def, sessionSolver);
    }

    async function makeRectangleWithHoleSession(
        id: string,
        datumId: string,
        outer: [number, number, number, number],
        inner: [number, number, number, number]
    ): Promise<SketchSession> {
        const [x1o, y1o, x2o, y2o] = outer;
        const [x1i, y1i, x2i, y2i] = inner;
        const ring = (prefix: string, x1: number, y1: number, x2: number, y2: number, fixed: boolean) => {
            const pids = [`${prefix}-p0`, `${prefix}-p1`, `${prefix}-p2`, `${prefix}-p3`];
            const points = [
                { id: pids[0], type: 'point', x: x1, y: y1, fixed },
                { id: pids[1], type: 'point', x: x2, y: y1 },
                { id: pids[2], type: 'point', x: x2, y: y2 },
                { id: pids[3], type: 'point', x: x1, y: y2 }
            ];
            const lines = [
                { id: `${prefix}-l0`, type: 'line', p1_id: pids[0], p2_id: pids[1] },
                { id: `${prefix}-l1`, type: 'line', p1_id: pids[1], p2_id: pids[2] },
                { id: `${prefix}-l2`, type: 'line', p1_id: pids[2], p2_id: pids[3] },
                { id: `${prefix}-l3`, type: 'line', p1_id: pids[3], p2_id: pids[0] }
            ];
            return { points, lines };
        };
        const outerRing = ring(`${id}-o`, x1o, y1o, x2o, y2o, true);
        const innerRing = ring(`${id}-i`, x1i, y1i, x2i, y2i, false);
        const def: SketchDef = {
            id,
            name: id,
            datumId,
            primitives: [...outerRing.points, ...innerRing.points, ...outerRing.lines, ...innerRing.lines],
            constraints: []
        };
        const sessionSolver = await PlanegcsSketchSolver.create();
        return SketchSession.fromSketchDef(def, sessionSolver);
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

    function canonicalJson(doc: NukeCadDocument): string {
        return JSON.stringify(canonicalize(doc), null, 2);
    }

    async function drawRectangle(session: SketchSession, x1: number, y1: number, x2: number, y2: number): Promise<void> {
        await session.setTool('rectangle');
        await session.click({ x: x1, y: y1 });
        await session.click({ x: x2, y: y2 });
    }

    async function drawArc3(
        session: SketchSession,
        start: { x: number; y: number },
        mid: { x: number; y: number },
        end: { x: number; y: number }
    ): Promise<void> {
        await session.setTool('arc3');
        await session.click({ x: start.x, y: start.y });
        await session.click({ x: mid.x, y: mid.y });
        await session.click({ x: end.x, y: end.y });
    }

    async function closeAndAnchor(session: SketchSession): Promise<void> {
        const points = session.getPrimitives().filter((p): p is SketchPrimitive & { type: 'point' } => p.type === 'point');
        const groups = new Map<string, (SketchPrimitive & { type: 'point' })[]>();
        for (const p of points) {
            const key = `${Math.round(p.x * 1e4) / 1e4},${Math.round(p.y * 1e4) / 1e4}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(p);
        }
        for (const group of groups.values()) {
            if (group.length > 1) {
                const first = group[0];
                for (let i = 1; i < group.length; i++) {
                    await session.addConstraint('coincident', [first.id, group[i].id]);
                }
            }
        }
        const first = points[0];
        if (first) {
            await session.addConstraint('fix', [first.id]);
        }
    }

    async function buildTokamakDocument(): Promise<NukeCadDocument> {
        const store = new CadDocumentStore();
        expect(store.createDocument('tokamak').success).toBe(true);

        const tf_coils = store.addBody('tf_coils', 'tf_coils').value!;
        const pf_coil_1 = store.addBody('pf_coil_1', 'pf_coil_1').value!;
        const pf_case_1 = store.addBody('pf_case_1', 'pf_case_1').value!;
        const pf_coil_2 = store.addBody('pf_coil_2', 'pf_coil_2').value!;
        const pf_case_2 = store.addBody('pf_case_2', 'pf_case_2').value!;
        const pf_coil_3 = store.addBody('pf_coil_3', 'pf_coil_3').value!;
        const pf_case_3 = store.addBody('pf_case_3', 'pf_case_3').value!;
        const pf_coil_4 = store.addBody('pf_coil_4', 'pf_coil_4').value!;
        const pf_case_4 = store.addBody('pf_case_4', 'pf_case_4').value!;
        const divertor = store.addBody('divertor', 'divertor').value!;
        const tf_inner_leg_1 = store.addBody('tf_inner_leg_1', 'tf_inner_leg_1').value!;
        const tf_inner_leg_2 = store.addBody('tf_inner_leg_2', 'tf_inner_leg_2').value!;
        const tf_inner_leg_3 = store.addBody('tf_inner_leg_3', 'tf_inner_leg_3').value!;
        const tf_inner_leg_4 = store.addBody('tf_inner_leg_4', 'tf_inner_leg_4').value!;
        const tf_inner_leg_5 = store.addBody('tf_inner_leg_5', 'tf_inner_leg_5').value!;
        const tf_inner_leg_6 = store.addBody('tf_inner_leg_6', 'tf_inner_leg_6').value!;
        const center_column = store.addBody('center_column', 'center_column').value!;
        const inboard_blanket = store.addBody('inboard_blanket', 'inboard_blanket').value!;
        const first_wall_inboard = store.addBody('first_wall_inboard', 'first_wall_inboard').value!;
        const first_wall_outboard = store.addBody('first_wall_outboard', 'first_wall_outboard').value!;
        const outboard_blanket = store.addBody('outboard_blanket', 'outboard_blanket').value!;
        const plasma = store.addBody('plasma', 'plasma').value!;
        const cuttingWedge = store.addBody('cutting_wedge').value!;

        const addSketch = async (id: string, datumId: string, build: (s: SketchSession) => Promise<void>): Promise<SketchDef> => {
            const session = await makeSession(id, datumId);
            await build(session);
            const def = session.toSketchDef();
            expect(store.upsertSketch(def).success).toBe(true);
            return def;
        };

        const addPolylineSketch = async (id: string, datumId: string, points: { x: number; y: number }[]): Promise<SketchDef> => {
            const session = await makePolylineSession(id, datumId, points);
            const def = session.toSketchDef();
            expect(store.upsertSketch(def).success).toBe(true);
            return def;
        };

        const pfCoil1Sketch = await addSketch('pf-coil-1-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 720, 360, 740, 380);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-coil-1',
                name: 'pf-coil-1',
                type: 'revolve',
                body: pf_coil_1,
                sketchId: pfCoil1Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const pfCoil2Sketch = await addSketch('pf-coil-2-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 785, 210, 835, 260);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-coil-2',
                name: 'pf-coil-2',
                type: 'revolve',
                body: pf_coil_2,
                sketchId: pfCoil2Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const pfCoil3Sketch = await addSketch('pf-coil-3-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 785, -260, 835, -210);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-coil-3',
                name: 'pf-coil-3',
                type: 'revolve',
                body: pf_coil_3,
                sketchId: pfCoil3Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const pfCoil4Sketch = await addSketch('pf-coil-4-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 720, -380, 740, -360);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-coil-4',
                name: 'pf-coil-4',
                type: 'revolve',
                body: pf_coil_4,
                sketchId: pfCoil4Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const pfCase1Sketch = await addSketch('pf-case-1-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 710, 350, 750, 390);
            await drawRectangle(s, 720, 360, 740, 380);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-case-1',
                name: 'pf-case-1',
                type: 'revolve',
                body: pf_case_1,
                sketchId: pfCase1Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const pfCase2Sketch = await addSketch('pf-case-2-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 770, 195, 850, 275);
            await drawRectangle(s, 785, 210, 835, 260);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-case-2',
                name: 'pf-case-2',
                type: 'revolve',
                body: pf_case_2,
                sketchId: pfCase2Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const pfCase3Sketch = await addSketch('pf-case-3-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 770, -275, 850, -195);
            await drawRectangle(s, 785, -260, 835, -210);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-case-3',
                name: 'pf-case-3',
                type: 'revolve',
                body: pf_case_3,
                sketchId: pfCase3Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const pfCase4Sketch = await addSketch('pf-case-4-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 710, -390, 750, -350);
            await drawRectangle(s, 720, -380, 740, -360);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'pf-case-4',
                name: 'pf-case-4',
                type: 'revolve',
                body: pf_case_4,
                sketchId: pfCase4Sketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);

        const divertorSketch = await addPolylineSketch(
            'divertor-sketch',
            'datum-xz',
            TOKAMAK_PROFILES.divertor.map(([x, z]) => ({ x, y: z }))
        );
        expect(
            store.addFeature({
                id: 'divertor',
                name: 'divertor',
                type: 'revolve',
                body: divertor,
                sketchId: divertorSketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);

        const innerLegs = [tf_inner_leg_1, tf_inner_leg_2, tf_inner_leg_3, tf_inner_leg_4, tf_inner_leg_5, tf_inner_leg_6];
        for (let i = 0; i < 6; i++) {
            const leg = TOKAMAK_PROFILES[`inner_leg_${i + 1}` as keyof typeof TOKAMAK_PROFILES] as {
                A: [number, number];
                B: [number, number];
                C: [number, number];
                M: [number, number];
            };
            const sketch = await addSketch(`inner-leg-${i + 1}-sketch`, 'datum-xy', async (s) => {
                await s.setTool('line');
                await s.click({ x: leg.A[0], y: leg.A[1] });
                await s.click({ x: leg.C[0], y: leg.C[1] });
                await s.click({ x: leg.C[0], y: leg.C[1] });
                await s.click({ x: leg.B[0], y: leg.B[1] });
                await drawArc3(s, { x: leg.B[0], y: leg.B[1] }, { x: leg.M[0], y: leg.M[1] }, { x: leg.A[0], y: leg.A[1] });
                await closeAndAnchor(s);
            });
            expect(
                store.addFeature({
                    id: `inner-leg-${i + 1}`,
                    name: `inner-leg-${i + 1}`,
                    type: 'pad',
                    body: innerLegs[i],
                    sketchId: sketch.id,
                    params: { length: 1030, axis: 'z' },
                    dependsOn: [],
                    suppressed: false
                }).success
            ).toBe(true);
        }

        const centerColumnSketch = await addSketch('center-column-sketch', 'datum-xz', async (s) => {
            await drawRectangle(s, 40, -515, 90, 515);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'center-column',
                name: 'center-column',
                type: 'revolve',
                body: center_column,
                sketchId: centerColumnSketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);

        const inboardBlanketSketch = await addPolylineSketch(
            'inboard_blanket-sketch',
            'datum-xz',
            TOKAMAK_PROFILES.layer_3.map(([x, z]) => ({ x, y: z }))
        );
        expect(
            store.addFeature({
                id: 'inboard_blanket',
                name: 'inboard_blanket',
                type: 'revolve',
                body: inboard_blanket,
                sketchId: inboardBlanketSketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const firstWallInboardSketch = await addPolylineSketch(
            'first_wall_inboard-sketch',
            'datum-xz',
            TOKAMAK_PROFILES.layer_4.map(([x, z]) => ({ x, y: z }))
        );
        expect(
            store.addFeature({
                id: 'first_wall_inboard',
                name: 'first_wall_inboard',
                type: 'revolve',
                body: first_wall_inboard,
                sketchId: firstWallInboardSketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const firstWallOutboardSketch = await addPolylineSketch(
            'first_wall_outboard-sketch',
            'datum-xz',
            TOKAMAK_PROFILES.layer_5.map(([x, z]) => ({ x, y: z }))
        );
        expect(
            store.addFeature({
                id: 'first_wall_outboard',
                name: 'first_wall_outboard',
                type: 'revolve',
                body: first_wall_outboard,
                sketchId: firstWallOutboardSketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        const outboardBlanketSketch = await addPolylineSketch(
            'outboard_blanket-sketch',
            'datum-xz',
            TOKAMAK_PROFILES.layer_6.map(([x, z]) => ({ x, y: z }))
        );
        expect(
            store.addFeature({
                id: 'outboard_blanket',
                name: 'outboard_blanket',
                type: 'revolve',
                body: outboard_blanket,
                sketchId: outboardBlanketSketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);

        const plasmaSketch = await addPolylineSketch('plasma-sketch', 'datum-xz', makePlasmaProfile());
        expect(
            store.addFeature({
                id: 'plasma',
                name: 'plasma',
                type: 'revolve',
                body: plasma,
                sketchId: plasmaSketch.id,
                params: { axis: 'z', angle: 180 },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);

        // TF coils: paramak-style D-frame extruded toroidally, patterned, and clipped to the 180deg sector.
        const tfCoilSession = await makeRectangleWithHoleSession('tf-coil-sketch', 'datum-xz', [10, -570, 910, 570], [60, -520, 860, 520]);
        const tfCoilSketch = tfCoilSession.toSketchDef();
        expect(store.upsertSketch(tfCoilSketch).success).toBe(true);
        expect(
            store.addFeature({
                id: 'tf-coil-pad',
                name: 'tf-coil-pad',
                type: 'pad',
                body: tf_coils,
                sketchId: tfCoilSketch.id,
                params: { length: 40, axis: 'y', symmetric: true },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        expect(
            store.addFeature({
                id: 'tf-coil-pattern',
                name: 'tf-coil-pattern',
                type: 'circularPattern',
                body: tf_coils,
                params: { source: 'tf-coil-pad', count: 7, angle: 180, axis: 'z' },
                dependsOn: ['tf-coil-pad'],
                suppressed: false
            }).success
        ).toBe(true);

        // The center column is the cylinder cut by the TF coil inner leg, matching the STEP layer_2 solid.
        expect(
            store.addFeature({
                id: 'center-column-cut',
                name: 'center-column-cut',
                type: 'booleanCut',
                body: center_column,
                params: { targetBody: center_column, toolBodies: [tf_coils], keepTools: true },
                dependsOn: ['center-column', 'tf-coil-pattern'],
                suppressed: false
            }).success
        ).toBe(true);

        const wedgeSketch = await addSketch('wedge-sketch', 'datum-xy', async (s) => {
            await drawRectangle(s, -1000, 0, 1000, 1000);
            await closeAndAnchor(s);
        });
        expect(
            store.addFeature({
                id: 'wedge-pad',
                name: 'wedge-pad',
                type: 'pad',
                body: cuttingWedge,
                sketchId: wedgeSketch.id,
                params: { length: 2000, axis: 'z', symmetric: true },
                dependsOn: [],
                suppressed: false
            }).success
        ).toBe(true);
        expect(
            store.addFeature({
                id: 'tf-coil-clip',
                name: 'tf-coil-clip',
                type: 'booleanCommon',
                body: tf_coils,
                params: { targetBody: tf_coils, toolBodies: [cuttingWedge], keepTools: false },
                dependsOn: ['wedge-pad'],
                suppressed: false
            }).success
        ).toBe(true);

        return store.document!;
    }

    it('builds the tokamak document and validates', async () => {
        const doc = await buildTokamakDocument();
        const validation = validateNukeCadDocument(doc);
        expect(validation.valid).toBe(true);
    }, 60000);

    it('produces a deterministic fixture that matches the committed asset', async () => {
        const doc = await buildTokamakDocument();
        const fixturePath = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'assets', 'tokamak_with_divertor.nuke-cad');
        if (process.env.NUKE_CAD_WRITE_FIXTURE === '1') {
            fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
            fs.writeFileSync(fixturePath, canonicalJson(doc) + '\n', 'utf-8');
        }
        expect(fs.existsSync(fixturePath)).toBe(true);
        const fixtureDoc = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as NukeCadDocument;
        expect(canonicalJson(doc)).toBe(canonicalJson(fixtureDoc));
    }, 60000);
});
