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
import { validateNukeCadDocument, type NukeCadDocument } from './cad-document';
import {
    COMPONENT_TEMPLATES,
    componentParameterSketchIds,
    getComponentTemplate,
    instantiateComponentTemplate,
    listComponentTemplates,
    resolveComponentTemplateParameters,
    validateComponentTemplate,
    validateComponentTemplateLibrary,
    type ComponentTemplate,
    type ComponentTemplateResolveResult
} from './component-templates';
import { createEmptyNukeCadDocument } from './document-templates';

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

function templateById(id: string): ComponentTemplate {
    const template = getComponentTemplate(id);
    if (template === undefined) {
        throw new Error(`${id} template is missing`);
    }
    return template;
}

function pincell(): ComponentTemplate {
    return templateById('pincell');
}

const PRIMITIVE_IDS = ['box', 'cone', 'cylinder', 'plate-with-hole', 'sphere', 'tube'] as const;
const ALL_TEMPLATE_IDS = ['box', 'cone', 'cylinder', 'plate-with-hole', 'sphere', 'tube', 'pincell'];

function countTemplate(): ComponentTemplate {
    return {
        id: 'count-test',
        name: 'Count test',
        description: 'Synthetic template used to exercise count validation.',
        category: 'primitives',
        keywords: ['test'],
        parameters: [{ name: 'holeCount', label: 'Holes', kind: 'count', unit: '1', default: 4, min: 1, max: 8 }],
        document: { ...createEmptyNukeCadDocument('count-test'), units: 'cm', parameters: { holeCount: 4 } }
    };
}

describe('component template library', () => {
    it('ships a valid pincell template', () => {
        expect(COMPONENT_TEMPLATES.map((template) => template.id)).toEqual(ALL_TEMPLATE_IDS);
        const template = pincell();
        expect(template.name).toBe('Pincell');
        expect(template.category).toBe('nuclear');
        expect(template.document.units).toBe('cm');
        expect(validateComponentTemplateLibrary()).toEqual([]);
        expect(validateNukeCadDocument(template.document).valid).toBe(true);
    });

    it('ships the six primitive templates', () => {
        for (const id of PRIMITIVE_IDS) {
            const template = templateById(id);
            expect(template.category, id).toBe('primitives');
            expect(template.document.units, id).toBe('cm');
            expect(template.parameters.length, id).toBeLessThanOrEqual(12);
            expect(validateComponentTemplate(template), id).toEqual([]);
            expect(validateNukeCadDocument(template.document).valid, id).toBe(true);
            expect(
                template.document.features.some((feature) => feature.type === 'import'),
                id
            ).toBe(false);
        }
    });

    it('leaves every primitive body labelled and untagged', () => {
        for (const id of PRIMITIVE_IDS) {
            const template = templateById(id);
            expect(template.document.bodies.length, id).toBeGreaterThan(0);
            for (const body of template.document.bodies) {
                expect(body.label?.trim(), id).toBeTruthy();
                expect(body.material, id).toBeUndefined();
            }
        }
    });

    it('tags every pincell body with a bare material', () => {
        const materials = Object.fromEntries(pincell().document.bodies.map((body) => [body.label, body.material]));
        expect(materials).toEqual({ clad: 'Zircaloy-4', fuel: 'UO2', moderator: 'H2O' });
    });

    it('lists and filters templates by category and query', () => {
        expect(listComponentTemplates()).toHaveLength(ALL_TEMPLATE_IDS.length);
        expect(listComponentTemplates().map((template) => template.id)).toEqual([
            'box',
            'cone',
            'cylinder',
            'pincell',
            'plate-with-hole',
            'sphere',
            'tube'
        ]);
        expect(listComponentTemplates({ category: 'nuclear' }).map((template) => template.id)).toEqual(['pincell']);
        expect(listComponentTemplates({ category: 'primitives' }).map((template) => template.id)).toEqual([...PRIMITIVE_IDS]);
        expect(listComponentTemplates({ category: 'mechanical' })).toEqual([]);
        expect(listComponentTemplates({ query: 'PWR' }).map((template) => template.id)).toEqual(['pincell']);
        expect(listComponentTemplates({ query: 'pin cell' }).map((template) => template.id)).toEqual(['pincell']);
        expect(listComponentTemplates({ query: 'three-body' }).map((template) => template.id)).toEqual(['pincell']);
        expect(listComponentTemplates({ query: 'box' }).map((template) => template.id)).toEqual(['box']);
        expect(listComponentTemplates({ query: 'hole' }).map((template) => template.id)).toEqual(['plate-with-hole']);
        expect(listComponentTemplates({ query: 'cylinder' }).map((template) => template.id)).toEqual(['cylinder']);
        expect(listComponentTemplates({ query: 'no-such-template' })).toEqual([]);
        expect(getComponentTemplate('missing')).toBeUndefined();
    });

    it('accepts the synthetic count template', () => {
        expect(validateComponentTemplate(countTemplate())).toEqual([]);
    });
});

