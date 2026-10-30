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

import { categoryColor, materialColor } from 'nuke-essentials/lib/theme/browser/material-colors';
import type { DagmcModelInfo } from '../plugins/openmc/widgets/dagmc/dagmc-toggle-model';

/**
 * Visibility + selection contract between the native DAGMC viewer widget
 * and the DAGMC Outline sidebar panel.
 *
 * Sync is single-direction with no duplicated state: the panel renders a
 * {@link DagmcOutlineSnapshot} read from the active viewer and applies edits
 * through {@link DagmcOutlineHost.applyDagmcOutline} — the same toggle-model
 * calls the viewer footer used to make, plus the widget-owned canvas
 * selection. Widgets own every value; the panel never caches them.
 * Material/group sections are absent without model info
 * (the `dagmc.info` payload); volume rows then fall back to the loaded
 * block names (`Volume_<id>`), which stay toggleable through the same
 * hidden-volumes set. Display settings (color-by, shading, clip) stay in the
 * Viewer Settings sidebar — this panel owns visibility + selection only.
 *
 * Pure types + selection/filter helpers only; no three.js, no DOM, no Theia
 * imports.
 */

/** One volume row: a `Volume_<id>` block, enriched with model info when available. */
export interface DagmcOutlineVolumeEntry {
    readonly id: number;
    /**
     * Collapsed display name shown once (`Volume <id>`); the material rides
     * as a muted suffix in the row, never repeated inside the label.
     */
    readonly label: string;
    readonly material: string | undefined;
    readonly groups: readonly string[];
    readonly visible: boolean;
    readonly selected: boolean;
}

/** One material or group row: checked while its hidden-set entry is absent. */
export interface DagmcOutlineNamedEntry {
    readonly name: string;
    readonly volumeCount: number;
    readonly visible: boolean;
    /**
     * Deterministic swatch color for material and group rows (the same
     * categorical color the viewer paints in Material or Group mode);
     * unmapped entries leave it unset.
     */
    readonly color?: string;
}

/**
 * Material row including its deterministic swatch color from the shared
 * `materialColor` palette, so the outline and the canvas agree.
 */
export function createDagmcOutlineMaterialEntry(name: string, volumeCount: number, visible: boolean): DagmcOutlineNamedEntry {
    return { name, volumeCount, visible, color: materialColor(name) };
}

/**
 * Group row including its deterministic swatch color from the shared
 * `categoryColor` palette (`group:<name>`, the same key Group mode paints).
 */
export function createDagmcOutlineGroupEntry(name: string, volumeCount: number, visible: boolean): DagmcOutlineNamedEntry {
    return { name, volumeCount, visible, color: categoryColor(`group:${name}`) };
}

/**
 * Everything the outline panel renders for one active DAGMC viewer.
 * `hasDataset` is false before a manifest loads (rows hide, the title still
 * identifies the tab); `hasModelInfo` is false without the `dagmc.info`
 * payload (material/group sections hide, volumes come from block names).
 */
export interface DagmcOutlineSnapshot {
    readonly widgetId: string;
    readonly title: string;
    readonly hasDataset: boolean;
    readonly hasModelInfo: boolean;
    readonly volumes: readonly DagmcOutlineVolumeEntry[];
    readonly materials: readonly DagmcOutlineNamedEntry[];
    readonly groups: readonly DagmcOutlineNamedEntry[];
    readonly showGraveyard: boolean;
    readonly visibleCount: number;
    readonly totalCount: number;
    /**
     * Widget-owned canvas selection mirrored by the panel (outline row
     * clicks and canvas picks both route through the widget); null clears.
     */
    readonly selectedVolumeId: number | null;
}

/**
 * One outline edit. Every field is optional; hosts apply the fields they
 * support and ignore the rest. Toggles reuse the `dagmc-toggle-model`
 * visibility algebra; `showAll` clears every hidden-set (graveyard kept),
 * `hideAll` sets the hidden-volume set to every known id, and
 * `focusVolume` frames one visible volume without changing visibility.
 */
