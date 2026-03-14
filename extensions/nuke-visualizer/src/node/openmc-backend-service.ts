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
import { execSync, spawnSync } from 'child_process';
import {
    OpenMCBackendService,
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    OpenMCVisualizationResult,
    OpenMCFilter
} from '../common/visualizer-protocol';

interface OpenMCProcess {
    process: RawProcess;
    port: number;
    filePath: string;
}

@injectable()
export class OpenMCBackendServiceImpl implements OpenMCBackendService {
    private processes: Map<number, OpenMCProcess> = new Map();
    private reservedPorts: Set<number> = new Set();

    @inject(RawProcessFactory)
    protected readonly rawProcessFactory: RawProcessFactory;

    async loadStatepoint(statepointPath: string): Promise<OpenMCStatepointInfo> {
        const pythonCommand = await this.detectPythonCommand();
        const scriptPath = this.findOpenMCScript();

        const result = spawnSync(
            pythonCommand,
            [scriptPath, 'info', statepointPath],
            { encoding: 'utf8', timeout: 30000 }
        );

        if (result.status !== 0) {
            throw new Error(result.stderr || `Failed to load statepoint: ${result.status}`);
        }

        try {
            const info = JSON.parse(result.stdout);
            return {
                file: statepointPath,
                batches: info.batches,
                generationsPerBatch: info.generations_per_batch || 1,
                kEff: info.k_eff,
                kEffStd: info.k_eff_std,
                nTallies: info.n_tallies,
                tallyIds: info.tally_ids
            };
        } catch (error) {
            throw new Error(`Failed to parse statepoint info: ${error}`);
        }
    }

    async listTallies(statepointPath: string): Promise<OpenMCTallyInfo[]> {
        const pythonCommand = await this.detectPythonCommand();
        const scriptPath = this.findOpenMCScript();

        const result = spawnSync(
            pythonCommand,
            [scriptPath, 'list', statepointPath],
            { encoding: 'utf8', timeout: 30000 }
        );

        if (result.status !== 0) {
            throw new Error(result.stderr || `Failed to list tallies: ${result.status}`);
        }

        try {
            const tallies = JSON.parse(result.stdout);
            return tallies.map((t: any) => ({
                id: t.id,
                name: t.name,
                scores: t.scores,
                nuclides: t.nuclides,
                filters: t.filters.map((f: any): OpenMCFilter => ({
                    type: f.type,
                    bins: f.bins,
                    meshDimensions: f.mesh_dimensions,
                    meshBounds: f.mesh_info ? {
                        lowerLeft: f.mesh_info.lower_left,
                        upperRight: f.mesh_info.upper_right
                    } : undefined,
                    meshType: f.mesh_type,
                    meshWidth: f.width
                })),
                hasMesh: t.has_mesh
            }));
        } catch (error) {
            throw new Error(`Failed to parse tally list: ${error}`);
        }
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
            const pythonCommand = await this.detectPythonCommand();
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
            const pythonCommand = await this.detectPythonCommand();
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
        score?: string
    ): Promise<OpenMCVisualizationResult> {
        const port = await this.findFreePort(8090);
        this.reservedPorts.add(port);

        try {
            const pythonCommand = await this.detectPythonCommand();
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

            const process = this.startPythonProcess(pythonCommand, args, port);

            await this.waitForServer(port, process);

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
        const pythonCommand = await this.detectPythonCommand();
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'spectrum', statepointPath, tallyId.toString(),
            '--score-index', scoreIndex.toString(),
            '--nuclide-index', nuclideIndex.toString()
        ];

        console.log(`[OpenMC] Running spectrum command: ${pythonCommand} ${args.join(' ')}`);

        // Increased maxBuffer to 10MB for large spectra
        const result = spawnSync(pythonCommand, args, { 
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024 
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Spectrum command failed with status ${result.status}`);
            console.error(`[OpenMC] stderr: ${result.stderr}`);
            throw new Error(result.stderr || `Command failed with status ${result.status}`);
        }

        try {
            console.log(`[OpenMC] Spectrum output length: ${result.stdout?.length || 0} characters`);
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse spectrum JSON: ${e}`);
            console.error(`[OpenMC] Raw output (first 500 chars): ${result.stdout?.substring(0, 500)}`);
            throw e;
        }
    }

    async getSpatialPlot(
        statepointPath: string,
        tallyId: number,
        axis: 'x' | 'y' | 'z',
        scoreIndex: number = 0,
        nuclideIndex: number = 0
    ): Promise<any> {
        const pythonCommand = await this.detectPythonCommand();
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'spatial', statepointPath, tallyId.toString(), 
            '--axis', axis,
            '--score-index', scoreIndex.toString(),
            '--nuclide-index', nuclideIndex.toString()
        ];

        console.log(`[OpenMC] Running spatial plot command: ${pythonCommand} ${args.join(' ')}`);

