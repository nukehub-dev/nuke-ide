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
 * Nuke Core Backend Service
 * 
 * Backend service for core infrastructure:
 * - Python environment management
 * - Configuration management
 * - Utility functions for extensions
 * 
 * @module nuke-core/node
 */

import { injectable } from '@theia/core/shared/inversify';
import {
    NukeCoreBackendServiceInterface,
    PythonConfig,
    PythonEnvironment,
    PythonDetectionResult,
    ListEnvironmentsResult
} from '../common/nuke-core-protocol';

@injectable()
export class NukeCoreBackendServiceImpl implements NukeCoreBackendServiceInterface {
    
    private config: PythonConfig = {};
    private cachedPythonCommand?: string;

    async setConfig(config: PythonConfig): Promise<void> {
        this.config = { ...config };
        this.cachedPythonCommand = undefined; // Clear cache
        console.log(`[NukeCore] Config updated: pythonPath=${config.pythonPath}, condaEnv=${config.condaEnv}`);
    }

    async getConfig(): Promise<PythonConfig> {
        return { ...this.config };
    }

    async detectPython(): Promise<PythonDetectionResult> {
        return this.doDetectPython();
    }

    async getPythonCommand(): Promise<string | undefined> {
        if (this.cachedPythonCommand) {
            return this.cachedPythonCommand;
        }
        const result = await this.doDetectPython();
        return result.success ? result.command : undefined;
    }

