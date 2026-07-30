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
 * Filename patterns for OpenMC output files claimed by the output viewers.
 * Pure functions (no DI) so the viewer contributions' canHandle logic is
 * unit-testable without a container. Matching is case-insensitive on the
 * file basename.
 */

/** `tracks.h5` and per-rank `tracks_p<N>.h5` particle track files. */
export function isTracksFileName(baseName: string): boolean {
    return /^tracks(_p\d+)?\.h5$/.test(baseName.toLowerCase());
}

/** `collision_track.h5` and numbered `collision_track.<N>.h5` files. */
export function isCollisionTrackFileName(baseName: string): boolean {
    return /^collision_track(\.\d+)?\.h5$/.test(baseName.toLowerCase());
}

/** `weight_windows.h5` files. */
export function isWeightWindowsFileName(baseName: string): boolean {
    return baseName.toLowerCase() === 'weight_windows.h5';
}

/**
 * `particle_restart.h5` (conventional input name) and OpenMC's lost-particle
 * output files `particle_<batch>_<id>.h5` (src/particle.cpp write_restart).
 */
export function isParticleRestartFileName(baseName: string): boolean {
    const name = baseName.toLowerCase();
    return name === 'particle_restart.h5' || /^particle_\d+_\d+\.h5$/.test(name);
}
