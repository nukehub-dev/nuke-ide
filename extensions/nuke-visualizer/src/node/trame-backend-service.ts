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
import { TrameBackendService, PythonConfig } from '../common/trame-protocol';

@injectable()
export class TrameBackendServiceImpl implements TrameBackendService {
    private processes: Map<number, RawProcess> = new Map();

    @inject(RawProcessFactory)
    protected readonly rawProcessFactory: RawProcessFactory;

    async startServer(filePath?: string, config?: PythonConfig): Promise<{ port: number; url: string }> {
        // Kill any existing processes first to prevent accumulation
        await this.killAllProcesses();
        
        const port = await this.findFreePort(8080);
        
        // Find the Python script
        const pythonScript = this.findPythonScript();
        
        // Detect Python command with both trame AND ParaView
        const pythonInfo = await this.detectPythonCommand(config);
        
        const args: string[] = [pythonScript, '--port', port.toString()];
        if (filePath) {
            args.push('--file', filePath);
        }

        const processOptions: RawProcessOptions = {
            command: pythonInfo.command,
            args,
        };

        console.log(`[TrameBackend] Starting server: ${pythonInfo.command} ${args.join(' ')}`);
        if (pythonInfo.description) {
            console.log(`[TrameBackend] Using: ${pythonInfo.description}`);
        }

        const process = this.rawProcessFactory(processOptions);
        
        process.outputStream.on('data', (data: Buffer) => {
            console.log(`[Trame ${port}] ${data.toString().trim()}`);
        });

        process.errorStream.on('data', (data: Buffer) => {
            console.error(`[Trame ${port}] ERROR: ${data.toString().trim()}`);
        });

        process.onExit((event: { code?: number; signal?: string }) => {
            console.log(`[Trame ${port}] Process exited with code ${event.code}, signal: ${event.signal}`);
            this.processes.delete(port);
        });

        this.processes.set(port, process);

        // Wait a bit for the server to start
        await this.delay(3000);

        return { port, url: `http://localhost:${port}` };
    }

    async stopServer(port: number): Promise<void> {
        console.log(`[TrameBackend] Stopping server on port ${port}`);
        const process = this.processes.get(port);
        if (process) {
            // Try graceful kill first
            process.kill();
            
            // Force kill after 2 seconds if still running
            setTimeout(() => {
                try {
                    if (process.pid) {
                        process.kill();
                        console.log(`[TrameBackend] Force killed process ${process.pid}`);
                    }
                } catch (e) {
                    // Process already dead
                }
            }, 2000);
            
            this.processes.delete(port);
        }
    }

    private async killAllProcesses(): Promise<void> {
        console.log(`[TrameBackend] Cleaning up ${this.processes.size} existing processes`);
        const ports = Array.from(this.processes.keys());
        for (const port of ports) {
            await this.stopServer(port);
        }
        // Wait a moment for processes to die
        await this.delay(500);
    }

