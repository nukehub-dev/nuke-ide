// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
 * OpenMC Material Edit
 *
 * Pure validation, diff, and snapshot helpers for the material additions,
 * updates, and removals that NukeAI may preview and apply. The editable field
 * allow-list deliberately excludes material identity, macroscopic data, and
 * nuke-cad provenance: those need their own workflows and are never rewritten
 * by this safe-edit loop.
 *
 * @module openmc-studio/browser/capabilities
 */

import { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import { OpenMCMaterial, OpenMCNuclide, OpenMCThermalScattering } from '../../common/openmc-state-schema';

/** Maximum number of material actions in one preview request. */
export const MAX_MATERIAL_ACTIONS = 20;

/** Fields a material update or addition may set. */
export const MATERIAL_EDITABLE_FIELDS = [
    'name',
    'density',
    'densityUnit',
    'nuclides',
    'thermalScattering',
    'color',
    'temperature',
    'volume',
    'isDepletable',
    'ncrystalCfg',
    'isotropic'
] as const;

/** A field from {@link MATERIAL_EDITABLE_FIELDS}. */
export type OpenMCMaterialEditableField = (typeof MATERIAL_EDITABLE_FIELDS)[number];

/** Density units accepted by the OpenMC material schema. */
export const MATERIAL_DENSITY_UNITS = ['g/cm3', 'kg/m3', 'atom/b-cm', 'sum', 'macro'] as const;

/** Fields this capability refuses to rewrite. */
export const MATERIAL_PROTECTED_FIELDS = ['id', 'macroscopic', 'nukeCadMaterialId', 'nukeCadParentId'] as const;

/** Replace one existing material's editable fields. */
export interface OpenMCMaterialUpdateAction {
    readonly action: 'update';
    readonly materialId: number;
    readonly updates: Readonly<Record<string, unknown>>;
}

/** Add a material with an editor-assigned id. */
export interface OpenMCMaterialAddAction {
    readonly action: 'add';
    readonly material: Readonly<Record<string, unknown>>;
}

/** Remove an existing material. */
export interface OpenMCMaterialRemoveAction {
    readonly action: 'remove';
    readonly materialId: number;
}

/** One material edit requested by a capability caller. */
export type OpenMCMaterialAction = OpenMCMaterialUpdateAction | OpenMCMaterialAddAction | OpenMCMaterialRemoveAction;

/** Diff and working snapshot produced by a dry-run of the actions. */
export interface OpenMCMaterialPreview {
    readonly changes: NukeChange[];
    readonly after: OpenMCMaterial[];
    readonly addedIds: number[];
}

/** Human labels used by the diff card. */
const FIELD_LABELS: Record<OpenMCMaterialEditableField, string> = {
    name: 'Name',
    density: 'Density',
    densityUnit: 'Density unit',
    nuclides: 'Nuclides',
    thermalScattering: 'Thermal scattering',
    color: 'Color',
    temperature: 'Temperature',
    volume: 'Volume',
    isDepletable: 'Depletable',
    ncrystalCfg: 'NCrystal configuration',
    isotropic: 'Isotropic nuclides'
};

/** True for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for a positive material id. */
function isMaterialId(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** True for a finite number greater than zero. */
function isPositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** True for a string with non-whitespace content. */
function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** True for a supported density unit. */
function isDensityUnit(value: unknown): value is (typeof MATERIAL_DENSITY_UNITS)[number] {
    return typeof value === 'string' && (MATERIAL_DENSITY_UNITS as readonly string[]).includes(value);
}

/** True when a string names an editable material field. */
export function isMaterialEditableField(field: string): field is OpenMCMaterialEditableField {
    return (MATERIAL_EDITABLE_FIELDS as readonly string[]).includes(field);
}

/** Read one editable field from a material. */
export function materialValue(material: OpenMCMaterial, field: OpenMCMaterialEditableField): unknown {
    return material[field];
}

/**
 * Compare material values for stale checks.
 *
 * Undefined object properties and missing properties compare equal so optional
 * unset fields never look changed. Arrays compare by index and objects by key,
 * independent of insertion order.
 */
export function materialEquals(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((value, index) => materialEquals(value, right[index]));
    }
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
    const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }
    return leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && materialEquals(leftRecord[key], rightRecord[key])
    );
}

/** Deep-clone one material. */
function cloneMaterial(material: OpenMCMaterial): OpenMCMaterial {
    return JSON.parse(JSON.stringify(material)) as OpenMCMaterial;
}

