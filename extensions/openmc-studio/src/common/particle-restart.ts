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
 * Pure helpers for particle-restart runs (`openmc -r particle_restart.h5`).
 *
 * Filename conventions (OpenMC `src/particle.cpp::Particle::write_restart`):
 * the writer produces `particle_<batch>_<particle_id>.h5`; `particle_restart.h5`
 * is the conventional name users give the file when feeding it back via `-r`.
 *
 * Track capture note: in particle-restart mode OpenMC only writes tracks when
 * `write_all_tracks` is set, which comes exclusively from the CLI flag `-t`
 * (`src/initialize.cpp:354-356`, `src/particle_restart.cpp:101-105`) — the
 * `<max_tracks>`/`<track>` settings.xml elements are ignored in that mode.
 * The `-t` flag is added by the dashboard at run time; the settings produced
 * here document the intent and also apply to later non-restart runs.
 */

export interface ParticleRestartFileInfo {
    /** True when the basename is a particle restart file */
    isParticleRestart: boolean;
    /** Batch the particle was lost in (only from `particle_<batch>_<id>.h5`) */
    batch?: number;
    /** Particle identifier (only from `particle_<batch>_<id>.h5`) */
    particleId?: number;
}

/** Parse a restart filename for particle-restart identity and embedded ids. */
export function parseParticleRestartFileName(baseName: string): ParticleRestartFileInfo {
    const name = baseName.toLowerCase();
    if (name === 'particle_restart.h5') {
        return { isParticleRestart: true };
    }
    const match = /^particle_(\d+)_(\d+)\.h5$/.exec(name);
    if (match) {
        return { isParticleRestart: true, batch: parseInt(match[1], 10), particleId: parseInt(match[2], 10) };
    }
    return { isParticleRestart: false };
}

/** True when the given path points at a particle restart file. */
export function isParticleRestartFile(path: string | undefined): boolean {
    if (!path) {
        return false;
    }
    const baseName = path.split(/[\\/]/).pop() ?? '';
    return parseParticleRestartFileName(baseName).isParticleRestart;
}

export interface TrackCaptureSettings {
    /** Explicit [batch, generation, particle] triples (only when ids are known) */
    tracks?: [number, number, number][];
    /** Always 1: capture at most the restarted particle */
    maxTracks: number;
}

/**
 * Derive track-capture settings for a particle-restart run. When the filename
 * carries the batch/particle ids, an explicit triple is included (generation
 * defaults to 1 — the filename does not carry it); `maxTracks: 1` is always
 * set as a safety net so at most one track is written.
 */
export function deriveTrackCaptureSettings(info: ParticleRestartFileInfo): TrackCaptureSettings {
    if (info.isParticleRestart && info.batch !== undefined && info.particleId !== undefined) {
        return { tracks: [[info.batch, 1, info.particleId]], maxTracks: 1 };
    }
    return { maxTracks: 1 };
}

/**
 * True when a run with this restart file needs the `-t` CLI flag to capture
 * the restarted particle's track: particle-restart mode ignores the
 * settings.xml track elements, so `-t` is the only switch.
 */
export function needsTrackFlagForRun(restartFile: string | undefined, trackCaptureEnabled: boolean): boolean {
    return trackCaptureEnabled && isParticleRestartFile(restartFile);
}
