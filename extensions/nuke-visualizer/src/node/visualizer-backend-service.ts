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

import { injectable, inject } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
    VisualizerBackendService,
    PythonConfig,
    EnvironmentInfo,
    VisualizerClient,
    VisualizationState,
    CameraViewType,
    ScreenshotOptions,
    ScreenshotResult,
    DEFAULT_VISUALIZATION_STATE,
    DagmcModelInfo,
    ExodusSeries,
    BASE_VISUALIZER_REQUIREMENTS,
    EXODUS_REQUIREMENTS,
    STEP_REQUIREMENTS
} from '../common/base-visualizer-protocol';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface } from 'nuke-core/lib/common';
import { PythonCommandHelper } from './services/python-command-helper';

/**
 * Node.js backend implementation of the base visualizer RPC service.
 *
 * Runs headless `server.py` conversion/info commands (DAGMC/STEP to VTK,
 * DAGMC model info, Exodus series) and manages visualization server
 * lifecycle. All viewers render natively in the frontend (three.js) —
 * no trame/ParaView server is spawned here.
 *
 * @see src/common/base-visualizer-protocol.ts for the RPC interface
 * @see src/browser/visualizer-widget.tsx for the frontend consumer
 */
@injectable()
export class VisualizerBackendServiceImpl implements VisualizerBackendService, BackendApplicationContribution {
    private processes: Map<number, unknown> = new Map();
    private reservedPorts: Set<number> = new Set();
    private client: VisualizerClient | undefined;

    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    @inject(PythonCommandHelper)
    protected readonly pythonHelper: PythonCommandHelper;

    setClient(client: VisualizerClient): void {
        this.client = client;
    }

    /**
     * Check whether a port belongs to a trame server started by this service.
     * Used by the visualizer reverse proxy to restrict forwarding to known servers.
     */
    isVisualizerPort(port: number): boolean {
        return this.processes.has(port);
    }

    private log(message: string): void {
        console.log(`[VisualizerBackend] ${message}`);
        this.client?.log(message);
    }

    private errorLog(message: string): void {
        console.error(`[VisualizerBackend] ${message}`);
        this.client?.error(message);
    }

