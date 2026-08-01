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
 * Tests for the output viewers' file-claim patterns: tracks, collision
 * track, and weight windows files route to their viewers through
 * {@link selectOutputViewer}, while other OpenMC `.h5` outputs (statepoint,
 * source, depletion) fall through to the existing handlers. The real
 * contributions (openmc-*-viewer-contribution.ts) build their `canHandle`
 * from these exact pattern functions and scores — the widget dependency
 * chain cannot be imported in a node test environment, so the patterns are
 * exercised here as pure data.
 */

import { describe, expect, it } from 'vitest';
import URI from '@theia/core/lib/common/uri';
import { OutputViewerContribution, selectOutputViewer } from './output-viewer-registry';
import {
    isCollisionTrackFileName,
    isParticleRestartFileName,
    isSummaryFileName,
    isTracksFileName,
    isVoxelPlotFileName,
    isWeightWindowsFileName
} from './output-file-patterns';

/** Mirror of the real contributions' canHandle (same pattern fns and scores). */
function contribution(id: string, matches: (base: string) => boolean): OutputViewerContribution {
    return {
        id,
        label: id,
        priority: 100,
        canHandle: (uri: URI) => (matches(uri.path.base) ? 600 : 0),
        open: async () => undefined
    };
}

const tracksContribution = contribution('openmc-tracks-viewer', isTracksFileName);
const collisionContribution = contribution('openmc-collision-track-viewer', isCollisionTrackFileName);
const weightWindowsContribution = contribution('openmc-weight-windows-viewer', isWeightWindowsFileName);
const particleRestartContribution = contribution('openmc-particle-restart-viewer', isParticleRestartFileName);
const voxelPlotContribution = contribution('openmc-voxel-plot-viewer', isVoxelPlotFileName);
const summaryContribution = contribution('openmc-summary-viewer', isSummaryFileName);
const allContributions = [
    tracksContribution,
    collisionContribution,
    weightWindowsContribution,
    particleRestartContribution,
    voxelPlotContribution,
    summaryContribution
];

describe('output file patterns', () => {
    it('matches tracks files including MPI ranks', () => {
        expect(isTracksFileName('tracks.h5')).toBe(true);
        expect(isTracksFileName('tracks_p0.h5')).toBe(true);
        expect(isTracksFileName('tracks_p127.h5')).toBe(true);
        expect(isTracksFileName('TRACKS.H5')).toBe(true);
        expect(isTracksFileName('tracks.h5.bak')).toBe(false);
        expect(isTracksFileName('my_tracks.h5')).toBe(false);
        expect(isTracksFileName('statepoint.100.h5')).toBe(false);
    });

    it('matches collision track files including numbered splits', () => {
        expect(isCollisionTrackFileName('collision_track.h5')).toBe(true);
        expect(isCollisionTrackFileName('collision_track.1.h5')).toBe(true);
        expect(isCollisionTrackFileName('collision_track.12.h5')).toBe(true);
        expect(isCollisionTrackFileName('collision_track.h5.tmp')).toBe(false);
        expect(isCollisionTrackFileName('tracks.h5')).toBe(false);
    });

    it('matches weight windows files exactly', () => {
        expect(isWeightWindowsFileName('weight_windows.h5')).toBe(true);
        expect(isWeightWindowsFileName('WEIGHT_WINDOWS.H5')).toBe(true);
        expect(isWeightWindowsFileName('weight_windows.1.h5')).toBe(false);
        expect(isWeightWindowsFileName('my_weight_windows.h5')).toBe(false);
    });

    it('matches particle restart files (input name and writer output name)', () => {
        expect(isParticleRestartFileName('particle_restart.h5')).toBe(true);
        expect(isParticleRestartFileName('particle_17_42.h5')).toBe(true);
        expect(isParticleRestartFileName('PARTICLE_RESTART.H5')).toBe(true);
        expect(isParticleRestartFileName('particle_restart.1.h5')).toBe(false);
        expect(isParticleRestartFileName('particle_restart.h5.bak')).toBe(false);
        expect(isParticleRestartFileName('particle_abc.h5')).toBe(false);
        expect(isParticleRestartFileName('statepoint.100.h5')).toBe(false);
    });

    it('matches voxel plot files without colliding with other outputs', () => {
        expect(isVoxelPlotFileName('voxel_plot.h5')).toBe(true);
        expect(isVoxelPlotFileName('plot_1.h5')).toBe(true);
        expect(isVoxelPlotFileName('plot_12.h5')).toBe(true);
        expect(isVoxelPlotFileName('VOXEL_PLOT.H5')).toBe(true);
        expect(isVoxelPlotFileName('my_voxel.h5')).toBe(true);
        // No collisions with the other claimed outputs
        expect(isVoxelPlotFileName('statepoint.100.h5')).toBe(false);
        expect(isVoxelPlotFileName('source.h5')).toBe(false);
        expect(isVoxelPlotFileName('depletion_results.h5')).toBe(false);
        expect(isVoxelPlotFileName('tracks.h5')).toBe(false);
        expect(isVoxelPlotFileName('collision_track.h5')).toBe(false);
        expect(isVoxelPlotFileName('weight_windows.h5')).toBe(false);
        expect(isVoxelPlotFileName('particle_restart.h5')).toBe(false);
        expect(isVoxelPlotFileName('summary.h5')).toBe(false);
        expect(isVoxelPlotFileName('plot_1.h5.bak')).toBe(false);
    });

    it('matches summary.h5 exactly', () => {
        expect(isSummaryFileName('summary.h5')).toBe(true);
        expect(isSummaryFileName('SUMMARY.H5')).toBe(true);
        expect(isSummaryFileName('summary.1.h5')).toBe(false);
        expect(isSummaryFileName('my_summary.h5')).toBe(false);
        expect(isSummaryFileName('statepoint.100.h5')).toBe(false);
    });
});

