// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { injectable, inject } from '@theia/core/shared/inversify';
import { RawProcessFactory, RawProcess, RawProcessOptions } from '@theia/process/lib/node/raw-process';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { spawnSync } from 'child_process';
import {
    OpenMCBackendService,
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    OpenMCVisualizationResult,
    XSGroupStructuresResponse,
    PythonConfig,
    VisualizerClient
} from '../../../common/visualizer-protocol';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import { PythonCommandHelper } from '../../services/python-command-helper';
import { OpenMCStatepointService, OpenMCGeometryService, OpenMCXSService, OpenMCDepletionService } from './services';

interface OpenMCProcess {
    process: RawProcess;
    port: number;
    filePath: string;
}

@injectable()
export class OpenMCBackendServiceImpl implements OpenMCBackendService {
    private processes: Map<number, OpenMCProcess> = new Map();
    private reservedPorts: Set<number> = new Set();
    private pythonConfig: PythonConfig = {};
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

    async setPythonConfig(config: PythonConfig): Promise<void> {
        this.pythonConfig = config;
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
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.findOpenMCScript();

            const args: string[] = [
                scriptPath,
                'visualize-mesh',
                statepointPath,
                tallyId.toString(),
                '--port', port.toString()
            ];

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
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.findOpenMCScript();

            const args: string[] = [
                scriptPath,
                'visualize-source',
                sourcePath,
                '--port', port.toString()
            ];

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
        filterGraveyard: boolean = true
    ): Promise<OpenMCVisualizationResult> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.findOpenMCScript();

            const args: string[] = [
                scriptPath,
                'visualize-overlay',
                geometryPath,
                statepointPath,
                tallyId.toString(),
                '--port', port.toString()
            ];

            if (score) {
                args.push('--score', score);
            }

            if (!filterGraveyard) {
                args.push('--no-graveyard-filter');
            }

            // Create a custom process to capture stdout for warnings
            const processOptions: RawProcessOptions = {
                command: pythonCommand,
                args,
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

    async getEnergySpectrum(
        statepointPath: string,
        tallyId: number,
        scoreIndex: number = 0,
        nuclideIndex: number = 0
    ): Promise<any> {
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'heatmap-all', statepointPath, tallyId.toString(),
            plane,
            '--score-index', scoreIndex.toString(),
            '--nuclide-index', nuclideIndex.toString()
        ];

        console.log(`[OpenMC] Running heatmap-all command: ${pythonCommand} ${args.join(' ')}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            maxBuffer: 100 * 1024 * 1024  // 100MB for all slices
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Heatmap-all command failed with status ${result.status}`);
            console.error(`[OpenMC] stderr: ${result.stderr}`);
            throw new Error(result.stderr || `Command failed with status ${result.status}`);
        }

