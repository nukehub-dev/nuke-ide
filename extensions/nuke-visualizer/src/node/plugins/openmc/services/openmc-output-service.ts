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

import { injectable, inject } from '@theia/core/shared/inversify';
import {
    OpenMCTracksInfo,
    OpenMCTracksData,
    OpenMCTracksDataOptions,
    OpenMCTracksVtkOptions,
    OpenMCCollisionTrackInfo,
    OpenMCCollisionTrackData,
    OpenMCCollisionTrackQuery,
    OpenMCCollisionVtkOptions,
    OpenMCWeightWindowsData,
    OpenMCVtkConversionResult,
    OpenMCKineticsResult,
    OpenMCVtkFileInfo,
    OpenMCParticleRestart,
    NuclearDataLibraryRequest,
    NuclearDataLibraryResult,
    NuclideDetailRequest,
    NuclideDetailResult
} from '../../../../common/openmc-protocol';
import { PythonCommandHelper } from '../../../services/python-command-helper';

/**
 * Backend data/conversion queries for the OpenMC output file viewers
 * (particle tracks, collision tracks, weight windows). Wraps the
 * `openmc.tracks-*`, `openmc.collision-track-*`, `openmc.weight-windows*` and
 * `openmc.*-vtk` commands of `python/server.py`.
 */
@injectable()
export class OpenMCOutputService {
    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    private get scriptPath(): string {
        return this.pythonHelper.findScript('server.py');
    }

    async getTracksInfo(filePath: string): Promise<OpenMCTracksInfo> {
        return this.executeCommandJson<OpenMCTracksInfo>(['openmc.tracks-info', filePath]);
    }

    async getTracksData(filePath: string, options?: OpenMCTracksDataOptions): Promise<OpenMCTracksData> {
        const args = ['openmc.tracks-data', filePath];
        if (options?.offset !== undefined) {
            args.push('--offset', options.offset.toString());
        }
        if (options?.limit !== undefined) {
            args.push('--limit', options.limit.toString());
        }
        if (options?.maxPoints !== undefined) {
            args.push('--max-points', options.maxPoints.toString());
        }
        if (options?.particle) {
            args.push('--particle', options.particle);
        }
        if (options?.cell?.length) {
            args.push('--cell', options.cell.join(','));
        }
        if (options?.material?.length) {
            args.push('--material', options.material.join(','));
        }
        return this.executeCommandJson<OpenMCTracksData>(args);
    }

    async convertTracksToVtk(filePath: string, options?: OpenMCTracksVtkOptions): Promise<OpenMCVtkConversionResult> {
        const args = ['openmc.tracks-vtk', filePath];
        if (options?.particle) {
            args.push('--particle', options.particle);
        }
        if (options?.cell?.length) {
            args.push('--cell', options.cell.join(','));
        }
        if (options?.material?.length) {
            args.push('--material', options.material.join(','));
        }
        if (options?.maxTracks !== undefined) {
            args.push('--max-tracks', options.maxTracks.toString());
        }
        if (options?.maxPoints !== undefined) {
            args.push('--max-points', options.maxPoints.toString());
        }
        return this.runConversion(args);
    }

    async getCollisionTrackInfo(filePath: string): Promise<OpenMCCollisionTrackInfo> {
        return this.executeCommandJson<OpenMCCollisionTrackInfo>(['openmc.collision-track-info', filePath]);
    }

    async getCollisionTrackData(filePath: string, query?: OpenMCCollisionTrackQuery): Promise<OpenMCCollisionTrackData> {
        const args = ['openmc.collision-track-data', filePath];
        if (query?.offset !== undefined) {
            args.push('--offset', query.offset.toString());
        }
        if (query?.limit !== undefined) {
            args.push('--limit', query.limit.toString());
        }
        if (query?.mt?.length) {
            args.push('--mt', query.mt.join(','));
        }
        if (query?.cell?.length) {
            args.push('--cell', query.cell.join(','));
        }
        return this.executeCommandJson<OpenMCCollisionTrackData>(args);
    }

    async convertCollisionTrackToVtk(filePath: string, options?: OpenMCCollisionVtkOptions): Promise<OpenMCVtkConversionResult> {
        const args = ['openmc.collision-vtk', filePath];
        if (options?.mt?.length) {
            args.push('--mt', options.mt.join(','));
        }
        if (options?.cell?.length) {
            args.push('--cell', options.cell.join(','));
        }
        if (options?.limit !== undefined) {
            args.push('--limit', options.limit.toString());
        }
        return this.runConversion(args, 120000);
    }

