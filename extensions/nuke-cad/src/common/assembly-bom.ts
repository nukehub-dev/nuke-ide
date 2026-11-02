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
 * Bill-of-materials quantity delta for assembly edits.
 *
 * Quantities group by the exact instance `part` source string (a document
 * path, an embedded `body:<id>` reference, or an exchange-file path), so two
 * instances of the same source are one BOM row. Rows cover every part present
 * before or after the edit — including unchanged rows — so the preview panel
 * can show the full before/after table with zero deltas inline.
 *
 * Pure TypeScript with no build or backend dependency.
 *
 * @module nuke-cad/common
 */

import type { NukeCadAssembly } from './cad-document';

/** One BOM quantity row for an exact part source string. */
export interface AssemblyBomQuantityRow {
    /** Exact instance `part` source string. */
    readonly part: string;
    readonly before: number;
    readonly after: number;
    readonly delta: number;
}

/** Quantity and grounding delta between two assembly sections. */
export interface AssemblyBomDelta {
    /** Every part present before or after the edit, sorted by part string. */
    readonly rows: readonly AssemblyBomQuantityRow[];
    /** Total instance count before the edit. */
    readonly beforeTotal: number;
    /** Total instance count after the edit. */
    readonly afterTotal: number;
    /** Grounded instance id before the edit ('' when absent). */
    readonly groundedBefore: string;
    /** Grounded instance id after the edit ('' when absent). */
    readonly groundedAfter: string;
}

function countParts(assembly: NukeCadAssembly | undefined): Map<string, number> {
    const counts = new Map<string, number>();
    if (assembly === undefined) {
        return counts;
    }
    for (const instance of assembly.instances) {
        counts.set(instance.part, (counts.get(instance.part) ?? 0) + 1);
    }
    return counts;
}

/**
 * Build the BOM quantity delta between two assembly sections.
 *
 * `after` is the candidate section; either side may be absent (a single-part
 * document). Rows are sorted by exact part string rather than relying on
 * insertion or locale order, so preview output is stable across runs.
 */
export function buildAssemblyBomDelta(before: NukeCadAssembly | undefined, after: NukeCadAssembly | undefined): AssemblyBomDelta {
    const beforeCounts = countParts(before);
    const afterCounts = countParts(after);
    const parts = new Set<string>([...beforeCounts.keys(), ...afterCounts.keys()]);
    const rows = [...parts]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((part) => {
            const beforeCount = beforeCounts.get(part) ?? 0;
            const afterCount = afterCounts.get(part) ?? 0;
            return {
                part,
                before: beforeCount,
                after: afterCount,
                delta: afterCount - beforeCount
            };
        });

    let beforeTotal = 0;
    for (const count of beforeCounts.values()) {
        beforeTotal += count;
    }
    let afterTotal = 0;
    for (const count of afterCounts.values()) {
        afterTotal += count;
    }

    return {
        rows,
        beforeTotal,
        afterTotal,
        groundedBefore: before?.groundedInstanceId ?? '',
        groundedAfter: after?.groundedInstanceId ?? ''
    };
}
