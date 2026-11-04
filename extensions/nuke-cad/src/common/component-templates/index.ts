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

/**
 * Parametric component template registry.
 *
 * A component template is a complete, validated `.nuke-cad` document plus a
 * typed parameter contract. Resolving a template maps caller-supplied values
 * (optionally expressed in a length unit different from the parameter's own)
 * into document units without touching the template body. Creating a document
 * deep-clones the body; sketch solving happens in the caller's creation flow.
 *
 * Templates are distinct from `DOCUMENT_TEMPLATES` (parameter-only presets over
 * an empty document) and `SAMPLE_PROJECTS` (non-parametric demonstrations).
 *
 * Public exports are unchanged from the former single-file registry; family
 * modules own the shipped entries and this module owns aggregation, ranking,
 * resolution, and validation.
 *
 * @module nuke-cad/common
 */

import {
    validateBodyMaterialTag,
    validateNukeCadDocument,
    type CurveDef,
    type DocumentUnits,
    type NukeCadDocument,
    type SketchDef
} from '../cad-document';
import { parseExpression, type Expr } from '../expression';
import { MECHANICAL_COMPONENT_TEMPLATES } from './mechanical';
import { NUCLEAR_COMPONENT_TEMPLATES } from './nuclear';
import { PINCELL_COMPONENT_TEMPLATE } from './pincell';
import { PRIMITIVE_COMPONENT_TEMPLATES } from './primitives';
import type {
    ComponentParameterKind,
    ComponentTemplate,
    ComponentTemplateCategory,
    ComponentTemplateParameter,
    ComponentTemplateResolveResult,
    ComponentTemplateUnit,
    ResolvedComponentParameter
} from './types';

export type {
    ComponentParameterKind,
    ComponentTemplate,
    ComponentTemplateCategory,
    ComponentTemplateParameter,
    ComponentTemplateResolveResult,
    ComponentTemplateUnit,
    ResolvedComponentParameter
} from './types';

/** Maximum number of typed parameters a template may expose. */
const MAX_COMPONENT_TEMPLATE_PARAMETERS = 12;

/** Stable template id shape (lowercase kebab-case). */
const COMPONENT_TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Relative tolerance for a radius/diameter pair supplied at the same time. */
const PAIR_RELATIVE_TOLERANCE = 1e-9;

const COMPONENT_TEMPLATE_CATEGORIES: readonly ComponentTemplateCategory[] = ['primitives', 'mechanical', 'nuclear', 'assembly'];

const COMPONENT_PARAMETER_KINDS: readonly ComponentParameterKind[] = ['length', 'angle', 'ratio', 'count'];

const COMPONENT_TEMPLATE_UNITS: readonly ComponentTemplateUnit[] = ['mm', 'cm', 'm', 'deg', '1'];

/** Constraint fields that carry a scalar value which may be a parameter name. */
const CONSTRAINT_PARAMETER_KEYS: readonly string[] = ['distance', 'radius', 'diameter', 'angle', 'difference'];

/** Identifier names that are never document-parameter references in curve expressions. */
const CURVE_EXPRESSION_RESERVED: ReadonlySet<string> = new Set(['t', 'pi', 'e']);