        try {
            console.log(`[OpenMC] Heatmap-all output length: ${result.stdout?.length || 0} characters`);
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse heatmap-all JSON: ${e}`);
            console.error(`[OpenMC] Raw output (first 500 chars): ${result.stdout?.substring(0, 500)}`);
            throw e;
        }
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
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const warning = pythonInfo.warning;
            
            // Check for h5py using nuke-core
            const h5pyCheck = await this.nukeCoreService.checkDependencies(
                [{ name: 'h5py' }],
                pythonCommand
            );
            
            if (!h5pyCheck.available) {
                return {
                    available: false,
                    message: `h5py not installed in ${pythonCommand}. Run: pip install h5py`,
                    warning
                };
            }

            // Check for OpenMC script
            const scriptPath = this.findOpenMCScript();
            
            if (!fs.existsSync(scriptPath)) {
                return {
                    available: false,
                    message: `OpenMC integration script not found at ${scriptPath}`,
                    warning
                };
            }

            return {
                available: true,
                message: 'OpenMC integration available',
                warning
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
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const warning = pythonInfo.warning;
            
            // Check for openmc module using nuke-core
            const openmcCheck = await this.nukeCoreService.checkDependencies(
                [{ name: 'openmc' }],
                pythonCommand
            );
            
            if (!openmcCheck.available) {
                return {
                    available: false,
                    message: `OpenMC Python module not installed in ${pythonCommand}. Run: pip install openmc`,
                    warning
                };
            }

            return {
                available: true,
                message: 'OpenMC Python module available',
                warning
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

    async getDepletionData(
        filePath: string,
        materialIndex: number,
        nuclides?: string[],
        includeActivity?: boolean
    ): Promise<any> {
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
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.findOpenMCScript();

            const args: string[] = [
                scriptPath,
                'visualize-geometry',
                filePath,
                '--port', port.toString()
            ];

            if (highlightCellIds && highlightCellIds.length > 0) {
                args.push('--highlight', highlightCellIds.join(','));
            }

            if (overlaps && overlaps.length > 0) {
                // Limit overlaps for performance
                const MAX_OVERLAPS = 1000;
                const limitedOverlaps = overlaps.length > MAX_OVERLAPS 
                    ? overlaps.slice(0, MAX_OVERLAPS) 
                    : overlaps;
                if (overlaps.length > MAX_OVERLAPS) {
                    console.log(`[OpenMC] Limiting overlaps from ${overlaps.length} to ${MAX_OVERLAPS} for performance`);
                }
                
                const tempDir = os.tmpdir();
                overlapsPath = path.join(tempDir, `overlaps_${Date.now()}.json`);
                const overlapData = {
                    geometryPath: filePath,
                    overlaps: limitedOverlaps.map(o => ({
                        coordinates: o.coordinates,
                        cellIds: o.cellIds
                    }))
                };
                fs.writeFileSync(overlapsPath, JSON.stringify(overlapData));
                args.push('--overlaps', overlapsPath);
            }

            const process = this.startPythonProcess(pythonCommand, args, port);

            // Wait for server to be ready (longer timeout when overlaps present)
            const serverTimeout = (overlaps && overlaps.length > 0) ? 60000 : 30000;
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'mix-materials', request.filePath,
            '--material-ids', request.materialIds.join(','),
            '--fractions', request.fractions.join(','),
            '--percent-type', request.percentType
        ];

        if (request.name) {
            args.push('--name', request.name);
        }

        if (request.id !== undefined) {
            args.push('--id', request.id.toString());
        }

        console.log(`[OpenMC] Running mix-materials command`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000
        });

        // Try to parse stdout even if status is not 0, as our script catches exceptions
        // and prints them as JSON to stdout.
        if (result.stdout) {
            try {
                const data = JSON.parse(result.stdout);
                if (data.error) {
                    console.error(`[OpenMC] Mix materials failed (JSON error): ${data.error}`);
                    if (data.traceback) {
                        console.error(`[OpenMC] Traceback: ${data.traceback}`);
                    }
                    return { error: data.error };
                }
                if (result.status === 0) {
                    return { material: data };
                }
            } catch (e) {
                // Not JSON or other parse error, continue to stderr check
            }
        }

        if (result.status !== 0) {
            console.error(`[OpenMC] Mix materials command failed with status ${result.status}`);
            console.error(`[OpenMC] Stderr: ${result.stderr}`);
            return { error: result.stderr || `Command failed with status ${result.status}` };
        }

        return { error: 'Unknown error occurred during material mixing' };
    }

    async addMaterial(filePath: string, materialXml: string): Promise<void> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'add-material', filePath,
            '--material-xml', materialXml
        ];

        console.log(`[OpenMC] Running add-material command`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000
        });

        if (result.stdout) {
            try {
                const data = JSON.parse(result.stdout);
                if (data.error) {
                    console.error(`[OpenMC] Add material failed (JSON error): ${data.error}`);
                    throw new Error(data.error);
                }
                if (result.status === 0) {
                    return;
                }
            } catch (e) {
                if (e instanceof Error && e.message !== 'Unexpected end of JSON input') {
                    throw e;
                }
            }
        }

        if (result.status !== 0) {
            console.error(`[OpenMC] Add material command failed with status ${result.status}`);
            console.error(`[OpenMC] Stderr: ${result.stderr}`);
            throw new Error(result.stderr || `Command failed with status ${result.status}`);
        }
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
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const scriptPath = this.findOpenMCScript();

            const args: string[] = [
                scriptPath,
                'visualize-statepoint-source',
                statepointPath,
                '--port', port.toString()
            ];

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

    // === Geometry Overlap Checker ===

    async checkOverlaps(request: any): Promise<any> {
        return this.geometryService.checkOverlaps(request);
    }

    async getOverlapVisualization(geometryPath: string, overlaps: any[]): Promise<any> {
        return this.geometryService.getOverlapVisualization(geometryPath, overlaps);
    }

    private async getTallyInfo(statepointPath: string, tallyId: number): Promise<OpenMCTallyInfo> {
        const tallies = await this.listTallies(statepointPath);
        const tally = tallies.find(t => t.id === tallyId);
        if (!tally) {
            throw new Error(`Tally ${tallyId} not found`);
        }
        return tally;
    }

    private startPythonProcess(command: string, args: string[], port: number): RawProcess {
        const processOptions: RawProcessOptions = {
            command,
            args,
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

    private async waitForServer(port: number, process: RawProcess, timeoutMs: number = 30000, stderrOutput?: { data: string }): Promise<void> {
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
                    const lines = stderrOutput.data.split('\n').filter(l => l.trim());
                    const errorLine = lines.find(l => l.includes('Error:') || l.includes('Traceback'));
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

    private async detectPythonCommand(): Promise<{ command: string; warning?: string }> {
        // Sync config with nuke-core
        if (this.pythonConfig.pythonPath || this.pythonConfig.condaEnv) {
            await this.nukeCoreService.setConfig({
                pythonPath: this.pythonConfig.pythonPath,
                condaEnv: this.pythonConfig.condaEnv
            });
        }
        
        // Use nuke-core to detect Python with OpenMC-specific requirements
        const detectionResult = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: [
                { name: 'h5py' },
                { name: 'openmc' }
            ],
            autoDetectEnvs: ['openmc', 'nuke-ide']
        });
        
        if (!detectionResult.success || !detectionResult.command) {
            throw new Error(detectionResult.error || 'Failed to detect environment with h5py and openmc. Configure in Settings → Nuke Utils.');
        }
        
        return {
            command: detectionResult.command,
            warning: detectionResult.warning
        };
    }

    private getExtensionPath(): string {
        try {
            return path.dirname(require.resolve('nuke-visualizer/package.json'));
        } catch (e) {
            // Fallback to __dirname if require.resolve fails
            return path.resolve(__dirname, '../..');
        }
    }

    private findOpenMCScript(): string {
        const extensionPath = this.getExtensionPath();
        const scriptPath = path.resolve(extensionPath, 'python/openmc_server.py');
        
        if (fs.existsSync(scriptPath)) {
            return scriptPath;
        }

        // Fallback search in common locations
        const fallbackPaths = [
            path.resolve(__dirname, '../../../../extensions/nuke-visualizer/python/openmc_server.py'),
            path.resolve(process.cwd(), 'extensions/nuke-visualizer/python/openmc_server.py'),
        ];
        
        for (const fp of fallbackPaths) {
            if (fs.existsSync(fp)) {
                return fp;
            }
        }

        return scriptPath;
    }
}
