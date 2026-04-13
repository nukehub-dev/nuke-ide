/*******************************************************************************
 * Copyright (C) 2024 NukeHub and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
 *******************************************************************************/

import { injectable, inject } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { ProcessManager } from '@theia/process/lib/node/process-manager';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

import {
    StartOptimizationRequest,
    StartOptimizationResult,
    StopOptimizationRequest,
    StopOptimizationResult,
    OptimizationProgressEvent,
    OptimizationIterationResult,
    OpenMCStudioClient
} from '../common/openmc-studio-protocol';
import { OpenMCParameterSweep, OpenMCState } from '../common/openmc-state-schema';
import { XMLGenerationService } from './xml-generation-service';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common/nuke-core-protocol';

interface OptimizationRunState {
    runId: string;
    process?: any;
    status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    currentIteration: number;
    totalIterations: number;
    results: OptimizationIterationResult[];
    outputDirectory: string;
    startTime?: Date;
    endTime?: Date;
}

@injectable()
export class OptimizationBackendService {
    
    @inject(ILogger)
    protected readonly logger: ILogger;
    
    @inject(ProcessManager)
    protected readonly processManager: ProcessManager;

    @inject(XMLGenerationService)
    protected readonly xmlService: XMLGenerationService;

    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    private getExtensionPath(): string {
        return path.resolve(__dirname, '../..');
    }

    private async getDepletionRunnerPath(): Promise<string> {
        const extensionPath = this.getExtensionPath();
        const scriptPath = path.resolve(extensionPath, 'python/run_depletion.py');
        
        if (fs.existsSync(scriptPath)) {
            return scriptPath;
        }
        
        const fallbackPaths = [
            path.resolve(__dirname, '../../../../extensions/openmc-studio/python/run_depletion.py'),
            path.resolve(process.cwd(), 'extensions/openmc-studio/python/run_depletion.py'),
            path.resolve(__dirname, '../../python/run_depletion.py'),
            path.resolve(__dirname, '../../../python/run_depletion.py'),
        ];
        
        for (const fp of fallbackPaths) {
            if (fs.existsSync(fp)) {
                return fp;
            }
        }
        
        return scriptPath;
    }

    private activeRuns: Map<string, OptimizationRunState> = new Map();
    private clients: Set<OpenMCStudioClient> = new Set();

    /**
     * Register a client for receiving events
     */
    registerClient(client: OpenMCStudioClient): void {
        this.clients.add(client);
    }

    /**
     * Unregister a client
     */
    unregisterClient(client: OpenMCStudioClient): void {
        this.clients.delete(client);
    }

    /**
     * Start an optimization run
     */
    async startOptimization(request: StartOptimizationRequest): Promise<StartOptimizationResult> {
        try {
            this.logger.info(`[OptimizationBackend] Starting optimization run: ${request.runId}`);

            // Calculate total iterations
            let totalIterations = 1;
            for (const sweep of request.sweeps) {
                const values = this.computeSweepValues(sweep);
                totalIterations *= values.length;
            }

            // Create run state
            const runState: OptimizationRunState = {
                runId: request.runId,
                status: 'running',
                currentIteration: 0,
                totalIterations,
                results: [],
                outputDirectory: request.outputDirectory,
                startTime: new Date()
            };

            this.activeRuns.set(request.runId, runState);

            // Create output directory (make absolute to ensure it exists from backend perspective)
            let outputDir = request.outputDirectory;
            if (!path.isAbsolute(outputDir)) {
                outputDir = path.resolve(outputDir);
            }
            runState.outputDirectory = outputDir;
            
            this.logger.info(`[OptimizationBackend] Output directory: ${outputDir}`);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Start the optimization process
            await this.executeOptimizationRun(runState, request);

            this.notifyProgress({
                runId: request.runId,
                currentIteration: 0,
                totalIterations,
                parameterValues: {},
                status: 'running',
                progressPercent: 0
            });

            return {
                success: true,
                totalIterations
            };

        } catch (error) {
            this.logger.error('[OptimizationBackend] Failed to start optimization:', error);
            return {
                success: false,
                error: String(error)
            };
        }
    }

    /**
     * Stop/cancel an optimization run
     */
    async stopOptimization(request: StopOptimizationRequest): Promise<StopOptimizationResult> {
        const runState = this.activeRuns.get(request.runId);
        
        if (!runState) {
            return {
                success: false,
                error: `Run ${request.runId} not found`
            };
        }

        if (runState.process) {
            runState.process.kill();
        }

        runState.status = 'cancelled';
        runState.endTime = new Date();

        this.notifyProgress({
            runId: request.runId,
            currentIteration: runState.currentIteration,
            totalIterations: runState.totalIterations,
            parameterValues: {},
            status: 'cancelled',
            progressPercent: (runState.currentIteration / runState.totalIterations) * 100
        });

        return { success: true };
    }

