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
 * Dataset Inspector contract between a viewer widget and the sidebar panel.
 *
 * Sync is single-direction with no duplicated state: every render reads a
 * fresh {@link DatasetSummary} / {@link DatasetTable} from the bound widget;
 * the panel never caches dataset contents. A widget opts into the panel by
 * implementing the two methods — the panel detects the surface structurally,
 * so no viewer class needs importing and future DAGMC / geometry / Exodus
 * hosts bind without panel changes.
 *
 * Pure types + helpers only; no three.js, no DOM, no Theia imports.
 */

import type { DatasetArrayInfo, DatasetAssociation, DatasetStats, DatasetSummary, DatasetTable } from '../viewer-core/dataset-inspector';

/**
 * Structural surface a dataset viewer exposes to the inspector panel (bound
 * once, not per viewer). Implementations delegate to the pure core:
 * `summarizeNativeModel(this.model)` and `tableForArray(this.model, ...)`.
 */
export interface ViewerDatasetHost {
    /** Dataset summary, or undefined before a file finishes loading. */
    getDatasetSummary(): DatasetSummary | undefined;
    /** Table for one array, or undefined when the dataset has no such array. */
    getDatasetTable(association: DatasetAssociation, name: string): DatasetTable | undefined;
    /** Descriptive stats (and optional cell integral) for one array. */
    getDatasetStats?(association: DatasetAssociation, name: string): DatasetStats | undefined;
}

/**
 * Whether a widget implements the dataset host surface. Structural on
 * purpose: any Theia widget (native-VTK viewers today, DAGMC/Exodus later)
 * can opt in by adding the two methods.
 */
export function isViewerDatasetHost(candidate: object | undefined): candidate is ViewerDatasetHost {
    if (candidate === undefined) {
        return false;
    }
    const host = candidate as ViewerDatasetHost;
    return typeof host.getDatasetSummary === 'function' && typeof host.getDatasetTable === 'function';
}

/** The array the inspector table shows, plus its association. */
export interface DatasetSelection {
    readonly association: DatasetAssociation;
    readonly array: DatasetArrayInfo;
}

/**
 * Resolve the array to display: the remembered association/name when it
 * still exists, otherwise the first array of the remembered association
 * (Point/Cell toggle semantics), otherwise the first array of any
 * association, otherwise undefined for a dataset with no arrays.
 */
export function resolveDatasetSelection(
    summary: DatasetSummary,
    association: DatasetAssociation | undefined,
    name: string | undefined
): DatasetSelection | undefined {
    const exact = summary.arrays.find((entry) => entry.association === association && entry.name === name);
    if (exact) {
        return { association: exact.association, array: exact };
    }
    const preferred = summary.arrays.find((entry) => entry.association === association);
    if (preferred) {
        return { association: preferred.association, array: preferred };
    }
    const first = summary.arrays[0];
    return first ? { association: first.association, array: first } : undefined;
}
