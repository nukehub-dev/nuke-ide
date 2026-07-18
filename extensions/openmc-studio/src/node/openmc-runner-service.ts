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

/**
 * OpenMC Runner Service
 *
 * Backend service for running OpenMC simulations using Python.
 * Aligns with nuke-visualizer's approach of using Python directly.
 *
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { resolvePythonScript } from 'nuke-core/lib/node/utils/script-resolver';
import { ProcessManager } from '@theia/process/lib/node';
import * as fs from 'fs';
import * as path from 'path';

import {
    SimulationRunRequest,
    SimulationRunResult,
    SimulationProgress,
    SimulationLogResult,
    OpenMCStudioClient
} from '../common/openmc-studio-protocol';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import { OpenMCValidationBackendService } from './openmc-validation-backend-service';

interface RunningSimulation {
    processId: string;
    process: any; // ChildProcess type
    startTime: Date;
    request: SimulationRunRequest;
    logFilePath: string;
    logStream?: fs.WriteStream;
}

/**
 * OpenMC Runner Service
 *
 * Backend service for executing OpenMC simulations and depletion calculations.
 * Handles Python environment detection, process spawning, progress streaming,
 * and simulation lifecycle management.
 *
 * @module openmc-studio/node
 */
@injectable()
export class OpenMCRunnerService {
    @inject(ProcessManager)
    protected readonly processManager: ProcessManager;

    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    @inject(OpenMCValidationBackendService)
    protected readonly validationService: OpenMCValidationBackendService;

    private runningSimulations = new Map<string, RunningSimulation>();
    private completedSimulations = new Map<string, { workingDirectory: string; logFilePath: string }>();
    private client?: OpenMCStudioClient;

    /**
     * Check if depletion is enabled in the working directory by looking for
     * depletion settings in settings.xml.
     */
    private async checkDepletionEnabled(
        workingDirectory: string
    ): Promise<{ enabled: boolean; settings?: { chainFile?: string; timeSteps: number[]; power?: number; powerDensity?: number } }> {
        const fs = await import('fs');

        const settingsPath = path.join(workingDirectory, 'settings.xml');
        if (!fs.existsSync(settingsPath)) {
            return { enabled: false };
        }

        try {
            const content = fs.readFileSync(settingsPath, 'utf-8');
            // Check for <depletion> tag
            const depletionMatch = content.match(/<depletion>[\s\S]*?<\/depletion>/);
            if (depletionMatch) {
                const depletionXml = depletionMatch[0];

                // Extract chain file
                const chainFileMatch = depletionXml.match(/<chain_file>(.*?)<\/chain_file>/);
                const chainFile = chainFileMatch ? chainFileMatch[1] : undefined;

                // Extract time steps
                const timeStepsMatch = depletionXml.match(/<time_steps>(.*?)<\/time_steps>/);
                const timeSteps = timeStepsMatch
                    ? timeStepsMatch[1]
                          .trim()
                          .split(/\s+/)
                          .map(Number)
                          .filter((n) => !isNaN(n))
                    : [];

                // Extract power
                const powerMatch = depletionXml.match(/<power>(.*?)<\/power>/);
                const power = powerMatch ? Number(powerMatch[1]) : undefined;

                // Extract power density
                const powerDensityMatch = depletionXml.match(/<power_density>(.*?)<\/power_density>/);
                const powerDensity = powerDensityMatch ? Number(powerDensityMatch[1]) : undefined;

                return {
                    enabled: true,
                    settings: {
                        chainFile,
                        timeSteps,
                        power,
                        powerDensity
                    }
                };
            }

            return { enabled: false };
        } catch (e) {
            console.error('[OpenMC Runner] Error checking depletion settings:', e);
            return { enabled: false };
        }
    }

