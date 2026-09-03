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
 * @module nuke-cad/browser/widgets
 */

import {
    type CurveDef,
    type FeatureDef,
    type FeatureParams,
    type HelicalSweepParams,
    type LoftParams,
    type NukeCadDocument,
    type PipeParams,
    type SketchDef,
    type SweepOrientation,
    type SweepParams
} from '../../../common/cad-document';
import { createEmptyNukeCadDocument } from '../../../common/document-templates';

/** Feature types that sweep a section along a document curve. */
export type CurveSweepFeatureType = 'sweep' | 'pipe';

/** Feature types whose dialogs offer the ghosted preview. */
export type PreviewableFeatureType = CurveSweepFeatureType | 'loft' | 'helicalSweep';

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
     * Section sketch: set for sweep and helicalSweep (the document's selected
     * sketch); undefined for pipe (schema-level circle section) and loft
     * (the ordered sections live in `params.sectionSketchIds`).
     */
    readonly sketchId?: string;
    readonly params: SweepParams | PipeParams | LoftParams | HelicalSweepParams;
}

/**
 * Assemble the tentative mini-document for a feature preview.
 *
 * The mini-document is an empty v3 document plus exactly what the draft
 * feature references: the section sketch(es) and their datums (one for
 * sweep/helicalSweep, `params.sectionSketchIds` in order for loft, none for
 * pipe), the path curve(s) (`params.pathCurveId` for sweep/pipe, none
 * otherwise), and the draft feature itself targeting a fresh preview body.
 * It is built through the normal geometry-service document path, so the
 * preview shows exactly the shape the feature adds — not a rebuild of the
 * whole document. Returns undefined when a referenced sketch/datum/curve is
 * missing (caller clears the preview).
 */
export function buildFeaturePreviewDocument(doc: NukeCadDocument, request: FeaturePreviewRequest): NukeCadDocument | undefined {
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