describe('resolveComponentTemplateParameters', () => {
    it('resolves every default in document units', () => {
        const result = expectSuccess(resolveComponentTemplateParameters(pincell(), {}));
        expect(result.values).toEqual({ fuelRadius: 0.4, cladRadius: 0.5, pitch: 1.26 });
        expect(result.resolved.map((parameter) => parameter.name)).toEqual([
            'fuelRadius',
            'cladRadius',
            'pitch',
            'fuelDiameter',
            'cladDiameter'
        ]);

        const fuelRadius = result.resolved.find((parameter) => parameter.name === 'fuelRadius')!;
        expect(fuelRadius.value).toBeCloseTo(0.4);
        expect(fuelRadius.inputValue).toBeCloseTo(0.4);
        expect(fuelRadius.defaultValue).toBeCloseTo(0.4);
        expect(fuelRadius.min).toBeCloseTo(0.01);
        expect(fuelRadius.max).toBeCloseTo(10);
        expect(fuelRadius.derived).toBe(true);

        const fuelDiameter = result.resolved.find((parameter) => parameter.name === 'fuelDiameter')!;
        expect(fuelDiameter.value).toBeCloseTo(0.8);
        expect(fuelDiameter.inputValue).toBeCloseTo(0.8);
        expect(fuelDiameter.defaultValue).toBeCloseTo(0.8);
        expect(fuelDiameter.derived).toBe(true);
    });

    it('converts length inputs from the requested input unit', () => {
        const result = expectSuccess(resolveComponentTemplateParameters(pincell(), { fuelRadius: 5, pitch: 12.6 }, 'mm'));
        expect(result.values.fuelRadius).toBeCloseTo(0.5);
        expect(result.values.pitch).toBeCloseTo(1.26);

        const fuelRadius = result.resolved.find((parameter) => parameter.name === 'fuelRadius')!;
        expect(fuelRadius.inputValue).toBeCloseTo(0.5);
        expect(fuelRadius.value).toBeCloseTo(0.5);
        expect(fuelRadius.derived).toBe(false);

        const fuelDiameter = result.resolved.find((parameter) => parameter.name === 'fuelDiameter')!;
        expect(fuelDiameter.value).toBeCloseTo(1);
        expect(fuelDiameter.derived).toBe(true);
    });

    it('rejects values outside the declared range', () => {
        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { fuelRadius: 20 }))).toContain('fuelRadius');
        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { cladRadius: 0.001 }))).toContain('cladRadius');
        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { fuelRadius: 200 }, 'mm'))).toContain('fuelRadius');
    });

    it('rejects unknown and non-finite overrides', () => {
        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { nope: 1 }))).toContain("'nope'");
        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { fuelRadius: Number.NaN }))).toContain('fuelRadius');
        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { fuelRadius: Number.POSITIVE_INFINITY }))).toContain(
            'fuelRadius'
        );
    });

    it('rejects non-integer and non-positive counts', () => {
        expect(expectFailure(resolveComponentTemplateParameters(countTemplate(), { holeCount: 2.5 }))).toContain('positive integer');
        expect(expectFailure(resolveComponentTemplateParameters(countTemplate(), { holeCount: 0 }))).toContain('positive integer');
        const result = expectSuccess(resolveComponentTemplateParameters(countTemplate(), { holeCount: 3 }));
        expect(result.values.holeCount).toBe(3);
        expect(result.resolved[0].value).toBe(3);
        expect(result.resolved[0].derived).toBe(false);
    });

    it('resolves a diameter alias into its radius document parameter', () => {
        const result = expectSuccess(resolveComponentTemplateParameters(pincell(), { cladDiameter: 1 }));
        expect(result.values.cladRadius).toBeCloseTo(0.5);
        const cladRadius = result.resolved.find((parameter) => parameter.name === 'cladRadius')!;
        expect(cladRadius.value).toBeCloseTo(0.5);
        expect(cladRadius.derived).toBe(true);
        const cladDiameter = result.resolved.find((parameter) => parameter.name === 'cladDiameter')!;
        expect(cladDiameter.value).toBeCloseTo(1);
        expect(cladDiameter.inputValue).toBeCloseTo(1);
        expect(cladDiameter.derived).toBe(false);
    });

    it('accepts a consistent radius/diameter pair and rejects an inconsistent one', () => {
        const consistent = expectSuccess(resolveComponentTemplateParameters(pincell(), { cladRadius: 0.5, cladDiameter: 1 }));
        expect(consistent.values.cladRadius).toBeCloseTo(0.5);
        expect(consistent.resolved.find((parameter) => parameter.name === 'cladRadius')!.derived).toBe(false);
        expect(consistent.resolved.find((parameter) => parameter.name === 'cladDiameter')!.derived).toBe(false);

        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { cladRadius: 0.5, cladDiameter: 1.1 }))).toContain('disagree');
    });

    it('enforces the target range through a derived alias', () => {
        expect(expectFailure(resolveComponentTemplateParameters(pincell(), { fuelDiameter: 30 }))).toContain('fuelDiameter');
    });
});

