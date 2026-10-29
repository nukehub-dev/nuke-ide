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

import { injectable, inject } from '@theia/core/shared/inversify';
import { RawProcessFactory, RawProcess } from '@theia/process/lib/node/raw-process';

import {
    OpenMCBackendService,
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    OpenMCTallySeries,
    OpenMCTallySeriesOptions,
    XSGroupStructuresResponse,
    PythonConfig,
    VisualizerClient,
    OPENMC_REQUIREMENTS,
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
    OpenMCGeometryMeshResult,
    OpenMCKineticsResult,
    OpenMCVtkFileInfo,
    OpenMCParticleRestart,
    NuclearDataLibraryRequest,
    NuclearDataLibraryResult,
    NuclideDetailRequest,
    NuclideDetailResult,
    NCrystalMaterialsRequest,
    NCrystalMaterialsResult,
    NCrystalInfoRequest,
    NCrystalInfoResult,
    NCrystalXSRequest,
    NCrystalXSResult,
    EndfEvaluationsRequest,
    EndfEvaluationsResult,
    EndfDetailRequest,
    EndfDetailResult,
    OpenMCTallyMeshVtkOptions,
    OpenMCSourceVtkOptions,
    OpenMCOverlayVtkOptions,
    OpenMCOverlayGeometryVtkOptions,
    OpenMCTallyLineProbeOptions,
    OpenMCTallyLineProbeResult,
    OpenMCTallyContourOptions
} from '../../../common/openmc-protocol';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import { PythonCommandHelper } from '../../services/python-command-helper';
import { OpenMCStatepointService, OpenMCGeometryService, OpenMCXSService, OpenMCDepletionService, OpenMCOutputService } from './services';

interface OpenMCProcess {
    process: RawProcess;
    port: number;
    filePath: string;
}

/**
 * Render a pip install hint for a requirement entry, honoring its structured
 * spec fields (`extraIndexUrl`, `pipSpec`, `pipArgs`).
 */
function pipInstallHint(name: string): string {
    const def = OPENMC_REQUIREMENTS.find((r) => r.name === name);
    const args = [...(def?.pipArgs ?? [])];
    if (def?.extraIndexUrl) {
        args.push('--extra-index-url', def.extraIndexUrl);
    }
    args.push(def?.pipSpec ?? name);
    return `pip install ${args.join(' ')}`;
}

/**
 * Node.js backend implementation of the OpenMC visualization RPC service.
 *
 * Runs headless `server.py` conversion/info commands and delegates data
 * queries to specialized sub-services (no visualization servers are spawned;
 * all viewers render natively in the frontend):
 * - {@link OpenMCStatepointService} — statepoint and tally data
 * - {@link OpenMCGeometryService} — geometry hierarchy and materials
 * - {@link OpenMCXSService} — cross-section plotting
 * - {@link OpenMCDepletionService} — depletion/burnup analysis
 *
 * @see src/common/openmc-protocol.ts for the RPC interface
 * @see src/browser/plugins/openmc/openmc-service.ts for the frontend consumer
 */
@injectable()
export class OpenMCBackendServiceImpl implements OpenMCBackendService {
    private processes: Map<number, OpenMCProcess> = new Map();
    private reservedPorts: Set<number> = new Set();

    @inject(RawProcessFactory)
    protected readonly rawProcessFactory: RawProcessFactory;

    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    @inject(OpenMCStatepointService)
    protected readonly statepointService: OpenMCStatepointService;

    @inject(OpenMCGeometryService)
    protected readonly geometryService: OpenMCGeometryService;

    @inject(OpenMCXSService)
    protected readonly xsService: OpenMCXSService;

    @inject(OpenMCDepletionService)
    protected readonly depletionService: OpenMCDepletionService;

    @inject(OpenMCOutputService)
    protected readonly outputService: OpenMCOutputService;

    setClient(_client: VisualizerClient): void {
        // No log streaming is wired through the client on this service; the
        // parameter only satisfies the shared RPC interface.
    }

    /**
     * Check whether a port belongs to a visualization server started by this
     * service. No servers are spawned anymore (all viewers render natively),
     * so this always reports false; it stays so the RPC surface is stable.
     */
    isVisualizerPort(port: number): boolean {
        return this.processes.has(port);
    }

