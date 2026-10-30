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
 * Pure helpers for the coil-sweep feature dialog.
 *
 * The dialog keeps its draft state as strings; {@link validateCoilSweepDraft}
 * turns that draft into validated schema params (mirroring the `coilSweep`
 * rules in `cad-document.ts`) and {@link coilSweepDraftFromParams} prefills
 * the fields when an existing feature is edited. There is no ghost preview for
 * coil sweeps in this tranche, so no preview document is assembled here.
 *
 * @module nuke-cad/browser/widgets
 */

import { type CoilSweepParams, type CurveDef } from '../../../common/cad-document';

/** String-state draft of a coil-sweep dialog. */
export interface CoilSweepDraft {
    /** Selected centerline curve id (may be empty while the user is choosing). */
    readonly pathCurveId: string;
    /** Rectangular section width as entered. */
    readonly width: string;
    /** Rectangular section height as entered. */
    readonly height: string;
    /** Constant section tilt from the tangent-normal plane, degrees. */
    readonly tiltDeg: string;
    /** Total twist around the path, degrees. */
    readonly twistDeg: string;
    /** Loft stations along the curve. */
    readonly stations: string;
}

export type CoilSweepValidation = { readonly ok: true; readonly params: CoilSweepParams } | { readonly ok: false; readonly error: string };

/** Dialog defaults for a fresh coil sweep: unit square section, no tilt/twist, 60 stations. */
export function defaultCoilSweepDraft(): CoilSweepDraft {
    return { pathCurveId: '', width: '1', height: '1', tiltDeg: '0', twistDeg: '0', stations: '60' };
}

/** Parse a required numeric field; blank input is invalid instead of silently becoming zero. */
function parseRequiredNumber(text: string): number | undefined {
    if (text.trim().length === 0) {
        return undefined;
    }
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
}

/**
 * Validate a coil-sweep dialog draft and produce the schema params.
 *
 * Mirrors the schema rules: a non-empty path curve that exists in the
 * document, positive finite width/height, finite tilt in [-89, 89], finite
 * twist, and integer stations in [8, 720]. Nothing is clamped.
 */
export function validateCoilSweepDraft(draft: CoilSweepDraft, curves: readonly CurveDef[]): CoilSweepValidation {
    if (draft.pathCurveId.length === 0) {
        return { ok: false, error: 'Select a path curve.' };
    }
    if (!curves.some((curve) => curve.id === draft.pathCurveId)) {
        return { ok: false, error: `Path curve '${draft.pathCurveId}' does not exist in this document.` };
    }
    const width = parseRequiredNumber(draft.width);
    if (width === undefined || width <= 0) {
        return { ok: false, error: 'Width must be a positive number.' };
    }
    const height = parseRequiredNumber(draft.height);
    if (height === undefined || height <= 0) {
        return { ok: false, error: 'Height must be a positive number.' };
    }
    const tiltDeg = parseRequiredNumber(draft.tiltDeg);
    if (tiltDeg === undefined || tiltDeg < -89 || tiltDeg > 89) {
        return { ok: false, error: 'Tilt must be between -89 and 89 degrees.' };
    }
    const twistDeg = parseRequiredNumber(draft.twistDeg);
    if (twistDeg === undefined) {
        return { ok: false, error: 'Twist must be a finite number of degrees.' };
    }
    const stations = parseRequiredNumber(draft.stations);
    if (stations === undefined || !Number.isInteger(stations) || stations < 8 || stations > 720) {
        return { ok: false, error: 'Stations must be a whole number between 8 and 720.' };
    }
    return {
        ok: true,
        params: { pathCurveId: draft.pathCurveId, width, height, tiltDeg, twistDeg, stations }
    };
}

/** Coil-sweep draft prefilled from an existing feature's params (edit-parameters flow). */
export function coilSweepDraftFromParams(params: Record<string, unknown>): CoilSweepDraft {
    const defaults = defaultCoilSweepDraft();
    return {
        pathCurveId: typeof params.pathCurveId === 'string' ? params.pathCurveId : '',
        width: params.width !== undefined ? String(params.width) : defaults.width,
        height: params.height !== undefined ? String(params.height) : defaults.height,
        tiltDeg: params.tiltDeg !== undefined ? String(params.tiltDeg) : defaults.tiltDeg,
        twistDeg: params.twistDeg !== undefined ? String(params.twistDeg) : defaults.twistDeg,
        stations: params.stations !== undefined ? String(params.stations) : defaults.stations
    };
}
