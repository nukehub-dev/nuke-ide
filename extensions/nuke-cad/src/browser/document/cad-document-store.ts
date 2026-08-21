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
 * Pure TypeScript document store for `.nuke-cad` models.
 *
 * Holds the active {@link NukeCadDocument}, its dirty state, the backing file
 * URI, and sketch/feature selection. All mutations produce immutable document
 * updates and validate the result with {@link validateNukeCadDocument} before
 * committing. User errors are returned as structured results; the store never
 * throws for routine validation failures.
 *
 * @module nuke-cad/browser/document
 */

import {
    NUKE_CAD_SCHEMA_VERSION,
    type NukeCadDocument,
    type BodyDef,
    type SketchDef,
    type FeatureDef,
    type FeatureParams,
    type DatumKind,
    type ValidationIssue,
    validateNukeCadDocument,
    migrateNukeCadDocument
} from '../../common/cad-document';
import { type FeatureResult, type ReferenceResolutionResult } from '../../common/nuke-cad-protocol';
import { type TopologyRef } from '../../common/topology-refs';

/** Listener invoked after any mutation that changes the store state. */
export type DocumentStoreListener = () => void;

/** Result of a document-store mutation. */
export interface DocumentMutationResult<T = void> {
    /** Whether the mutation produced a valid document update. */
    readonly success: boolean;
    /** Human-readable error message when ``success`` is false. */
    readonly error?: string;
    /** Structured validation issues when the candidate document was invalid. */
    readonly issues?: ValidationIssue[];
    /** Optional payload produced by the mutation. */
    readonly value?: T;
}

/** Stable selection state tracked by the document store. */
export interface DocumentSelection {
    /** Id of the selected sketch, if any. */
    readonly selectedSketchId?: string;
    /** Id of the selected feature, if any. */
    readonly selectedFeatureId?: string;
    /** Id of the selected body, if any. */
    readonly selectedBodyId?: string;
}

interface StoreState {
    document?: NukeCadDocument;
    uri?: string;
    dirty: boolean;
    selection: DocumentSelection;
    featureResults: Map<string, FeatureResult>;
    /** Projected construction primitives per sketch from the last document build. */
    projectedPrimitives: Map<string, Record<string, unknown>[]>;
    /** Per-reference resolution status from the last document build. */
    referenceResults: ReferenceResolutionResult[];
}

let idCounter = 0;

function nextId(prefix: string): string {
    return `${prefix}-${++idCounter}`;
}

function emptyDocument(name: string): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name,
        parameters: {},
        datums: [
            { id: 'datum-xy', kind: 'XY', name: 'XY Plane' },
            { id: 'datum-yz', kind: 'YZ', name: 'YZ Plane' },
            { id: 'datum-xz', kind: 'XZ', name: 'XZ Plane' }
        ],
        bodies: [],
        sketches: [],
        features: []
    };
}

function cloneDocument(doc: NukeCadDocument): NukeCadDocument {
    return {
        version: doc.version,
        name: doc.name,
        parameters: { ...doc.parameters },
        datums: doc.datums.map((d) => ({ ...d, reference: d.reference !== undefined ? cloneTopologyRef(d.reference) : undefined })),
        bodies: doc.bodies.map((b) => ({ ...b })),
        sketches: doc.sketches.map((s) => ({
            ...s,
            primitives: s.primitives.map((p) => ({ ...p })),
            constraints: s.constraints.map((c) => ({ ...c })),
            parameters: s.parameters !== undefined ? { ...s.parameters } : undefined,
            dimensions: s.dimensions !== undefined ? s.dimensions.map((d) => ({ ...d })) : undefined,
            externalRefs: s.externalRefs !== undefined ? s.externalRefs.map((r) => cloneTopologyRef(r)) : undefined
        })),
        features: doc.features.map((f) => ({ ...f, params: { ...f.params }, dependsOn: [...f.dependsOn], body: f.body }))
    };
}

function clonePoint3(p: import('../../common/topology-refs').Point3): import('../../common/topology-refs').Point3 {
    return [p[0], p[1], p[2]];
}

