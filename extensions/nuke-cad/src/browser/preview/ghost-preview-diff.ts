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
 * Solid-level diff between the current CAD build and a candidate tessellation.
 *
 * The ghost preview renders the candidate geometry on top of the current one,
 * so it only needs to know which solids are new, which disappeared, and which
 * ones changed shape or mass properties. Identity prefers `bodyId` because
 * positional `solidId`s can shuffle between builds; assemblies repeat sparse
 * body ids across instances, so those fall back to `solidId` matching.
 *
 * Pure module (no Theia, no three.js) so the comparison stays vitest-coverable.
 *
 * @module nuke-cad/browser/preview
 */

import type { TessSolidProperties, SolidSummary } from '../state/nuke-cad-state-manager';
import type { ParsedTessData } from '../viewer-core/tess-reuse';

/** Relative tolerance for mass-property comparisons. */
const RELATIVE_EPSILON = 1e-6;

/** Absolute tolerance so values near zero do not need an exact match. */
const ABSOLUTE_EPSILON = 1e-9;

/** What a candidate build changes relative to the current build. */
export interface GhostPreviewDiff {
    /** Candidate solid ids whose counts or mass properties differ. */
    readonly changedSolidIds: readonly number[];
    /** Candidate solid ids with no counterpart in the current build. */
    readonly addedSolidIds: readonly number[];
    /** Current solid ids with no counterpart in the candidate build. */
    readonly removedSolidIds: readonly number[];
    /** Unique body ids of changed and added candidate solids. */
    readonly changedBodyIds: readonly string[];
}

/** One candidate/current pair selected by the identity matching passes. */
interface SolidMatch {
    readonly candidateIndex: number;
    readonly currentIndex: number;
}

function numbersEqual(left: number, right: number): boolean {
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return left === right;
    }
    const scale = Math.max(Math.abs(left), Math.abs(right));
    return Math.abs(left - right) <= ABSOLUTE_EPSILON + RELATIVE_EPSILON * scale;
}

function numberArraysEqual(left: readonly number[] | undefined, right: readonly number[] | undefined): boolean {
    if (left === undefined || right === undefined) {
        return true;
    }
    if (left.length !== right.length) {
        return false;
    }
    return left.every((value, index) => numbersEqual(value, right[index]));
}

function optionalNumbersEqual(left: number | undefined, right: number | undefined): boolean {
    if (left === undefined || right === undefined) {
        return true;
    }
    return numbersEqual(left, right);
}

function boundingBoxesEqual(left: TessSolidProperties['bbox'], right: TessSolidProperties['bbox']): boolean {
    if (left === undefined || right === undefined) {
        return true;
    }
    return numberArraysEqual(left.min, right.min) && numberArraysEqual(left.max, right.max);
}

/** Compare per-solid mass properties; missing values on either side are ignored. */
function propertiesEqual(left: TessSolidProperties | undefined, right: TessSolidProperties | undefined): boolean {
    if (left === undefined || right === undefined) {
        return true;
    }
    return (
        optionalNumbersEqual(left.volume, right.volume) &&
        optionalNumbersEqual(left.area, right.area) &&
        boundingBoxesEqual(left.bbox, right.bbox) &&
        numberArraysEqual(left.centerOfMass, right.centerOfMass)
    );
}

/** Counts and (when both sides carry them) mass properties decide a solid's equality. */
function solidsEqual(current: SolidSummary, candidate: SolidSummary): boolean {
    return (
        current.faceCount === candidate.faceCount &&
        current.edgeCount === candidate.edgeCount &&
        current.triangleCount === candidate.triangleCount &&
        propertiesEqual(current.properties, candidate.properties)
    );
}

