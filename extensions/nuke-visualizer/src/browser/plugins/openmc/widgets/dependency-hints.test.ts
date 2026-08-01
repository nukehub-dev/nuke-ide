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
 * Tests for {@link detectMissingDependencies} (pure, no DI).
 */

import { describe, expect, it } from 'vitest';
import { detectMissingDependencies } from './dependency-hints';

describe('detectMissingDependencies', () => {
    it('detects the python commands’ missing-dependency messages', () => {
        expect(detectMissingDependencies('vtk not installed (required for VTK export)')).toEqual(['vtk']);
        expect(detectMissingDependencies('h5py not installed')).toEqual(['h5py']);
        expect(detectMissingDependencies("No module named 'trame'")).toEqual(['trame']);
        expect(detectMissingDependencies('Required dependencies not installed: No module named paraview')).toEqual(['paraview']);
    });

    it('collects several dependencies without duplicates', () => {
        expect(detectMissingDependencies("Required dependencies not installed: No module named 'vtk'; trame missing")).toEqual([
            'vtk',
            'trame'
        ]);
    });

    it('detects the node-side environment detection failure', () => {
        expect(detectMissingDependencies('Failed to detect Python environment with trame, paraview, vtk')).toEqual([
            'vtk',
            'trame',
            'paraview'
        ]);
    });

    it('returns undefined for non-dependency errors', () => {
        expect(detectMissingDependencies('File not found: /run/tracks.h5')).toBeUndefined();
        expect(detectMissingDependencies('No IFP tallies found in statepoint.h5')).toBeUndefined();
        expect(detectMissingDependencies("No 'collision_track_bank' dataset in collision_track.h5")).toBeUndefined();
        expect(detectMissingDependencies('Script exited with code 1')).toBeUndefined();
    });
});
