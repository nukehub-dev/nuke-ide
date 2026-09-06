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
 * Pure helpers for the sweep/pipe/loft/helical-sweep feature dialogs.
 *
 * The dialogs keep their draft state as strings; the `validate*Draft`
 * functions turn a draft into validated schema params (mirroring
 * `validateFeatureParams` in `cad-document.ts`), and
 * {@link buildFeaturePreviewDocument} assembles the tentative mini-document
 * the ghosted preview builds through the normal geometry-service path.
 *
 * The same machinery serves every solid-feature dialog that can offer the
 * ghosted preview: {@link collectPreviewClosure} computes the transitive
 * reference closure a draft needs, the extrude/revolve/primitive validators
 * cover the sketch/datum-placed dialogs, and dress-up/hole/boolean drafts
 * carry their TopologyRefs through opaquely (the backend resolves them
 * against the closure-collected history or fails silently).
 *
 * @module nuke-cad/browser/widgets
 */

import {
    type BodyDef,
    type BooleanParams,
    type CurveDef,
    type DatumPlane,
    type DraftParams,
    type ExtrudeEnd,
    type ExtrudeParams,
    type FeatureDef,
    type FeatureParams,
    type FilletParams,
    type HelicalSweepParams,
    type HoleParams,
    type LatticeParams,
    type LoftParams,
    type NukeCadDocument,
    type PipeParams,
    type PrimitiveParams,
    type PrimitiveShape,
    type RevolveParams,
    type ShellParams,
    type SketchDef,
    type SweepOrientation,
    type SweepParams
} from '../../../common/cad-document';
import { createEmptyNukeCadDocument } from '../../../common/document-templates';

/** Feature types that sweep a section along a document curve. */
export type CurveSweepFeatureType = 'sweep' | 'pipe';

/** Sketch-profile solid features whose dialogs offer the ghosted preview. */
export type SketchSolidPreviewFeatureType = 'pad' | 'pocket' | 'revolve' | 'groove';

/** Dress-up, hole, and boolean features whose drafts carry TopologyRefs opaquely. */
export type ReferencePreviewFeatureType =
    'fillet' | 'chamfer' | 'draft' | 'shell' | 'hole' | 'booleanFuse' | 'booleanCut' | 'booleanCommon';

/** Feature types whose dialogs offer the ghosted preview. */
export type PreviewableFeatureType =
    CurveSweepFeatureType | 'loft' | 'helicalSweep' | 'lattice' | SketchSolidPreviewFeatureType | 'primitive' | ReferencePreviewFeatureType;

/** String-state draft of a sweep/pipe dialog. */
export interface SweepPipeDraft {
    readonly type: CurveSweepFeatureType;
    /** Selected path curve id (may be empty while the user is choosing). */
    readonly pathCurveId: string;
    readonly orientation: SweepOrientation;
    /** Binormal components as entered; required iff orientation is 'fixedBinormal'. */
    readonly binormal: readonly [string, string, string];
    /** Pipe radius as entered; only used for pipe. */
    readonly radius?: string;
}

export type SweepPipeValidation =
    { readonly ok: true; readonly params: SweepParams | PipeParams } | { readonly ok: false; readonly error: string };

/**
 * Validate a sweep/pipe dialog draft and produce the schema params.
 *
 * Mirrors the schema rules: the path curve must be chosen from the document's
 * curves, `fixedBinormal` requires a finite non-zero binormal, and pipe
 * requires a positive finite radius (numeric only — no parameter-name lookup).
 */
export function validateSweepPipeDraft(draft: SweepPipeDraft, curves: readonly CurveDef[]): SweepPipeValidation {
    const curveIds = new Set(curves.map((c) => c.id));
    if (draft.pathCurveId.length === 0) {
        return { ok: false, error: 'Select a path curve.' };
    }
    if (!curveIds.has(draft.pathCurveId)) {
        return { ok: false, error: `Path curve '${draft.pathCurveId}' does not exist in this document.` };
    }
    const binormal: [number, number, number] = [Number(draft.binormal[0]), Number(draft.binormal[1]), Number(draft.binormal[2])];
    if (draft.orientation === 'fixedBinormal') {
        if (!binormal.every((v) => Number.isFinite(v)) || (binormal[0] === 0 && binormal[1] === 0 && binormal[2] === 0)) {
            return { ok: false, error: 'Binormal must be a non-zero [x, y, z] vector.' };
        }
    }
    if (draft.type === 'pipe') {
        const radius = Number(draft.radius ?? '');
        if (!Number.isFinite(radius) || radius <= 0) {
            return { ok: false, error: 'Radius must be a positive number.' };
        }
        const params: PipeParams = {
            pathCurveId: draft.pathCurveId,
            radius,
            orientation: draft.orientation,
            ...(draft.orientation === 'fixedBinormal' ? { binormal } : {})
        };
        return { ok: true, params };
    }
    const params: SweepParams = {
        pathCurveId: draft.pathCurveId,
        orientation: draft.orientation,
        ...(draft.orientation === 'fixedBinormal' ? { binormal } : {})
    };
    return { ok: true, params };
}

