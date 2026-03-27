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

/**
 * OpenMC Runner Service
 * 
 * Backend service for running OpenMC simulations using Python.
 * Aligns with nuke-visualizer's approach of using Python directly.
 * 
 * @module openmc-studio/node
 */

import { injectable, inject } from '@theia/core/shared/inversify';
import { ProcessManager } from '@theia/process/lib/node';

import {
    SimulationRunRequest,
    SimulationRunResult,
    SimulationProgress,
    OpenMCStudioClient
} from '../common/openmc-studio-protocol';

interface RunningSimulation {
    processId: string;
    process: any; // ChildProcess type
    startTime: Date;
    request: SimulationRunRequest;
}

export interface PythonConfig {
    pythonPath?: string;
    condaEnv?: string;
}

@injectable()
export class OpenMCRunnerService {
    
    @inject(ProcessManager)
    protected readonly processManager: ProcessManager;

    private runningSimulations = new Map<string, RunningSimulation>();
    private pythonConfig: PythonConfig = {};
    private client?: OpenMCStudioClient;

    /**
     * Set the client for progress notifications.
     */
    setClient(client: OpenMCStudioClient): void {
        this.client = client;
    }

    /**
     * Set Python configuration (shared with nuke-visualizer).
     */
    async setPythonConfig(config: PythonConfig): Promise<void> {
        this.pythonConfig = config;
        console.log(`[OpenMC Runner] Python config updated: ${JSON.stringify(config)}`);
    }

    /**
     * Log a message to the console (client logging disabled to prevent disconnect errors).
     */
    protected log(message: string): void {
        console.log(`[OpenMC Runner] ${message}`);
    }

    // ============================================================================
    // Python Environment Detection (aligned with nuke-visualizer)
    // ============================================================================