    /**
     * Get optimization run status
     */
    async getOptimizationStatus(runId: string): Promise<{
        running: boolean;
        currentIteration: number;
        totalIterations: number;
        status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    }> {
        const runState = this.activeRuns.get(runId);
        
        if (!runState) {
            return {
                running: false,
                currentIteration: 0,
                totalIterations: 0,
                status: 'failed'
            };
        }

        return {
            running: runState.status === 'running',
            currentIteration: runState.currentIteration,
            totalIterations: runState.totalIterations,
            status: runState.status
        };
    }

    /**
     * Get iteration logs index for an optimization run
     */
    async getIterationLogsIndex(runId: string): Promise<{
        iterations: { iteration: number; hasLog: boolean; timestamp: string }[];
        outputDirectory: string;
    }>;

    async getIterationLogsIndex(runId: string): Promise<{
        iterations: { iteration: number; hasLog: boolean; timestamp: string }[];
        outputDirectory: string;
    }> {
        this.logger.info(`[OptimizationBackend] getIterationLogsIndex called with runId: ${runId}, active runs: ${this.activeRuns.size}`);
        
        let runState = this.activeRuns.get(runId);
        
        if (!runState) {
            this.logger.warn(`[OptimizationBackend] Direct match not found, checking ${this.activeRuns.size} active runs`);
            // Try to reconstruct from active runs by partial match
            for (const [id, state] of this.activeRuns) {
                this.logger.info(`[OptimizationBackend] Checking run: ${id} with outputDir: ${state.outputDirectory}`);
                if (id === runId || runId.includes(id) || id.includes(runId)) {
                    runState = state;
                    break;
                }
            }
            
            if (!runState) {
                this.logger.warn(`[OptimizationBackend] getIterationLogsIndex: run ${runId} not found in ${this.activeRuns.size} active runs`);
                return {
                    iterations: [],
                    outputDirectory: ''
                };
            }
        }

        const iterations: { iteration: number; hasLog: boolean; timestamp: string }[] = [];
        const outputDir = runState.outputDirectory;
        
        this.logger.info(`[OptimizationBackend] getIterationLogsIndex: checking ${outputDir}`);

        // Check existing iteration directories
        if (fs.existsSync(outputDir)) {
            const entries = fs.readdirSync(outputDir);
            this.logger.info(`[OptimizationBackend] Found entries: ${entries.join(', ')}`);
            for (const entry of entries) {
                const match = entry.match(/^iteration_(\d+)$/);
                if (match) {
                    const iteration = parseInt(match[1]);
                    const iterDir = path.join(outputDir, entry);
                    const logPath = path.join(iterDir, 'output.log');
                    const hasLog = fs.existsSync(logPath);

                    let timestamp = '';
                    try {
                        const stats = fs.statSync(iterDir);
                        timestamp = stats.mtime.toISOString();
                    } catch {}

                    iterations.push({ iteration, hasLog, timestamp });
                }
            }
        } else {
            this.logger.warn(`[OptimizationBackend] Output directory does not exist: ${outputDir}`);
        }

        // Sort by iteration number
        iterations.sort((a, b) => a.iteration - b.iteration);

        return {
            iterations,
            outputDirectory: outputDir
        };
    }

    /**
     * Get log content for a specific iteration
     */
    async getIterationLog(runId: string, iteration: number): Promise<{
        success: boolean;
        logContent?: string;
        error?: string;
    }> {
        const runState = this.activeRuns.get(runId);
        
        if (!runState) {
            return {
                success: false,
                error: `Run ${runId} not found`
            };
        }

        const logPath = path.join(runState.outputDirectory, `iteration_${iteration}`, 'output.log');
        
        if (!fs.existsSync(logPath)) {
            return {
                success: false,
                error: `Log file not found for iteration ${iteration}`
            };
        }

        try {
            const content = fs.readFileSync(logPath, 'utf-8');
            return {
                success: true,
                logContent: content
            };
        } catch (err) {
            return {
                success: false,
                error: `Failed to read log: ${err}`
            };
        }
    }

