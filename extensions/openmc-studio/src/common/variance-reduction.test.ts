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

import { describe, expect, it } from 'vitest';
import { OpenMCMesh, OpenMCSource } from './openmc-state-schema';
import {
    defaultWeightWindowSet,
    migrateLegacyVarianceReduction,
    normalizeWeightWindowSets,
    resolveWeightWindowBounds,
    stripSourceBias,
    summarizeWeightWindows,
    validateVarianceReduction
} from './variance-reduction';

const MESHES: OpenMCMesh[] = [
    { type: 'regular', id: 5, lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1], dimension: [2, 2, 2] },
    { type: 'regular', id: 6, lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1], dimension: [2, 2, 2] },
    { type: 'cylindrical', id: 7, origin: [0, 0, 0], rGrid: [0, 1], phiGrid: [0, 1], zGrid: [0, 1] }
];

describe('weight-window normalization', () => {
    it('migrates the legacy single object to a list with an ID', () => {
        const sets = normalizeWeightWindowSets({ meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7] });
        expect(sets).toEqual([{ id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7] }]);
    });

    it('preserves explicit IDs and assigns missing ones', () => {
        const sets = normalizeWeightWindowSets([
            { id: 4, meshId: 5, lowerBound: 0.5 },
            { meshId: 6, lowerBound: 1 }
        ]);
        expect(sets?.map((set) => set.id)).toEqual([4, 1]);
    });

    it('builds a new set with a unique ID', () => {
        const existing = [{ id: 1, meshId: 5, lowerBound: 0.5 }];
        expect(defaultWeightWindowSet(6, existing).id).toBe(2);
    });

    it('summarizes sets, meshes, and energy groups', () => {
        expect(
            summarizeWeightWindows([
                { id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 1e6, 2e7] },
                { id: 2, meshId: 6, lowerBound: 0.1, energyBounds: [0, 2e7] }
            ])
        ).toBe('2 sets · 2 meshes · 3 energy groups');
    });
});

describe('weight-window bounds', () => {
    it('broadcasts scalars over every cell and energy group', () => {
        const resolved = resolveWeightWindowBounds({ id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 1e6, 2e7] }, MESHES);
        expect(resolved.total).toBe(16);
        expect(resolved.lower).toHaveLength(16);
        expect(resolved.lower.every((value) => value === 0.5)).toBe(true);
        expect(resolved.upper.every((value) => value === 1)).toBe(true);
    });

    it('uses explicit arrays verbatim', () => {
        const lower = Array.from({ length: 8 }, (_, index) => index + 1);
        const resolved = resolveWeightWindowBounds({ id: 1, meshId: 5, lowerBound: lower, energyBounds: [0, 2e7] }, MESHES);
        expect(resolved.lower).toEqual(lower);
        expect(resolved.upper).toEqual(lower.map((value) => value * 2));
    });
});

describe('variance-reduction migration', () => {
    const source = (): OpenMCSource => ({
        type: 'independent',
        spatial: { type: 'point', origin: [0, 0, 0] },
        energy: { type: 'uniform', min: 1e5, max: 2e7 }
    });

    it('maps a legacy energy bias onto the first independent source', () => {
        const result = migrateLegacyVarianceReduction(
            {
                sourceBiasing: { energyBias: { type: 'uniform', min: 1e6, max: 2e7 } },
                weightWindows: { meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7] } as any
            },
            [source()]
        );
        const migrated = result.sources[0] as Extract<OpenMCSource, { spatial: unknown }>;
        expect(migrated.energy.bias).toEqual({ distribution: { type: 'uniform', min: 1e6, max: 2e7 } });
        expect(result.varianceReduction?.sourceBiasing).toBeUndefined();
        expect(result.varianceReduction?.weightWindows).toHaveLength(1);
        expect(result.varianceReduction?.weightWindowsOn).toBe(true);
        expect(result.warnings.some((warning) => warning.includes('energy bias'))).toBe(true);
    });

    it('drops an unrepresentable spatial bias with a warning', () => {
        const result = migrateLegacyVarianceReduction(
            { sourceBiasing: { spatialBias: { type: 'box', lowerLeft: [-1, -1, -1], upperRight: [1, 1, 1] } } },
            [source()]
        );
        expect(result.warnings.some((warning) => warning.includes('spatial source-biasing'))).toBe(true);
        expect(result.varianceReduction).toBeUndefined();
    });
});

