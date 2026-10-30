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
 * Presentational model for the W7-X native coil shape-study dialog.
 *
 * The dialog edits the five numeric parameters that feed every native
 * `coilSweep`; this module owns their string-state draft, validation, and the
 * stable copy (module summary, approximate warning, reference volume). The
 * persistent banner text lives in `w7x-study-model.ts` beside the count-study
 * banner so both design-study kinds share one renderer.
 *
 * @module nuke-cad/browser/widgets
 */

import {
    W7X_SHAPE_DEFAULTS,
    W7X_SHAPE_MAX_STATIONS,
    W7X_SHAPE_MAX_TILT_DEG,
    W7X_SHAPE_MIN_STATIONS,
    W7X_SHAPE_MIN_TILT_DEG,
    W7X_SHAPE_REFERENCE_VOLUME_M3,
    type W7xShapeStudyConfig
} from '../../../common/w7x-shape-study';

/** Read-only inventory line shown above the dialog fields. */
export const W7X_SHAPE_STUDY_INVENTORY = '5 modules · 50 coils · 10 native bodies';

/** Approximate-geometry warning repeated in the dialog and banner. */
export const W7X_SHAPE_STUDY_APPROXIMATE_WARNING = 'Approximate native sweeps — not the reference B-rep';

/** Dialog footnote explaining that coil sweeps have no ghost preview yet. */
export const W7X_SHAPE_STUDY_NO_PREVIEW_NOTE = 'Coil sweeps have no live preview in this release.';

/** Banner title for a shape-study document. */
export const W7X_SHAPE_STUDY_BANNER_TITLE = 'W7-X coil shape study · 5 modules';

/** Banner status label; the geometry is approximate, not invalid. */
export const W7X_SHAPE_STUDY_BANNER_STATUS = 'Approximate coils';

/** Banner warning line for the native sweeps. */
export const W7X_SHAPE_STUDY_BANNER_WARNING = 'Native sweeps approximate the reference B-rep.';

/** Dialog draft kept as strings so every intermediate keystroke is editable. */
export interface W7xShapeStudyDraft {
    readonly width: string;
    readonly height: string;
    readonly tiltDeg: string;
    readonly twistDeg: string;
    readonly stations: string;
}

export type W7xShapeStudyDraftValidation =
    { readonly ok: true; readonly config: W7xShapeStudyConfig } | { readonly ok: false; readonly error: string };

/** Build the dialog draft from a config, defaulting to the planner defaults. */
export function defaultW7xShapeStudyDraft(config: W7xShapeStudyConfig = W7X_SHAPE_DEFAULTS): W7xShapeStudyDraft {
    return {
        width: String(config.width),
        height: String(config.height),
        tiltDeg: String(config.tiltDeg),
        twistDeg: String(config.twistDeg),
        stations: String(config.stations)
    };
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
 * Validate the shape-study dialog draft.
 *
 * Mirrors the planner/schema rules: positive finite width and height, finite
 * tilt in [-89, 89], finite twist, and integer stations in [8, 720]. Nothing
 * is clamped; an invalid field reports a field-specific message.
 */
export function validateW7xShapeStudyDraft(draft: W7xShapeStudyDraft): W7xShapeStudyDraftValidation {
    const width = parseRequiredNumber(draft.width);
    if (width === undefined || width <= 0) {
        return { ok: false, error: 'Section width must be a positive number.' };
    }
    const height = parseRequiredNumber(draft.height);
    if (height === undefined || height <= 0) {
        return { ok: false, error: 'Section height must be a positive number.' };
    }
    const tiltDeg = parseRequiredNumber(draft.tiltDeg);
    if (tiltDeg === undefined || tiltDeg < W7X_SHAPE_MIN_TILT_DEG || tiltDeg > W7X_SHAPE_MAX_TILT_DEG) {
        return { ok: false, error: `Tilt must be between ${W7X_SHAPE_MIN_TILT_DEG} and ${W7X_SHAPE_MAX_TILT_DEG} degrees.` };
    }
    const twistDeg = parseRequiredNumber(draft.twistDeg);
    if (twistDeg === undefined) {
        return { ok: false, error: 'Twist must be a finite number of degrees.' };
    }
    const stations = parseRequiredNumber(draft.stations);
    if (stations === undefined || !Number.isInteger(stations) || stations < W7X_SHAPE_MIN_STATIONS || stations > W7X_SHAPE_MAX_STATIONS) {
        return {
            ok: false,
            error: `Stations must be a whole number between ${W7X_SHAPE_MIN_STATIONS} and ${W7X_SHAPE_MAX_STATIONS}.`
        };
    }
    return { ok: true, config: { width, height, tiltDeg, twistDeg, stations } };
}

/** Format the one-module reference coil volume for the dialog's display-only row. */
export function formatW7xShapeStudyReferenceVolume(volumeM3: number = W7X_SHAPE_REFERENCE_VOLUME_M3): string {
    return `${volumeM3.toFixed(9)} m³`;
}
