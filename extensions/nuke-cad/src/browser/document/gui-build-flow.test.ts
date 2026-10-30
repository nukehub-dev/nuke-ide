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

/**
 * GUI-path end-to-end driver for the nuke-cad document modeler.
 *
 * These tests exercise the same public session + store APIs the viewport uses,
 * with no DOM. They prove that the L-bracket and pincell demo models can be
 * authored parametrically, validated, and serialized to the backend-compatible
 * .nuke-cad format.
 */

describe('GUI build flow', () => {
    async function makeSession(id: string, datumId = 'datum-xy'): Promise<SketchSession> {
        // Each session needs its own solver instance; primitives do not share
        // ids across sketches in the real GUI either.
        const sessionSolver = await PlanegcsSketchSolver.create();
        return SketchSession.create(sessionSolver, {
            id,
            name: id,
            datumId,
            snap: { radius: 0.25, gridPitch: 0.001 }
        });
    }

    function pointAt(session: SketchSession, x: number, y: number, tolerance = 1e-6): SketchPrimitive & { type: 'point' } {
        for (const p of session.getPrimitives()) {
            if (p.type === 'point' && Math.abs(p.x - x) < tolerance && Math.abs(p.y - y) < tolerance) {
                return p as SketchPrimitive & { type: 'point' };
            }
        }
        throw new Error(`No point at (${x}, ${y})`);
    }

    function lineBetween(session: SketchSession, x1: number, y1: number, x2: number, y2: number): SketchPrimitive & { type: 'line' } {
        for (const p of session.getPrimitives()) {
            if (p.type !== 'line') {
                continue;
            }
            const a = session.getPrimitive(p.p1Id);
            const b = session.getPrimitive(p.p2Id);
            if (
                a?.type === 'point' &&
                b?.type === 'point' &&
                ((Math.abs(a.x - x1) < 1e-6 && Math.abs(a.y - y1) < 1e-6 && Math.abs(b.x - x2) < 1e-6 && Math.abs(b.y - y2) < 1e-6) ||
                    (Math.abs(a.x - x2) < 1e-6 && Math.abs(a.y - y2) < 1e-6 && Math.abs(b.x - x1) < 1e-6 && Math.abs(b.y - y1) < 1e-6))
            ) {
                return p as SketchPrimitive & { type: 'line' };
            }
        }
        throw new Error(`No line from (${x1}, ${y1}) to (${x2}, ${y2})`);
    }

    function circleAt(session: SketchSession, x: number, y: number): SketchPrimitive & { type: 'circle' } {
        for (const p of session.getPrimitives()) {
            if (p.type !== 'circle') {
                continue;
            }
            const c = session.getPrimitive(p.centerId);
            if (c?.type === 'point' && Math.abs(c.x - x) < 1e-6 && Math.abs(c.y - y) < 1e-6) {
                return p as SketchPrimitive & { type: 'circle' };
            }
        }
        throw new Error(`No circle at (${x}, ${y})`);
    }

    function circleWithRadius(session: SketchSession, radius: number, tolerance = 1e-9): SketchPrimitive & { type: 'circle' } {
        for (const p of session.getPrimitives()) {
            if (p.type === 'circle' && Math.abs(p.radius - radius) < tolerance) {
                return p as SketchPrimitive & { type: 'circle' };
            }
        }
        throw new Error(`No circle with radius ${radius}`);
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

    async function addParametricDimension(
        session: SketchSession,
        dimensionId: string,
        paramName: string,
        paramValue: number
    ): Promise<void> {
        await session.addParameter(paramName, paramValue);
        const edit = await session.editDimension(dimensionId, { parameter: paramName });
        expect(edit.success).toBe(true);
    }

    async function restoreSketch(def: SketchDef, inherited: Record<string, number>): Promise<SketchSession> {
        const restoreSolver = await PlanegcsSketchSolver.create();
        return SketchSession.fromSketchDef(def, restoreSolver, { inheritedParameters: inherited });
    }

    describe('parametric L-bracket', () => {
        it('draws, constrains, pads, and re-solves on parameter edits', async () => {
            const store = new CadDocumentStore();
            expect(store.createDocument('l-bracket').success).toBe(true);

            const session = await makeSession('bracket-profile', 'datum-xy');
            await session.setTool('line');

            // Draw an L profile counter-clockwise from the origin. The line tool
            // creates one segment per pair of clicks; each new segment starts by
            // snapping back to the previous endpoint.
            const legLength = 50;
            const legWidth = 10;
            await session.click({ x: 0, y: 0 });
            await session.click({ x: legLength, y: 0 });
            await session.click({ x: legLength, y: 0 });
            await session.click({ x: legLength, y: legWidth });
            await session.click({ x: legLength, y: legWidth });
            await session.click({ x: legWidth, y: legWidth });
            await session.click({ x: legWidth, y: legWidth });
            await session.click({ x: legWidth, y: legLength });
            await session.click({ x: legWidth, y: legLength });
            await session.click({ x: 0, y: legLength });
            await session.click({ x: 0, y: legLength });
            await session.click({ x: 0, y: 0 });

            // Anchor the profile and drive the two key dimensions with parameters.
            const origin = pointAt(session, 0, 0);
            const fix = await session.addConstraint('fix', [origin.id]);
            expect(fix.success).toBe(true);

            const bottom = lineBetween(session, 0, 0, legLength, 0);
            // Signed distance convention: value = target1.<coord> - target2.<coord>.
            const bottomDim = await session.addDimension('distanceH', [bottom.p2Id, bottom.p1Id], legLength);
            expect(bottomDim.success).toBe(true);
            await addParametricDimension(session, bottomDim.dimensionId!, 'legLength', legLength);

            const right = lineBetween(session, legLength, 0, legLength, legWidth);
            const rightDim = await session.addDimension('distanceV', [right.p2Id, right.p1Id], legWidth);
            expect(rightDim.success).toBe(true);
            await addParametricDimension(session, rightDim.dimensionId!, 'legWidth', legWidth);

            const leftOuter = lineBetween(session, 0, legLength, 0, 0);
            const leftDim = await session.addDimension('distanceV', [leftOuter.p1Id, leftOuter.p2Id], legLength);
            expect(leftDim.success).toBe(true);
            await addParametricDimension(session, leftDim.dimensionId!, 'legLength', legLength);

            const topInner = lineBetween(session, legLength, legWidth, legWidth, legWidth);
            const innerDim = await session.addDimension('distanceH', [topInner.p1Id, topInner.p2Id], legLength - legWidth);
            expect(innerDim.success).toBe(true);

            expect(session.getStatus().dof).toBe(0);
            expect(session.getStatus().fullyConstrained).toBe(true);

            const sketchDef = session.toSketchDef();
            expect(store.upsertSketch(sketchDef).success).toBe(true);

            const body = store.addBody('bracket', 'bracket');
            expect(body.success).toBe(true);
            const feature = {
                id: 'bracket',
                name: 'bracket',
                type: 'pad' as const,
                body: body.value!,
                sketchId: sketchDef.id,
                params: { length: 10 },
                dependsOn: [],
                suppressed: false
            };
            expect(store.addFeature(feature).success).toBe(true);

            const doc = store.document!;
            const validation = validateNukeCadDocument(doc);
            expect(validation.valid).toBe(true);
            expect(doc.parameters.legLength).toBe(legLength);
            expect(doc.parameters.legWidth).toBe(legWidth);

            // Edit the document parameter and prove the sketch re-solves.
            const newLength = 70;
            expect(store.setParameter('legLength', newLength).success).toBe(true);

            const reloaded = await restoreSketch(doc.sketches[0], store.document!.parameters);
            const rebuiltBottom = lineBetween(reloaded, 0, 0, newLength, 0);
            const rebuiltP2 = reloaded.getPrimitive(rebuiltBottom.p2Id);
            expect(rebuiltP2?.type).toBe('point');
            expect((rebuiltP2 as Extract<SketchPrimitive, { type: 'point' }>).x).toBeCloseTo(newLength, 10);
        });
    });

    describe('parametric pincell', () => {
        async function buildPincellDocument(): Promise<NukeCadDocument> {
            const store = new CadDocumentStore();
            expect(store.createDocument('pincell').success).toBe(true);

            const fuelRadius = 0.4;
            const cladRadius = 0.5;
            const pitch = 1.26;
            const height = 1.0;

            // Fuel cylinder sketch: single circle.
            const fuelSession = await makeSession('fuel-sketch', 'datum-xy');
            await fuelSession.setTool('circle');
            await fuelSession.click({ x: 0, y: 0 });
            await fuelSession.click({ x: fuelRadius, y: 0 });
            const fuelCenter = pointAt(fuelSession, 0, 0);
            await fuelSession.addConstraint('fix', [fuelCenter.id]);
            const fuelDim = await fuelSession.addDimension('radius', [circleAt(fuelSession, 0, 0).id], fuelRadius);
            expect(fuelDim.success).toBe(true);
            await addParametricDimension(fuelSession, fuelDim.dimensionId!, 'fuelRadius', fuelRadius);
            expect(fuelSession.getStatus().dof).toBe(0);
            const fuelSketch = fuelSession.toSketchDef();
            expect(store.upsertSketch(fuelSketch).success).toBe(true);

            // Clad annulus sketch: concentric inner/outer circles. The sketcher
            // turns circle-inside-circle into a single annulus face; extruding it
            // gives the hollow clad cylinder that touches but does not overlap fuel.
            const cladSession = await makeSession('clad-sketch', 'datum-xy');
            await cladSession.setTool('circle');
            await cladSession.click({ x: 0, y: 0 });
            await cladSession.click({ x: fuelRadius, y: 0 });
            await cladSession.setTool('circle');
            await cladSession.click({ x: 0, y: 0 });
            await cladSession.click({ x: cladRadius, y: 0 });
            const cladCircles = cladSession
                .getPrimitives()
                .filter((p): p is SketchPrimitive & { type: 'circle' } => p.type === 'circle')
                .sort((a, b) => a.radius - b.radius);
            expect(cladCircles).toHaveLength(2);
            const [innerCladCircle, outerCladCircle] = cladCircles;
            await cladSession.addConstraint('fix', [cladSession.getPrimitive(innerCladCircle.centerId)!.id]);
            await cladSession.addConstraint('fix', [cladSession.getPrimitive(outerCladCircle.centerId)!.id]);
            const innerCladDim = await cladSession.addDimension('radius', [innerCladCircle.id], fuelRadius);
            expect(innerCladDim.success).toBe(true);
            // The inner circle tracks the fuel radius so the annulus wall thickness
            // stays correct when fuelRadius changes.
            await addParametricDimension(cladSession, innerCladDim.dimensionId!, 'fuelRadius', fuelRadius);
            const outerCladDim = await cladSession.addDimension('radius', [outerCladCircle.id], cladRadius);
            expect(outerCladDim.success).toBe(true);
            await addParametricDimension(cladSession, outerCladDim.dimensionId!, 'cladRadius', cladRadius);
            expect(cladSession.getStatus().dof).toBe(0);
            const cladSketch = cladSession.toSketchDef();
            expect(store.upsertSketch(cladSketch).success).toBe(true);

            // Moderator box sketch: square pitch box with a concentric clad hole.
            const modSession = await makeSession('moderator-sketch', 'datum-xy');
            await modSession.setTool('rectangle');
            await modSession.click({ x: -pitch / 2, y: -pitch / 2 });
            await modSession.click({ x: pitch / 2, y: pitch / 2 });
            await modSession.setTool('circle');
            await modSession.click({ x: 0, y: 0 });
            await modSession.click({ x: cladRadius, y: 0 });
            const modCorner = pointAt(modSession, -pitch / 2, -pitch / 2);
            const modCenter = pointAt(modSession, 0, 0);
            await modSession.addConstraint('fix', [modCorner.id]);
            await modSession.addConstraint('fix', [modCenter.id]);
            const widthDim = await modSession.addDimension(
                'distanceH',
                [pointAt(modSession, pitch / 2, -pitch / 2).id, modCorner.id],
                pitch
            );
            expect(widthDim.success).toBe(true);
            await addParametricDimension(modSession, widthDim.dimensionId!, 'pitch', pitch);
            const heightDim = await modSession.addDimension(
                'distanceV',
                [pointAt(modSession, -pitch / 2, pitch / 2).id, modCorner.id],
                pitch
            );
            expect(heightDim.success).toBe(true);
            await addParametricDimension(modSession, heightDim.dimensionId!, 'pitch', pitch);
            const holeDim = await modSession.addDimension('radius', [circleAt(modSession, 0, 0).id], cladRadius);
            expect(holeDim.success).toBe(true);
            await addParametricDimension(modSession, holeDim.dimensionId!, 'cladRadius', cladRadius);
            expect(modSession.getStatus().dof).toBe(0);
            const modSketch = modSession.toSketchDef();
            expect(store.upsertSketch(modSketch).success).toBe(true);

            // Create bodies in the order that preserves the v1 selector map
            // (clad, fuel, moderator) so the committed fixture stays stable.
            const cladBody = store.addBody('clad', 'clad');
            const fuelBody = store.addBody('fuel', 'fuel');
            const modBody = store.addBody('moderator', 'moderator');
            expect(cladBody.success && fuelBody.success && modBody.success).toBe(true);

            // Three additive pads produce sealed, non-overlapping solids.
            const fuelFeature = {
                id: 'fuel',
                name: 'fuel',
                type: 'pad' as const,
                body: fuelBody.value!,
                sketchId: fuelSketch.id,
                params: { length: height },
                dependsOn: [],
                suppressed: false
            };
            expect(store.addFeature(fuelFeature).success).toBe(true);

            const cladFeature = {
                id: 'clad',
                name: 'clad',
                type: 'pad' as const,
                body: cladBody.value!,
                sketchId: cladSketch.id,
                params: { length: height },
                dependsOn: [],
                suppressed: false
            };
            expect(store.addFeature(cladFeature).success).toBe(true);

            const modFeature = {
                id: 'moderator',
                name: 'moderator',
                type: 'pad' as const,
                body: modBody.value!,
                sketchId: modSketch.id,
                params: { length: height },
                dependsOn: [],
                suppressed: false
            };
            expect(store.addFeature(modFeature).success).toBe(true);

            return store.document!;
        }

        it('builds a sealed three-region pincell and re-solves on parameter edits', async () => {
            const doc = await buildPincellDocument();
            const validation = validateNukeCadDocument(doc);
            expect(validation.valid).toBe(true);
            expect(doc.parameters.fuelRadius).toBe(0.4);
            expect(doc.parameters.cladRadius).toBe(0.5);

            const store = new CadDocumentStore();
            expect(store.loadDocument(doc).success).toBe(true);

            // Change the fuel radius and prove both the fuel cylinder and the
            // clad annulus inner radius re-solve.
            expect(store.setParameter('fuelRadius', 0.45).success).toBe(true);
            const fuelReloaded = await restoreSketch(doc.sketches[0], store.document!.parameters);
            const fuelCladReloaded = await restoreSketch(doc.sketches[1], store.document!.parameters);
            expect(fuelReloaded.getStatus().dof).toBe(0);
            expect(fuelCladReloaded.getStatus().dof).toBe(0);
            expect(circleAt(fuelReloaded, 0, 0).radius).toBeCloseTo(0.45, 10);
            expect(circleWithRadius(fuelCladReloaded, 0.45).radius).toBeCloseTo(0.45, 10);

            // Change the clad radius and prove both the clad annulus outer radius
            // and the moderator hole re-solve.
            expect(store.setParameter('cladRadius', 0.55).success).toBe(true);
            const cladReloaded = await restoreSketch(doc.sketches[1], store.document!.parameters);
            const modReloaded = await restoreSketch(doc.sketches[2], store.document!.parameters);
            expect(cladReloaded.getStatus().dof).toBe(0);
            expect(modReloaded.getStatus().dof).toBe(0);
            expect(circleWithRadius(cladReloaded, 0.55).radius).toBeCloseTo(0.55, 10);
            expect(circleAt(modReloaded, 0, 0).radius).toBeCloseTo(0.55, 10);
        });

        it('produces a deterministic fixture that matches the committed asset', async () => {
            const doc = await buildPincellDocument();
            const fixturePath = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'assets', 'gui_pincell.nuke-cad');

            if (process.env.NUKE_CAD_WRITE_FIXTURE === '1') {
                fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
                fs.writeFileSync(fixturePath, canonicalJson(doc) + '\n', 'utf-8');
            }

            expect(fs.existsSync(fixturePath)).toBe(true);
            const fixtureDoc = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as NukeCadDocument;
            expect(canonicalJson(doc)).toBe(canonicalJson(fixtureDoc));
        });
    });
});
