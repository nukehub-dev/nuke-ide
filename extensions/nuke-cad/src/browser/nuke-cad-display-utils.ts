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
 * Display-only geometry utilities for the CAD viewport.
 *
 * These helpers keep viewport tessellation bounded for large models without
 * affecting DAGMC or FEM mesh export tolerances, which use the separate
 * ``nukeCad.facetingTolerance`` preference.
 *
 * @module nuke-cad/browser
 */

import type { CadBoundingBox, GeometryBuildResult, GeometryBuildRequest, BuildDocumentRequest } from '../common/nuke-cad-protocol';

/** Default display-only triangle budget. */
export const DEFAULT_MAX_DISPLAY_TRIANGLES = 2_000_000;

/** Default display-only faceting tolerance (coarser than the export default). */
export const DEFAULT_DISPLAY_FACETING_TOLERANCE = 0.01;

/**
 * Determine whether a build request is viewport-display-only.
 *
 * A request is treated as display-only when it does not explicitly request
 * DAGMC or FEM mesh export. Script builds default to export when neither flag
 * is set; STEP imports and ``.nuke-cad`` document builds default to display.
 *
 * @param sourceType - The resolved source kind: ``step`` for STEP imports,
 * ``script`` for Python scripts, or ``document`` for ``.nuke-cad`` documents.
 */
export function isDisplayBuild(request: GeometryBuildRequest | BuildDocumentRequest, sourceType: 'script' | 'step' | 'document'): boolean {
    if (request.exportDagmc === true || request.exportMesh === true) {
        return false;
    }
    if (request.exportDagmc === false || request.exportMesh === false) {
        return true;
    }
    return sourceType === 'step' || sourceType === 'document';
}

/**
 * Compute an axis-aligned bounding-box diagonal.
 *
 * Returns ``0`` when the box is missing or degenerate.
 */
export function boundingBoxDiagonal(boundingBox?: CadBoundingBox): number {
    if (!boundingBox) {
        return 0;
    }
    const min = boundingBox.min;
    const max = boundingBox.max;
    if (!Array.isArray(min) || !Array.isArray(max) || min.length < 3 || max.length < 3) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < 3; i++) {
        const d = max[i] - min[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

/**
 * Compute a display faceting tolerance that tries to keep triangle count under
 * the configured budget.
 *
 * The returned tolerance is never finer than ``displayTolerance``. When a
 * previous bounding box is available, a heuristic tolerance is derived from the
 * box diagonal assuming triangle count scales roughly with
 * ``(diagonal / tolerance)^2``. For the first open of a new model, or for
 * models with no prior bounding box, ``displayTolerance`` is used unchanged.
 */
export function computeDisplayTolerance(
    displayTolerance: number,
    maxDisplayTriangles: number,
    previousBoundingBox?: CadBoundingBox
): number {
    const diagonal = boundingBoxDiagonal(previousBoundingBox);
    if (diagonal <= 0 || maxDisplayTriangles <= 0) {
        return displayTolerance;
    }
    // Heuristic: target ~maxDisplayTriangles across the model bounding box.
    // The 0.5 factor is a safety margin; real OCP tessellation density depends
    // on surface curvature as well as the linear deflection.
    const heuristic = (diagonal / Math.sqrt(maxDisplayTriangles)) * 0.5;
    return Math.max(displayTolerance, heuristic);
}

/**
 * Build a user-facing warning when a display build exceeds the triangle budget.
 *
 * Returns ``undefined`` when the budget is respected or when no triangle count
 * is reported.
 */
export function formatTriangleBudgetWarning(triangleCount: number | undefined, maxDisplayTriangles: number): string | undefined {
    if (triangleCount === undefined || triangleCount <= maxDisplayTriangles) {
        return undefined;
    }
    const count = triangleCount.toLocaleString();
    const budget = maxDisplayTriangles.toLocaleString();
    return (
        `Viewport tessellation (${count} triangles) exceeds the display budget (${budget}). ` +
        'Increase "nukeCad.maxDisplayTriangles" or "nukeCad.displayFacetingTolerance" for finer display meshing; ' +
        'DAGMC and FEM export tolerances are unaffected.'
    );
}

/**
 * Attach a triangle-budget warning to a build result when appropriate.
 *
 * Returns a shallow copy of the result with an updated ``warnings`` array.
 */
export function withTriangleBudgetWarning(result: GeometryBuildResult, maxDisplayTriangles: number): GeometryBuildResult {
    const warning = formatTriangleBudgetWarning(result.triangleCount, maxDisplayTriangles);
    if (!warning) {
        return result;
    }
    return {
        ...result,
        warnings: [...(result.warnings ?? []), warning]
    };
}
