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
 * Sketch-dimension authoring contracts.
 *
 * A request edits one existing driving dimension or one document parameter
 * referenced by the target sketch. The solver transaction resolves the request
 * against a detached document, re-solves every affected sketch, and returns
 * one atomic before/after snapshot for preview and apply.
 *
 * @module nuke-cad/browser/sketch
 */

import type { SketchSolver } from '../../common/sketch-solver';
import type { NukeChange } from 'nuke-core/lib/common/nuke-capability-protocol';
import type { DimensionKind, NukeCadDocument, SketchDef } from '../../common/cad-document';

/** Maximum number of edits accepted by one sketch proposal. */
export const CAD_SKETCH_EDIT_LIMIT = 8;

/** Edit an existing literal driving dimension. */
export interface SketchDimensionEdit {
    readonly sketchId: string;
    readonly dimensionId: string;
    readonly value: number;
}

/**
 * Edit a document parameter referenced by the target sketch.
 *
 * Saved documents merge sketch-local parameters into `doc.parameters`, so the
 * parameter is always the document-level value. Every sketch and parametric
 * curve referencing it is re-solved or re-sampled in the same transaction.
 */
export interface SketchParameterEdit {
    readonly sketchId: string;
    readonly parameterName: string;
    readonly value: number;
}

/** One requested sketch edit. */
export type SketchEditRequest = SketchDimensionEdit | SketchParameterEdit;

/** How a request was resolved against the sketch. */
export type ResolvedSketchEditKind = 'dimension' | 'parameter';

/** One resolved edit row shown in the review panel. */
export interface ResolvedSketchEdit {
    readonly kind: ResolvedSketchEditKind;
    readonly sketchId: string;
    readonly sketchName: string;
    /** Target dimension id; set for literal and parameter-bound dimension edits. */
    readonly dimensionId?: string;
    readonly dimensionKind?: DimensionKind;
    /** Document parameter driving this edit, when the target is parameter-bound. */
    readonly parameterName?: string;
    readonly before: number;
    readonly after: number;
    /** Dimensions whose value changes because of this edit. */
    readonly affectedDimensionIds: readonly string[];
}

/** Per-sketch solver outcome captured by the transaction. */
export interface SketchSolveStatus {
    readonly sketchId: string;
    readonly sketchName: string;
    readonly status: 'converged' | 'failed';
    readonly dof: number;
    readonly fullyConstrained: boolean;
    readonly conflicting: readonly string[];
    readonly redundant: readonly string[];
    readonly errorCount: number;
    readonly warningCount: number;
}

/** Aggregate solver outcome for every sketch touched by the transaction. */
export interface SketchSolveSummary {
    readonly status: 'converged' | 'failed';
    readonly dof: number;
    readonly fullyConstrained: boolean;
    readonly conflicting: readonly string[];
    readonly redundant: readonly string[];
    readonly errorCount: number;
    readonly warningCount: number;
    readonly sketches: readonly SketchSolveStatus[];
}

/** A prepared sketch edit ready for a candidate build and review. */
export interface PreparedSketchEdit {
    /** Target sketch that carried the request. */
    readonly targetSketchId: string;
    readonly targetSketchName: string;
    /** Detached candidate document used for the preview build. */
    readonly afterDocument: NukeCadDocument;
    /** Snapshot per affected sketch before the edit, keyed by sketch id. */
    readonly beforeSketches: Readonly<Record<string, SketchDef>>;
    /** Resolved sketch definition per affected sketch after the edit. */
    readonly afterSketches: Readonly<Record<string, SketchDef>>;
    /** Document parameter values changed by this edit, before the edit. */
    readonly beforeParameters: Readonly<Record<string, number>>;
    /** Document parameter values changed by this edit, after the edit. */
    readonly afterParameters: Readonly<Record<string, number>>;
    readonly edits: readonly ResolvedSketchEdit[];
    readonly changes: readonly NukeChange[];
    readonly solver: SketchSolveSummary;
    readonly affectedSketchIds: readonly string[];
    readonly affectedFeatureIds: readonly string[];
}

/** Stable error codes returned by the transaction. */
export type SketchEditErrorCode =
    | 'invalid-input'
    | 'too-many-edits'
    | 'duplicate-edit'
    | 'multiple-sketches'
    | 'sketch-not-found'
    | 'dimension-not-found'
    | 'dimension-not-driving'
    | 'dimension-constraint-missing'
    | 'parameter-not-found'
    | 'parameter-not-referenced'
    | 'parameter-conflict'
    | 'value-not-finite'
    | 'value-unchanged'
    | 'solver-failed'
    | 'solve-conflicting'
    | 'curve-resample-failed'
    | 'document-validation-failed';

/** Result of {@link NukeCadSketchEditService.prepare}. */
export type SketchEditPrepareResult =
    | { readonly ok: true; readonly result: PreparedSketchEdit }
    | { readonly ok: false; readonly code: SketchEditErrorCode; readonly message: string };

/** Solver factory injected so tests and the browser can share the transaction. */
export type CreateSketchSolver = () => Promise<SketchSolver>;
