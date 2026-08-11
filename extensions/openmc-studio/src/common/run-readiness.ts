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
 * Run-readiness predicates for the simulation dashboard.
 *
 * Pure helpers computing the Setup Checklist items and overall readiness from
 * the current OpenMC state. The simulation tab renders from these; the
 * predicates mirror the checklist logic exactly (including DAGMC-aware
 * material matching) so the banner and the checklist can never disagree.
 *
 * @module openmc-studio/common
 */

import { OpenMCState } from './openmc-state-schema';

/** Status of a single checklist item */
export type ChecklistStatus = 'done' | 'partial' | 'missing' | 'optional';

/** A single Setup Checklist entry */
export interface ChecklistItem {
    /** Item identifier */
    id: string;
    /** Display label */
    label: string;
    /** Computed status */
    status: ChecklistStatus;
    /** Status detail text (e.g. '3 defined', 'Not configured') */
    detail: string;
}

/** Readiness result for the simulation banner */
export interface ReadinessResult {
    /** Whether the model is ready to run */
    ready: boolean;
    /** Display names of missing required items (empty when ready) */
    missing: string[];
}

/**
 * Compute the materials checklist status (DAGMC-aware).
 * @param state - Current OpenMC simulation state.
 * @returns The materials checklist item.
 */
export function computeMaterialsItem(state: OpenMCState): ChecklistItem {
    const openMCMaterialCount = state.materials.length;
    const dagmcMaterials = state.settings.dagmcInfo?.materials;
    // "graveyard" is a DAGMC sentinel material and does not need a matching OpenMC material.
    const dagmcMaterialNames = dagmcMaterials ? Object.keys(dagmcMaterials).filter((name) => name.toLowerCase() !== 'graveyard') : [];
    const dagmcMaterialCount = dagmcMaterialNames.length;

    if (state.settings.dagmcFile) {
        if (dagmcMaterialCount === 0) {
            const done = openMCMaterialCount > 0;
            return {
                id: 'materials',
                label: 'Materials',
                status: done ? 'done' : 'missing',
                detail: done ? `${openMCMaterialCount} defined` : '0 defined (no DAGMC mats found)'
            };
        }
        if (openMCMaterialCount === 0) {
            return {
                id: 'materials',
                label: 'Materials',
                status: 'missing',
                detail: `0 / ${dagmcMaterialCount} DAGMC materials configured`
            };
        }
        const openMCMaterialNames = new Set(state.materials.map((m) => m.name.toLowerCase()));
        const missingCount = dagmcMaterialNames.filter((dm) => !openMCMaterialNames.has(dm.toLowerCase())).length;
        const done = missingCount === 0;
        return {
            id: 'materials',
            label: 'Materials',
            status: done ? 'done' : 'partial',
            detail: `${dagmcMaterialCount - missingCount} / ${dagmcMaterialCount} DAGMC materials defined`
        };
    }

    const done = openMCMaterialCount > 0;
    return {
        id: 'materials',
        label: 'Materials',
        status: done ? 'done' : 'missing',
        detail: done ? `${openMCMaterialCount} defined` : 'Not configured'
    };
}

/**
 * Compute the geometry checklist status (CSG cells or a DAGMC universe).
 * @param state - Current OpenMC simulation state.
 * @returns The geometry checklist item.
 */
export function computeGeometryItem(state: OpenMCState): ChecklistItem {
    const hasCSG = state.geometry.cells.length > 0;
    const hasDagmc = !!state.settings.dagmcFile;
    const done = hasCSG || hasDagmc;
    const dagmcVolumeCount = state.settings.dagmcInfo?.volumeCount || 0;

    return {
        id: 'geometry',
        label: 'Geometry',
        status: done ? 'done' : 'missing',
        detail: hasCSG
            ? `${state.geometry.cells.length} cells, ${state.geometry.surfaces.length} surfaces`
            : hasDagmc
              ? `${dagmcVolumeCount} DAGMC volumes`
              : 'Not configured'
    };
}

/**
 * Compute the source checklist status.
 * @param state - Current OpenMC simulation state.
 * @returns The source checklist item.
 */
export function computeSourceItem(state: OpenMCState): ChecklistItem {
    const done = state.settings.sources.length > 0;
    return {
        id: 'source',
        label: 'Source',
        status: done ? 'done' : 'missing',
        detail: done ? `${state.settings.sources.length} defined` : 'Not configured'
    };
}

/**
 * Compute the MGXS library checklist status (multi-group mode only).
 * @param state - Current OpenMC simulation state.
 * @returns The MGXS library checklist item.
 */