    /**
     * Execute the optimization run
     */
    private async executeOptimizationRun(
        runState: OptimizationRunState,
        request: StartOptimizationRequest
    ): Promise<void> {
        // Generate all parameter combinations
        const combinations = this.generateParameterCombinations(request.sweeps);
        
        for (let i = 0; i < combinations.length; i++) {
            if (runState.status === 'cancelled') {
                break;
            }

            const combination = combinations[i];
            const iteration = i + 1;

            try {
                // Notify progress - include iteration number for grouping in UI
                this.notifyProgress({
                    runId: runState.runId,
                    currentIteration: iteration,
                    totalIterations: runState.totalIterations,
                    parameterValues: combination,
                    status: 'running',
                    progressPercent: (iteration / runState.totalIterations) * 100
                });

                // Notify log about iteration start
                this.notifyLog(`\n=== Iteration ${iteration}/${runState.totalIterations} ===\n`);

                // Run single iteration
                const result = await this.runSingleIteration(
                    runState,
                    request,
                    iteration,
                    combination
                );

                runState.results.push(result);
                runState.currentIteration = iteration;

                // Notify iteration complete
                this.notifyIterationComplete(runState.runId, result);

            } catch (error) {
                this.logger.error(`[OptimizationBackend] Iteration ${iteration} failed:`, error);
                
                const failedResult: OptimizationIterationResult = {
                    iteration,
                    parameterValues: combination,
                    executionTime: 0,
                    success: false,
                    errorMessage: String(error)
                };

                runState.results.push(failedResult);
                this.notifyIterationComplete(runState.runId, failedResult);
            }
        }

        runState.status = runState.status === 'cancelled' ? 'cancelled' : 'completed';
        runState.endTime = new Date();

        this.notifyProgress({
            runId: runState.runId,
            currentIteration: runState.currentIteration,
            totalIterations: runState.totalIterations,
            parameterValues: {},
            status: runState.status,
            progressPercent: 100
        });
    }

    /**
     * Run a single iteration
     */
    private async runSingleIteration(
        runState: OptimizationRunState,
        request: StartOptimizationRequest,
        iteration: number,
        parameterValues: Record<string, number>
    ): Promise<OptimizationIterationResult> {
        const startTime = Date.now();
        
        // Create iteration directory
        const iterationDir = path.join(runState.outputDirectory, `iteration_${iteration}`);
        this.logger.info(`[OptimizationBackend] Creating iteration directory: ${iterationDir}`);
        fs.mkdirSync(iterationDir, { recursive: true });

        // Write parameter configuration
        const configPath = path.join(iterationDir, 'params.json');
        fs.writeFileSync(configPath, JSON.stringify(parameterValues, null, 2));

        // Apply parameter modifications to the state
        const modifiedState = this.applyParameterSweep(request.baseState, parameterValues);

        // Generate XML files
        const xmlResult = await this.xmlService.generateXML({
            state: modifiedState,
            outputDirectory: iterationDir,
            files: {
                materials: true,
                geometry: true,
                settings: true,
                tallies: true,
                plots: false
            }
        });

        if (!xmlResult.success) {
            throw new Error(`XML generation failed: ${xmlResult.error}`);
        }

        // Create log file for this iteration
        const logFilePath = path.join(iterationDir, 'output.log');

        // Run OpenMC simulation
        this.logger.info(`[OptimizationBackend] Running iteration ${iteration}`);
        const simResult = await this.runOpenMCSimulation(
            iterationDir, 
            1,
            request.crossSectionsPath,
            request.chainFilePath,
            runState,
            logFilePath
        );

        const executionTime = (Date.now() - startTime) / 1000;

        // Try to read statepoint results
        let keff: number | undefined;
        let keffStd: number | undefined;
        
        try {
            const statepointResult = await this.readStatepointResults(iterationDir);
            keff = statepointResult.keff;
            keffStd = statepointResult.keffStd;
        } catch (err) {
            this.logger.warn(`[OptimizationBackend] Could not read statepoint for iteration ${iteration}: ${err}`);
        }

        return {
            iteration,
            parameterValues,
            keff,
            keffStd,
            executionTime,
            success: simResult.success,
            errorMessage: simResult.error,
            statepointPath: path.join(iterationDir, 'statepoint.h5')
        };
    }

/**
     * Apply parameter sweep values to state
     * Uses parameterPath from sweep config to determine what to modify
     */
    private applyParameterSweep(state: OpenMCState, parameters: Record<string, number>): OpenMCState {
        const modifiedState: OpenMCState = JSON.parse(JSON.stringify(state));

        for (const [paramPath, value] of Object.entries(parameters)) {
            this.applyParameterByPath(modifiedState, paramPath, value);
        }

        return modifiedState;
    }

