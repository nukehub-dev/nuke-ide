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
 * Material-legend helpers for the Model Outline's Document section.
 *
 * The legend lists the distinct in-CAD body material tags behind the
 * display-only `nukeCad.colorByMaterial` toggle. Tags dedupe
 * case-insensitively and keep their first spelling, matching the shared
 * `materialColor` normalization so one swatch represents one material.
 *
 * @module nuke-cad/browser/widgets
 */

import { type BodyDef } from '../../../common/cad-document';

/** Maximum material rows shown in the outline legend. */
export const MATERIAL_LEGEND_LIMIT = 8;

/**
 * Distinct, trimmed material tags in body order (case-insensitive dedupe,
 * first spelling wins). Blank and whitespace-only tags are skipped.
 */
export function collectMaterialTags(bodies: readonly BodyDef[]): string[] {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const body of bodies) {
        const tag = body.material?.trim();
        if (tag === undefined || tag.length === 0) {
            continue;
        }
        const key = tag.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        tags.push(tag);
    }
    return tags;
}