describe('instantiateComponentTemplate', () => {
    it('deep-clones the template body into an independent document', () => {
        const template = pincell();
        const clone = instantiateComponentTemplate(template, 'My pincell');
        expect(clone.name).toBe('My pincell');
        expect(clone).not.toBe(template.document);
        expect(clone.parameters).toEqual(template.document.parameters);
        expect(validateNukeCadDocument(clone).valid).toBe(true);

        clone.parameters.fuelRadius = 99;
        clone.bodies[0].material = 'MOX';
        clone.sketches[0].primitives[0] = { id: 'mutated' };

        expect(template.document.parameters.fuelRadius).toBe(0.4);
        expect(template.document.bodies[0].material).toBe('Zircaloy-4');
        expect(template.document.sketches[0].primitives[0]).not.toEqual({ id: 'mutated' });
    });
});

describe('componentParameterSketchIds', () => {
    it('finds every pincell sketch that references a parameter', () => {
        const document = pincell().document;
        expect([...componentParameterSketchIds(document, 'fuelRadius')].sort()).toEqual(['clad-sketch', 'fuel-sketch']);
        expect([...componentParameterSketchIds(document, 'cladRadius')].sort()).toEqual(['clad-sketch', 'moderator-sketch']);
        expect(componentParameterSketchIds(document, 'pitch')).toEqual(['moderator-sketch']);
        expect(componentParameterSketchIds(document, 'missing')).toEqual([]);

        const all = new Set<string>();
        for (const name of ['fuelRadius', 'cladRadius', 'pitch']) {
            for (const id of componentParameterSketchIds(document, name)) {
                all.add(id);
            }
        }
        expect([...all].sort()).toEqual(['clad-sketch', 'fuel-sketch', 'moderator-sketch']);
    });

    it('includes parameter-driven curve ids', () => {
        const document: NukeCadDocument = {
            ...pincell().document,
            curves: [
                {
                    id: 'curve-1',
                    name: 'pitch spiral',
                    source: {
                        kind: 'parametric',
                        x: 'pitch*t',
                        y: '0',
                        z: '0',
                        tStart: 0,
                        tEnd: 1,
                        sampleCount: 8
                    },
                    samples: [
                        [0, 0, 0],
                        [1, 0, 0],
                        [2, 0, 0],
                        [3, 0, 0]
                    ]
                }
            ]
        };
        expect(componentParameterSketchIds(document, 'pitch')).toEqual(['moderator-sketch', 'curve-1']);
        expect(componentParameterSketchIds(document, 'fuelRadius')).toEqual(['fuel-sketch', 'clad-sketch']);
    });
});

