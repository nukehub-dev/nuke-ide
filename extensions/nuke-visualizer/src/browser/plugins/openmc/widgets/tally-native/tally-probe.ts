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
 * Line-probe state for the native tally viewer (`openmc.tally-line-probe`).
 *
 * Probe endpoints are entered numerically (two-click canvas picking stays
 * in the measure tool — its raycast handles are private to the shared
 * viewer base); the sampled series renders in the probe panel table with
 * CSV export following the kinetics-tab `kineticsToCsv` precedent.
 *
 * Pure functions + types only; no DOM, no DI, no three.js.
 */

import type { OpenMCTallyLineProbeResult } from '../../../../../common/openmc-protocol';
import {
    defaultProbeEndpoints as defaultSharedEndpoints,
    formatProbePoint,
    parseProbePoint as parseSharedPoint
} from '../../../../viewer-core/probe-model';

export { formatProbePoint };

/** World-space probe endpoint in cm. */
export type ProbePoint3D = [number, number, number];

/** Default sample count (matches the `--npoints` command default). */
export const LINE_PROBE_DEFAULT_NPOINTS = 100;

/** Sample-count bounds (mirror the backend `LINE_PROBE_MIN/MAX_POINTS`). */
export const LINE_PROBE_MIN_NPOINTS = 2;
export const LINE_PROBE_MAX_NPOINTS = 100000;

/** Series-table render cap (large probes stay interactive; CSV exports all rows). */
export const LINE_PROBE_TABLE_ROW_CAP = 1000;

/** Axis-aligned dataset bounds the default probe line spans. */
export interface ProbeBounds {
    readonly min: ProbePoint3D;
    readonly max: ProbePoint3D;
}

/** Tally context for a probe run (set by the opener; manual entry otherwise). */
export interface LineProbeContext {
    readonly statepointPath: string;
    readonly tallyId: number;
    readonly score?: string;
    readonly nuclide?: string;
}

/** Parse one coordinate: finite numbers only, anything else is undefined. */
export function parseProbeCoordinate(text: string): number | undefined {
    const value = Number(text.trim());
    return text.trim() !== '' && Number.isFinite(value) ? value : undefined;
}

/** Parse an endpoint from free text (`x, y, z` or `x y z`, in cm). */
export function parseProbePoint(text: string): ProbePoint3D | undefined {
    const point = parseSharedPoint(text);
    return point === undefined ? undefined : [point[0], point[1], point[2]];
}

/** Clamp a sample count into the backend range (non-finite → default). */
export function clampProbeNpoints(value: number): number {
    if (!Number.isFinite(value)) {
        return LINE_PROBE_DEFAULT_NPOINTS;
    }
    return Math.min(LINE_PROBE_MAX_NPOINTS, Math.max(LINE_PROBE_MIN_NPOINTS, Math.floor(value)));
}

/** Default probe line: the X-axis span through the dataset center. */
export function defaultProbeEndpoints(bounds: ProbeBounds | undefined): { start: ProbePoint3D; end: ProbePoint3D } {
    const { start, end } = defaultSharedEndpoints(bounds);
    return { start: [start[0], start[1], start[2]], end: [end[0], end[1], end[2]] };
}

/**
 * Serialize a probe series to CSV: one row per sample
 * (distance/position/value). Values are written at full precision.
 */
export function lineProbeToCsv(result: OpenMCTallyLineProbeResult): string {
    const rows: string[][] = [['distance_cm', 'x_cm', 'y_cm', 'z_cm', 'value']];
    for (const point of result.series ?? []) {
        rows.push([
            String(point.distance),
            String(point.position[0]),
            String(point.position[1]),
            String(point.position[2]),
            String(point.value)
        ]);
    }
    return rows.map((row) => row.join(',')).join('\n') + '\n';
}

/** One-line summary for the series header (`51 points · flux-mean · 0–12.5 cm`). */
export function describeLineProbeSeries(result: OpenMCTallyLineProbeResult): string {
    const count = result.series?.length ?? 0;
    const range = result.dataRange ? ` [${result.dataRange[0]}, ${result.dataRange[1]}]` : '';
    const length = result.length !== undefined ? ` · 0–${result.length} cm` : '';
    const array = result.arrayName ? ` · ${result.arrayName}` : '';
    return `${count} points${array}${length}${range}`;
}