    async setPythonConfig(config: PythonConfig): Promise<void> {
        // Also update nuke-core config
        await this.nukeCoreService.setConfig({
            pythonPath: config.pythonPath,
            condaEnv: config.condaEnv
        });
        this.statepointService.setPythonConfig(config);
        console.log(`[OpenMC] Python config updated: ${JSON.stringify(config)}`);
    }

    async loadStatepoint(statepointPath: string): Promise<OpenMCStatepointInfo> {
        return this.statepointService.loadStatepoint(statepointPath);
    }

    async listTallies(statepointPath: string): Promise<OpenMCTallyInfo[]> {
        return this.statepointService.listTallies(statepointPath);
    }

    async getTallySeries(files: string[], options: OpenMCTallySeriesOptions): Promise<OpenMCTallySeries> {
        return this.statepointService.getTallySeries(files, options);
    }

    async getEnergySpectrum(statepointPath: string, tallyId: number, scoreIndex: number = 0, nuclideIndex: number = 0): Promise<any> {
        return this.statepointService.getEnergySpectrum(statepointPath, tallyId, scoreIndex, nuclideIndex);
    }

    async getSpatialPlot(
        statepointPath: string,
        tallyId: number,
        axis: 'x' | 'y' | 'z',
        scoreIndex: number = 0,
        nuclideIndex: number = 0
    ): Promise<any> {
        return this.statepointService.getSpatialPlot(statepointPath, tallyId, axis, scoreIndex, nuclideIndex);
    }

    async getHeatmapSlice(
        statepointPath: string,
        tallyId: number,
        plane: 'xy' | 'xz' | 'yz',
        sliceIndex: number,
        scoreIndex: number = 0,
        nuclideIndex: number = 0
    ): Promise<any> {
        return this.statepointService.getHeatmapSlice(statepointPath, tallyId, plane, sliceIndex, scoreIndex, nuclideIndex);
    }

    async getAllHeatmapSlices(
        statepointPath: string,
        tallyId: number,
        plane: 'xy' | 'xz' | 'yz',
        scoreIndex: number = 0,
        nuclideIndex: number = 0
    ): Promise<any[]> {
        return this.statepointService.getAllHeatmapSlices(statepointPath, tallyId, plane, scoreIndex, nuclideIndex);
    }

    async stopServer(port: number): Promise<void> {
        const proc = this.processes.get(port);
        if (proc) {
            proc.process.kill();
            this.processes.delete(port);
            this.reservedPorts.delete(port);
            console.log(`[OpenMC] Stopped server on port ${port}`);
        }
    }

