// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
//
// Redistribution and use in source and binary forms, without modification, are
// permitted provided that the following conditions are met:
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
 * Real-solver check for component-template parameter overrides.
 *
 * The capability tests fake the sketch transaction; this suite proves the
 * shipped pincell template really re-solves its sketches and moves the stored
 * primitives, which is what the backend builds.
 */

import { describe, expect, it } from 'vitest';
import type { NukeCadDocument } from '../../common/cad-document';
import {
    componentParameterSketchIds,
    getComponentTemplate,
    instantiateComponentTemplate,
    resolveComponentTemplateParameters
} from '../../common/component-templates';
import { PlanegcsSketchSolver } from '../../common/sketch-solver';
import { NukeCadSketchEditService } from '../sketch/sketch-edit-service';

const template = getComponentTemplate('pincell');

/** Apply resolved values the same way the creation capability does. */
async function applyValues(document: NukeCadDocument, values: Readonly<Record<string, number>>): Promise<NukeCadDocument> {
    const service = new NukeCadSketchEditService(() => PlanegcsSketchSolver.create());
    let candidate = document;
    for (const [name, value] of Object.entries(values)) {
        if (candidate.parameters[name] === value) {
            continue;
        }
        const sketchId = componentParameterSketchIds(candidate, name)[0];
        expect(sketchId).toBeDefined();
        const prepared = await service.prepare(candidate, [{ sketchId: sketchId as string, parameterName: name, value }]);
        if (!prepared.ok) {
            throw new Error(`${name}: ${prepared.message}`);
        }
        expect(prepared.result.solver.status).toBe('converged');
        candidate = prepared.result.afterDocument;
    }
    return candidate;
}

/** Radii stored on a sketch's circles. */
function circleRadii(document: NukeCadDocument, sketchId: string): number[] {
    const sketch = document.sketches.find((entry) => entry.id === sketchId);
    return (sketch?.primitives ?? [])
        .filter((primitive): primitive is { type: 'circle'; radius: number } => primitive.type === 'circle')
        .map((primitive) => primitive.radius);
}

describe('component template parameter solving', () => {
    it('ships a pincell template with the expected document parameters', () => {
        expect(template).toBeDefined();
        expect(template?.document.units).toBe('cm');
        expect(template?.document.parameters).toEqual({ fuelRadius: 0.4, cladRadius: 0.5, pitch: 1.26 });
    });

    it('moves the stored circle radii when the fuel radius changes', async () => {
        const resolved = resolveComponentTemplateParameters(template!, { fuelRadius: 0.45 });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) {
            return;
        }
        const document = await applyValues(instantiateComponentTemplate(template!, 'solved'), resolved.values);
        expect(document.parameters.fuelRadius).toBeCloseTo(0.45);
        expect(circleRadii(document, 'fuel-sketch')).toContainEqual(expect.closeTo(0.45, 9));
        expect(circleRadii(document, 'clad-sketch')).toContainEqual(expect.closeTo(0.45, 9));
        expect(circleRadii(document, 'clad-sketch')).toContainEqual(expect.closeTo(0.5, 9));
    });

    it('resolves a diameter alias into the radius parameter and the geometry', async () => {
        const resolved = resolveComponentTemplateParameters(template!, { cladDiameter: 1.1 });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) {
            return;
        }
        const document = await applyValues(instantiateComponentTemplate(template!, 'solved'), resolved.values);
        expect(document.parameters.cladRadius).toBeCloseTo(0.55);
        expect(circleRadii(document, 'clad-sketch')).toContainEqual(expect.closeTo(0.55, 9));
    });

    it('moves the moderator box when the pitch changes', async () => {
        const resolved = resolveComponentTemplateParameters(template!, { pitch: 1.4 });
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) {
            return;
        }
        const document = await applyValues(instantiateComponentTemplate(template!, 'solved'), resolved.values);
        expect(document.parameters.pitch).toBeCloseTo(1.4);
        const points = (document.sketches.find((entry) => entry.id === 'moderator-sketch')?.primitives ?? []).filter(
            (primitive) => primitive.type === 'point'
        ) as { x: number; y: number }[];
        // The square stays centred on the fuel pin: every corner sits at ±pitch/2.
        const extent = Math.max(...points.map((point) => Math.abs(point.x)), ...points.map((point) => Math.abs(point.y)));
        expect(extent).toBeCloseTo(0.7, 6);
    });
});
