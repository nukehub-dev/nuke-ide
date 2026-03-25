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
import { execSync, spawnSync } from 'child_process';
import {
    OpenMCBackendService,
    OpenMCStatepointInfo,
    OpenMCTallyInfo,
    OpenMCVisualizationResult,
    OpenMCFilter,
    XSGroupStructuresResponse,
    PythonConfig,
    VisualizerClient
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
    private pythonConfig: PythonConfig = {};
    private client: VisualizerClient | undefined;

    @inject(RawProcessFactory)
    protected readonly rawProcessFactory: RawProcessFactory;

    setClient(client: VisualizerClient): void {
        this.client = client;
    }

    async setPythonConfig(config: PythonConfig): Promise<void> {
        this.pythonConfig = config;
        console.log(`[OpenMC] Python config updated: ${JSON.stringify(config)}`);
    }

    async loadStatepoint(statepointPath: string): Promise<OpenMCStatepointInfo> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'spatial', statepointPath, tallyId.toString(), 
            axis,
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

    async getHeatmapSlice(
        statepointPath: string,
        tallyId: number,
        plane: 'xy' | 'xz' | 'yz',
        sliceIndex: number,
        scoreIndex: number = 0,
        nuclideIndex: number = 0
    ): Promise<any> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'heatmap', statepointPath, tallyId.toString(),
            plane,
            sliceIndex.toString(),
            '--score-index', scoreIndex.toString(),
            '--nuclide-index', nuclideIndex.toString()
        ];

        console.log(`[OpenMC] Running heatmap command: ${pythonCommand} ${args.join(' ')}`);

        // Increased maxBuffer to 50MB for large mesh data
        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Heatmap command failed with status ${result.status}`);
            console.error(`[OpenMC] stderr: ${result.stderr}`);
            throw new Error(result.stderr || `Command failed with status ${result.status}`);
        }

        try {
            console.log(`[OpenMC] Heatmap output length: ${result.stdout?.length || 0} characters`);
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse heatmap JSON: ${e}`);
            console.error(`[OpenMC] Raw output (first 500 chars): ${result.stdout?.substring(0, 500)}`);
            throw e;
        }
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
            
            // Check for h5py
            try {
                execSync(`"${pythonCommand}" -c "import h5py"`, { stdio: 'ignore' });
            } catch {
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
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

        // Add integral quantities calculation flag
        if (request.includeIntegrals) {
            args.push('--include-integrals');
        }

        // Add derivative calculation flag
        if (request.includeDerivative) {
            args.push('--include-derivative');
        }

        // Add group structure for multigroup XS
        if (request.groupStructure && request.groupStructure !== 'continuous') {
            args.push('--group-structure', request.groupStructure);
        }

        // Add thermal scattering mode
        if (request.thermalScattering) {
            args.push('--thermal-scattering', JSON.stringify(request.thermalScattering));
        }

        console.log(`[OpenMC] Running XS plot command: ${pythonCommand} ${args.join(' ')}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            maxBuffer: 50 * 1024 * 1024,  // 50MB buffer for large derivative datasets
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

    async checkOpenMCPythonAvailable(): Promise<{ available: boolean; message: string; warning?: string }> {
        try {
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const warning = pythonInfo.warning;
            
            // Check for openmc module
            try {
                execSync(`"${pythonCommand}" -c "import openmc"`, { stdio: 'ignore' });
            } catch {
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
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

    async getAvailableThermalMaterials(crossSectionsPath?: string): Promise<string[]> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'list-thermal-materials'];
        if (crossSectionsPath) {
            args.push('--cross-sections', crossSectionsPath);
        }

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] List thermal materials command failed: ${result.stderr}`);
            return [];
        }

        try {
            const data = JSON.parse(result.stdout);
            return data.materials || [];
        } catch (e) {
            console.error(`[OpenMC] Failed to parse thermal materials list: ${e}`);
            return [];
        }
    }

    async getGroupStructures(): Promise<XSGroupStructuresResponse> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'list-group-structures'];

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 10000
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] List group structures command failed: ${result.stderr}`);
            return { structures: [], metadata: { openmc_available: false, sources: [] } };
        }

        try {
            const data = JSON.parse(result.stdout);
            return {
                structures: data.structures || [],
                metadata: data.metadata || { openmc_available: false, sources: [] }
            };
        } catch (e) {
            console.error(`[OpenMC] Failed to parse group structures list: ${e}`);
            return { structures: [], metadata: { openmc_available: false, sources: [] } };
        }
    }

    // === Depletion/Burnup Methods ===

    async getDepletionSummary(filePath: string): Promise<any> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'depletion-summary', filePath];

        console.log(`[OpenMC] Running depletion-summary command for ${filePath}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Depletion summary command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to load depletion summary');
        }

        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse depletion summary: ${e}`);
            throw e;
        }
    }

    async getDepletionMaterials(filePath: string): Promise<any[]> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'depletion-materials', filePath];

        console.log(`[OpenMC] Running depletion-materials command for ${filePath}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Depletion materials command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to load depletion materials');
        }

        try {
            const data = JSON.parse(result.stdout);
            return data.materials || [];
        } catch (e) {
            console.error(`[OpenMC] Failed to parse depletion materials: ${e}`);
            throw e;
        }
    }

    async getDepletionData(
        filePath: string,
        materialIndex: number,
        nuclides?: string[],
        includeActivity?: boolean
    ): Promise<any> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [
            scriptPath, 'depletion-data', filePath, materialIndex.toString()
        ];

        if (nuclides && nuclides.length > 0) {
            args.push('--nuclides', nuclides.join(','));
        }

        console.log(`[OpenMC] Running depletion-data command for material ${materialIndex}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 60000,
            maxBuffer: 50 * 1024 * 1024  // 50MB for large depletion files
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Depletion data command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to load depletion data');
        }

        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse depletion data: ${e}`);
            throw e;
        }
    }

    // === Geometry Hierarchy Viewer ===

    async getGeometryHierarchy(filePath: string): Promise<any> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'geometry', filePath];

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024  // 10MB for large geometry files
        });

        // Check if stdout is empty
        if (!result.stdout || result.stdout.trim() === '') {
            throw new Error('Geometry parser returned empty output. The file may not be a valid OpenMC geometry file.');
        }

        // Try to parse the output as JSON (even if status is non-zero, error info is in JSON)
        try {
            const parsed = JSON.parse(result.stdout);
            // If there's an error in the JSON, return it (don't throw)
            if (parsed.error) {
                return parsed;  // Return the error object so frontend can handle it
            }
            return parsed;
        } catch (e) {
            throw new Error('Failed to parse geometry data. The file may be corrupted or not a valid geometry file.');
        }
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'materials', filePath];

        console.log(`[OpenMC] Running materials command for ${filePath}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024  // 10MB for large materials files
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Materials command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to load materials');
        }

        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse materials data: ${e}`);
            throw e;
        }
    }
    
    /**
     * Get mapping of materials to cells that use them.
     */
    async getMaterialCellLinkage(materialsPath: string, geometryPath: string): Promise<any> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args = [scriptPath, 'material-cell-linkage', materialsPath, geometryPath];

        console.log(`[OpenMC] Running material-cell-linkage command`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Material-cell linkage command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to get material-cell linkage');
        }

        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse material-cell linkage: ${e}`);
            throw e;
        }
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

    // === Geometry Overlap Checker ===

    async checkOverlaps(request: any): Promise<any> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args: string[] = [
            scriptPath,
            'check-overlaps',
            request.geometryPath,
            '--samples', (request.samplePoints || 100000).toString(),
            '--tolerance', (request.tolerance || 1e-6).toString()
        ];

        if (request.bounds) {
            args.push('--bounds', JSON.stringify(request.bounds));
        }

        if (request.parallel) {
            args.push('--parallel');
        }

        console.log(`[OpenMC] Running overlap check on ${request.geometryPath}`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 300000,  // 5 minute timeout for large geometries
            maxBuffer: 50 * 1024 * 1024  // 50MB for large result sets
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Overlap check command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to check overlaps');
        }

        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse overlap results: ${e}`);
            throw e;
        }
    }

    async getOverlapVisualization(geometryPath: string, overlaps: any[]): Promise<any> {
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        const scriptPath = this.findOpenMCScript();

        const args: string[] = [
            scriptPath,
            'overlap-viz',
            geometryPath,
            '--overlaps', JSON.stringify(overlaps),
            '--marker-size', '1.0'
        ];

        console.log(`[OpenMC] Getting overlap visualization data`);

        const result = spawnSync(pythonCommand, args, {
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
        });

        if (result.status !== 0) {
            console.error(`[OpenMC] Overlap viz command failed: ${result.stderr}`);
            throw new Error(result.stderr || 'Failed to get overlap visualization');
        }

        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            console.error(`[OpenMC] Failed to parse overlap viz data: ${e}`);
            throw e;
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
        const warnings: string[] = [];

        // 1. Check pythonConfig.pythonPath first (user preference)
        if (this.pythonConfig.pythonPath && fs.existsSync(this.pythonConfig.pythonPath)) {
            if (this.testPython(this.pythonConfig.pythonPath)) {
                return { command: this.pythonConfig.pythonPath };
            }
            const msg = `Configured Python at ${this.pythonConfig.pythonPath} is missing required dependencies (h5py, openmc). Using fallback.`;
            console.warn(`[OpenMC] ${msg}`);
            warnings.push(msg);
        } else if (this.pythonConfig.pythonPath) {
            const msg = `Configured Python path does not exist: ${this.pythonConfig.pythonPath}. Using fallback.`;
            console.warn(`[OpenMC] ${msg}`);
            warnings.push(msg);
        }

        // 2. Check pythonConfig.condaEnv (user preference for conda env name)
        if (this.pythonConfig.condaEnv) {
            const condaPython = this.findCondaPython(this.pythonConfig.condaEnv);
            if (condaPython && this.testPython(condaPython)) {
                return { 
                    command: condaPython,
                    warning: warnings.length > 0 ? warnings.join(' ') : undefined
                };
            }
            const msg = `Conda environment '${this.pythonConfig.condaEnv}' not found or missing dependencies. Using fallback.`;
            console.warn(`[OpenMC] ${msg}`);
            warnings.push(msg);
        }

        // 3. Try common conda envs if not configured
        const commonCondaEnvs = ['visualizer', 'trame', 'openmc', 'nuke-ide'];
        for (const envName of commonCondaEnvs) {
            const condaPython = this.findCondaPython(envName);
            if (condaPython && this.testPython(condaPython)) {
                const warning = warnings.length > 0 ? warnings.join(' ') : undefined;
                const fallbackMsg = `Using auto-detected conda environment: ${envName}`;
                return { 
                    command: condaPython, 
                    warning: warning ? `${warning} ${fallbackMsg}` : fallbackMsg
                };
            }
        }

        // 4. Check CONDA_PREFIX env var (if shell has activated conda)
        const condaPrefix = process.env.CONDA_PREFIX;
        if (condaPrefix) {
            const condaPython = path.join(condaPrefix, 'bin', 'python');
            if (fs.existsSync(condaPython) && this.testPython(condaPython)) {
                const warning = warnings.length > 0 ? warnings.join(' ') : undefined;
                const fallbackMsg = `Using active conda environment: ${path.basename(condaPrefix)}`;
                return { 
                    command: condaPython,
                    warning: warning ? `${warning} ${fallbackMsg}` : fallbackMsg
                };
            }
        }

        // 5. Try system commands
        const candidates = ['pvpython', 'python3', 'python'];
        for (const cmd of candidates) {
            try {
                // Use which to get absolute path
                const cmdPath = execSync(`which ${cmd}`, { encoding: 'utf8' }).trim();
                if (cmdPath && this.testPython(cmdPath)) {
                    const warning = warnings.length > 0 ? warnings.join(' ') : undefined;
                    const fallbackMsg = `Using system ${cmd} from PATH: ${cmdPath}`;
                    return { 
                        command: cmdPath,
                        warning: warning ? `${warning} ${fallbackMsg}` : fallbackMsg
                    };
                }
            } catch {
                // not found
            }
        }

        // Final fallback to python3 if all detection fails
        const msg = '[OpenMC] All Python detection methods failed. Falling back to default python3.';
        console.warn(msg);
        return { 
            command: 'python3',
            warning: warnings.length > 0 ? `${warnings.join(' ')} ${msg}` : msg
        };
    }

    private findCondaPython(envName: string): string | undefined {
        const homeDir = os.homedir();
        const condaBasePaths = [
            path.join(homeDir, '.conda', 'envs'),
            path.join(homeDir, 'anaconda3', 'envs'),
            path.join(homeDir, 'miniconda3', 'envs'),
            '/opt/conda/envs',
            '/opt/miniconda3/envs',
            '/opt/anaconda3/envs',
            '/usr/local/conda/envs',
            '/usr/local/miniconda3/envs',
            '/usr/local/anaconda3/envs',
        ];

        for (const condaPath of condaBasePaths) {
            const envPython = path.join(condaPath, envName, 'bin', 'python');
            if (fs.existsSync(envPython)) {
                return envPython;
            }
        }
        return undefined;
    }

    private testPython(pythonPath: string): boolean {
        try {
            // Check for critical dependencies h5py and openmc
            execSync(`"${pythonPath}" -c "import h5py; import openmc"`, { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
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
