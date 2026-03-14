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
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import { spawnSync, execSync } from 'child_process';
import { 
    VisualizerBackendService, 
    PythonConfig, 
    EnvironmentInfo, 
    VisualizerClient,
    VisualizationState,
    CameraViewType,
    ScreenshotOptions,
    ScreenshotResult,
    DEFAULT_VISUALIZATION_STATE
} from '../common/visualizer-protocol';

@injectable()
export class VisualizerBackendServiceImpl implements VisualizerBackendService, BackendApplicationContribution {
    private processes: Map<number, RawProcess> = new Map();
    private reservedPorts: Set<number> = new Set();
    private client: VisualizerClient | undefined;

    @inject(RawProcessFactory)
    protected readonly rawProcessFactory: RawProcessFactory;

    setClient(client: VisualizerClient): void {
        this.client = client;
    }

    private log(message: string): void {
        console.log(`[VisualizerBackend] ${message}`);
        this.client?.log(message);
    }

    private errorLog(message: string): void {
        console.error(`[VisualizerBackend] ${message}`);
        this.client?.error(message);
    }

    async onStop?(): Promise<void> {
        console.log('[VisualizerBackend] Shutting down, cleaning up all processes...');
        const ports = Array.from(this.processes.keys());
        for (const port of ports) {
            await this.stopServer(port);
        }
    }

    async startServer(filePath?: string, config?: PythonConfig, theme?: string): Promise<{ port: number; url: string; warning?: string }> {
        const port = await this.findFreePort(8080);
        this.reservedPorts.add(port);
        
        try {
            // Find the Python script
            const pythonScript = this.findPythonScript();
            
            // Detect Python command
            const pythonInfo = await this.detectPythonCommand(config);
            const warning = pythonInfo.warning;
            
            const args: string[] = [pythonScript, '--port', port.toString()];
            if (filePath) {
                args.push('--file', filePath);
            }
            // Pass theme if provided (dark or light)
            this.log(`Theme received: ${theme}`);
            if (theme) {
                args.push('--theme', theme);
                this.log(`Added --theme ${theme} to args`);
            }

            const processOptions: RawProcessOptions = {
                command: pythonInfo.command,
                args,
            };

            this.log(`Starting server on port ${port} for ${filePath || 'default'}`);
            const process = this.rawProcessFactory(processOptions);
            
            // Track the process
            this.processes.set(port, process);
            
            this.log(`[Server ${port}] Command: ${processOptions.command} ${(processOptions.args || []).join(' ')}`);

            // Collect output for logging/debugging
            process.outputStream.on('data', (data: Buffer) => {
                const line = data.toString().trim();
                this.log(`[Server ${port}] ${line}`);
            });

            process.errorStream.on('data', (data: Buffer) => {
                const line = data.toString().trim();
                this.errorLog(`[Server ${port}] ERROR: ${line}`);
            });

            process.onExit((event: { code?: number; signal?: string }) => {
                this.log(`[Server ${port}] Process exited (code: ${event.code}, signal: ${event.signal})`);
                this.processes.delete(port);
                this.reservedPorts.delete(port);
                this.client?.onServerStop(port);
            });

            // Wait for server to be ready
            try {
                await this.waitForServer(port, process);
                return { port, url: `http://127.0.0.1:${port}`, warning };
            } catch (error) {
                process.kill();
                this.processes.delete(port);
                this.reservedPorts.delete(port);
                throw error;
            }
        } finally {
            // If it succeeded, it's in this.processes now. If it failed, it's removed.
            // But we keep it in reservedPorts until it's actually running or cleaned up.
        }
    }