function cloneTopologyRef(ref: TopologyRef): TopologyRef {
    const fp = ref.fingerprint;
    const base = {
        featureId: ref.featureId,
        kind: ref.kind
    };
    if (ref.kind === 'edge') {
        const edge = fp as import('../../common/topology-refs').EdgeFingerprint;
        const cloned: import('../../common/topology-refs').EdgeFingerprint = {
            curveType: edge.curveType,
            length: edge.length,
            start: clonePoint3(edge.start),
            end: clonePoint3(edge.end)
        };
        if (edge.center !== undefined) {
            cloned.center = clonePoint3(edge.center);
        }
        return { ...base, fingerprint: cloned };
    }
    const face = fp as import('../../common/topology-refs').FaceFingerprint;
    const cloned: import('../../common/topology-refs').FaceFingerprint = {
        surfaceType: face.surfaceType,
        area: face.area,
        center: clonePoint3(face.center)
    };
    if (face.normal !== undefined) {
        cloned.normal = clonePoint3(face.normal);
    }
    if (face.axis !== undefined) {
        cloned.axis = {
            origin: clonePoint3(face.axis.origin),
            direction: clonePoint3(face.axis.direction)
        };
    }
    if (face.radius !== undefined) {
        cloned.radius = face.radius;
    }
    if (face.minorRadius !== undefined) {
        cloned.minorRadius = face.minorRadius;
    }
    return { ...base, fingerprint: cloned };
}

function formatIssues(issues: ValidationIssue[]): string {
    return issues.map((i) => `${i.path || 'document'}: ${i.message}`).join('; ');
}

function fingerprintsEqual(
    a: import('../../common/topology-refs').FaceFingerprint | import('../../common/topology-refs').EdgeFingerprint,
    b: import('../../common/topology-refs').FaceFingerprint | import('../../common/topology-refs').EdgeFingerprint
): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Framework-free store for the active `.nuke-cad` document.
 *
 * The store is intentionally decoupled from Theia and React so it can be unit
 * tested with vitest and reused by any UI layer.
 */
export class CadDocumentStore {
    private state: StoreState = {
        dirty: false,
        selection: {},
        featureResults: new Map<string, FeatureResult>(),
        projectedPrimitives: new Map<string, Record<string, unknown>[]>(),
        referenceResults: []
    };

    private readonly listeners = new Set<DocumentStoreListener>();

    /** Subscribe to store change events. Returns an unsubscribe function. */
    onChange(listener: DocumentStoreListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emitChange(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }

    /** The active document, if any. */
    get document(): NukeCadDocument | undefined {
        return this.state.document;
    }

    /** Absolute file URI backing the document, when one has been assigned. */
    get uri(): string | undefined {
        return this.state.uri;
    }

    /** Whether the document has unsaved changes. */
    get dirty(): boolean {
        return this.state.dirty;
    }

    /** Current sketch/feature selection. */
    get selection(): DocumentSelection {
        return this.state.selection;
    }

    /** Per-feature results from the last document build. */
    get featureResults(): ReadonlyMap<string, FeatureResult> {
        return this.state.featureResults;
    }

    /** True when a document is loaded and it is not the initial empty state. */
    get hasDocument(): boolean {
        return this.state.document !== undefined;
    }

    /** Serialize the active document to JSON, or undefined when none is active. */
    toJson(): string | undefined {
        if (this.state.document === undefined) {
            return undefined;
        }
        return JSON.stringify(this.state.document, null, 2);
    }

    /**
     * Create a new empty document with the given name.
     *
     * The new document contains the three canonical datum planes (XY, YZ, XZ)
     * and no sketches, bodies, or features. It is not marked dirty.
     */
    createDocument(name: string): DocumentMutationResult {
        const document = emptyDocument(name);
        const validation = validateNukeCadDocument(document);
        if (!validation.valid) {
            return { success: false, error: formatIssues(validation.issues), issues: validation.issues };
        }
        this.state = {
            document,
            uri: undefined,
            dirty: false,
            selection: {},
            featureResults: new Map<string, FeatureResult>(),
            projectedPrimitives: new Map<string, Record<string, unknown>[]>(),
            referenceResults: []
        };
        this.emitChange();
        return { success: true };
    }

    /**
     * Load a parsed `.nuke-cad` JSON object into the store.
     *
     * The object is migrated to the current schema version when needed and then
     * validated. Migration/validation failures are returned as structured
     * errors without changing the active document.
     */
    loadDocument(json: unknown): DocumentMutationResult {
        let document: NukeCadDocument;
        try {
            const migrated = migrateNukeCadDocument(json);
            document = migrated.document;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: message,
                issues: [{ path: 'version', message }]
            };
        }
        const validation = validateNukeCadDocument(document);
        if (!validation.valid) {
            return { success: false, error: formatIssues(validation.issues), issues: validation.issues };
        }
        this.state = {
            document,
            uri: undefined,
            dirty: false,
            selection: {},
            featureResults: new Map<string, FeatureResult>(),
            projectedPrimitives: new Map<string, Record<string, unknown>[]>(),
            referenceResults: []
        };
        this.emitChange();
        return { success: true };
    }

