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
 * Shared helpers for the structured tally filters (`cellinstance`,
 * `meshmaterial`) and for 0.16-only reaction/particle filters.
 *
 * The schema stores pair filters as structured pairs, while OpenMC XML/Python
 * encode a flat `cell instance cell instance …` / `element material …` list.
 * These helpers are the single conversion point used by XML generation,
 * import, Python export, and the filter editor so no path silently reorders
 * or drops a bin.
 *
 * @module openmc-studio/common
 */

import { OpenMCBinnedPair, OpenMCTallyFilter, OpenMCTallyFilterType } from './openmc-state-schema';
import type { OpenMCCompat } from './openmc-studio-protocol';
import {
    isParticleSupported,
    legacyParticleBins,
    NEUTRON_PARTICLE,
    OpenMCParticleType,
    particleFromLegacyBin,
    particleTypeName,
    resolveParticleType
} from './particle-types';

/** Filter types whose `<bins>` are flattened numeric pairs. */
const PAIR_FILTER_TYPES = new Set<OpenMCTallyFilterType>(['cellinstance', 'meshmaterial']);

/**
 * Whether a filter type is stored as structured `{first, second}` pairs.
 *
 * @param type - Filter type.
 */
export function isPairFilter(type: OpenMCTallyFilterType): boolean {
    return PAIR_FILTER_TYPES.has(type);
}

/**
 * Chunk a flat OpenMC pair list into structured pairs. A trailing odd value is
 * ignored here and reported by `validateTallyFilter` instead of being silently
 * repaired.
 *
 * @param bins - Flat pair list.
 */
export function pairsFromBins(bins: number[]): OpenMCBinnedPair[] {
    const pairs: OpenMCBinnedPair[] = [];
    for (let i = 0; i + 1 < bins.length; i += 2) {
        pairs.push({ first: bins[i], second: bins[i + 1] });
    }
    return pairs;
}

/**
 * Flatten structured pairs into OpenMC's `<bins>` order.
 *
 * @param pairs - Structured pairs.
 */
export function flattenPairs(pairs: OpenMCBinnedPair[]): number[] {
    return pairs.flatMap((pair) => [pair.first, pair.second]);
}

/**
 * Read cell-instance pairs, deriving them from legacy flat bins when needed.
 *
 * @param filter - Cell-instance filter.
 */
export function getCellInstancePairs(filter: OpenMCTallyFilter): OpenMCBinnedPair[] {
    if (filter.pairs && filter.pairs.length > 0) {
        return filter.pairs;
    }
    return pairsFromBins(filter.bins);
}

/**
 * Read mesh-material pairs, deriving them from legacy flat bins when needed.
 *
 * @param filter - Mesh-material filter.
 */
export function getMeshMaterialPairs(filter: OpenMCTallyFilter): OpenMCBinnedPair[] {
    if (filter.pairs && filter.pairs.length > 0) {
        return filter.pairs;
    }
    return pairsFromBins(filter.bins);
}

/**
 * Whether the active environment can emit a filter type.
 *
 * Only `reaction` and `particleproduction` are 0.16-only; every other filter
 * in the catalog exists in the release-compatible 0.15.3 surface.
 *
 * @param type - Filter type.
 * @param compat - Probed capabilities.
 */
export function isFilterSupported(type: OpenMCTallyFilterType, compat?: OpenMCCompat): boolean {
    if (type === 'reaction') {
        return compat?.reactionFilter === true;
    }
    if (type === 'particleproduction') {
        return compat?.particleProductionFilter === true;
    }
    return true;
}

/**
 * Warning text for a filter that the probed environment cannot emit.
 *
 * @param type - Filter type.
 * @returns Warning message, or undefined when the filter is supported.
 */