const LENGTH_TO_METRES: Record<'mm' | 'cm' | 'm', number> = { mm: 0.001, cm: 0.01, m: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDocumentUnit(value: unknown): value is DocumentUnits {
    return value === 'mm' || value === 'cm' || value === 'm';
}

function isLengthUnit(value: unknown): value is 'mm' | 'cm' | 'm' {
    return value === 'mm' || value === 'cm' || value === 'm';
}

function isParameterKind(value: unknown): value is ComponentParameterKind {
    return COMPONENT_PARAMETER_KINDS.includes(value as ComponentParameterKind);
}

function isTemplateUnit(value: unknown): value is ComponentTemplateUnit {
    return COMPONENT_TEMPLATE_UNITS.includes(value as ComponentTemplateUnit);
}

function kindUnitCompatible(kind: ComponentParameterKind, unit: ComponentTemplateUnit): boolean {
    if (kind === 'length') {
        return isLengthUnit(unit);
    }
    if (kind === 'angle') {
        return unit === 'deg';
    }
    return unit === '1';
}

/** Convert a value from one declared length unit into another; non-length units pass through. */
function convertLength(value: number, from: ComponentTemplateUnit, to: ComponentTemplateUnit): number {
    if (!isLengthUnit(from) || !isLengthUnit(to)) {
        return value;
    }
    return (value * LENGTH_TO_METRES[from]) / LENGTH_TO_METRES[to];
}

function toDocumentUnits(value: number, parameter: ComponentTemplateParameter, documentUnits: DocumentUnits): number {
    if (parameter.kind !== 'length') {
        return value;
    }
    return convertLength(value, parameter.unit, documentUnits);
}

function fromDocumentUnits(value: number, parameter: ComponentTemplateParameter, documentUnits: DocumentUnits): number {
    if (parameter.kind !== 'length') {
        return value;
    }
    return convertLength(value, documentUnits, parameter.unit);
}

function fromInputUnit(value: number, parameter: ComponentTemplateParameter, inputUnit: string | undefined): number {
    if (parameter.kind !== 'length' || inputUnit === undefined || !isLengthUnit(inputUnit)) {
        return value;
    }
    return convertLength(value, inputUnit, parameter.unit);
}

/** Map an alias value in its declared unit into its target parameter's declared unit. */
function derivedValueInTargetUnits(parameter: ComponentTemplateParameter, value: number, target: ComponentTemplateParameter): number {
    if (parameter.derived === undefined) {
        return value;
    }
    const converted = parameter.kind === 'length' && target.kind === 'length' ? convertLength(value, parameter.unit, target.unit) : value;
    return converted * parameter.derived.factor;
}

/** Recover an alias value from its target's stored value (document units). */
function derivedValueFromStorage(
    parameter: ComponentTemplateParameter,
    storage: number,
    target: ComponentTemplateParameter,
    documentUnits: DocumentUnits
): number {
    if (parameter.derived === undefined || parameter.derived.factor === 0) {
        return storage;
    }
    const targetValue = fromDocumentUnits(storage, target, documentUnits) / parameter.derived.factor;
    return parameter.kind === 'length' && target.kind === 'length' ? convertLength(targetValue, target.unit, parameter.unit) : targetValue;
}

/** The value a derived alias contributes to its target, in document units. */
function derivedStorageInDocumentUnits(
    parameter: ComponentTemplateParameter,
    value: number,
    byName: ReadonlyMap<string, ComponentTemplateParameter>,
    documentUnits: DocumentUnits
): number | undefined {
    if (parameter.derived === undefined) {
        return toDocumentUnits(value, parameter, documentUnits);
    }
    const target = byName.get(parameter.derived.parameter);
    if (target === undefined) {
        return undefined;
    }
    return toDocumentUnits(derivedValueInTargetUnits(parameter, value, target), target, documentUnits);
}

function nearlyEqual(a: number, b: number): boolean {
    const scale = Math.max(Math.abs(a), Math.abs(b));
    if (scale === 0) {
        return true;
    }
    return Math.abs(a - b) / scale <= PAIR_RELATIVE_TOLERANCE;
}

function formatValue(value: number): string {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(8)));
}

function rangeMessage(name: string, parameter: ComponentTemplateParameter, actual: number): string {
    const bound = actual < (parameter.min ?? Number.NEGATIVE_INFINITY) ? parameter.min : parameter.max;
    const side = actual < (parameter.min ?? Number.NEGATIVE_INFINITY) ? 'at least' : 'at most';
    return `Parameter '${name}' must be ${side} ${bound} ${parameter.unit} (got ${formatValue(actual)} ${parameter.unit})`;
}

/** Identifier references in a parametric expression (parse failures yield none). */
function expressionIdentifiers(expression: string): readonly string[] {
    const parsed = parseExpression(expression);
    if (!parsed.ok) {
        return [];
    }
    const names = new Set<string>();
    const visit = (node: Expr): void => {
        switch (node.type) {
            case 'ident':
                if (!CURVE_EXPRESSION_RESERVED.has(node.name)) {
                    names.add(node.name);
                }
                break;
            case 'unary':
                visit(node.operand);
                break;
            case 'binary':
                visit(node.left);
                visit(node.right);
                break;
            case 'call':
                for (const argument of node.args) {
                    visit(argument);
                }
                break;
            default:
                break;
        }
    };
    visit(parsed.ast);
    return [...names];
}

/** True when any string field of `value` (at any depth) equals `expected`. */
function containsStringValue(value: unknown, expected: string): boolean {
    if (typeof value === 'string') {
        return value === expected;
    }
    if (Array.isArray(value)) {
        return value.some((item) => containsStringValue(item, expected));
    }
    if (isRecord(value)) {
        return Object.values(value).some((item) => containsStringValue(item, expected));
    }
    return false;
}