    async checkOpenMCAvailable(): Promise<{ available: boolean; message: string; warning?: string }> {
        try {
            const python = await this.pythonHelper.detectPython();
            const check = await this.pythonHelper.checkPackages(python.command);

            if (!check.available) {
                return {
                    available: false,
                    message: `Missing packages: ${check.missing.join(', ')}. Run: ${check.missing.map(pipInstallHint).join(' and ')}`,
                    warning: python.warning
                };
            }

            const scriptPath = this.pythonHelper.findScript('server.py');
            if (!require('fs').existsSync(scriptPath)) {
                return {
                    available: false,
                    message: `OpenMC integration script not found at ${scriptPath}`,
                    warning: python.warning
                };
            }

            return {
                available: true,
                message: 'OpenMC integration available',
                warning: python.warning
            };
        } catch (error) {
            return {
                available: false,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    // === Cross-Section (XS) Plotting ===

    async getXSData(request: any): Promise<any> {
        return this.xsService.getXSData(request);
    }

    async checkOpenMCPythonAvailable(): Promise<{ available: boolean; message: string; warning?: string }> {
        try {
            const python = await this.pythonHelper.detectPython();
            const check = await this.pythonHelper.checkPackages(python.command, OPENMC_REQUIREMENTS);

            if (!check.available) {
                return {
                    available: false,
                    message: `OpenMC Python module not installed. Run: ${pipInstallHint('openmc')}`,
                    warning: python.warning
                };
            }

            return {
                available: true,
                message: 'OpenMC Python module available',
                warning: python.warning
            };
        } catch (error) {
            return {
                available: false,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async getAvailableNuclides(crossSectionsPath?: string): Promise<string[]> {
        return this.xsService.getAvailableNuclides(crossSectionsPath);
    }

    async getAvailableThermalMaterials(crossSectionsPath?: string): Promise<string[]> {
        return this.xsService.getAvailableThermalMaterials(crossSectionsPath);
    }

    async getGroupStructures(): Promise<XSGroupStructuresResponse> {
        return this.xsService.getGroupStructures();
    }

    // === Depletion/Burnup Methods ===

    async getDepletionSummary(filePath: string): Promise<any> {
        return this.depletionService.getDepletionSummary(filePath);
    }

    async getDepletionMaterials(filePath: string): Promise<any[]> {
        return this.depletionService.getDepletionMaterials(filePath);
    }

    async getDepletionData(filePath: string, materialIndex: number, nuclides?: string[], includeActivity?: boolean): Promise<any> {
        return this.depletionService.getDepletionData(filePath, materialIndex, nuclides, includeActivity);
    }

    // === Geometry Hierarchy Viewer ===

    async getGeometryHierarchy(filePath: string): Promise<any> {
        return this.geometryService.getGeometryHierarchy(filePath);
    }

    // === Material Explorer ===

    async extractGeometryMesh(filePath: string, segments?: number): Promise<OpenMCGeometryMeshResult> {
        return this.geometryService.extractGeometryMesh(filePath, segments);
    }

    async getMaterials(filePath: string): Promise<any> {
        return this.geometryService.getMaterials(filePath);
    }

    async getMaterialCellLinkage(materialsPath: string, geometryPath: string): Promise<any> {
        return this.geometryService.getMaterialCellLinkage(materialsPath, geometryPath);
    }

    async mixMaterials(request: any): Promise<any> {
        return this.geometryService.mixMaterials(request);
    }

    async addMaterial(filePath: string, materialXml: string): Promise<void> {
        return this.geometryService.addMaterialToFile(filePath, materialXml);
    }

    // === Statepoint Viewer ===

    async getStatepointFullInfo(statepointPath: string): Promise<any> {
        return this.statepointService.getStatepointFullInfo(statepointPath);
    }

    async getDerivedTallies(
        statepointPath: string,
        definitions: import('../../../common/openmc-protocol').OpenMCDerivedTallyDefinition[]
    ): Promise<import('../../../common/openmc-protocol').OpenMCDerivedTallyEvaluation> {
        return this.statepointService.getDerivedTallies(statepointPath, definitions);
    }

    async getKGenerationData(statepointPath: string): Promise<any> {
        return this.statepointService.getKGenerationData(statepointPath);
    }

    async getSourceData(statepointPath: string, maxParticles?: number): Promise<any> {
        return this.statepointService.getSourceData(statepointPath, maxParticles);
    }

    async getEnergyDistribution(statepointPath: string, nBins?: number): Promise<any> {
        return this.statepointService.getEnergyDistribution(statepointPath, nBins);
    }

    async getGeometryBounds(geometryPath: string): Promise<{ x: [number, number]; y: [number, number]; z: [number, number] } | null> {
        try {
            const scriptPath = this.pythonHelper.findScript('server.py');
            const result = await this.pythonHelper.executeScriptJson<
                { x: [number, number]; y: [number, number]; z: [number, number] } | { error: string }
            >(scriptPath, ['openmc.geometry-bounds', geometryPath]);
            if (result && 'error' in result) {
                console.error('[OpenMC Backend] Geometry bounds error:', result.error);
                return null;
            }
            return result as { x: [number, number]; y: [number, number]; z: [number, number] };
        } catch (error) {
            console.error('[OpenMC Backend] Failed to get geometry bounds:', error);
            return null;
        }
    }

    // === Geometry Overlap Checker ===

    async checkOverlaps(request: any): Promise<any> {
        return this.geometryService.checkOverlaps(request);
    }

    async getOverlapVisualization(geometryPath: string, overlaps: any[]): Promise<any> {
        return this.geometryService.getOverlapVisualization(geometryPath, overlaps);
    }

    // === Output File Viewers (tracks / collision track / weight windows) ===

    async getTracksInfo(filePath: string): Promise<OpenMCTracksInfo> {
        return this.outputService.getTracksInfo(filePath);
    }

    async getTracksData(filePath: string, options?: OpenMCTracksDataOptions): Promise<OpenMCTracksData> {
        return this.outputService.getTracksData(filePath, options);
    }

    async convertTracksToVtk(filePath: string, options?: OpenMCTracksVtkOptions): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertTracksToVtk(filePath, options);
    }

    async getCollisionTrackInfo(filePath: string): Promise<OpenMCCollisionTrackInfo> {
        return this.outputService.getCollisionTrackInfo(filePath);
    }

    async getCollisionTrackData(filePath: string, query?: OpenMCCollisionTrackQuery): Promise<OpenMCCollisionTrackData> {
        return this.outputService.getCollisionTrackData(filePath, query);
    }

    async convertCollisionTrackToVtk(filePath: string, options?: OpenMCCollisionVtkOptions): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertCollisionTrackToVtk(filePath, options);
    }

    async getWeightWindows(filePath: string): Promise<OpenMCWeightWindowsData> {
        return this.outputService.getWeightWindows(filePath);
    }

    async convertWeightWindowsToVtk(filePath: string, meshId?: number): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertWeightWindowsToVtk(filePath, meshId);
    }

    async getKineticsParameters(statepointPath: string): Promise<OpenMCKineticsResult> {
        return this.outputService.getKineticsParameters(statepointPath);
    }

    async convertVoxelToVtk(filePath: string): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertVoxelToVtk(filePath);
    }

    async getVtkInfo(filePath: string): Promise<OpenMCVtkFileInfo> {
        return this.outputService.getVtkInfo(filePath);
    }

    async getParticleRestart(filePath: string): Promise<OpenMCParticleRestart> {
        return this.outputService.getParticleRestart(filePath);
    }

    async getNuclearDataLibrary(request: NuclearDataLibraryRequest): Promise<NuclearDataLibraryResult> {
        return this.outputService.getNuclearDataLibrary(request);
    }

    async getNuclideDetail(request: NuclideDetailRequest): Promise<NuclideDetailResult> {
        return this.outputService.getNuclideDetail(request);
    }

    async getNCrystalMaterials(request: NCrystalMaterialsRequest): Promise<NCrystalMaterialsResult> {
        return this.outputService.getNCrystalMaterials(request);
    }

    async getNCrystalInfo(request: NCrystalInfoRequest): Promise<NCrystalInfoResult> {
        return this.outputService.getNCrystalInfo(request);
    }

    async getNCrystalXS(request: NCrystalXSRequest): Promise<NCrystalXSResult> {
        return this.outputService.getNCrystalXS(request);
    }

    async getEndfEvaluations(request: EndfEvaluationsRequest): Promise<EndfEvaluationsResult> {
        return this.outputService.getEndfEvaluations(request);
    }

    async getEndfDetail(request: EndfDetailRequest): Promise<EndfDetailResult> {
        return this.outputService.getEndfDetail(request);
    }

    async convertTallyMeshToVtk(statepointPath: string, options?: OpenMCTallyMeshVtkOptions): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertTallyMeshToVtk(statepointPath, options);
    }

    async convertSourceToVtk(filePath: string, options?: OpenMCSourceVtkOptions): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertSourceToVtk(filePath, options);
    }

    async convertOverlayToVtk(statepointPath: string, options?: OpenMCOverlayVtkOptions): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertOverlayToVtk(statepointPath, options);
    }

    async convertOverlayGeometryToVtk(
        statepointPath: string,
        h5mPath: string,
        options?: OpenMCOverlayGeometryVtkOptions
    ): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertOverlayGeometryToVtk(statepointPath, h5mPath, options);
    }

    async getTallyLineProbe(statepointPath: string, options: OpenMCTallyLineProbeOptions): Promise<OpenMCTallyLineProbeResult> {
        return this.outputService.getTallyLineProbe(statepointPath, options);
    }

    async convertTallyContourToVtk(statepointPath: string, options: OpenMCTallyContourOptions): Promise<OpenMCVtkConversionResult> {
        return this.outputService.convertTallyContourToVtk(statepointPath, options);
    }
}