export interface DagmcOutlinePatch {
    readonly toggleVolume?: number;
    readonly toggleMaterial?: string;
    readonly toggleGroup?: string;
    readonly showGraveyard?: boolean;
    readonly showAll?: boolean;
    /** Hide every known volume (material/group/graveyard switches untouched). */
    readonly hideAll?: boolean;
    /** Frame one volume's visible blocks in the canvas; hidden or unknown ids are a no-op. */
    readonly focusVolume?: number;
    /** Select a volume in the canvas (null clears); the widget owns the value. */
    readonly selectVolume?: number | null;
}

/** Structural surface a DAGMC viewer widget exposes to the outline panel (bound once, not per viewer). */
export interface DagmcOutlineHost {
    /** Read the current outline; undefined when the widget cannot report any (never for open viewers). */
    getDagmcOutlineSnapshot(): DagmcOutlineSnapshot | undefined;
    /** Apply an outline edit through the widget's existing visibility setters. */
    applyDagmcOutline(patch: DagmcOutlinePatch): void;
}

/**
 * Base widget ids bound to the outline panel. Open instances append
 * `:<path>` to the base id (`setVtmFile`).
 */
export const DAGMC_OUTLINE_WIDGET_IDS: readonly string[] = ['dagmc-viewer-widget'];

/** Whether a widget id belongs to a viewer bound to the outline panel (instance suffixes included). */
export function isDagmcOutlineWidgetId(id: string): boolean {
    return DAGMC_OUTLINE_WIDGET_IDS.some((base) => id === base || id.startsWith(`${base}:`));
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
export function resolveDagmcOutlineTargetId(
    activeId: string | undefined,
    currentId: string | undefined,
    mainId?: string | undefined
): string | undefined {
    if (activeId !== undefined && isDagmcOutlineWidgetId(activeId)) {
        return activeId;
    }
    if (currentId !== undefined && isDagmcOutlineWidgetId(currentId)) {
        return currentId;
    }
    if (mainId !== undefined && isDagmcOutlineWidgetId(mainId)) {
        return mainId;
    }
    return undefined;
}

/**
 * Case-insensitive substring match for the outline search filter.
 * Blank queries match everything, so 20+-volume models stay browsable.
 */
export function matchesDagmcOutlineQuery(value: string, query: string): boolean {
    const q = query.trim().toLowerCase();
    return q.length === 0 || value.toLowerCase().includes(q);
}

/** Whether a volume row survives the search filter (label, material, and groups are all searchable). */
export function dagmcOutlineVolumeMatches(entry: DagmcOutlineVolumeEntry, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
        return true;
    }
    return (
        matchesDagmcOutlineQuery(entry.label, query) ||
        (entry.material !== undefined && matchesDagmcOutlineQuery(entry.material, query)) ||
        entry.groups.some((group) => matchesDagmcOutlineQuery(group, query))
    );
}

/**
 * Collapsed volume display name: the human name once (`Volume <id>`). The
 * material is NOT repeated inside the label — the panel renders it as a
 * muted suffix — so `Volume 1 (mat_0) [mat:mat_0]`-style duplication from
 * the group suffix can never reappear. Groups stay searchable through the
 * entry's `groups`, not the label.
 */
export function formatDagmcOutlineVolumeLabel(id: number): string {
    return `Volume ${id}`;
}

/** Build the panel status line from model info and block counts (`N of M volumes (P materials, G groups)`). */
export function describeDagmcOutlineCounts(info: DagmcModelInfo | undefined, totalBlocks: number, visibleBlocks: number): string {
    if (!info) {
        return `${visibleBlocks} of ${totalBlocks} volumes (no model info)`;
    }
    return `${visibleBlocks} of ${totalBlocks} volumes (${Object.keys(info.materials).length} materials, ${Object.keys(info.groups).length} groups)`;
}
