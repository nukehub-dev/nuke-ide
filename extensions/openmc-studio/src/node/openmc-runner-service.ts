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

    private client?: OpenMCStudioClient;
    private runningSimulations = new Map<string, RunningSimulation>();
    private pythonConfig: PythonConfig = {};

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
     * Log a message to the client.
     */
    protected log(message: string): void {
        console.log(`[OpenMC Runner] ${message}`);
        this.client?.log(message);
    }

    // ============================================================================
    // Python Environment Detection (aligned with nuke-visualizer)
    // ============================================================================

    /**
     * Detect Python command to use based on configuration.
     */
    protected async detectPythonCommand(): Promise<{ command: string; warning?: string }> {
        // 1. Try explicitly configured Python path first
        if (this.pythonConfig.pythonPath) {
            return { command: this.pythonConfig.pythonPath };
        }

        // 2. Try conda environment
        if (this.pythonConfig.condaEnv) {
            const condaPython = await this.findCondaPython(this.pythonConfig.condaEnv);
            if (condaPython) {
                return { command: condaPython };
            }
        }

        // 3. Try to detect conda environment with 'openmc' name
        const openmcCondaPython = await this.findCondaPython('openmc');
        if (openmcCondaPython) {
            return { 
                command: openmcCondaPython,
                warning: `Using auto-detected conda environment 'openmc'. Configure 'nukeVisualizer.condaEnv' to use a specific environment.`
            };
        }

        // 4. Try 'python' in PATH
        try {
            const { execSync } = await import('child_process');
            execSync('python --version', { stdio: 'ignore' });
            return { 
                command: 'python',
                warning: `Using system Python. For better results, configure 'nukeVisualizer.pythonPath' or 'nukeVisualizer.condaEnv'.`
            };
        } catch {
            // 5. Try 'python3' in PATH
            try {
                const { execSync } = await import('child_process');
                execSync('python3 --version', { stdio: 'ignore' });
                return { 
                    command: 'python3',
                    warning: `Using system Python. For better results, configure 'nukeVisualizer.pythonPath' or 'nukeVisualizer.condaEnv'.`
                };
            } catch {
                throw new Error('Could not find Python. Please configure nukeVisualizer.pythonPath or nukeVisualizer.condaEnv in preferences.');
            }
        }
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
            try {
                const output = execSync(
                    `"${pythonCommand}" -c "import openmc; print(openmc.__version__)"`,
                    { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] }
                ).trim();
                
                return {
                    available: true,
                    version: output,
                    path: pythonCommand,
                    error: pythonInfo.warning
                };
            } catch {
                return {
                    available: false,
                    error: `OpenMC Python module not found in ${pythonCommand}. Install with: pip install openmc`,
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
        const pythonInfo = await this.detectPythonCommand();
        const pythonCommand = pythonInfo.command;
        
        // Build command
        let command: string;
        let args: string[];
        
        if (request.mpi?.enabled && request.mpi.processes && request.mpi.processes > 1) {
            command = 'mpirun';
            args = ['-np', String(request.mpi.processes), pythonCommand, '-m', 'openmc'];
        } else {
            command = pythonCommand;
            args = ['-m', 'openmc'];
        }
        
        // Add any additional arguments
        if (request.args) {
            args.push(...request.args);
        }
        
        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
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
                this.parseProgress(chunk);
            });
            
            // Handle stderr
            childProcess.stderr?.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderr += chunk;
            });
            
            // Handle process exit
            childProcess.on('close', (code: number | null) => {
                this.runningSimulations.delete(processId);
                
                const endTime = new Date();
                const duration = (endTime.getTime() - startTime.getTime()) / 1000;
                
                // Get output files
                const outputFiles = this.detectOutputFiles(request.workingDirectory);
                
                resolve({
                    success: code === 0,
                    exitCode: code ?? undefined,
                    stdout,
                    stderr,
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
            
            // Notify client
            this.client?.onProgress(progress);
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
