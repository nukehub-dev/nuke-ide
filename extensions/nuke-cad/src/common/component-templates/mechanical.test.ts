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
    instantiateComponentTemplate,
    resolveComponentTemplateParameters,
    validateComponentTemplate,
    type ComponentTemplate,
    type ComponentTemplateResolveResult
} from '../component-templates';
import { MECHANICAL_COMPONENT_TEMPLATES } from './mechanical';

const MECHANICAL_IDS = ['l-bracket', 'flange', 'stepped-shaft', 'pipe-with-bore', 'bolt-circle-plate'] as const;

const EXPECTED_FEATURES: Readonly<Record<string, readonly string[]>> = {
    'l-bracket': ['sweep'],
    flange: ['revolve', 'groove', 'pocket', 'circularPattern'],
    'stepped-shaft': ['revolve'],
    'pipe-with-bore': ['revolve', 'groove'],
    'bolt-circle-plate': ['revolve', 'pocket', 'circularPattern']
};

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
    const template = MECHANICAL_COMPONENT_TEMPLATES.find((candidate) => candidate.id === id);
    if (template === undefined) {
        throw new Error(`${id} template is missing`);
    }
    return template;
}

function resolvedParameter(result: Extract<ComponentTemplateResolveResult, { ok: true }>, name: string) {
    const parameter = result.resolved.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
        throw new Error(`${name} was not resolved`);
    }
    return parameter;
}

