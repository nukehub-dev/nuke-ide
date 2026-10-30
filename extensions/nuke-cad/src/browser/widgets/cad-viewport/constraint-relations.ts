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
 * Valid geometric relations for a pair of sketch entities.
 *
 * Pure matrix used by the constraint context popover. The result is symmetric:
 * validRelations(a, b) === validRelations(b, a).
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import type { ConstraintKind } from '../../sketch/sketch-session';

/** Entity types supported by the constraint relation matrix. */
export type SketchEntityType = 'point' | 'line' | 'circle' | 'arc';

const POINT_POINT_RELATIONS: ReadonlyArray<ConstraintKind> = ['coincident'];
const POINT_CURVE_RELATIONS: ReadonlyArray<ConstraintKind> = ['pointOnObject'];
const LINE_LINE_RELATIONS: ReadonlyArray<ConstraintKind> = ['coincident', 'parallel', 'perpendicular', 'equal'];
const LINE_CURVE_RELATIONS: ReadonlyArray<ConstraintKind> = ['tangent', 'coincident'];
const CURVE_CURVE_RELATIONS: ReadonlyArray<ConstraintKind> = ['concentric', 'equal', 'tangent', 'coincident'];

/**
 * Return the valid constraint kinds for a pair of sketch entity types.
 *
 * The matrix intentionally omits single-entity constraints (horizontal,
 * vertical, fix), value-taking dimensions (distance, angle, radius, diameter),
 * and symmetry (which needs a third axis entity). A point paired with a curve
 * offers point-on-object (point-to-curve); point/point pairs offer coincident.
 * The returned array is stable and symmetric.
 */
export function validRelations(typeA: SketchEntityType, typeB: SketchEntityType): ConstraintKind[] {
    const a = normalize(typeA);
    const b = normalize(typeB);

    if (a === 'point' && b === 'point') {
        return [...POINT_POINT_RELATIONS];
    }
    if (a === 'point' || b === 'point') {
        return [...POINT_CURVE_RELATIONS];
    }
    if (a === 'line' && b === 'line') {
        return [...LINE_LINE_RELATIONS];
    }
    if (a === 'line' || b === 'line') {
        return [...LINE_CURVE_RELATIONS];
    }
    return [...CURVE_CURVE_RELATIONS];
}

/** Treat arcs as circles for relation purposes. */
function normalize(type: SketchEntityType): SketchEntityType {
    return type === 'arc' ? 'circle' : type;
}