    /**
     * Assign the backing file URI after a save or save-as operation.
     *
     * This does not write the file; callers use Theia's FileService for I/O.
     */
    setUri(uri: string): void {
        this.state = { ...this.state, uri };
        this.emitChange();
    }

    /** Mark the active document as saved (clears the dirty flag). */
    markSaved(): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        this.state = { ...this.state, dirty: false };
        this.emitChange();
        return { success: true };
    }

    /**
     * Add or replace a sketch in the document.
     *
     * Sketch-local parameters are merged into document-level parameters so they
     * can be referenced by later features. For a new sketch, a name collision
     * with an existing document parameter that has a different value is returned
     * as a structured error; an exact-value match is allowed. Updating an
     * existing sketch re-merges its parameters so edits flow back into the
     * document-level parameter table.
     *
     * The stored sketch keeps its geometry, constraints, and dimensions but its
     * local parameter table is cleared after a successful merge.
     */
    upsertSketch(sketchDef: SketchDef): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);

        const index = doc.sketches.findIndex((s) => s.id === sketchDef.id);
        const isUpdate = index >= 0;

        // Merge sketch-local parameters into document parameters.
        // New sketches must not collide with existing document parameters.
        // Updating an existing sketch re-merges its parameters so edits flow
        // back into the document-level parameter table.
        const localParams = sketchDef.parameters ?? {};
        for (const [name, value] of Object.entries(localParams)) {
            const existing = doc.parameters[name];
            if (!isUpdate && existing !== undefined && existing !== value) {
                return {
                    success: false,
                    error: `Parameter '${name}' from sketch '${sketchDef.id}' collides with document parameter (${existing} vs ${value})`
                };
            }
            doc.parameters[name] = value;
        }

        const sketchWithoutLocalParams: SketchDef = {
            ...sketchDef,
            parameters: undefined
        };

        if (isUpdate) {
            doc.sketches[index] = sketchWithoutLocalParams;
        } else {
            doc.sketches.push(sketchWithoutLocalParams);
        }

        return this.commit(doc);
    }

    /**
     * Delete a sketch from the document.
     *
     * Rejects when any feature references the sketch, listing the referencing
     * feature ids in the error.
     */
    deleteSketch(id: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const dependents = doc.features.filter((f) => f.sketchId === id).map((f) => f.id);
        if (dependents.length > 0) {
            return {
                success: false,
                error: `Cannot delete sketch '${id}' because features depend on it: ${dependents.join(', ')}`
            };
        }
        doc.sketches = doc.sketches.filter((s) => s.id !== id);
        return this.commit(doc, { clearSelection: { selectedSketchId: id } });
    }

    /** Add a feature to the end of the feature tree. */
    addFeature(feature: FeatureDef): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        doc.features.push(feature);
        return this.commit(doc, { selectFeature: feature.id });
    }

    /**
     * Update the parameters of an existing feature.
     *
     * The supplied ``params`` are shallow-merged into the existing feature
     * parameters; omitted keys keep their previous values.
     */
    updateFeatureParams(id: string, params: FeatureParams): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const feature = doc.features.find((f) => f.id === id);
        if (feature === undefined) {
            return { success: false, error: `Feature '${id}' not found` };
        }
        feature.params = { ...feature.params, ...(params as Record<string, unknown>) };
        return this.commit(doc, { selectFeature: id });
    }

    /** Rename an existing feature. */
    renameFeature(id: string, name: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const feature = doc.features.find((f) => f.id === id);
        if (feature === undefined) {
            return { success: false, error: `Feature '${id}' not found` };
        }
        feature.name = name;
        return this.commit(doc);
    }

    /** Set the suppressed flag on a feature. */
    setFeatureSuppressed(id: string, suppressed: boolean): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const feature = doc.features.find((f) => f.id === id);
        if (feature === undefined) {
            return { success: false, error: `Feature '${id}' not found` };
        }
        feature.suppressed = suppressed;
        return this.commit(doc);
    }

    /**
     * Delete a feature from the document.
     *
     * Rejects when other features explicitly depend on it, listing the
     * dependent feature ids in the error. Cascading deletion is intentionally
     * avoided in Tier 1 to prevent accidental model damage.
     */
    deleteFeature(id: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const dependents = doc.features.filter((f) => f.dependsOn.includes(id)).map((f) => f.id);
        if (dependents.length > 0) {
            return {
                success: false,
                error: `Cannot delete feature '${id}' because features depend on it: ${dependents.join(', ')}`
            };
        }
        doc.features = doc.features.filter((f) => f.id !== id);
        return this.commit(doc, { clearSelection: { selectedFeatureId: id } });
    }

    /**
     * Set a document-level parameter.
     *
     * The new value must be finite. Validation catches collisions with
     * sketch-local parameters that use the same name.
     */
    setParameter(name: string, value: number): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { success: false, error: `Parameter '${name}' must be a finite number, got ${value}` };
        }
        const doc = cloneDocument(check.value!);
        doc.parameters[name] = value;
        return this.commit(doc);
    }

    /** Remove a document-level parameter. */
    removeParameter(name: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        delete doc.parameters[name];
        return this.commit(doc);
    }

    /**
     * Add a body to the document.
     *
     * Generates a collision-free id. Returns the new body id on success.
     */
    addBody(name: string, label?: string): DocumentMutationResult<string> {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const id = uniqueBodyId(doc);
        const body: BodyDef = { id, name, label };
        doc.bodies.push(body);
        const result = this.commit(doc, { selectBody: id });
        if (!result.success) {
            return { success: false, error: result.error, issues: result.issues };
        }
        return { success: true, value: id };
    }

    /**
     * Rename an existing body.
     */
    renameBody(id: string, name: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const body = doc.bodies.find((b) => b.id === id);
        if (body === undefined) {
            return { success: false, error: `Body '${id}' not found` };
        }
        body.name = name;
        return this.commit(doc);
    }

    /**
     * Set or clear the label of an existing body.
     */
    setBodyLabel(id: string, label?: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const body = doc.bodies.find((b) => b.id === id);
        if (body === undefined) {
            return { success: false, error: `Body '${id}' not found` };
        }
        if (label === undefined) {
            delete body.label;
        } else {
            body.label = label;
        }
        return this.commit(doc);
    }

    /**
     * Remove a body from the document.
     *
     * Rejects when any feature references the body.
     */
    removeBody(id: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const dependents = doc.features.filter((f) => f.body === id).map((f) => f.id);
        if (dependents.length > 0) {
            return {
                success: false,
                error: `Cannot delete body '${id}' because features depend on it: ${dependents.join(', ')}`
            };
        }
        doc.bodies = doc.bodies.filter((b) => b.id !== id);
        return this.commit(doc, { clearSelection: { selectedBodyId: id } });
    }

    /**
     * Add a datum plane to the document.
     *
     * Face datums that reference the same face fingerprint and offset are reused
     * so repeated sketch-on-face operations do not multiply datums. Other datum
     * kinds always create a new datum.
     */
    addDatum(kind: DatumKind, offset?: number, reference?: TopologyRef): DocumentMutationResult<string> {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        if (kind === 'face' && reference === undefined) {
            return { success: false, error: 'Face datum requires a topology reference' };
        }
        const doc = cloneDocument(check.value!);
        if (kind === 'face' && reference !== undefined) {
            const existing = doc.datums.find(
                (d) =>
                    d.kind === 'face' &&
                    d.reference !== undefined &&
                    d.reference.featureId === reference.featureId &&
                    d.reference.kind === reference.kind &&
                    fingerprintsEqual(d.reference.fingerprint, reference.fingerprint) &&
                    (d.offset ?? 0) === (offset ?? 0)
            );
            if (existing !== undefined) {
                return { success: true, value: existing.id };
            }
        }
        const id = createDatumId();
        doc.datums.push({ id, kind, name: `${kind} Datum`, offset, reference });
        const result = this.commit(doc);
        if (!result.success) {
            return { success: false, error: result.error, issues: result.issues };
        }
        return { success: true, value: id };
    }

    /** Set the selected sketch id. */
    selectSketch(id: string | undefined): void {
        this.state = {
            ...this.state,
            selection: { ...this.state.selection, selectedSketchId: id }
        };
        this.emitChange();
    }

    /** Set the selected feature id. */
    selectFeature(id: string | undefined): void {
        this.state = {
            ...this.state,
            selection: { ...this.state.selection, selectedFeatureId: id }
        };
        this.emitChange();
    }

    /** Set the selected body id. */
    selectBody(id: string | undefined): void {
        this.state = {
            ...this.state,
            selection: { ...this.state.selection, selectedBodyId: id }
        };
        this.emitChange();
    }

    /** Clear sketch, feature, and body selection. */
    clearSelection(): void {
        this.state = { ...this.state, selection: {} };
        this.emitChange();
    }

    /**
     * Update per-feature build results from a document rebuild.
     *
     * This is not a user mutation and does not affect the dirty flag.
     */
    setFeatureResults(results: FeatureResult[]): void {
        const map = new Map<string, FeatureResult>();
        for (const result of results) {
            map.set(result.featureId, result);
        }
        this.state = { ...this.state, featureResults: map };
        this.emitChange();
    }

    /**
     * Update projected construction primitives per sketch from a document rebuild.
     *
     * This is not a user mutation and does not affect the dirty flag.
     */
    setProjectedPrimitives(projected: Record<string, Record<string, unknown>[]> | undefined): void {
        const map = new Map<string, Record<string, unknown>[]>();
        if (projected !== undefined) {
            for (const [sketchId, primitives] of Object.entries(projected)) {
                map.set(
                    sketchId,
                    primitives.map((p) => ({ ...p }))
                );
            }
        }
        this.state = { ...this.state, projectedPrimitives: map };
        this.emitChange();
    }

    /** Projected construction primitives per sketch from the last document build. */
    getProjectedPrimitives(): ReadonlyMap<string, Record<string, unknown>[]> {
        return this.state.projectedPrimitives;
    }

    /**
     * Update per-reference resolution status from a document rebuild.
     *
     * This is not a user mutation and does not affect the dirty flag.
     */
    setReferenceResults(results: ReferenceResolutionResult[]): void {
        this.state = { ...this.state, referenceResults: results };
        this.emitChange();
    }

    /** Per-reference resolution status from the last document build. */
    getReferenceResults(): readonly ReferenceResolutionResult[] {
        return this.state.referenceResults;
    }

    /** Add an external reference to a sketch. */
    addExternalRef(sketchId: string, ref: TopologyRef): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const sketch = doc.sketches.find((s) => s.id === sketchId);
        if (sketch === undefined) {
            return { success: false, error: `Sketch '${sketchId}' not found` };
        }
        sketch.externalRefs = [...(sketch.externalRefs ?? []), cloneTopologyRef(ref)];
        return this.commit(doc);
    }

    /** Remove an external reference from a sketch by index. */
    removeExternalRef(sketchId: string, index: number): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const sketch = doc.sketches.find((s) => s.id === sketchId);
        if (sketch === undefined) {
            return { success: false, error: `Sketch '${sketchId}' not found` };
        }
        const refs = sketch.externalRefs ?? [];
        if (index < 0 || index >= refs.length) {
            return { success: false, error: `Invalid external reference index ${index}` };
        }
        sketch.externalRefs = refs.filter((_, i) => i !== index);
        if (sketch.externalRefs.length === 0) {
            delete sketch.externalRefs;
        }
        return this.commit(doc);
    }

    private requireDocument(): DocumentMutationResult<NukeCadDocument> {
        if (this.state.document === undefined) {
            return { success: false, error: 'No active document' };
        }
        return { success: true, value: this.state.document };
    }

    private commit(
        doc: NukeCadDocument,
        options?: {
            clearSelection?: { selectedSketchId?: string; selectedFeatureId?: string; selectedBodyId?: string };
            selectFeature?: string;
            selectBody?: string;
        }
    ): DocumentMutationResult {
        const validation = validateNukeCadDocument(doc);
        if (!validation.valid) {
            return { success: false, error: formatIssues(validation.issues), issues: validation.issues };
        }
        let selection = this.state.selection;
        if (
            options?.clearSelection?.selectedSketchId !== undefined &&
            selection.selectedSketchId === options.clearSelection.selectedSketchId
        ) {
            selection = { ...selection, selectedSketchId: undefined };
        }
        if (
            options?.clearSelection?.selectedFeatureId !== undefined &&
            selection.selectedFeatureId === options.clearSelection.selectedFeatureId
        ) {
            selection = { ...selection, selectedFeatureId: undefined };
        }
        if (options?.clearSelection?.selectedBodyId !== undefined && selection.selectedBodyId === options.clearSelection.selectedBodyId) {
            selection = { ...selection, selectedBodyId: undefined };
        }
        if (options?.selectFeature !== undefined) {
            selection = { ...selection, selectedFeatureId: options.selectFeature };
        }
        if (options?.selectBody !== undefined) {
            selection = { ...selection, selectedBodyId: options.selectBody };
        }
        this.state = { ...this.state, document: doc, dirty: true, selection };
        this.emitChange();
        return { success: true };
    }
}