    /**
     * Get the path to the depletion runner script.
     */
    private async getDepletionRunnerPath(): Promise<string> {
        const resolved = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'run_depletion.py' });
        if (resolved) {
            this.log(`Found depletion script: ${resolved}`);
            return resolved;
        }
        throw new Error('Python script not found: run_depletion.py');
    }

    /**
     * Set the client for progress notifications and log streaming.
     * @param client - Frontend client interface
     */
    setClient(client: OpenMCStudioClient): void {
        this.client = client;
    }

    /**
     * Safely send log message to client. Removes client reference on disconnect error.
     */
    private safeLog(message: string): void {
        if (!this.client) return;
        try {
            this.client.log(message);
        } catch (error) {
            console.warn('[OpenMC Runner] Client disconnected, clearing client reference');
            this.client = undefined;
        }
    }

    /**
     * Safely send warning message to client. Removes client reference on disconnect error.
     */
    private safeWarn(message: string): void {
        if (!this.client) return;
        try {
            this.client.warn(message);
        } catch (error) {
            console.warn('[OpenMC Runner] Client disconnected, clearing client reference');
            this.client = undefined;
        }
    }

    /**
     * Safely send status update to client. Removes client reference on disconnect error.
     */
    private safeSendStatus(status: any): void {
        if (!this.client) return;
        try {
            this.client.onSimulationStatus(status);
        } catch (error) {
            console.warn('[OpenMC Runner] Client disconnected, clearing client reference');
            this.client = undefined;
        }
    }

    /**
     * Set Python configuration for environment detection.
     * @param config - Python path and/or conda environment
     */
    async setPythonConfig(config: { pythonPath?: string; condaEnv?: string }): Promise<void> {
        console.log(`[OpenMC Runner] Python config: ${JSON.stringify(config)}`);
        await this.nukeCoreService.setConfig(config);
    }

    /**
     * Log a message to the console (client logging disabled to prevent disconnect errors).
     */
    protected log(message: string): void {
        console.log(`[OpenMC Runner] ${message}`);
    }

    // ============================================================================
    // Python Environment Detection
    // ============================================================================

    /**
     * Detect Python command with OpenMC available.
     * @returns Python command, version, and any warnings
     * @throws Error if no environment with OpenMC is found
     */
    protected async detectPythonCommand(): Promise<{ command: string; warning?: string; version?: string }> {
        const validation = await this.validationService.validateOpenMCSetup();

        if (!validation.ready || !validation.pythonCommand) {
            throw new Error(
                validation.errors.join('\n') || 'Failed to detect environment with OpenMC. Configure in Settings → Nuke Utils.'
            );
        }

        // Log any warnings (e.g., fallback to different environment)
        if (validation.warnings.length > 0) {
            this.log(`Environment warning: ${validation.warnings.join('; ')}`);
        }

        // Get OpenMC version
        let version: string | undefined;
        try {
            const depCheck = await this.nukeCoreService.checkDependencies([{ name: 'openmc' }], validation.pythonCommand);
            version = depCheck.versions['openmc'];
        } catch {
            // Version check failed but OpenMC is available
        }

        return {
            command: validation.pythonCommand,
            version,
            warning: validation.warnings.join('\n') || undefined
        };
    }

    /**
     * Find the OpenMC executable corresponding to the given Python.
     * @param pythonPath - Path to Python executable
     * @returns Path to openmc executable
     */
    protected async findOpenMCExecutable(pythonPath: string): Promise<string> {
        const path = await import('path');
        const fs = await import('fs');

        // Get the directory containing Python
        const pythonDir = path.dirname(pythonPath);
        const isWindows = process.platform === 'win32';

        // Look for openmc executable in the same directory
        const openmcName = isWindows ? 'openmc.exe' : 'openmc';
        const openmcInSameDir = path.join(pythonDir, openmcName);

        if (fs.existsSync(openmcInSameDir)) {
            return openmcInSameDir;
        }

        // Also check if Python is in a 'bin' or 'Scripts' directory
        const parentDir = path.dirname(pythonDir);
        const binDirs = isWindows
            ? [path.join(parentDir, 'Scripts'), path.join(parentDir, 'bin')]
            : [path.join(parentDir, 'bin'), path.join(parentDir, 'Scripts')];

        for (const binDir of binDirs) {
            const openmcPath = path.join(binDir, openmcName);
            if (fs.existsSync(openmcPath)) {
                return openmcPath;
            }
        }

        // Last resort: assume it's in the same directory as Python
        this.log(`Warning: Could not find openmc executable, assuming it's in: ${openmcInSameDir}`);
        return openmcInSameDir;
    }

    // ============================================================================
    // OpenMC Availability Check
    // ============================================================================

    /**
     * Check if OpenMC is available in the configured environment.
     * @returns Availability status with version and path
     */
    async checkOpenMC(): Promise<{ available: boolean; version?: string; path?: string; error?: string }> {
        // Get Python command
        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            return {
                available: false,
                error: 'No Python environment configured'
            };
        }

        // Check for openmc using nuke-core
        const depCheck = await this.nukeCoreService.checkDependencies([{ name: 'openmc' }], pythonCommand);

        if (!depCheck.available) {
            return {
                available: false,
                error: `OpenMC not installed in configured environment`
            };
        }

        // Find the openmc executable path
        try {
            const openmcExe = await this.findOpenMCExecutable(pythonCommand);
            return {
                available: true,
                version: depCheck.versions['openmc'],
                path: openmcExe,
                error: undefined
            };
        } catch {
            return {
                available: true,
                version: depCheck.versions['openmc'],
                error: undefined
            };
        }
    }

    /**
     * Check if MPI is available for parallel simulations.
     * @returns MPI availability with version and default process count
     */
    async checkMPI(): Promise<{ available: boolean; version?: string; processes?: number; error?: string }> {
        try {
            const { execSync } = await import('child_process');

            // Try to run 'mpirun --version'
            const output = execSync('mpirun --version', { encoding: 'utf-8', timeout: 5000 });

            return {
                available: true,
                version: output.split('\n')[0],
                processes: this.getDefaultMPIProcesses()
            };
        } catch (error) {
            return {
                available: false,
                error: 'MPI (mpirun) not found in PATH'
            };
        }
    }

    private getDefaultMPIProcesses(): number {
        // Default to number of CPUs or 4
        return require('os').cpus().length || 4;
    }

    // ============================================================================
    // Simulation Runner
    // ============================================================================

    /**
     * Run OpenMC simulation (blocking - returns when complete).
     * @param request - Simulation run configuration
     * @returns Simulation result with output and timing
     */
    async runSimulation(request: SimulationRunRequest): Promise<SimulationRunResult> {
        const processId = `sim-${Date.now()}`;

        this.log(`Starting simulation ${processId} in ${request.workingDirectory}`);

        const { spawn } = await import('child_process');

        // Detect Python command
        this.log('Detecting Python environment...');
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;

        this.log(`Using Python: ${pythonCommand}${pythonInfo.version ? ` (${pythonInfo.version})` : ''}`);
        if (pythonInfo.warning) {
            this.log(`Note: ${pythonInfo.warning}`);
        }

        // Build command - find openmc executable
        const openmcExe = await this.findOpenMCExecutable(pythonCommand);

        let command: string;
        let args: string[];

        if (request.mpi?.enabled && request.mpi.processes && request.mpi.processes > 1) {
            command = 'mpirun';
            args = ['-np', String(request.mpi.processes), openmcExe];
        } else {
            command = openmcExe;
            args = [];
        }

        // Add any additional arguments
        if (request.args) {
            args.push(...request.args);
        }

        // Build environment - ensure PATH includes Python bin directory
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) ? currentPath : `${pythonBinDir}:${currentPath}`;

        this.log(`Environment PATH includes: ${pythonBinDir}`);

        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
                PATH: newPath,
                ...request.env
            };

            // Create log file path
            const logDir = path.join(request.workingDirectory, 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logFilePath = path.join(logDir, `${processId}.log`);
            const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

            const childProcess = spawn(command, args, {
                cwd: request.workingDirectory,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const startTime = new Date();
            let stdout = '';
            let stderr = '';

            // Store running simulation
            this.runningSimulations.set(processId, {
                processId,
                process: childProcess,
                startTime,
                request,
                logFilePath,
                logStream
            });

            // Handle stdout
            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                // Stream output to client for real-time feedback in frontend
                this.safeLog(chunk);
                this.parseProgress(chunk);
                // Write to log file
                logStream.write(chunk);
            });

            // Handle stderr
            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                // Stream errors to client for real-time feedback in frontend
                this.safeWarn(chunk);
                // Write to log file
                logStream.write(chunk);
            });

            // Handle process exit
            childProcess.on('close', (code: number | null) => {
                // Close log stream
                logStream.end();

                // Store completed simulation info for later log retrieval
                this.completedSimulations.set(processId, {
                    workingDirectory: request.workingDirectory,
                    logFilePath
                });

                this.runningSimulations.delete(processId);

                const endTime = new Date();
                const duration = (endTime.getTime() - startTime.getTime()) / 1000;

                // Get output files
                const outputFiles = this.detectOutputFiles(request.workingDirectory);

                const success = code === 0;
                let error: string | undefined;

                if (!success) {
                    if (code !== null) {
                        error = `Process exited with code ${code}`;
                    } else {
                        error = 'Process was terminated';
                    }
                    // Include stderr excerpt if available
                    if (stderr) {
                        const stderrExcerpt = stderr.split('\n').slice(0, 5).join('\n');
                        error += `\nStderr: ${stderrExcerpt}`;
                    }
                }

                resolve({
                    success,
                    exitCode: code ?? undefined,
                    stdout,
                    stderr,
                    error,
                    outputFiles,
                    timing: {
                        startTime: startTime.toISOString(),
                        endTime: endTime.toISOString(),
                        duration
                    }
                });
            });

            // Handle errors
            childProcess.on('error', (error: Error) => {
                // Close log stream
                logStream.end();

                // Store completed simulation info even on error
                this.completedSimulations.set(processId, {
                    workingDirectory: request.workingDirectory,
                    logFilePath
                });

                this.runningSimulations.delete(processId);
                reject(error);
            });
        });
    }

    /**
     * Start simulation non-blocking - returns immediately with processId.
     * If depletion is enabled, runs depletion via Python API instead.
     * @param request - Simulation run configuration
     * @returns Response with process ID for tracking
     */
    async startSimulation(request: SimulationRunRequest): Promise<{ processId: string; success: boolean; error?: string }> {
        const processId = `sim-${Date.now()}`;

        this.log(`Starting simulation ${processId} in ${request.workingDirectory}`);

        // Check if depletion is enabled
        const depletionCheck = await this.checkDepletionEnabled(request.workingDirectory);
        if (depletionCheck.enabled && depletionCheck.settings) {
            this.log('Depletion settings detected - running depletion via Python API');
            return this.startDepletionSimulation(processId, request, depletionCheck.settings);
        }

        const { spawn } = await import('child_process');

        // Detect Python command
        this.log('Detecting Python environment...');
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;

        if (!pythonCommand) {
            return {
                processId,
                success: false,
                error: 'Python with OpenMC not found. Please check your environment.'
            };
        }

        this.log(`Using Python: ${pythonCommand}${pythonInfo.version ? ` (${pythonInfo.version})` : ''}`);
        if (pythonInfo.warning) {
            this.log(`Note: ${pythonInfo.warning}`);
        }

        // Build command - find openmc executable
        const openmcExe = await this.findOpenMCExecutable(pythonCommand);

        let command: string;
        let args: string[];

        if (request.mpi?.enabled && request.mpi.processes && request.mpi.processes > 1) {
            command = 'mpirun';
            args = ['-np', String(request.mpi.processes), openmcExe];
        } else {
            command = openmcExe;
            args = [];
        }

        // Add any additional arguments
        if (request.args) {
            args.push(...request.args);
        }

        // Build environment - ensure PATH includes Python bin directory
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) ? currentPath : `${pythonBinDir}:${currentPath}`;

        this.log(`Environment PATH includes: ${pythonBinDir}`);

        try {
            const env = {
                ...process.env,
                PATH: newPath,
                ...request.env
            };

            // Create log file path
            const logDir = path.join(request.workingDirectory, 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logFilePath = path.join(logDir, `${processId}.log`);
            const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

            const childProcess = spawn(command, args, {
                cwd: request.workingDirectory,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const startTime = new Date();
            let stdout = '';
            let stderr = '';

            // Store running simulation with log info
            this.runningSimulations.set(processId, {
                processId,
                process: childProcess,
                startTime,
                request,
                logFilePath,
                logStream
            });

            // Notify client that simulation is starting
            this.safeSendStatus({
                processId,
                status: 'starting'
            });

            // Handle stdout
            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                this.safeLog(chunk);
                this.parseProgress(chunk);
                // Write to log file
                logStream.write(chunk);
            });

            // Handle stderr
            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                this.safeWarn(chunk);
                // Write to log file
                logStream.write(chunk);
            });

            // Handle process exit
            childProcess.on('close', (code: number | null) => {
                // Close log stream
                logStream.end();

                // Store completed simulation info for later log retrieval
                this.completedSimulations.set(processId, {
                    workingDirectory: request.workingDirectory,
                    logFilePath
                });

                this.runningSimulations.delete(processId);

                const endTime = new Date();
                const duration = (endTime.getTime() - startTime.getTime()) / 1000;

                // Get output files
                const outputFiles = this.detectOutputFiles(request.workingDirectory);

                const success = code === 0;
                let error: string | undefined;

                if (!success) {
                    if (code !== null) {
                        error = `Process exited with code ${code}`;
                    } else {
                        error = 'Process was terminated';
                    }
                    if (stderr) {
                        const stderrExcerpt = stderr.split('\n').slice(0, 5).join('\n');
                        error += `\nStderr: ${stderrExcerpt}`;
                    }
                }

                // Notify client of completion
                this.safeSendStatus({
                    processId,
                    status: success ? 'completed' : 'failed',
                    result: {
                        success,
                        exitCode: code ?? undefined,
                        stdout,
                        stderr,
                        error,
                        outputFiles,
                        timing: {
                            startTime: startTime.toISOString(),
                            endTime: endTime.toISOString(),
                            duration
                        }
                    }
                });
            });

            // Handle errors
            childProcess.on('error', (error: Error) => {
                // Close log stream
                logStream.end();

                // Store completed simulation info even on error
                this.completedSimulations.set(processId, {
                    workingDirectory: request.workingDirectory,
                    logFilePath
                });

                this.runningSimulations.delete(processId);
                this.safeSendStatus({
                    processId,
                    status: 'failed',
                    result: {
                        success: false,
                        error: error.message,
                        stdout,
                        stderr,
                        outputFiles: []
                    }
                });
            });

            // Return immediately with processId
            return { processId, success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Error starting simulation: ${errorMsg}`);
            return {
                processId,
                success: false,
                error: errorMsg
            };
        }
    }

    /**
     * Start depletion simulation using Python API.
     */
    private async startDepletionSimulation(
        processId: string,
        request: SimulationRunRequest,
        depletionSettings: { chainFile?: string; timeSteps: number[]; power?: number; powerDensity?: number }
    ): Promise<{ processId: string; success: boolean; error?: string }> {
        const { spawn } = await import('child_process');
        const path = await import('path');

        // Detect Python command
        this.log('Detecting Python environment for depletion...');
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;

        if (!pythonCommand) {
            return {
                processId,
                success: false,
                error: 'Python with OpenMC not found. Please check your environment.'
            };
        }

        // Get the depletion runner script path
        const depletionRunnerPath = await this.getDepletionRunnerPath();

        // Build command arguments
        const args: string[] = [depletionRunnerPath, request.workingDirectory, '--time-steps', depletionSettings.timeSteps.join(',')];

        if (depletionSettings.chainFile) {
            args.push('--chain-file', depletionSettings.chainFile);
        }

        if (depletionSettings.power !== undefined) {
            args.push('--power', String(depletionSettings.power));
        } else if (depletionSettings.powerDensity !== undefined) {
            args.push('--power-density', String(depletionSettings.powerDensity));
        }

        // Default solver and operator
        args.push('--solver', 'cecm');
        args.push('--operator', 'coupled');

        // Add MPI processes if enabled
        if (request.mpi?.enabled && request.mpi.processes && request.mpi.processes > 1) {
            args.push('--mpi-processes', String(request.mpi.processes));
        }

        this.log(`Running depletion: ${pythonCommand} ${args.join(' ')}`);

        // Build environment
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) ? currentPath : `${pythonBinDir}:${currentPath}`;

        try {
            const env = {
                ...process.env,
                PATH: newPath,
                ...request.env
            };

            // Create log file path
            const logDir = path.join(request.workingDirectory, 'logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const logFilePath = path.join(logDir, `${processId}.log`);
            const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

            const childProcess = spawn(pythonCommand, args, {
                cwd: request.workingDirectory,
                env,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            const startTime = new Date();
            let stdout = '';
            let stderr = '';

            // Store running simulation
            this.runningSimulations.set(processId, {
                processId,
                process: childProcess,
                startTime,
                request,
                logFilePath,
                logStream
            });

            // Notify client that simulation is starting
            this.safeSendStatus({
                processId,
                status: 'starting'
            });

            // Handle stdout
            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                this.safeLog(chunk);
                logStream.write(chunk);
            });

            // Handle stderr (includes progress messages from depletion script)
            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                this.safeLog(chunk);
                logStream.write(chunk);
            });

            // Handle process exit
            childProcess.on('close', (code: number | null) => {
                // Close log stream
                logStream.end();

                // Store completed simulation info for later log retrieval
                this.completedSimulations.set(processId, {
                    workingDirectory: request.workingDirectory,
                    logFilePath
                });

                this.runningSimulations.delete(processId);

                const endTime = new Date();
                const duration = (endTime.getTime() - startTime.getTime()) / 1000;

                // Get output files including depletion results
                const outputFiles = this.detectOutputFiles(request.workingDirectory);

                const success = code === 0;
                let error: string | undefined;

                if (!success) {
                    if (code !== null) {
                        error = `Depletion process exited with code ${code}`;
                    } else {
                        error = 'Depletion process was terminated';
                    }
                    if (stderr) {
                        const stderrExcerpt = stderr.split('\n').slice(0, 10).join('\n');
                        error += `\nStderr: ${stderrExcerpt}`;
                    }
                }

                // Notify client of completion
                this.safeSendStatus({
                    processId,
                    status: success ? 'completed' : 'failed',
                    result: {
                        success,
                        exitCode: code ?? undefined,
                        stdout,
                        stderr,
                        error,
                        outputFiles,
                        timing: {
                            startTime: startTime.toISOString(),
                            endTime: endTime.toISOString(),
                            duration
                        }
                    }
                });
            });

            // Handle errors
            childProcess.on('error', (error: Error) => {
                // Close log stream
                logStream.end();

                // Store completed simulation info even on error
                this.completedSimulations.set(processId, {
                    workingDirectory: request.workingDirectory,
                    logFilePath
                });

                this.runningSimulations.delete(processId);
                this.safeSendStatus({
                    processId,
                    status: 'failed',
                    result: {
                        success: false,
                        error: error.message,
                        stdout,
                        stderr,
                        outputFiles: []
                    }
                });
            });

            // Return immediately with processId
            return { processId, success: true };
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.log(`Error starting depletion simulation: ${errorMsg}`);
            return {
                processId,
                success: false,
                error: errorMsg
            };
        }
    }

    /**
     * Cancel a running simulation.
     * @param processId - Process ID from startSimulation
     * @returns Whether cancellation was successful
     */
    async cancelSimulation(processId: string): Promise<boolean> {
        const simulation = this.runningSimulations.get(processId);

        if (!simulation) {
            this.log(`Cancel failed: simulation ${processId} not found`);
            return false;
        }

        try {
            this.log(`Cancelling simulation ${processId}...`);
            simulation.process.kill('SIGTERM');

            // Force kill after 3 seconds if still running
            setTimeout(() => {
                if (!simulation.process.killed) {
                    this.log(`Force killing simulation ${processId}...`);
                    simulation.process.kill('SIGKILL');
                }
            }, 3000);

            // Notify client
            this.safeSendStatus({
                processId,
                status: 'cancelled'
            });

            return true;
        } catch (error) {
            this.log(`Error cancelling simulation: ${error}`);
            return false;
        }
    }

    /**
     * Get simulation log file content.
     * @param processId - Process ID from startSimulation
     * @returns Log content and status
     */
    async getSimulationLog(processId: string): Promise<SimulationLogResult> {
        const simulation = this.runningSimulations.get(processId);

        // If simulation is running, return current log file path
        if (simulation) {
            try {
                if (fs.existsSync(simulation.logFilePath)) {
                    const content = fs.readFileSync(simulation.logFilePath, 'utf-8');
                    return {
                        success: true,
                        logContent: content,
                        logPath: simulation.logFilePath,
                        isRunning: true
                    };
                } else {
                    return {
                        success: false,
                        error: 'Log file not found',
                        isRunning: true
                    };
                }
            } catch (error) {
                return {
                    success: false,
                    error: `Error reading log: ${error}`,
                    isRunning: true
                };
            }
        }

        // Try to find log file for completed simulation using stored info
        const completedSim = this.completedSimulations.get(processId);
        if (completedSim) {
            try {
                if (fs.existsSync(completedSim.logFilePath)) {
                    const content = fs.readFileSync(completedSim.logFilePath, 'utf-8');
                    return {
                        success: true,
                        logContent: content,
                        logPath: completedSim.logFilePath,
                        isRunning: false
                    };
                } else {
                    return {
                        success: false,
                        error: 'Log file not found for completed simulation',
                        isRunning: false
                    };
                }
            } catch (error) {
                return {
                    success: false,
                    error: `Error reading log: ${error}`,
                    isRunning: false
                };
            }
        }

        // Simulation not found
        return {
            success: false,
            error: 'Simulation not found',
            isRunning: false
        };
    }

    /**
     * Parse progress information from OpenMC stdout output.
     * @param output - Output chunk from OpenMC process
     */
    private parseProgress(output: string): void {
        // Look for batch progress patterns
        // Example: "Simulating batch 10/100..."
        const batchMatch = output.match(/batch\s+(\d+)\s*\/\s*(\d+)/i);
        if (batchMatch) {
            const batch = parseInt(batchMatch[1], 10);
            const total = parseInt(batchMatch[2], 10);

            // Look for k-effective
            const keffMatch = output.match(/k-effective\s*=\s*([\d.]+)\s*\+\/\-\s*([\d.]+)/i);

            const progress: SimulationProgress = {
                batch,
                totalBatches: total,
                elapsedTime: 0,
                complete: false
            };

            if (keffMatch) {
                progress.kEff = parseFloat(keffMatch[1]);
                progress.kEffStd = parseFloat(keffMatch[2]);
            }

            // Notify client (disabled to prevent disconnect errors)
            // this.client?.onProgress(progress);
        }
    }

    /**
     * Detect output files in the working directory.
     * @param workingDirectory - Directory to scan
     * @returns List of output file paths
     */
    private detectOutputFiles(workingDirectory: string): string[] {
        const fs = require('fs');

        const outputFiles: string[] = [];

        try {
            const files = fs.readdirSync(workingDirectory);

            for (const file of files) {
                // Check for statepoint files
                if (file.startsWith('statepoint') && file.endsWith('.h5')) {
                    outputFiles.push(path.join(workingDirectory, file));
                }
                // Check for summary file
                else if (file === 'summary.h5') {
                    outputFiles.push(path.join(workingDirectory, file));
                }
                // Check for source file
                else if (file === 'source.h5') {
                    outputFiles.push(path.join(workingDirectory, file));
                }
                // Check for tally output
                else if (file.startsWith('tally') && file.endsWith('.out')) {
                    outputFiles.push(path.join(workingDirectory, file));
                }
                // Check for depletion results
                else if (file === 'depletion_results.h5') {
                    outputFiles.push(path.join(workingDirectory, file));
                }
                // Check for depletion summary
                else if (file === 'depletion_summary.json') {
                    outputFiles.push(path.join(workingDirectory, file));
                }
                // Check for OpenMC simulation output (from depletion)
                else if (file === 'openmc_simulation.h5') {
                    outputFiles.push(path.join(workingDirectory, file));
                }
            }
        } catch (error) {
            this.log(`Error detecting output files: ${error}`);
        }

        return outputFiles;
    }

    /**
     * Cleanup running simulations on shutdown.
     * Sends SIGTERM to all active processes.
     */
    cleanup(): void {
        this.log('Cleaning up running simulations');

        for (const [processId, simulation] of this.runningSimulations) {
            this.log(`Terminating simulation ${processId}`);
            try {
                simulation.process.kill('SIGTERM');
            } catch (error) {
                // Ignore errors during cleanup
            }
        }

        this.runningSimulations.clear();
    }
}