/** A validated feature draft ready for the ghosted preview build. */
export interface FeaturePreviewRequest {
    readonly type: PreviewableFeatureType;
    /**
     * Section/profile sketch: set for sweep, helicalSweep, pad, pocket,
     * revolve, and groove (the document's selected sketch); undefined for
     * pipe (schema-level circle section), loft (the ordered sections live in
     * `params.sectionSketchIds`), primitive (placed on a datum), and the
     * dress-up/hole/boolean types (they reference history geometry through
     * opaque TopologyRefs instead).
     */
    readonly sketchId?: string;
    /**
     * Target body for drafts that modify existing geometry (pocket/groove
     * subtractive cuts, dress-up, hole). Without it the draft would run
     * against the empty preview body and fail silently; solid producers
     * (pad/revolve/sweep/pipe/loft/helicalSweep/primitive) omit it and build
     * standalone on `preview-body`. Booleans name their bodies in params
     * (`targetBody`/`toolBodies`) instead.
     */
    readonly bodyId?: string;
    readonly params:
        | SweepParams
        | PipeParams
        | LoftParams
        | HelicalSweepParams
        | LatticeParams
        | ExtrudeParams
        | RevolveParams
        | PrimitiveParams
        | FilletParams
        | ShellParams
        | DraftParams
        | HoleParams
        | BooleanParams;
}

/** A history entry for the preview build: a feature id resolved against the document, or a feature record used verbatim. */
export type PreviewHistoryEntry = FeatureDef | string;

// ---------------------------------------------------------------------------
// Preview reference closure
// ---------------------------------------------------------------------------

/** Seed ids for {@link collectPreviewClosure}. */
export interface PreviewClosureSeeds {
    readonly featureIds: readonly string[];
    readonly sketchIds: readonly string[];
    readonly curveIds: readonly string[];
    readonly bodyIds: readonly string[];
}

/** Transitive reference closure over a document, in document order. */
export interface PreviewClosure {
    readonly features: FeatureDef[];
    readonly sketches: SketchDef[];
    readonly datums: DatumPlane[];
    readonly curves: CurveDef[];
    readonly bodies: BodyDef[];
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function stringArrayField(params: Record<string, unknown>, key: string): string[] {
    const value = params[key];
    return Array.isArray(value) ? value.filter(isNonEmptyString) : [];
}

/** Collect the producing feature ids behind a TopologyRef or an array of them. */
function collectTopologyRefFeatureIds(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
        for (const entry of value) {
            collectTopologyRefFeatureIds(entry, into);
        }
        return;
    }
    if (typeof value === 'object' && value !== null) {
        const featureId = (value as Record<string, unknown>).featureId;
        if (isNonEmptyString(featureId)) {
            into.add(featureId);
        }
    }
}

function addIfMissing(set: Set<string>, value: string): boolean {
    if (set.has(value)) {
        return false;
    }
    set.add(value);
    return true;
}

/**
 * Expand one closure feature into its directly referenced ids.
 *
 * Covers every reference type: the target body, `dependsOn`, the consumed
 * sketch (`sketchId`/`sectionSketchIds`), pattern `source`/`first`/`second`,
 * sweep `pathCurveId`, pattern/primitive datum ids, extrude `upToBody`,
 * boolean `targetBody`/`toolBodies`, and every embedded TopologyRef
 * (`edges`/`faces`/`upToFace`/`face`/`neutralPlane`).
 */
function expandClosureFeature(
    feature: FeatureDef,
    seed: {
        features: Set<string>;
        sketches: Set<string>;
        datums: Set<string>;
        curves: Set<string>;
        bodies: Set<string>;
    }
): boolean {
    let grown = false;
    const add = (set: Set<string>, value: string): void => {
        grown = addIfMissing(set, value) || grown;
    };
    add(seed.bodies, feature.body);
    for (const dep of feature.dependsOn ?? []) {
        if (isNonEmptyString(dep)) {
            add(seed.features, dep);
        }
    }
    if (isNonEmptyString(feature.sketchId)) {
        add(seed.sketches, feature.sketchId);
    }
    const params = (feature.params ?? {}) as unknown as Record<string, unknown>;
    for (const key of ['source', 'first', 'second'] as const) {
        const ref = params[key];
        if (isNonEmptyString(ref)) {
            add(seed.features, ref);
        }
    }
    for (const sketchId of stringArrayField(params, 'sectionSketchIds')) {
        add(seed.sketches, sketchId);
    }
    const pathCurveId = params.pathCurveId;
    if (isNonEmptyString(pathCurveId)) {
        add(seed.curves, pathCurveId);
    }
    for (const key of ['datumId', 'axisDatumId', 'planeDatumId'] as const) {
        const ref = params[key];
        if (isNonEmptyString(ref)) {
            add(seed.datums, ref);
        }
    }
    for (const key of ['upToBody', 'targetBody'] as const) {
        const ref = params[key];
        if (isNonEmptyString(ref)) {
            add(seed.bodies, ref);
        }
    }
    for (const toolBody of stringArrayField(params, 'toolBodies')) {
        add(seed.bodies, toolBody);
    }
    for (const key of ['edges', 'faces', 'upToFace', 'face', 'neutralPlane'] as const) {
        const refs = params[key];
        if (refs !== undefined) {
            const before = seed.features.size;
            collectTopologyRefFeatureIds(refs, seed.features);
            grown = seed.features.size > before || grown;
        }
    }
    return grown;
}

