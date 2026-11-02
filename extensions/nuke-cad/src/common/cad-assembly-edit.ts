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
 * Pure assembly edit engine for `.nuke-cad` documents.
 *
 * One prepared edit applies 1–16 add/remove/placement actions to a document
 * clone and returns the exact candidate document, solved before/after
 * placements, capability-style changes, a BOM delta, and the labelled
 * embedded-body impact of removals. Nothing here performs a geometry build:
 * selector solid ids, candidate tessellation, collision warnings, and live
 * OpenMC region blocking stay with the capability/preview layer, which
 * enriches the label-keyed region placeholders this module returns.
 *
 * Rules mirror the authoring contract rather than the lower-level store
 * mutations: an existing grounded assembly is required, grounding never
 * changes, removals never cascade connectors/mates (they are rejected
 * instead), file-backed instances are never removable, and placements are
 * pos+quat only.
 *
 * @module nuke-cad/common
 */

import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import {
    ASSEMBLY_SCHEMA_VERSION,
    isQuaternion,
    isVec3,
    instancePlacementToMatrix,
    validateAssemblyDocument,
    type AssemblyInstance,
    type InstancePlacement,
    type Mat4,
    type PosQuatPlacement,
    type Vec3
} from './assembly-document';
import type { NukeCadAssembly, NukeCadDocument } from './cad-document';
import { validateNukeCadDocument } from './cad-document';
import { buildAssemblyBomDelta, type AssemblyBomDelta } from './assembly-bom';

/** Maximum number of actions accepted by one prepared assembly edit. */
export const CAD_ASSEMBLY_EDIT_LIMIT = 16;

/** One requested assembly edit action. */
export type AssemblyChangeInput =
    | {
          readonly action: 'addInstance';
          readonly id?: string;
          readonly part: string;
          readonly placement: PosQuatPlacement;
          readonly scale?: number | Vec3;
      }
    | { readonly action: 'removeInstance'; readonly instanceId: string }
    | { readonly action: 'setPlacement'; readonly instanceId: string; readonly placement: PosQuatPlacement };

/** Full placement/matrix snapshot for one side of a planned instance change. */
export interface AssemblyPlacementSnapshot {
    readonly placement: InstancePlacement;
    readonly matrix: Mat4;
    /**
     * Solid ids owned by the instance. Always empty in the pure engine — no
     * build or selector map exists here. A capability may fill these from a
     * candidate build; the type stays shared for the preview panel.
     */
    readonly solidIds: readonly number[];
}

/** One instance change with its before/after solved placement. */
export interface AssemblyPlacementPlan {
    readonly instanceId: string;
    readonly part: string;
    readonly kind: 'add' | 'remove' | 'place';
    /** Before placement/matrix; absent for add. */
    readonly before?: AssemblyPlacementSnapshot;
    /** After placement/matrix; absent for remove. */
    readonly after?: AssemblyPlacementSnapshot;
}

/**
 * Label-keyed region placeholder for a removal that loses the last instance
 * of an embedded labelled body.
 */
export interface AssemblyRemovedRegion {
    readonly selector: string;
    readonly group: string;
    readonly material?: string;
    readonly materialId?: string;
    /** Empty in the pure engine; the capability fills these from the build. */
    readonly solidIds: readonly number[];
}

/** Complete validated assembly edit prepared for preview and one-commit apply. */
export interface PreparedAssemblyEdit {
    readonly afterDocument: NukeCadDocument;
    readonly afterSection: NukeCadAssembly;
    readonly addedInstanceIds: readonly string[];
    readonly removedInstanceIds: readonly string[];
    readonly changes: readonly NukeChange[];
    readonly placements: readonly AssemblyPlacementPlan[];
    readonly bomDelta: AssemblyBomDelta;
    readonly warnings: readonly string[];
    /** Expected selector keys that disappear with removed labelled instances. */
    readonly removedSelectorKeys: readonly string[];
    /** Label-keyed regions that lose their last instance and need acknowledgement. */
    readonly removedRegions: readonly AssemblyRemovedRegion[];
    readonly requiresAcknowledgement: boolean;
}