/** Deep-clone a materials array so previews never share state with the project. */
export function cloneMaterials(materials: readonly OpenMCMaterial[]): OpenMCMaterial[] {
    return materials.map((material) => cloneMaterial(material));
}

/** Next id used when the caller does not pass the state manager's allocator. */
function nextMaterialIdFor(materials: readonly OpenMCMaterial[]): number {
    const ids = materials.map((material) => material.id);
    return ids.length > 0 ? Math.max(1, ...ids) + 1 : 1;
}

/** Explain why a protected field cannot be requested. */
function protectedFieldMessage(field: string): string | undefined {
    if (field === 'id') {
        return 'The material id is assigned automatically and cannot be set.';
    }
    if (field === 'macroscopic') {
        return 'Macroscopic data cannot be added or changed here.';
    }
    if (field === 'nukeCadMaterialId' || field === 'nukeCadParentId') {
        return `${field} is nuke-cad provenance and cannot be changed here.`;
    }
    return undefined;
}

/** Validate the shape and values of a nuclide list. */
function validateNuclides(value: unknown): string | undefined {
    if (!Array.isArray(value)) {
        return 'Nuclides must be an array of { name, fraction, fractionType } entries.';
    }
    let total = 0;
    for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        if (!isRecord(entry)) {
            return `Nuclide ${index + 1} must be an object.`;
        }
        if (!isNonEmptyString(entry.name)) {
            return `Nuclide ${index + 1} needs a non-empty name.`;
        }
        if (typeof entry.fraction !== 'number' || !Number.isFinite(entry.fraction) || entry.fraction < 0) {
            return `Nuclide ${entry.name.trim()} needs a finite fraction greater than or equal to 0.`;
        }
        if (entry.fractionType !== undefined && entry.fractionType !== 'ao' && entry.fractionType !== 'wo') {
            return `Nuclide ${entry.name.trim()} fraction type must be 'ao' or 'wo'.`;
        }
        total += entry.fraction;
    }
    if (value.length > 0 && total <= 0) {
        return 'Nuclide fractions must total more than 0.';
    }
    return undefined;
}

/** Validate the shape and values of a thermal scattering list. */
function validateThermalScattering(value: unknown): string | undefined {
    if (!Array.isArray(value)) {
        return 'Thermal scattering must be an array of { name, fraction } entries.';
    }
    for (let index = 0; index < value.length; index += 1) {
        const entry = value[index];
        if (!isRecord(entry)) {
            return `Thermal scattering ${index + 1} must be an object.`;
        }
        if (!isNonEmptyString(entry.name)) {
            return `Thermal scattering ${index + 1} needs a non-empty name.`;
        }
        if (typeof entry.fraction !== 'number' || !Number.isFinite(entry.fraction) || entry.fraction <= 0) {
            return `Thermal scattering ${entry.name.trim()} needs a finite fraction greater than 0.`;
        }
    }
    return undefined;
}

/** Validate the isotropic nuclide name list. */
function validateIsotropic(value: unknown): string | undefined {
    if (!Array.isArray(value)) {
        return 'isotropic must be an array of nuclide names.';
    }
    for (const name of value) {
        if (!isNonEmptyString(name)) {
            return 'isotropic entries must be non-empty strings.';
        }
    }
    return undefined;
}

/** Validate one editable field value. */
function validateMaterialField(field: OpenMCMaterialEditableField, value: unknown): string | undefined {
    switch (field) {
        case 'name':
            return isNonEmptyString(value) ? undefined : 'Name must be a non-empty string.';
        case 'density':
            return isPositiveNumber(value) ? undefined : 'Density must be a finite number greater than 0.';
        case 'densityUnit':
            return isDensityUnit(value) ? undefined : `Density unit must be one of ${MATERIAL_DENSITY_UNITS.join(', ')}.`;
        case 'nuclides':
            return validateNuclides(value);
        case 'thermalScattering':
            return validateThermalScattering(value);
        case 'color':
            return isNonEmptyString(value) ? undefined : 'Color must be a non-empty string.';
        case 'temperature':
            return isPositiveNumber(value) ? undefined : 'Temperature must be a finite number greater than 0.';
        case 'volume':
            return isPositiveNumber(value) ? undefined : 'Volume must be a finite number greater than 0.';
        case 'isDepletable':
            return typeof value === 'boolean' ? undefined : 'isDepletable must be a boolean.';
        case 'ncrystalCfg':
            return isNonEmptyString(value) ? undefined : 'NCrystal configuration must be a non-empty string.';
        case 'isotropic':
            return validateIsotropic(value);
    }
    return undefined;
}