/**
 * Compute the transitive closure of everything a preview needs from the document.
 *
 * Starting from the seed ids, follows feature `dependsOn`/pattern
 * `source`/`first`/`second`/`sketchId`/`sectionSketchIds`/sweep
 * `pathCurveId`/datum ids/`upToBody`/boolean `targetBody`/`toolBodies`/
 * TopologyRef producers, sketch datum ids and `externalRefs`, and datum face
 * references (`face` reference + `midplane` faces) to a fixpoint. Unknown ids
 * are skipped silently. The result is pure (no input is mutated) and in
 * document order.
 */
export function collectPreviewClosure(doc: NukeCadDocument, seeds: PreviewClosureSeeds): PreviewClosure {
    const featureIds = new Set(seeds.featureIds.filter(isNonEmptyString));
    const sketchIds = new Set(seeds.sketchIds.filter(isNonEmptyString));
    const curveIds = new Set(seeds.curveIds.filter(isNonEmptyString));
    const bodyIds = new Set(seeds.bodyIds.filter(isNonEmptyString));
    const datumIds = new Set<string>();
    const seed = { features: featureIds, sketches: sketchIds, datums: datumIds, curves: curveIds, bodies: bodyIds };
    let grown = true;
    while (grown) {
        grown = false;
        for (const feature of doc.features) {
            if (featureIds.has(feature.id)) {
                grown = expandClosureFeature(feature, seed) || grown;
            }
        }
        for (const sketch of doc.sketches) {
            if (!sketchIds.has(sketch.id)) {
                continue;
            }
            if (isNonEmptyString(sketch.datumId)) {
                grown = addIfMissing(datumIds, sketch.datumId) || grown;
            }
            if (sketch.externalRefs !== undefined) {
                const before = featureIds.size;
                collectTopologyRefFeatureIds(sketch.externalRefs, featureIds);
                grown = featureIds.size > before || grown;
            }
        }
        for (const datum of doc.datums) {
            if (!datumIds.has(datum.id)) {
                continue;
            }
            if (datum.reference !== undefined) {
                const before = featureIds.size;
                collectTopologyRefFeatureIds(datum.reference, featureIds);
                grown = featureIds.size > before || grown;
            }
            if (datum.faces !== undefined) {
                const before = featureIds.size;
                collectTopologyRefFeatureIds(datum.faces, featureIds);
                grown = featureIds.size > before || grown;
            }
        }
    }
    return {
        features: doc.features.filter((f) => featureIds.has(f.id)),
        sketches: doc.sketches.filter((s) => sketchIds.has(s.id)),
        datums: doc.datums.filter((d) => datumIds.has(d.id)),
        curves: doc.curves.filter((c) => curveIds.has(c.id)),
        bodies: doc.bodies.filter((b) => bodyIds.has(b.id))
    };
}

/**
 * Assemble the tentative mini-document for a feature preview.
 *
 * Without `history` this is the original sweep/pipe/loft/helicalSweep path:
 * an empty v3 document plus exactly what the draft feature references — the
 * section sketch(es) and their datums (one for sweep/helicalSweep,
 * `params.sectionSketchIds` in order for loft, none for pipe), the path
 * curve(s) (`params.pathCurveId` for sweep/pipe, none otherwise), and the
 * draft feature itself targeting a fresh preview body. It is built through
 * the normal geometry-service document path, so the preview shows exactly
 * the shape the feature adds — not a rebuild of the whole document. Returns
 * undefined when a referenced sketch/datum/curve is missing (caller clears
 * the preview).
 *
 * With `history` (a closed feature set, typically one body's chain, as
 * feature records or ids) the mini-document additionally includes the
 * history features verbatim — same ids, so TopologyRef fingerprints resolve
 * because the geometry rebuilds identically — plus the
 * {@link collectPreviewClosure} sketches/datums/curves/bodies covering both
 * the history and the draft's own references, then the draft feature on
 * `preview-body` as above. Dress-up/hole/boolean drafts carry their
 * TopologyRefs through opaquely; the backend resolves them against the
 * history or fails silently per the preview contract. Returns undefined when
 * a draft-referenced sketch/datum/curve is missing.
 */
export function buildFeaturePreviewDocument(
    doc: NukeCadDocument,
    request: FeaturePreviewRequest,
    history: readonly PreviewHistoryEntry[] = []
): NukeCadDocument | undefined {
    if (
        history.length === 0 &&
        (request.type === 'sweep' || request.type === 'pipe' || request.type === 'loft' || request.type === 'helicalSweep')
    ) {
        return buildLegacyPreviewDocument(doc, request);
    }
    return buildClosurePreviewDocument(doc, request, history);
}

/**
 * Original sweep/pipe/loft/helicalSweep mini-document path.
 *
 * Kept verbatim so previews without history are byte-identical to before.
 */
