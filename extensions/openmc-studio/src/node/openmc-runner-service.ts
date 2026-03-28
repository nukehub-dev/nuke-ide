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
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';

interface RunningSimulation {
    processId: string;
    process: any; // ChildProcess type
    startTime: Date;
    request: SimulationRunRequest;
}

@injectable()
export class OpenMCRunnerService {
    
    @inject(ProcessManager)
    protected readonly processManager: ProcessManager;

    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    private runningSimulations = new Map<string, RunningSimulation>();
    private client?: OpenMCStudioClient;

    /**
     * Set the client for progress notifications.
     */
    setClient(client: OpenMCStudioClient): void {
        this.client = client;
    }

    /**
     * Set Python configuration.
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
    // Python Environment Detection (aligned with nuke-visualizer)
    // ============================================================================

    /**
     * Detect Python command to use based on configuration.
     * Also verifies that OpenMC is available in the detected Python.
     */
    protected async detectPythonCommand(): Promise<{ command: string; warning?: string; version?: string }> {
        // Use nuke-core's Python detection with OpenMC requirements
        // If this succeeds, OpenMC is guaranteed to be available
        const detectionResult = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: [
                { name: 'openmc' }
            ],
            autoDetectEnvs: ['openmc', 'nuke-ide', 'visualizer', 'trame']
        });
        
        if (!detectionResult.success || !detectionResult.command) {
            throw new Error(detectionResult.error || 'Failed to detect Python with OpenMC. Configure Python in Settings → Nuke.');
        }
        
        // Try to get OpenMC version (best effort - we know it's there from the detection)
        let version: string | undefined;
        try {
            const depCheck = await this.nukeCoreService.checkDependencies(
                [{ name: 'openmc' }],
                detectionResult.command
            );
            version = depCheck.versions['openmc'];
        } catch {
            // Version check failed but OpenMC is available (validated by detectPythonWithRequirements)
        }
        
        return {
            command: detectionResult.command,
            version,
            warning: detectionResult.warning
        };
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
        
        // Last resort: assume it's in the same directory as Python
        this.log(`Warning: Could not find openmc executable, assuming it's in: ${openmcInSameDir}`);
        return openmcInSameDir;
    }

    // ============================================================================
    // OpenMC Availability Check
    // ============================================================================

    /**
     * Check if OpenMC is available.
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
        const depCheck = await this.nukeCoreService.checkDependencies(
            [{ name: 'openmc' }],
            pythonCommand
        );
        
        if (!depCheck.available) {
            return {
                available: false,
                error: `OpenMC not installed in ${pythonCommand}. Run: pip install openmc`
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
