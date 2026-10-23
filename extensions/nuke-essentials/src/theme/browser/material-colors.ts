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
 * Deterministic categorical colors for material/category names (DAGMC
 * color-by and outline swatches).
 *
 * Keys normalize to trimmed lower case before hashing with FNV-1a, so
 * `Fuel`, `fuel`, and `  FUEL ` always land on the same palette entry and
 * rebuilt viewers never reshuffle the colors. The graveyard termination
 * material is special-cased to a muted grey. Pure: no DOM, no Theia imports.
 */

/** Ten-color accessible categorical palette (Tableau-10). */
export const MATERIAL_PALETTE: readonly string[] = [
    '#4e79a7',
    '#f28e2b',
    '#e15759',
    '#76b7b2',
    '#59a14f',
    '#edc948',
    '#b07aa1',
    '#ff9da7',
    '#9c755f',
    '#bab0ac'
];

/** Muted swatch reserved for the graveyard termination material. */
export const GRAVEYARD_MATERIAL_COLOR = '#8c8c8c';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Normalize a category key for hashing and map keys. */
function normalizeCategoryKey(key: string): string {
    return key.trim().toLowerCase();
}

/** 32-bit FNV-1a hash of a normalized category key. */
function fnv1a(value: string): number {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash >>> 0;
}

/**
 * Deterministic categorical color for an arbitrary category key (volume id or
 * group name). Undefined for empty or missing keys.
 */
export function categoryColor(key: string | undefined): string | undefined {
    if (key === undefined) {
        return undefined;
    }
    const normalized = normalizeCategoryKey(key);
    if (normalized.length === 0) {
        return undefined;
    }
    return MATERIAL_PALETTE[fnv1a(normalized) % MATERIAL_PALETTE.length];
}

/**
 * Deterministic categorical color for a material name. Undefined for empty
 * or missing names; the graveyard termination material is muted grey.
 */
export function materialColor(name: string | undefined): string | undefined {
    if (name !== undefined && normalizeCategoryKey(name) === 'graveyard') {
        return GRAVEYARD_MATERIAL_COLOR;
    }
    return categoryColor(name);
}

/** Color map keyed by normalized material names (last duplicate wins; undefined/blank names skipped). */
export function materialColorMap(names: Iterable<string>): Map<string, string> {
    const colors = new Map<string, string>();
    for (const name of names) {
        const color = materialColor(name);
        if (color !== undefined) {
            colors.set(normalizeCategoryKey(name), color);
        }
    }
    return colors;
}
