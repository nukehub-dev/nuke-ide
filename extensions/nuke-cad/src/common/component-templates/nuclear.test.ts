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

import { describe, expect, it } from 'vitest';
import { validateNukeCadDocument } from '../cad-document';
import {
    componentParameterSketchIds,
    resolveComponentTemplateParameters,
    validateComponentTemplate,
    type ComponentTemplate,
    type ComponentTemplateResolveResult
} from './index';
import { NUCLEAR_COMPONENT_TEMPLATES, validateGuideTubeWall } from './nuclear';

const NUCLEAR_IDS = ['hex-cell', 'control-rod-guide-tube', 'assembly-grid-plate'] as const;

function templateById(id: string): ComponentTemplate {
    const template = NUCLEAR_COMPONENT_TEMPLATES.find((candidate) => candidate.id === id);
    if (template === undefined) {
        throw new Error(`${id} template is missing`);
    }
    return template;
}

function expectSuccess(result: ComponentTemplateResolveResult): Extract<ComponentTemplateResolveResult, { ok: true }> {
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result;
}

function expectFailure(result: ComponentTemplateResolveResult): string {
    if (result.ok) {
        throw new Error('Expected parameter resolution to fail');
    }
    return result.message;
}

describe('nuclear component templates', () => {
    it('ships the three nuclear templates in a stable order', () => {
        expect(NUCLEAR_COMPONENT_TEMPLATES.map((template) => template.id)).toEqual([...NUCLEAR_IDS]);
        expect(templateById('hex-cell').parameters.map((parameter) => parameter.name)).toEqual(
            expect.arrayContaining(['pitch', 'fuelRadius', 'cladRadius', 'height'])
        );
        expect(templateById('control-rod-guide-tube').parameters.map((parameter) => parameter.name)).toEqual(
            expect.arrayContaining(['outerDiameter', 'innerDiameter', 'length', 'wallThickness'])
        );
        expect(templateById('assembly-grid-plate').parameters.map((parameter) => parameter.name)).toEqual(
            expect.arrayContaining(['width', 'height', 'plateThickness', 'cellPitch', 'cellCount', 'cellDiameter'])
        );
        for (const template of NUCLEAR_COMPONENT_TEMPLATES) {
            expect(template.category, template.id).toBe('nuclear');
            expect(template.document.units, template.id).toBe('cm');
            expect(template.parameters.length, template.id).toBeGreaterThan(0);
            expect(template.parameters.length, template.id).toBeLessThanOrEqual(12);
            expect(validateComponentTemplate(template), template.id).toEqual([]);
            expect(validateNukeCadDocument(template.document).valid, template.id).toBe(true);
            expect(
                template.document.features.some((feature) => feature.type === 'import'),
                template.id
            ).toBe(false);
        }
    });

    it('keeps every body labelled and tags the nuclear materials by region', () => {
        const hexMaterials = Object.fromEntries(templateById('hex-cell').document.bodies.map((body) => [body.label, body.material]));
        expect(hexMaterials).toEqual({ fuel: 'UO2', clad: 'Zircaloy-4', moderator: 'H2O' });

        const guide = templateById('control-rod-guide-tube').document;
        expect(guide.bodies).toHaveLength(1);
        expect(guide.bodies[0]).toMatchObject({ label: 'guide-tube', material: 'Zircaloy-4' });

        const plate = templateById('assembly-grid-plate').document;
        expect(plate.bodies).toHaveLength(1);
        expect(plate.bodies[0]).toMatchObject({ label: 'grid-plate', material: 'Zircaloy-4' });

        for (const template of NUCLEAR_COMPONENT_TEMPLATES) {
            for (const body of template.document.bodies) {
                expect(body.label?.trim(), `${template.id}:${body.id}`).toBeTruthy();
                expect(body.material?.trim(), `${template.id}:${body.id}`).toBeTruthy();
            }
        }
    });

    it('resolves every default into the document parameter table', () => {
        for (const template of NUCLEAR_COMPONENT_TEMPLATES) {
            const result = expectSuccess(resolveComponentTemplateParameters(template, {}));
            expect(Object.keys(result.values), template.id).toEqual(Object.keys(template.document.parameters));
            for (const [name, value] of Object.entries(template.document.parameters)) {
                expect(result.values[name], `${template.id}:${name}`).toBeCloseTo(value);
            }
            expect(
                result.resolved.map((parameter) => parameter.name),
                template.id
            ).toEqual(template.parameters.map((parameter) => parameter.name));
            for (const parameter of result.resolved) {
                expect(parameter.derived, `${template.id}:${parameter.name}`).toBe(true);
            }
        }
    });

    it('resolves hex-cell diameter aliases and length-unit conversions', () => {
        const hex = templateById('hex-cell');
        const overrides = expectSuccess(resolveComponentTemplateParameters(hex, { fuelDiameter: 0.9, cladDiameter: 1.0, pitch: 1.4 }));
        expect(overrides.values.fuelRadius).toBeCloseTo(0.45);
        expect(overrides.values.cladRadius).toBeCloseTo(0.5);
        expect(overrides.values.pitch).toBeCloseTo(1.4);
        const fuelDiameter = overrides.resolved.find((parameter) => parameter.name === 'fuelDiameter')!;
        expect(fuelDiameter.value).toBeCloseTo(0.9);
        expect(fuelDiameter.derived).toBe(false);

        const millimetres = expectSuccess(resolveComponentTemplateParameters(hex, { height: 20 }, 'mm'));
        expect(millimetres.values.height).toBeCloseTo(2);
        expect(millimetres.values.fuelRadius).toBeCloseTo(0.4);

        expect(expectFailure(resolveComponentTemplateParameters(hex, { fuelRadius: 0.4, fuelDiameter: 0.9 }))).toContain('disagree');
        expect(expectFailure(resolveComponentTemplateParameters(hex, { pitch: 0.001 }))).toContain('pitch');
        expect(expectFailure(resolveComponentTemplateParameters(hex, { fuelDiameter: 30 }))).toContain('fuelDiameter');
    });

    it('resolves guide-tube diameter aliases and validates the wall relation', () => {
        const guide = templateById('control-rod-guide-tube');
        const resolved = expectSuccess(
            resolveComponentTemplateParameters(guide, {
                outerDiameter: 1.4,
                innerDiameter: 1.2,
                wallThickness: 0.1,
                length: 40
            })
        );
        expect(resolved.values.outerRadius).toBeCloseTo(0.7);
        expect(resolved.values.innerRadius).toBeCloseTo(0.6);
        expect(resolved.values.wallThickness).toBeCloseTo(0.1);
        expect(resolved.values.length).toBeCloseTo(40);
        expect(validateGuideTubeWall(1.2, 1.08, 0.06)).toBeUndefined();
        expect(validateGuideTubeWall(1.4, 1.2, 0.1)).toBeUndefined();

        expect(validateGuideTubeWall(1.4, 1.2, 0.2)).toContain('must equal');
        expect(validateGuideTubeWall(1.2, 1.4, 0.1)).toContain('must be smaller');
        expect(validateGuideTubeWall(Number.NaN, 1.2, 0.1)).toContain('finite');
        expect(validateGuideTubeWall(1.4, 1.2, 0)).toContain('positive');

        expect(expectFailure(resolveComponentTemplateParameters(guide, { outerDiameter: 0.05 }))).toContain('outerDiameter');
        expect(expectFailure(resolveComponentTemplateParameters(guide, { innerRadius: 0.001 }))).toContain('innerRadius');
        expect(expectFailure(resolveComponentTemplateParameters(guide, { length: 500 }))).toContain('length');
    });

    it('resolves grid-plate overrides and rejects invalid counts', () => {
        const plate = templateById('assembly-grid-plate');
        const resolved = expectSuccess(
            resolveComponentTemplateParameters(plate, {
                width: 5,
                height: 4.5,
                plateThickness: 0.4,
                cellPitch: 1.5,
                cellCount: 4,
                cellDiameter: 1
            })
        );
        expect(resolved.values).toEqual({
            width: 5,
            height: 4.5,
            plateThickness: 0.4,
            cellPitch: 1.5,
            cellCount: 4,
            cellDiameter: 1
        });
        expect(resolved.resolved.find((parameter) => parameter.name === 'cellCount')!.value).toBe(4);

        expect(expectFailure(resolveComponentTemplateParameters(plate, { cellCount: 2.5 }))).toContain('positive integer');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { cellCount: 0 }))).toContain('positive integer');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { cellDiameter: 0.001 }))).toContain('cellDiameter');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { width: 0.1 }))).toContain('width');
    });

    it('references every document parameter from at least one sketch or curve', () => {
        for (const template of NUCLEAR_COMPONENT_TEMPLATES) {
            for (const name of Object.keys(template.document.parameters)) {
                expect(componentParameterSketchIds(template.document, name).length, `${template.id}:${name}`).toBeGreaterThan(0);
            }
        }
        expect(componentParameterSketchIds(templateById('hex-cell').document, 'pitch')).toEqual(['hex-moderator-profile']);
        expect(componentParameterSketchIds(templateById('hex-cell').document, 'height')).toContain('hex-cell-height-path');
        expect(componentParameterSketchIds(templateById('control-rod-guide-tube').document, 'wallThickness')).toEqual([
            'guide-tube-profile'
        ]);
        expect(componentParameterSketchIds(templateById('assembly-grid-plate').document, 'cellCount')).toEqual(['grid-plate-profile']);
        expect(componentParameterSketchIds(templateById('assembly-grid-plate').document, 'plateThickness')).toContain(
            'grid-plate-thickness-path'
        );
    });
});