function buildLegacyPreviewDocument(doc: NukeCadDocument, request: FeaturePreviewRequest): NukeCadDocument | undefined {
    const params = request.params as unknown as Record<string, unknown>;
    const sketchIds =
        request.type === 'loft'
            ? Array.isArray(params.sectionSketchIds)
                ? params.sectionSketchIds.filter((sid): sid is string => typeof sid === 'string')
                : []
            : request.sketchId !== undefined
              ? [request.sketchId]
              : [];
    const curveIds =
        request.type === 'sweep' || request.type === 'pipe'
            ? typeof params.pathCurveId === 'string' && params.pathCurveId.length > 0
                ? [params.pathCurveId]
                : []
            : [];
    const sketches: SketchDef[] = [];
    const datums: NukeCadDocument['datums'] = [];
    for (const sketchId of sketchIds) {
        const sketch = doc.sketches.find((s) => s.id === sketchId);
        if (sketch === undefined) {
            return undefined;
        }
        const datum = doc.datums.find((d) => d.id === sketch.datumId);
        if (datum === undefined) {
            return undefined;
        }
        sketches.push(sketch);
        if (!datums.some((d) => d.id === datum.id)) {
            datums.push(datum);
        }
    }
    const curves: CurveDef[] = [];
    for (const curveId of curveIds) {
        const curve = doc.curves.find((c) => c.id === curveId);
        if (curve === undefined) {
            return undefined;
        }
        curves.push(curve);
    }
    const base = createEmptyNukeCadDocument('preview');
    const feature: FeatureDef = {
        id: 'preview-feature',
        name: 'Preview',
        type: request.type,
        body: 'preview-body',
        sketchId: request.type === 'sweep' || request.type === 'helicalSweep' ? request.sketchId : undefined,
        params: request.params as FeatureParams,
        suppressed: false,
        dependsOn: []
    };
    return {
        ...base,
        parameters: { ...doc.parameters },
        datums: [...base.datums, ...datums.filter((d) => !base.datums.some((bd) => bd.id === d.id))],
        bodies: [{ id: 'preview-body', name: 'Preview' }],
        sketches,
        features: [feature],
        curves
    };
}

/** Sketch ids a draft feature consumes directly: the profile sketch, or the loft sections in order. */
function draftPreviewSketchIds(request: FeaturePreviewRequest): string[] {
    const params = request.params as unknown as Record<string, unknown>;
    if (request.type === 'loft') {
        return Array.isArray(params.sectionSketchIds) ? params.sectionSketchIds.filter(isNonEmptyString) : [];
    }
    if (
        (request.type === 'sweep' ||
            request.type === 'helicalSweep' ||
            request.type === 'pad' ||
            request.type === 'pocket' ||
            request.type === 'revolve' ||
            request.type === 'groove') &&
        isNonEmptyString(request.sketchId)
    ) {
        return [request.sketchId];
    }
    return [];
}

/** Curve ids a draft feature consumes directly: the sweep/pipe path curve. */
function draftPreviewCurveIds(request: FeaturePreviewRequest): string[] {
    const params = request.params as unknown as Record<string, unknown>;
    if (request.type === 'sweep' || request.type === 'pipe') {
        return isNonEmptyString(params.pathCurveId) ? [params.pathCurveId] : [];
    }
    return [];
}

/** Datum ids a draft feature consumes directly: the primitive placement datum (default `datum-xy`). */
function draftPreviewDatumIds(request: FeaturePreviewRequest): string[] {
    const params = request.params as unknown as Record<string, unknown>;
    if (request.type === 'primitive') {
        return [isNonEmptyString(params.datumId) ? params.datumId : 'datum-xy'];
    }
    return [];
}

/** Producing feature ids behind a draft's opaque TopologyRefs (`edges`/`faces`/`upToFace`/`face`/`neutralPlane`). */
function draftPreviewRefFeatureIds(request: FeaturePreviewRequest): string[] {
    const params = request.params as unknown as Record<string, unknown>;
    const ids = new Set<string>();
    for (const key of ['edges', 'faces', 'upToFace', 'face', 'neutralPlane'] as const) {
        const refs = params[key];
        if (refs !== undefined) {
            collectTopologyRefFeatureIds(refs, ids);
        }
    }
    return [...ids];
}

/**
 * Pattern/mirror/lattice input feature ids a draft names directly (`source`).
 *
 * Lattice drafts replicate one same-body source feature; seeding it pulls the
 * source (and, through the closure fixpoint, its sketch/datum inputs) into
 * the mini-document so the backend resolves the source tool shape. No other
 * previewable type names `source`, so this only affects lattice.
 */
function draftPreviewSourceFeatureIds(request: FeaturePreviewRequest): string[] {
    const params = request.params as unknown as Record<string, unknown>;
    return isNonEmptyString(params.source) ? [params.source] : [];
}

/**
 * Body ids a draft names directly: the explicit `bodyId` (pocket/groove
 * cuts, dress-up, hole), boolean `targetBody`/`toolBodies`, and extrude
 * `upToBody`. Dress-up/hole dialogs also pass refs whose producing features
 * resolve to the same bodies; both channels feed the history below.
 */