    async getWeightWindows(filePath: string): Promise<OpenMCWeightWindowsData> {
        return this.executeCommandJson<OpenMCWeightWindowsData>(['openmc.weight-windows', filePath]);
    }

    async getKineticsParameters(statepointPath: string): Promise<OpenMCKineticsResult> {
        return this.executeCommandJson<OpenMCKineticsResult>(['openmc.kinetics', statepointPath]);
    }

    async convertVoxelToVtk(filePath: string): Promise<OpenMCVtkConversionResult> {
        return this.runConversion(['openmc.voxel-vtk', filePath], 120000);
    }

    async getVtkInfo(filePath: string): Promise<OpenMCVtkFileInfo> {
        return this.executeCommandJson<OpenMCVtkFileInfo>(['openmc.vtk-info', filePath]);
    }

    async getParticleRestart(filePath: string): Promise<OpenMCParticleRestart> {
        return this.executeCommandJson<OpenMCParticleRestart>(['openmc.particle-restart', filePath]);
    }

    async getNuclearDataLibrary(request: NuclearDataLibraryRequest): Promise<NuclearDataLibraryResult> {
        const args = ['openmc.nuclear-data-library'];
        if (request.crossSectionsPath) {
            args.push('--cross-sections', request.crossSectionsPath);
        }
        // Library scans read hundreds of HDF5 group keys — allow a long timeout
        return this.executeCommandJson<NuclearDataLibraryResult>(args, 300000);
    }

    async getNuclideDetail(request: NuclideDetailRequest): Promise<NuclideDetailResult> {
        return this.executeCommandJson<NuclideDetailResult>(['openmc.nuclear-data-nuclide', request.path], 120000);
    }

    /**
     * Run an openmc.* command and parse its stdout JSON. Error reporting is
     * stdout-first: on non-zero exit, a parsed `{"error": ...}` payload
     * provides the message (this is the genuine command error); stderr —
     * which may carry unrelated plugin-load log lines — is only a fallback.
     * Structured `{"success": false, ...}` envelopes (nuclear-data commands)
     * are returned as-is so callers can render them.
     */
    protected async executeCommandJson<T>(args: string[], timeout = 60000): Promise<T> {
        const result = await this.pythonHelper.executeScript(this.scriptPath, args, {
            timeout,
            maxBuffer: 64 * 1024 * 1024
        });

        let parsed: Record<string, unknown> | undefined;
        try {
            parsed = JSON.parse(result.stdout) as Record<string, unknown>;
        } catch {
            parsed = undefined;
        }

        if (result.status !== 0) {
            if (parsed && 'success' in parsed && typeof parsed.error === 'string') {
                return parsed as T; // structured failure envelope
            }
            const message =
                (parsed && typeof parsed.error === 'string' && parsed.error) ||
                result.stderr.trim() ||
                `Command '${args[0]}' exited with code ${result.status}`;
            throw new Error(message);
        }
        if (parsed === undefined) {
            throw new Error(`Command '${args[0]}' produced non-JSON output (exit ${result.status}): ${result.stdout.substring(0, 500)}`);
        }
        return parsed as T;
    }

    async convertWeightWindowsToVtk(filePath: string, meshId?: number): Promise<OpenMCVtkConversionResult> {
        const args = ['openmc.weight-windows-vtk', filePath];
        if (meshId !== undefined) {
            args.push('--mesh-id', String(meshId));
        }
        return this.runConversion(args, 120000);
    }

    /**
     * Run a `openmc.*-vtk` conversion command and normalize the result:
     * the command prints `{"vtkPath": ...}` on success; failures (non-zero
     * exit or an `{"error": ...}` payload) become `{ success: false, error }`.
     */
    protected async runConversion(args: string[], timeout = 60000): Promise<OpenMCVtkConversionResult> {
        try {
            const raw = await this.executeCommandJson<Record<string, unknown>>(args, timeout);
            if (typeof raw.error === 'string') {
                return { success: false, error: raw.error };
            }
            const { vtkPath, ...stats } = raw;
            return { success: true, vtkPath: vtkPath as string, stats };
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
}