describe('mechanical component templates', () => {
    it('ships five valid mechanical templates', () => {
        expect(MECHANICAL_COMPONENT_TEMPLATES.map((template) => template.id)).toEqual([...MECHANICAL_IDS]);
        expect(new Set(MECHANICAL_COMPONENT_TEMPLATES.map((template) => template.id)).size).toBe(MECHANICAL_IDS.length);
        for (const id of MECHANICAL_IDS) {
            const template = templateById(id);
            expect(template.category, id).toBe('mechanical');
            expect(template.document.units, id).toBe('cm');
            expect(template.parameters.length, id).toBeLessThanOrEqual(12);
            expect(template.parameters.length, id).toBeGreaterThan(0);
            expect(validateComponentTemplate(template), id).toEqual([]);
            expect(validateNukeCadDocument(template.document).valid, id).toBe(true);
            expect(
                template.document.features.some((feature) => feature.type === 'import'),
                id
            ).toBe(false);
        }
    });

    it('leaves every mechanical body labelled and untagged', () => {
        for (const id of MECHANICAL_IDS) {
            const template = templateById(id);
            expect(template.document.bodies.length, id).toBe(1);
            for (const body of template.document.bodies) {
                expect(body.label?.trim(), id).toBeTruthy();
                expect(body.material, id).toBeUndefined();
            }
        }
    });

    it('uses the expected feature graph for each part', () => {
        for (const id of MECHANICAL_IDS) {
            const template = templateById(id);
            expect(
                template.document.features.map((feature) => feature.type),
                id
            ).toEqual([...EXPECTED_FEATURES[id]]);
            expect(
                template.document.features.some((feature) => feature.type === 'circularPattern'),
                id
            ).toBe(id === 'flange' || id === 'bolt-circle-plate');
        }
    });

    it('resolves every default into the document parameter table', () => {
        for (const id of MECHANICAL_IDS) {
            const template = templateById(id);
            const result = expectSuccess(resolveComponentTemplateParameters(template, {}));
            expect(Object.keys(result.values), id).toEqual(Object.keys(template.document.parameters));
            for (const [name, value] of Object.entries(template.document.parameters)) {
                expect(result.values[name], `${id}:${name}`).toBeCloseTo(value);
            }
            expect(
                result.resolved.map((parameter) => parameter.name),
                id
            ).toEqual(template.parameters.map((parameter) => parameter.name));
            for (const parameter of result.resolved) {
                expect(parameter.derived, `${id}:${parameter.name}`).toBe(true);
                expect(parameter.value, `${id}:${parameter.name}`).toBeCloseTo(parameter.defaultValue);
            }
        }
    });

    it('resolves representative overrides and diameter aliases', () => {
        const cases: ReadonlyArray<{
            id: string;
            overrides: Record<string, number>;
            expected: Record<string, number>;
        }> = [
            {
                id: 'l-bracket',
                overrides: { legLength: 10, legWidth: 3, thickness: 0.8, holeDiameter: 1.1, holeCount: 3 },
                expected: { legLength: 10, legWidth: 3, thickness: 0.8, holeDiameter: 1.1, holeCount: 3 }
            },
            {
                id: 'flange',
                overrides: {
                    outerDiameter: 14,
                    innerDiameter: 8,
                    thickness: 1.2,
                    boltCircleDiameter: 11,
                    boltHoleDiameter: 1.2,
                    boltCount: 8
                },
                expected: { outerRadius: 7, innerRadius: 4, thickness: 1.2, boltCircleRadius: 5.5, boltHoleDiameter: 1.2, boltCount: 8 }
            },
            {
                id: 'stepped-shaft',
                overrides: { shaftDiameter: 5, stepDiameter: 3, totalLength: 16, stepLength: 5 },
                expected: { shaftRadius: 2.5, stepRadius: 1.5, totalLength: 16, stepLength: 5 }
            },
            {
                id: 'pipe-with-bore',
                overrides: { outerDiameter: 8, boreDiameter: 6, length: 12 },
                expected: { outerRadius: 4, boreRadius: 3, length: 12 }
            },
            {
                id: 'bolt-circle-plate',
                overrides: { diameter: 12, thickness: 1, holeDiameter: 1.2, holeCount: 6, holeCircleDiameter: 8 },
                expected: { radius: 6, thickness: 1, holeDiameter: 1.2, holeCount: 6, holeCircleRadius: 4 }
            }
        ];

        for (const testCase of cases) {
            const result = expectSuccess(resolveComponentTemplateParameters(templateById(testCase.id), testCase.overrides));
            for (const [name, value] of Object.entries(testCase.expected)) {
                const actual = result.values[name] ?? result.templateValues[name];
                expect(actual, `${testCase.id}:${name}`).toBeCloseTo(value);
            }
            for (const parameter of result.resolved) {
                if (!Object.prototype.hasOwnProperty.call(testCase.overrides, parameter.name)) {
                    continue;
                }
                expect(parameter.derived, `${testCase.id}:${parameter.name}`).toBe(false);
            }
        }

        const flange = expectSuccess(resolveComponentTemplateParameters(templateById('flange'), { outerDiameter: 14 }));
        expect(resolvedParameter(flange, 'outerRadius').value).toBeCloseTo(7);
        expect(resolvedParameter(flange, 'outerRadius').derived).toBe(true);
        expect(resolvedParameter(flange, 'outerDiameter').derived).toBe(false);

        const radiusForm = expectSuccess(resolveComponentTemplateParameters(templateById('flange'), { outerRadius: 7 }));
        expect(resolvedParameter(radiusForm, 'outerRadius').derived).toBe(false);
        expect(resolvedParameter(radiusForm, 'outerDiameter').value).toBeCloseTo(14);
        expect(resolvedParameter(radiusForm, 'outerDiameter').derived).toBe(true);
    });

    it('converts mechanical length inputs from millimetres', () => {
        const bracket = expectSuccess(
            resolveComponentTemplateParameters(
                templateById('l-bracket'),
                { legLength: 100, legWidth: 30, thickness: 6, holeDiameter: 10 },
                'mm'
            )
        );
        expect(bracket.values).toEqual({ legLength: 10, legWidth: 3, thickness: 0.6, holeDiameter: 1 });
        expect(bracket.templateValues.holeCount).toBe(2);

        const flange = expectSuccess(
            resolveComponentTemplateParameters(templateById('flange'), { outerDiameter: 140, boltCircleDiameter: 110 }, 'mm')
        );
        expect(flange.values.outerRadius).toBeCloseTo(7);
        expect(flange.values.boltCircleRadius).toBeCloseTo(5.5);

        const plate = expectSuccess(resolveComponentTemplateParameters(templateById('bolt-circle-plate'), { diameter: 120 }, 'mm'));
        expect(plate.values.radius).toBeCloseTo(6);
    });

    it('keeps radius/diameter aliases consistent and rejects disagreements', () => {
        const pairs: ReadonlyArray<{ id: string; radius: string; diameter: string; value: number }> = [
            { id: 'flange', radius: 'outerRadius', diameter: 'outerDiameter', value: 6 },
            { id: 'stepped-shaft', radius: 'shaftRadius', diameter: 'shaftDiameter', value: 2 },
            { id: 'pipe-with-bore', radius: 'outerRadius', diameter: 'outerDiameter', value: 3 },
            { id: 'bolt-circle-plate', radius: 'radius', diameter: 'diameter', value: 5 }
        ];
        for (const pair of pairs) {
            const template = templateById(pair.id);
            const both = expectSuccess(
                resolveComponentTemplateParameters(template, { [pair.radius]: pair.value, [pair.diameter]: pair.value * 2 })
            );
            expect(both.values[pair.radius], pair.id).toBeCloseTo(pair.value);
            expect(resolvedParameter(both, pair.radius).derived, pair.id).toBe(false);
            expect(resolvedParameter(both, pair.diameter).derived, pair.id).toBe(false);

            expect(
                expectFailure(
                    resolveComponentTemplateParameters(template, { [pair.radius]: pair.value, [pair.diameter]: pair.value * 2 + 1 })
                ),
                pair.id
            ).toContain('disagree');
        }
    });

    it('rejects out-of-range, unknown, and non-integer overrides', () => {
        const bracket = templateById('l-bracket');
        expect(expectFailure(resolveComponentTemplateParameters(bracket, { legLength: 0 }))).toContain('legLength');
        expect(expectFailure(resolveComponentTemplateParameters(bracket, { legLength: 500 }))).toContain('legLength');
        expect(expectFailure(resolveComponentTemplateParameters(bracket, { holeDiameter: 0.01 }))).toContain('holeDiameter');
        expect(expectFailure(resolveComponentTemplateParameters(bracket, { nope: 1 }))).toContain("'nope'");

        const flange = templateById('flange');
        expect(expectFailure(resolveComponentTemplateParameters(flange, { outerDiameter: 0.5 }))).toContain('outerDiameter');
        expect(expectFailure(resolveComponentTemplateParameters(flange, { boltHoleDiameter: 0.1 }))).toContain('boltHoleDiameter');
        expect(expectFailure(resolveComponentTemplateParameters(flange, { boltCount: 0 }))).toContain('positive integer');
        expect(expectFailure(resolveComponentTemplateParameters(flange, { boltCount: 2.5 }))).toContain('positive integer');

        const shaft = templateById('stepped-shaft');
        expect(expectFailure(resolveComponentTemplateParameters(shaft, { totalLength: 0 }))).toContain('totalLength');
        expect(expectFailure(resolveComponentTemplateParameters(shaft, { shaftDiameter: 500 }))).toContain('shaftDiameter');

        const plate = templateById('bolt-circle-plate');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { holeCircleRadius: 0.1 }))).toContain('holeCircleRadius');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { thickness: 0 }))).toContain('thickness');
        expect(expectFailure(resolveComponentTemplateParameters(plate, { holeCount: -1 }))).toContain('positive integer');
    });

    it('declares count parameters as positive-integer counts', () => {
        const countNames: Readonly<Record<string, string>> = {
            'l-bracket': 'holeCount',
            flange: 'boltCount',
            'bolt-circle-plate': 'holeCount'
        };
        for (const [id, name] of Object.entries(countNames)) {
            const parameter = templateById(id).parameters.find((candidate) => candidate.name === name);
            expect(parameter, `${id}:${name}`).toBeDefined();
            expect(parameter!.kind, `${id}:${name}`).toBe('count');
            expect(parameter!.unit, `${id}:${name}`).toBe('1');
            expect(Number.isInteger(parameter!.default), `${id}:${name}`).toBe(true);
            expect(parameter!.min, `${id}:${name}`).toBeGreaterThanOrEqual(1);
            expect(Number.isInteger(parameter!.min), `${id}:${name}`).toBe(true);
            expect(Number.isInteger(parameter!.max), `${id}:${name}`).toBe(true);
        }
    });

    it('references every document parameter from at least one sketch', () => {
        for (const id of MECHANICAL_IDS) {
            const template = templateById(id);
            for (const name of Object.keys(template.document.parameters)) {
                expect(componentParameterSketchIds(template.document, name).length, `${id}:${name}`).toBeGreaterThan(0);
            }
            for (const parameter of template.parameters) {
                if (parameter.derived === undefined) {
                    continue;
                }
                expect(componentParameterSketchIds(template.document, parameter.name), `${id}:${parameter.name}`).toEqual([]);
            }
        }
    });

    it('applies creation-time count parameters through the configure hook', () => {
        function instantiate(id: string, overrides: Record<string, number>) {
            const template = templateById(id);
            const resolved = expectSuccess(resolveComponentTemplateParameters(template, overrides));
            const document = instantiateComponentTemplate(template, id, { ...resolved.values, ...resolved.templateValues });
            expect(validateNukeCadDocument(document).valid, id).toBe(true);
            return document;
        }

        const bracket = instantiate('l-bracket', { holeCount: 3 });
        const bracketSketch = bracket.sketches.find((sketch) => sketch.id === 'l-bracket-profile')!;
        expect(bracketSketch.primitives.filter((primitive) => String(primitive.id).startsWith('point-hole-'))).toHaveLength(3);
        expect(bracket.parameters.holeCount).toBeUndefined();

        const flange = instantiate('flange', { boltCount: 8 });
        const flangePattern = flange.features.find((feature) => feature.id === 'flange-bolt-pattern')!;
        expect((flangePattern.params as { count?: number }).count).toBe(8);
        expect(flange.parameters.boltCount).toBeUndefined();

        const plate = instantiate('bolt-circle-plate', { holeCount: 6 });
        const platePattern = plate.features.find((feature) => feature.id === 'bolt-circle-plate-pattern')!;
        expect((platePattern.params as { count?: number }).count).toBe(6);
        expect(plate.parameters.holeCount).toBeUndefined();
    });

    it('keeps count parameters out of the editable document parameters', () => {
        for (const id of MECHANICAL_IDS) {
            const template = templateById(id);
            const countNames = template.parameters
                .filter((parameter) => parameter.binding === 'template')
                .map((parameter) => parameter.name);
            for (const name of countNames) {
                expect(template.document.parameters[name], `${id}:${name}`).toBeUndefined();
                expect(componentParameterSketchIds(template.document, name), `${id}:${name}`).toEqual([]);
            }
        }
    });
});