    /**
     * Detect Python command to use based on configuration.
     * Also verifies that OpenMC is available in the detected Python.
     */
    protected async detectPythonCommand(): Promise<{ command: string; warning?: string; version?: string }> {
        // 1. Try explicitly configured Python path first
        if (this.pythonConfig.pythonPath) {
            this.log(`Using configured Python: ${this.pythonConfig.pythonPath}`);
            const version = await this.getPythonVersion(this.pythonConfig.pythonPath);
            const openmcCheck = await this.checkOpenMCInPython(this.pythonConfig.pythonPath);
            if (!openmcCheck.available) {
                throw new Error(`Configured Python does not have OpenMC installed. ${openmcCheck.error}\nPath: ${this.pythonConfig.pythonPath}`);
            }
            return { command: this.pythonConfig.pythonPath, version };
        }

        // 2. Try conda environment
        if (this.pythonConfig.condaEnv) {
            this.log(`Looking for conda environment: ${this.pythonConfig.condaEnv}`);
            const condaPython = await this.findCondaPython(this.pythonConfig.condaEnv);
            if (condaPython) {
                this.log(`Found conda Python: ${condaPython}`);
                const version = await this.getPythonVersion(condaPython);
                const openmcCheck = await this.checkOpenMCInPython(condaPython);
                if (!openmcCheck.available) {
                    throw new Error(
                        `Conda environment '${this.pythonConfig.condaEnv}' does not have OpenMC installed.\n` +
                        `${openmcCheck.error}\n` +
                        `Activate the environment and install: conda activate ${this.pythonConfig.condaEnv} && pip install openmc`
                    );
                }
                return { command: condaPython, version };
            }
            throw new Error(
                `Conda environment '${this.pythonConfig.condaEnv}' not found.\n` +
                `Available environments can be listed with: conda env list`
            );
        }

        // 3. Try to detect conda environment with 'openmc' name
        this.log(`Looking for auto-detected 'openmc' conda environment...`);
        const openmcCondaPython = await this.findCondaPython('openmc');
        if (openmcCondaPython) {
            this.log(`Found conda environment 'openmc': ${openmcCondaPython}`);
            const version = await this.getPythonVersion(openmcCondaPython);
            const openmcCheck = await this.checkOpenMCInPython(openmcCondaPython);
            if (openmcCheck.available) {
                return { 
                    command: openmcCondaPython,
                    version,
                    warning: `Using auto-detected conda environment 'openmc'. Configure 'nukeVisualizer.condaEnv' to use a specific environment.`
                };
            }
        }

        // 4. Try 'python' in PATH
        this.log(`Trying system Python...`);
        try {
            const { execSync } = await import('child_process');
            execSync('python --version', { stdio: 'ignore' });
            const version = await this.getPythonVersion('python');
            const openmcCheck = await this.checkOpenMCInPython('python');
            if (openmcCheck.available) {
                return { 
                    command: 'python',
                    version,
                    warning: `Using system Python with OpenMC. For better control, configure 'nukeVisualizer.pythonPath' or 'nukeVisualizer.condaEnv'.`
                };
            }
            this.log(`System Python found but OpenMC not available: ${openmcCheck.error}`);
        } catch {
            // python not available
        }
        
        // 5. Try 'python3' in PATH
        try {
            const { execSync } = await import('child_process');
            execSync('python3 --version', { stdio: 'ignore' });
            const version = await this.getPythonVersion('python3');
            const openmcCheck = await this.checkOpenMCInPython('python3');
            if (openmcCheck.available) {
                return { 
                    command: 'python3',
                    version,
                    warning: `Using system Python with OpenMC. For better control, configure 'nukeVisualizer.pythonPath' or 'nukeVisualizer.condaEnv'.`
                };
            }
            this.log(`Python3 found but OpenMC not available: ${openmcCheck.error}`);
        } catch {
            // python3 not available
        }
        
        // None worked - provide helpful error
        throw new Error(
            'Could not find Python with OpenMC installed.\n\n' +
            'Options to fix:\n' +
            '1. Install OpenMC in current Python: pip install openmc\n' +
            '2. Create conda environment: conda create -n openmc python=3.10 openmc\n' +
            '3. Set Python path in preferences: nukeVisualizer.pythonPath\n' +
            '4. Set conda environment in preferences: nukeVisualizer.condaEnv'
        );
    }