/** Normalize a validated field value before it enters the working snapshot. */
function normalizeMaterialField(field: OpenMCMaterialEditableField, value: unknown): unknown {
    switch (field) {
        case 'name':
        case 'color':
        case 'ncrystalCfg':
            return (value as string).trim();
        case 'nuclides':
            return (value as Array<Record<string, unknown>>).map((entry): OpenMCNuclide => ({
                name: (entry.name as string).trim(),
                fraction: entry.fraction as number,
                fractionType: (entry.fractionType ?? 'ao') as OpenMCNuclide['fractionType']
            }));
        case 'thermalScattering':
            return (value as Array<Record<string, unknown>>).map((entry): OpenMCThermalScattering => ({
                name: (entry.name as string).trim(),
                fraction: entry.fraction as number
            }));
        case 'isotropic':
            return (value as string[]).map((name) => name.trim());
        default:
            return value;
    }
}

/** Reject NCrystal configurations that conflict with other scattering data. */
function ncrystalConflicts(material: OpenMCMaterial, updates: Readonly<Record<string, unknown>>): string[] {
    const errors: string[] = [];
    const crystal = 'ncrystalCfg' in updates ? normalizeMaterialField('ncrystalCfg', updates.ncrystalCfg) : material.ncrystalCfg;
    if (typeof crystal !== 'string' || crystal.length === 0) {
        return errors;
    }
    const thermal =
        'thermalScattering' in updates
            ? (normalizeMaterialField('thermalScattering', updates.thermalScattering) as OpenMCThermalScattering[])
            : material.thermalScattering;
    if (thermal.length > 0) {
        errors.push(`Material ${material.id}: NCrystal configuration cannot be combined with thermal scattering data.`);
    }
    if (material.macroscopic) {
        errors.push(`Material ${material.id}: NCrystal configuration cannot be combined with macroscopic data.`);
    }
    return errors;
}

/** Validate one update action against the material it targets. */
function validateMaterialUpdate(
    materials: readonly OpenMCMaterial[],
    material: OpenMCMaterial,
    updates: Readonly<Record<string, unknown>>
): string[] {
    const fields = Object.keys(updates);
    if (fields.length === 0) {
        return [`Update for material ${material.id} needs at least one editable field.`];
    }

    const errors: string[] = [];
    let valuesValid = true;
    for (const field of fields) {
        if (!isMaterialEditableField(field)) {
            errors.push(protectedFieldMessage(field) ?? `${field} is not an editable material field.`);
            valuesValid = false;
            continue;
        }
        const error = validateMaterialField(field, updates[field]);
        if (error) {
            errors.push(`Material ${material.id}: ${error}`);
            valuesValid = false;
        }
    }
    if (!valuesValid) {
        return errors;
    }

    if ('name' in updates) {
        const name = normalizeMaterialField('name', updates.name) as string;
        const other = materials.find((candidate) => candidate.id !== material.id && candidate.name === name);
        if (other) {
            errors.push(`Material name "${name}" is already used by material ${other.id}.`);
        }
    }
    if ('densityUnit' in updates) {
        const unit = updates.densityUnit as OpenMCMaterial['densityUnit'];
        if (material.macroscopic && unit !== 'macro') {
            errors.push(`Material ${material.id}: macroscopic materials must use the 'macro' density unit.`);
        }
        if (!material.macroscopic && unit === 'macro') {
            errors.push(`Material ${material.id}: the 'macro' density unit requires macroscopic data.`);
        }
    }
    errors.push(...ncrystalConflicts(material, updates));
    return errors;
}