function curveReferencesParameter(curve: CurveDef, parameterName: string): boolean {
    if (curve.source.kind !== 'parametric') {
        return false;
    }
    return [curve.source.x, curve.source.y, curve.source.z].some((expression) => expressionIdentifiers(expression).includes(parameterName));
}

function sketchReferencesParameter(sketch: SketchDef, parameterName: string): boolean {
    for (const dimension of sketch.dimensions ?? []) {
        if (typeof dimension.parameter === 'string' && dimension.parameter === parameterName) {
            return true;
        }
    }
    for (const constraint of sketch.constraints) {
        if (containsStringValue(constraint, parameterName)) {
            return true;
        }
    }
    return false;
}

/**
 * Built-in component templates.
 *
 * Families are implemented in sibling modules: six primitives, five mechanical
 * parts, three nuclear starters, and the nuclear pincell.
 */
export const COMPONENT_TEMPLATES: readonly ComponentTemplate[] = [
    ...PRIMITIVE_COMPONENT_TEMPLATES,
    ...MECHANICAL_COMPONENT_TEMPLATES,
    ...NUCLEAR_COMPONENT_TEMPLATES,
    PINCELL_COMPONENT_TEMPLATE
];

/** Look up a component template by id. */
export function getComponentTemplate(id: string): ComponentTemplate | undefined {
    return COMPONENT_TEMPLATES.find((template) => template.id === id);
}

/**
 * List component templates matching a category and free-text query.
 *
 * The query is a case-insensitive substring over id, name, keywords, and
 * description. Exact id matches rank first, then keyword/id-substring matches,
 * then name matches, then description matches. Results cap at 50.
 */