    /**
     * Read a user preference from Theia's settings file (~/.theia/settings.json).
     * Falls back to defaultValue if the file or preference is not found.
     */
    private getUserPreference<T>(name: string, defaultValue: T): T {
        try {
            const settingsPath = path.join(os.homedir(), '.theia', 'settings.json');
            if (!fs.existsSync(settingsPath)) {
                return defaultValue;
            }
            const content = fs.readFileSync(settingsPath, 'utf-8');
            const settings = JSON.parse(content);
            const value = settings[name];
            return value !== undefined ? value : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    async onStop?(): Promise<void> {
        console.log('[VisualizerBackend] Shutting down, cleaning up all processes...');
        const ports = Array.from(this.processes.keys());
        for (const port of ports) {
            await this.stopServer(port);
        }
    }

    async stopServer(port: number): Promise<void> {
        if (this.processes.has(port)) {
            this.log(`Forgetting server on port ${port}`);
            this.processes.delete(port);
            this.reservedPorts.delete(port);
        }
    }

    private parseJsonFromMixedOutput(stdout: string): any {
        // Library code may print log lines before the JSON output.
        // Find the first line that starts with '{' and parse it as JSON.
        const lines = stdout.split('\n');
        const jsonLine = lines.find((l) => l.trimStart().startsWith('{'));
        if (!jsonLine) {
            throw new Error(`No JSON found in output: ${stdout.substring(0, 200)}`);
        }
        try {
            return JSON.parse(jsonLine);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Failed to parse JSON: ${msg}. Output: ${stdout.substring(0, 500)}`);
        }
    }

    async convertDagmc(filePath: string, volumeId?: number): Promise<string> {
        this.log(`Starting DAGMC conversion: ${filePath}${volumeId !== undefined ? ` (volume ${volumeId})` : ''}`);

        const serverScript = this.pythonHelper.findScript('server.py');
        const pythonInfo = await this.pythonHelper.detectPythonForBaseVisualizer();
        this.log(`[Converter] Using Python: ${pythonInfo.command}`);

        const args = ['base.convert-dagmc', '--file', filePath];
        if (volumeId !== undefined) {
            args.push('--volume', String(volumeId));
        }

        this.log(`[Converter] Command: "${pythonInfo.command}" "${serverScript}" "${args.join('" "')}"`);

        // Compute proportional timeout for large files
        const baseTimeoutSec = this.getUserPreference('nukeVisualizer.serverTimeout', 30);
        const perMBSec = this.getUserPreference('nukeVisualizer.serverTimeoutPerMB', 0.5);
        const stats = fs.statSync(filePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        const timeoutMs = Math.round(
            Math.max(baseTimeoutSec * 1000, Math.min(600000, baseTimeoutSec * 1000 + fileSizeMB * perMBSec * 1000))
        );
        this.log(
            `[Converter] Timeout: ${(timeoutMs / 1000).toFixed(1)}s (base=${baseTimeoutSec}s, perMB=${perMBSec}s, size=${fileSizeMB.toFixed(1)}MB)`
        );

        const execResult = await this.pythonHelper.executeScript(serverScript, args, { timeout: timeoutMs });
        if (execResult.status !== 0) {
            const errorOutput = (execResult.stdout || '') + (execResult.stderr || '');
            this.errorLog(`[Converter] FAILED with status ${execResult.status}. Output: ${errorOutput}`);
            throw new Error(errorOutput || `Conversion failed with status ${execResult.status}`);
        }

        const result = this.parseJsonFromMixedOutput(execResult.stdout) as {
            vtk_path: string;
            from_cache: boolean;
            original_cells?: number;
            filtered_cells?: number;
            error?: string;
        };

        if (result.error) {
            this.errorLog(`[Converter] FAILED: ${result.error}`);
            throw new Error(result.error);
        }

        const vtkPath = result.vtk_path;
        if (vtkPath && fs.existsSync(vtkPath)) {
            this.log(`[Converter] Success: ${vtkPath}`);
            return vtkPath;
        }

        throw new Error(`Conversion completed but could not find output VTK file: ${vtkPath}`);
    }

    async convertStep(filePath: string): Promise<string> {
        this.log(`Starting STEP conversion: ${filePath}`);

        const serverScript = this.pythonHelper.findScript('server.py');

        // STEP conversion requires gmsh — detect Python with gmsh available
        const pythonInfo = await this.pythonHelper.detectPython(STEP_REQUIREMENTS);
        this.log(`[STEP Converter] Using Python: ${pythonInfo.command}`);

        const args = ['base.convert-step', '--file', filePath];

        this.log(`[STEP Converter] Command: "${pythonInfo.command}" "${serverScript}" "${args.join('" "')}"`);

        const execResult = await this.pythonHelper.executeScript(serverScript, args, { requirements: STEP_REQUIREMENTS });
        if (execResult.status !== 0) {
            const errorOutput = (execResult.stdout || '') + (execResult.stderr || '');
            this.errorLog(`[STEP Converter] FAILED with status ${execResult.status}. Output: ${errorOutput}`);
            throw new Error(errorOutput || `STEP conversion failed with status ${execResult.status}`);
        }

        const result = this.parseJsonFromMixedOutput(execResult.stdout) as {
            vtk_path: string;
            from_cache: boolean;
            num_nodes?: number;
            num_elements?: number;
            error?: string;
        };

        if (result.error) {
            this.errorLog(`[STEP Converter] FAILED: ${result.error}`);
            throw new Error(result.error);
        }

        const vtkPath = result.vtk_path;
        if (vtkPath && fs.existsSync(vtkPath)) {
            this.log(`[STEP Converter] Success: ${vtkPath}`);
            return vtkPath;
        }

        throw new Error(`STEP conversion completed but could not find output VTK file: ${vtkPath}`);
    }

    async getDagmcInfo(filePath: string): Promise<DagmcModelInfo> {
        this.log(`Getting DAGMC info: ${filePath}`);

        const serverScript = this.pythonHelper.findScript('server.py');
        const pythonInfo = await this.pythonHelper.detectPythonForBaseVisualizer();
        this.log(`[DAGMC Info] Using Python: ${pythonInfo.command}`);

        const args = ['dagmc.info', '--file', filePath];
        this.log(`[DAGMC Info] Command: "${pythonInfo.command}" "${serverScript}" "${args.join('" "')}"`);

        const execResult = await this.pythonHelper.executeScript(serverScript, args);
        if (execResult.status !== 0) {
            const errorOutput = (execResult.stdout || '') + (execResult.stderr || '');
            this.errorLog(`[DAGMC Info] FAILED with status ${execResult.status}. Output: ${errorOutput}`);
            throw new Error(errorOutput || `DAGMC info extraction failed with status ${execResult.status}`);
        }

        const result = this.parseJsonFromMixedOutput(execResult.stdout) as {
            volumes: any[];
            materials: Record<string, any>;
            groups: Record<string, any>;
            surfaces: any[];
            fileInfo: any;
            error?: string;
        };

        if (result.error) {
            this.errorLog(`[DAGMC Info] FAILED: ${result.error}`);
            throw new Error(result.error);
        }

        return result as DagmcModelInfo;
    }

    async getExodusSeries(filePath: string, maxSteps?: number, maxPoints?: number): Promise<ExodusSeries> {
        this.log(`Extracting Exodus series: ${filePath}`);

        const serverScript = this.pythonHelper.findScript('server.py');
        const pythonInfo = await this.pythonHelper.detectPython(EXODUS_REQUIREMENTS);
        this.log(`[Exodus Series] Using Python: ${pythonInfo.command}`);

        const args = ['base.exodus-series', '--file', filePath];
        if (maxSteps !== undefined) {
            args.push('--max-steps', String(maxSteps));
        }
        if (maxPoints !== undefined) {
            args.push('--max-points', String(maxPoints));
        }
        this.log(`[Exodus Series] Command: "${pythonInfo.command}" "${serverScript}" "${args.join('" "')}"`);

        const execResult = await this.pythonHelper.executeScript(serverScript, args, { requirements: EXODUS_REQUIREMENTS });
        if (execResult.status !== 0) {
            // Base-plugin commands report errors as a single JSON object on
            // stderr (never a traceback); surface that message when present.
            const message = this.exodusErrorMessage(execResult.stdout, execResult.stderr, execResult.status);
            this.errorLog(`[Exodus Series] FAILED with status ${execResult.status}. Output: ${message}`);
            throw new Error(message);
        }

        const result = this.parseJsonFromMixedOutput(execResult.stdout) as ExodusSeries & { error?: string };

        if (result.error) {
            this.errorLog(`[Exodus Series] FAILED: ${result.error}`);
            throw new Error(result.error);
        }

        return result;
    }

    /**
     * Best-effort error text for a failed `base.exodus-series` run: the
     * stderr JSON payload's `error` when the command honored the base-plugin
     * contract, else the combined output, else a bare status line.
     */
    private exodusErrorMessage(stdout: string, stderr: string, status: number | null): string {
        for (const output of [stderr, stdout]) {
            try {
                const payload = this.parseJsonFromMixedOutput(output) as { error?: unknown };
                if (payload && typeof payload.error === 'string' && payload.error) {
                    return payload.error;
                }
            } catch {
                // No JSON here — try the next stream.
            }
        }
        const combined = `${stdout || ''}${stderr || ''}`.trim();
        return combined || `Exodus series extraction failed with status ${status}`;
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
            moabInstalled: false
        };

        try {
            info.pythonVersion = execSync(`"${pythonCommand}" --version`, { encoding: 'utf8' }).trim();
        } catch (e) {
            this.errorLog('Failed to get python version');
        }

        // Use nuke-core to check dependencies
        const depCheck = await this.nukeCoreService.checkDependencies(BASE_VISUALIZER_REQUIREMENTS, pythonCommand);

        info.trameInstalled = depCheck.versions['trame'] !== undefined;
        info.trameVersion = depCheck.versions['trame'];
        info.paraviewInstalled = depCheck.versions['paraview'] !== undefined;
        info.paraviewVersion = depCheck.versions['paraview'];

        // Check moab separately (optional, with fallback to mbconvert CLI)
        if (depCheck.versions['moab']) {
            info.moabInstalled = true;
            info.moabVersion = depCheck.versions['moab'];
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
}
