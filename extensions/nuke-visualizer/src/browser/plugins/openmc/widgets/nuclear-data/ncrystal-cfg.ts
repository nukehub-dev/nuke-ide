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
 * Pure helpers for the NCrystal cfg-string builder. NCrystal cfg strings
 * carry all parameters inline (`Al_sg225.ncmat;temp=300K;dcutoff=0.5Aa`) —
 * see openmc's `Material.from_ncrystal`. No DI/DOM dependencies.
 */

/** One cfg-builder field definition: state key, label, hint, placeholder */
export interface NcCfgField {
    key: string;
    label: string;
    hint: string;
    placeholder: string;
}

/** The fields offered by the builder, in display order. */
export const NC_CFG_FIELDS: readonly NcCfgField[] = [
    { key: 'temp', label: 'Temperature', hint: 'e.g. 300K, 600K — material temperature', placeholder: '300K' },
    { key: 'dcutoff', label: 'dcutoff', hint: 'Crystal d-spacing cutoff, e.g. 0.5Aa (Bragg edges below)', placeholder: '0.5Aa' },
    { key: 'dcutoffup', label: 'dcutoffup', hint: 'Upper d-spacing cutoff, e.g. 5Aa', placeholder: '' },
    { key: 'mosaicity', label: 'Mosaicity', hint: 'Crystal mosaic spread (FWHM), e.g. 2deg', placeholder: '' },
    { key: 'vdoslux', label: 'vdoslux', hint: 'Phonon expansion order 1–3 (higher = better low-E)', placeholder: '' }
];

/** Compose the cfg string from a base name and the builder field values. */
export function composeCfgString(base: string, fields: Record<string, string>): string {
    const parts = [base];
    for (const { key } of NC_CFG_FIELDS) {
        const value = (fields[key] ?? '').trim();
        if (value) {
            parts.push(`${key}=${value}`);
        }
    }
    return parts.join(';');
}