describe('variance-reduction validation', () => {
    it('requires a regular UFS mesh in eigenvalue mode', () => {
        const missing = validateVarianceReduction({ ufs: { enabled: true } }, MESHES, 'eigenvalue');
        expect(missing.some((issue) => issue.field === 'ufs' && issue.message.includes('without a mesh'))).toBe(true);

        const cylindrical = validateVarianceReduction({ ufs: { enabled: true, meshId: 7 } }, MESHES, 'eigenvalue');
        expect(cylindrical.some((issue) => issue.message.includes('regular mesh'))).toBe(true);

        const fixed = validateVarianceReduction({ ufs: { enabled: true, meshId: 5 } }, MESHES, 'fixed source');
        expect(fixed.some((issue) => issue.field === 'ufs' && issue.severity === 'warning')).toBe(true);
    });

    it('reports missing meshes, bad bounds, and duplicate IDs', () => {
        const issues = validateVarianceReduction(
            {
                weightWindows: [
                    { id: 1, meshId: 99, lowerBound: 0, energyBounds: [1e6, 0] },
                    { id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 1e6], upperBound: [] }
                ]
            },
            MESHES,
            'eigenvalue'
        );
        expect(issues.some((issue) => issue.message.includes('does not exist'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('strictly increase'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('positive number'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('repeats an existing set ID'))).toBe(true);
        expect(issues.some((issue) => issue.message.includes('empty upper-bound array'))).toBe(true);
    });

    it('reports mismatched bound-array lengths against mesh cells and groups', () => {
        const issues = validateVarianceReduction(
            {
                weightWindows: [
                    {
                        id: 1,
                        meshId: 5,
                        lowerBound: [0.5, 0.5],
                        upperBound: [1, 1],
                        energyBounds: [0, 1e6, 2e7]
                    }
                ]
            },
            MESHES,
            'eigenvalue'
        );
        expect(issues.some((issue) => issue.message.includes('needs 16'))).toBe(true);
    });

    it('rejects disabling both checkpoints while weight windows are on', () => {
        const issues = validateVarianceReduction(
            {
                weightWindows: [{ id: 1, meshId: 5, lowerBound: 0.5, energyBounds: [0, 2e7] }],
                weightWindowCheckpoints: { collision: false, surface: false }
            },
            MESHES,
            'eigenvalue'
        );
        expect(issues.some((issue) => issue.field === 'weight-window-checkpoints' && issue.severity === 'error')).toBe(true);
    });

    it('requires a mesh for the weight-window generator', () => {
        const issues = validateVarianceReduction({ weightWindowGenerator: { method: 'magic' } }, MESHES, 'eigenvalue');
        expect(issues.some((issue) => issue.field === 'weight-window-generator')).toBe(true);
    });
});

describe('source-bias stripping', () => {
    it('removes every bias from an independent source', () => {
        const stripped = stripSourceBias({
            type: 'independent',
            spatial: {
                type: 'pointcloud',
                positions: [[0, 0, 0]],
                strengths: [1],
                bias: { probabilities: [1] }
            },
            energy: { type: 'uniform', min: 0, max: 1, bias: { distribution: { type: 'uniform', min: 0, max: 1 } } },
            angle: {
                type: 'isotropic',
                bias: {
                    distribution: {
                        type: 'mu-phi',
                        mu: { type: 'uniform', min: -1, max: 1 },
                        phi: { type: 'uniform', min: 0, max: 2 * Math.PI }
                    }
                }
            },
            time: { type: 'uniform', min: 0, max: 1, bias: { distribution: { type: 'uniform', min: 0, max: 1 } } }
        }) as any;
        expect(stripped.energy.bias).toBeUndefined();
        expect(stripped.angle.bias).toBeUndefined();
        expect(stripped.time.bias).toBeUndefined();
        expect(stripped.spatial.bias).toBeUndefined();
    });
});
