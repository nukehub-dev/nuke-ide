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
    type SketchDef,
    type FeatureDef,
    type FeatureParams,
    type ValidationIssue,
    validateNukeCadDocument,
    migrateNukeCadDocument
} from '../../common/cad-document';
import { type FeatureResult } from '../../common/nuke-cad-protocol';

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
}

interface StoreState {
    document?: NukeCadDocument;
    uri?: string;
    dirty: boolean;
    selection: DocumentSelection;
    featureResults: Map<string, FeatureResult>;
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
        sketches: [],
        features: []
    };
}

function cloneDocument(doc: NukeCadDocument): NukeCadDocument {
    return {
        version: doc.version,
        name: doc.name,
        parameters: { ...doc.parameters },
        datums: doc.datums.map((d) => ({ ...d })),
        sketches: doc.sketches.map((s) => ({
            ...s,
            primitives: s.primitives.map((p) => ({ ...p })),
            constraints: s.constraints.map((c) => ({ ...c })),
            parameters: s.parameters !== undefined ? { ...s.parameters } : undefined,
            dimensions: s.dimensions !== undefined ? s.dimensions.map((d) => ({ ...d })) : undefined
        })),
        features: doc.features.map((f) => ({ ...f, params: { ...f.params }, dependsOn: [...f.dependsOn] }))
    };
}

function formatIssues(issues: ValidationIssue[]): string {
    return issues.map((i) => `${i.path || 'document'}: ${i.message}`).join('; ');
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
        featureResults: new Map<string, FeatureResult>()
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
     * and no sketches or features. It is not marked dirty.
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
            featureResults: new Map<string, FeatureResult>()
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
            featureResults: new Map<string, FeatureResult>()
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
     * existing sketch re-merges its local parameters so edits flow back into the
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
     * Add a datum plane to the document.
     *
     * Generates a collision-free id, validates the result, and preserves the
     * backing URI and dirty state.
     */
    addDatum(kind: 'XY' | 'YZ' | 'XZ' | 'offset', offset = 0): DocumentMutationResult<string> {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const existing = doc.datums.find((d) => d.kind === kind && d.offset === offset);
        if (existing !== undefined) {
            return { success: true, value: existing.id };
        }
        const usedNames = new Set(doc.datums.map((d) => d.name));
        let name = `${kind} Offset ${offset}`;
        let suffix = 1;
        while (usedNames.has(name)) {
            name = `${kind} Offset ${offset} (${suffix++})`;
        }
        const id = nextId('datum');
        doc.datums.push({ id, kind, name, offset });
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

    /** Clear both sketch and feature selection. */
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

    private requireDocument(): DocumentMutationResult<NukeCadDocument> {
        if (this.state.document === undefined) {
            return { success: false, error: 'No active document' };
        }
        return { success: true, value: this.state.document };
    }

    private commit(
        doc: NukeCadDocument,
        options?: { clearSelection?: { selectedSketchId?: string; selectedFeatureId?: string }; selectFeature?: string }
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
        if (options?.selectFeature !== undefined) {
            selection = { ...selection, selectedFeatureId: options.selectFeature };
        }
        this.state = { ...this.state, document: doc, dirty: true, selection };
        this.emitChange();
        return { success: true };
    }
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
 * Compute the implicit dependency for a new feature.
 *
 * In Tier 1 the backend fuses additive features into and cuts subtractive
 * features from a single accumulated body. This helper finds the most recent
 * non-suppressed solid-producing feature in the existing tree and returns its
 * id, or undefined for the first additive feature.
 *
 * Subtractive features (pocket, groove) should always depend on a previous
 * solid-producing feature; callers surface an error when none exists.
 */
export function computeDependsOn(type: FeatureDef['type'], features: readonly FeatureDef[]): string | undefined {
    const solidProducers: FeatureDef['type'][] = ['pad', 'pocket', 'revolve', 'groove'];
    if (!solidProducers.includes(type)) {
        return undefined;
    }
    for (let i = features.length - 1; i >= 0; i--) {
        const feature = features[i];
        if (!feature.suppressed && solidProducers.includes(feature.type)) {
            return feature.id;
        }
    }
    return undefined;
}