/** Validate one add action against the current materials. */
function validateMaterialAddition(materials: readonly OpenMCMaterial[], input: Readonly<Record<string, unknown>>): string[] {
    const errors: string[] = [];
    for (const field of Object.keys(input)) {
        if (!isMaterialEditableField(field)) {
            errors.push(protectedFieldMessage(field) ?? `${field} is not an editable material field.`);
        }
    }
    let valuesValid = true;
    for (const required of ['name', 'density', 'densityUnit'] as const) {
        if (!(required in input)) {
            errors.push(`A new material needs ${required}.`);
            valuesValid = false;
        }
    }
    for (const field of MATERIAL_EDITABLE_FIELDS) {
        if (!(field in input)) {
            continue;
        }
        const error = validateMaterialField(field, input[field]);
        if (error) {
            errors.push(`New material: ${error}`);
            valuesValid = false;
        }
    }
    if (!valuesValid) {
        return errors;
    }

    if (input.densityUnit === 'macro') {
        errors.push(
            "A new material cannot use the 'macro' density unit; macroscopic data is added through the macroscopic material editor."
        );
    }
    const name = normalizeMaterialField('name', input.name) as string;
    const existing = materials.find((candidate) => candidate.name === name);
    if (existing) {
        errors.push(`Material name "${name}" is already used by material ${existing.id}.`);
    }
    const crystal = normalizeMaterialField('ncrystalCfg', input.ncrystalCfg ?? '') as string;
    const thermal =
        'thermalScattering' in input
            ? (normalizeMaterialField('thermalScattering', input.thermalScattering) as OpenMCThermalScattering[])
            : [];
    if (crystal.length > 0 && thermal.length > 0) {
        errors.push('NCrystal configuration cannot be combined with thermal scattering data.');
    }
    return errors;
}

/** Fields accepted by each action kind. */
const ACTION_KEYS: Record<OpenMCMaterialAction['action'], readonly string[]> = {
    update: ['action', 'materialId', 'updates'],
    add: ['action', 'material'],
    remove: ['action', 'materialId']
};

/**
 * Validate a material action set against the current materials.
 *
 * @param materials - Current materials; never mutated.
 * @param actions - Requested additions, updates, and removals.
 * @returns Human-readable problems; an empty array means the set is valid.
 */
export function validateMaterialActions(materials: readonly OpenMCMaterial[], actions: readonly OpenMCMaterialAction[]): string[] {
    if (actions.length < 1 || actions.length > MAX_MATERIAL_ACTIONS) {
        return [`Provide between 1 and ${MAX_MATERIAL_ACTIONS} material actions.`];
    }

    const errors: string[] = [];
    const changedIds = new Set<number>();
    const addedNames = new Set<string>();
    for (const entry of actions) {
        const action = entry as unknown as Record<string, unknown>;
        switch (action.action) {
            case 'update': {
                const extraKeys = Object.keys(action).filter((key) => !ACTION_KEYS.update.includes(key));
                if (extraKeys.length > 0) {
                    errors.push(`Update actions do not accept ${extraKeys.join(', ')}.`);
                    break;
                }
                const materialId = action.materialId;
                if (!isMaterialId(materialId)) {
                    errors.push('Each update action needs a positive integer materialId.');
                    break;
                }
                if (changedIds.has(materialId)) {
                    errors.push(`Material ${materialId} can only be changed once per preview.`);
                    break;
                }
                changedIds.add(materialId);
                const material = materials.find((candidate) => candidate.id === materialId);
                if (!material) {
                    errors.push(`Material ${materialId} does not exist.`);
                    break;
                }
                const updates = action.updates;
                if (!isRecord(updates)) {
                    errors.push(`Update for material ${materialId} needs an updates object.`);
                    break;
                }
                errors.push(...validateMaterialUpdate(materials, material, updates));
                break;
            }
            case 'add': {
                const extraKeys = Object.keys(action).filter((key) => !ACTION_KEYS.add.includes(key));
                if (extraKeys.length > 0) {
                    errors.push(`Add actions do not accept ${extraKeys.join(', ')}.`);
                    break;
                }
                const material = action.material;
                if (!isRecord(material)) {
                    errors.push('Each add action needs a material object.');
                    break;
                }
                if (isNonEmptyString(material.name)) {
                    const name = material.name.trim();
                    if (addedNames.has(name)) {
                        errors.push(`Material name "${name}" is added more than once.`);
                    }
                    addedNames.add(name);
                }
                errors.push(...validateMaterialAddition(materials, material));
                break;
            }
            case 'remove': {
                const extraKeys = Object.keys(action).filter((key) => !ACTION_KEYS.remove.includes(key));
                if (extraKeys.length > 0) {
                    errors.push(`Remove actions do not accept ${extraKeys.join(', ')}.`);
                    break;
                }
                const materialId = action.materialId;
                if (!isMaterialId(materialId)) {
                    errors.push('Each remove action needs a positive integer materialId.');
                    break;
                }
                if (changedIds.has(materialId)) {
                    errors.push(`Material ${materialId} can only be changed once per preview.`);
                    break;
                }
                changedIds.add(materialId);
                if (!materials.some((candidate) => candidate.id === materialId)) {
                    errors.push(`Material ${materialId} does not exist.`);
                }
                break;
            }
            default:
                errors.push('Each material action must be update, add, or remove.');
        }
    }
    return errors;
}