function draftPreviewBodyIds(request: FeaturePreviewRequest): string[] {
    const params = request.params as unknown as Record<string, unknown>;
    const ids: string[] = [];
    if (isNonEmptyString(request.bodyId)) {
        ids.push(request.bodyId);
    }
    for (const key of ['bodyId', 'upToBody', 'targetBody'] as const) {
        const ref = params[key];
        if (isNonEmptyString(ref)) {
            ids.push(ref);
        }
    }
    ids.push(...stringArrayField(params, 'toolBodies'));
    return ids;
}

/**
 * Feature types that modify existing body geometry instead of producing a
 * standalone solid. Their drafts retarget from `preview-body` onto the
 * referenced body (which the history below rebuilds identically), so the
 * ghost shows the operation on real geometry. Everything else builds
 * standalone on `preview-body`.
 *
 * Lattice joins this list: whether its source is additive (instances fuse
 * into the body) or subtractive (instances cut it), the draft must run
 * against the rebuilt real body where the source tool shape exists — on the
 * empty preview body the source would dangle and the preview would clear.
 */
const HISTORY_TARGET_TYPES: readonly PreviewableFeatureType[] = [
    'pocket',
    'groove',
    'fillet',
    'chamfer',
    'draft',
    'shell',
    'hole',
    'lattice',
    'booleanFuse',
    'booleanCut',
    'booleanCommon'
];

/**
 * Closure mini-document path for previews with history and for the
 * post-sweep solid-feature dialogs (pad/pocket/revolve/groove, primitive,
 * dress-up, hole, boolean).
 *
 * History entries carry the features to replay verbatim (same ids, so
 * TopologyRef fingerprints resolve because the geometry rebuilds
 * identically); string entries resolve against the document and unknown ids
 * are skipped. The closure then pulls every sketch/datum/curve/body the
 * history and the draft reference, and the draft feature goes on
 * `preview-body` last. Returns undefined when a draft-referenced
 * sketch/datum/curve is missing (caller clears the preview); unresolvable
 * opaque references are left for the backend, which fails silently per the
 * preview contract.
 */
