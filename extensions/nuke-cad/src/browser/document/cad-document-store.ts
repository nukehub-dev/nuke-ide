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
    type NukeCadDocument,
    type BodyDef,
    type SketchDef,
    type FeatureDef,
    type FeatureParams,
    type DatumKind,
    type DatumPlane,
    type CurvePoint,
    type ValidationIssue,
    type CurveDef,
    type CurveSource,
    type DocumentUnits,
    type ParametricCurveSource,
    NUKE_CAD_SCHEMA_VERSION,
    validateNukeCadDocument,
    migrateNukeCadDocument
} from '../../common/cad-document';
import { applyDocumentTemplate, createEmptyNukeCadDocument } from '../../common/document-templates';
import {
    convertQuantity,
    evaluateExpression,
    evaluateQuantity,
    isDimensionless,
    parseExpression,
    sampleFourier,
    sampleParametric,
    type Expr,
    type QuantityScope
} from '../../common/expression';
import { type FeatureResult, type ReferenceResolutionResult } from '../../common/nuke-cad-protocol';
import { type TopologyRef, type FaceFingerprint, type EdgeFingerprint, validateTopologyRef } from '../../common/topology-refs';
import { FeatureGraph } from '../../common/feature-graph';

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
    /** Id of the selected curve, if any. */
    readonly selectedCurveId?: string;
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

function cloneCurve(curve: CurveDef): CurveDef {
    return {
        id: curve.id,
        name: curve.name,
        source: cloneCurveSource(curve.source),
        samples: curve.samples.map((p) => [p[0], p[1], p[2]])
    };
}

function cloneCurveSource(source: CurveSource): CurveSource {
    if (source.kind === 'points') {
        return { kind: 'points' };
    }
    if (source.kind === 'parametric') {
        return { ...source };
    }
    return {
        kind: 'fourier',
        nfp: source.nfp,
        order: source.order,
        cosX: [...source.cosX],
        sinX: [...source.sinX],
        cosY: [...source.cosY],
        sinY: [...source.sinY],
        cosZ: [...source.cosZ],
        sinZ: [...source.sinZ],
        sampleCount: source.sampleCount
    };
}

