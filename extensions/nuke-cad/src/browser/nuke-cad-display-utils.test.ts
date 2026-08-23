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

import { describe, it, expect } from 'vitest';
import {
    isDisplayBuild,
    boundingBoxDiagonal,
    computeDisplayTolerance,
    formatTriangleBudgetWarning,
    withTriangleBudgetWarning,
    DEFAULT_MAX_DISPLAY_TRIANGLES
} from './nuke-cad-display-utils';
import type { GeometryBuildRequest, BuildDocumentRequest, GeometryBuildResult } from '../common/nuke-cad-protocol';

describe('isDisplayBuild', () => {
    it('treats document builds without export flags as display builds', () => {
        expect(isDisplayBuild({ scriptPath: '/tmp/model.nuke-cad' } as BuildDocumentRequest, 'document')).toBe(true);
    });

    it('treats document builds with explicit false flags as display builds', () => {
        expect(
            isDisplayBuild({ scriptPath: '/tmp/model.nuke-cad', exportDagmc: false, exportMesh: false } as BuildDocumentRequest, 'document')
        ).toBe(true);
    });

    it('treats document builds with explicit true export flags as export builds', () => {
        expect(isDisplayBuild({ scriptPath: '/tmp/model.nuke-cad', exportDagmc: true } as BuildDocumentRequest, 'document')).toBe(false);
        expect(isDisplayBuild({ scriptPath: '/tmp/model.nuke-cad', exportMesh: true } as BuildDocumentRequest, 'document')).toBe(false);
    });

    it('treats STEP imports as display builds', () => {
        expect(
            isDisplayBuild({ scriptPath: '/tmp/model.step', exportDagmc: false, exportMesh: false } as GeometryBuildRequest, 'step')
        ).toBe(true);
        expect(isDisplayBuild({ scriptPath: '/tmp/model.step' } as GeometryBuildRequest, 'step')).toBe(true);
    });

    it('treats script builds as export builds', () => {
        expect(isDisplayBuild({ scriptPath: '/tmp/model.py' } as GeometryBuildRequest, 'script')).toBe(false);
    });

    it('honors explicit export flags regardless of source type', () => {
        expect(
            isDisplayBuild({ scriptPath: '/tmp/model.py', exportDagmc: false, exportMesh: false } as GeometryBuildRequest, 'script')
        ).toBe(true);
        expect(isDisplayBuild({ scriptPath: '/tmp/model.step', exportDagmc: true } as GeometryBuildRequest, 'step')).toBe(false);
    });
});

describe('boundingBoxDiagonal', () => {
    it('returns 0 for missing box', () => {
        expect(boundingBoxDiagonal(undefined)).toBe(0);
    });

    it('returns 0 for malformed box', () => {
        expect(boundingBoxDiagonal({ min: [0], max: [1] })).toBe(0);
    });

    it('computes a unit cube diagonal', () => {
        expect(boundingBoxDiagonal({ min: [0, 0, 0], max: [1, 1, 1] })).toBeCloseTo(Math.sqrt(3));
    });

    it('computes a rectangular box diagonal', () => {
        expect(boundingBoxDiagonal({ min: [0, 0, 0], max: [3, 4, 0] })).toBe(5);
    });
});

describe('computeDisplayTolerance', () => {
    it('returns display tolerance when no bounding box is available', () => {
        expect(computeDisplayTolerance(0.01, DEFAULT_MAX_DISPLAY_TRIANGLES)).toBe(0.01);
    });

    it('returns display tolerance when box is degenerate', () => {
        expect(computeDisplayTolerance(0.01, DEFAULT_MAX_DISPLAY_TRIANGLES, { min: [0, 0, 0], max: [0, 0, 0] })).toBe(0.01);
    });

    it('uses the heuristic when it suggests a coarser tolerance', () => {
        // Diagonal ~ 17320; heuristic > 0.01.
        const box = { min: [0, 0, 0], max: [10_000, 10_000, 10_000] };
        const tolerance = computeDisplayTolerance(0.01, DEFAULT_MAX_DISPLAY_TRIANGLES, box);
        expect(tolerance).toBeGreaterThan(0.01);
    });

    it('keeps display tolerance when heuristic suggests finer meshing', () => {
        // Diagonal ~ 1.73; heuristic < 0.01.
        const box = { min: [0, 0, 0], max: [1, 1, 1] };
        const tolerance = computeDisplayTolerance(0.01, DEFAULT_MAX_DISPLAY_TRIANGLES, box);
        expect(tolerance).toBe(0.01);
    });

    it('respects a reduced triangle budget', () => {
        const box = { min: [0, 0, 0], max: [100, 100, 100] };
        const coarse = computeDisplayTolerance(0.01, 10_000, box);
        const fine = computeDisplayTolerance(0.01, DEFAULT_MAX_DISPLAY_TRIANGLES, box);
        expect(coarse).toBeGreaterThanOrEqual(fine);
    });
});

describe('formatTriangleBudgetWarning', () => {
    it('returns undefined when count is missing', () => {
        expect(formatTriangleBudgetWarning(undefined, DEFAULT_MAX_DISPLAY_TRIANGLES)).toBeUndefined();
    });

    it('returns undefined when count is within budget', () => {
        expect(formatTriangleBudgetWarning(100, DEFAULT_MAX_DISPLAY_TRIANGLES)).toBeUndefined();
        expect(formatTriangleBudgetWarning(DEFAULT_MAX_DISPLAY_TRIANGLES, DEFAULT_MAX_DISPLAY_TRIANGLES)).toBeUndefined();
    });

    it('returns a warning when count exceeds budget', () => {
        const warning = formatTriangleBudgetWarning(DEFAULT_MAX_DISPLAY_TRIANGLES + 1, DEFAULT_MAX_DISPLAY_TRIANGLES);
        expect(warning).toBeDefined();
        expect(warning).toContain('exceeds the display budget');
        expect(warning).toContain('DAGMC and FEM export tolerances are unaffected');
    });
});

describe('withTriangleBudgetWarning', () => {
    it('returns the result unchanged when within budget', () => {
        const result: GeometryBuildResult = { success: true, triangleCount: 100 };
        expect(withTriangleBudgetWarning(result, DEFAULT_MAX_DISPLAY_TRIANGLES)).toBe(result);
    });

    it('adds a warning to an existing warnings array', () => {
        const result: GeometryBuildResult = { success: true, triangleCount: DEFAULT_MAX_DISPLAY_TRIANGLES + 1, warnings: ['existing'] };
        const updated = withTriangleBudgetWarning(result, DEFAULT_MAX_DISPLAY_TRIANGLES);
        expect(updated.warnings).toEqual(['existing', expect.stringContaining('display budget')]);
    });
});
