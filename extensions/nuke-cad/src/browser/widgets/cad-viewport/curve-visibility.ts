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
 * Curve visibility against the hidden-solids set.
 *
 * Document curves (sweep/pipe paths) are construction geometry with no solid
 * of their own, so the Model Outline hide/isolate actions used to leave them
 * on screen: hiding the copper body left the full W7X centerline loop
 * floating in an empty viewport. A curve hides exactly when every body that
 * consumes it as a sweep/pipe path is fully hidden; unreferenced curves are
 * always shown (the Feature Tree owns their lifetime via delete/rename).
 *
 * Pure set math — no three.js or Theia imports, so vitest covers it.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

/** One sweep/pipe path consumption: the named body is built along the curve. */
export interface CurvePathUser {
    readonly curveId: string;
    readonly bodyId: string;
}

/**
 * Bodies with at least one tessellated solid where every solid is hidden. A
 * body with no tessellated solids (unbuilt or failed features) never counts
 * as hidden — construction geometry must not vanish because of a build
 * failure elsewhere.
 */
export function hiddenBodyIds(solidToBody: ReadonlyMap<number, string>, hiddenSolidIds: ReadonlySet<number>): ReadonlySet<string> {
    const seen = new Map<string, boolean>();
    for (const [solidId, bodyId] of solidToBody) {
        const hidden = hiddenSolidIds.has(solidId);
        seen.set(bodyId, (seen.get(bodyId) ?? true) && hidden);
    }
    const hidden = new Set<string>();
    for (const [bodyId, allHidden] of seen) {
        if (allHidden) {
            hidden.add(bodyId);
        }
    }
    return hidden;
}

/**
 * Plan which document curves stay visible. `curveIds` is every curve in the
 * tessellation payload; `pathUsers` pairs each sweep/pipe feature's path
 * curve with the body it builds.
 */
export function visibleCurveIds(
    curveIds: readonly string[],
    pathUsers: readonly CurvePathUser[],
    solidToBody: ReadonlyMap<number, string>,
    hiddenSolidIds: ReadonlySet<number>
): ReadonlySet<string> {
    const hidden = hiddenBodyIds(solidToBody, hiddenSolidIds);
    const usersByCurve = new Map<string, string[]>();
    for (const user of pathUsers) {
        const users = usersByCurve.get(user.curveId);
        if (users === undefined) {
            usersByCurve.set(user.curveId, [user.bodyId]);
        } else {
            users.push(user.bodyId);
        }
    }
    const visible = new Set<string>();
    for (const curveId of curveIds) {
        const users = usersByCurve.get(curveId);
        if (users === undefined || users.some((bodyId) => !hidden.has(bodyId))) {
            visible.add(curveId);
        }
    }
    return visible;
}
