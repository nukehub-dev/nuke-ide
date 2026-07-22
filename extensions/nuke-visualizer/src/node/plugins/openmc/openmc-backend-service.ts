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
import { RawProcessFactory, RawProcess, RawProcessOptions } from '@theia/process/lib/node/raw-process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';

import {
    OpenMCBackendService,
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    OpenMCVisualizationResult,
    XSGroupStructuresResponse,
    PythonConfig,
    VisualizerClient,
    OPENMC_REQUIREMENTS
} from '../../../common/openmc-protocol';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import { PythonCommandHelper } from '../../services/python-command-helper';
import { OpenMCStatepointService, OpenMCGeometryService, OpenMCXSService, OpenMCDepletionService } from './services';

interface OpenMCProcess {
    process: RawProcess;
    port: number;
    filePath: string;
}

/**
 * Node.js backend implementation of the OpenMC visualization RPC service.
 *
 * Spawns Python processes running `server.py` for 3D tally/geometry
 * visualization, and delegates data queries to specialized sub-services:
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
    private client: VisualizerClient | undefined;

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

    setClient(client: VisualizerClient): void {
        this.client = client;
    }

    /**
     * Check whether a port belongs to a trame server started by this service.
     * Used by the visualizer reverse proxy to restrict forwarding to known servers.
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

    async visualizeMeshTally(
        statepointPath: string,
        tallyId: number,
        score?: string,
        nuclide?: string
    ): Promise<OpenMCVisualizationResult> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonInfo = await this.pythonHelper.detectPython();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.pythonHelper.findScript('server.py');

            const args: string[] = [scriptPath, 'openmc.visualize-mesh', statepointPath, tallyId.toString(), '--port', port.toString()];

            if (score) {
                args.push('--score', score);
            }

            if (nuclide) {
                args.push('--nuclide', nuclide);
            }

            const process = this.startPythonProcess(pythonCommand, args, port);

            // Wait for server to be ready
            await this.waitForServer(port, process);

            // Get tally info
            const tallyInfo = await this.getTallyInfo(statepointPath, tallyId);

            return {
                success: true,
                port,
                url: `http://127.0.0.1:${port}`,
                tallyInfo
            };
        } catch (error) {
            this.reservedPorts.delete(port);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async visualizeSource(sourcePath: string): Promise<OpenMCVisualizationResult> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonInfo = await this.pythonHelper.detectPython();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.pythonHelper.findScript('server.py');

            const args: string[] = [scriptPath, 'openmc.visualize-source', sourcePath, '--port', port.toString()];

            const process = this.startPythonProcess(pythonCommand, args, port);

            await this.waitForServer(port, process);

            return {
                success: true,
                port,
                url: `http://127.0.0.1:${port}`
            };
        } catch (error) {
            this.reservedPorts.delete(port);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async visualizeTallyOnGeometry(
        geometryPath: string,
        statepointPath: string,
        tallyId: number,
        score?: string,
        filterGraveyard: boolean = true,
        pixelated: boolean = true
    ): Promise<OpenMCVisualizationResult> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonInfo = await this.pythonHelper.detectPython();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.pythonHelper.findScript('server.py');

            const args: string[] = [
                scriptPath,
                'openmc.visualize-overlay',
                statepointPath,
                tallyId.toString(),
                '--mode',
                'full',
                '--port',
                port.toString()
            ];

            if (geometryPath) {
                args.push('--geometry', geometryPath);
            }

            if (score) {
                args.push('--score', score);
            }

            if (filterGraveyard) {
                args.push('--filter-graveyard');
            }

            if (pixelated) {
                args.push('--pixelated');
            }

            // Create a custom process to capture stdout for warnings
            const processOptions: RawProcessOptions = {
                command: pythonCommand,
                args
            };
            const process = this.rawProcessFactory(processOptions);

            // Capture stdout to look for structured warnings and send immediately via RPC
            process.outputStream.on('data', (data: Buffer) => {
                const msg = data.toString();
                console.log(`[OpenMC ${port}] ${msg.trim()}`);

                // Check for warning in real-time and send to client immediately
                const lines = msg.split('\n');
                for (const line of lines) {
                    if (line.startsWith('NUKE_IDE_WARNING:')) {
                        try {
                            const jsonStr = line.substring('NUKE_IDE_WARNING:'.length);
                            const parsed = JSON.parse(jsonStr);
                            if (parsed.type === 'spatial_warning' && parsed.message) {
                                console.log(`[OpenMC Backend] Sending spatial warning to client via RPC`);
                                this.client?.warn(parsed.message);
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            });

            process.errorStream.on('data', (data: Buffer) => {
                console.error(`[OpenMC ${port}] ERROR: ${data.toString().trim()}`);
            });

            process.onExit((event: { code?: number; signal?: string }) => {
                console.log(`[OpenMC ${port}] Process exited (code: ${event.code}, signal: ${event.signal})`);
                this.processes.delete(port);
                this.reservedPorts.delete(port);
            });

            this.processes.set(port, { process, port, filePath: geometryPath });

            // Use longer timeout for large DAGMC files (120 seconds)
            await this.waitForServer(port, process, 120000);

            const tallyInfo = await this.getTallyInfo(statepointPath, tallyId);

            return {
                success: true,
                port,
                url: `http://127.0.0.1:${port}`,
                tallyInfo
            };
        } catch (error) {
            this.reservedPorts.delete(port);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async visualizeTallySlice(
        geometryPath: string,
        statepointPath: string,
        tallyId: number,
        options: any,
        score?: string,
        nuclide?: string
    ): Promise<OpenMCVisualizationResult> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonInfo = await this.pythonHelper.detectPython();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.pythonHelper.findScript('server.py');

            const args: string[] = [
                scriptPath,
                'openmc.visualize-overlay',
                statepointPath,
                tallyId.toString(),
                '--mode',
                'slice',
                '--plane',
                options.plane || 'z',
                '--port',
                port.toString()
            ];

            if (geometryPath) {
                args.push('--geometry', geometryPath);
            }

            if (score) {
                args.push('--score', score);
            }

            if (nuclide) {
                args.push('--nuclide', nuclide);
            }

            if (options.position !== undefined) {
                args.push('--position', options.position.toString());
            }

            if (options.resolution) {
                args.push('--resolution', options.resolution.toString());
            }

            if (options.pixelated) {
                args.push('--pixelated');
            }

            if (options.showGeometry !== false) {
                args.push('--show-geometry');
            }

            if (options.filterGraveyard) {
                args.push('--filter-graveyard');
            }

            const processOptions: RawProcessOptions = {
                command: pythonCommand,
                args
            };
            const process = this.rawProcessFactory(processOptions);

            process.outputStream.on('data', (data: Buffer) => {
                const msg = data.toString();
                console.log(`[OpenMC ${port}] ${msg.trim()}`);
            });

            process.errorStream.on('data', (data: Buffer) => {
                console.error(`[OpenMC ${port}] ERROR: ${data.toString().trim()}`);
            });

            process.onExit((event: { code?: number; signal?: string }) => {
                console.log(`[OpenMC ${port}] Process exited (code: ${event.code}, signal: ${event.signal})`);
                this.processes.delete(port);
                this.reservedPorts.delete(port);
            });

            this.processes.set(port, { process, port, filePath: statepointPath });

            await this.waitForServer(port, process, 120000);

            const tallyInfo = await this.getTallyInfo(statepointPath, tallyId);

            return {
                success: true,
                port,
                url: `http://127.0.0.1:${port}`,
                tallyInfo
            };
        } catch (error) {
            this.reservedPorts.delete(port);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async visualizeTallyAndSourceOnGeometry(
        geometryPath: string,
        statepointPath: string,
        tallyId: number,
        score?: string,
        filterGraveyard: boolean = true
    ): Promise<OpenMCVisualizationResult> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonInfo = await this.pythonHelper.detectPython();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.pythonHelper.findScript('server.py');

            const args: string[] = [
                scriptPath,
                'openmc.visualize-overlay',
                statepointPath,
                tallyId.toString(),
                '--geometry',
                geometryPath,
                '--mode',
                'full',
                '--with-source',
                '--port',
                port.toString()
            ];

            if (score) {
                args.push('--score', score);
            }

            if (filterGraveyard) {
                args.push('--filter-graveyard');
            }

            const processOptions: RawProcessOptions = {
                command: pythonCommand,
                args
            };
            const process = this.rawProcessFactory(processOptions);

            process.outputStream.on('data', (data: Buffer) => {
                const msg = data.toString();
                console.log(`[OpenMC ${port}] ${msg.trim()}`);
                const lines = msg.split('\n');
                for (const line of lines) {
                    if (line.startsWith('NUKE_IDE_WARNING:')) {
                        try {
                            const jsonStr = line.substring('NUKE_IDE_WARNING:'.length);
                            const parsed = JSON.parse(jsonStr);
                            if (parsed.type === 'spatial_warning' && parsed.message) {
                                console.log(`[OpenMC Backend] Sending spatial warning to client via RPC`);
                                this.client?.warn(parsed.message);
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            });

            process.errorStream.on('data', (data: Buffer) => {
                console.error(`[OpenMC ${port}] ERROR: ${data.toString().trim()}`);
            });

            process.onExit((event: { code?: number; signal?: string }) => {
                console.log(`[OpenMC ${port}] Process exited (code: ${event.code}, signal: ${event.signal})`);
                this.processes.delete(port);
                this.reservedPorts.delete(port);
            });

            this.processes.set(port, { process, port, filePath: geometryPath });

            await this.waitForServer(port, process, 120000);

            const tallyInfo = await this.getTallyInfo(statepointPath, tallyId);

            return {
                success: true,
                port,
                url: `http://127.0.0.1:${port}`,
                tallyInfo
            };
        } catch (error) {
            this.reservedPorts.delete(port);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
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
                    message: `Missing packages: ${check.missing.join(', ')}. Run: pip install ${check.missing.join(' ')}`,
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
                    message: `OpenMC Python module not installed. Run: pip install openmc`,
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

    async visualizeGeometry(
        filePath: string,
        highlightCellIds?: number[],
        overlaps?: any[]
    ): Promise<{ success: boolean; port?: number; url?: string; error?: string }> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        let overlapsPath: string | undefined;
        try {
            const pythonInfo = await this.pythonHelper.detectPython();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.pythonHelper.findScript('server.py');

            const args: string[] = [scriptPath, 'openmc.visualize-geometry', filePath, '--port', port.toString()];

            if (highlightCellIds && highlightCellIds.length > 0) {
                args.push('--highlight', highlightCellIds.join(','));
            }

            if (overlaps && overlaps.length > 0) {
                // Limit overlaps for performance
                const MAX_OVERLAPS = 1000;
                const limitedOverlaps = overlaps.length > MAX_OVERLAPS ? overlaps.slice(0, MAX_OVERLAPS) : overlaps;
                if (overlaps.length > MAX_OVERLAPS) {
                    console.log(`[OpenMC] Limiting overlaps from ${overlaps.length} to ${MAX_OVERLAPS} for performance`);
                }

                const tempDir = os.tmpdir();
                overlapsPath = path.join(tempDir, `overlaps_${Date.now()}.json`);
                const overlapData = {
                    geometryPath: filePath,
                    overlaps: limitedOverlaps.map((o) => ({
                        coordinates: o.coordinates,
                        cellIds: o.cellIds
                    }))
                };
                fs.writeFileSync(overlapsPath, JSON.stringify(overlapData));
                args.push('--overlaps', overlapsPath);
            }

            const process = this.startPythonProcess(pythonCommand, args, port);

            // Wait for server to be ready (longer timeout when overlaps present)
            const serverTimeout = overlaps && overlaps.length > 0 ? 60000 : 30000;
            await this.waitForServer(port, process, serverTimeout);

            return {
                success: true,
                port,
                url: `http://127.0.0.1:${port}`
            };
        } catch (error) {
            this.reservedPorts.delete(port);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            // Cleanup temp file
            if (overlapsPath && fs.existsSync(overlapsPath)) {
                try {
                    fs.unlinkSync(overlapsPath);
                } catch (e) {
                    // Ignore cleanup errors
                }
            }
        }
    }

    // === Material Explorer ===

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

    async getKGenerationData(statepointPath: string): Promise<any> {
        return this.statepointService.getKGenerationData(statepointPath);
    }

    async getSourceData(statepointPath: string, maxParticles?: number): Promise<any> {
        return this.statepointService.getSourceData(statepointPath, maxParticles);
    }

    async getEnergyDistribution(statepointPath: string, nBins?: number): Promise<any> {
        return this.statepointService.getEnergyDistribution(statepointPath, nBins);
    }

    async visualizeStatepointSource(statepointPath: string): Promise<any> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonInfo = await this.pythonHelper.detectPython();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.pythonHelper.findScript('server.py');

            const args: string[] = [scriptPath, 'openmc.visualize-statepoint-source', statepointPath, '--port', port.toString()];

            const process = this.startPythonProcess(pythonCommand, args, port);

            await this.waitForServer(port, process);

            return {
                success: true,
                port,
                url: `http://127.0.0.1:${port}`
            };
        } catch (error) {
            this.reservedPorts.delete(port);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
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

    private async getTallyInfo(statepointPath: string, tallyId: number): Promise<OpenMCTallyInfo> {
        const tallies = await this.listTallies(statepointPath);
        const tally = tallies.find((t) => t.id === tallyId);
        if (!tally) {
            throw new Error(`Tally ${tallyId} not found`);
        }
        return tally;
    }

    private startPythonProcess(command: string, args: string[], port: number): RawProcess {
        const processOptions: RawProcessOptions = {
            command,
            args
        };

        const process = this.rawProcessFactory(processOptions);

        process.outputStream.on('data', (data: Buffer) => {
            console.log(`[OpenMC ${port}] ${data.toString().trim()}`);
        });

        process.errorStream.on('data', (data: Buffer) => {
            const message = data.toString().trim();
            console.error(`[OpenMC ${port}] ERROR: ${message}`);
        });

        process.onExit((event: { code?: number; signal?: string }) => {
            console.log(`[OpenMC ${port}] Process exited (code: ${event.code}, signal: ${event.signal})`);
            this.processes.delete(port);
            this.reservedPorts.delete(port);
        });

        this.processes.set(port, { process, port, filePath: args[2] || '' });

        return process;
    }

    private async waitForServer(
        port: number,
        process: RawProcess,
        timeoutMs: number = 30000,
        stderrOutput?: { data: string }
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Server startup timeout on port ${port}`));
            }, timeoutMs);

            const portCheckInterval = setInterval(() => {
                const socket = new net.Socket();
                socket.on('error', () => socket.destroy());
                socket.on('connect', () => {
                    socket.destroy();
                    cleanup();
                    resolve();
                });
                socket.connect(port, '127.0.0.1');
            }, 1000);

            const exitListener = (event: { code?: number; signal?: string }) => {
                cleanup();
                let errorMsg = `Process exited with code ${event.code} before server started`;
                // Include stderr output if available
                if (stderrOutput?.data) {
                    // Extract the last error line from stderr
                    const lines = stderrOutput.data.split('\n').filter((l) => l.trim());
                    const errorLine = lines.find((l) => l.includes('Error:') || l.includes('Traceback'));
                    if (errorLine) {
                        errorMsg += `: ${errorLine}`;
                    }
                }
                reject(new Error(errorMsg));
            };
            const exitDisposable = process.onExit(exitListener);

            const cleanup = () => {
                clearTimeout(timeout);
                clearInterval(portCheckInterval);
                exitDisposable.dispose();
            };
        });
    }

    private async findFreePort(startPort: number): Promise<number> {
        for (let port = startPort; port < startPort + 1000; port++) {
            if (this.reservedPorts.has(port)) {
                continue;
            }
            try {
                await new Promise<void>((resolve, reject) => {
                    const server = net.createServer();
                    server.once('error', (err: any) => {
                        if (err.code === 'EADDRINUSE') {
                            reject();
                        } else {
                            reject(err);
                        }
                    });
                    server.once('listening', () => {
                        server.close(() => resolve());
                    });
                    server.listen(port);
                });
                return port;
            } catch {
                continue;
            }
        }
        throw new Error(`No free port found in range ${startPort}-${startPort + 1000}`);
    }
}