    private async detectPythonCommand(config?: PythonConfig): Promise<{ command: string; env?: NodeJS.ProcessEnv; description?: string }> {
        const { execSync } = require('child_process');
        
        // Helper to test if a Python has both trame AND paraview
        const testPython = (pythonPath: string): boolean => {
            try {
                // Test trame
                execSync(`"${pythonPath}" -c "import trame"`, { stdio: 'ignore' });
                // Test paraview
                execSync(`"${pythonPath}" -c "from paraview import simple"`, { stdio: 'ignore' });
                return true;
            } catch {
                return false;
            }
        };
        
        // 1. Check config.pythonPath first (user preference)
        if (config?.pythonPath && fs.existsSync(config.pythonPath)) {
            console.log(`[TrameBackend] Testing configured python: ${config.pythonPath}`);
            if (testPython(config.pythonPath)) {
                console.log(`[TrameBackend] Using configured python: ${config.pythonPath}`);
                return { 
                    command: config.pythonPath, 
                    description: 'user configured pythonPath' 
                };
            } else {
                console.log(`[TrameBackend] Configured python exists but missing dependencies`);
            }
        }
        
        // 2. Check config.condaEnv (user preference for conda env name)
        if (config?.condaEnv) {
            const condaPython = this.findCondaPython(config.condaEnv);
            if (condaPython) {
                console.log(`[TrameBackend] Testing conda env '${config.condaEnv}': ${condaPython}`);
                if (testPython(condaPython)) {
                    console.log(`[TrameBackend] Using conda env '${config.condaEnv}': ${condaPython}`);
                    return { 
                        command: condaPython, 
                        description: `conda env (${config.condaEnv})` 
                    };
                }
            }
        }
        
        // 3. Check CONDA_PREFIX env var (if shell has activated conda)
        const condaPrefix = process.env.CONDA_PREFIX;
        if (condaPrefix) {
            const condaPython = path.join(condaPrefix, 'bin', 'python');
            if (fs.existsSync(condaPython)) {
                console.log(`[TrameBackend] Testing conda environment: ${condaPython}`);
                if (testPython(condaPython)) {
                    console.log(`[TrameBackend] Using conda env: ${condaPython}`);
                    return { 
                        command: condaPython, 
                        description: `conda env (${path.basename(condaPrefix)})` 
                    };
                }
            }
        }
        
        // 4. Auto-detect common conda envs
        const commonCondaEnvs = ['trame', 'paraview', 'pv'];
        for (const envName of commonCondaEnvs) {
            const condaPython = this.findCondaPython(envName);
            if (condaPython) {
                console.log(`[TrameBackend] Testing conda env '${envName}': ${condaPython}`);
                if (testPython(condaPython)) {
                    console.log(`[TrameBackend] Found conda env '${envName}': ${condaPython}`);
                    return { 
                        command: condaPython, 
                        description: `conda env (${envName})` 
                    };
                }
            }
        }
        
        // 5. Check environment variable for Python path
        const envPythonPath = process.env.TRAME_PYTHON_PATH;
        if (envPythonPath && fs.existsSync(envPythonPath)) {
            console.log(`[TrameBackend] Testing Python from env var: ${envPythonPath}`);
            if (testPython(envPythonPath)) {
                console.log(`[TrameBackend] Using Python from env var: ${envPythonPath}`);
                return { 
                    command: envPythonPath, 
                    description: 'from environment variable' 
                };
            }
        }
        
        // 6. Try python3/python from system PATH
        for (const cmd of ['python3', 'python']) {
            try {
                const cmdPath = execSync(`which ${cmd}`, { encoding: 'utf8' }).trim();
                if (cmdPath) {
                    console.log(`[TrameBackend] Testing ${cmd} from PATH: ${cmdPath}`);
                    if (testPython(cmdPath)) {
                        console.log(`[TrameBackend] Using ${cmd} from PATH: ${cmdPath}`);
                        return { 
                            command: cmdPath, 
                            description: `${cmd} (from PATH)` 
                        };
                    }
                }
            } catch {
                // not found
            }
        }
        
        // Fallback - return the first configured path even if it doesn't work, so user sees the error
        if (config?.pythonPath && fs.existsSync(config.pythonPath)) {
            console.warn('[TrameBackend] No working Python found with both trame and paraview. Using configured python.');
            return { command: config.pythonPath, description: 'fallback (may not work)' };
        }
        
        console.warn('[TrameBackend] No Python found. Configure in Preferences > Trame.');
        return { command: 'python3', description: 'fallback (may not work)' };
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

    private findPythonScript(): string {
        const possiblePaths = [
            path.join(__dirname, '..', '..', 'python', 'trame_app.py'),
            path.join(__dirname, '..', '..', '..', 'nuke-trame', 'python', 'trame_app.py'),
            path.join(__dirname, '..', '..', '..', 'python', 'trame_app.py'),
            path.join(__dirname, '..', '..', '..', '..', 'python', 'trame_app.py'),
            path.join(__dirname, '..', '..', '..', '..', '..', 'python', 'trame_app.py'),
        ];

        for (const scriptPath of possiblePaths) {
            const normalizedPath = path.normalize(scriptPath);
            if (fs.existsSync(normalizedPath)) {
                console.log(`[TrameBackend] Found Python script at: ${normalizedPath}`);
                return normalizedPath;
            }
        }

        console.error(`[TrameBackend] Could not find trame_app.py`);
        return path.join(process.cwd(), 'python', 'trame_app.py');
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
