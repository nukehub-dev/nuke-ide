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
 * Sketch-dimension authoring transaction.
 *
 * Resolves literal driving dimensions and document-parameter edits against a
 * detached copy of the document, re-solves every affected sketch with the real
 * planegcs solver, re-samples dependent parametric curves, and returns one
 * atomic before/after snapshot. The caller applies it through
 * {@link CadDocumentStore.applySketchAuthoringEdit}.
 *
 * @module nuke-cad/browser/sketch
 */

import { PlanegcsSketchSolver } from '../../common/sketch-solver';
import {
    validateNukeCadDocument,
    type DimensionKind,
    type NukeCadDocument,
    type SketchDef,
    type SketchDimension
} from '../../common/cad-document';
import {
    CadDocumentStore,
    buildCurveSamples,
    collectParameterUsages,
    featuresConsumingCurve,
    featuresConsumingSketch,
    type DocumentMutationResult
} from '../document/cad-document-store';
import { SketchSession, type SketchStatus } from './sketch-session';
import {
    CAD_SKETCH_EDIT_LIMIT,
    type CreateSketchSolver,
    type PreparedSketchEdit,
    type ResolvedSketchEdit,
    type SketchEditErrorCode,
    type SketchEditPrepareResult,
    type SketchEditRequest,
    type SketchSolveStatus,
    type SketchSolveSummary
} from './sketch-edit-types';
import { getPlanegcsWasmUrl } from './planegcs-wasm-url';
import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';

/** One request after shape validation. */
interface NormalizedRequest {
    readonly sketchId: string;
    readonly dimensionId?: string;
    readonly parameterName?: string;
    readonly value: number;
}

/** A literal dimension edit applied to the target session. */
interface LiteralDimensionEdit {
    readonly dimensionId: string;
    readonly value: number;
    readonly before: number;
}

/** A resolved request before its rows are built. */
type ResolvedRequest =
    | { readonly kind: 'dimension'; readonly dimensionId: string; readonly value: number; readonly before: number }
    | {
          readonly kind: 'parameter';
          readonly parameterName: string;
          readonly value: number;
          readonly dimensionId?: string;
          readonly dimensionKind?: DimensionKind;
      };

/** One driving dimension bound to a changed document parameter. */
interface BoundDimension {
    readonly sketchId: string;
    readonly sketchName: string;
    readonly dimensionId: string;
    readonly kind: DimensionKind;
    readonly before: number;
}

/** Internal rejection carrying a stable error code. */
class SketchEditRejected extends Error {
    constructor(
        readonly code: SketchEditErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'SketchEditRejected';
    }
}

function reject(code: SketchEditErrorCode, message: string): never {
    throw new SketchEditRejected(code, message);
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function hasOwn(record: Readonly<Record<string, number>>, name: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, name);
}

function dimensionKindLabel(kind: DimensionKind | undefined): string {
    switch (kind) {
        case 'radius':
            return 'Radius';
        case 'diameter':
            return 'Diameter';
        case 'angle':
            return 'Angle';
        case 'distance':
            return 'Distance';
        case 'distanceH':
            return 'Horizontal distance';
        case 'distanceV':
            return 'Vertical distance';
        default:
            return 'Dimension';
    }
}

function findDimension(def: SketchDef | undefined, dimensionId: string): SketchDimension | undefined {
    return (def?.dimensions ?? []).find((dimension) => dimension.id === dimensionId);
}

function findSketch(document: NukeCadDocument, sketchId: string): SketchDef | undefined {
    return document.sketches.find((sketch) => sketch.id === sketchId);
}