/** Stored placement matrices for the grounded/unmated instances this slice permits. */
function storedPlacementMatrices(assembly: NukeCadAssembly): Map<string, Mat4> {
    return new Map(assembly.instances.map((instance) => [instance.id, instancePlacementToMatrix(instance.placement)]));
}

/** Result of {@link prepareAssemblyEdit}: a complete edit or a rejection message. */
export type AssemblyEditPrepareResult =
    { readonly ok: true; readonly result: PreparedAssemblyEdit } | { readonly ok: false; readonly message: string };

interface PendingAdd {
    readonly kind: 'add';
    readonly id: string;
    readonly part: string;
    readonly placement: PosQuatPlacement;
    readonly scale?: number | Vec3;
}

interface PendingRemove {
    readonly kind: 'remove';
    readonly instance: AssemblyInstance;
}

interface PendingPlace {
    readonly kind: 'place';
    readonly instance: AssemblyInstance;
    readonly placement: PosQuatPlacement;
}

type PendingAssemblyAction = PendingAdd | PendingRemove | PendingPlace;

function reject(message: string): { readonly ok: false; readonly message: string } {
    return { ok: false, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneDocument(document: NukeCadDocument): NukeCadDocument {
    return JSON.parse(JSON.stringify(document)) as NukeCadDocument;
}

function clonePlacement(placement: InstancePlacement): InstancePlacement {
    if ('matrix' in placement) {
        return { matrix: [...placement.matrix] as Mat4 };
    }
    return {
        position: [placement.position[0], placement.position[1], placement.position[2]],
        orientation: [placement.orientation[0], placement.orientation[1], placement.orientation[2], placement.orientation[3]]
    };
}

function clonePosQuat(placement: PosQuatPlacement): PosQuatPlacement {
    return {
        position: [placement.position[0], placement.position[1], placement.position[2]],
        orientation: [placement.orientation[0], placement.orientation[1], placement.orientation[2], placement.orientation[3]]
    };
}

function isValidPosQuat(value: unknown): value is PosQuatPlacement {
    if (!isRecord(value) || !isVec3(value.position) || !isQuaternion(value.orientation)) {
        return false;
    }
    const [x, y, z, w] = value.orientation;
    return Math.sqrt(x * x + y * y + z * z + w * w) > 1e-9;
}

function isValidScale(value: unknown): value is number | Vec3 {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0;
    }
    return isVec3(value) && value[0] > 0 && value[1] > 0 && value[2] > 0;
}

function bodyIdFromPart(part: string): string | undefined {
    if (!part.startsWith('body:')) {
        return undefined;
    }
    const bodyId = part.slice('body:'.length);
    return bodyId.length > 0 ? bodyId : undefined;
}

function isBodyMated(assembly: NukeCadAssembly, instanceId: string): boolean {
    return assembly.mates.some((mate) => mate.instanceA === instanceId || mate.instanceB === instanceId);
}

function isBodyConnected(assembly: NukeCadAssembly, instanceId: string): boolean {
    return assembly.connectors.some((connector) => connector.instanceId === instanceId);
}

function nextInstanceId(taken: Set<string>): string {
    let index = taken.size + 1;
    let id = `instance-${index}`;
    while (taken.has(id)) {
        index++;
        id = `instance-${index}`;
    }
    taken.add(id);
    return id;
}

function formatAssemblyIssues(issues: readonly { path: string; message: string }[]): string {
    return issues.map((issue) => `${issue.path || 'assembly'}: ${issue.message}`).join('; ');
}

/**
 * Validate and apply assembly actions to a copy of `document`.
 *
 * The whole request is rejected if any action is invalid, so a call either
 * produces a complete candidate or no document at all. All action shapes,
 * duplicate targets, grounding, connector/mate references, and allowed part
 * sources are validated before the clone is mutated. The returned document is
 * a detached copy with only the assembly section changed; the input document
 * is never touched.
 */
export function prepareAssemblyEdit(document: NukeCadDocument, actions: readonly AssemblyChangeInput[]): AssemblyEditPrepareResult {
    if (!isRecord(document)) {
        return reject('The document must be an object.');
    }
    const beforeSection = document.assembly;
    if (beforeSection === undefined) {
        return reject('This document has no assembly section; add an assembly before changing instances.');
    }
    if (
        !Array.isArray(beforeSection.instances) ||
        !Array.isArray(beforeSection.connectors) ||
        !Array.isArray(beforeSection.mates) ||
        !Array.isArray(document.bodies)
    ) {
        return reject('The assembly section is malformed.');
    }
    if (typeof beforeSection.groundedInstanceId !== 'string' || beforeSection.groundedInstanceId.length === 0) {
        return reject('The assembly must have a grounded instance before instances can be edited.');
    }
    if (!beforeSection.instances.some((instance) => instance.id === beforeSection.groundedInstanceId)) {
        return reject(`Grounded instance '${beforeSection.groundedInstanceId}' does not exist.`);
    }
    if (!Array.isArray(actions) || actions.length === 0) {
        return reject('No assembly edit actions were provided.');
    }
    if (actions.length > CAD_ASSEMBLY_EDIT_LIMIT) {
        return reject(`Too many assembly edit actions (${actions.length}); at most ${CAD_ASSEMBLY_EDIT_LIMIT} are allowed.`);
    }

    const existingIds = new Set(beforeSection.instances.map((instance) => instance.id));
    const reservedAddIds = new Set<string>();
    const claimedTargets = new Set<string>();

    // Phase 1: shape and duplicate validation before any clone is mutated.
    for (const [index, action] of actions.entries()) {
        if (!isRecord(action)) {
            return reject(`Assembly edit action ${index + 1} must be an object.`);
        }
        const kind = action.action;
        if (kind === 'addInstance') {
            const id = action.id;
            if (id !== undefined) {
                if (typeof id !== 'string' || id.length === 0) {
                    return reject(`Assembly edit action ${index + 1} id must be a non-empty string.`);
                }
                if (existingIds.has(id)) {
                    return reject(`Instance id '${id}' is already in use.`);
                }
                if (reservedAddIds.has(id) || claimedTargets.has(id)) {
                    return reject(`Duplicate assembly edit for instance '${id}'.`);
                }
                reservedAddIds.add(id);
            }
            continue;
        }
        if (kind === 'removeInstance' || kind === 'setPlacement') {
            const instanceId = action.instanceId;
            if (typeof instanceId !== 'string' || instanceId.length === 0) {
                return reject(`Assembly edit action ${index + 1} requires a non-empty instance id.`);
            }
            if (claimedTargets.has(instanceId) || reservedAddIds.has(instanceId)) {
                return reject(`Duplicate assembly edit for instance '${instanceId}'.`);
            }
            claimedTargets.add(instanceId);
            continue;
        }
        return reject(`Assembly edit action ${index + 1} has an unknown action '${String(kind)}'.`);
    }

    const takenIds = new Set<string>([...existingIds, ...reservedAddIds]);
    const pending: PendingAssemblyAction[] = [];

    // Phase 2: semantic validation against the pre-edit section.
    for (const [index, action] of actions.entries()) {
        const kind = action.action;
        if (kind === 'addInstance') {
            const part = action.part;
            if (typeof part !== 'string' || part.length === 0) {
                return reject(`Assembly edit action ${index + 1} requires a non-empty part.`);
            }
            if (part.startsWith('body:')) {
                const bodyId = bodyIdFromPart(part);
                if (bodyId === undefined || !document.bodies.some((body) => body.id === bodyId)) {
                    return reject(`Assembly edit action ${index + 1} references unknown body '${part}'.`);
                }
            } else if (!beforeSection.instances.some((instance) => instance.part === part)) {
                return reject(
                    `Assembly edit action ${index + 1} part '${part}' is neither a body:<id> source nor an existing instance part.`
                );
            }
            if (!isValidPosQuat(action.placement)) {
                return reject(`Assembly edit action ${index + 1} placement must have a finite position and a non-zero quaternion.`);
            }
            if (action.scale !== undefined && !isValidScale(action.scale)) {
                return reject(`Assembly edit action ${index + 1} scale must be a positive number or a [sx, sy, sz] array of positives.`);
            }
            const id = action.id ?? nextInstanceId(takenIds);
            if (action.id !== undefined) {
                takenIds.add(action.id);
            }
            pending.push({
                kind: 'add',
                id,
                part,
                placement: clonePosQuat(action.placement),
                ...(action.scale !== undefined
                    ? { scale: Array.isArray(action.scale) ? ([action.scale[0], action.scale[1], action.scale[2]] as Vec3) : action.scale }
                    : {})
            });
            continue;
        }

        const instanceId = action.instanceId;
        const instance = beforeSection.instances.find((candidate) => candidate.id === instanceId);
        if (instance === undefined) {
            return reject(`Instance '${instanceId}' not found.`);
        }

        if (kind === 'removeInstance') {
            if (instance.id === beforeSection.groundedInstanceId) {
                return reject(`Instance '${instanceId}' is grounded and cannot be removed.`);
            }
            if (bodyIdFromPart(instance.part) === undefined) {
                return reject(`Instance '${instanceId}' is file-backed; only embedded body:<id> instances can be removed.`);
            }
            if (isBodyMated(beforeSection, instanceId)) {
                return reject(`Instance '${instanceId}' participates in a mate; remove the mate before removing the instance.`);
            }
            if (isBodyConnected(beforeSection, instanceId)) {
                return reject(`Instance '${instanceId}' has connectors; remove its connectors before removing the instance.`);
            }
            pending.push({ kind: 'remove', instance });
            continue;
        }

        if (isBodyMated(beforeSection, instanceId)) {
            return reject(`Instance '${instanceId}' participates in a mate and cannot be moved independently.`);
        }
        if (!isValidPosQuat(action.placement)) {
            return reject(`Instance '${instanceId}' placement must have a finite position and a non-zero quaternion.`);
        }
        pending.push({ kind: 'place', instance, placement: clonePosQuat(action.placement) });
    }

    const removeCount = pending.filter((action) => action.kind === 'remove').length;
    if (beforeSection.instances.length - removeCount < 1) {
        return reject('An assembly edit must leave at least one instance.');
    }

    const afterDocument = cloneDocument(document);
    const afterSection = afterDocument.assembly;
    if (afterSection === undefined) {
        return reject('The document assembly section disappeared while preparing the edit.');
    }

    for (const action of pending) {
        if (action.kind === 'add') {
            const instance: AssemblyInstance = {
                id: action.id,
                part: action.part,
                placement: clonePosQuat(action.placement)
            };
            if (action.scale !== undefined) {
                instance.scale = Array.isArray(action.scale) ? ([action.scale[0], action.scale[1], action.scale[2]] as Vec3) : action.scale;
            }
            afterSection.instances.push(instance);
        } else if (action.kind === 'remove') {
            afterSection.instances = afterSection.instances.filter((instance) => instance.id !== action.instance.id);
        } else {
            const target = afterSection.instances.find((instance) => instance.id === action.instance.id);
            if (target === undefined) {
                return reject(`Instance '${action.instance.id}' disappeared while preparing the edit.`);
            }
            target.placement = clonePosQuat(action.placement);
        }
    }

    const assemblyName = typeof afterDocument.name === 'string' && afterDocument.name.length > 0 ? afterDocument.name : 'assembly';
    const assemblyCheck = validateAssemblyDocument({
        version: ASSEMBLY_SCHEMA_VERSION,
        name: assemblyName,
        instances: afterSection.instances,
        connectors: afterSection.connectors,
        mates: afterSection.mates,
        groundedInstanceId: afterSection.groundedInstanceId
    });
    if (!assemblyCheck.valid) {
        return reject(`The edited assembly is invalid: ${formatAssemblyIssues(assemblyCheck.issues)}`);
    }
    const documentCheck = validateNukeCadDocument(afterDocument);
    if (!documentCheck.valid) {
        return reject(`The edited document is invalid: ${formatAssemblyIssues(documentCheck.issues)}`);
    }

    const beforeMatrices = storedPlacementMatrices(beforeSection);
    const afterMatrices = storedPlacementMatrices(afterSection);
    const afterById = new Map(afterSection.instances.map((instance) => [instance.id, instance]));
    const changes: NukeChange[] = [];
    const placements: AssemblyPlacementPlan[] = [];
    const addedInstanceIds: string[] = [];
    const removedInstanceIds: string[] = [];

    for (const action of pending) {
        if (action.kind === 'add') {
            const instance = afterById.get(action.id);
            if (instance === undefined) {
                return reject(`Instance '${action.id}' disappeared while preparing the edit.`);
            }
            addedInstanceIds.push(action.id);
            changes.push({
                path: `assemblies.instances.${action.id}`,
                label: `Assembly instance ${action.id}`,
                kind: 'add',
                after: instance.part
            });
            placements.push({
                instanceId: action.id,
                part: instance.part,
                kind: 'add',
                after: {
                    placement: clonePlacement(instance.placement),
                    matrix: afterMatrices.get(action.id) ?? instancePlacementToMatrix(instance.placement),
                    solidIds: []
                }
            });
            continue;
        }

        if (action.kind === 'remove') {
            removedInstanceIds.push(action.instance.id);
            changes.push({
                path: `assemblies.instances.${action.instance.id}`,
                label: `Assembly instance ${action.instance.id}`,
                kind: 'remove',
                before: action.instance.part,
                after: undefined
            });
            placements.push({
                instanceId: action.instance.id,
                part: action.instance.part,
                kind: 'remove',
                before: {
                    placement: clonePlacement(action.instance.placement),
                    matrix: beforeMatrices.get(action.instance.id) ?? instancePlacementToMatrix(action.instance.placement),
                    solidIds: []
                }
            });
            continue;
        }

        const afterInstance = afterById.get(action.instance.id);
        if (afterInstance === undefined) {
            return reject(`Instance '${action.instance.id}' disappeared while preparing the edit.`);
        }
        changes.push({
            path: `assemblies.instances.${action.instance.id}`,
            label: `Assembly instance ${action.instance.id}`,
            kind: 'update',
            before: clonePlacement(action.instance.placement),
            after: clonePlacement(afterInstance.placement)
        });
        placements.push({
            instanceId: action.instance.id,
            part: afterInstance.part,
            kind: 'place',
            before: {
                placement: clonePlacement(action.instance.placement),
                matrix: beforeMatrices.get(action.instance.id) ?? instancePlacementToMatrix(action.instance.placement),
                solidIds: []
            },
            after: {
                placement: clonePlacement(afterInstance.placement),
                matrix: afterMatrices.get(action.instance.id) ?? instancePlacementToMatrix(afterInstance.placement),
                solidIds: []
            }
        });
    }

    const bodyById = new Map(afterDocument.bodies.map((body) => [body.id, body]));
    const remainingLabels = new Set<string>();
    for (const instance of afterSection.instances) {
        const bodyId = bodyIdFromPart(instance.part);
        const label = bodyId !== undefined ? bodyById.get(bodyId)?.label : undefined;
        if (label !== undefined && label.length > 0) {
            remainingLabels.add(label);
        }
    }

    const warnings: string[] = [];
    const removedSelectorKeys: string[] = [];
    const removedRegions: AssemblyRemovedRegion[] = [];
    const affectedLabels = new Set<string>();
    for (const action of pending) {
        if (action.kind !== 'remove') {
            continue;
        }
        const bodyId = bodyIdFromPart(action.instance.part);
        const body = bodyId !== undefined ? bodyById.get(bodyId) : undefined;
        const label = body?.label;
        if (label === undefined || label.length === 0) {
            warnings.push(`Instance '${action.instance.id}' has no region label; no labelled region is affected.`);
            continue;
        }
        removedSelectorKeys.push(`${action.instance.id}/${label}`);
        if (!remainingLabels.has(label)) {
            if (!affectedLabels.has(label)) {
                affectedLabels.add(label);
                removedRegions.push({
                    selector: label,
                    group: label,
                    ...(body?.material !== undefined ? { material: body.material } : {}),
                    solidIds: []
                });
            }
            warnings.push(
                `Removing instance '${action.instance.id}' removes the last instance of labelled body '${label}'; acknowledgement is required.`
            );
        } else {
            warnings.push(`Removing instance '${action.instance.id}' removes its '${label}' region instance; other instances remain.`);
        }
    }

    return {
        ok: true,
        result: {
            afterDocument,
            afterSection,
            addedInstanceIds,
            removedInstanceIds,
            changes,
            placements,
            bomDelta: buildAssemblyBomDelta(beforeSection, afterSection),
            warnings,
            removedSelectorKeys,
            removedRegions,
            requiresAcknowledgement: removedRegions.length > 0
        }
    };
}