function buildClosurePreviewDocument(
    doc: NukeCadDocument,
    request: FeaturePreviewRequest,
    history: readonly PreviewHistoryEntry[]
): NukeCadDocument | undefined {
    const historyFeatures: FeatureDef[] = [];
    for (const entry of history) {
        if (typeof entry === 'string') {
            const found = doc.features.find((f) => f.id === entry);
            if (found !== undefined) {
                historyFeatures.push(found);
            }
        } else if (entry !== null && typeof entry === 'object' && isNonEmptyString(entry.id)) {
            historyFeatures.push(entry);
        }
    }
    // Modifier drafts (subtractive cuts, dress-up, hole, booleans) operate on
    // existing body geometry: pull the REQUEST-named bodies' FULL feature
    // chains into the history so TopologyRefs resolve against identical
    // geometry — including bodies those chains themselves name (tool bodies,
    // up-to bodies), to a fixpoint, so a cross-body boolean never replays
    // against an empty tool body. Without this the draft would run against
    // an empty body and fail silently. Chains replay verbatim (suppression
    // flags intact), mirroring real-build semantics; a costly closure (e.g.
    // a ×50 pattern) simply hits the backend timeout and clears the preview
    // per the preview contract. Explicit history entries keep their exact
    // verbatim semantics (their bodies do NOT expand); only request-named
    // bodies seed the fixpoint.
    const historyIds = new Set(historyFeatures.map((f) => f.id));
    const referencedBodies = new Set(draftPreviewBodyIds(request));
    const collectNamedBodies = (feature: FeatureDef): void => {
        const params = (feature.params ?? {}) as unknown as Record<string, unknown>;
        for (const key of ['bodyId', 'upToBody', 'targetBody'] as const) {
            const ref = params[key];
            if (isNonEmptyString(ref)) {
                referencedBodies.add(ref);
            }
        }
        for (const toolBody of stringArrayField(params, 'toolBodies')) {
            referencedBodies.add(toolBody);
        }
    };
    // Only request-named bodies seed the fixpoint (explicit history entries
    // keep verbatim semantics); each pulled chain feature in turn contributes
    // the bodies IT names, so cross-body booleans never replay against an
    // empty tool body.
    let grown = true;
    while (grown) {
        grown = false;
        for (const feature of doc.features) {
            if (!historyIds.has(feature.id) && isNonEmptyString(feature.body) && referencedBodies.has(feature.body)) {
                historyFeatures.push(feature);
                historyIds.add(feature.id);
                collectNamedBodies(feature);
                grown = true;
            }
        }
    }
    const closure = collectPreviewClosure(doc, {
        featureIds: [...historyFeatures.map((f) => f.id), ...draftPreviewRefFeatureIds(request), ...draftPreviewSourceFeatureIds(request)],
        sketchIds: draftPreviewSketchIds(request),
        curveIds: draftPreviewCurveIds(request),
        bodyIds: [...referencedBodies]
    });
    const sketchById = new Map(closure.sketches.map((s) => [s.id, s]));
    for (const sketchId of draftPreviewSketchIds(request)) {
        const sketch = sketchById.get(sketchId);
        if (sketch === undefined) {
            return undefined;
        }
        if (!closure.datums.some((d) => d.id === sketch.datumId)) {
            return undefined;
        }
    }
    const curveById = new Set(closure.curves.map((c) => c.id));
    for (const curveId of draftPreviewCurveIds(request)) {
        if (!curveById.has(curveId)) {
            return undefined;
        }
    }
    const datumById = new Set(closure.datums.map((d) => d.id));
    const base = createEmptyNukeCadDocument('preview');
    for (const datum of base.datums) {
        datumById.add(datum.id);
    }
    for (const datumId of draftPreviewDatumIds(request)) {
        if (!datumById.has(datumId)) {
            return undefined;
        }
    }
    const historyById = new Map(historyFeatures.map((f) => [f.id, f]));
    const features: FeatureDef[] = closure.features.map((f) => historyById.get(f.id) ?? f);
    for (const historyFeature of historyFeatures) {
        if (!features.some((f) => f.id === historyFeature.id)) {
            features.push(historyFeature);
        }
    }
    const bodies: BodyDef[] = [...closure.bodies];
    if (!bodies.some((b) => b.id === 'preview-body')) {
        bodies.push({ id: 'preview-body', name: 'Preview' });
    }
    // Modifier drafts (subtractive cuts, dress-up, hole, booleans) retarget
    // from the empty preview body onto the referenced real body, which the
    // history above rebuilds identically — otherwise they fail silently
    // against nothing. Falls back to preview-body when the body is absent.
    let draftBody = 'preview-body';
    if ((HISTORY_TARGET_TYPES as readonly string[]).includes(request.type)) {
        const params = request.params as unknown as Record<string, unknown>;
        const candidates = [
            request.bodyId,
            ...(typeof params.bodyId === 'string' ? [params.bodyId] : []),
            ...(typeof params.targetBody === 'string' ? [params.targetBody] : [])
        ];
        const target = candidates.find(
            (candidate): candidate is string => isNonEmptyString(candidate) && bodies.some((b) => b.id === candidate)
        );
        if (target !== undefined) {
            draftBody = target;
        }
    }
    const feature: FeatureDef = {
        id: 'preview-feature',
        name: 'Preview',
        type: request.type,
        body: draftBody,
        sketchId:
            request.type === 'sweep' ||
            request.type === 'helicalSweep' ||
            request.type === 'pad' ||
            request.type === 'pocket' ||
            request.type === 'revolve' ||
            request.type === 'groove'
                ? request.sketchId
                : undefined,
        params: request.params as FeatureParams,
        suppressed: false,
        dependsOn: []
    };
    features.push(feature);
    return {
        ...base,
        parameters: { ...doc.parameters },
        datums: [...base.datums, ...closure.datums.filter((d) => !base.datums.some((bd) => bd.id === d.id))],
        bodies,
        sketches: closure.sketches,
        features,
        curves: closure.curves
    };
}

/**
 * Resolve a viewport curve pick against the document's curves.
 *
 * The viewport pick path reads `userData.curveId` off the rendered curve line;
 * this guard drops picks for curves that no longer exist (deleted or a stale
 * pick after a rebuild) so the dialog never records a dangling reference.
 */
export function resolveCurvePick(curves: readonly CurveDef[], curveId: unknown): string | undefined {
    if (typeof curveId !== 'string' || curveId.length === 0) {
        return undefined;
    }
    return curves.some((c) => c.id === curveId) ? curveId : undefined;
}

// ---------------------------------------------------------------------------
// Loft dialog
// ---------------------------------------------------------------------------

/** String-state draft of a loft dialog (sections are document sketch ids). */
export interface LoftDraft {
    /** Ordered section sketch ids as picked in the dialog. */
    readonly sectionSketchIds: readonly string[];
    readonly ruled: boolean;
}

export type LoftValidation = { readonly ok: true; readonly params: LoftParams } | { readonly ok: false; readonly error: string };

/**
 * Validate a loft dialog draft and produce the schema params.
 *
 * Mirrors the schema rules: at least two distinct sections, every section
 * must reference an existing document sketch, and `ruled` is a plain boolean.
 */
export function validateLoftDraft(draft: LoftDraft, sketches: readonly SketchDef[]): LoftValidation {
    const sketchIds = new Set(sketches.map((s) => s.id));
    if (draft.sectionSketchIds.length < 2) {
        return { ok: false, error: 'Add at least 2 section sketches.' };
    }
    const seen = new Set<string>();
    for (const sid of draft.sectionSketchIds) {
        if (seen.has(sid)) {
            return { ok: false, error: `Section sketch '${sid}' is listed more than once.` };
        }
        seen.add(sid);
        if (!sketchIds.has(sid)) {
            return { ok: false, error: `Section sketch '${sid}' does not exist in this document.` };
        }
    }
    return { ok: true, params: { sectionSketchIds: [...draft.sectionSketchIds], ruled: draft.ruled } };
}

