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
import { execSync, spawnSync } from 'child_process';
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
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';

@injectable()
export class VisualizerBackendServiceImpl implements VisualizerBackendService, BackendApplicationContribution {
    private processes: Map<number, RawProcess> = new Map();
    private reservedPorts: Set<number> = new Set();
    private client: VisualizerClient | undefined;

    @inject(RawProcessFactory)
    protected readonly rawProcessFactory: RawProcessFactory;

    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

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

    async convertDagmc(filePath: string, volumeId?: number): Promise<string> {
        this.log(`Starting DAGMC conversion: ${filePath}${volumeId !== undefined ? ` (volume ${volumeId})` : ''}`);
        
        // Find the dagmc converter script
        const converterScript = this.findDagmcConverterScript();
        
        // Find Python command
        const pythonInfo = await this.detectPythonCommand();
        this.log(`[Converter] Using Python: ${pythonInfo.command}`);
        
        try {
            // Build command arguments
            const args = [converterScript, filePath];
            if (volumeId !== undefined) {
                args.push('--volume', String(volumeId));
            }
            
            this.log(`[Converter] Command: "${pythonInfo.command}" "${args.join('" "')}"`);
            
            // Run the converter script
            const result = spawnSync(
                pythonInfo.command,
                args,
                { encoding: 'utf8' }
            );
            
            if (result.status !== 0) {
                const errorOutput = (result.stdout || '') + (result.stderr || '');
                this.errorLog(`[Converter] FAILED with status ${result.status}. Output: ${errorOutput}`);
                throw new Error(errorOutput || `Conversion failed with status ${result.status}`);
            }
            
            this.log(`[Converter] Output: ${result.stdout}`);
            
            // Parse output to find converted file path
            const match = result.stdout.match(/Output: (.+)/);
            if (match) {
                const vtkPath = match[1].trim();
                if (fs.existsSync(vtkPath)) {
                    this.log(`[Converter] Success: ${vtkPath}`);
                    return vtkPath;
                }
            }
            
            // Fallback: try to infer VTK path
            let vtkPath: string;
            if (volumeId !== undefined) {
                // Volume extraction output
                vtkPath = filePath.replace(/\.h5m$/i, `_${volumeId}.vtk`);
            } else {
                vtkPath = filePath.replace(/\.h5m$/i, '.vtk');
            }
            
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
        
        // Set config in nuke-core if provided
        if (config?.pythonPath || config?.condaEnv) {
            await this.nukeCoreService.setConfig({
                pythonPath: config.pythonPath,
                condaEnv: config.condaEnv
            });
        }
        
        const pythonCommand = await this.nukeCoreService.getPythonCommand();
        if (!pythonCommand) {
            throw new Error('No Python environment configured. Please set Python path in preferences.');
        }
        
        const info: EnvironmentInfo = {
            pythonPath: pythonCommand,
            pythonVersion: 'unknown',
            paraviewInstalled: false,
            trameInstalled: false,
            moabInstalled: false,
        };

        try {
            info.pythonVersion = execSync(`"${pythonCommand}" --version`, { encoding: 'utf8' }).trim();
        } catch (e) {
            this.errorLog('Failed to get python version');
        }

        // Use nuke-core to check dependencies
        const depCheck = await this.nukeCoreService.checkDependencies([
            { name: 'trame', submodule: 'app' },
            { name: 'paraview' },
            { name: 'pymoab', required: false }
        ], pythonCommand);

        info.trameInstalled = depCheck.versions['trame'] !== undefined;
        info.trameVersion = depCheck.versions['trame'];
        info.paraviewInstalled = depCheck.versions['paraview'] !== undefined;
        info.paraviewVersion = depCheck.versions['paraview'];
        
        // Check moab separately (optional, with fallback to mbconvert CLI)
        if (depCheck.versions['pymoab']) {
            info.moabInstalled = true;
            info.moabVersion = depCheck.versions['pymoab'];
        } else {
            // Check mbconvert as fallback
            try {
                execSync('mbconvert --version', { stdio: 'ignore' });
                info.moabInstalled = true;
                info.moabVersion = 'Available (mbconvert CLI)';
            } catch {
                info.moabInstalled = false;
            }
        }

        return info;
    }

    private async detectPythonCommand(config?: PythonConfig): Promise<{ command: string; env?: NodeJS.ProcessEnv; description?: string; warning?: string }> {
        // Set config in nuke-core if provided
        if (config?.pythonPath || config?.condaEnv) {
            await this.nukeCoreService.setConfig({
                pythonPath: config.pythonPath,
                condaEnv: config.condaEnv
            });
        }
        
        // Use nuke-core to detect Python with visualizer-specific requirements
        const detectionResult = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: [
                { name: 'trame' },
                { name: 'paraview', submodule: 'simple' }
            ],
            autoDetectEnvs: ['visualizer', 'paraview', 'nuke-ide']
        });
        
        if (!detectionResult.success || !detectionResult.command) {
            throw new Error(detectionResult.error || 'Failed to detect environment with trame and paraview. Configure in Settings → Nuke Visualizer.');
        }
        
        return {
            command: detectionResult.command,
            warning: detectionResult.warning
        };
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