describe('output viewer routing', () => {
    it('claims only its own file kind', () => {
        expect(tracksContribution.canHandle(new URI('file:///run/tracks.h5'))).toBeGreaterThan(0);
        expect(tracksContribution.canHandle(new URI('file:///run/collision_track.h5'))).toBe(0);
        expect(tracksContribution.canHandle(new URI('file:///run/weight_windows.h5'))).toBe(0);

        expect(collisionContribution.canHandle(new URI('file:///run/collision_track.2.h5'))).toBeGreaterThan(0);
        expect(collisionContribution.canHandle(new URI('file:///run/tracks.h5'))).toBe(0);

        expect(weightWindowsContribution.canHandle(new URI('file:///run/weight_windows.h5'))).toBeGreaterThan(0);
        expect(weightWindowsContribution.canHandle(new URI('file:///run/tracks.h5'))).toBe(0);
    });

    it('routes each output file to its viewer through the registry matcher', () => {
        expect(selectOutputViewer(new URI('file:///run/tracks.h5'), allContributions)).toBe(tracksContribution);
        expect(selectOutputViewer(new URI('file:///run/tracks_p3.h5'), allContributions)).toBe(tracksContribution);
        expect(selectOutputViewer(new URI('file:///run/collision_track.h5'), allContributions)).toBe(collisionContribution);
        expect(selectOutputViewer(new URI('file:///run/weight_windows.h5'), allContributions)).toBe(weightWindowsContribution);
        expect(selectOutputViewer(new URI('file:///run/particle_restart.h5'), allContributions)).toBe(particleRestartContribution);
        expect(selectOutputViewer(new URI('file:///run/particle_17_42.h5'), allContributions)).toBe(particleRestartContribution);
        expect(selectOutputViewer(new URI('file:///run/voxel_plot.h5'), allContributions)).toBe(voxelPlotContribution);
        expect(selectOutputViewer(new URI('file:///run/plot_1.h5'), allContributions)).toBe(voxelPlotContribution);
        expect(selectOutputViewer(new URI('file:///run/summary.h5'), allContributions)).toBe(summaryContribution);
    });

    it('lets statepoint/source/depletion files fall through', () => {
        for (const name of ['statepoint.100.h5', 'statepoint.h5', 'source.h5', 'depletion_results.h5']) {
            expect(selectOutputViewer(new URI(`file:///run/${name}`), allContributions)).toBeUndefined();
        }
    });
});