export function getFilterSupportWarning(type: OpenMCTallyFilterType): string | undefined {
    if (type === 'reaction') {
        return 'Reaction filters require OpenMC 0.16 or newer and are omitted from generated XML/Python on older environments';
    }
    if (type === 'particleproduction') {
        return 'Particle-production filters require OpenMC 0.16 or newer and are omitted from generated XML/Python on older environments';
    }
    return undefined;
}

/**
 * Read a `particle` filter's bins, deriving canonical particles from legacy
 * numeric bins when the project predates the PDG-backed model.
 *
 * @param filter - Particle filter.
 */
export function getParticleFilterBins(filter: OpenMCTallyFilter): OpenMCParticleType[] {
    if (filter.particleBins && filter.particleBins.length > 0) {
        return filter.particleBins;
    }
    const derived: OpenMCParticleType[] = [];
    for (const bin of filter.bins) {
        const particle = particleFromLegacyBin(bin);
        if (particle) {
            derived.push(particle);
        }
    }
    return derived;
}

/**
 * Read a particle-production filter's secondary particles, tolerating legacy
 * string names from pre-PDG project files.
 *
 * @param filter - Particle-production filter.
 */
export function getParticleProductionTypes(filter: OpenMCTallyFilter): OpenMCParticleType[] {
    const types = filter.particleTypes ?? [];
    return types.map((value): OpenMCParticleType => {
        const resolved = resolveParticleType(value);
        return resolved.ok ? resolved.particle! : { name: particleTypeName(value) ?? String(value) };
    });
}

/**
 * Mirror canonical particle bins into the legacy numeric `bins` field when
 * every particle has a legacy code, so older readers stay in sync.
 *
 * @param particles - Canonical particle bins.
 */
export function particleFilterLegacyBins(particles: OpenMCParticleType[]): number[] {
    return legacyParticleBins(particles);
}

/**
 * Drop particle bins the probed environment cannot represent. A `particle`
 * filter whose bins are all unsupported is omitted from the tally so OpenMC
 * never receives an empty or invalid filter element.
 *
 * @param filter - Particle filter to sanitize.
 * @param compat - Probed capabilities.
 * @param label - Tally label for the warning.
 * @returns Sanitized filter (or the original when nothing changed) and warning.
 */
export function sanitizeParticleFilter(
    filter: OpenMCTallyFilter,
    compat: OpenMCCompat | undefined,
    label: string
): { filter: OpenMCTallyFilter; warning?: string } {
    if (filter.type !== 'particle') {
        return { filter };
    }
    const configured = getParticleFilterBins(filter);
    const invalid = configured.filter((particle) => !resolveParticleType(particle).ok);
    const unsupported = configured.filter(
        (particle) => resolveParticleType(particle).ok && !isParticleSupported(particle, 'tally-filter', compat)
    );
    const supported = configured.filter(
        (particle) => resolveParticleType(particle).ok && isParticleSupported(particle, 'tally-filter', compat)
    );
    if (invalid.length === 0 && unsupported.length === 0) {
        return { filter };
    }
    const warnings: string[] = [];
    if (invalid.length > 0) {
        warnings.push(
            `${label}: particle filter bins '${invalid
                .map((particle) => particleTypeName(particle) ?? particle.name)
                .join(', ')}' are not recognized OpenMC particles and were omitted`
        );
    }
    if (unsupported.length > 0) {
        warnings.push(
            `${label}: particle filter bins '${unsupported
                .map((particle) => particle.name)
                .join(', ')}' require OpenMC 0.16 or newer and were omitted from the generated filter`
        );
    }
    const warning = warnings.join('. ');
    if (supported.length === 0) {
        return { filter: { ...filter, particleBins: [], bins: [] }, warning };
    }
    return {
        filter: {
            ...filter,
            particleBins: supported,
            bins: particleFilterLegacyBins(supported)
        },
        warning
    };
}

/** Default canonical particle filter bin (neutron). */
export const DEFAULT_PARTICLE_FILTER_BINS: OpenMCParticleType[] = [NEUTRON_PARTICLE];