/**
 * Move the section at `index` one position up or down.
 *
 * Pure reorder helper for the loft dialog's section list: returns a new array,
 * leaves the input untouched, and is a no-op (returning a copy) when the move
 * would leave the list bounds.
 */
export function moveLoftSection(sectionSketchIds: readonly string[], index: number, direction: 'up' | 'down'): readonly string[] {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || index >= sectionSketchIds.length || target < 0 || target >= sectionSketchIds.length) {
        return [...sectionSketchIds];
    }
    const result = [...sectionSketchIds];
    [result[index], result[target]] = [result[target], result[index]];
    return result;
}

/** Loft draft fields prefilled from an existing feature's params (edit-parameters flow). */
export function loftDraftFromParams(params: Record<string, unknown>): LoftDraft {
    const sectionSketchIds = Array.isArray(params.sectionSketchIds)
        ? params.sectionSketchIds.filter((sid): sid is string => typeof sid === 'string' && sid.length > 0)
        : [];
    return { sectionSketchIds, ruled: params.ruled === true };
}

// ---------------------------------------------------------------------------
// Helical sweep dialog
// ---------------------------------------------------------------------------

/** Origin-aligned helix axes. */
export type HelixAxis = HelicalSweepParams['axis'];

/** String-state draft of a helical sweep dialog. */
export interface HelicalSweepDraft {
    readonly axis: HelixAxis;
    readonly startRadius: string;
    readonly pitch: string;
    readonly turns: string;
    readonly leftHanded: boolean;
    readonly orientation: SweepOrientation;
    /** Binormal components as entered; required iff orientation is 'fixedBinormal'. */
    readonly binormal: readonly [string, string, string];
}

export type HelicalSweepValidation =
    { readonly ok: true; readonly params: HelicalSweepParams } | { readonly ok: false; readonly error: string };

/** Unit vector for an origin-aligned helix axis. */
export function helixAxisUnit(axis: HelixAxis): readonly [number, number, number] {
    switch (axis) {
        case 'X':
            return [1, 0, 0];
        case 'Y':
            return [0, 1, 0];
        default:
            return [0, 0, 1];
    }
}

/**
 * Validate a helical sweep dialog draft and produce the schema params.
 *
 * Mirrors the schema rules: `startRadius`/`pitch`/`turns` must be positive
 * finite numbers, and `fixedBinormal` requires a finite non-zero binormal.
 * The derived helix height (`pitch * turns`) is not stored.
 */
export function validateHelicalSweepDraft(draft: HelicalSweepDraft): HelicalSweepValidation {
    const numbers: Record<'startRadius' | 'pitch' | 'turns', number> = {
        startRadius: Number(draft.startRadius),
        pitch: Number(draft.pitch),
        turns: Number(draft.turns)
    };
    for (const [name, value] of Object.entries(numbers) as Array<[keyof typeof numbers, number]>) {
        if (!Number.isFinite(value) || value <= 0) {
            return {
                ok: false,
                error: `${name === 'startRadius' ? 'Start radius' : name === 'pitch' ? 'Pitch' : 'Turns'} must be a positive number.`
            };
        }
    }
    const binormal: [number, number, number] = [Number(draft.binormal[0]), Number(draft.binormal[1]), Number(draft.binormal[2])];
    if (draft.orientation === 'fixedBinormal') {
        if (!binormal.every((v) => Number.isFinite(v)) || (binormal[0] === 0 && binormal[1] === 0 && binormal[2] === 0)) {
            return { ok: false, error: 'Binormal must be a non-zero [x, y, z] vector.' };
        }
    }
    const params: HelicalSweepParams = {
        axis: draft.axis,
        startRadius: numbers.startRadius,
        pitch: numbers.pitch,
        turns: numbers.turns,
        leftHanded: draft.leftHanded,
        orientation: draft.orientation,
        ...(draft.orientation === 'fixedBinormal' ? { binormal } : {})
    };
    return { ok: true, params };
}

/** Helical sweep draft prefilled from an existing feature's params (edit-parameters flow). */
export function helicalSweepDraftFromParams(params: Record<string, unknown>): HelicalSweepDraft {
    const axis: HelixAxis = params.axis === 'X' || params.axis === 'Y' ? params.axis : 'Z';
    const orientation: SweepOrientation = params.orientation === 'frenet' ? 'frenet' : 'fixedBinormal';
    const binormal = params.binormal as readonly [number, number, number] | undefined;
    const unit = helixAxisUnit(axis);
    return {
        axis,
        startRadius: params.startRadius !== undefined ? String(params.startRadius) : '1',
        pitch: params.pitch !== undefined ? String(params.pitch) : '1',
        turns: params.turns !== undefined ? String(params.turns) : '3',
        leftHanded: params.leftHanded === true,
        orientation,
        binormal:
            binormal !== undefined
                ? [String(binormal[0]), String(binormal[1]), String(binormal[2])]
                : [String(unit[0]), String(unit[1]), String(unit[2])]
    };
}

// ---------------------------------------------------------------------------
// Extrude (pad/pocket) dialog
// ---------------------------------------------------------------------------