function assertSolveSucceeded(status: SketchStatus, sketchName: string): void {
    if (status.solveStatus === 'failed') {
        reject('solver-failed', `Sketch '${sketchName}' failed to solve`);
    }
    if (status.conflicting.length > 0) {
        reject('solve-conflicting', `Sketch '${sketchName}' has conflicting constraints: ${status.conflicting.join(', ')}`);
    }
    const error = (status.diagnostics ?? []).find((diagnostic) => diagnostic.severity === 'error');
    if (error !== undefined) {
        reject('solver-failed', `Sketch '${sketchName}': ${error.message}`);
    }
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

/**
 * Compare two detached sketch snapshots deterministically.
 *
 * Object keys are sorted before serialization so snapshots produced by
 * different code paths (document load vs session serialization) compare by
 * content rather than key order.
 */
export function sketchDefinitionsEqual(a: SketchDef | undefined, b: SketchDef | undefined): boolean {
    if (a === undefined || b === undefined) {
        return a === b;
    }
    const stable = (value: unknown): string => {
        if (value === undefined) {
            return 'null';
        }
        if (value === null || typeof value !== 'object') {
            return JSON.stringify(value) ?? 'null';
        }
        if (Array.isArray(value)) {
            return `[${value.map(stable).join(',')}]`;
        }
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
            .join(',')}}`;
    };
    return stable(a) === stable(b);
}

/**
 * Prepare and commit sketch-dimension authoring edits.
 *
 * `prepare` never mutates its input document and disposes every solver it
 * creates. `commit` writes the prepared snapshots through the document store's
 * single atomic commit path.
 */
export class NukeCadSketchEditService {
    private readonly createSolver: CreateSketchSolver;

    constructor(createSolver?: CreateSketchSolver) {
        this.createSolver = createSolver ?? (() => PlanegcsSketchSolver.create({ locateFile: () => getPlanegcsWasmUrl() }));
    }

    async prepare(document: NukeCadDocument, requests: readonly SketchEditRequest[]): Promise<SketchEditPrepareResult> {
        const sessions: SketchSession[] = [];
        try {
            return await this.prepareInternal(document, requests, sessions);
        } catch (error) {
            if (error instanceof SketchEditRejected) {
                return { ok: false, code: error.code, message: error.message };
            }
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, code: 'solver-failed', message: `Sketch solve failed: ${message}` };
        } finally {
            for (const session of sessions) {
                try {
                    session.destroy();
                } catch {
                    // Solver teardown must never mask the transaction result.
                }
            }
        }
    }

    commit(store: CadDocumentStore, prepared: PreparedSketchEdit): DocumentMutationResult {
        return store.applySketchAuthoringEdit({
            sketches: Object.values(prepared.afterSketches),
            parameters: prepared.afterParameters
        });
    }

    private async prepareInternal(
        document: NukeCadDocument,
        requests: readonly SketchEditRequest[],
        sessions: SketchSession[]
    ): Promise<SketchEditPrepareResult> {
        if (!Array.isArray(requests) || requests.length === 0) {
            reject('invalid-input', 'At least one sketch edit is required');
        }
        if (requests.length > CAD_SKETCH_EDIT_LIMIT) {
            reject('too-many-edits', `At most ${CAD_SKETCH_EDIT_LIMIT} sketch edits are allowed per transaction`);
        }

        const normalized: NormalizedRequest[] = [];
        for (const [index, request] of requests.entries()) {
            if (request === null || typeof request !== 'object') {
                reject('invalid-input', `Edit ${index + 1} must be an object`);
            }
            const candidate = request as { sketchId?: unknown; dimensionId?: unknown; parameterName?: unknown; value?: unknown };
            const sketchId = candidate.sketchId;
            if (typeof sketchId !== 'string' || sketchId.length === 0) {
                reject('invalid-input', `Edit ${index + 1} must have a non-empty sketchId`);
            }
            if (candidate.dimensionId !== undefined && typeof candidate.dimensionId !== 'string') {
                reject('invalid-input', `Edit ${index + 1} dimensionId must be a string`);
            }
            if (candidate.parameterName !== undefined && typeof candidate.parameterName !== 'string') {
                reject('invalid-input', `Edit ${index + 1} parameterName must be a string`);
            }
            const hasDimension = typeof candidate.dimensionId === 'string' && candidate.dimensionId.length > 0;
            const hasParameter = typeof candidate.parameterName === 'string' && candidate.parameterName.length > 0;
            if (hasDimension === hasParameter) {
                reject('invalid-input', `Edit ${index + 1} must target exactly one dimension or parameter`);
            }
            if (typeof candidate.value !== 'number') {
                reject('invalid-input', `Edit ${index + 1} value must be a number`);
            }
            if (!Number.isFinite(candidate.value)) {
                reject('value-not-finite', `Edit ${index + 1} value must be finite, got ${candidate.value}`);
            }
            normalized.push({
                sketchId,
                dimensionId: hasDimension ? (candidate.dimensionId as string) : undefined,
                parameterName: hasParameter ? (candidate.parameterName as string) : undefined,
                value: candidate.value
            });
        }

        const targetSketchId = normalized[0].sketchId;
        if (normalized.some((request) => request.sketchId !== targetSketchId)) {
            reject('multiple-sketches', 'All edits in one transaction must target the same sketch');
        }

        const dimensionValues = new Map<string, number>();
        const parameterValues = new Map<string, number>();
        for (const request of normalized) {
            if (request.dimensionId !== undefined) {
                const existing = dimensionValues.get(request.dimensionId);
                if (existing !== undefined && existing !== request.value) {
                    reject('duplicate-edit', `Dimension '${request.dimensionId}' is edited with conflicting values`);
                }
                dimensionValues.set(request.dimensionId, request.value);
            }
            if (request.parameterName !== undefined) {
                const existing = parameterValues.get(request.parameterName);
                if (existing !== undefined && existing !== request.value) {
                    reject('parameter-conflict', `Parameter '${request.parameterName}' is edited with conflicting values`);
                }
                parameterValues.set(request.parameterName, request.value);
            }
        }

        const targetSketch = findSketch(document, targetSketchId);
        if (targetSketch === undefined) {
            reject('sketch-not-found', `Sketch '${targetSketchId}' not found`);
        }

        const usages = collectParameterUsages(document);
        const usageByName = new Map(usages.map((usage) => [usage.name, usage]));

        const literalEdits: LiteralDimensionEdit[] = [];
        const resolvedRequests: ResolvedRequest[] = [];
        const parameterUpdates = new Map<string, number>();
        const parameterBoundDimensionIds = new Set<string>();

        const recordParameter = (name: string, value: number, dimensionId?: string, dimensionKind?: DimensionKind): void => {
            const existing = parameterUpdates.get(name);
            if (existing !== undefined && existing !== value) {
                reject('parameter-conflict', `Parameter '${name}' is edited with conflicting values`);
            }
            if (existing === undefined) {
                parameterUpdates.set(name, value);
            }
            if (dimensionId !== undefined) {
                parameterBoundDimensionIds.add(dimensionId);
            }
            resolvedRequests.push({ kind: 'parameter', parameterName: name, value, dimensionId, dimensionKind });
        };

        for (const request of normalized) {
            if (request.dimensionId !== undefined) {
                const dimension = (targetSketch.dimensions ?? []).find((entry) => entry.id === request.dimensionId);
                if (dimension === undefined) {
                    reject('dimension-not-found', `Dimension '${request.dimensionId}' not found on sketch '${targetSketch.name}'`);
                }
                if (!dimension.driving) {
                    reject('dimension-not-driving', `Dimension '${dimension.id}' is a reference dimension and cannot be edited`);
                }
                if (!targetSketch.constraints.some((constraint) => (constraint as { id?: unknown }).id === dimension.constraintId)) {
                    reject(
                        'dimension-constraint-missing',
                        `Dimension '${dimension.id}' references missing constraint '${dimension.constraintId}'`
                    );
                }
                const boundParameter = typeof dimension.parameter === 'string' ? dimension.parameter : '';
                if (boundParameter.length > 0) {
                    if (!hasOwn(document.parameters, boundParameter)) {
                        reject('parameter-not-found', `Parameter '${boundParameter}' not found`);
                    }
                    if (dimension.value === request.value) {
                        reject('value-unchanged', `Dimension '${dimension.id}' is already ${request.value}`);
                    }
                    recordParameter(boundParameter, request.value, dimension.id, dimension.kind);
                } else {
                    if (dimension.value === request.value) {
                        reject('value-unchanged', `Dimension '${dimension.id}' is already ${request.value}`);
                    }
                    literalEdits.push({ dimensionId: dimension.id, value: request.value, before: dimension.value });
                    resolvedRequests.push({ kind: 'dimension', dimensionId: dimension.id, value: request.value, before: dimension.value });
                }
            } else {
                const name = request.parameterName as string;
                if (!hasOwn(document.parameters, name)) {
                    reject('parameter-not-found', `Parameter '${name}' not found`);
                }
                const usage = usageByName.get(name);
                const referenced =
                    usage !== undefined && usage.usedBy.some((referrer) => referrer.kind === 'sketch' || referrer.kind === 'curve');
                if (!referenced) {
                    reject('parameter-not-referenced', `Parameter '${name}' is not referenced by a sketch dimension, constraint, or curve`);
                }
                const before = document.parameters[name];
                if (before === request.value) {
                    reject('value-unchanged', `Parameter '${name}' is already ${request.value}`);
                }
                recordParameter(name, request.value);
            }
        }

        for (const literal of literalEdits) {
            if (parameterBoundDimensionIds.has(literal.dimensionId)) {
                reject('duplicate-edit', `Dimension '${literal.dimensionId}' is edited both literally and through its parameter`);
            }
        }

        const affectedSketchIds = new Set<string>([targetSketch.id]);
        const affectedCurveIds = new Set<string>();
        for (const name of parameterUpdates.keys()) {
            const usage = usageByName.get(name);
            if (usage === undefined) {
                continue;
            }
            for (const referrer of usage.usedBy) {
                if (referrer.kind === 'sketch') {
                    affectedSketchIds.add(referrer.id);
                } else if (referrer.kind === 'curve') {
                    affectedCurveIds.add(referrer.id);
                }
            }
        }
        const affectedSketches = document.sketches.filter((sketch) => affectedSketchIds.has(sketch.id));

        const affectedFeatureIdSet = new Set<string>();
        for (const sketch of affectedSketches) {
            for (const featureId of featuresConsumingSketch(document, sketch.id)) {
                affectedFeatureIdSet.add(featureId);
            }
        }
        for (const curveId of affectedCurveIds) {
            for (const featureId of featuresConsumingCurve(document, curveId)) {
                affectedFeatureIdSet.add(featureId);
            }
        }
        const affectedFeatureIds = document.features.filter((feature) => affectedFeatureIdSet.has(feature.id)).map((feature) => feature.id);

        const candidateParameters: Record<string, number> = { ...document.parameters };
        for (const [name, value] of parameterUpdates) {
            candidateParameters[name] = value;
        }

        const beforeSketches: Record<string, SketchDef> = {};
        const afterSketches: Record<string, SketchDef> = {};
        const statuses = new Map<string, SketchStatus>();

        for (const sketch of affectedSketches) {
            const solver = await this.createSolver();
            let session: SketchSession;
            try {
                session = await SketchSession.fromSketchDef(cloneJson(sketch), solver, {
                    inheritedParameters: candidateParameters
                });
            } catch (error) {
                solver.destroy();
                throw error;
            }
            sessions.push(session);

            if (sketch.id === targetSketch.id) {
                for (const edit of literalEdits) {
                    const result = await session.editDimension(edit.dimensionId, { value: edit.value });
                    if (!result.success) {
                        reject('solver-failed', result.error ?? `Failed to edit dimension '${edit.dimensionId}'`);
                    }
                }
            }

            const status = session.getStatus();
            assertSolveSucceeded(status, sketch.name);
            statuses.set(sketch.id, status);
            beforeSketches[sketch.id] = cloneJson(sketch);
            afterSketches[sketch.id] = cloneJson(session.toSketchDef());
        }

        const afterDocument = cloneJson(document);
        for (const [name, value] of parameterUpdates) {
            afterDocument.parameters[name] = value;
        }
        afterDocument.sketches = afterDocument.sketches.map((sketch) => {
            const replacement = afterSketches[sketch.id];
            if (replacement === undefined) {
                return sketch;
            }
            for (const [name, value] of Object.entries(replacement.parameters ?? {})) {
                afterDocument.parameters[name] = value;
            }
            return { ...replacement, parameters: undefined };
        });

        for (const curveId of affectedCurveIds) {
            const index = afterDocument.curves.findIndex((curve) => curve.id === curveId);
            if (index < 0) {
                continue;
            }
            const curve = afterDocument.curves[index];
            if (curve.source.kind === 'points') {
                continue;
            }
            const result = buildCurveSamples(curve.source, afterDocument.parameters, afterDocument.units);
            if (result.error !== undefined) {
                reject('curve-resample-failed', `Curve '${curve.name}' could not be resampled: ${result.error}`);
            }
            if (result.samples.length < 4) {
                reject('curve-resample-failed', `Curve '${curve.name}' resampled to fewer than 4 points`);
            }
            afterDocument.curves[index] = { ...curve, samples: result.samples };
        }

        const validation = validateNukeCadDocument(afterDocument);
        if (!validation.valid) {
            const details = validation.issues
                .slice(0, 3)
                .map((issue) => `${issue.path || 'document'}: ${issue.message}`)
                .join('; ');
            const remaining = validation.issues.length > 3 ? ` (+${validation.issues.length - 3} more)` : '';
            reject('document-validation-failed', `Edited document is invalid: ${details}${remaining}`);
        }

        const changes: NukeChange[] = [];
        const changePaths = new Set<string>();
        const pushChange = (change: NukeChange): void => {
            if (changePaths.has(change.path)) {
                return;
            }
            changePaths.add(change.path);
            changes.push(change);
        };

        const afterDimensionValue = (sketchId: string, dimensionId: string): number | undefined =>
            findDimension(afterSketches[sketchId], dimensionId)?.value;

        const edits: ResolvedSketchEdit[] = [];
        for (const request of resolvedRequests) {
            if (request.kind === 'dimension') {
                const after = afterDimensionValue(targetSketch.id, request.dimensionId) ?? request.value;
                const dimension = findDimension(targetSketch, request.dimensionId);
                const kind = dimension?.kind;
                pushChange({
                    path: `sketches.${targetSketch.id}.dimensions.${request.dimensionId}`,
                    label: `${targetSketch.name}: ${dimensionKindLabel(kind)} ${request.dimensionId}`,
                    kind: 'update',
                    before: request.before,
                    after
                });
                edits.push({
                    kind: 'dimension',
                    sketchId: targetSketch.id,
                    sketchName: targetSketch.name,
                    dimensionId: request.dimensionId,
                    dimensionKind: kind,
                    before: request.before,
                    after,
                    affectedDimensionIds: [request.dimensionId]
                });
            } else {
                const bound = collectBoundDimensions(affectedSketches, request.parameterName);
                edits.push({
                    kind: 'parameter',
                    sketchId: targetSketch.id,
                    sketchName: targetSketch.name,
                    dimensionId: request.dimensionId,
                    dimensionKind: request.dimensionKind,
                    parameterName: request.parameterName,
                    before: document.parameters[request.parameterName],
                    after: parameterUpdates.get(request.parameterName) ?? request.value,
                    affectedDimensionIds: bound.map((entry) => entry.dimensionId)
                });
            }
        }

        for (const [name, after] of parameterUpdates) {
            pushChange({
                path: `parameters.${name}`,
                label: `Parameter ${name}`,
                kind: 'update',
                before: document.parameters[name],
                after
            });
            for (const bound of collectBoundDimensions(affectedSketches, name)) {
                const afterValue = afterDimensionValue(bound.sketchId, bound.dimensionId) ?? after;
                pushChange({
                    path: `sketches.${bound.sketchId}.dimensions.${bound.dimensionId}`,
                    label: `${bound.sketchName}: ${dimensionKindLabel(bound.kind)} ${bound.dimensionId}`,
                    kind: 'update',
                    before: bound.before,
                    after: afterValue
                });
            }
        }

        const solveStatuses: SketchSolveStatus[] = affectedSketches.map((sketch) => {
            const status = statuses.get(sketch.id);
            const diagnostics = status?.diagnostics ?? [];
            return {
                sketchId: sketch.id,
                sketchName: sketch.name,
                status: status?.solveStatus === 'failed' ? 'failed' : 'converged',
                dof: status?.dof ?? 0,
                fullyConstrained: status?.fullyConstrained ?? false,
                conflicting: [...(status?.conflicting ?? [])],
                redundant: [...(status?.redundant ?? [])],
                errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
                warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length
            };
        });
        const targetStatus = statuses.get(targetSketch.id);
        const solver: SketchSolveSummary = {
            status: solveStatuses.some((status) => status.status === 'failed') ? 'failed' : 'converged',
            dof: targetStatus?.dof ?? 0,
            fullyConstrained: solveStatuses.every((status) => status.fullyConstrained),
            conflicting: unique(solveStatuses.flatMap((status) => status.conflicting)),
            redundant: unique(solveStatuses.flatMap((status) => status.redundant)),
            errorCount: solveStatuses.reduce((total, status) => total + status.errorCount, 0),
            warningCount: solveStatuses.reduce((total, status) => total + status.warningCount, 0),
            sketches: solveStatuses
        };

        const beforeParameters: Record<string, number> = {};
        const afterParameters: Record<string, number> = {};
        for (const [name, value] of parameterUpdates) {
            beforeParameters[name] = document.parameters[name];
            afterParameters[name] = value;
        }

        const result: PreparedSketchEdit = {
            targetSketchId: targetSketch.id,
            targetSketchName: targetSketch.name,
            afterDocument,
            beforeSketches,
            afterSketches,
            beforeParameters,
            afterParameters,
            edits,
            changes,
            solver,
            affectedSketchIds: affectedSketches.map((sketch) => sketch.id),
            affectedFeatureIds
        };
        return { ok: true, result };
    }
}

function collectBoundDimensions(sketches: readonly SketchDef[], parameterName: string): BoundDimension[] {
    const bound: BoundDimension[] = [];
    for (const sketch of sketches) {
        for (const dimension of sketch.dimensions ?? []) {
            if (dimension.driving && dimension.parameter === parameterName) {
                bound.push({
                    sketchId: sketch.id,
                    sketchName: sketch.name,
                    dimensionId: dimension.id,
                    kind: dimension.kind,
                    before: dimension.value
                });
            }
        }
    }
    return bound;
}
