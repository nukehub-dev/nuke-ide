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
    OpenMCStudioClient,
    VolumeCalculationRequest,
    VolumeCalculationResult,
    PlotGenerationRequest,
    PlotGenerationResult,
    DepletionRunSettings,
    NCrystalImportResult,
    MgxsGenerationRequest,
    MgxsGenerationResult,
    MgConversionRequest,
    MgConversionResult,
    MgxsDataNamesResult,
    ChainBuildRequest,
    ChainBuildResult,
    MgxsLibraryGenerationRequest,
    MgxsLibraryGenerationResult
} from '../common/openmc-studio-protocol';
import { OpenMCCmfdSettings } from '../common/openmc-state-schema';
import { resolveDepletionSolver } from '../common/depletion-solvers';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import { STUDIO_CORE_PACKAGES } from '../common/packages';
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
    private async checkDepletionEnabled(workingDirectory: string): Promise<{ enabled: boolean; settings?: DepletionRunSettings }> {
        const fs = await import('fs');

        const settingsPath = path.join(workingDirectory, 'settings.xml');
        if (!fs.existsSync(settingsPath)) {
            return { enabled: false };
        }

        const extractTag = (xml: string, tag: string): string | undefined => {
            const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
            return match ? match[1] : undefined;
        };

        const unescapeXml = (text: string): string =>
            text
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&amp;/g, '&');

        try {
            const content = fs.readFileSync(settingsPath, 'utf-8');
            // Check for <depletion> tag
            const depletionMatch = content.match(/<depletion>[\s\S]*?<\/depletion>/);
            if (!depletionMatch) {
                return { enabled: false };
            }

            const depletionXml = depletionMatch[0];

            // Extract chain file
            const chainFile = extractTag(depletionXml, 'chain_file');

            // Extract time steps
            const timeStepsText = extractTag(depletionXml, 'time_steps');
            const timeSteps = timeStepsText
                ? timeStepsText
                      .trim()
                      .split(/\s+/)
                      .map(Number)
                      .filter((n) => !isNaN(n))
                : [];

            // Extract power
            const powerText = extractTag(depletionXml, 'power');
            const power = powerText !== undefined ? Number(powerText) : undefined;

            // Extract power density
            const powerDensityText = extractTag(depletionXml, 'power_density');
            const powerDensity = powerDensityText !== undefined ? Number(powerDensityText) : undefined;

            const settings: DepletionRunSettings = { chainFile, timeSteps, power, powerDensity };

            // Advanced options
            const operator = extractTag(depletionXml, 'operator');
            if (operator) {
                settings.operator = operator as DepletionRunSettings['operator'];
            }
            const solver = extractTag(depletionXml, 'solver');
            if (solver) {
                // Legacy stored values (leapfrog, predictor-corrector, …) map
                // to canonical OpenMC integrator ids
                settings.solver = resolveDepletionSolver(solver);
            }
            const normalization = extractTag(depletionXml, 'normalization');
            if (normalization) {
                settings.normalization = normalization;
            }
            if (extractTag(depletionXml, 'diff_burnable_mats') === 'true') {
                settings.diffBurnableMats = true;
            }
            const diffVolumeMethod = extractTag(depletionXml, 'diff_volume_method');
            if (diffVolumeMethod) {
                settings.diffVolumeMethod = diffVolumeMethod as DepletionRunSettings['diffVolumeMethod'];
            }
            const fluxFiles = extractTag(depletionXml, 'flux_files');
            if (fluxFiles) {
                settings.fluxFiles = fluxFiles.split(',').filter((f) => f.length > 0);
            }
            const microxsFiles = extractTag(depletionXml, 'microxs_files');
            if (microxsFiles) {
                settings.microxsFiles = microxsFiles.split(',').filter((f) => f.length > 0);
            }
            if (extractTag(depletionXml, 'generate_microxs') === 'true') {
                settings.generateFromModel = true;
            }
            const transferRates = extractTag(depletionXml, 'transfer_rates');
            if (transferRates) {
                try {
                    settings.transferRates = JSON.parse(unescapeXml(transferRates));
                } catch {
                    this.log('Warning: failed to parse <transfer_rates> JSON in settings.xml');
                }
            }
            const fissionQ = extractTag(depletionXml, 'fission_q');
            if (fissionQ) {
                try {
                    settings.fissionQ = JSON.parse(unescapeXml(fissionQ));
                } catch {
                    this.log('Warning: failed to parse <fission_q> JSON in settings.xml');
                }
            }

            return { enabled: true, settings };
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
     * Get the path to the CMFD runner script.
     */
    private async getCmfdRunnerPath(): Promise<string> {
        const resolved = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'run_cmfd.py' });
        if (resolved) {
            this.log(`Found CMFD script: ${resolved}`);
            return resolved;
        }
        throw new Error('Python script not found: run_cmfd.py');
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
        // Merge with the current nuke-core config so OpenMC data-library paths
        // (cross sections / chain file) set via Nuke Utils preferences are preserved.
        const current = await this.nukeCoreService.getConfig();
        await this.nukeCoreService.setConfig({ ...current, ...config });
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
            const depCheck = await this.nukeCoreService.checkDependencies(STUDIO_CORE_PACKAGES, validation.pythonCommand);
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
     *
     * Resolution order:
     * 1. ``$OPENMC_ROOT/bin/openmc`` if the ``OPENMC_ROOT`` environment variable is set.
     * 2. ``openmc`` resolved on ``PATH`` (with the Python directory and ``$OPENMC_ROOT/bin``
     *    prepended so common layouts are found).
     * 3. Next to the Python interpreter.
     * 4. In a sibling ``bin`` / ``Scripts`` directory.
     *
     * @param pythonPath - Path to Python executable
     * @returns Path to openmc executable
     */
    protected async findOpenMCExecutable(pythonPath: string): Promise<string> {
        const path = await import('path');
        const fs = await import('fs');
        const { execSync } = await import('child_process');

        const pythonDir = path.dirname(pythonPath);
        const isWindows = process.platform === 'win32';
        const openmcName = isWindows ? 'openmc.exe' : 'openmc';
        const candidates: string[] = [];

        // 1. OPENMC_ROOT explicit install root.
        if (process.env.OPENMC_ROOT) {
            candidates.push(path.join(process.env.OPENMC_ROOT, 'bin', openmcName));
        }

        // 2. Resolve via PATH, making sure the Python bin dir and OPENMC_ROOT/bin are searched.
        const pathSegments: string[] = [pythonDir];
        if (process.env.OPENMC_ROOT) {
            pathSegments.push(path.join(process.env.OPENMC_ROOT, 'bin'));
        }
        const currentPath = process.env.PATH || '';
        const separator = isWindows ? ';' : ':';
        const searchPath = [...pathSegments, currentPath].join(separator);
        try {
            const whichCmd = isWindows ? 'where' : 'which';
            const resolved = execSync(`"${whichCmd}" ${openmcName}`, {
                env: { ...process.env, PATH: searchPath },
                encoding: 'utf-8'
            })
                .trim()
                .split('\n')[0];
            if (resolved) {
                candidates.push(resolved);
            }
        } catch {
            // PATH lookup failed; continue with explicit candidates.
        }

        // 3. Same directory as the Python interpreter.
        candidates.push(path.join(pythonDir, openmcName));

        // 4. Sibling bin / Scripts directory.
        const parentDir = path.dirname(pythonDir);
        const binDirs = isWindows
            ? [path.join(parentDir, 'Scripts'), path.join(parentDir, 'bin')]
            : [path.join(parentDir, 'bin'), path.join(parentDir, 'Scripts')];
        for (const binDir of binDirs) {
            candidates.push(path.join(binDir, openmcName));
        }

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        // Last resort: return the first candidate so spawn errors are meaningful.
        this.log(`Warning: Could not find openmc executable, expected at: ${candidates[0]}`);
        return candidates[0];
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
        const depCheck = await this.nukeCoreService.checkDependencies(STUDIO_CORE_PACKAGES, pythonCommand);

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

        // Restart from a previous statepoint file (openmc -r <file>)
        if (request.restartFile) {
            args.push('-r', request.restartFile);
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
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                PATH: newPath,
                ...request.env
            };

            // Ensure backend environment variables are available even when the
            // frontend process cannot read the shell environment.
            if (!env.OPENMC_CROSS_SECTIONS && process.env.OPENMC_CROSS_SECTIONS) {
                env.OPENMC_CROSS_SECTIONS = process.env.OPENMC_CROSS_SECTIONS;
            }
            if (!env.OPENMC_CHAIN_FILE && process.env.OPENMC_CHAIN_FILE) {
                env.OPENMC_CHAIN_FILE = process.env.OPENMC_CHAIN_FILE;
            }

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
            childProcess.on('close', async (code: number | null) => {
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

                // Tidy particle track and particle-restart files into subfolders
                await this.organizeRunOutputFiles(request.workingDirectory, request.restartFile);

                // Get output files
                const outputFiles = await this.detectOutputFiles(request.workingDirectory);

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

        // CMFD is a C-API feature with no settings.xml representation, so it
        // cannot ride the plain `openmc` binary path — route to the driver.
        if (request.cmfd?.enabled) {
            this.log('CMFD acceleration enabled - running via openmc.cmfd C API driver');
            return this.startCmfdSimulation(processId, request, request.cmfd);
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

        // Restart from a previous statepoint file (openmc -r <file>)
        if (request.restartFile) {
            args.push('-r', request.restartFile);
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
            childProcess.on('close', async (code: number | null) => {
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

                // Tidy particle track and particle-restart files into subfolders
                await this.organizeRunOutputFiles(request.workingDirectory, request.restartFile);

                // Get output files
                const outputFiles = await this.detectOutputFiles(request.workingDirectory);

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
        depletionSettings: DepletionRunSettings
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

        // Solver and operator
        args.push('--solver', resolveDepletionSolver(depletionSettings.solver));
        args.push('--operator', depletionSettings.operator ?? 'coupled');

        // Advanced options
        if (depletionSettings.normalization) {
            args.push('--normalization', depletionSettings.normalization);
        }
        if (depletionSettings.diffBurnableMats) {
            args.push('--diff-burnable-mats');
        }
        if (depletionSettings.diffVolumeMethod) {
            args.push('--diff-volume-method', depletionSettings.diffVolumeMethod);
        }
        if (depletionSettings.fluxFiles && depletionSettings.fluxFiles.length > 0) {
            args.push('--flux-files', depletionSettings.fluxFiles.join(','));
        }
        if (depletionSettings.microxsFiles && depletionSettings.microxsFiles.length > 0) {
            args.push('--microxs-files', depletionSettings.microxsFiles.join(','));
        }
        if (depletionSettings.generateFromModel) {
            args.push('--generate-microxs');
        }
        if (depletionSettings.transferRates && depletionSettings.transferRates.length > 0) {
            args.push('--transfer-rates', JSON.stringify(depletionSettings.transferRates));
        }
        if (depletionSettings.fissionQ && Object.keys(depletionSettings.fissionQ).length > 0) {
            args.push('--fission-q', JSON.stringify(depletionSettings.fissionQ));
        }

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
            childProcess.on('close', async (code: number | null) => {
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
                const outputFiles = await this.detectOutputFiles(request.workingDirectory);

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
     * Start a CMFD-accelerated simulation using the Python C API driver.
     *
     * Mirrors {@link startDepletionSimulation}: XML inputs are already in the
     * working directory (generated by the caller), the CMFD config travels as
     * a JSON CLI argument, driver progress streams on stderr, and libopenmc's
     * own batch table on stdout feeds {@link parseProgress} like the CLI path.
     */
    private async startCmfdSimulation(
        processId: string,
        request: SimulationRunRequest,
        cmfd: OpenMCCmfdSettings
    ): Promise<{ processId: string; success: boolean; error?: string }> {
        const { spawn } = await import('child_process');
        const path = await import('path');

        // Detect Python command
        this.log('Detecting Python environment for CMFD run...');
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;

        if (!pythonCommand) {
            return {
                processId,
                success: false,
                error: 'Python with OpenMC not found. Please check your environment.'
            };
        }

        // Get the CMFD runner script path
        const cmfdRunnerPath = await this.getCmfdRunnerPath();

        // Build command; MPI wraps the driver in mpirun (the driver hands the
        // world communicator to the C API via mpi4py)
        const mpiProcesses = request.mpi?.enabled && request.mpi.processes && request.mpi.processes > 1 ? request.mpi.processes : undefined;
        const driverArgs = [cmfdRunnerPath, request.workingDirectory, '--cmfd-config', JSON.stringify(cmfd)];

        let command: string;
        let args: string[];
        if (mpiProcesses) {
            command = 'mpirun';
            args = ['-np', String(mpiProcesses), pythonCommand, ...driverArgs, '--mpi-processes', String(mpiProcesses)];
        } else {
            command = pythonCommand;
            args = driverArgs;
        }

        this.log(`Running with CMFD acceleration: ${command} ${args.join(' ')}`);

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

            // Notify client that simulation is starting
            this.safeSendStatus({
                processId,
                status: 'starting'
            });

            // Handle stdout (libopenmc batch table — same format as the CLI)
            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                this.safeLog(chunk);
                this.parseProgress(chunk);
                logStream.write(chunk);
            });

            // Handle stderr (includes progress messages from the CMFD driver)
            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                this.safeLog(chunk);
                logStream.write(chunk);
            });

            // Handle process exit
            childProcess.on('close', async (code: number | null) => {
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

                // Get output files including the statepoint
                const outputFiles = await this.detectOutputFiles(request.workingDirectory);

                const success = code === 0;
                let error: string | undefined;

                if (!success) {
                    if (code !== null) {
                        error = `CMFD process exited with code ${code}`;
                    } else {
                        error = 'CMFD process was terminated';
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
            this.log(`Error starting CMFD simulation: ${errorMsg}`);
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
     * Read the effective OpenMC output directory from settings.xml.
     * Falls back to the working directory when settings.xml is missing or has
     * no <output><path> element.
     * @param workingDirectory - Directory containing settings.xml
     * @returns Effective output directory
     */
    private async getOutputDirectory(workingDirectory: string): Promise<string> {
        const settingsPath = path.join(workingDirectory, 'settings.xml');
        try {
            const content = await fs.promises.readFile(settingsPath, 'utf-8');
            const match = content.match(/<output>\s*[\s\S]*?<path>([^<]+)<\/path>[\s\S]*?<\/output>/);
            if (match && match[1]) {
                const outputPath = match[1].trim();
                if (path.isAbsolute(outputPath)) {
                    return outputPath;
                }
                return path.resolve(workingDirectory, outputPath);
            }
        } catch {
            // ignore and fall back
        }
        return workingDirectory;
    }

    /**
     * Move OpenMC particle track files (`tracks.h5`, `tracks_p<N>.h5`) and
     * lost-particle restart files (`particle_<batch>_<id>.h5`) from both the
     * working directory and the configured OpenMC output directory into
     * dedicated `tracks/` and `particles/` subfolders. This keeps both the cwd
     * and `settings.output.path` tidy. The currently selected restart file is
     * left untouched so a re-run from it still works.
     * Non-blocking: failures are logged but do not fail the run.
     * @param workingDirectory - Directory to organize
     * @param restartFile - Optional restart file path to preserve in place
     */
    private async organizeRunOutputFiles(workingDirectory: string, restartFile?: string): Promise<void> {
        const restartBase = restartFile ? path.basename(restartFile) : undefined;
        const outputDirectory = await this.getOutputDirectory(workingDirectory);
        const directories = [workingDirectory];
        if (outputDirectory !== workingDirectory) {
            directories.push(outputDirectory);
        }

        for (const dir of directories) {
            try {
                const tracksDir = path.join(dir, 'tracks');
                await fs.promises.mkdir(tracksDir, { recursive: true });

                const particlesDir = path.join(dir, 'particles');
                await fs.promises.mkdir(particlesDir, { recursive: true });

                const files = await fs.promises.readdir(dir);
                for (const file of files) {
                    // Particle tracks
                    if (file === 'tracks.h5' || /^tracks_p\d+\.h5$/.test(file)) {
                        const source = path.join(dir, file);
                        const destination = path.join(tracksDir, file);
                        try {
                            await fs.promises.access(destination);
                            this.log(`Track file already exists in ${path.relative(workingDirectory, tracksDir)}/: ${file}`);
                        } catch {
                            await fs.promises.rename(source, destination);
                            this.log(`Moved track file into ${path.relative(workingDirectory, tracksDir)}/: ${file}`);
                        }
                    }
                    // Lost-particle restart files; leave the actively selected restart file alone
                    else if (/^particle_\d+_\d+\.h5$/.test(file) && file !== restartBase) {
                        const source = path.join(dir, file);
                        const destination = path.join(particlesDir, file);
                        try {
                            await fs.promises.access(destination);
                            this.log(`Particle restart file already exists in ${path.relative(workingDirectory, particlesDir)}/: ${file}`);
                        } catch {
                            await fs.promises.rename(source, destination);
                            this.log(`Moved particle restart file into ${path.relative(workingDirectory, particlesDir)}/: ${file}`);
                        }
                    }
                }
            } catch (error) {
                this.log(`Warning: failed to organize run output files in ${dir}: ${error}`);
            }
        }
    }

    /**
     * Detect output files in the working directory and the configured output
     * directory (including organized subfolders).
     * @param workingDirectory - Directory to scan
     * @returns List of output file paths
     */
    private async detectOutputFiles(workingDirectory: string): Promise<string[]> {
        const outputFiles: string[] = [];
        const outputDirectory = await this.getOutputDirectory(workingDirectory);
        const directories = [workingDirectory];
        if (outputDirectory !== workingDirectory) {
            directories.push(outputDirectory);
        }

        for (const dir of directories) {
            try {
                const files = await fs.promises.readdir(dir);

                for (const file of files) {
                    // Check for statepoint files
                    if (file.startsWith('statepoint') && file.endsWith('.h5')) {
                        outputFiles.push(path.join(dir, file));
                    }
                    // Check for summary file
                    else if (file === 'summary.h5') {
                        outputFiles.push(path.join(dir, file));
                    }
                    // Check for source file
                    else if (file === 'source.h5') {
                        outputFiles.push(path.join(dir, file));
                    }
                    // Check for tally output
                    else if (file.startsWith('tally') && file.endsWith('.out')) {
                        outputFiles.push(path.join(dir, file));
                    }
                    // Check for depletion results
                    else if (file === 'depletion_results.h5') {
                        outputFiles.push(path.join(dir, file));
                    }
                    // Check for depletion summary
                    else if (file === 'depletion_summary.json') {
                        outputFiles.push(path.join(dir, file));
                    }
                    // Check for OpenMC simulation output (from depletion)
                    else if (file === 'openmc_simulation.h5') {
                        outputFiles.push(path.join(dir, file));
                    }
                    // Check for weight windows output
                    else if (file === 'weight_windows.h5') {
                        outputFiles.push(path.join(dir, file));
                    }
                }

                // Track files are moved into a tracks/ subfolder; surface them too
                const tracksDir = path.join(dir, 'tracks');
                try {
                    const trackFiles = await fs.promises.readdir(tracksDir);
                    for (const file of trackFiles) {
                        if (file === 'tracks.h5' || /^tracks_p\d+\.h5$/.test(file)) {
                            outputFiles.push(path.join(tracksDir, file));
                        }
                    }
                } catch {
                    // tracks/ does not exist or is unreadable
                }

                // Lost-particle restart files are moved into a particles/ subfolder
                const particlesDir = path.join(dir, 'particles');
                try {
                    const particleFiles = await fs.promises.readdir(particlesDir);
                    for (const file of particleFiles) {
                        if (/^particle_\d+_\d+\.h5$/.test(file)) {
                            outputFiles.push(path.join(particlesDir, file));
                        }
                    }
                } catch {
                    // particles/ does not exist or is unreadable
                }
            } catch (error) {
                this.log(`Error detecting output files in ${dir}: ${error}`);
            }
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

    // ============================================================================
    // Volume Calculation & Native Plotting
    // ============================================================================

    /**
     * Run a stochastic volume calculation via python/run_volume_calc.py (blocking).
     * @param request - Volume calculation request
     * @returns Volume calculation result with per-domain volumes
     */
    async runVolumeCalculation(request: VolumeCalculationRequest): Promise<VolumeCalculationResult> {
        this.log(`Running volume calculation in ${request.workingDirectory}`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'run_volume_calc.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: run_volume_calc.py' };
        }

        const args: string[] = [
            scriptPath,
            request.workingDirectory,
            '--domain-type',
            request.domainType,
            '--domain-ids',
            request.domainIds.join(','),
            '--samples',
            String(request.samples)
        ];
        if (request.lowerLeft) {
            // Equals form: values start with '-', which argparse would
            // otherwise misread as an option flag
            args.push(`--lower-left=${request.lowerLeft.join(',')}`);
        }
        if (request.upperRight) {
            args.push(`--upper-right=${request.upperRight.join(',')}`);
        }
        if (request.triggerType) {
            args.push('--trigger-type', request.triggerType);
            if (request.triggerThreshold !== undefined) {
                args.push('--trigger-threshold', String(request.triggerThreshold));
            }
        }

        return this.executePythonScriptJson<VolumeCalculationResult>(args, request.workingDirectory);
    }

    /**
     * Generate native OpenMC plots via python/generate_plots.py (blocking).
     * @param request - Plot generation request with plot configurations
     * @returns Plot generation result with generated file paths
     */
    async generatePlots(request: PlotGenerationRequest): Promise<PlotGenerationResult> {
        this.log(`Generating ${request.plots.length} plot(s) in ${request.workingDirectory}`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'generate_plots.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: generate_plots.py' };
        }

        // Write plot configurations to a JSON file in the working directory
        const configPath = path.join(request.workingDirectory, '.nuke-plots-config.json');
        try {
            fs.writeFileSync(configPath, JSON.stringify(request.plots, null, 2));
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to write plot configuration: ${msg}` };
        }

        const args: string[] = [scriptPath, request.workingDirectory, '--plots-config', configPath];
        if (request.convertVoxelToVtk) {
            args.push('--convert-vtk');
        }

        return this.executePythonScriptJson<PlotGenerationResult>(args, request.workingDirectory);
    }

    /**
     * Import a material composition from an NCrystal configuration string via
     * python/ncrystal_import.py (blocking one-shot job).
     * @param cfg - NCrystal configuration string, e.g. `Al_sg225.ncmat;temp=300K`
     * @returns The imported material composition
     */
    async importNCrystalMaterial(cfg: string): Promise<NCrystalImportResult> {
        this.log(`Importing NCrystal material: ${cfg}`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'ncrystal_import.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: ncrystal_import.py' };
        }

        return this.executePythonScriptJson<NCrystalImportResult>([scriptPath, cfg], process.cwd());
    }

    /**
     * Generate an MGXS library via python/generate_mgxs.py (blocking).
     * @param request - MGXS generation configuration
     * @returns The generated library path
     */
    async generateMgxs(request: MgxsGenerationRequest): Promise<MgxsGenerationResult> {
        this.log(`Generating MGXS library in ${request.workingDirectory} (method=${request.method}, groups=${request.groups})`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'generate_mgxs.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: generate_mgxs.py' };
        }

        const args: string[] = [scriptPath, request.workingDirectory, '--method', request.method, '--groups', request.groups];
        if (request.particles) {
            args.push('--particles', String(request.particles));
        }
        if (request.correction) {
            args.push('--correction', request.correction);
        }
        if (request.temperatures && request.temperatures.length > 0) {
            args.push('--temperatures', request.temperatures.join(','));
        }
        if (request.output) {
            args.push('--output', request.output);
        }
        if (request.randomRay) {
            args.push('--random-ray');
        }

        return this.executePythonScriptJson<MgxsGenerationResult>(args, request.workingDirectory);
    }

    /**
     * Convert a CE project to multi-group via python/convert_to_multigroup_project.py:
     * MGXS generation (reusing generate_mgxs) plus the material/XS-data mapping.
     * @param request - Conversion configuration
     * @returns The library path and material mapping
     */
    async convertToMultigroupProject(request: MgConversionRequest): Promise<MgConversionResult> {
        this.log(`Converting project to multi-group in ${request.workingDirectory}`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'convert_to_multigroup_project.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: convert_to_multigroup_project.py' };
        }

        const args: string[] = [scriptPath, request.workingDirectory];
        if (request.method) {
            args.push('--method', request.method);
        }
        if (request.groups) {
            args.push('--groups', request.groups);
        }
        if (request.particles) {
            args.push('--particles', String(request.particles));
        }
        if (request.output) {
            args.push('--output', request.output);
        }

        return this.executePythonScriptJson<MgConversionResult>(args, request.workingDirectory);
    }

    /**
     * Read the material/XS-data mapping from an existing MGXS library.
     * @param mgxsPath - Path to the MGXS library HDF5 file
     * @returns Result with the list of material-name / XS-data-name mappings
     */
    async getMgxsDataNames(mgxsPath: string): Promise<MgxsDataNamesResult> {
        this.log(`Reading MGXS data names from ${mgxsPath}`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'read_mgxs_data_names.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: read_mgxs_data_names.py' };
        }

        return this.executePythonScriptJson<MgxsDataNamesResult>([scriptPath, mgxsPath], path.dirname(scriptPath));
    }

    /**
     * Generate a fine-grained MGXS library via python/generate_mgxs_library.py.
     * @param request - Library generation configuration
     * @returns The generated library path and configuration summary
     */
    async generateMgxsLibrary(request: MgxsLibraryGenerationRequest): Promise<MgxsLibraryGenerationResult> {
        this.log(`Generating fine-grained MGXS library in ${request.workingDirectory}`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'generate_mgxs_library.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: generate_mgxs_library.py' };
        }

        const args: string[] = [scriptPath, request.workingDirectory];
        if (request.groups) {
            args.push('--groups', request.groups);
        }
        if (request.mgxsTypes && request.mgxsTypes.length > 0) {
            args.push('--mgxs-types', request.mgxsTypes.join(','));
        }
        if (request.domainType) {
            args.push('--domain-type', request.domainType);
        }
        if (request.domainIds && request.domainIds.length > 0) {
            args.push('--domain-ids', request.domainIds.join(','));
        }
        if (request.byNuclide) {
            args.push('--by-nuclide');
        }
        if (request.legendreOrder !== undefined) {
            args.push('--legendre-order', String(request.legendreOrder));
        }
        if (request.estimator) {
            args.push('--estimator', request.estimator);
        }
        if (request.correction) {
            args.push('--correction', request.correction);
        }
        if (request.particles) {
            args.push('--particles', String(request.particles));
        }
        if (request.output) {
            args.push('--output', request.output);
        }

        return this.executePythonScriptJson<MgxsLibraryGenerationResult>(args, request.workingDirectory);
    }

    /**
     * Build a custom depletion chain via python/build_chain.py (blocking).
     * @param request - Chain build configuration (subset or ENDF mode)
     * @returns The build result with the output chain path
     */
    async buildChain(request: ChainBuildRequest): Promise<ChainBuildResult> {
        this.log(`Building depletion chain (mode=${request.fromChain ? 'subset' : 'endf'}) → ${request.output}`);

        const scriptPath = resolvePythonScript({ packageName: 'openmc-studio', scriptName: 'build_chain.py' });
        if (!scriptPath) {
            return { success: false, error: 'Python script not found: build_chain.py' };
        }

        const args: string[] = [scriptPath, '--output', request.output];
        if (request.fromChain) {
            args.push('--from-chain', request.fromChain);
        }
        if (request.fromEndf) {
            args.push('--from-endf', request.fromEndf);
        }
        if (request.nuclides && request.nuclides.length > 0) {
            args.push('--nuclides', request.nuclides.join(','));
        }

        return this.executePythonScriptJson<ChainBuildResult>(args, process.cwd());
    }

    /**
     * Execute a Python script that streams progress on stderr and prints one
     * final JSON object on stdout, and parse the result.
     * @param args - Full argument vector (script path first)
     * @param cwd - Working directory for the spawned process
     * @returns The parsed JSON result
     */
    private async executePythonScriptJson<T extends { success: boolean; error?: string; output?: string }>(
        args: string[],
        cwd: string
    ): Promise<T> {
        const { spawn } = await import('child_process');

        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        this.log(`Using Python: ${pythonCommand}${pythonInfo.version ? ` (${pythonInfo.version})` : ''}`);

        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) ? currentPath : `${pythonBinDir}:${currentPath}`;

        return new Promise<T>((resolve) => {
            const childProcess = spawn(pythonCommand, args, {
                cwd,
                env: { ...process.env, PATH: newPath },
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            childProcess.stdout?.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                // Stream progress lines to the client log
                this.safeLog(chunk);
            });

            childProcess.on('error', (error) => {
                resolve({ success: false, error: `Failed to start Python: ${error.message}`, output: stderr } as T);
            });

            childProcess.on('close', (code) => {
                // Scan stdout BACKWARDS for the last line that parses as a JSON
                // object — the model run inside scripts (e.g. generate_mgxs)
                // inherits stdout, so openmc's own log lines can follow the JSON
                const lines = stdout.trim().split('\n');
                for (let i = lines.length - 1; i >= 0; i--) {
                    const candidate = lines[i].trim();
                    if (!candidate.startsWith('{')) {
                        continue;
                    }
                    try {
                        const result = JSON.parse(candidate) as T;
                        result.output = result.output ?? stderr;
                        if (code !== 0 && result.success !== false) {
                            result.success = false;
                            result.error = result.error || `Process exited with code ${code}`;
                        }
                        resolve(result);
                        return;
                    } catch {
                        // Not a JSON line — keep scanning backwards
                    }
                }
                // No JSON anywhere: surface the real cause (traceback / openmc
                // error) instead of a random log line
                const detail = stderr.trim() || stdout.trim();
                resolve({
                    success: false,
                    error: `Script exited with code ${code}${detail ? `: ${detail.slice(-500)}` : ''}`,
                    output: stderr
                } as T);
            });
        });
    }
}