/** String-state draft of a pad/pocket dialog. */
export interface ExtrudeDraft {
    readonly type: 'pad' | 'pocket';
    /** Extrusion length as entered; required iff the end is blind. */
    readonly length: string;
    readonly axis: 'x' | 'y' | 'z';
    readonly symmetric: boolean;
    readonly twoSided: boolean;
    readonly end: ExtrudeEnd;
}

export type ExtrudeValidation = { readonly ok: true; readonly params: ExtrudeParams } | { readonly ok: false; readonly error: string };

/**
 * Validate a pad/pocket dialog draft and produce the schema params.
 *
 * Mirrors the schema rules: blind ends require a positive finite length
 * (`symmetric`/`twoSided` split it equally both ways), matching the dialog's
 * own validation. Non-blind ends are intentionally un-previewable — they need
 * the live body state no mini-document can resolve — so they return
 * `{ ok: false }` with a reason the dialog shows instead of a faked preview.
 */
export function validateExtrudeDraft(draft: ExtrudeDraft): ExtrudeValidation {
    if (draft.end !== 'blind') {
        return {
            ok: false,
            error: `End '${draft.end}' needs the live body state and cannot be previewed; switch to a blind end to preview.`
        };
    }
    if (draft.axis !== 'x' && draft.axis !== 'y' && draft.axis !== 'z') {
        return { ok: false, error: `Axis must be 'x', 'y' or 'z'.` };
    }
    const length = Number(draft.length);
    if (!Number.isFinite(length) || length <= 0) {
        return { ok: false, error: 'Length must be a positive number.' };
    }
    const params: ExtrudeParams = {
        length,
        axis: draft.axis,
        symmetric: draft.symmetric,
        ...(draft.twoSided ? { twoSided: true } : {})
    };
    return { ok: true, params };
}

// ---------------------------------------------------------------------------
// Revolve (revolve/groove) dialog
// ---------------------------------------------------------------------------

/** String-state draft of a revolve/groove dialog. */
export interface RevolveDraft {
    readonly axis: string;
    /** Revolution angle in degrees as entered. */
    readonly angle: string;
}

export type RevolveValidation = { readonly ok: true; readonly params: RevolveParams } | { readonly ok: false; readonly error: string };

/**
 * Validate a revolve/groove dialog draft and produce the schema params.
 *
 * Mirrors the schema rules: the axis is `x`/`y`/`z` and the angle is in
 * (0, 360] degrees, matching the dialog's own validation.
 */
export function validateRevolveDraft(draft: RevolveDraft): RevolveValidation {
    if (draft.axis !== 'x' && draft.axis !== 'y' && draft.axis !== 'z') {
        return { ok: false, error: `Axis must be 'x', 'y' or 'z'.` };
    }
    const angle = Number(draft.angle);
    if (!Number.isFinite(angle) || angle <= 0 || angle > 360) {
        return { ok: false, error: 'Angle must be in (0, 360].' };
    }
    return { ok: true, params: { axis: draft.axis, angle } };
}

// ---------------------------------------------------------------------------
// Primitive dialog
// ---------------------------------------------------------------------------

/** String-state draft of a primitive dialog (dimensions as entered, one slot per shape arity position). */
export interface PrimitiveDraft {
    readonly shape: PrimitiveShape;
    /** Dimension strings; only the first `arity` entries are read (box 3, sphere 1, else 2). */
    readonly dimensions: readonly string[];
    /** Placement datum id as entered; empty means the `datum-xy` default. */
    readonly datumId: string;
}

export type PrimitiveValidation = { readonly ok: true; readonly params: PrimitiveParams } | { readonly ok: false; readonly error: string };

/**
 * Validate a primitive dialog draft and produce the schema params.
 *
 * Mirrors the schema rules: the shape sets the dimension arity (box 3,
 * sphere 1, cylinder/cone/torus 2) and every consumed dimension must be a
 * positive finite number, matching the dialog's own validation. A non-empty
 * datum id must reference a document datum when the datum list is provided;
 * an empty datum id stays omitted (the `datum-xy` default).
 */
export function validatePrimitiveDraft(draft: PrimitiveDraft, datums?: readonly DatumPlane[]): PrimitiveValidation {
    const shapes: PrimitiveShape[] = ['box', 'cylinder', 'sphere', 'cone', 'torus'];
    if (!shapes.includes(draft.shape)) {
        return { ok: false, error: `Unknown primitive shape '${draft.shape}'.` };
    }
    const arity = draft.shape === 'box' ? 3 : draft.shape === 'sphere' ? 1 : 2;
    const dimensions = draft.dimensions.slice(0, arity).map((d) => Number(d));
    if (dimensions.length < arity || dimensions.some((d) => !Number.isFinite(d) || d <= 0)) {
        return { ok: false, error: 'Dimensions must be positive finite numbers.' };
    }
    const datumId = draft.datumId.trim();
    if (datumId !== '' && datums !== undefined && datums.every((d) => d.id !== datumId)) {
        return { ok: false, error: `Unknown datum '${datumId}'.` };
    }
    return { ok: true, params: { shape: draft.shape, dimensions, ...(datumId !== '' ? { datumId } : {}) } };
}