export function computeMgxsItem(state: OpenMCState): ChecklistItem {
    const done = !!state.settings.mgxsLibrary;
    return {
        id: 'mgxs-library',
        label: 'MGXS Library',
        status: done ? 'done' : 'missing',
        detail: done ? state.settings.mgxsLibrary!.split('/').pop()! : 'Not set (required for multi-group)'
    };
}

/**
 * Compute the kinetics checklist status (when IFP is enabled).
 * @param state - Current OpenMC simulation state.
 * @returns The kinetics checklist item.
 */
export function computeKineticsItem(state: OpenMCState): ChecklistItem {
    const generations = state.settings.kinetics?.ifpNGenerations ?? 0;
    const inactive = state.settings.run.mode === 'eigenvalue' ? state.settings.run.inactive : 0;
    const done = generations > 0 && generations <= inactive;
    return {
        id: 'kinetics',
        label: 'Kinetics (IFP)',
        status: done ? 'done' : 'partial',
        detail: done ? `${generations} generations` : `${generations} generations > ${inactive} inactive batches`
    };
}

/**
 * Compute the full Setup Checklist: required items, optional items, and
 * conditional Phase 5 items (kinetics when enabled, random ray in multi-group).
 * @param state - Current OpenMC simulation state.
 * @returns The checklist items in display order.
 */
export function computeSetupChecklist(state: OpenMCState): ChecklistItem[] {
    const items: ChecklistItem[] = [computeMaterialsItem(state), computeGeometryItem(state), computeSourceItem(state)];

    const tallies = state.tallies || [];
    items.push({
        id: 'tallies',
        label: 'Tallies',
        status: tallies.length > 0 ? 'done' : 'optional',
        detail: tallies.length > 0 ? `${tallies.length} defined` : 'Optional - none configured'
    });

    const depletion = state.depletion;
    const isDepletionEnabled = !!depletion?.enabled;
    const depletionDone = !isDepletionEnabled || ((depletion!.timeSteps?.length ?? 0) > 0 && !!depletion?.chainFile);
    items.push({
        id: 'depletion',
        label: 'Depletion',
        status: !isDepletionEnabled ? 'optional' : depletionDone ? 'done' : 'partial',
        detail: !isDepletionEnabled
            ? 'Disabled'
            : depletionDone
              ? `Enabled (${depletion!.timeSteps.length} steps)`
              : `Enabled (missing ${!depletion?.chainFile ? 'chain file' : 'steps'})`
    });

    const vr = state.varianceReduction;
    const hasVR =
        !!vr &&
        !!(vr.survivalBiasing || vr.weightWindows || vr.sourceBiasing || vr.weightWindowGenerator || vr.cutoff?.weight !== undefined);
    items.push({
        id: 'variance-reduction',
        label: 'Variance Reduction',
        status: hasVR ? 'done' : 'optional',
        detail: hasVR ? 'Enabled' : 'Optional - none configured'
    });

    if (state.settings.kinetics?.enabled) {
        items.push(computeKineticsItem(state));
    }

    if (state.settings.energyMode === 'multigroup') {
        items.push(computeMgxsItem(state));
    }

    // DAGMC random ray only works with a nuclide-wise MGXS library
    if (state.settings.randomRay && state.settings.dagmcFile) {
        const done = state.settings.nuclideWiseMgxs === true;
        items.push({
            id: 'nuclide-wise-mgxs',
            label: 'Nuclide-wise MGXS',
            status: done ? 'done' : 'missing',
            detail: done ? 'Enabled' : 'Required for DAGMC random ray'
        });
    }

    return items;
}

/**
 * Compute overall run readiness: materials + geometry + source are required,
 * plus the MGXS library when in multi-group mode.
 * @param state - Current OpenMC simulation state.
 * @returns Readiness result with the names of missing required items.
 */
export function computeReadiness(state: OpenMCState): ReadinessResult {
    const missing: string[] = [];

    if (computeMaterialsItem(state).status === 'missing') {
        missing.push('Materials');
    }
    if (computeGeometryItem(state).status === 'missing') {
        missing.push('Geometry');
    }
    if (computeSourceItem(state).status === 'missing') {
        missing.push('Source');
    }
    if (state.settings.energyMode === 'multigroup' && computeMgxsItem(state).status === 'missing') {
        missing.push('MGXS Library');
    }
    // DAGMC random ray requires the nuclide-wise MGXS mode (OpenMC rejects
    // macroscopic multi-group materials on DAGMC geometries)
    if (state.settings.randomRay && state.settings.dagmcFile && state.settings.nuclideWiseMgxs !== true) {
        missing.push('Nuclide-wise MGXS (DAGMC random ray)');
    }

    return { ready: missing.length === 0, missing };
}
