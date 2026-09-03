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
 * Pure helpers for the sweep/pipe feature dialogs.
 *
 * The dialog keeps its draft state as strings; {@link validateSweepPipeDraft}
 * turns the draft into validated schema params (mirroring
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
    type NukeCadDocument,
    type PipeParams,
    type SweepOrientation,
    type SweepParams
} from '../../../common/cad-document';
import { createEmptyNukeCadDocument } from '../../../common/document-templates';

/** Feature types that sweep a section along a document curve. */
export type CurveSweepFeatureType = 'sweep' | 'pipe';

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

/** A validated sweep/pipe draft ready for the ghosted preview build. */
export interface FeaturePreviewRequest {
    readonly type: CurveSweepFeatureType;
    /** Sweep section sketch; undefined for pipe (schema-level circle section). */
    readonly sketchId?: string;
    readonly params: SweepParams | PipeParams;
}

/**
 * Assemble the tentative mini-document for a sweep/pipe preview.
 *
 * The mini-document is an empty v3 document plus exactly what the draft
 * feature references: the section sketch (and its datum, for sweep), the path
 * curve, and the draft feature itself targeting a fresh preview body. It is
 * built through the normal geometry-service document path, so the preview
 * shows exactly the shape the feature adds — not a rebuild of the whole
 * document. Returns undefined when a referenced sketch/curve/datum is missing
 * (caller clears the preview).
 */
export function buildFeaturePreviewDocument(doc: NukeCadDocument, request: FeaturePreviewRequest): NukeCadDocument | undefined {
    const curve = doc.curves.find((c) => c.id === request.params.pathCurveId);
    if (curve === undefined) {
        return undefined;
    }
    const sketch = request.sketchId !== undefined ? doc.sketches.find((s) => s.id === request.sketchId) : undefined;
    if (request.type === 'sweep' && sketch === undefined) {
        return undefined;
    }
    const datum = sketch !== undefined ? doc.datums.find((d) => d.id === sketch.datumId) : undefined;
    if (sketch !== undefined && datum === undefined) {
        return undefined;
    }
    const base = createEmptyNukeCadDocument('preview');
    const feature: FeatureDef = {
        id: 'preview-feature',
        name: 'Preview',
        type: request.type,
        body: 'preview-body',
        sketchId: sketch?.id,
        params: request.params as FeatureParams,
        suppressed: false,
        dependsOn: []
    };
    return {
        ...base,
        parameters: { ...doc.parameters },
        datums: [...base.datums, ...(datum !== undefined && !base.datums.some((d) => d.id === datum.id) ? [datum] : [])],
        bodies: [{ id: 'preview-body', name: 'Preview' }],
        sketches: sketch !== undefined ? [sketch] : [],
        features: [feature],
        curves: [curve]
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