    /**
     * Apply a parameter using a path like "materialName.nuclideName" or "materialName.property"
     */
    private applyParameterByPath(state: OpenMCState, paramPath: string, value: number): void {
        const parts = paramPath.split('.');
        
        if (parts.length < 2) {
            this.logger.warn(`[OptimizationBackend] Invalid parameter path: ${paramPath}`);
            return;
        }

        const typePrefix = parts[0];
        
        if (typePrefix === 'settings') {
            this.applySettingsParameter(state, parts.slice(1).join('.'), value);
            return;
        }

        if (typePrefix === 'geometry') {
            this.applyGeometryParameter(state, parts.slice(1).join('.'), value);
            return;
        }

        const [materialName, ...rest] = parts;
        const targetField = rest.join('.');

        const material = state.materials.find(m => 
            m.name.toLowerCase() === materialName.toLowerCase()
        );

        if (!material) {
            this.logger.warn(`[OptimizationBackend] Material ${materialName} not found`);
            return;
        }

        const nuclide = material.nuclides.find(n => 
            n.name.toLowerCase() === targetField.toLowerCase()
        );

        if (nuclide) {
            this.setNuclideFraction(material, targetField, value);
            return;
        }

        const prop = targetField.toLowerCase();
        if (prop === 'density') {
            material.density = value;
            this.logger.info(`[OptimizationBackend] Set ${material.name}.density = ${value}`);
        } else if (prop === 'temperature') {
            material.temperature = value;
            this.logger.info(`[OptimizationBackend] Set ${material.name}.temperature = ${value}`);
        } else {
            this.logger.warn(`[OptimizationBackend] Unknown target: ${targetField}`);
        }
    }

    private applySettingsParameter(state: OpenMCState, settingKey: string, value: number): void {
        if (!state.settings || !state.settings.run) {
            this.logger.warn(`[OptimizationBackend] Settings not initialized`);
            return;
        }

        const runSettings = state.settings.run as any;

        switch (settingKey) {
            case 'particles':
                if ('particles' in runSettings) {
                    const roundedValue = Math.max(1, Math.round(value));
                    runSettings.particles = roundedValue;
                    this.logger.info(`[OptimizationBackend] Set settings.particles = ${roundedValue}`);
                }
                break;
            case 'inactive':
                if ('inactive' in runSettings) {
                    let roundedValue = Math.max(0, Math.round(value));
                    // Ensure inactive < batches to have at least 1 active batch
                    const batches = runSettings.batches ?? 10;
                    if (roundedValue >= batches) {
                        roundedValue = batches - 1;
                        this.logger.info(`[OptimizationBackend] Clamped inactive from ${Math.round(value)} to ${roundedValue} (must be < batches=${batches})`);
                    }
                    runSettings.inactive = roundedValue;
                    this.logger.info(`[OptimizationBackend] Set settings.inactive = ${roundedValue}`);
                }
                break;
            case 'batches':
                if ('batches' in runSettings) {
                    let roundedValue = Math.max(1, Math.round(value));
                    // Ensure batches > inactive to have at least 1 active batch
                    const inactive = runSettings.inactive ?? 0;
                    if (roundedValue <= inactive) {
                        roundedValue = inactive + 1;
                        this.logger.info(`[OptimizationBackend] Adjusted batches from ${Math.round(value)} to ${roundedValue} (must be > inactive=${inactive})`);
                    }
                    runSettings.batches = roundedValue;
                    this.logger.info(`[OptimizationBackend] Set settings.batches = ${roundedValue}`);
                }
                break;
            case 'seed':
                state.settings.seed = Math.max(1, Math.round(value));
                this.logger.info(`[OptimizationBackend] Set settings.seed = ${Math.max(1, Math.round(value))}`);
                break;
            default:
                this.logger.warn(`[OptimizationBackend] Unknown settings parameter: ${settingKey}`);
        }
    }

    private applyGeometryParameter(state: OpenMCState, paramKey: string, value: number): void {
        const parts = paramKey.split('.');
        if (parts.length < 2) {
            this.logger.warn(`[OptimizationBackend] Invalid geometry parameter path: ${paramKey}`);
            return;
        }

        const [cellName, prop] = parts;
        
        if (!state.geometry || !state.geometry.cells) {
            this.logger.warn(`[OptimizationBackend] Geometry not initialized`);
            return;
        }

        const cell = state.geometry.cells.find(c => 
            c.name?.toLowerCase() === cellName.toLowerCase()
        );

        if (!cell) {
            this.logger.warn(`[OptimizationBackend] Cell ${cellName} not found`);
            return;
        }

        if (prop === 'temperature') {
            cell.temperature = value;
            this.logger.info(`[OptimizationBackend] Set ${cell.name}.temperature = ${value}`);
        } else {
            this.logger.warn(`[OptimizationBackend] Unknown geometry parameter: ${prop}`);
        }
    }

