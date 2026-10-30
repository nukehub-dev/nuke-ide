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
 * Pure helpers behind the Model Outline panel's Parameters spreadsheet
 * section: parameter-row sorting and the BOM CSV export.
 *
 * Rows (`ParameterUsage`) come from `CadDocumentStore.collectParameterUsages`;
 * BOM rows join the manifest volumes + selector map (the same inputs the
 * outline list renders) with the `SolidSummary` data already published to
 * `NukeCadStateManager`. Kept free of Theia/React imports so vitest can
 * exercise it directly.
 *
 * @module nuke-cad/browser/widgets/outline-panel
 */

import type { ParameterUsage } from '../../document/cad-document-store';
import type { SolidSummary } from '../../state/nuke-cad-state-manager';

export type ParamSortKey = 'name' | 'value' | 'usedBy';

/** Sort parameter rows; ties break by name so the order is stable. */
export function compareParamRows(a: ParameterUsage, b: ParameterUsage, key: ParamSortKey, descending: boolean): number {
    let result: number;
    if (key === 'name') {
        result = a.name.localeCompare(b.name);
    } else if (key === 'value') {
        result = a.value - b.value;
    } else {
        result = a.usedBy.length - b.usedBy.length;
    }
    if (result === 0 && key !== 'name') {
        result = a.name.localeCompare(b.name);
    }
    return descending ? -result : result;
}

/** One-line summary of a parameter's referrers for the used-by cell tooltip. */
export function describeParamUsage(usage: ParameterUsage): string {
    if (usage.usedBy.length === 0) {
        return 'Not referenced by any sketch, curve, or feature';
    }
    return usage.usedBy.map((referrer) => `${referrer.kind} '${referrer.label}' (${referrer.detail})`).join('\n');
}

/** Structural subset of a manifest volume needed for the BOM export. */
export interface BomSourceVolume {
    readonly selector: string;
    readonly name?: string;
    readonly material?: string;
}

/** Manifest side of the BOM export (mirrors what the outline list renders). */
export interface BomSourceModel {
    readonly volumes: readonly BomSourceVolume[];
    readonly selectorMap: Record<string, number[]>;
}

/** One BOM CSV data row: `{instance/body, label, material, volume}`. */
export interface BomCsvRow {
    /** Manifest selector keying the solid (`<instance>/<label>` for assemblies), else `mat_<id>`. */
    readonly instance: string;
    /** Manifest volume name (or the selector when unnamed). */
    readonly label: string;
    /** Manifest material, else the in-CAD body tag, else empty. */
    readonly material: string;
    /** Solid volume in model units, or empty when the payload omits it. */
    readonly volume: string;
}

/**
 * Build one BOM row per built solid (solid-id order), joining the manifest
 * label/material through the inverted selector map with the mesh summary.
 * Manifest volumes with no built solids carry no volume data and are omitted;
 * summaries without a manifest fall back to positional `mat_<id>` rows, like
 * the outline list.
 */
export function buildBomCsvRows(
    source: BomSourceModel | undefined,
    summaries: readonly SolidSummary[],
    docMaterials: ReadonlyMap<string, string>
): BomCsvRow[] {
    const selectorBySolid = new Map<number, string>();
    if (source !== undefined) {
        for (const [selector, ids] of Object.entries(source.selectorMap)) {
            for (const id of ids) {
                if (!selectorBySolid.has(id)) {
                    selectorBySolid.set(id, selector);
                }
            }
        }
    }
    const volumeBySelector = new Map<string, BomSourceVolume>();
    if (source !== undefined) {
        for (const volume of source.volumes) {
            if (!volumeBySelector.has(volume.selector)) {
                volumeBySelector.set(volume.selector, volume);
            }
        }
    }
    return [...summaries]
        .sort((a, b) => a.solidId - b.solidId)
        .map((summary) => {
            const selector = selectorBySolid.get(summary.solidId);
            const volumeEntry = selector !== undefined ? volumeBySelector.get(selector) : undefined;
            const label = volumeEntry?.name ?? selector ?? summary.bodyId ?? `mat_${summary.solidId}`;
            const material = volumeEntry?.material ?? (selector !== undefined ? docMaterials.get(selector) : undefined) ?? '';
            const rawVolume = summary.properties?.volume;
            const volume = rawVolume === undefined || rawVolume === null || !Number.isFinite(rawVolume) ? '' : String(rawVolume);
            return { instance: selector ?? `mat_${summary.solidId}`, label, material, volume };
        });
}

/** Header line of the BOM CSV export. */
export const BOM_CSV_HEADER = 'instance/body,label,material,volume';

function csvCell(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Render BOM rows as RFC-4180 CSV (quoted when needed, LF-terminated). */
export function formatBomCsv(rows: readonly BomCsvRow[]): string {
    const lines = [BOM_CSV_HEADER];
    for (const row of rows) {
        lines.push([row.instance, row.label, row.material, row.volume].map(csvCell).join(','));
    }
    return lines.join('\n') + '\n';
}