    private async waitForServer(port: number, process: RawProcess): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Server startup timeout on port ${port}`));
            }, 30000);

            const successListener = (data: Buffer) => {
                if (data.toString().includes('Starting visualizer server on')) {
                    cleanup();
                    resolve();
                }
            };

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

            process.outputStream.on('data', successListener);

            const cleanup = () => {
                clearTimeout(timeout);
                clearInterval(portCheckInterval);
                process.outputStream.removeListener('data', successListener);
                exitDisposable.dispose();
            };
        });
    }

    async stopServer(port: number): Promise<void> {
        const process = this.processes.get(port);
        if (process) {
            this.log(`Stopping server on port ${port}`);
            process.kill();
            this.processes.delete(port);
            this.reservedPorts.delete(port);
        }
    }

    async convertDagmc(filePath: string): Promise<string> {
        this.log(`Starting DAGMC conversion: ${filePath}`);
        
        // Find the dagmc converter script
        const converterScript = this.findDagmcConverterScript();
        
        // Find Python command
        const pythonInfo = await this.detectPythonCommand();
        this.log(`[Converter] Using Python: ${pythonInfo.command}`);
        
        try {
            this.log(`[Converter] Command: "${pythonInfo.command}" "${converterScript}" "${filePath}"`);
            // Run the converter script
            // Using spawnSync to better handle stdout/stderr on failure
            const result = spawnSync(
                pythonInfo.command,
                [converterScript, filePath],
                { encoding: 'utf8' }
            );
            
            if (result.status !== 0) {
                const errorOutput = (result.stdout || '') + (result.stderr || '');
                this.errorLog(`[Converter] FAILED with status ${result.status}. Output: ${errorOutput}`);
                throw new Error(errorOutput || `Conversion failed with status ${result.status}`);
            }
            
            this.log(`[Converter] Output: ${result.stdout}`);
            
            // Parse output to find converted file path
            const match = result.stdout.match(/Conversion complete: (.+)/);
            if (match) {
                const vtkPath = match[1].trim();
                if (fs.existsSync(vtkPath)) {
                    this.log(`[Converter] Success: ${vtkPath}`);
                    return vtkPath;
                }
            }
            
            // Fallback: try to infer VTK path (replace .h5m with .vtk)
            const vtkPath = filePath.replace(/\.h5m$/i, '.vtk');
            if (fs.existsSync(vtkPath)) {
                this.log(`[Converter] Success (inferred): ${vtkPath}`);
                return vtkPath;
            }
            
            throw new Error(`Conversion completed but could not find output VTK file. Output: ${result.stdout}`);
            
        } catch (error) {
            this.errorLog(`[Converter] ERROR: ${error instanceof Error ? error.message : String(error)}`);
            throw new Error(error instanceof Error ? error.message : String(error));
        }
    }

    async checkEnvironment(config?: PythonConfig): Promise<EnvironmentInfo> {
        this.log('Checking environment...');
        const pythonInfo = await this.detectPythonCommand(config);
        
        const info: EnvironmentInfo = {
            pythonPath: pythonInfo.command,
            pythonVersion: 'unknown',
            paraviewInstalled: false,
            trameInstalled: false,
            moabInstalled: false,
            warning: pythonInfo.warning
        };

        try {
            info.pythonVersion = execSync(`"${pythonInfo.command}" --version`, { encoding: 'utf8' }).trim();
        } catch (e) {
            this.errorLog('Failed to get python version');
        }

        // Check paraview
        try {
            const pvOutput = execSync(`"${pythonInfo.command}" -c "import paraview; print(paraview.__version__)"`, { encoding: 'utf8' }).trim();
            info.paraviewInstalled = true;
            info.paraviewVersion = pvOutput;
        } catch (e) {
            info.paraviewInstalled = false;
        }

        // Check trame
        try {
            // Try trame.app first (the main submodule that has __version__)
            const trameOutput = execSync(`"${pythonInfo.command}" -c "import trame.app; print(trame.app.__version__)"`, { encoding: 'utf8' }).trim();
            info.trameInstalled = true;
            info.trameVersion = trameOutput;
        } catch (e) {
            // Fallback: just check if trame can be imported
            try {
                execSync(`"${pythonInfo.command}" -c "import trame"`, { stdio: 'ignore' });
                info.trameInstalled = true;
                info.trameVersion = 'installed (version unknown)';
            } catch {
                info.trameInstalled = false;
            }
        }

        // Check moab (pymoab)
        try {
            execSync(`"${pythonInfo.command}" -c "from pymoab import core"`, { stdio: 'ignore' });
            info.moabInstalled = true;
            // pymoab doesn't have a direct __version__ in some versions, but we can check if it works
            info.moabVersion = 'Available (pymoab)';
        } catch (e) {
            // Check mbconvert as fallback
            try {
                execSync('mbconvert --version', { stdio: 'ignore' });
                info.moabInstalled = true;
                info.moabVersion = 'Available (mbconvert CLI)';
            } catch (e2) {
                info.moabInstalled = false;
            }
        }

        return info;
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

    private getExtensionPath(): string {
        try {
            return path.dirname(require.resolve('nuke-visualizer/package.json'));
        } catch (e) {
            // Fallback to __dirname if require.resolve fails (e.g. during development/testing)
            return path.normalize(path.join(__dirname, '../..'));
        }
    }

    private findPythonScript(): string {
        const extensionPath = this.getExtensionPath();
        const scriptPath = path.normalize(path.join(extensionPath, 'python/visualizer_app.py'));
        if (fs.existsSync(scriptPath)) {
            console.log(`[VisualizerBackend] Found Python script at: ${scriptPath}`);
            return scriptPath;
        }

        console.error(`[VisualizerBackend] Could not find visualizer_app.py at ${scriptPath}`);
        return scriptPath;
    }

    private findDagmcConverterScript(): string {
        const extensionPath = this.getExtensionPath();
        const scriptPath = path.normalize(path.join(extensionPath, 'python/dagmc_converter.py'));
        if (fs.existsSync(scriptPath)) {
            console.log(`[VisualizerBackend] Found DAGMC converter script at: ${scriptPath}`);
            return scriptPath;
        }

        console.error(`[VisualizerBackend] Could not find dagmc_converter.py at ${scriptPath}`);
        return scriptPath;
    }

    // === Visualization Controls ===
    // Note: Interactive controls are handled directly in the trame UI.
    // These backend methods are placeholders for future external control API.

    async getVisualizationState(_port: number): Promise<VisualizationState> {
        // TODO: Implement WebSocket or HTTP API to query state from Python server
        this.log('getVisualizationState: Not yet implemented');
        return DEFAULT_VISUALIZATION_STATE;
    }

    async updateVisualizationState(_port: number, _state: Partial<VisualizationState>): Promise<void> {
        // TODO: Implement WebSocket or HTTP API to update state on Python server
        this.log('updateVisualizationState: Not yet implemented');
    }

    async resetCamera(_port: number): Promise<boolean> {
        // TODO: Implement external camera control
        this.log('resetCamera: Not yet implemented');
        return false;
    }

    async setCameraView(_port: number, _viewType: CameraViewType): Promise<boolean> {
        // TODO: Implement external camera control
        this.log('setCameraView: Not yet implemented');
        return false;
    }

    async captureScreenshot(_port: number, _options: ScreenshotOptions): Promise<ScreenshotResult> {
        // TODO: Implement screenshot capture API
        this.log('captureScreenshot: Not yet implemented');
        return { error: 'Not yet implemented' };
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
}
