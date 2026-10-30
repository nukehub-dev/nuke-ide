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
 * Visibility + selection contract between the native CSG geometry viewer
 * widget and the CSG Outline sidebar panel (DAGMC Outline parity for
 * `geometry.xml` models).
 *
 * Sync is single-direction with no duplicated state: the panel renders a
 * {@link CsgOutlineSnapshot} read from the active viewer and applies edits
 * through {@link CsgOutlineHost.applyCsgOutline} — the same visibility
 * setters the viewer footer used to make, plus the widget-owned canvas
 * selection. Widgets own every value; the panel never caches them. Display
 * settings (clip, opacity, background) stay in the Viewer Settings
 * sidebar — this panel owns visibility + selection only.
 *
 * Pure types + selection/filter helpers only; no three.js, no DOM, no Theia
 * imports.
 */

/** One cell row: the model label, enriched with material and visibility. */
export interface CsgOutlineCellEntry {
    readonly id: number;
    /** Display name shown once (`Cell <id> name`); the material rides as a muted suffix. */
    readonly label: string;
    readonly material: string;
    readonly visible: boolean;
    readonly selected: boolean;
}

/** One material row: checked while its hidden-set entry is absent. */
export interface CsgOutlineMaterialEntry {
    readonly name: string;
    readonly cellCount: number;
    readonly visible: boolean;
}

/**
 * Everything the outline panel renders for one active geometry viewer.
 * `hasDataset` is false before a model loads (rows hide, the title still
 * identifies the tab).
 */
export interface CsgOutlineSnapshot {
    readonly widgetId: string;
    readonly title: string;
    readonly hasDataset: boolean;
    readonly cells: readonly CsgOutlineCellEntry[];
    readonly materials: readonly CsgOutlineMaterialEntry[];
    readonly showVoid: boolean;
    readonly visibleCount: number;
    readonly totalCount: number;
    /**
     * Widget-owned canvas selection mirrored by the panel (outline row
     * clicks and canvas picks both route through the widget); null clears.
     */
    readonly selectedCellId: number | null;
}

/**
 * One outline edit. Every field is optional; hosts apply the fields they
 * support and ignore the rest. `showAll` clears every hidden-set (the void
 * switch is kept, mirroring the DAGMC graveyard rule).
 */
export interface CsgOutlinePatch {
    readonly toggleCell?: number;
    readonly toggleMaterial?: string;
    readonly showVoid?: boolean;
    readonly showAll?: boolean;
    /** Select a cell in the canvas (null clears); the widget owns the value. */
    readonly selectCell?: number | null;
}

/** Structural surface a geometry viewer widget exposes to the outline panel (bound once, not per viewer). */
export interface CsgOutlineHost {
    /** Read the current outline; undefined when the widget cannot report any (never for open viewers). */
    getCsgOutlineSnapshot(): CsgOutlineSnapshot | undefined;
    /** Apply an outline edit through the widget's existing visibility setters. */
    applyCsgOutline(patch: CsgOutlinePatch): void;
}

/**
 * Base widget ids bound to the outline panel. Open instances append
 * `:<path>` to the base id (`setModelFile`); tally overlay tabs bind for
 * their CSG underlay (`tally-native-viewer-widget:<kind>:<stamp>`).
 */
export const CSG_OUTLINE_WIDGET_IDS: readonly string[] = ['geometry-native-viewer-widget', 'tally-native-viewer-widget'];

/** Whether a widget id belongs to a viewer bound to the outline panel (instance suffixes included). */
export function isCsgOutlineWidgetId(id: string): boolean {
    return CSG_OUTLINE_WIDGET_IDS.some((base) => id === base || id.startsWith(`${base}:`));
}

/**
 * Pick the widget id the panel binds to: the active tab wins, otherwise the
 * current tab, otherwise the main area's selected tab, otherwise nothing
 * (empty state). The main-area fallback is focus-independent — shell
 * activation/current events only track focus, so a viewer opened, restored,
 * or finished loading without a focus change would otherwise leave the
 * panel in its empty state while its tab sits open in the main area.
 * Non-viewer ids never match.
 */
export function resolveCsgOutlineTargetId(
    activeId: string | undefined,
    currentId: string | undefined,
    mainId?: string | undefined
): string | undefined {
    if (activeId !== undefined && isCsgOutlineWidgetId(activeId)) {
        return activeId;
    }
    if (currentId !== undefined && isCsgOutlineWidgetId(currentId)) {
        return currentId;
    }
    if (mainId !== undefined && isCsgOutlineWidgetId(mainId)) {
        return mainId;
    }
    return undefined;
}

/**
 * Case-insensitive substring match for the outline search filter.
 * Blank queries match everything, so large cell lists stay browsable.
 */
export function matchesCsgOutlineQuery(value: string, query: string): boolean {
    const q = query.trim().toLowerCase();
    return q.length === 0 || value.toLowerCase().includes(q);
}

/** Whether a cell row survives the search filter (label and material are both searchable). */
export function csgOutlineCellMatches(entry: CsgOutlineCellEntry, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
        return true;
    }
    return matchesCsgOutlineQuery(entry.label, query) || matchesCsgOutlineQuery(entry.material, query);
}

/** Build the panel status line (`N of M cells (K materials)`). */
export function describeCsgOutlineCounts(visibleCells: number, totalCells: number, materialCount: number): string {
    return `${visibleCells} of ${totalCells} cells (${materialCount} materials)`;
}
