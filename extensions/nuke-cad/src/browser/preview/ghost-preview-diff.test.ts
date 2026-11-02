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
 * Tests the candidate-vs-current solid diff used by the ghost preview.
 */

import { describe, expect, it } from 'vitest';
import type { SolidSummary, TessSolidProperties } from '../state/nuke-cad-state-manager';
import type { ParsedTessData, ParsedTessSolidMeta } from '../viewer-core/tess-reuse';
import { compareCandidateSolids } from './ghost-preview-diff';

const BASE_PROPERTIES: TessSolidProperties = {
    volume: 100,
    area: 60,
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
    centerOfMass: [0.5, 0.5, 0.5]
};

function summary(solidId: number, overrides: Partial<SolidSummary> = {}): SolidSummary {
    return {
        solidId,
        faceCount: 6,
        edgeCount: 12,
        triangleCount: 12,
        properties: BASE_PROPERTIES,
        ...overrides
    };
}

function meta(solidId: number, overrides: Partial<ParsedTessSolidMeta> = {}): ParsedTessSolidMeta {
    return {
        solidId,
        faceCount: 6,
        edgeCount: 12,
        triangleCount: 12,
        properties: BASE_PROPERTIES,
        ...overrides
    };
}

function tessData(...solids: ParsedTessSolidMeta[]): ParsedTessData {
    return {
        version: 1,
        tolerance: 0.1,
        boundingBox: { min: [0, 0, 0], max: [1, 1, 1] },
        solids,
        faces: [],
        edges: [],
        curves: []
    };
}

describe('compareCandidateSolids', () => {
    it('reports no changes for identical solids', () => {
        const diff = compareCandidateSolids([summary(1), summary(2)], tessData(meta(1), meta(2)));
        expect(diff).toEqual({ changedSolidIds: [], addedSolidIds: [], removedSolidIds: [], changedBodyIds: [] });
    });

    it('prefers body id over a shuffled solid id', () => {
        const diff = compareCandidateSolids([summary(1, { bodyId: 'housing' })], tessData(meta(2, { bodyId: 'housing' })));
        expect(diff).toEqual({ changedSolidIds: [], addedSolidIds: [], removedSolidIds: [], changedBodyIds: [] });
    });

    it('detects a volume change', () => {
        const candidate = meta(1, { bodyId: 'housing', properties: { ...BASE_PROPERTIES, volume: 120 } });
        const diff = compareCandidateSolids([summary(1, { bodyId: 'housing' })], tessData(candidate));
        expect(diff.changedSolidIds).toEqual([1]);
        expect(diff.changedBodyIds).toEqual(['housing']);
        expect(diff.addedSolidIds).toEqual([]);
        expect(diff.removedSolidIds).toEqual([]);
    });

    it('detects a bounding-box change', () => {
        const candidate = meta(1, {
            properties: { ...BASE_PROPERTIES, bbox: { min: [0, 0, 0], max: [2, 1, 1] } }
        });
        const diff = compareCandidateSolids([summary(1)], tessData(candidate));
        expect(diff.changedSolidIds).toEqual([1]);
    });

    it('detects a center-of-mass change', () => {
        const candidate = meta(1, { properties: { ...BASE_PROPERTIES, centerOfMass: [0.5, 0.6, 0.5] } });
        const diff = compareCandidateSolids([summary(1)], tessData(candidate));
        expect(diff.changedSolidIds).toEqual([1]);
    });

    it('detects a count-only change', () => {
        const candidate = meta(1, { faceCount: 7, triangleCount: 14 });
        const diff = compareCandidateSolids([summary(1)], tessData(candidate));
        expect(diff.changedSolidIds).toEqual([1]);
    });

    it('ignores differences inside the property tolerance', () => {
        const candidate = meta(1, { properties: { ...BASE_PROPERTIES, volume: 100 + 1e-8 } });
        const diff = compareCandidateSolids([summary(1)], tessData(candidate));
        expect(diff.changedSolidIds).toEqual([]);
    });

    it('reports added and removed solids and the added body id', () => {
        const current = [summary(1, { bodyId: 'base' }), summary(2, { bodyId: 'leg' })];
        const candidate = tessData(meta(1, { bodyId: 'base' }), meta(3, { bodyId: 'cap' }));
        const diff = compareCandidateSolids(current, candidate);
        expect(diff.changedSolidIds).toEqual([]);
        expect(diff.addedSolidIds).toEqual([3]);
        expect(diff.removedSolidIds).toEqual([2]);
        expect(diff.changedBodyIds).toEqual(['cap']);
    });

    it('compares counts only when the candidate has no properties', () => {
        const unchanged = compareCandidateSolids([summary(1)], tessData(meta(1, { properties: undefined })));
        expect(unchanged.changedSolidIds).toEqual([]);

        const changed = compareCandidateSolids([summary(1)], tessData(meta(1, { properties: undefined, triangleCount: 16 })));
        expect(changed.changedSolidIds).toEqual([1]);
    });

    it('falls back to solid id when assembly body ids repeat', () => {
        const current = [summary(1, { bodyId: 'blade' }), summary(2, { bodyId: 'blade' }), summary(3, { bodyId: 'blade' })];
        const candidate = tessData(
            meta(1, { bodyId: 'blade' }),
            meta(2, { bodyId: 'blade', properties: { ...BASE_PROPERTIES, volume: 140 } }),
            meta(3, { bodyId: 'blade' })
        );
        const diff = compareCandidateSolids(current, candidate);
        expect(diff.changedSolidIds).toEqual([2]);
        expect(diff.addedSolidIds).toEqual([]);
        expect(diff.removedSolidIds).toEqual([]);
        expect(diff.changedBodyIds).toEqual(['blade']);
    });

    it('adds an assembly instance that has no solid-id counterpart', () => {
        const current = [summary(1, { bodyId: 'blade' }), summary(2, { bodyId: 'blade' })];
        const candidate = tessData(meta(1, { bodyId: 'blade' }), meta(2, { bodyId: 'blade' }), meta(3, { bodyId: 'blade' }));
        const diff = compareCandidateSolids(current, candidate);
        expect(diff.addedSolidIds).toEqual([3]);
        expect(diff.changedBodyIds).toEqual(['blade']);
    });
});
