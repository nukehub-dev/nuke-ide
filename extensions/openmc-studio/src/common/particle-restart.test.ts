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
 * Tests for the particle-restart helpers: filename parsing, track-capture
 * derivation, and the `-t` flag decision (pure, no DI).
 */

import { describe, expect, it } from 'vitest';
import { deriveTrackCaptureSettings, isParticleRestartFile, needsTrackFlagForRun, parseParticleRestartFileName } from './particle-restart';

describe('parseParticleRestartFileName', () => {
    it('recognizes the conventional input name without ids', () => {
        expect(parseParticleRestartFileName('particle_restart.h5')).toEqual({ isParticleRestart: true });
        expect(parseParticleRestartFileName('PARTICLE_RESTART.H5')).toEqual({ isParticleRestart: true });
    });

    it('extracts batch and particle id from writer output names', () => {
        expect(parseParticleRestartFileName('particle_17_42.h5')).toEqual({ isParticleRestart: true, batch: 17, particleId: 42 });
        expect(parseParticleRestartFileName('particle_1_1000000.h5')).toEqual({
            isParticleRestart: true,
            batch: 1,
            particleId: 1000000
        });
    });

    it('rejects non-restart files', () => {
        for (const name of [
            'statepoint.100.h5',
            'particle_restart.1.h5',
            'particle_restart.h5.bak',
            'particle_abc.h5',
            'particle_1.h5',
            'my_particle_1_2.h5',
            'tracks.h5'
        ]) {
            expect(parseParticleRestartFileName(name).isParticleRestart).toBe(false);
        }
    });
});

describe('isParticleRestartFile', () => {
    it('matches on the basename only, across separators', () => {
        expect(isParticleRestartFile('/run/output/particle_restart.h5')).toBe(true);
        expect(isParticleRestartFile('C:\\runs\\particle_3_7.h5')).toBe(true);
        expect(isParticleRestartFile('/run/statepoint.100.h5')).toBe(false);
        expect(isParticleRestartFile(undefined)).toBe(false);
        expect(isParticleRestartFile('')).toBe(false);
    });
});

describe('deriveTrackCaptureSettings', () => {
    it('uses filename ids when present (generation defaults to 1)', () => {
        expect(deriveTrackCaptureSettings({ isParticleRestart: true, batch: 17, particleId: 42 })).toEqual({
            tracks: [[17, 1, 42]],
            maxTracks: 1
        });
    });

    it('falls back to maxTracks only', () => {
        expect(deriveTrackCaptureSettings({ isParticleRestart: true })).toEqual({ maxTracks: 1 });
        expect(deriveTrackCaptureSettings({ isParticleRestart: false })).toEqual({ maxTracks: 1 });
    });
});

describe('needsTrackFlagForRun', () => {
    it('requires both a particle restart file and enabled capture', () => {
        expect(needsTrackFlagForRun('/run/particle_restart.h5', true)).toBe(true);
        expect(needsTrackFlagForRun('/run/particle_1_2.h5', true)).toBe(true);
        expect(needsTrackFlagForRun('/run/particle_restart.h5', false)).toBe(false);
        expect(needsTrackFlagForRun('/run/statepoint.100.h5', true)).toBe(false);
        expect(needsTrackFlagForRun(undefined, true)).toBe(false);
    });
});