    /**
     * Get Python version string.
     */
    protected async getPythonVersion(pythonPath: string): Promise<string | undefined> {
        try {
            const { execSync } = await import('child_process');
            return execSync(`"${pythonPath}" --version`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
        } catch {
            return undefined;
        }
    }

    /**
     * Check if OpenMC is available in the given Python.
     */
    protected async checkOpenMCInPython(pythonPath: string): Promise<{ available: boolean; version?: string; error?: string }> {
        try {
            const { execSync } = await import('child_process');
            const version = execSync(
                `"${pythonPath}" -c "import openmc; print(openmc.__version__)"`,
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
            ).trim();
            return { available: true, version };
        } catch {
            return { available: false, error: 'OpenMC module not found' };
        }
    }

    /**
     * Find the OpenMC executable corresponding to the given Python.
     * The openmc executable should be in the same bin directory as Python.
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
        
        // Fallback: try to find via 'which' or 'where'
        try {
            const { execSync } = await import('child_process');
            const whichCmd = isWindows ? 'where' : 'which';
            const openmcPath = execSync(`${whichCmd} ${openmcName}`, { 
                encoding: 'utf-8', 
                stdio: ['pipe', 'pipe', 'ignore'] 
            }).trim().split('\n')[0];
            if (openmcPath && fs.existsSync(openmcPath)) {
                return openmcPath;
            }
        } catch {
            // Not found in PATH
        }
        
        // Last resort: assume it's in the same directory as Python
        this.log(`Warning: Could not find openmc executable, assuming it's in: ${openmcInSameDir}`);
        return openmcInSameDir;
    }

    /**
     * Find Python in a conda environment.
     */
    protected async findCondaPython(envName: string): Promise<string | undefined> {
        try {
            const { execSync } = await import('child_process');
            
            // Get conda base path
            const condaBase = execSync('conda info --base', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
            
            // Construct path to Python in the environment
            const isWindows = process.platform === 'win32';
            const pythonPath = isWindows
                ? `${condaBase}/envs/${envName}/python.exe`
                : `${condaBase}/envs/${envName}/bin/python`;
            
            // Check if it exists
            const { existsSync } = await import('fs');
            if (existsSync(pythonPath)) {
                return pythonPath;
            }
        } catch {
            // Conda not available or environment not found
        }
        return undefined;
    }

    // ============================================================================
    // OpenMC Availability Check
    // ============================================================================

    async checkOpenMC(): Promise<{ available: boolean; version?: string; path?: string; error?: string }> {
        try {
            const pythonInfo = await this.detectPythonCommand();
            const pythonCommand = pythonInfo.command;
            const { execSync } = await import('child_process');
            
            // Check for openmc module in Python
            let version: string;
            try {
                version = execSync(
                    `"${pythonCommand}" -c "import openmc; print(openmc.__version__)"`,
                    { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }
                ).trim();
            } catch {
                return {
                    available: false,
                    error: `OpenMC Python module not found in ${pythonCommand}. Install with: pip install openmc`,
                    path: pythonCommand
                };
            }
            
            // Also verify the openmc executable exists
            try {
                const openmcExe = await this.findOpenMCExecutable(pythonCommand);
                // Test the executable
                execSync(`"${openmcExe}" --version`, { 
                    encoding: 'utf-8', 
                    timeout: 5000, 
                    stdio: ['pipe', 'pipe', 'ignore'] 
                });
                
                return {
                    available: true,
                    version,
                    path: openmcExe,
                    error: pythonInfo.warning
                };
            } catch {
                return {
                    available: false,
                    error: `OpenMC Python module found (${version}) but 'openmc' executable not found. Try reinstalling: pip install --force-reinstall openmc`,
                    path: pythonCommand
                };
            }
            
        } catch (error) {
            return {
                available: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

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
        const path = await import('path');
        const pythonBinDir = path.dirname(pythonCommand);
        const currentPath = process.env.PATH || '';
        const newPath = currentPath.includes(pythonBinDir) 
            ? currentPath 
            : `${pythonBinDir}:${currentPath}`;
        
        this.log(`Environment PATH includes: ${pythonBinDir}`);
        
        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
                PATH: newPath,
                ...request.env
            };
            
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
                request
            });
            
            // Handle stdout
            childProcess.stdout?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdout += chunk;
                // Stream output to client for real-time feedback in frontend
                this.client?.log(chunk);
                this.parseProgress(chunk);
            });
            
            // Handle stderr
            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
                // Stream errors to client for real-time feedback in frontend
                this.client?.warn(chunk);
            });
            
            // Handle process exit
            childProcess.on('close', (code: number | null) => {
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
                this.runningSimulations.delete(processId);
                reject(error);
            });
        });
    }

    async cancelSimulation(processId: string): Promise<boolean> {
        const simulation = this.runningSimulations.get(processId);
        
        if (!simulation) {
            return false;
        }
        
        try {
            simulation.process.kill('SIGTERM');
            
            // Force kill after 5 seconds if still running
            setTimeout(() => {
                if (!simulation.process.killed) {
                    simulation.process.kill('SIGKILL');
                }
            }, 5000);
            
            return true;
        } catch (error) {
            this.log(`Error cancelling simulation: ${error}`);
            return false;
        }
    }

    /**
     * Parse progress information from OpenMC output.
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
     */
    private detectOutputFiles(workingDirectory: string): string[] {
        const fs = require('fs');
        const path = require('path');
        
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
            }
        } catch (error) {
            this.log(`Error detecting output files: ${error}`);
        }
        
        return outputFiles;
    }

    /**
     * Cleanup on shutdown.
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