function uniqueBodyId(doc: NukeCadDocument): string {
    let index = doc.bodies.length + 1;
    let id: string;
    const existing = new Set(doc.bodies.map((b) => b.id));
    do {
        id = `body-${index++}`;
    } while (existing.has(id));
    return id;
}

/**
 * Return a new unique id for a datum plane.
 *
 * The prefix is chosen so the id is stable enough for tests while remaining
 * unique across the application session.
 */
export function createDatumId(): string {
    return nextId('datum');
}

/**
 * Return a new unique id for a sketch.
 *
 * Callers may override the generated id; this helper is provided for
 * convenience in UI code.
 */
export function createSketchId(): string {
    return nextId('sketch');
}

/**
 * Return a new unique id for a feature.
 *
 * Callers may override the generated id; this helper is provided for
 * convenience in UI code.
 */
export function createFeatureId(): string {
    return nextId('feature');
}

/**
 * Return a new unique id for a body.
 *
 * Callers may override the generated id; this helper is provided for
 * convenience in UI code.
 */
export function createBodyId(): string {
    return nextId('body');
}

/**
 * Compute the implicit dependency for a new feature.
 *
 * In v2 each body has its own accumulator. This helper finds the most recent
 * non-suppressed solid-producing feature in the existing tree that targets the
 * same body, or undefined when the body has no prior solid features.
 */
export function computeDependsOn(type: FeatureDef['type'], bodyId: string, features: readonly FeatureDef[]): string | undefined {
    const solidFeatures: FeatureDef['type'][] = [
        'pad',
        'pocket',
        'revolve',
        'groove',
        'fillet',
        'chamfer',
        'draft',
        'shell',
        'booleanFuse',
        'booleanCut',
        'booleanCommon'
    ];
    if (!solidFeatures.includes(type)) {
        return undefined;
    }
    for (let i = features.length - 1; i >= 0; i--) {
        const feature = features[i];
        if (!feature.suppressed && solidFeatures.includes(feature.type) && feature.body === bodyId) {
            return feature.id;
        }
    }
    return undefined;
}
