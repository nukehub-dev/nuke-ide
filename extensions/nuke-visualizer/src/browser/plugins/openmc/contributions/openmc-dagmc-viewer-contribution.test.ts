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
 * Tests for the native DAGMC viewer's file-claim scores: raw `.h5m` files
 * route to the isolating multiblock viewer (converted on open, with a
 * generic-viewer fallback), while `.vtm` manifests keep their direct claim.
 * The real contribution (`openmc-dagmc-viewer-contribution.ts`) builds its
 * `canHandle` from these exact pattern functions and scores — the widget
 * dependency chain cannot be imported in a node test environment, so the
 * claims are exercised here as pure data (same pattern as
 * `output-viewer-contributions.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import URI from '@theia/core/lib/common/uri';

/** Mirror of `isDagmcMultiblockFileName` in the real contribution. */
function isDagmcMultiblockFileName(baseName: string): boolean {
    return baseName.toLowerCase().endsWith('.vtm');
}

/** Mirror of `isDagmcH5mFileName` in the real contribution. */
function isDagmcH5mFileName(baseName: string): boolean {
    return baseName.toLowerCase().endsWith('.h5m');
}

/** Mirror of the real contribution's scores (h5m beats the generic opener's 1000). */
const DAGMC_H5M_CLAIM_SCORE = 1100;
const DAGMC_VTM_CLAIM_SCORE = 600;

/** Mirror of the real contribution's `canHandle`. */
function canHandle(uri: URI): number {
    const base = uri.path.base;
    if (isDagmcH5mFileName(base)) {
        return DAGMC_H5M_CLAIM_SCORE;
    }
    return isDagmcMultiblockFileName(base) ? DAGMC_VTM_CLAIM_SCORE : 0;
}

/** The generic visualizer opener's `.h5m` score (`visualizer-open-handler.ts`). */
const GENERIC_H5M_SCORE = 1000;

describe('dagmc viewer claims', () => {
    it('matches .h5m files case-insensitively', () => {
        expect(isDagmcH5mFileName('tokamak.h5m')).toBe(true);
        expect(isDagmcH5mFileName('TOKAMAK.H5M')).toBe(true);
        expect(isDagmcH5mFileName('tokamak_volumes.vtm')).toBe(false);
        expect(isDagmcH5mFileName('model.h5m.bak')).toBe(false);
        expect(isDagmcH5mFileName('statepoint.100.h5')).toBe(false);
    });

    it('matches .vtm manifests case-insensitively', () => {
        expect(isDagmcMultiblockFileName('tokamak_volumes.vtm')).toBe(true);
        expect(isDagmcMultiblockFileName('TOKAMAK_VOLUMES.VTM')).toBe(true);
        expect(isDagmcMultiblockFileName('tokamak.h5m')).toBe(false);
        expect(isDagmcMultiblockFileName('model.vtm.bak')).toBe(false);
    });

    it('claims .h5m above the generic visualizer opener', () => {
        expect(canHandle(new URI('file:///run/tokamak.h5m'))).toBe(DAGMC_H5M_CLAIM_SCORE);
        expect(DAGMC_H5M_CLAIM_SCORE).toBeGreaterThan(GENERIC_H5M_SCORE);
    });

    it('keeps the .vtm direct claim', () => {
        expect(canHandle(new URI('file:///run/tokamak_volumes.vtm'))).toBe(DAGMC_VTM_CLAIM_SCORE);
    });

    it('ignores unrelated files', () => {
        for (const name of ['model.vtk', 'model.vtp', 'part.step', 'tracks.h5', 'statepoint.100.h5']) {
            expect(canHandle(new URI(`file:///run/${name}`))).toBe(0);
        }
    });
});
