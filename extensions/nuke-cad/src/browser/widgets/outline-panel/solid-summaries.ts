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
 * Pure helpers behind the Model Outline panel's Properties section (V7) and
 * spreadsheet table view (V10): per-solid summary extraction from the
 * tessellation payload, SI quantity formatting, and table sort comparison.
 *
 * Kept free of Theia/React imports so vitest can exercise it directly.
 *
 * @module nuke-cad/browser/widgets/outline-panel
 */

import { SolidSummary, TessSolidProperties } from '../../state/nuke-cad-state-manager';

/** Structural subset of a tessellation face needed for counting. */
interface SummaryFaceInput {
    readonly triangles?: readonly unknown[];
}

/** Structural subset of a tessellation solid needed for summarizing. */
interface SummarySolidInput {
    readonly solidId: number;
    readonly bodyId?: string;
    readonly faces?: readonly SummaryFaceInput[];
    readonly edges?: readonly unknown[];
    readonly properties?: TessSolidProperties;
    /** Precomputed counts (the typed-array parse path carries no face objects). */
    readonly faceCount?: number;
    readonly edgeCount?: number;
    readonly triangleCount?: number;
}

/** Placeholder rendered when payload data is absent (older backends). */
export const MISSING_VALUE = '—';

export function countTriangles(faces: readonly SummaryFaceInput[] | undefined): number {
    let count = 0;
    for (const face of faces ?? []) {
        count += face.triangles?.length ?? 0;
    }
    return count;
}

export function buildSolidSummaries(solids: readonly SummarySolidInput[] | undefined): SolidSummary[] {
    return (solids ?? []).map((solid) => ({
        solidId: solid.solidId,
        bodyId: solid.bodyId,
        faceCount: solid.faceCount ?? solid.faces?.length ?? 0,
        edgeCount: solid.edgeCount ?? solid.edges?.length ?? 0,
        triangleCount: solid.triangleCount ?? countTriangles(solid.faces),
        properties: solid.properties
    }));
}

const LARGE_PREFIXES: ReadonlyArray<{ readonly factor: number; readonly symbol: string }> = [
    { factor: 1e12, symbol: 'T' },
    { factor: 1e9, symbol: 'G' },
    { factor: 1e6, symbol: 'M' },
    { factor: 1e3, symbol: 'k' }
];

const SMALL_PREFIXES: ReadonlyArray<{ readonly factor: number; readonly symbol: string }> = [
    { factor: 1e-3, symbol: 'm' },
    { factor: 1e-6, symbol: 'µ' },
    { factor: 1e-9, symbol: 'n' }
];

function formatSignificand(value: number): string {
    const abs = Math.abs(value);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    let text = value.toFixed(digits);
    if (text.includes('.')) {
        text = text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return text === '-0' ? '0' : text;
}

/** Compact SI-prefixed rendering ('—' for missing/non-finite values). */
export function formatSi(value: number | undefined | null): string {
    if (value === undefined || value === null || !Number.isFinite(value)) {
        return MISSING_VALUE;
    }
    const abs = Math.abs(value);
    if (abs === 0) {
        return '0';
    }
    if (abs >= 1000) {
        for (const prefix of LARGE_PREFIXES) {
            if (abs >= prefix.factor) {
                return formatSignificand(value / prefix.factor) + prefix.symbol;
            }
        }
    }
    if (abs < 1) {
        for (const prefix of SMALL_PREFIXES) {
            if (abs >= prefix.factor) {
                return formatSignificand(value / prefix.factor) + prefix.symbol;
            }
        }
        return value.toExponential(2);
    }
    return formatSignificand(value);
}

export type QuantityUnit = 'u' | 'u²' | 'u³';

/** Formats a scalar with its model-unit suffix ('u', 'u²', 'u³'). */
export function formatQuantity(value: number | undefined | null, unit: QuantityUnit): string {
    const formatted = formatSi(value);
    return formatted === MISSING_VALUE ? MISSING_VALUE : `${formatted} ${unit}`;
}

/** Renders an xyz triple as comma-joined values ('—' when absent). */
export function formatVec3(values: number[] | undefined, unit?: QuantityUnit): string {
    if (!values || values.length < 3 || values.some((v) => !Number.isFinite(v))) {
        return MISSING_VALUE;
    }
    const text = `${formatSi(values[0])}, ${formatSi(values[1])}, ${formatSi(values[2])}`;
    return unit ? `${text} ${unit}` : text;
}

/** Bounding-box extent dx/dy/dz, or undefined without bbox data. */
export function bboxSize(properties: TessSolidProperties | undefined): [number, number, number] | undefined {
    const min = properties?.bbox?.min;
    const max = properties?.bbox?.max;
    if (!min || !max || min.length < 3 || max.length < 3) {
        return undefined;
    }
    return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

export type SolidSortKey = 'solidId' | 'label' | 'volume' | 'area' | 'faceCount' | 'triangleCount';

/** One spreadsheet row: manifest label joined with the mesh summary. */
export interface SolidTableRow {
    readonly solidId: number;
    readonly label: string;
    readonly summary?: SolidSummary;
}

function numericSortValue(row: SolidTableRow, key: SolidSortKey): number | undefined {
    switch (key) {
        case 'solidId':
            return row.solidId;
        case 'volume':
            return row.summary?.properties?.volume;
        case 'area':
            return row.summary?.properties?.area;
        case 'faceCount':
            return row.summary?.faceCount;
        case 'triangleCount':
            return row.summary?.triangleCount;
        default:
            return undefined;
    }
}

/** Rows with missing numeric data always sort last, regardless of direction. */
export function compareSolidRows(a: SolidTableRow, b: SolidTableRow, key: SolidSortKey, descending: boolean): number {
    if (key === 'label') {
        const result = a.label.localeCompare(b.label);
        return descending ? -result : result;
    }
    const av = numericSortValue(a, key);
    const bv = numericSortValue(b, key);
    if (av === undefined && bv === undefined) {
        return a.solidId - b.solidId;
    }
    if (av === undefined) {
        return 1;
    }
    if (bv === undefined) {
        return -1;
    }
    const result = av - bv;
    return descending ? -result : result;
}
