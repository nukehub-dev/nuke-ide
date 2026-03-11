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
import { VisualizerBackendService, PythonConfig } from '../common/visualizer-protocol';

@injectable()
export class VisualizerBackendServiceImpl implements VisualizerBackendService {
    private processes: Map<number, RawProcess> = new Map();

    @inject(RawProcessFactory)
    protected readonly rawProcessFactory: RawProcessFactory;

    async startServer(filePath?: string, config?: PythonConfig): Promise<{ port: number; url: string; warning?: string }> {
        // Kill any existing processes first to prevent accumulation
        await this.killAllProcesses();
        
        const port = await this.findFreePort(8080);
        
        // Find the Python script
        const pythonScript = this.findPythonScript();
        
        // Detect Python command with both visualizer AND ParaView
        const pythonInfo = await this.detectPythonCommand(config);
        const warning = pythonInfo.warning;
        if (warning) {
            console.log(`[VisualizerBackend] Warning: ${warning}`);
        }
        
        const args: string[] = [pythonScript, '--port', port.toString()];
        if (filePath) {
            args.push('--file', filePath);
        }

        const processOptions: RawProcessOptions = {
            command: pythonInfo.command,
            args,
        };

        console.log(`[VisualizerBackend] Starting server: ${pythonInfo.command} ${args.join(' ')}`);
        if (pythonInfo.description) {
            console.log(`[VisualizerBackend] Using: ${pythonInfo.description}`);
        }

        const process = this.rawProcessFactory(processOptions);
        
        // Collect stdout and stderr for error reporting
        const stdoutLines: string[] = [];
        const stderrLines: string[] = [];
        
        process.outputStream.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            stdoutLines.push(line);
            console.log(`[Visualizer ${port}] ${line}`);
        });

        process.errorStream.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            stderrLines.push(line);
            console.error(`[Visualizer ${port}] ERROR: ${line}`);
        });

        process.onExit((event: { code?: number; signal?: string }) => {
            console.log(`[Visualizer ${port}] Process exited with code ${event.code}, signal: ${event.signal}`);
            this.processes.delete(port);
        });

        this.processes.set(port, process);

        // Wait for server to be ready or process to exit
        const serverReady = new Promise<{ port: number; url: string; warning?: string }>((resolve, reject) => {
            // Timeout after 30 seconds
            const timeout = setTimeout(() => {
                clearInterval(portCheckInterval);
                process.outputStream.removeListener('data', successListener);
                exitListenerDisposable.dispose();
                reject(new Error(`Server startup timeout after 30 seconds.\n\nStdout:\n${stdoutLines.slice(-20).join('\n')}\n\nStderr:\n${stderrLines.slice(-20).join('\n')}`));
            }, 30000);

            // Check for success message in stdout
            const successListener = (data: Buffer) => {
                const line = data.toString().trim();
                console.log(`[VisualizerBackend ${port}] stdout: ${line}`);
                if (line.includes('Starting visualizer server on')) {
                    console.log(`[VisualizerBackend ${port}] Detected success message, resolving promise`);
                    clearTimeout(timeout);
                    process.outputStream.removeListener('data', successListener);
                    resolve({ port, url: `http://127.0.0.1:${port}`, warning });
                }
            };
            process.outputStream.on('data', successListener);

            // Monitor process exit
            const exitListener = (event: { code?: number; signal?: string }) => {
                clearTimeout(timeout);
                process.outputStream.removeListener('data', successListener);
                clearInterval(portCheckInterval);
                exitListenerDisposable.dispose();
                if (event.code !== 0) {
                    reject(new Error(`Process exited with code ${event.code}.\n\nStdout:\n${stdoutLines.slice(-20).join('\n')}\n\nStderr:\n${stderrLines.slice(-20).join('\n')}`));
                } else {
                    // Process exited cleanly but before success message? Should not happen.
                    reject(new Error(`Process exited unexpectedly with code 0.\n\nStdout:\n${stdoutLines.slice(-20).join('\n')}\n\nStderr:\n${stderrLines.slice(-20).join('\n')}`));
                }
            };
            const exitListenerDisposable = process.onExit(exitListener);

            // Also periodically check if port is listening as a fallback
            const portCheckInterval = setInterval(() => {
                console.log(`[VisualizerBackend ${port}] Port check attempt`);
                const socket = new net.Socket();
                socket.on('error', () => {
                    socket.destroy();
                });
                socket.on('connect', () => {
                    console.log(`[VisualizerBackend ${port}] Port connect successful, server is listening`);
                    socket.destroy();
                    clearTimeout(timeout);
                    clearInterval(portCheckInterval);
                    process.outputStream.removeListener('data', successListener);
                    exitListenerDisposable.dispose();
                    resolve({ port, url: `http://127.0.0.1:${port}`, warning });
                });
                socket.connect(port, '127.0.0.1');
            }, 1000);

        });

        try {
            const result = await serverReady;
            console.log(`[VisualizerBackend ${port}] Server ready, returning result`);
            return result;
        } catch (error) {
            console.error(`[VisualizerBackend ${port}] Server ready promise rejected:`, error);
            // Ensure process is killed on error
            process.kill();
            this.processes.delete(port);
            throw error;
        }
    }

    async stopServer(port: number): Promise<void> {
        console.log(`[VisualizerBackend] Stopping server on port ${port}`);
        const process = this.processes.get(port);
        if (process) {
            // Try graceful kill first
            process.kill();
            
            // Force kill after 2 seconds if still running
            setTimeout(() => {
                try {
                    if (process.pid) {
                        process.kill();
                        console.log(`[VisualizerBackend] Force killed process ${process.pid}`);
                    }
                } catch (e) {
                    // Process already dead
                }
            }, 2000);
            
            this.processes.delete(port);
        }
    }

    private async killAllProcesses(): Promise<void> {
        console.log(`[VisualizerBackend] Cleaning up ${this.processes.size} existing processes`);
        const ports = Array.from(this.processes.keys());
        for (const port of ports) {
            await this.stopServer(port);
        }
        // Wait a moment for processes to die
        await this.delay(500);
    }

    private async detectPythonCommand(config?: PythonConfig): Promise<{ command: string; env?: NodeJS.ProcessEnv; description?: string; warning?: string }> {
        const errors: string[] = [];
        const warnings: string[] = [];
        
        // Helper to test Python and collect missing dependencies
        const testAndCollect = (pythonPath: string, context: string): { success: boolean; missing: string[] } => {
            const result = this.testPythonWithDetails(pythonPath);
            if (!result.success) {
                errors.push(`${context}: Python at ${pythonPath} missing ${result.missing.join(' and ')}`);
            }
            return result;
        };
        
        // 1. Check config.pythonPath first (user preference)
        if (config?.pythonPath) {
            if (fs.existsSync(config.pythonPath)) {
                const stat = fs.statSync(config.pythonPath);
                if (stat.isDirectory()) {
                    const msg = `Configured Python path is a directory, not an executable: ${config.pythonPath}`;
                    errors.push(msg);
                    warnings.push(msg);
                    console.log(`[VisualizerBackend] Configured python is a directory, skipping: ${config.pythonPath}`);
                } else {
                    console.log(`[VisualizerBackend] Testing configured python: ${config.pythonPath}`);
                    const result = testAndCollect(config.pythonPath, 'Configured python');
                    if (result.success) {
                        console.log(`[VisualizerBackend] Using configured python: ${config.pythonPath}`);
                        return { 
                            command: config.pythonPath, 
                            description: 'user configured pythonPath',
                            warning: warnings.length > 0 ? warnings.join(' ') : undefined
                        };
                    } else {
                        console.log(`[VisualizerBackend] Configured python exists but missing dependencies`);
                        warnings.push(`Configured Python at ${config.pythonPath} is missing required dependencies. Using fallback.`);
                    }
                }
            } else {
                const msg = `Configured Python path does not exist: ${config.pythonPath}`;
                errors.push(msg);
                warnings.push(msg);
                console.log(`[VisualizerBackend] Configured python path does not exist: ${config.pythonPath}`);
            }
        }
        
        // 2. Check config.condaEnv (user preference for conda env name)
        if (config?.condaEnv) {
            const condaPython = this.findCondaPython(config.condaEnv);
            if (condaPython) {
                console.log(`[VisualizerBackend] Testing conda env '${config.condaEnv}': ${condaPython}`);
                const result = testAndCollect(condaPython, `Conda env '${config.condaEnv}'`);
                if (result.success) {
                    console.log(`[VisualizerBackend] Using conda env '${config.condaEnv}': ${condaPython}`);
                    return { 
                        command: condaPython, 
                        description: `conda env (${config.condaEnv})`,
                        warning: warnings.length > 0 ? warnings.join(' ') : undefined
                    };
                }
            } else {
                errors.push(`Conda environment '${config.condaEnv}' not found`);
            }
        }
        
        // 3. Check CONDA_PREFIX env var (if shell has activated conda)
        const condaPrefix = process.env.CONDA_PREFIX;
        if (condaPrefix) {
            const condaPython = path.join(condaPrefix, 'bin', 'python');
            if (fs.existsSync(condaPython)) {
                console.log(`[VisualizerBackend] Testing conda environment: ${condaPython}`);
                const result = testAndCollect(condaPython, `Active conda env '${path.basename(condaPrefix)}'`);
                if (result.success) {
                    console.log(`[VisualizerBackend] Using conda env: ${condaPython}`);
                    return { 
                        command: condaPython, 
                        description: `conda env (${path.basename(condaPrefix)})`,
                        warning: warnings.length > 0 ? warnings.join(' ') : undefined
                    };
                }
            }
        }
        
        // 4. Auto-detect common conda envs
        const commonCondaEnvs = ['visualizer', 'trame', 'paraview', 'pv'];
        for (const envName of commonCondaEnvs) {
            const condaPython = this.findCondaPython(envName);
            if (condaPython) {
                console.log(`[VisualizerBackend] Testing conda env '${envName}': ${condaPython}`);
                const result = testAndCollect(condaPython, `Auto-detected conda env '${envName}'`);
                if (result.success) {
                    console.log(`[VisualizerBackend] Found conda env '${envName}': ${condaPython}`);
                    return { 
                        command: condaPython, 
                        description: `conda env (${envName})`,
                        warning: warnings.length > 0 ? warnings.join(' ') : undefined
                    };
                }
            }
        }
        
        // 5. Check environment variable for Python path
        const envPythonPath = process.env.VISUALIZER_PYTHON_PATH;
        if (envPythonPath && fs.existsSync(envPythonPath)) {
            console.log(`[VisualizerBackend] Testing Python from env var: ${envPythonPath}`);
            const result = testAndCollect(envPythonPath, 'Environment variable VISUALIZER_PYTHON_PATH');
            if (result.success) {
                console.log(`[VisualizerBackend] Using Python from env var: ${envPythonPath}`);
                return { 
                    command: envPythonPath, 
                    description: 'from environment variable',
                    warning: warnings.length > 0 ? warnings.join(' ') : undefined
                };
            }
        }
        
        // 6. Try python3/python from system PATH
        const { execSync } = require('child_process');
        for (const cmd of ['python3', 'python']) {
            try {
                const cmdPath = execSync(`which ${cmd}`, { encoding: 'utf8' }).trim();
                if (cmdPath) {
                    console.log(`[VisualizerBackend] Testing ${cmd} from PATH: ${cmdPath}`);
                    const result = testAndCollect(cmdPath, `System ${cmd}`);
                    if (result.success) {
                        console.log(`[VisualizerBackend] Using ${cmd} from PATH: ${cmdPath}`);
                        return { 
                            command: cmdPath, 
                            description: `${cmd} (from PATH)`,
                            warning: warnings.length > 0 ? warnings.join(' ') : undefined
                        };
                    }
                }
            } catch {
                // not found
            }
        }
        
        // No suitable Python found
        const errorMessage = `Unable to find a Python interpreter with both visualizer and ParaView installed.\n\n` +
            `Please configure a Python path in Preferences → NukeVisualizer.\n\n` +
            `Details:\n${errors.map(e => '  • ' + e).join('\n')}`;
        throw new Error(errorMessage);
    }
    
    private findCondaPython(envName: string): string | undefined {
        const homeDir = os.homedir();
        const condaBasePaths = [
            path.join(homeDir, '.conda', 'envs'),
            path.join(homeDir, 'anaconda3', 'envs'),
            path.join(homeDir, 'miniconda3', 'envs'),
            '/opt/conda/envs',
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

    private testPythonWithDetails(pythonPath: string): { success: boolean; missing: string[] } {
        const { execSync } = require('child_process');
        const missing: string[] = [];
        try {
            execSync(`"${pythonPath}" -c "import trame"`, { stdio: 'ignore' });
        } catch {
            missing.push('trame (visualizer engine)');
        }
        try {
            execSync(`"${pythonPath}" -c "from paraview import simple"`, { stdio: 'ignore' });
        } catch {
            missing.push('paraview');
        }
        return { success: missing.length === 0, missing };
    }

    private findPythonScript(): string {
        const possiblePaths = [
            path.join(__dirname, '..', '..', 'python', 'visualizer_app.py'),
            path.join(__dirname, '..', '..', '..', 'nuke-visualizer', 'python', 'visualizer_app.py'),
            path.join(__dirname, '..', '..', '..', 'python', 'visualizer_app.py'),
            path.join(__dirname, '..', '..', '..', '..', 'python', 'visualizer_app.py'),
            path.join(__dirname, '..', '..', '..', '..', '..', 'python', 'visualizer_app.py'),
        ];

        for (const scriptPath of possiblePaths) {
            const normalizedPath = path.normalize(scriptPath);
            if (fs.existsSync(normalizedPath)) {
                console.log(`[VisualizerBackend] Found Python script at: ${normalizedPath}`);
                return normalizedPath;
            }
        }

        console.error(`[VisualizerBackend] Could not find visualizer_app.py`);
        return path.join(process.cwd(), 'python', 'visualizer_app.py');
    }

    private async findFreePort(startPort: number): Promise<number> {
        for (let port = startPort; port < startPort + 1000; port++) {
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

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
