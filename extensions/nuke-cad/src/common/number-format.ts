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
 * Shared decimal formatting for length/angle readouts.
 *
 * Kept free of DOM/Theia imports so both the viewport overlay and the Model
 * Outline use one rounding/trimming rule. The precision preference caps the
 * rendered decimal places; trailing zeros always stay trimmed so the default
 * output reads `5` / `2.5`, never `5.00` / `2.50`.
 *
 * @module nuke-cad/common
 */

/** Smallest/largest decimal-place counts accepted by the precision settings. */
export const MIN_DECIMALS = 0;
export const MAX_DECIMALS = 6;

/** Clamp a decimal-place count to the supported 0–6 range, truncating fractions. */
export function clampDecimals(decimals: number): number {
    if (!Number.isFinite(decimals)) {
        return MIN_DECIMALS;
    }
    return Math.min(MAX_DECIMALS, Math.max(MIN_DECIMALS, Math.trunc(decimals)));
}

/**
 * Format a finite number with at most `decimals` decimal places, rounding and
 * trimming trailing zeros. Non-finite values render as an em dash; a rounded
 * `-0` renders as `0` instead of `-0`.
 */
export function formatDecimal(value: number, decimals: number): string {
    if (!Number.isFinite(value)) {
        return '—';
    }
    const digits = clampDecimals(decimals);
    let text = value.toFixed(digits);
    if (text.includes('.')) {
        text = text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return text === '-0' ? '0' : text;
}