function cloneDocument(doc: NukeCadDocument): NukeCadDocument {
    return {
        version: doc.version,
        name: doc.name,
        units: doc.units,
        parameters: { ...doc.parameters },
        datums: doc.datums.map((d) => ({
            ...d,
            reference: d.reference !== undefined ? cloneTopologyRef(d.reference) : undefined,
            points: d.points !== undefined ? d.points.map((p) => [p[0], p[1], p[2]] as CurvePoint) : undefined,
            faces: d.faces !== undefined ? d.faces.map((f) => cloneTopologyRef(f)) : undefined
        })),
        bodies: doc.bodies.map((b) => ({ ...b })),
        sketches: doc.sketches.map((s) => ({
            ...s,
            primitives: s.primitives.map((p) => ({ ...p })),
            constraints: s.constraints.map((c) => ({ ...c })),
            parameters: s.parameters !== undefined ? { ...s.parameters } : undefined,
            dimensions: s.dimensions !== undefined ? s.dimensions.map((d) => ({ ...d })) : undefined,
            externalRefs: s.externalRefs !== undefined ? s.externalRefs.map((r) => cloneTopologyRef(r)) : undefined
        })),
        features: doc.features.map((f) => ({ ...f, params: { ...f.params }, dependsOn: [...f.dependsOn], body: f.body })),
        curves: doc.curves.map((c) => cloneCurve(c))
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

/** Relative tolerance matching the unit-less sampler's endpoint-closure rule. */
const PARAMETRIC_CLOSURE_TOLERANCE = 1e-9;

function parametricEndpointsMeet(points: readonly (readonly [number, number, number])[]): boolean {
    let extent = 0;
    for (const point of points) {
        for (const coordinate of point) {
            extent = Math.max(extent, Math.abs(coordinate));
        }
    }
    const first = points[0];
    const last = points[points.length - 1];
    const gap = Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
    return gap <= PARAMETRIC_CLOSURE_TOLERANCE * Math.max(1, extent);
}

/**
 * True when the expression holds a unit literal (``10mm``); the unit-less
 * evaluator rejects those, so only such coordinates take the quantity path.
 */
function containsQuantityNode(ast: Expr): boolean {
    switch (ast.type) {
        case 'quantity':
            return true;
        case 'unary':
            return containsQuantityNode(ast.operand);
        case 'binary':
            return containsQuantityNode(ast.left) || containsQuantityNode(ast.right);
        case 'call':
            return ast.args.some(containsQuantityNode);
        default:
            return false;
    }
}

/**
 * Sample a parametric source into the document's declared length unit.
 *
 * Coordinates holding unit literals are evaluated with the quantity scope
 * (document parameters and ``t`` are dimensionless) and expressed in
 * ``units``: dimensionless results are already in doc units, quantities
 * convert (``10mm`` to 10 in a ``mm`` document, ``1cm`` to 10). Dimension
 * mismatches (seconds in ``x(t)``) throw and surface through the caller's
 * error channel. Unit-free coordinates (``cos(t)``, ``t``) keep the exact
 * legacy evaluation so existing curves survive a unit declaration.
 */
export function sampleParametricWithUnits(
    source: ParametricCurveSource,
    parameters: Record<string, number>,
    units: DocumentUnits
): [number, number, number][] {
    const asts = [source.x, source.y, source.z].map((expr) => {
        const parsed = parseExpression(expr);
        if (!parsed.ok) {
            throw new Error(parsed.error);
        }
        return parsed.ast;
    });
    const labels = ['x(t)', 'y(t)', 'z(t)'];
    const count = Math.max(2, Math.floor(source.sampleCount));
    const points: [number, number, number][] = [];
    for (let i = 0; i < count; i++) {
        const t = source.tStart + ((source.tEnd - source.tStart) * i) / (count - 1);
        const scope: QuantityScope = { ...parameters, t };
        const coords = asts.map((ast, index) => {
            if (!containsQuantityNode(ast)) {
                return evaluateExpression(ast, { ...parameters, t });
            }
            const quantity = evaluateQuantity(ast, scope);
            if (isDimensionless(quantity.unit)) {
                return quantity.value;
            }
            return convertQuantity(quantity, units, labels[index]);
        });
        points.push([coords[0], coords[1], coords[2]]);
    }
    if (parametricEndpointsMeet(points)) {
        points.push([points[0][0], points[0][1], points[0][2]]);
    }
    return points;
}

function buildCurveSamples(
    source: CurveSource,
    parameters: Record<string, number>,
    units?: DocumentUnits
): { samples: [number, number, number][]; error?: string } {
    try {
        if (source.kind === 'points') {
            return { samples: [] };
        }
        if (source.kind === 'parametric') {
            // Unitless documents keep the legacy sampler verbatim (unit syntax
            // rejected by its guard); declared units coerce per coordinate.
            const samples =
                units === undefined
                    ? (sampleParametric(source, parameters) as [number, number, number][])
                    : sampleParametricWithUnits(source, parameters, units);
            return { samples };
        }
        return { samples: sampleFourier(source) as [number, number, number][] };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { samples: [], error: message };
    }
}

function curveNameInUse(doc: NukeCadDocument, name: string, excludeId?: string): boolean {
    return doc.curves.some((c) => c.name === name && c.id !== excludeId);
}

function getPatternSourceIds(feature: FeatureDef): string[] {
    const params = feature.params as Record<string, unknown>;
    const ids: string[] = [];
    const source = params.source;
    if (typeof source === 'string' && source.length > 0) {
        ids.push(source);
    }
    // multiTransform names its two pattern/mirror inputs as `first`/`second`.
    for (const key of ['first', 'second'] as const) {
        const peer = params[key];
        if (typeof peer === 'string' && peer.length > 0 && !ids.includes(peer)) {
            ids.push(peer);
        }
    }
    return ids;
}

/**
 * Loft section sketch ids (`params.sectionSketchIds`), mirroring the backend's
 * `_feature_sketch_ids`: a feature consumes a sketch through `sketchId` or
 * through a loft's ordered section list.
 */
function getSectionSketchIds(feature: FeatureDef): string[] {
    const sectionSketchIds = (feature.params as Record<string, unknown>).sectionSketchIds;
    if (!Array.isArray(sectionSketchIds)) {
        return [];
    }
    return sectionSketchIds.filter((sid): sid is string => typeof sid === 'string' && sid.length > 0);
}

function featureConsumesSketch(feature: FeatureDef, sketchId: string): boolean {
    return feature.sketchId === sketchId || getSectionSketchIds(feature).includes(sketchId);
}

function collectDependentFeatureIds(doc: NukeCadDocument, id: string): string[] {
    const dependents: string[] = [];
    for (const feature of doc.features) {
        if (feature.dependsOn.includes(id) || getPatternSourceIds(feature).includes(id)) {
            dependents.push(feature.id);
        }
    }
    return dependents;
}

interface TopologyRefUpdateResult {
    success: boolean;
    error?: string;
}

function setTopologyRef(ref: TopologyRef, fingerprint: FaceFingerprint | EdgeFingerprint): TopologyRef {
    return { featureId: ref.featureId, kind: ref.kind, fingerprint: cloneTopologyRef({ ...ref, fingerprint }).fingerprint };
}

function updateTopologyRefByPath(
    doc: NukeCadDocument,
    path: string,
    fingerprint: FaceFingerprint | EdgeFingerprint
): TopologyRefUpdateResult {
    const datumMatch = path.match(/^datum\.([^.]+)\.reference$/);
    if (datumMatch !== null) {
        const datumId = datumMatch[1];
        const datum = doc.datums.find((d) => d.id === datumId);
        if (datum === undefined) {
            return { success: false, error: `Unknown datum '${datumId}'` };
        }
        if (datum.reference === undefined) {
            return { success: false, error: `Datum '${datumId}' has no topology reference` };
        }
        const updated = setTopologyRef(datum.reference, fingerprint);
        if (!validateTopologyRef(updated).valid) {
            return { success: false, error: `Invalid fingerprint for ${path}` };
        }
        datum.reference = updated;
        return { success: true };
    }

    const sketchExternalMatch = path.match(/^sketch\.([^.]+)\.externalRefs\[(\d+)\]$/);
    if (sketchExternalMatch !== null) {
        const sketchId = sketchExternalMatch[1];
        const index = Number(sketchExternalMatch[2]);
        const sketch = doc.sketches.find((s) => s.id === sketchId);
        if (sketch === undefined) {
            return { success: false, error: `Unknown sketch '${sketchId}'` };
        }
        const refs = sketch.externalRefs ?? [];
        if (index < 0 || index >= refs.length) {
            return { success: false, error: `Invalid external reference index ${index} on sketch '${sketchId}'` };
        }
        const updated = setTopologyRef(refs[index], fingerprint);
        if (!validateTopologyRef(updated).valid) {
            return { success: false, error: `Invalid fingerprint for ${path}` };
        }
        refs[index] = updated;
        sketch.externalRefs = refs;
        return { success: true };
    }

    const featureArrayMatch = path.match(/^feature\.([^.]+)\.params\.(edges|faces)\[(\d+)\]$/);
    if (featureArrayMatch !== null) {
        const featureId = featureArrayMatch[1];
        const arrayName = featureArrayMatch[2] as 'edges' | 'faces';
        const index = Number(featureArrayMatch[3]);
        const feature = doc.features.find((f) => f.id === featureId);
        if (feature === undefined) {
            return { success: false, error: `Unknown feature '${featureId}'` };
        }
        const params = feature.params as Record<string, unknown>;
        const refs = params[arrayName] as TopologyRef[] | undefined;
        if (!Array.isArray(refs) || index < 0 || index >= refs.length) {
            return { success: false, error: `Invalid ${arrayName}[${index}] on feature '${featureId}'` };
        }
        const updated = setTopologyRef(refs[index], fingerprint);
        if (!validateTopologyRef(updated).valid) {
            return { success: false, error: `Invalid fingerprint for ${path}` };
        }
        // Copy-on-write: the cloned feature's params share array values with the
        // live document, so replacing the element in place would corrupt the
        // live document if the surrounding commit validation fails.
        params[arrayName] = refs.map((ref, i) => (i === index ? updated : ref));
        return { success: true };
    }

    const featureFaceMatch = path.match(/^feature\.([^.]+)\.params\.(face|upToFace)$/);
    if (featureFaceMatch !== null) {
        const featureId = featureFaceMatch[1];
        const key = featureFaceMatch[2];
        const feature = doc.features.find((f) => f.id === featureId);
        if (feature === undefined) {
            return { success: false, error: `Unknown feature '${featureId}'` };
        }
        const params = feature.params as Record<string, unknown>;
        const existing = params[key] as TopologyRef | undefined;
        if (existing === undefined) {
            return { success: false, error: `Feature '${featureId}' has no ${key} reference` };
        }
        const updated = setTopologyRef(existing, fingerprint);
        if (!validateTopologyRef(updated).valid) {
            return { success: false, error: `Invalid fingerprint for ${path}` };
        }
        params[key] = updated;
        return { success: true };
    }

    return { success: false, error: `Unsupported or malformed reference path '${path}'` };
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
     * and no sketches, bodies, or features. It is not marked dirty. When
     * ``templateId`` is supplied the matching built-in template's parameters are
     * merged over the empty document.
     */
    createDocument(name: string, templateId?: string): DocumentMutationResult {
        const document = applyDocumentTemplate(createEmptyNukeCadDocument(name), templateId ?? 'empty');
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
        const dependents = doc.features.filter((f) => featureConsumesSketch(f, id)).map((f) => f.id);
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
        if (typeof name !== 'string' || name.length === 0) {
            return { success: false, error: 'Feature name must be a non-empty string' };
        }
        const doc = cloneDocument(check.value!);
        const feature = doc.features.find((f) => f.id === id);
        if (feature === undefined) {
            return { success: false, error: `Feature '${id}' not found` };
        }
        if (doc.features.some((f) => f.id !== id && f.name === name)) {
            return { success: false, error: `Feature name '${name}' is already in use` };
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
     * With the default ``error`` policy, deletion is rejected when other
     * features explicitly depend on the feature or when a pattern/mirror
     * feature names it as a ``source``.
     *
     * With the ``cascade`` policy, the feature plus its transitive
     * dependents (``dependsOn`` closure and ``source`` references) are
     * removed.
     */
    deleteFeature(id: string, policy: 'error' | 'cascade' = 'error'): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const directDependents = collectDependentFeatureIds(doc, id);
        if (policy === 'error' && directDependents.length > 0) {
            return {
                success: false,
                error: `Cannot delete feature '${id}' because features depend on it: ${directDependents.join(', ')}`
            };
        }
        const removal = new Set<string>([id]);
        if (policy === 'cascade') {
            let changed = true;
            while (changed) {
                changed = false;
                for (const feature of doc.features) {
                    if (removal.has(feature.id)) {
                        continue;
                    }
                    if (
                        feature.dependsOn.some((dep) => removal.has(dep)) ||
                        getPatternSourceIds(feature).some((source) => removal.has(source))
                    ) {
                        removal.add(feature.id);
                        changed = true;
                    }
                }
            }
        }
        doc.features = doc.features.filter((f) => !removal.has(f.id));
        return this.commit(doc, { clearSelection: { selectedFeatureId: id } });
    }

    /**
     * Reorder the feature list.
     *
     * The supplied ids must be a permutation of the current feature ids.
     * Reordering is rejected when any feature's explicit ``dependsOn`` entries
     * or a pattern/mirror feature's implied ``source`` dependency would appear
     * after it in the new order.
     */
    reorderFeatures(orderedIds: string[]): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const currentIds = new Set(doc.features.map((f) => f.id));
        if (orderedIds.length !== currentIds.size || orderedIds.some((id) => !currentIds.has(id))) {
            return { success: false, error: 'Reordered ids must be a permutation of the current feature ids' };
        }
        const position = new Map<string, number>();
        for (let i = 0; i < orderedIds.length; i++) {
            position.set(orderedIds[i], i);
        }
        const violations: string[] = [];
        for (const id of orderedIds) {
            const feature = doc.features.find((f) => f.id === id)!;
            const dependencies = [...feature.dependsOn];
            for (const source of getPatternSourceIds(feature)) {
                if (!dependencies.includes(source)) {
                    dependencies.push(source);
                }
            }
            for (const dep of dependencies) {
                if ((position.get(dep) ?? -1) > (position.get(id) ?? -1)) {
                    violations.push(`${id} depends on ${dep}`);
                }
            }
        }
        if (violations.length > 0) {
            return {
                success: false,
                error: `Cannot reorder: dependencies must precede their dependents (${violations.join('; ')})`
            };
        }
        const featureMap = new Map(doc.features.map((f) => [f.id, f]));
        doc.features = orderedIds.map((id) => featureMap.get(id)!);
        return this.commit(doc);
    }

    /**
     * Replace the fingerprint of a topology reference identified by its
     * document path.
     *
     * Supported paths:
     *   - ``datum.<id>.reference``
     *   - ``sketch.<id>.externalRefs[<i>]``
     *   - ``feature.<id>.params.edges[<i>]``
     *   - ``feature.<id>.params.faces[<i>]``
     *   - ``feature.<id>.params.face``
     *   - ``feature.<id>.params.upToFace``
     *
     * The replacement fingerprint is validated before the document is updated.
     */
    replaceTopologyRef(path: string, fingerprint: FaceFingerprint | EdgeFingerprint): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        const update = updateTopologyRefByPath(doc, path, fingerprint);
        if (!update.success) {
            return { success: false, error: update.error };
        }
        return this.commit(doc);
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
     * Set the document's declared length unit (`mm`/`cm`/`m`; blank clears back
     * to legacy unitless).
     *
     * Tagging only: existing numbers (parameters, curve samples, sketch
     * coordinates) are never rescaled or rewritten. Declaring units on a
     * unitless document only affects future inputs (curve-expression coercion
     * and dimension display read `document.units` at entry time).
     */
    setUnits(units: DocumentUnits | undefined): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        if (units !== undefined && units !== 'mm' && units !== 'cm' && units !== 'm') {
            return { success: false, error: `Unknown document units '${units}' (expected 'mm', 'cm', 'm' or blank)` };
        }
        if ((check.value!.units ?? undefined) === units) {
            return { success: true };
        }
        const doc = cloneDocument(check.value!);
        if (units === undefined) {
            delete doc.units;
        } else {
            doc.units = units;
        }
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
        if (typeof name !== 'string' || name.length === 0) {
            return { success: false, error: 'Body name must be a non-empty string' };
        }
        const doc = cloneDocument(check.value!);
        const body = doc.bodies.find((b) => b.id === id);
        if (body === undefined) {
            return { success: false, error: `Body '${id}' not found` };
        }
        if (doc.bodies.some((b) => b.id !== id && b.name === name)) {
            return { success: false, error: `Body name '${name}' is already in use` };
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
     * Add a 3D curve to the document.
     *
     * For ``points`` sources the supplied samples are used directly. For
     * ``parametric`` and ``fourier`` sources the store resamples the source on
     * the current document parameters.
     */
    addCurve(def: CurveDef): DocumentMutationResult<string> {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        if (typeof def.name !== 'string' || def.name.length === 0) {
            return { success: false, error: 'Curve name must be a non-empty string' };
        }
        const doc = cloneDocument(check.value!);
        if (curveNameInUse(doc, def.name)) {
            return { success: false, error: `Curve name '${def.name}' is already in use` };
        }
        const id = typeof def.id === 'string' && def.id.length > 0 && !doc.curves.some((c) => c.id === def.id) ? def.id : createCurveId();
        let samples: [number, number, number][];
        if (def.source.kind === 'points') {
            samples = def.samples.map((p) => [p[0], p[1], p[2]]);
        } else {
            const result = buildCurveSamples(def.source, doc.parameters, doc.units);
            if (result.error !== undefined) {
                return { success: false, error: result.error };
            }
            samples = result.samples;
        }
        if (samples.length < 4) {
            return { success: false, error: `Curve '${def.name}' must have at least 4 samples` };
        }
        doc.curves = [...doc.curves, { ...def, id, samples }];
        const commitResult = this.commit(doc, { selectCurve: id });
        if (!commitResult.success) {
            return { success: false, error: commitResult.error, issues: commitResult.issues };
        }
        return { success: true, value: id };
    }

    /**
     * Update an existing curve's source and resample it.
     *
     * The curve id is preserved even when the supplied definition carries a
     * different id.
     */
    updateCurve(id: string, def: CurveDef): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        if (typeof def.name !== 'string' || def.name.length === 0) {
            return { success: false, error: 'Curve name must be a non-empty string' };
        }
        const doc = cloneDocument(check.value!);
        const index = doc.curves.findIndex((c) => c.id === id);
        if (index < 0) {
            return { success: false, error: `Curve '${id}' not found` };
        }
        if (curveNameInUse(doc, def.name, id)) {
            return { success: false, error: `Curve name '${def.name}' is already in use` };
        }
        let samples: [number, number, number][];
        if (def.source.kind === 'points') {
            samples = def.samples.map((p) => [p[0], p[1], p[2]]);
        } else {
            const result = buildCurveSamples(def.source, doc.parameters, doc.units);
            if (result.error !== undefined) {
                return { success: false, error: result.error };
            }
            samples = result.samples;
        }
        if (samples.length < 4) {
            return { success: false, error: `Curve '${def.name}' must have at least 4 samples` };
        }
        doc.curves = doc.curves.map((c, i) => (i === index ? { ...def, id, samples } : c));
        return this.commit(doc, { selectCurve: id });
    }

    /** Rename an existing curve. */
    renameCurve(id: string, name: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        if (typeof name !== 'string' || name.length === 0) {
            return { success: false, error: 'Curve name must be a non-empty string' };
        }
        const doc = cloneDocument(check.value!);
        if (!doc.curves.some((c) => c.id === id)) {
            return { success: false, error: `Curve '${id}' not found` };
        }
        if (curveNameInUse(doc, name, id)) {
            return { success: false, error: `Curve name '${name}' is already in use` };
        }
        doc.curves = doc.curves.map((c) => (c.id === id ? { ...c, name } : c));
        return this.commit(doc);
    }

    /** Delete a curve from the document. */
    deleteCurve(id: string): DocumentMutationResult {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        const doc = cloneDocument(check.value!);
        if (!doc.curves.some((c) => c.id === id)) {
            return { success: false, error: `Curve '${id}' not found` };
        }
        doc.curves = doc.curves.filter((c) => c.id !== id);
        return this.commit(doc, { clearSelection: { selectedCurveId: id } });
    }

    /** Set the selected curve id. */
    selectCurve(id: string | undefined): void {
        this.state = {
            ...this.state,
            selection: { ...this.state.selection, selectedCurveId: id }
        };
        this.emitChange();
    }

    /**
     * Add a datum plane to the document.
     *
     * Face datums that reference the same face fingerprint and offset are reused
     * so repeated sketch-on-face operations do not multiply datums. Other datum
     * kinds always create a new datum.
     *
     * New-kind datums carry their validated payload in ``extra``: `threePoint`
     * needs exactly 3 points, `midplane` exactly 2 faces, `line2Point` exactly
     * 2 points. Only presence is checked here; deep validation (collinearity,
     * distinctness, planarity) stays with commit-time schema validation.
     */
    addDatum(
        kind: DatumKind,
        offset?: number,
        reference?: TopologyRef,
        extra?: { points?: readonly CurvePoint[]; faces?: TopologyRef[] }
    ): DocumentMutationResult<string> {
        const check = this.requireDocument();
        if (!check.success) {
            return { success: false, error: check.error, issues: check.issues };
        }
        if (kind === 'face' && reference === undefined) {
            return { success: false, error: 'Face datum requires a topology reference' };
        }
        if (kind === 'threePoint' && (extra?.points === undefined || extra.points.length !== 3)) {
            return { success: false, error: 'threePoint datum requires exactly 3 points' };
        }
        if (kind === 'midplane' && (extra?.faces === undefined || extra.faces.length !== 2)) {
            return { success: false, error: 'midplane datum requires exactly 2 face references' };
        }
        if (kind === 'line2Point' && (extra?.points === undefined || extra.points.length !== 2)) {
            return { success: false, error: 'line2Point datum requires exactly 2 points' };
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
        doc.datums.push({
            id,
            kind,
            name: `${kind} Datum`,
            offset,
            reference,
            ...(extra?.points !== undefined ? { points: extra.points.map((p) => [p[0], p[1], p[2]] as CurvePoint) } : {}),
            ...(extra?.faces !== undefined ? { faces: extra.faces.map((f) => cloneTopologyRef(f)) } : {})
        });
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
            clearSelection?: { selectedSketchId?: string; selectedFeatureId?: string; selectedBodyId?: string; selectedCurveId?: string };
            selectFeature?: string;
            selectBody?: string;
            selectCurve?: string;
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
        if (
            options?.clearSelection?.selectedCurveId !== undefined &&
            selection.selectedCurveId === options.clearSelection.selectedCurveId
        ) {
            selection = { ...selection, selectedCurveId: undefined };
        }
        if (options?.selectFeature !== undefined) {
            selection = { ...selection, selectedFeatureId: options.selectFeature };
        }
        if (options?.selectBody !== undefined) {
            selection = { ...selection, selectedBodyId: options.selectBody };
        }
        if (options?.selectCurve !== undefined) {
            selection = { ...selection, selectedCurveId: options.selectCurve };
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
 * Return a new unique id for a curve.
 *
 * Callers may override the generated id; this helper is provided for
 * convenience in UI code.
 */
export function createCurveId(): string {
    return nextId('curve');
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
        'sweep',
        'pipe',
        'loft',
        'helicalSweep',
        'fillet',
        'chamfer',
        'draft',
        'shell',
        'mirror',
        'linearPattern',
        'circularPattern',
        'hole',
        'primitive',
        'multiTransform',
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

// *****************************************************************************
// P2 result-cache orchestration (TS side).
//
// Two self-consistent key systems, never compared across the language
// boundary (their number grammars differ): this region's keys back the
// in-session memory cache only, while ``python/doc_cache.py`` keys the zip
// sidecar. This region owns the TS-side pure logic: content-key computation
// for the open fast path, dirty-plan computation for partial rebuilds, the
// untitled memory-backed cache, and the rebuild lifecycle tracker. The
// widget (``cad-viewport-widget.tsx``) orchestrates these against the
// ``buildFeaturesPartial`` RPC; it never touches blobs.
// *****************************************************************************

/**
 * Builder-semantics version baked into every content key.
 *
 * MUST match ``BUILDER_VERSION`` in ``python/doc_cache.py`` (C1): any change
 * to builder semantics — or to the canonicalization below — bumps both, which
 * loudly invalidates every stored key (hash mismatch → full rebuild).
 */
export const RESULT_CACHE_BUILDER_VERSION = 1;

/** Version input used when the OCP version is not known (pure key checks). */
export const RESULT_CACHE_OCP_UNKNOWN = 'unknown';

/** Versions folded into every content key (brief §2: key = SHA over inputs + versions). */
export interface ResultCacheVersions {
    readonly builderVersion: number;
    readonly ocpVersion: string;
}

/**
 * Format a finite number for canonical JSON.
 *
 * Self-consistent by design (see the key-system split below): these keys
 * back the in-session memory cache only and are never compared against the
 * Python sidecar keys, so no cross-language grammar audit is required —
 * stability across sessions of the same frontend is what matters.
 * - non-finite (NaN/Infinity) throws — such values never enter a key;
 * - ``-0`` normalizes to ``0.0``;
 * - integral values with ``abs < 1e21`` serialize as ``<int>.0`` regardless of
 *   JSON int/float origin (Python MUST normalize ints the same way, since TS
 *   cannot distinguish ``10`` from ``10.0`` after parsing);
 * - everything else serializes in exponential form with exactly 17 significant
 *   digits (``toExponential(16)``, injective over doubles), mantissa trailing
 *   zeros stripped, exponent sign always present with no leading zeros
 *   (``2.5``, ``5e-1``, ``1e+21`` — the exponent is omitted when zero).
 *   Python mirror: ``format(v, '.16e')`` + the same trims.
 */
export function formatCanonicalNumber(value: number): string {
    if (!Number.isFinite(value)) {
        throw new Error(`Cannot canonicalize non-finite number ${value}`);
    }
    if (value === 0) {
        return '0.0';
    }
    if (Number.isInteger(value) && Math.abs(value) < 1e21) {
        return `${value}.0`;
    }
    const text = value.toExponential(16);
    const match = /^([+-]?)(\d)\.(\d+)e([+-]?\d+)$/.exec(text);
    if (match === null) {
        throw new Error(`Cannot canonicalize number ${value}`);
    }
    const [, sign, digit, fraction, exponent] = match;
    const trimmedFraction = fraction.replace(/0+$/, '');
    const mantissa = trimmedFraction.length > 0 ? `${sign}${digit}.${trimmedFraction}` : `${sign}${digit}`;
    const exponentNumber = parseInt(exponent, 10);
    if (exponentNumber === 0) {
        return mantissa;
    }
    return `${mantissa}e${exponentNumber < 0 ? '-' : '+'}${Math.abs(exponentNumber)}`;
}

/**
 * Deterministic JSON serialization for content keys.
 *
 * Grammar: objects emit keys sorted by UTF-16 code-unit order with no
 * whitespace; arrays keep document order; strings use ``JSON.stringify``
 * quoting; booleans/null are literal; numbers use
 * {@link formatCanonicalNumber}; ``undefined`` object properties are omitted
 * and ``undefined`` array items become ``null`` (JSON semantics).
 */
export function canonicalJson(value: unknown): string {
    if (value === null) {
        return 'null';
    }
    if (value === undefined) {
        throw new Error('Cannot canonicalize undefined');
    }
    if (typeof value === 'number') {
        return formatCanonicalNumber(value);
    }
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    }
    throw new Error(`Cannot canonicalize value of type ${typeof value}`);
}

const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function sha256Rotr(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits));
}

/**
 * SHA-256 hex digest over the UTF-8 encoding of ``text``.
 *
 * Pure TypeScript (no Node/browser crypto dependency) so the open fast path
 * runs identically in every host; byte-identical to
 * ``hashlib.sha256(text.encode('utf-8')).hexdigest()`` (cross-checked in
 * tests against ``node:crypto``).
 */
export function sha256Hex(text: string): string {
    const data = new TextEncoder().encode(text);
    let paddedLength = data.length + 1 + 8;
    while (paddedLength % 64 !== 0) {
        paddedLength++;
    }
    const padded = new Uint8Array(paddedLength);
    padded.set(data);
    padded[data.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(data.length / 0x20000000));
    view.setUint32(paddedLength - 4, (data.length << 3) >>> 0);

    const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const schedule = new Array<number>(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let t = 0; t < 16; t++) {
            schedule[t] = view.getUint32(offset + t * 4);
        }
        for (let t = 16; t < 64; t++) {
            const s0 = sha256Rotr(schedule[t - 15], 7) ^ sha256Rotr(schedule[t - 15], 18) ^ (schedule[t - 15] >>> 3);
            const s1 = sha256Rotr(schedule[t - 2], 17) ^ sha256Rotr(schedule[t - 2], 19) ^ (schedule[t - 2] >>> 10);
            schedule[t] = (schedule[t - 16] + s0 + schedule[t - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, h] = state;
        for (let t = 0; t < 64; t++) {
            const s1 = sha256Rotr(e, 6) ^ sha256Rotr(e, 11) ^ sha256Rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + s1 + ch + SHA256_K[t] + schedule[t]) | 0;
            const s0 = sha256Rotr(a, 2) ^ sha256Rotr(a, 13) ^ sha256Rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + maj) | 0;
            h = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        state[0] = (state[0] + a) | 0;
        state[1] = (state[1] + b) | 0;
        state[2] = (state[2] + c) | 0;
        state[3] = (state[3] + d) | 0;
        state[4] = (state[4] + e) | 0;
        state[5] = (state[5] + f) | 0;
        state[6] = (state[6] + g) | 0;
        state[7] = (state[7] + h) | 0;
    }
    return state.map((word) => `00000000${(word >>> 0).toString(16)}`.slice(-8)).join('');
}

/** Node id prefixes for the key table (sketches and curves are cache nodes too). */
export type ResultCacheNodeKind = 'sketch' | 'curve' | 'feature';

function cacheNodeId(kind: ResultCacheNodeKind, id: string): string {
    return `${kind}:${id}`;
}

/** Per-node content keys for a document, keyed by ``<kind>:<id>``. */
export interface ResultCacheKeyTable {
    readonly keys: Record<string, string>;
}

function sortByStringId(items: readonly Record<string, unknown>[]): Record<string, unknown>[] {
    return [...items].sort((a, b) => {
        const aId = typeof a.id === 'string' ? a.id : '';
        const bId = typeof b.id === 'string' ? b.id : '';
        return aId < bId ? -1 : aId > bId ? 1 : 0;
    });
}

function datumSnapshot(doc: NukeCadDocument, datumId: string): Record<string, unknown> {
    const datum: DatumPlane | undefined = doc.datums.find((d) => d.id === datumId);
    if (datum === undefined) {
        throw new Error(`Cannot key sketch: unknown datum '${datumId}'`);
    }
    return {
        kind: datum.kind,
        offset: datum.offset,
        reference: datum.reference,
        points: datum.points,
        faces: datum.faces
    };
}

/**
 * Compute per-node content keys for a document, purely from the doc JSON (no
 * OCP, no backend call).
 *
 * Recipe (brief §2, node granularity brief §4): ``sketch:<id>`` keys hash the
 * sketch primitive snapshot + datum snapshot + external refs; ``curve:<id>``
 * keys hash source + samples; ``feature:<id>`` keys hash canonical params
 * JSON + consumed-sketch keys + referenced-curve keys + upstream feature keys
 * + versions. Upstream edges are explicit ``dependsOn`` plus pattern/mirror
 * ``source``/``first``/``second`` refs (resolved recursively in any document
 * order, cycles rejected). Document-level ``parameters`` are intentionally
 * NOT key inputs: the backend builds from solved primitives and stored curve
 * samples and never reads the parameter table at build time, so parameters
 * cannot stale a key (verified: no ``parameters`` read in
 * ``feature_builder.py``/``sketch_builder.py``/``curve_builder.py``).
 *
 * Throws on structural problems (unknown datum/sketch/curve/dependency,
 * dependency cycle); callers treat that as a cache miss → full build.
 */
export function computeResultCacheKeys(doc: NukeCadDocument, versions: ResultCacheVersions): ResultCacheKeyTable {
    const sketches = new Map(doc.sketches.map((s) => [s.id, s]));
    const curves = new Map(doc.curves.map((c) => [c.id, c]));
    const features = new Map(doc.features.map((f) => [f.id, f]));
    // Document order affects accumulation and boolean tips, so a pure
    // reorder must miss rather than serve pre-reorder geometry.
    const order = new Map(doc.features.map((f, index) => [f.id, index] as const));
    const keys: Record<string, string> = {};

    for (const sketch of doc.sketches) {
        // `parameters` rides along even though solved coordinates usually
        // embed value edits already: a value-only change with no re-solve
        // must still miss rather than serve a stale tessellation.
        const input = {
            primitives: sortByStringId(sketch.primitives),
            constraints: sortByStringId(sketch.constraints),
            datum: datumSnapshot(doc, sketch.datumId),
            externalRefs: sketch.externalRefs ?? [],
            parameters: sketch.parameters ?? {},
            versions
        };
        keys[cacheNodeId('sketch', sketch.id)] = sha256Hex(canonicalJson(input));
    }

    for (const curve of doc.curves) {
        const input = { source: curve.source, samples: curve.samples, versions };
        keys[cacheNodeId('curve', curve.id)] = sha256Hex(canonicalJson(input));
    }

    const visiting = new Set<string>();
    const featureKey = (id: string): string => {
        const cached = keys[cacheNodeId('feature', id)];
        if (cached !== undefined) {
            return cached;
        }
        const feature = features.get(id);
        if (feature === undefined) {
            throw new Error(`Cannot key feature: unknown dependency '${id}'`);
        }
        if (visiting.has(id)) {
            throw new Error(`Cannot key feature: dependency cycle at '${id}'`);
        }
        visiting.add(id);
        try {
            const sketchIds = new Set<string>();
            if (feature.sketchId !== undefined) {
                sketchIds.add(feature.sketchId);
            }
            for (const sectionId of getSectionSketchIds(feature)) {
                sketchIds.add(sectionId);
            }
            const sketchEntries: [string, string][] = [...sketchIds].sort().map((sketchId) => {
                if (!sketches.has(sketchId)) {
                    throw new Error(`Cannot key feature '${id}': unknown sketch '${sketchId}'`);
                }
                return [sketchId, keys[cacheNodeId('sketch', sketchId)]];
            });
            const curveEntries: [string, string][] = [];
            const pathCurveId = (feature.params as Record<string, unknown>).pathCurveId;
            if (typeof pathCurveId === 'string' && pathCurveId.length > 0) {
                if (!curves.has(pathCurveId)) {
                    throw new Error(`Cannot key feature '${id}': unknown curve '${pathCurveId}'`);
                }
                curveEntries.push([pathCurveId, keys[cacheNodeId('curve', pathCurveId)]]);
            }
            const upstreamIds = new Set<string>(feature.dependsOn);
            for (const source of getPatternSourceIds(feature)) {
                upstreamIds.add(source);
            }
            const upstreamEntries: [string, string][] = [...upstreamIds].sort().map((depId) => [depId, featureKey(depId)]);
            const input = {
                type: feature.type,
                body: feature.body,
                order: order.get(id),
                params: feature.params,
                sketches: sketchEntries,
                curves: curveEntries,
                upstream: upstreamEntries,
                versions
            };
            const key = sha256Hex(canonicalJson(input));
            keys[cacheNodeId('feature', id)] = key;
            return key;
        } finally {
            visiting.delete(id);
        }
    };
    for (const feature of doc.features) {
        featureKey(feature.id);
    }
    return { keys };
}

/** Cached tessellation + key record backing one open document. */
export interface CachedDocumentResult {
    /** Per-node content keys at the time the tessellation was produced. */
    readonly keys: Record<string, string>;
    /** Builder version the keys were computed with. */
    readonly builderVersion: number;
    /** OCP version the keys were computed with. */
    readonly ocpVersion: string;
    /** Document schema version the keys were computed with. */
    readonly schemaVersion: number;
    /** Raw ``.tess.json`` text for immediate render on a fast-path hit. */
    readonly tessText: string;
}

/**
 * Memory-backed result cache with the zip-manifest interface (no zip).
 *
 * Untitled documents (no URI, no sidecar) use this directly; saved documents
 * use it as the in-session fast path in front of the Python-managed zip. Key
 * with {@link cacheKeyForDocument}.
 */
export class MemoryResultCache {
    private readonly entries = new Map<string, CachedDocumentResult>();

    get(key: string): CachedDocumentResult | undefined {
        return this.entries.get(key);
    }

    set(key: string, record: CachedDocumentResult): void {
        this.entries.set(key, record);
    }

    delete(key: string): boolean {
        return this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}

/**
 * Cache key for one open document: the backing URI when saved, otherwise a
 * name-scoped untitled slot (the store holds a single active document, so one
 * slot per name is unambiguous within a session).
 */
export function cacheKeyForDocument(uri: string | undefined, docName: string): string {
    return uri ?? `untitled:${docName}`;
}

/** Outcome of the open fast-path hash check. */
export interface OpenFastPathCheck {
    readonly hit: boolean;
    readonly reason: string;
}

/**
 * Open fast-path hash check, purely from the doc JSON (no OCP, no backend).
 *
 * Recomputes content keys with the record's own OCP version and compares them
 * against the stored keys: full hit → the caller renders ``record.tessText``
 * with zero backend spawn; any mismatch → full build (the safe default).
 * Version gates: schema or builder mismatch is an immediate miss. OCP-upgrade
 * staleness cannot be detected here (the current OCP version is only known to
 * the backend); the backend re-verifies keys with the true OCP version on the
 * next build and misses to a full rebuild there.
 */
export function checkOpenFastPath(doc: NukeCadDocument, record: CachedDocumentResult | undefined): OpenFastPathCheck {
    if (record === undefined) {
        return { hit: false, reason: 'no-cache-entry' };
    }
    if (record.schemaVersion !== NUKE_CAD_SCHEMA_VERSION) {
        return { hit: false, reason: 'schema-mismatch' };
    }
    if (record.builderVersion !== RESULT_CACHE_BUILDER_VERSION) {
        return { hit: false, reason: 'builder-mismatch' };
    }
    let current: ResultCacheKeyTable;
    try {
        current = computeResultCacheKeys(doc, { builderVersion: record.builderVersion, ocpVersion: record.ocpVersion });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { hit: false, reason: `key-error: ${message}` };
    }
    const currentIds = Object.keys(current.keys).sort();
    const storedIds = Object.keys(record.keys).sort();
    if (currentIds.length !== storedIds.length || currentIds.some((id, index) => id !== storedIds[index])) {
        return { hit: false, reason: 'node-set-mismatch' };
    }
    for (const id of currentIds) {
        if (current.keys[id] !== record.keys[id]) {
            return { hit: false, reason: `key-mismatch: ${id}` };
        }
    }
    return { hit: true, reason: 'hit' };
}

/** Minimal dirty-closure plan: ordered feature ids plus stale dependents. */
export interface DirtyRebuildPlan {
    /** Feature ids in topological build order (the partial-RPC payload). */
    readonly featureIds: string[];
    /** Non-suppressed features depending on suppressed ones (kept last-good). */
    readonly stale: string[];
}

/**
 * Compute the minimal rebuild plan for edited features via the existing
 * ``FeatureGraph.markDirty`` + ``recomputePlan`` (dependents included,
 * suppressed features omitted with dependents marked stale).
 *
 * Throws on unknown dirty ids or an inconsistent graph; callers treat that as
 * "plan unavailable" → full build.
 */
export function planDirtyRebuild(doc: NukeCadDocument, dirtyFeatureIds: readonly string[]): DirtyRebuildPlan {
    const graph = new FeatureGraph(doc.features);
    graph.markDirty([...dirtyFeatureIds]);
    const plan = graph.recomputePlan();
    return { featureIds: plan.order, stale: plan.stale };
}

/** Ids of features consuming a sketch (``sketchId`` or loft ``sectionSketchIds``). */
export function featuresConsumingSketch(doc: NukeCadDocument, sketchId: string): string[] {
    return doc.features.filter((f) => featureConsumesSketch(f, sketchId)).map((f) => f.id);
}

/** Ids of features sweeping along a curve (``params.pathCurveId``). */
export function featuresConsumingCurve(doc: NukeCadDocument, curveId: string): string[] {
    return doc.features.filter((f) => (f.params as Record<string, unknown>).pathCurveId === curveId).map((f) => f.id);
}

/** Ids of features consuming sketches placed on a datum. */
export function featuresOnDatum(doc: NukeCadDocument, datumId: string): string[] {
    const sketchIds = new Set(doc.sketches.filter((s) => s.datumId === datumId).map((s) => s.id));
    return doc.features.filter((f) => featureConsumesSketchIds(f, sketchIds)).map((f) => f.id);
}

function featureConsumesSketchIds(feature: FeatureDef, sketchIds: ReadonlySet<string>): boolean {
    if (feature.sketchId !== undefined && sketchIds.has(feature.sketchId)) {
        return true;
    }
    return getSectionSketchIds(feature).some((id) => sketchIds.has(id));
}

/** Every feature id in document order (conservative dirty set for unknown-scope edits). */
export function allFeatureIds(doc: NukeCadDocument): string[] {
    return doc.features.map((f) => f.id);
}

/**
 * Directory owning the ``<stem>.nuke-cache.zip`` sidecar for a document path
 * (TS-owned cache policy; the backend only resolves the zip inside it).
 */
export function partialCacheDirForDocument(filePath: string): string {
    const index = filePath.lastIndexOf('/');
    if (index < 0) {
        return '.';
    }
    return filePath.slice(0, index) || '/';
}

/**
 * Decide between the partial RPC and a full build: a non-empty plan smaller
 * than the whole tree goes through ``buildFeaturesPartial``; an empty plan
 * (unknown scope or nothing dirty) and a full-tree plan use ``buildDocument``.
 */
export function shouldUsePartialPlan(planIds: readonly string[], totalFeatures: number): boolean {
    return planIds.length > 0 && planIds.length < totalFeatures;
}

/** Lifecycle of one document's rebuild flow (existing chrome: overlay/banner/error). */
export type PartialRebuildStatus = 'fresh' | 'stale' | 'building' | 'error' | 'cancelled';

/** Snapshot of {@link PartialRebuildTracker}. */
export interface PartialRebuildState {
    readonly status: PartialRebuildStatus;
    /** Dirty feature ids accumulated since the last successful build. Empty while stale means unknown scope (full build). */
    readonly dirtyIds: string[];
    readonly error?: string;
}

/**
 * Pure tracker for the edit → plan → partial-RPC lifecycle.
 *
 * ``noteEdit`` marks stale (queueing while a build is in flight);
 * ``beginBuild`` drains the dirty set into one ``buildFeaturesPartial`` call
 * (``undefined`` while a build is already running — the caller coalesces);
 * ``succeed``/``fail``/``cancel`` close the build, carrying queued edits into
 * the next round. ``reset`` clears everything on document open.
 */
export class PartialRebuildTracker {
    private status: PartialRebuildStatus = 'fresh';
    private dirtyIds = new Set<string>();
    private pendingWhileBuilding = new Set<string>();
    private lastError?: string;

    getState(): PartialRebuildState {
        const state: PartialRebuildState = { status: this.status, dirtyIds: [...this.dirtyIds] };
        return this.lastError === undefined ? state : { ...state, error: this.lastError };
    }

    noteEdit(ids: readonly string[]): void {
        const target = this.status === 'building' ? this.pendingWhileBuilding : this.dirtyIds;
        for (const id of ids) {
            target.add(id);
        }
        if (this.status !== 'building') {
            this.status = 'stale';
            this.lastError = undefined;
        }
    }

    beginBuild(): string[] | undefined {
        if (this.status === 'building') {
            return undefined;
        }
        this.status = 'building';
        this.lastError = undefined;
        const ids = [...this.dirtyIds];
        this.dirtyIds.clear();
        return ids;
    }

    succeed(): void {
        if (this.status !== 'building') {
            return;
        }
        if (this.pendingWhileBuilding.size > 0) {
            this.dirtyIds = this.pendingWhileBuilding;
            this.pendingWhileBuilding = new Set<string>();
            this.status = 'stale';
        } else {
            this.status = 'fresh';
        }
    }

    fail(error: string, retryIds: readonly string[] = []): void {
        if (this.status !== 'building') {
            return;
        }
        for (const id of this.pendingWhileBuilding) {
            this.dirtyIds.add(id);
        }
        this.pendingWhileBuilding.clear();
        for (const id of retryIds) {
            this.dirtyIds.add(id);
        }
        this.status = 'error';
        this.lastError = error;
    }

    cancel(retryIds: readonly string[] = []): void {
        if (this.status !== 'building') {
            return;
        }
        for (const id of this.pendingWhileBuilding) {
            this.dirtyIds.add(id);
        }
        this.pendingWhileBuilding.clear();
        for (const id of retryIds) {
            this.dirtyIds.add(id);
        }
        this.status = this.dirtyIds.size > 0 ? 'stale' : 'cancelled';
        this.lastError = undefined;
    }

    reset(): void {
        this.status = 'fresh';
        this.dirtyIds.clear();
        this.pendingWhileBuilding.clear();
        this.lastError = undefined;
    }
}
