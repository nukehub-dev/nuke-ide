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
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { NukeCoreBackendService, NukeCoreBackendServiceInterface, PackageDependency } from 'nuke-core/lib/common';
import { PythonConfig } from '../../common/base-visualizer-protocol';

export interface PythonCommandResult {
    command: string;
    warning?: string;
}

export interface ScriptExecutionResult {
    stdout: string;
    stderr: string;
    status: number | null;
}

/** Default package requirements for OpenMC operations */
export const OPENMC_REQUIREMENTS: PackageDependency[] = [
    { name: 'h5py', required: true },
    { name: 'openmc', required: true },
    { name: 'numpy', required: true }
];

/** Default package requirements for base visualizer (VTK/Paraview) operations */
export const BASE_VISUALIZER_REQUIREMENTS: PackageDependency[] = [
    { name: 'trame', submodule: 'app', required: true },
    { name: 'paraview', submodule: 'simple', required: true }
];

@injectable()
export class PythonCommandHelper {
    @inject(NukeCoreBackendService)
    protected readonly nukeCoreService: NukeCoreBackendServiceInterface;

    /**
     * Sync Python configuration with nuke-core before detection.
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
     * Delegates to nuke-core's smart detection with fallback.
     *
     * Defaults to OpenMC requirements if none specified.
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
     * Detect Python for base visualizer operations (VTK/Paraview).
     * Uses BASE_VISUALIZER_REQUIREMENTS by default.
     */
    async detectPythonForBaseVisualizer(
        autoDetectEnvs?: string[]
    ): Promise<PythonCommandResult> {
        return this.detectPython(BASE_VISUALIZER_REQUIREMENTS, autoDetectEnvs);
    }

    /**
     * Check if the given Python command has the required packages installed.
     * Delegates to nuke-core's checkDependencies.
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
     * Find the absolute path to a Python script within the extension's python/ directory.
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