    /**
     * Set a specific nuclide's fraction in a material and normalize all others to sum to 1
     */
    private setNuclideFraction(material: any, nuclideName: string, fraction: number): void {
        const targetNuclide = material.nuclides.find((n: any) => 
            n.name.toLowerCase() === nuclideName.toLowerCase()
        );

        if (!targetNuclide) {
            this.logger.warn(`[OptimizationBackend] Nuclide ${nuclideName} not found in ${material.name}`);
            return;
        }

        const otherNuclides = material.nuclides.filter((n: any) => 
            n.name.toLowerCase() !== nuclideName.toLowerCase()
        );

        const otherTotalBefore = otherNuclides.reduce((sum: number, n: any) => sum + n.fraction, 0);

        targetNuclide.fraction = fraction;
        const remainingFraction = 1.0 - fraction;
        
        if (otherNuclides.length > 0) {
            if (otherTotalBefore > 0) {
                for (const n of otherNuclides) {
                    n.fraction = (n.fraction / otherTotalBefore) * remainingFraction;
                }
            } else {
                const equalFraction = remainingFraction / otherNuclides.length;
                for (const n of otherNuclides) {
                    n.fraction = equalFraction;
                }
            }
        }

        this.logger.info(`[OptimizationBackend] Set ${nuclideName} to ${fraction} in ${material.name}`);
    }

    /**
     * Run OpenMC simulation
     */
    private logStream?: fs.WriteStream;

