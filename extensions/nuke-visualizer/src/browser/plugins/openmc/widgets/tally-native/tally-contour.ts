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
 * Contour state for the native tally viewer (`openmc.tally-contour`).
 *
 * Iso values are entered numerically (one call extracts every value as a
 * surface in a single `.vtp`); the sibling contour tab opens through the
 * existing `openTallyNativeWidget` routing, so warp/threshold keep working
 * there through the inherited native-base funnels.
 *
 * Pure functions + types only; no DOM, no DI, no three.js.
 */

/** Iso-value count cap per contour call (mirrors the backend `CONTOUR_MAX_ISO_VALUES`). */
export const CONTOUR_MAX_ISO_VALUES = 8;

/** Parse one iso value: finite numbers only, anything else is undefined. */
export function parseContourIsoValue(text: string): number | undefined {
    const value = Number(text.trim());
    return text.trim() !== '' && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse iso values from free text (`1 2.5, 4` or `1; 2.5; 4`, in tally
 * units). Returns undefined unless at least one value parses finite.
 */
export function parseContourIsoValues(text: string): number[] | undefined {
    const parts = text.split(/[\s,;]+/).filter((part) => part !== '');
    if (parts.length === 0) {
        return undefined;
    }
    const values = parts.map(parseContourIsoValue);
    if (values.some((value) => value === undefined)) {
        return undefined;
    }
    return values as number[];
}

/** Format iso values for the text input (full precision round-trip). */
export function formatContourIsoValues(values: readonly number[]): string {
    return values.map((value) => String(value)).join(', ');
}

/** One-line summary for the contour run (`iso 20, 50 (smooth) · tally 4`). */
export function describeContourRequest(isoValues: readonly number[], smooth: boolean, tallyId: string): string {
    const iso = `iso ${formatContourIsoValues(isoValues)} (${smooth ? 'smooth' : 'pixelated'})`;
    return tallyId.trim() !== '' ? `${iso} · tally ${tallyId.trim()}` : iso;
}