        // Increased maxBuffer to 10MB for large mesh data
        const result = spawnSync(pythonCommand, args, { 
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024 
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Spatial plot command failed with status ${result.status}`);
            console.error(`[OpenMC] stderr: ${result.stderr}`);
            throw new Error(result.stderr || `Command failed with status ${result.status}`);
        }

        try {
            console.log(`[OpenMC] Spatial output length: ${result.stdout?.length || 0} characters`);
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse spatial plot JSON: ${e}`);
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

    async checkOpenMCAvailable(): Promise<{ available: boolean; message: string }> {
        try {
            const pythonCommand = await this.detectPythonCommand();
            
            // Check for h5py
            try {
                execSync(`"${pythonCommand}" -c "import h5py"`, { stdio: 'ignore' });
            } catch {
                return {
                    available: false,
                    message: 'h5py not installed. Run: pip install h5py'
                };
            }

            // Check for OpenMC script
            const scriptPath = this.findOpenMCScript();
            
            if (!fs.existsSync(scriptPath)) {
                return {
                    available: false,
                    message: `OpenMC integration script not found at ${scriptPath}`
                };
            }

            return {
                available: true,
                message: 'OpenMC integration available'
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
        const pythonCommand = await this.detectPythonCommand();
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath,
            'xs-plot',
            '--reactions', request.reactions.join(',')
        ];

        // Add nuclides if provided
        if (request.nuclides && request.nuclides.length > 0) {
            args.push('--nuclides', request.nuclides.join(','));
        }

        // Add temperature (default 294K)
        args.push('--temperature', (request.temperature || 294).toString());

        // Add energy range or region preset
        if (request.energyRegion) {
            args.push('--energy-region', request.energyRegion);
        } else if (request.energyRange) {
            args.push('--energy-min', request.energyRange[0].toString());
            args.push('--energy-max', request.energyRange[1].toString());
        }

        // Add cross-section path
        if (request.crossSectionsPath) {
            args.push('--cross-sections', request.crossSectionsPath);
        }

        // Add temperature comparison mode
        if (request.temperatureComparison) {
            const temps = request.temperatureComparison.temperatures.join(',');
            args.push('--temp-comparison', temps);
        }

        // Add materials for mixed nuclide calculations
        if (request.materials && request.materials.length > 0) {
            args.push('--materials', JSON.stringify(request.materials));
        }

        // Add flux spectrum for reaction rate calculation
        if (request.fluxSpectrum) {
            args.push('--flux-spectrum', JSON.stringify(request.fluxSpectrum));
        }

        // Add library comparison mode
        if (request.libraryComparison) {
            args.push('--library-comparison', JSON.stringify(request.libraryComparison));
        }

        // Add uncertainty extraction flag
        if (request.includeUncertainty) {
            args.push('--include-uncertainty');
        }

        console.log(`[OpenMC] Running XS plot command: ${pythonCommand} ${args.join(' ')}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            maxBuffer: 20 * 1024 * 1024,  // Increased for larger datasets
            timeout: 120000  // Increased for complex calculations
        });

        // Log stderr for debugging (even on success)
        if (result.stderr) {
            console.log(`[OpenMC] Python stderr: ${result.stderr}`);
        }

        if (result.status !== 0) {
            console.error(`[OpenMC] XS plot command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to get XS data');
        }

        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse XS data: ${e}`);
            console.error(`[OpenMC] Raw output: ${result.stdout?.substring(0, 500)}`);
            throw e;
        }
    }

    async checkOpenMCPythonAvailable(): Promise<{ available: boolean; message: string }> {
        try {
            const pythonCommand = await this.detectPythonCommand();
            
            // Check for openmc module
            try {
                execSync(`"${pythonCommand}" -c "import openmc"`, { stdio: 'ignore' });
            } catch {
                return {
                    available: false,
                    message: 'OpenMC Python module not installed. Run: pip install openmc'
                };
            }

            return {
                available: true,
                message: 'OpenMC Python module available'
            };
        } catch (error) {
            return {
                available: false,
                message: error instanceof Error ? error.message : String(error)
            };
        }
    }

    async getAvailableNuclides(crossSectionsPath?: string): Promise<string[]> {
        const pythonCommand = await this.detectPythonCommand();
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'list-nuclides'];
        if (crossSectionsPath) {
            args.push('--cross-sections', crossSectionsPath);
        }

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] List nuclides command failed: ${result.stderr}`);
            return [];
        }

        try {
            const data = JSON.parse(result.stdout);
            return data.nuclides || [];
        } catch (e) {
            console.error(`[OpenMC] Failed to parse nuclides list: ${e}`);
            return [];
        }
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

    private async waitForServer(port: number, process: RawProcess): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Server startup timeout on port ${port}`));
            }, 30000);

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
                reject(new Error(`Process exited with code ${event.code} before server started`));
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

    private async detectPythonCommand(): Promise<string> {
        // Try to find a suitable Python with ParaView
        const candidates = [
            process.env.CONDA_PREFIX ? path.join(process.env.CONDA_PREFIX, 'bin', 'python') : null,
            'pvpython',
            'python3',
            'python',
        ].filter((c): c is string => c !== null);

        for (const cmd of candidates) {
            try {
                execSync(`"${cmd}" -c "import paraview; import h5py"`, { stdio: 'ignore' });
                return cmd;
            } catch {
                continue;
            }
        }

        // Fallback to python3
        return 'python3';
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