/** Build a complete material from a validated add payload. */
function buildAddedMaterial(input: Readonly<Record<string, unknown>>, id: number): OpenMCMaterial {
    const material: OpenMCMaterial = {
        id,
        name: normalizeMaterialField('name', input.name) as string,
        density: input.density as number,
        densityUnit: input.densityUnit as OpenMCMaterial['densityUnit'],
        nuclides: 'nuclides' in input ? (normalizeMaterialField('nuclides', input.nuclides) as OpenMCNuclide[]) : [],
        thermalScattering:
            'thermalScattering' in input
                ? (normalizeMaterialField('thermalScattering', input.thermalScattering) as OpenMCThermalScattering[])
                : []
    };
    for (const field of ['color', 'temperature', 'volume', 'isDepletable', 'ncrystalCfg', 'isotropic'] as const) {
        if (field in input) {
            (material as unknown as Record<string, unknown>)[field] = normalizeMaterialField(field, input[field]);
        }
    }
    return material;
}

/**
 * Dry-run material actions on a cloned array and build the before/after diff.
 *
 * @param materials - Current materials; never mutated.
 * @param actions - Requested additions, updates, and removals.
 * @param nextMaterialId - Optional id allocator value from the state manager.
 * @returns Per-field changes, the working materials snapshot, and assigned ids.
 * @throws Error when the action set is invalid or would not change anything.
 */
export function previewMaterialActions(
    materials: readonly OpenMCMaterial[],
    actions: readonly OpenMCMaterialAction[],
    nextMaterialId?: number
): OpenMCMaterialPreview {
    const errors = validateMaterialActions(materials, actions);
    if (errors.length > 0) {
        throw new Error(errors.join(' '));
    }

    const working = cloneMaterials(materials);
    const changes: NukeChange[] = [];
    const addedIds: number[] = [];
    const usedIds = new Set(working.map((material) => material.id));
    let candidate =
        typeof nextMaterialId === 'number' && Number.isInteger(nextMaterialId) && nextMaterialId >= 1
            ? nextMaterialId
            : nextMaterialIdFor(materials);

    for (const action of actions) {
        switch (action.action) {
            case 'update': {
                const material = working.find((entry) => entry.id === action.materialId);
                if (!material) {
                    throw new Error(`Material ${action.materialId} does not exist.`);
                }
                for (const field of MATERIAL_EDITABLE_FIELDS) {
                    if (!(field in action.updates)) {
                        continue;
                    }
                    const before = materialValue(material, field);
                    const after = normalizeMaterialField(field, action.updates[field]);
                    if (materialEquals(before, after)) {
                        continue;
                    }
                    changes.push({
                        path: `materials.${material.id}.${field}`,
                        label: `${material.name} ${FIELD_LABELS[field]}`,
                        kind: 'update',
                        before,
                        after
                    });
                    (material as unknown as Record<string, unknown>)[field] = after;
                }
                break;
            }
            case 'add': {
                while (usedIds.has(candidate)) {
                    candidate += 1;
                }
                const id = candidate;
                candidate += 1;
                usedIds.add(id);
                addedIds.push(id);
                const material = buildAddedMaterial(action.material, id);
                working.push(material);
                changes.push({
                    path: `materials.${id}`,
                    label: `Add material ${material.name}`,
                    kind: 'add',
                    after: cloneMaterial(material)
                });
                break;
            }
            case 'remove': {
                const index = working.findIndex((entry) => entry.id === action.materialId);
                if (index < 0) {
                    throw new Error(`Material ${action.materialId} does not exist.`);
                }
                const [removed] = working.splice(index, 1);
                changes.push({
                    path: `materials.${removed.id}`,
                    label: `Remove material ${removed.name}`,
                    kind: 'remove',
                    before: cloneMaterial(removed)
                });
                break;
            }
        }
    }

    if (changes.length === 0) {
        throw new Error('The material actions would not change any material.');
    }
    return { changes, after: working, addedIds };
}