    async checkOpenMC(): Promise<{ available: boolean; version?: string; error?: string }> {
        const pythonResult = await this.doDetectPython();
        if (!pythonResult.success) {
            return { available: false, error: pythonResult.error };
        }

        const pythonCmd = pythonResult.command!;
        
        try {
            const { execSync } = await import('child_process');
            const output = execSync(
                `${pythonCmd} -c "import openmc; print(openmc.__version__)"`,
                { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            
            return { available: true, version: output };
        } catch (error) {
            return {
                available: false,
                error: `OpenMC Python module not found in ${pythonCmd}. Install with: pip install openmc`
            };
        }
    }

    async listEnvironments(): Promise<ListEnvironmentsResult> {
        const environments: PythonEnvironment[] = [];
        
        // 1. Try configured Python path
        if (this.config.pythonPath) {
            try {
                const env = await this.getEnvironmentInfo(this.config.pythonPath, 'system');
                if (env) environments.push(env);
            } catch {
                // Ignore
            }
        }
        
        // 2. Try conda environments
        const condaEnvs = await this.listCondaEnvironments();
        environments.push(...condaEnvs);
        
        // 3. Try system Python
        for (const cmd of ['python', 'python3']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                const existing = environments.find(e => e.pythonPath === cmd);
                if (!existing) {
                    const env = await this.getEnvironmentInfo(cmd, 'system');
                    if (env) environments.push(env);
                }
            } catch {
                // Ignore
            }
        }
        
        // Determine selected environment
        let selected: PythonEnvironment | undefined;
        if (this.config.pythonPath) {
            selected = environments.find(e => e.pythonPath === this.config.pythonPath);
        } else if (this.config.condaEnv) {
            selected = environments.find(e => 
                e.type === 'conda' && e.name.includes(this.config.condaEnv!)
            );
        }
        
        return { environments, selected };
    }

    private async doDetectPython(): Promise<PythonDetectionResult> {
        // 1. Try explicitly configured Python path first
        if (this.config.pythonPath) {
            try {
                const { execSync } = await import('child_process');
                execSync(`"${this.config.pythonPath}" --version`, { stdio: 'ignore' });
                this.cachedPythonCommand = this.config.pythonPath;
                return { success: true, command: this.config.pythonPath };
            } catch {
                return {
                    success: false,
                    error: `Configured Python path not valid: ${this.config.pythonPath}`
                };
            }
        }

        // 2. Try conda environment
        if (this.config.condaEnv) {
            const condaPython = await this.findCondaPython(this.config.condaEnv);
            if (condaPython) {
                this.cachedPythonCommand = condaPython;
                return { success: true, command: condaPython };
            }
            return {
                success: false,
                error: `Conda environment '${this.config.condaEnv}' not found`
            };
        }

        // 3. Try to detect conda environment with 'openmc' name
        const openmcCondaPython = await this.findCondaPython('openmc');
        if (openmcCondaPython) {
            this.cachedPythonCommand = openmcCondaPython;
            return {
                success: true,
                command: openmcCondaPython,
                warning: `Using auto-detected conda environment 'openmc'. Configure 'nukeVisualizer.condaEnv' to use a specific environment.`
            };
        }

        // 4. Try 'python' in PATH
        try {
            const { execSync } = await import('child_process');
            execSync('python --version', { stdio: 'ignore' });
            this.cachedPythonCommand = 'python';
            return {
                success: true,
                command: 'python',
                warning: `Using system Python. For better results, configure 'nukeVisualizer.pythonPath' or 'nukeVisualizer.condaEnv'.`
            };
        } catch {
            // 5. Try 'python3' in PATH
            try {
                const { execSync } = await import('child_process');
                execSync('python3 --version', { stdio: 'ignore' });
                this.cachedPythonCommand = 'python3';
                return {
                    success: true,
                    command: 'python3',
                    warning: `Using system Python. For better results, configure 'nukeVisualizer.pythonPath' or 'nukeVisualizer.condaEnv'.`
                };
            } catch {
                return {
                    success: false,
                    error: 'Could not find Python. Please configure nukeVisualizer.pythonPath or nukeVisualizer.condaEnv in preferences.'
                };
            }
        }
    }

    private async findCondaPython(envName: string): Promise<string | undefined> {
        try {
            const { execSync } = await import('child_process');
            
            // Get conda base path
            const condaBase = execSync('conda info --base', { 
                encoding: 'utf-8', 
                stdio: ['pipe', 'pipe', 'ignore'] 
            }).trim();
            
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

    private async listCondaEnvironments(): Promise<PythonEnvironment[]> {
        const environments: PythonEnvironment[] = [];
        
        try {
            const { execSync } = await import('child_process');
            const output = execSync('conda env list --json', {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            });
            
            const envList = JSON.parse(output);
            const isWindows = process.platform === 'win32';
            
            for (const env of envList.envs || []) {
                const pythonPath = isWindows
                    ? `${env}/python.exe`
                    : `${env}/bin/python`;
                
                const { existsSync } = await import('fs');
                if (existsSync(pythonPath)) {
                    const envName = env.split('/').pop() || env.split('\\').pop() || 'unknown';
                    const envInfo = await this.getEnvironmentInfo(pythonPath, 'conda');
                    if (envInfo) {
                        envInfo.name = envName === 'bin' ? 'base' : envName;
                        environments.push(envInfo);
                    }
                }
            }
        } catch {
            // Conda not available
        }
        
        return environments;
    }

    private async getEnvironmentInfo(
        pythonPath: string,
        type: PythonEnvironment['type']
    ): Promise<PythonEnvironment | undefined> {
        try {
            const { execSync } = await import('child_process');
            
            // Get Python version
            const versionOutput = execSync(`"${pythonPath}" --version`, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'ignore']
            }).trim();
            const versionMatch = versionOutput.match(/Python (\d+\.\d+\.\d+)/);
            const version = versionMatch ? versionMatch[1] : undefined;
            
            // Check for OpenMC
            let hasOpenMC = false;
            let openmcVersion: string | undefined;
            try {
                const openmcOutput = execSync(
                    `"${pythonPath}" -c "import openmc; print(openmc.__version__)"`,
                    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
                ).trim();
                hasOpenMC = true;
                openmcVersion = openmcOutput;
            } catch {
                // OpenMC not available
            }
            
            return {
                name: type === 'system' ? `System Python ${version || ''}`.trim() : pythonPath,
                pythonPath,
                type,
                version,
                hasOpenMC,
                openmcVersion
            };
        } catch {
            return undefined;
        }
    }
}