export function listComponentTemplates(query?: { readonly category?: string; readonly query?: string }): readonly ComponentTemplate[] {
    const category = query?.category;
    const text = (query?.query ?? '').trim().toLowerCase();
    const ranked: Array<{ readonly template: ComponentTemplate; readonly rank: number }> = [];
    for (const template of COMPONENT_TEMPLATES) {
        if (category !== undefined && category.length > 0 && template.category !== category) {
            continue;
        }
        let rank = 0;
        if (text.length > 0) {
            const id = template.id.toLowerCase();
            const name = template.name.toLowerCase();
            const description = template.description.toLowerCase();
            const keywordMatch = template.keywords.some((keyword) => keyword.toLowerCase().includes(text));
            if (id === text) {
                rank = 0;
            } else if (keywordMatch || id.includes(text)) {
                rank = 1;
            } else if (name.includes(text)) {
                rank = 2;
            } else if (description.includes(text)) {
                rank = 3;
            } else {
                continue;
            }
        }
        ranked.push({ template, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.template.name.localeCompare(b.template.name) || a.template.id.localeCompare(b.template.id));
    return ranked.slice(0, 50).map((entry) => entry.template);
}

/**
 * Resolve template parameters for one creation request.
 *
 * Overrides are validated in each parameter's declared unit (length inputs may
 * be supplied in `inputUnit` and are converted first). Derived aliases fold
 * into their document parameter with their factor; a radius/diameter pair may
 * be supplied together only when both describe the same value. Every template
 * parameter is returned, including defaults and pair-derived counterparts.
 */
export function resolveComponentTemplateParameters(
    template: ComponentTemplate,
    overrides: Readonly<Record<string, number>>,
    inputUnit?: string
): ComponentTemplateResolveResult {
    const documentUnits = template.document?.units;
    if (!isDocumentUnit(documentUnits)) {
        return { ok: false, message: `Template '${template.id}' must declare document units ('mm', 'cm' or 'm')` };
    }
    if (inputUnit !== undefined && !isLengthUnit(inputUnit)) {
        return { ok: false, message: `Unknown input unit '${inputUnit}' (expected 'mm', 'cm' or 'm')` };
    }

    const parameters = Array.isArray(template.parameters) ? template.parameters : [];
    const byName = new Map<string, ComponentTemplateParameter>();
    for (const parameter of parameters) {
        if (typeof parameter.name !== 'string' || parameter.name.length === 0) {
            return { ok: false, message: `Template '${template.id}' has an unnamed parameter` };
        }
        if (byName.has(parameter.name)) {
            return { ok: false, message: `Template '${template.id}' declares parameter '${parameter.name}' more than once` };
        }
        if (!isParameterKind(parameter.kind)) {
            return { ok: false, message: `Parameter '${parameter.name}' has unknown kind '${String(parameter.kind)}'` };
        }
        if (!isTemplateUnit(parameter.unit)) {
            return { ok: false, message: `Parameter '${parameter.name}' has unknown unit '${String(parameter.unit)}'` };
        }
        if (!kindUnitCompatible(parameter.kind, parameter.unit)) {
            return {
                ok: false,
                message: `Parameter '${parameter.name}' unit '${parameter.unit}' is incompatible with kind '${parameter.kind}'`
            };
        }
        byName.set(parameter.name, parameter);
    }

    for (const [name, value] of Object.entries(overrides)) {
        if (!byName.has(name)) {
            return { ok: false, message: `Unknown parameter '${name}' for template '${template.id}'` };
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { ok: false, message: `Parameter '${name}' must be a finite number` };
        }
    }

    const documentParameterValues = isRecord(template.document.parameters) ? template.document.parameters : {};
    const documentParameterNames = new Set(Object.keys(documentParameterValues));
    for (const name of documentParameterNames) {
        const canonical = byName.get(name);
        if (canonical === undefined) {
            return { ok: false, message: `Template '${template.id}' does not declare document parameter '${name}'` };
        }
        if (canonical.derived !== undefined) {
            return { ok: false, message: `Parameter '${name}' cannot be both a document parameter and a derived alias` };
        }
        if (canonical.binding === 'template') {
            return { ok: false, message: `Parameter '${name}' cannot be both a document parameter and template-bound` };
        }
        if (typeof canonical.default !== 'number' || !Number.isFinite(canonical.default)) {
            return { ok: false, message: `Parameter '${name}' must declare a finite default` };
        }
    }
    for (const parameter of parameters) {
        if (documentParameterNames.has(parameter.name)) {
            continue;
        }
        if (parameter.binding === 'template') {
            if (parameter.derived !== undefined) {
                return { ok: false, message: `Parameter '${parameter.name}' cannot be both template-bound and derived` };
            }
            continue;
        }
        if (parameter.derived === undefined) {
            return { ok: false, message: `Parameter '${parameter.name}' is not a document parameter` };
        }
        if (!documentParameterNames.has(parameter.derived.parameter)) {
            return {
                ok: false,
                message: `Parameter '${parameter.name}' derives from unknown document parameter '${parameter.derived.parameter}'`
            };
        }
        if (typeof parameter.derived.factor !== 'number' || !Number.isFinite(parameter.derived.factor) || parameter.derived.factor === 0) {
            return { ok: false, message: `Parameter '${parameter.name}' has an invalid derivation factor` };
        }
    }

    const direct = new Map<string, number>();
    for (const [name, value] of Object.entries(overrides)) {
        const parameter = byName.get(name)!;
        if (parameter.kind === 'count' && (!Number.isInteger(value) || value <= 0)) {
            return { ok: false, message: `Parameter '${name}' must be a positive integer` };
        }
        const declared = fromInputUnit(value, parameter, inputUnit);
        if (parameter.min !== undefined && declared < parameter.min) {
            return { ok: false, message: rangeMessage(name, parameter, declared) };
        }
        if (parameter.max !== undefined && declared > parameter.max) {
            return { ok: false, message: rangeMessage(name, parameter, declared) };
        }
        if (parameter.derived !== undefined) {
            const target = byName.get(parameter.derived.parameter);
            if (target !== undefined) {
                const stored = derivedValueInTargetUnits(parameter, declared, target);
                if (target.min !== undefined && stored < target.min) {
                    return {
                        ok: false,
                        message: `Parameter '${name}' resolves outside the range of '${target.name}' (minimum ${target.min} ${target.unit})`
                    };
                }
                if (target.max !== undefined && stored > target.max) {
                    return {
                        ok: false,
                        message: `Parameter '${name}' resolves outside the range of '${target.name}' (maximum ${target.max} ${target.unit})`
                    };
                }
            }
        }
        direct.set(name, declared);
    }

    const checkedPairs = new Set<string>();
    for (const parameter of parameters) {
        if (parameter.pair === undefined) {
            continue;
        }
        const counterpart = byName.get(parameter.pair);
        if (counterpart === undefined || counterpart.name === parameter.name) {
            continue;
        }
        const pairKey =
            parameter.name < counterpart.name ? `${parameter.name}|${counterpart.name}` : `${counterpart.name}|${parameter.name}`;
        if (checkedPairs.has(pairKey)) {
            continue;
        }
        checkedPairs.add(pairKey);
        const left = direct.get(parameter.name);
        const right = direct.get(counterpart.name);
        if (left === undefined || right === undefined) {
            continue;
        }
        const related = parameter.derived?.parameter === counterpart.name || counterpart.derived?.parameter === parameter.name;
        const leftValue = related
            ? derivedStorageInDocumentUnits(parameter, left, byName, documentUnits)
            : toDocumentUnits(left, parameter, documentUnits);
        const rightValue = related
            ? derivedStorageInDocumentUnits(counterpart, right, byName, documentUnits)
            : toDocumentUnits(right, counterpart, documentUnits);
        if (leftValue === undefined || rightValue === undefined || nearlyEqual(leftValue, rightValue)) {
            continue;
        }
        return {
            ok: false,
            message: `Parameters '${parameter.name}' and '${counterpart.name}' disagree (${formatValue(leftValue)} vs ${formatValue(
                rightValue
            )} ${documentUnits})`
        };
    }

    const values: Record<string, number> = {};
    for (const name of documentParameterNames) {
        const canonical = byName.get(name)!;
        const directValue = direct.get(name);
        const canonicalValue = directValue === undefined ? undefined : toDocumentUnits(directValue, canonical, documentUnits);
        let derivedValue: number | undefined;
        for (const parameter of parameters) {
            if (parameter.derived?.parameter !== name) {
                continue;
            }
            const aliasValue = direct.get(parameter.name);
            if (aliasValue === undefined) {
                continue;
            }
            const candidate = toDocumentUnits(derivedValueInTargetUnits(parameter, aliasValue, canonical), canonical, documentUnits);
            if (derivedValue !== undefined && !nearlyEqual(derivedValue, candidate)) {
                return { ok: false, message: `Derived parameters for '${name}' disagree` };
            }
            derivedValue = candidate;
        }
        if (canonicalValue !== undefined && derivedValue !== undefined && !nearlyEqual(canonicalValue, derivedValue)) {
            return { ok: false, message: `Derived parameters for '${name}' disagree` };
        }
        values[name] = canonicalValue ?? derivedValue ?? toDocumentUnits(canonical.default, canonical, documentUnits);
    }

    const templateValues: Record<string, number> = {};
    for (const parameter of parameters) {
        if (documentParameterNames.has(parameter.name) || parameter.binding !== 'template') {
            continue;
        }
        const directValue = direct.get(parameter.name);
        templateValues[parameter.name] = toDocumentUnits(directValue ?? parameter.default, parameter, documentUnits);
    }

    const templateError = template.validate?.({ ...values, ...templateValues });
    if (templateError !== undefined) {
        return { ok: false, message: templateError };
    }

    const resolved: ResolvedComponentParameter[] = [];
    for (const parameter of parameters) {
        const directValue = direct.get(parameter.name);
        let inputValue: number;
        if (directValue !== undefined) {
            inputValue = directValue;
        } else if (parameter.derived !== undefined) {
            const target = byName.get(parameter.derived.parameter);
            const stored = target !== undefined ? values[target.name] : undefined;
            if (target === undefined || stored === undefined) {
                return { ok: false, message: `Parameter '${parameter.name}' cannot resolve its derived value` };
            }
            inputValue = derivedValueFromStorage(parameter, stored, target, documentUnits);
        } else {
            const stored = values[parameter.name] ?? templateValues[parameter.name];
            if (stored === undefined) {
                return { ok: false, message: `Parameter '${parameter.name}' is not a document parameter` };
            }
            inputValue = fromDocumentUnits(stored, parameter, documentUnits);
        }
        resolved.push({
            name: parameter.name,
            label: parameter.label,
            kind: parameter.kind,
            unit: parameter.unit,
            value: toDocumentUnits(inputValue, parameter, documentUnits),
            inputValue,
            defaultValue: toDocumentUnits(parameter.default, parameter, documentUnits),
            derived: directValue === undefined,
            min: parameter.min === undefined ? undefined : toDocumentUnits(parameter.min, parameter, documentUnits),
            max: parameter.max === undefined ? undefined : toDocumentUnits(parameter.max, parameter, documentUnits)
        });
    }
    return { ok: true, values, templateValues, resolved };
}

/**
 * Clone a template body into a new, independent document with the supplied name.
 *
 * Parameters and sketches stay exactly as shipped; the caller validates and
 * solves them as part of its creation flow.
 */
export function instantiateComponentTemplate(
    template: ComponentTemplate,
    name: string,
    values?: Readonly<Record<string, number>>
): NukeCadDocument {
    const clone = JSON.parse(JSON.stringify(template.document)) as NukeCadDocument;
    clone.name = name;
    return values === undefined ? clone : (template.configure?.(clone, values) ?? clone);
}

/**
 * Validate one template contract.
 *
 * Returns human-readable error strings covering the document schema, parameter
 * declarations and cross-references, units, derivations, body labels, and
 * material tags. An empty result means the template is sound.
 */
export function validateComponentTemplate(template: ComponentTemplate): readonly string[] {
    const errors: string[] = [];
    const id = typeof template.id === 'string' ? template.id : '';
    const prefix = `Template '${id}'`;

    if (!COMPONENT_TEMPLATE_ID_PATTERN.test(id)) {
        errors.push(`${prefix}: id must match ${COMPONENT_TEMPLATE_ID_PATTERN}`);
    }
    if (typeof template.name !== 'string' || template.name.trim().length === 0) {
        errors.push(`${prefix}: name must be a non-empty string`);
    }
    if (typeof template.description !== 'string' || template.description.trim().length === 0) {
        errors.push(`${prefix}: description must be a non-empty string`);
    }
    if (!COMPONENT_TEMPLATE_CATEGORIES.includes(template.category)) {
        errors.push(`${prefix}: category must be one of ${COMPONENT_TEMPLATE_CATEGORIES.join(', ')}`);
    }
    const keywords = Array.isArray(template.keywords) ? template.keywords : [];
    if (!keywords.some((keyword) => typeof keyword === 'string' && keyword.trim().length > 0)) {
        errors.push(`${prefix}: at least one keyword is required`);
    }

    const parameters = Array.isArray(template.parameters) ? template.parameters : [];
    if (parameters.length < 1 || parameters.length > MAX_COMPONENT_TEMPLATE_PARAMETERS) {
        errors.push(`${prefix}: must declare between 1 and ${MAX_COMPONENT_TEMPLATE_PARAMETERS} parameters`);
    }
    const parameterNames = new Set<string>();
    for (const parameter of parameters) {
        const name = typeof parameter.name === 'string' ? parameter.name : '';
        const parameterLabel = name.length > 0 ? `parameter '${name}'` : 'parameter';
        if (name.length === 0) {
            errors.push(`${prefix}: parameter name must be a non-empty string`);
        } else if (parameterNames.has(name)) {
            errors.push(`${prefix}: duplicate parameter '${name}'`);
        } else {
            parameterNames.add(name);
        }
        if (typeof parameter.label !== 'string' || parameter.label.trim().length === 0) {
            errors.push(`${prefix}: ${parameterLabel} label must be a non-empty string`);
        }
        if (!isParameterKind(parameter.kind)) {
            errors.push(`${prefix}: ${parameterLabel} kind '${String(parameter.kind)}' is unknown`);
        } else if (!isTemplateUnit(parameter.unit)) {
            errors.push(`${prefix}: ${parameterLabel} unit '${String(parameter.unit)}' is unknown`);
        } else if (!kindUnitCompatible(parameter.kind, parameter.unit)) {
            errors.push(`${prefix}: ${parameterLabel} unit '${parameter.unit}' is incompatible with kind '${parameter.kind}'`);
        }
        const defaultFinite = typeof parameter.default === 'number' && Number.isFinite(parameter.default);
        if (!defaultFinite) {
            errors.push(`${prefix}: ${parameterLabel} default must be a finite number`);
        }
        const minFinite = parameter.min === undefined || (typeof parameter.min === 'number' && Number.isFinite(parameter.min));
        const maxFinite = parameter.max === undefined || (typeof parameter.max === 'number' && Number.isFinite(parameter.max));
        if (!minFinite) {
            errors.push(`${prefix}: ${parameterLabel} minimum must be a finite number`);
        }
        if (!maxFinite) {
            errors.push(`${prefix}: ${parameterLabel} maximum must be a finite number`);
        }
        if (parameter.min !== undefined && parameter.max !== undefined && minFinite && maxFinite && parameter.min > parameter.max) {
            errors.push(`${prefix}: ${parameterLabel} minimum exceeds its maximum`);
        }
        if (defaultFinite && minFinite && parameter.min !== undefined && parameter.default < parameter.min) {
            errors.push(`${prefix}: ${parameterLabel} default is below its minimum`);
        }
        if (defaultFinite && maxFinite && parameter.max !== undefined && parameter.default > parameter.max) {
            errors.push(`${prefix}: ${parameterLabel} default is above its maximum`);
        }
        if (
            parameter.step !== undefined &&
            (typeof parameter.step !== 'number' || !Number.isFinite(parameter.step) || parameter.step <= 0)
        ) {
            errors.push(`${prefix}: ${parameterLabel} step must be a positive finite number`);
        }
        if (parameter.binding !== undefined && parameter.binding !== 'template') {
            errors.push(`${prefix}: ${parameterLabel} binding must be 'template' when present`);
        }
        if (parameter.derived !== undefined) {
            const factor = parameter.derived.factor;
            if (typeof factor !== 'number' || !Number.isFinite(factor) || factor === 0) {
                errors.push(`${prefix}: ${parameterLabel} derivation factor must be finite and non-zero`);
            }
            const target = parameter.derived.parameter;
            if (typeof target !== 'string' || target.length === 0) {
                errors.push(`${prefix}: ${parameterLabel} derivation target must be a document parameter name`);
            }
        }
    }

    const document = template.document;
    if (!isRecord(document)) {
        errors.push(`${prefix}: document must be an object`);
        return errors;
    }
    const documentUnits = document.units;
    if (!isDocumentUnit(documentUnits)) {
        errors.push(`${prefix}: document must declare units as 'mm', 'cm' or 'm'`);
    }
    const documentParameterValues = isRecord(document.parameters) ? document.parameters : {};
    const documentParameterNames = new Set(Object.keys(documentParameterValues));
    for (const issue of validateNukeCadDocument(document as NukeCadDocument).issues) {
        const location = issue.path.length > 0 ? `document ${issue.path}` : 'document';
        errors.push(`${prefix}: ${location}: ${issue.message}`);
    }
    const features = Array.isArray(document.features) ? document.features : [];
    for (const feature of features) {
        if (isRecord(feature) && feature.type === 'import') {
            errors.push(`${prefix}: import feature '${String(feature.id)}' is not allowed in a template`);
        }
    }

    const declaredNames = new Set<string>();
    for (const parameter of parameters) {
        if (typeof parameter.name === 'string' && parameter.name.length > 0) {
            declaredNames.add(parameter.name);
        }
    }
    for (const parameter of parameters) {
        const name = parameter.name;
        if (typeof name !== 'string' || name.length === 0) {
            continue;
        }
        if (parameter.binding === 'template') {
            if (parameter.derived !== undefined) {
                errors.push(`${prefix}: parameter '${name}' cannot be both template-bound and derived`);
            }
            if (documentParameterNames.has(name)) {
                errors.push(`${prefix}: parameter '${name}' cannot be both a document parameter and template-bound`);
            }
        } else if (parameter.derived !== undefined) {
            if (documentParameterNames.has(name)) {
                errors.push(`${prefix}: parameter '${name}' cannot be both a document parameter and a derived alias`);
            }
            const target = parameter.derived.parameter;
            if (typeof target === 'string' && target.length > 0 && !documentParameterNames.has(target)) {
                errors.push(`${prefix}: parameter '${name}' derives from '${target}', which is not a document parameter`);
            }
        } else if (!documentParameterNames.has(name)) {
            errors.push(`${prefix}: parameter '${name}' must be a document parameter, declare a derived target, or use binding 'template'`);
        }
    }
    for (const name of documentParameterNames) {
        if (!declaredNames.has(name)) {
            errors.push(`${prefix}: document parameter '${name}' is not declared by a template parameter`);
        }
    }

    for (const parameter of parameters) {
        const name = parameter.name;
        if (typeof name !== 'string' || name.length === 0 || parameter.pair === undefined) {
            continue;
        }
        if (typeof parameter.pair !== 'string' || parameter.pair.length === 0 || parameter.pair === name) {
            errors.push(`${prefix}: parameter '${name}' pair must name another parameter`);
            continue;
        }
        const counterpart = parameters.find((candidate) => candidate.name === parameter.pair);
        if (counterpart === undefined) {
            errors.push(`${prefix}: parameter '${name}' pair '${parameter.pair}' is not declared`);
        } else if (counterpart.pair !== undefined && counterpart.pair !== name) {
            errors.push(`${prefix}: parameters '${name}' and '${parameter.pair}' declare different pair counterparts`);
        }
    }

    const bodies = Array.isArray(document.bodies) ? document.bodies : [];
    for (const [index, body] of bodies.entries()) {
        const bodyId = isRecord(body) && typeof body.id === 'string' ? body.id : String(index);
        if (!isRecord(body) || typeof body.label !== 'string' || body.label.trim().length === 0) {
            errors.push(`${prefix}: body '${bodyId}' must have a non-empty label`);
        }
        if (isRecord(body) && body.material !== undefined) {
            if (typeof body.material !== 'string' || body.material.trim().length === 0) {
                errors.push(`${prefix}: body '${bodyId}' material must be a non-empty string`);
            } else {
                const reason = validateBodyMaterialTag(body.material);
                if (reason !== undefined) {
                    errors.push(`${prefix}: body '${bodyId}' material: ${reason}`);
                }
            }
        }
    }

    const checkParameterReference = (name: string, location: string): void => {
        if (!declaredNames.has(name)) {
            errors.push(`${prefix}: ${location} references undeclared parameter '${name}'`);
        } else if (!documentParameterNames.has(name)) {
            errors.push(`${prefix}: ${location} references '${name}', which is not a document parameter`);
        }
    };
    const sketches = Array.isArray(document.sketches) ? document.sketches : [];
    for (const sketch of sketches) {
        if (!isRecord(sketch)) {
            continue;
        }
        const sketchId = typeof sketch.id === 'string' ? sketch.id : '?';
        const dimensions = Array.isArray(sketch.dimensions) ? sketch.dimensions : [];
        for (const dimension of dimensions) {
            if (!isRecord(dimension) || typeof dimension.parameter !== 'string' || dimension.parameter.length === 0) {
                continue;
            }
            const dimensionId = typeof dimension.id === 'string' ? dimension.id : '?';
            checkParameterReference(dimension.parameter, `sketch '${sketchId}' dimension '${dimensionId}'`);
        }
        const constraints = Array.isArray(sketch.constraints) ? sketch.constraints : [];
        for (const constraint of constraints) {
            if (!isRecord(constraint)) {
                continue;
            }
            const constraintId = typeof constraint.id === 'string' ? constraint.id : '?';
            for (const key of CONSTRAINT_PARAMETER_KEYS) {
                const value = constraint[key];
                if (typeof value !== 'string' || value.length === 0) {
                    continue;
                }
                checkParameterReference(value, `sketch '${sketchId}' constraint '${constraintId}' (${key})`);
            }
        }
    }
    const curves = Array.isArray(document.curves) ? document.curves : [];
    for (const curve of curves) {
        if (!isRecord(curve) || !isRecord(curve.source) || curve.source.kind !== 'parametric') {
            continue;
        }
        const curveId = typeof curve.id === 'string' ? curve.id : '?';
        for (const axis of ['x', 'y', 'z'] as const) {
            const expression = curve.source[axis];
            if (typeof expression !== 'string' || expression.length === 0) {
                continue;
            }
            for (const name of expressionIdentifiers(expression)) {
                checkParameterReference(name, `curve '${curveId}' ${axis}(t)`);
            }
        }
    }
    return errors;
}

/** Validate the shipped component-template library, including duplicate ids. */
export function validateComponentTemplateLibrary(): readonly string[] {
    const errors: string[] = [];
    const ids = new Set<string>();
    for (const template of COMPONENT_TEMPLATES) {
        if (ids.has(template.id)) {
            errors.push(`Duplicate component template id '${template.id}'`);
        }
        ids.add(template.id);
        errors.push(...validateComponentTemplate(template));
    }
    return errors;
}

/**
 * Ids of sketches whose dimensions or constraints reference a parameter, plus
 * ids of document curves whose parametric expressions reference it.
 *
 * A constraint references a parameter when any string field (at any depth)
 * equals the parameter name; a curve reference is any identifier in its
 * `x(t)`/`y(t)`/`z(t)` expression other than `t`, `pi`, or `e`.
 */
export function componentParameterSketchIds(document: NukeCadDocument, parameterName: string): readonly string[] {
    if (parameterName.length === 0) {
        return [];
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const sketch of document.sketches ?? []) {
        if (sketchReferencesParameter(sketch, parameterName)) {
            if (!seen.has(sketch.id)) {
                seen.add(sketch.id);
                ids.push(sketch.id);
            }
        }
    }
    for (const curve of document.curves ?? []) {
        if (curveReferencesParameter(curve, parameterName)) {
            if (!seen.has(curve.id)) {
                seen.add(curve.id);
                ids.push(curve.id);
            }
        }
    }
    return ids;
}
