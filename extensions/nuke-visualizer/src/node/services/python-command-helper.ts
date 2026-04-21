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
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface, PackageDependency } from 'nuke-core/lib/common';
import { OPENMC_REQUIREMENTS } from '../../common/openmc-protocol';
import { PythonConfig, BASE_VISUALIZER_REQUIREMENTS } from '../../common/base-visualizer-protocol';

export interface PythonCommandResult {
    command: string;
    warning?: string;
}

export interface ScriptExecutionResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

export { OPENMC_REQUIREMENTS } from '../../common/openmc-protocol';
export { BASE_VISUALIZER_REQUIREMENTS } from '../../common/base-visualizer-protocol';

@injectable()
export class PythonCommandHelper {
    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    /**
     * Sync Python configuration with nuke-core before detection.
     * Ensures that subsequent `detectPython` calls use the specified
     * interpreter or conda environment.
     */
    async syncConfig(config?: PythonConfig): Promise<void> {
        if (config?.pythonPath || config?.condaEnv) {
            await this.nukeCoreService.setConfig({
                pythonPath: config.pythonPath,
                condaEnv: config.condaEnv
            });
        }
    }

    /**
     * Detect a Python command that satisfies the given package requirements.
     * Delegates to `nuke-core` for smart detection across conda, venv, and system paths.
     *
     * Throws if no suitable Python is found. The error message suggests
     * configuring the environment in Settings → Nuke Utils.
     *
     * @param requirements Package requirements to satisfy (defaults to OpenMC requirements)
     * @param autoDetectEnvs Preferred conda/virtualenv names to check first
     * @returns Python command path and optional warning
     */
    async detectPython(
        requirements: PackageDependency[] = OPENMC_REQUIREMENTS,
        autoDetectEnvs?: string[]
    ): Promise<PythonCommandResult> {
        const detectionResult = await this.nukeCoreService.detectPythonWithRequirements({
            requiredPackages: requirements,
            autoDetectEnvs
        });

        if (!detectionResult.success || !detectionResult.command) {
            const reqList = requirements.filter(r => r.required !== false).map(r => r.name).join(', ') || 'required packages';
            throw new Error(
                detectionResult.error ||
                `Failed to detect Python environment with ${reqList}. Configure in Settings → Nuke Utils.`
            );
        }

        return {
            command: detectionResult.command,
            warning: detectionResult.warning
        };
    }

    /**
     * Detect Python for base visualizer operations (VTK/Paraview/Trame).
     * Uses {@link BASE_VISUALIZER_REQUIREMENTS} by default.
     *
     * @param autoDetectEnvs Preferred environment names
     */
    async detectPythonForBaseVisualizer(
        autoDetectEnvs?: string[]
    ): Promise<PythonCommandResult> {
        return this.detectPython(BASE_VISUALIZER_REQUIREMENTS, autoDetectEnvs);
    }

    /**
     * Check if the given Python command has the required packages installed.
     * Delegates to `nuke-core`'s dependency checker.
     *
     * @param pythonCommand Path to the Python executable to check
     * @param requirements Package requirements (defaults to OpenMC requirements)
     * @returns Availability, missing packages, and detected versions
     */
    async checkPackages(
        pythonCommand: string,
        requirements: PackageDependency[] = OPENMC_REQUIREMENTS
    ): Promise<{ available: boolean; missing: string[]; versions: Record<string, string> }> {
        const result = await this.nukeCoreService.checkDependencies(requirements, pythonCommand);
        return {
            available: result.available,
            missing: result.missing,
            versions: result.versions
        };
    }

    /**
     * Execute a Python script with the given arguments.
     * Automatically detects Python with the specified requirements before running.
     *
     * @param scriptPath Absolute path to the Python script
     * @param args Command-line arguments passed to the script
     * @param options Execution options (timeout, buffer size, requirements)
     * @returns stdout, stderr, and exit status
     */
    async executeScript(
        scriptPath: string,
        args: string[],
        options?: {
            maxBuffer?: number;
            timeout?: number;
            encoding?: BufferEncoding;
            requirements?: PackageDependency[];
        }
    ): Promise<ScriptExecutionResult> {
        const python = await this.detectPython(options?.requirements);
        const result = spawnSync(python.command, [scriptPath, ...args], {
            encoding: options?.encoding ?? 'utf8',
            maxBuffer: options?.maxBuffer ?? 10 * 1024 * 1024,
            timeout: options?.timeout ?? 60000
        });

        return {
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            status: result.status
        };
    }

    /**
     * Execute a Python script and parse the stdout as JSON.
     * Throws if the script exits non-zero or stdout is not valid JSON.
     *
     * @param scriptPath Absolute path to the Python script
     * @param args Command-line arguments passed to the script
     * @param options Execution options (timeout, requirements)
     * @returns Parsed JSON output cast to type T
     * @throws Error if script fails or output is not valid JSON
     */
    async executeScriptJson<T>(
        scriptPath: string,
        args: string[],
        options?: {
            maxBuffer?: number;
            timeout?: number;
            requirements?: PackageDependency[];
        }
    ): Promise<T> {
        const result = await this.executeScript(scriptPath, args, options);

        if (result.status !== 0) {
            const errMsg = result.stderr || `Script exited with code ${result.status}`;
            throw new Error(errMsg);
        }

        try {
            return JSON.parse(result.stdout) as T;
        } catch (e) {
            throw new Error(`Failed to parse script output as JSON: ${e}. Output: ${result.stdout.substring(0, 500)}`);
        }
    }

    /**
     * Find the absolute path to a Python script within the extension's `python/` directory.
     * Searches installed `lib/python/`, development `src/python/`, and fallback paths.
     *
     * @param scriptName Name of the script file (e.g., `'server.py'`)
     * @returns Absolute path to the script
     */
    findScript(scriptName: string): string {
        const extensionPath = this.getExtensionPath();
        const scriptPath = path.resolve(extensionPath, 'python', scriptName);

        if (fs.existsSync(scriptPath)) {
            return scriptPath;
        }

        // Fallback search in common development locations
        const fallbackPaths = [
            path.resolve(__dirname, '../../../../extensions/nuke-visualizer/python', scriptName),
            path.resolve(process.cwd(), 'extensions/nuke-visualizer/python', scriptName),
            path.resolve(__dirname, '../../../python', scriptName),
        ];

        for (const fp of fallbackPaths) {
            if (fs.existsSync(fp)) {
                return fp;
            }
        }

        return scriptPath;
    }

    /**
     * Get the root path of the nuke-visualizer extension.
     * Used internally by {@link findScript}.
     *
     * @returns Absolute path to the extension root
     */
    getExtensionPath(): string {
        try {
            return path.dirname(require.resolve('nuke-visualizer/package.json'));
        } catch (e) {
            // Fallback for development/testing
            return path.resolve(__dirname, '../..');
        }
    }
}