/** Index current solids by body id; duplicate ids stay grouped for uniqueness checks. */
function indexByBodyId(solids: readonly SolidSummary[]): Map<string, number[]> {
    const byBodyId = new Map<string, number[]>();
    solids.forEach((solid, index) => {
        if (solid.bodyId === undefined) {
            return;
        }
        const indexes = byBodyId.get(solid.bodyId);
        if (indexes === undefined) {
            byBodyId.set(solid.bodyId, [index]);
        } else {
            indexes.push(index);
        }
    });
    return byBodyId;
}

/** Pair solids whose body id is unique on both sides, then pair the rest by solid id. */
function matchSolids(current: readonly SolidSummary[], candidate: readonly SolidSummary[]): SolidMatch[] {
    const currentByBodyId = indexByBodyId(current);
    const candidateByBodyId = indexByBodyId(candidate);
    const matchedCurrent = new Set<number>();
    const matches: SolidMatch[] = [];
    const unmatchedCandidates: number[] = [];

    candidate.forEach((solid, candidateIndex) => {
        const bodyId = solid.bodyId;
        if (bodyId === undefined) {
            unmatchedCandidates.push(candidateIndex);
            return;
        }
        const currentIndexes = currentByBodyId.get(bodyId);
        const candidateIndexes = candidateByBodyId.get(bodyId);
        if (currentIndexes?.length === 1 && candidateIndexes?.length === 1 && !matchedCurrent.has(currentIndexes[0])) {
            const currentIndex = currentIndexes[0];
            matchedCurrent.add(currentIndex);
            matches.push({ candidateIndex, currentIndex });
        } else {
            unmatchedCandidates.push(candidateIndex);
        }
    });

    const currentBySolidId = new Map<number, number[]>();
    current.forEach((solid, index) => {
        if (matchedCurrent.has(index)) {
            return;
        }
        const indexes = currentBySolidId.get(solid.solidId);
        if (indexes === undefined) {
            currentBySolidId.set(solid.solidId, [index]);
        } else {
            indexes.push(index);
        }
    });

    for (const candidateIndex of unmatchedCandidates) {
        const indexes = currentBySolidId.get(candidate[candidateIndex].solidId);
        if (indexes === undefined || indexes.length === 0) {
            continue;
        }
        const currentIndex = indexes.shift() as number;
        matchedCurrent.add(currentIndex);
        matches.push({ candidateIndex, currentIndex });
    }
    return matches;
}

/**
 * Compare the current build's solid summaries against a candidate tessellation.
 *
 * @param current - Solid summaries of the geometry currently in the viewport.
 * @param candidate - Parsed tessellation of the proposed build.
 * @returns Changed, added, and removed solid ids plus the touched body ids.
 */
export function compareCandidateSolids(current: readonly SolidSummary[], candidate: ParsedTessData): GhostPreviewDiff {
    const currentIndexByCandidate = new Map<number, number>();
    for (const match of matchSolids(current, candidate.solids)) {
        currentIndexByCandidate.set(match.candidateIndex, match.currentIndex);
    }

    const changedSolidIds: number[] = [];
    const addedSolidIds: number[] = [];
    const changedBodyIds: string[] = [];
    const changedBodies = new Set<string>();

    candidate.solids.forEach((solid, candidateIndex) => {
        const currentIndex = currentIndexByCandidate.get(candidateIndex);
        if (currentIndex === undefined) {
            addedSolidIds.push(solid.solidId);
        } else if (!solidsEqual(current[currentIndex], solid)) {
            changedSolidIds.push(solid.solidId);
        } else {
            return;
        }
        if (solid.bodyId !== undefined && !changedBodies.has(solid.bodyId)) {
            changedBodies.add(solid.bodyId);
            changedBodyIds.push(solid.bodyId);
        }
    });

    const matchedCurrent = new Set(currentIndexByCandidate.values());
    const removedSolidIds: number[] = [];
    current.forEach((solid, index) => {
        if (!matchedCurrent.has(index)) {
            removedSolidIds.push(solid.solidId);
        }
    });

    return { changedSolidIds, addedSolidIds, removedSolidIds, changedBodyIds };
}