    private async runOpenMCSimulation(
        workingDir: string, 
        numProcesses: number,
        crossSectionsPath?: string,
        chainFilePath?: string,
        runState?: OptimizationRunState,
        logFilePath?: string
    ): Promise<{ success: boolean; error?: string }> {
        // Check if depletion is enabled in settings.xml
        const settingsXmlPath = path.join(workingDir, 'settings.xml');
        let useDepletion = false;
        let depletionSettings: { chainFile?: string; timeSteps: number[]; power?: number; powerDensity?: number } | undefined;
        
        if (fs.existsSync(settingsXmlPath)) {
            const content = fs.readFileSync(settingsXmlPath, 'utf-8');
            const depletionMatch = content.match(/<depletion>[\s\S]*?<\/depletion>/);
            if (depletionMatch) {
                useDepletion = true;
                const depletionXml = depletionMatch[0];
                
                const chainFileMatch = depletionXml.match(/<chain_file>(.*?)<\/chain_file>/);
                const chainFile = chainFileMatch ? chainFileMatch[1].trim() : undefined;
                
                const timeStepsMatch = depletionXml.match(/<time_steps>(.*?)<\/time_steps>/);
                const timeSteps = timeStepsMatch 
                    ? timeStepsMatch[1].trim().split(/\s+/).map(Number) 
                    : [];
                
                const powerMatch = depletionXml.match(/<power>(.*?)<\/power>/);
                const power = powerMatch ? parseFloat(powerMatch[1]) : undefined;
                
                const powerDensityMatch = depletionXml.match(/<power_density>(.*?)<\/power_density>/);
                const powerDensity = powerDensityMatch ? parseFloat(powerDensityMatch[1]) : undefined;
                
                depletionSettings = { chainFile, timeSteps, power, powerDensity };
                this.logger.info(`[OptimizationBackend] Depletion enabled - using Python API runner`);
            }
        }
        
        // If depletion enabled, use the Python runner
        if (useDepletion && depletionSettings) {
            return this.runDepletionSimulation(workingDir, numProcesses, depletionSettings, crossSectionsPath, chainFilePath, runState, logFilePath);
        }
        
        // Otherwise use direct OpenMC CLI
        const detectionResult = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            autoDetectEnvs: ['openmc', 'nuke-ide', 'visualizer']
        });

        if (!detectionResult.success || !detectionResult.command) {
            return { success: false, error: detectionResult.error || 'No Python environment with OpenMC found' };
        }

        const pythonDir = path.dirname(detectionResult.command);
        const isWindows = process.platform === 'win32';
        const openmcName = isWindows ? 'openmc.exe' : 'openmc';
        
        let openmcExe = path.join(pythonDir, openmcName);
        
        if (!fs.existsSync(openmcExe)) {
            const parentDir = path.dirname(pythonDir);
            const binDirs = isWindows 
                ? [path.join(parentDir, 'Scripts'), path.join(parentDir, 'bin')]
                : [path.join(parentDir, 'bin'), path.join(parentDir, 'Scripts')];
            
            for (const binDir of binDirs) {
                const openmcPath = path.join(binDir, openmcName);
                if (fs.existsSync(openmcPath)) {
                    openmcExe = openmcPath;
                    break;
                }
            }
        }

        const command = numProcesses > 1 ? 'mpirun' : openmcExe;
        const args = numProcesses > 1 ? ['-np', String(numProcesses), openmcExe] : [];
        this.logger.info(`[OptimizationBackend] Using command: ${command} with args: ${args.join(' ')}`);

        // Build environment with cross-sections and chain file
        const env: NodeJS.ProcessEnv = {
            ...process.env
        };
        if (crossSectionsPath) {
            env.OPENMC_CROSS_SECTIONS = crossSectionsPath;
            this.logger.info(`[OptimizationBackend] Using cross-sections: ${crossSectionsPath}`);
        }
        if (chainFilePath) {
            env.OPENMC_CHAIN_FILE = chainFilePath;
            this.logger.info(`[OptimizationBackend] Using chain file: ${chainFilePath}`);
        }

        // Create log file stream if path provided
        if (logFilePath) {
            this.logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        }

        return new Promise((resolve) => {

            this.logger.info(`[OptimizationBackend] Running OpenMC in ${workingDir}`);

            const childProcess = spawn(command, args, {
                cwd: workingDir,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Store process for cancellation
            if (runState) {
                runState.process = childProcess;
            }

            let stdout = '';
            let stderr = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                // Stream to clients for live log
                this.notifyLog(chunk);
                // Write to file
                if (this.logStream) {
                    this.logStream.write(chunk);
                }
            });

            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                // Stream errors to clients
                this.notifyWarn(chunk);
                // Write to file
                if (this.logStream) {
                    this.logStream.write(chunk);
                }
            });

            childProcess.on('close', (code) => {
                // Close log stream
                if (this.logStream) {
                    this.logStream.end();
                    this.logStream = undefined;
                }
                if (code === 0) {
                    resolve({ success: true });
                } else {
                    resolve({ 
                        success: false, 
                        error: `OpenMC exited with code ${code}: ${stderr || stdout}` 
                    });
                }
            });

            childProcess.on('error', (err) => {
                // Close log stream
                if (this.logStream) {
                    this.logStream.end();
                    this.logStream = undefined;
                }
                resolve({ success: false, error: `Failed to start OpenMC: ${err.message}` });
            });

            // Timeout after 10 minutes
            setTimeout(() => {
                childProcess.kill();
                resolve({ success: false, error: 'Simulation timeout (10 minutes exceeded)' });
            }, 600000);
        });
    }

    /**
     * Run depletion simulation using Python API
     */
    private depletionLogStream?: fs.WriteStream;

    private async runDepletionSimulation(
        workingDir: string, 
        numProcesses: number,
        depletionSettings: { chainFile?: string; timeSteps: number[]; power?: number; powerDensity?: number },
        crossSectionsPath?: string,
        providedChainFilePath?: string,
        runState?: OptimizationRunState,
        logFilePath?: string
    ): Promise<{ success: boolean; error?: string }> {
        this.logger.info(`[OptimizationBackend] Running depletion simulation in ${workingDir}`);

        // Create log file stream if path provided
        if (logFilePath) {
            this.depletionLogStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        }
        
        const detectionResult = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            autoDetectEnvs: ['openmc', 'nuke-ide', 'visualizer', 'trame']
        });

        if (!detectionResult.success || !detectionResult.command) {
            return { success: false, error: detectionResult.error || 'No Python environment with OpenMC found' };
        }

        const pythonCommand = detectionResult.command;
        const depletionRunnerPath = await this.getDepletionRunnerPath();
        
        const args = [
            depletionRunnerPath,
            workingDir,
            '--time-steps', depletionSettings.timeSteps.join(','),
        ];
        
        // Use provided chain file path or fall back to settings
        const chainFile = providedChainFilePath || depletionSettings.chainFile;
        if (chainFile) {
            args.push('--chain-file', chainFile);
        }
        
        if (depletionSettings.power !== undefined) {
            args.push('--power', String(depletionSettings.power));
        } else if (depletionSettings.powerDensity !== undefined) {
            args.push('--power-density', String(depletionSettings.powerDensity));
        }
        
        if (numProcesses > 1) {
            args.push('--mpi-processes', String(numProcesses));
        }

        // Build environment - ensure PATH includes Python bin directory
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) 
            ? currentPath 
            : `${pythonBinDir}:${currentPath}`;

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: newPath
        };

        // Add cross-sections path from request
        if (crossSectionsPath) {
            env.OPENMC_CROSS_SECTIONS = crossSectionsPath;
            this.logger.info(`[OptimizationBackend] Using cross-sections path: ${crossSectionsPath}`);
        }

        // Add chain file path from request
        if (providedChainFilePath) {
            env.OPENMC_CHAIN_FILE = providedChainFilePath;
            this.logger.info(`[OptimizationBackend] Using chain file path: ${providedChainFilePath}`);
        }

        return new Promise((resolve) => {
            this.logger.info(`[OptimizationBackend] Running: ${pythonCommand} ${args.join(' ')}`);
            if (crossSectionsPath) {
                this.logger.info(`[OptimizationBackend] Using cross-sections: ${crossSectionsPath}`);
            }

            const childProcess = spawn(pythonCommand, args, {
                cwd: workingDir,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Store process for cancellation
            if (runState) {
                runState.process = childProcess;
            }

            let stdout = '';
            let stderr = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                // Stream to clients for live log
                this.notifyLog(chunk);
                // Write to file
                if (this.depletionLogStream) {
                    this.depletionLogStream.write(chunk);
                }
            });

            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                // Stream to clients (depletion outputs progress to stderr)
                this.notifyLog(chunk);
                // Write to file
                if (this.depletionLogStream) {
                    this.depletionLogStream.write(chunk);
                }
            });

            childProcess.on('close', (code) => {
                // Close log stream
                if (this.depletionLogStream) {
                    this.depletionLogStream.end();
                    this.depletionLogStream = undefined;
                }
                if (code === 0) {
                    resolve({ success: true });
                } else {
                    resolve({ 
                        success: false, 
                        error: `Depletion runner exited with code ${code}: ${stderr || stdout}` 
                    });
                }
            });

            childProcess.on('error', (err) => {
                // Close log stream
                if (this.depletionLogStream) {
                    this.depletionLogStream.end();
                    this.depletionLogStream = undefined;
                }
                resolve({ success: false, error: `Failed to start depletion runner: ${err.message}` });
            });

            // Timeout after 30 minutes for depletion
            setTimeout(() => {
                childProcess.kill();
                resolve({ success: false, error: 'Depletion simulation timeout (30 minutes exceeded)' });
            }, 1800000);
        });
    }

    /**
     * Read results from statepoint file using Python
     */
    private async readStatepointResults(iterationDir: string): Promise<{ keff?: number; keffStd?: number }> {
        // Find the statepoint file (could be statepoint.h5 or statepoint.XXX.h5)
        const statepointFiles = fs.readdirSync(iterationDir)
            .filter(f => f.startsWith('statepoint') && f.endsWith('.h5'));
        
        if (statepointFiles.length === 0) {
            this.logger.warn(`[OptimizationBackend] No statepoint file found in ${iterationDir}`);
            return {};
        }
        
        const statepointFile = statepointFiles[0];
        const statepointPath = path.join(iterationDir, statepointFile);
        this.logger.info(`[OptimizationBackend] Reading statepoint: ${statepointPath}`);
        
        // Detect Python with OpenMC
        const detectionResult = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: [{ name: 'openmc' }],
            autoDetectEnvs: ['openmc', 'nuke-ide', 'visualizer', 'trame']
        });

        if (!detectionResult.success || !detectionResult.command) {
            this.logger.warn(`[OptimizationBackend] Could not detect Python with OpenMC for reading results`);
            return {};
        }

        const pythonCommand = detectionResult.command;
        this.logger.info(`[OptimizationBackend] Using Python: ${pythonCommand}`);
        
        return new Promise((resolve) => {
            // Use Python to read the statepoint - use actual filename
            const script = `
import openmc
import sys

try:
    sp = openmc.StatePoint('${statepointFile}')
    k = sp.k_combined
    print(f"KEFF:{k.nominal_value}")
    print(f"STD:{k.std_dev}")
except Exception as e:
    print(f"ERROR:{e}")
`;
            const scriptPath = path.join(iterationDir, 'read_results.py');
            fs.writeFileSync(scriptPath, script);

            // Build environment with OpenMC paths
            const crossSectionsPath = process.env.OPENMC_CROSS_SECTIONS;
            const chainFilePath = process.env.OPENMC_CHAIN_FILE;
            const env: NodeJS.ProcessEnv = { ...process.env };
            if (crossSectionsPath) {
                env.OPENMC_CROSS_SECTIONS = crossSectionsPath;
            }
            if (chainFilePath) {
                env.OPENMC_CHAIN_FILE = chainFilePath;
            }

            const childProcess = spawn(pythonCommand, ['read_results.py'], {
                cwd: iterationDir,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let keff: number | undefined;
            let keffStd: number | undefined;

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.startsWith('KEFF:')) {
                        keff = parseFloat(line.substring(5));
                    } else if (line.startsWith('STD:')) {
                        keffStd = parseFloat(line.substring(4));
                    }
                }
            });
            
            childProcess.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            childProcess.on('close', (code) => {
                this.logger.info(`[OptimizationBackend] Statepoint read exit code: ${code}, stdout: ${stdout}, stderr: ${stderr}`);
                if (keff !== undefined) {
                    this.logger.info(`[OptimizationBackend] Read keff=${keff} +/- ${keffStd} from ${iterationDir}`);
                }
                resolve({ keff, keffStd });
            });

            childProcess.on('error', (err) => {
                this.logger.warn(`[OptimizationBackend] Failed to read statepoint: ${err.message}`);
                resolve({});
            });

            // Timeout after 30 seconds
            setTimeout(() => {
                childProcess.kill();
                resolve({});
            }, 30000);
        });
    }

    /**
     * Generate all parameter combinations
     */
    private generateParameterCombinations(sweeps: OpenMCParameterSweep[]): Record<string, number>[] {
        if (sweeps.length === 0) {
            return [{}];
        }

        const combinations: Record<string, number>[] = [{}];

        for (const sweep of sweeps) {
            const values = this.computeSweepValues(sweep);
            const newCombinations: Record<string, number>[] = [];

            for (const combo of combinations) {
                for (const value of values) {
                    const paramKey = sweep.parameterPath || sweep.variable;
                    newCombinations.push({
                        ...combo,
                        [paramKey]: value
                    });
                }
            }

            combinations.length = 0;
            combinations.push(...newCombinations);
        }

        return combinations;
    }

    /**
     * Compute sweep values
     */
    private computeSweepValues(sweep: OpenMCParameterSweep): number[] {
        const { rangeType, startValue, endValue, numPoints } = sweep;
        const values: number[] = [];

        if (numPoints < 2) {
            return [startValue];
        }

        if (rangeType === 'linear') {
            const step = (endValue - startValue) / (numPoints - 1);
            for (let i = 0; i < numPoints; i++) {
                values.push(startValue + step * i);
            }
        } else { // logarithmic
            const logStart = Math.log10(startValue);
            const logEnd = Math.log10(endValue);
            const step = (logEnd - logStart) / (numPoints - 1);
            for (let i = 0; i < numPoints; i++) {
                values.push(Math.pow(10, logStart + step * i));
            }
        }

        return values;
    }

    /**
     * Notify clients of progress
     */
    private notifyProgress(event: OptimizationProgressEvent): void {
        this.clients.forEach(client => {
            if (client.onOptimizationProgress) {
                try {
                    client.onOptimizationProgress(event);
                } catch (error) {
                    this.logger.warn('[Optimization] Client disconnected, removing from listeners');
                    this.clients.delete(client);
                }
            }
        });
    }

    /**
     * Notify clients of iteration completion
     */
    private notifyIterationComplete(runId: string, result: OptimizationIterationResult): void {
        this.clients.forEach(client => {
            if (client.onOptimizationIterationComplete) {
                try {
                    client.onOptimizationIterationComplete(runId, result);
                } catch (error) {
                    this.logger.warn('[Optimization] Client disconnected, removing from listeners');
                    this.clients.delete(client);
                }
            }
        });
    }

    /**
     * Notify clients of log messages (live output)
     */
    private notifyLog(message: string): void {
        this.clients.forEach(client => {
            try {
                client.log(message);
            } catch (error) {
                this.logger.warn('[Optimization] Client disconnected, removing from listeners');
                this.clients.delete(client);
            }
        });
    }

    /**
     * Notify clients of warning messages
     */
    private notifyWarn(message: string): void {
        this.clients.forEach(client => {
            try {
                client.warn(message);
            } catch (error) {
                this.logger.warn('[Optimization] Client disconnected, removing from listeners');
                this.clients.delete(client);
            }
        });
    }
}