describe('primitive component templates', () => {
    it('resolves every default into the document parameter table', () => {
        for (const id of [...PRIMITIVE_IDS, 'pincell']) {
            const template = templateById(id);
            const result = expectSuccess(resolveComponentTemplateParameters(template, {}));
            expect(result.values, id).toEqual(template.document.parameters);
            expect(
                result.resolved.map((parameter) => parameter.name),
                id
            ).toEqual(template.parameters.map((parameter) => parameter.name));
            for (const parameter of result.resolved) {
                expect(parameter.derived, `${id}:${parameter.name}`).toBe(true);
            }
        }
    });

    it('resolves representative overrides for every primitive', () => {
        const cases: ReadonlyArray<{ id: string; overrides: Record<string, number>; expected: Record<string, number> }> = [
            { id: 'box', overrides: { length: 12, width: 7, height: 5 }, expected: { length: 12, width: 7, height: 5 } },
            { id: 'cylinder', overrides: { diameter: 6, height: 10 }, expected: { radius: 3, height: 10 } },
            {
                id: 'tube',
                overrides: { outerDiameter: 8, innerDiameter: 5, height: 9 },
                expected: { outerRadius: 4, innerRadius: 2.5, height: 9 }
            },
            { id: 'sphere', overrides: { diameter: 7 }, expected: { radius: 3.5 } },
            {
                id: 'cone',
                overrides: { bottomDiameter: 8, topDiameter: 4, height: 9 },
                expected: { bottomRadius: 4, topRadius: 2, height: 9 }
            },
            {
                id: 'plate-with-hole',
                overrides: { length: 14, width: 9, thickness: 0.8, holeDiameter: 3, holeOffsetX: 1.5, holeOffsetY: -1 },
                expected: { length: 14, width: 9, thickness: 0.8, holeDiameter: 3, holeOffsetX: 1.5, holeOffsetY: -1 }
            }
        ];
        for (const testCase of cases) {
            const result = expectSuccess(resolveComponentTemplateParameters(templateById(testCase.id), testCase.overrides));
            for (const [name, value] of Object.entries(testCase.expected)) {
                expect(result.values[name], `${testCase.id}:${name}`).toBeCloseTo(value);
            }
            for (const parameter of result.resolved) {
                if (!Object.prototype.hasOwnProperty.call(testCase.overrides, parameter.name)) {
                    continue;
                }
                expect(parameter.derived, `${testCase.id}:${parameter.name}`).toBe(false);
            }
        }
    });

    it('converts primitive length inputs from millimetres', () => {
        const box = expectSuccess(resolveComponentTemplateParameters(templateById('box'), { length: 100, width: 60, height: 40 }, 'mm'));
        expect(box.values).toEqual({ length: 10, width: 6, height: 4 });

        const cylinder = expectSuccess(resolveComponentTemplateParameters(templateById('cylinder'), { diameter: 50, height: 80 }, 'mm'));
        expect(cylinder.values.radius).toBeCloseTo(2.5);
        expect(cylinder.values.height).toBeCloseTo(8);

        const sphere = expectSuccess(resolveComponentTemplateParameters(templateById('sphere'), { diameter: 70 }, 'mm'));
        expect(sphere.values.radius).toBeCloseTo(3.5);
    });

    it('keeps radius/diameter aliases consistent and rejects disagreements', () => {
        const cylinder = templateById('cylinder');
        const both = expectSuccess(resolveComponentTemplateParameters(cylinder, { radius: 2.5, diameter: 5 }));
        expect(both.values.radius).toBeCloseTo(2.5);
        expect(both.resolved.find((parameter) => parameter.name === 'radius')!.derived).toBe(false);
        expect(both.resolved.find((parameter) => parameter.name === 'diameter')!.derived).toBe(false);
        expect(expectFailure(resolveComponentTemplateParameters(cylinder, { radius: 2.5, diameter: 6 }))).toContain('disagree');

        const tube = templateById('tube');
        expect(
            expectSuccess(resolveComponentTemplateParameters(tube, { outerRadius: 3, outerDiameter: 6 })).values.outerRadius
        ).toBeCloseTo(3);
        expect(expectFailure(resolveComponentTemplateParameters(tube, { outerRadius: 3, outerDiameter: 7 }))).toContain('disagree');

        const sphere = templateById('sphere');
        expect(expectFailure(resolveComponentTemplateParameters(sphere, { radius: 3, diameter: 7 }))).toContain('disagree');
    });

    it('rejects unknown and out-of-range primitive overrides', () => {
        const box = templateById('box');
        expect(expectFailure(resolveComponentTemplateParameters(box, { length: 0 }))).toContain('length');
        expect(expectFailure(resolveComponentTemplateParameters(box, { length: 300 }))).toContain('length');
        expect(expectFailure(resolveComponentTemplateParameters(box, { nope: 1 }))).toContain("'nope'");

        const plate = templateById('plate-with-hole');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { thickness: 0.001 }))).toContain('thickness');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { holeOffsetX: 500 }))).toContain('holeOffsetX');

        expect(expectFailure(resolveComponentTemplateParameters(templateById('tube'), { outerDiameter: 0.1 }))).toContain('outerDiameter');
        expect(expectFailure(resolveComponentTemplateParameters(templateById('sphere'), { diameter: 0.05 }))).toContain('diameter');
        expect(expectFailure(resolveComponentTemplateParameters(templateById('cone'), { topDiameter: 500 }))).toContain('topDiameter');
    });

    it('references every document parameter from at least one primitive sketch', () => {
        for (const id of [...PRIMITIVE_IDS, 'pincell']) {
            const document = templateById(id).document;
            for (const name of Object.keys(document.parameters)) {
                expect(componentParameterSketchIds(document, name).length, `${id}:${name}`).toBeGreaterThan(0);
            }
        }
    });

    it('includes the straight sweep path for box and plate extrusion parameters', () => {
        expect(componentParameterSketchIds(templateById('box').document, 'height')).toEqual(['box-profile', 'box-height-path']);
        expect(componentParameterSketchIds(templateById('plate-with-hole').document, 'thickness')).toEqual([
            'plate-profile',
            'plate-thickness-path'
        ]);
        expect(componentParameterSketchIds(templateById('cylinder').document, 'radius')).toEqual(['cylinder-profile']);
        expect(componentParameterSketchIds(templateById('cylinder').document, 'diameter')).toEqual([]);
    });

    it('instantiates a primitive without sharing the template body', () => {
        const template = templateById('box');
        const clone = instantiateComponentTemplate(template, 'My box');
        expect(clone.name).toBe('My box');
        expect(clone).not.toBe(template.document);
        expect(validateNukeCadDocument(clone).valid).toBe(true);

        clone.parameters.length = 99;
        clone.bodies[0].label = 'mutated';
        expect(template.document.parameters.length).toBe(10);
        expect(template.document.bodies[0].label).toBe('box');
    });
});

describe('validateComponentTemplate', () => {
    it('reports document and parameter contract violations', () => {
        const template = pincell();
        const broken: ComponentTemplate = {
            ...template,
            parameters: template.parameters.map((parameter) =>
                parameter.name === 'fuelRadius' ? { ...parameter, default: 20 } : parameter
            ),
            document: { ...template.document, units: undefined }
        };
        const errors = validateComponentTemplate(broken);
        expect(errors.some((error) => error.includes('units'))).toBe(true);
        expect(errors.some((error) => error.includes('above its maximum'))).toBe(true);
    });
});
