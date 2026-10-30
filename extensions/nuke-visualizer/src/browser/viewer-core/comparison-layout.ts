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
 * Pure pane-placement model for the Comparison workspace.
 *
 * The first selected pane keeps its position; every other pane is docked
 * relative to an already placed pane. Two and three panes form one horizontal
 * row, four panes form a 2x2 grid:
 *
 * ```
 * 2 panes:  A | B
 * 3 panes:  A | B | C
 * 4 panes:  A | B
 *           C | D
 * ```
 *
 * Placements are returned in pane order and always target a later pane than
 * their `ref`, so callers may dock them in groups as long as each `ref` is
 * placed first. The comparison contribution docks bottom splits before right
 * splits so four panes land in a true 2x2 grid.
 *
 * Pure data only; no Theia imports.
 */

/** Split direction used to dock one comparison pane next to another. */
export type ComparisonPaneSplit = 'split-right' | 'split-bottom';

/** One docking step: place `pane` by splitting `ref` in `mode`. */
export interface ComparisonPanePlacement {
    /** Zero-based index of the pane to dock. */
    readonly pane: number;
    /** Zero-based index of the already placed pane it splits from. */
    readonly ref: number;
    readonly mode: ComparisonPaneSplit;
}

/** Smallest supported comparison. */
const MIN_COMPARISON_PANES = 2;

/** Largest supported comparison (the 2x2 grid). */
const MAX_COMPARISON_PANES = 4;

/**
 * Docking steps for a validated pane count.
 *
 * - 2 or 3 panes: each pane splits right of the previous one.
 * - 4 panes: B splits right of A, C splits bottom of A, D splits right of C.
 *
 * @throws RangeError when `viewCount` is not an integer between 2 and 4.
 */
export function comparisonPanePlacements(viewCount: number): readonly ComparisonPanePlacement[] {
    if (!Number.isInteger(viewCount) || viewCount < MIN_COMPARISON_PANES || viewCount > MAX_COMPARISON_PANES) {
        throw new RangeError(`Comparison layout needs 2-4 panes, received ${viewCount}.`);
    }

    if (viewCount === MAX_COMPARISON_PANES) {
        return [
            { pane: 1, ref: 0, mode: 'split-right' },
            { pane: 2, ref: 0, mode: 'split-bottom' },
            { pane: 3, ref: 2, mode: 'split-right' }
        ];
    }

    const placements: ComparisonPanePlacement[] = [];
    for (let pane = 1; pane < viewCount; pane++) {
        placements.push({ pane, ref: pane - 1, mode: 'split-right' });
    }
    return placements;
}
