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
    ListEnvironmentsResult,
    PackageDependency,
    DependencyCheckResult,
    PythonDetectionOptions
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

    async detectPythonWithRequirements(
        options: PythonDetectionOptions
    ): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
        const { requiredPackages = [], autoDetectEnvs = [] } = options;
        const errors: string[] = [];
        const warnings: string[] = [];

        // Helper to test Python with dependencies
        const testPythonWithDeps = async (pythonPath: string): Promise<{ success: boolean; missing: string[] }> => {
            if (requiredPackages.length === 0) {
                return { success: true, missing: [] };
            }
            const result = await this.checkDependencies(requiredPackages, pythonPath);
            return { success: result.available, missing: result.missing };
        };

        // 1. Try explicitly configured Python path first
        if (this.config.pythonPath) {
            try {
                const { execSync } = await import('child_process');
                execSync(`"${this.config.pythonPath}" --version`, { stdio: 'ignore' });
                
                const depCheck = await testPythonWithDeps(this.config.pythonPath);
                if (depCheck.success) {
                    this.cachedPythonCommand = this.config.pythonPath;
                    return { success: true, command: this.config.pythonPath };
                } else {
                    errors.push(`Configured Python at ${this.config.pythonPath} is missing: ${depCheck.missing.join(', ')}`);
                    warnings.push(`Configured Python is missing required packages. Using fallback.`);
                }
            } catch {
                errors.push(`Configured Python path not valid: ${this.config.pythonPath}`);
            }
        }

        // 2. Try conda environment
        if (this.config.condaEnv) {
            const condaPython = await this.findCondaPython(this.config.condaEnv);
            if (condaPython) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachedPythonCommand = condaPython;
                    return { 
                        success: true, 
                        command: condaPython,
                        warning: warnings.length > 0 ? warnings.join(' ') : undefined
                    };
                } else {
                    errors.push(`Conda env '${this.config.condaEnv}' is missing: ${depCheck.missing.join(', ')}`);
                }
            } else {
                errors.push(`Conda environment '${this.config.condaEnv}' not found`);
            }
        }

        // 3. Check CONDA_PREFIX env var (if shell has activated conda)
        const condaPrefix = process.env.CONDA_PREFIX;
        if (condaPrefix) {
            const path = await import('path');
            const condaPython = path.join(condaPrefix, 'bin', 'python');
            const { existsSync } = await import('fs');
            if (existsSync(condaPython)) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachedPythonCommand = condaPython;
                    const envName = path.basename(condaPrefix);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using active conda environment '${envName}'.` 
                        : `Using active conda environment '${envName}'.`;
                    return { success: true, command: condaPython, warning };
                } else {
                    errors.push(`Active conda env '${path.basename(condaPrefix)}' is missing: ${depCheck.missing.join(', ')}`);
                }
            }
        }

        // 4. Try auto-detect conda environments (in order)
        for (const envName of autoDetectEnvs) {
            const condaPython = await this.findCondaPython(envName);
            if (condaPython) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachedPythonCommand = condaPython;
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using auto-detected conda environment '${envName}'.` 
                        : `Using auto-detected conda environment '${envName}'. Configure 'nuke.condaEnv' to use a specific environment.`;
                    return { success: true, command: condaPython, warning };
                } else {
                    errors.push(`Auto-detected conda env '${envName}' is missing: ${depCheck.missing.join(', ')}`);
                }
            }
        }

        // 4. Try 'python' in PATH
        try {
            const { execSync } = await import('child_process');
            execSync('python --version', { stdio: 'ignore' });
            const depCheck = await testPythonWithDeps('python');
            if (depCheck.success) {
                this.cachedPythonCommand = 'python';
                const warning = warnings.length > 0 
                    ? `${warnings.join(' ')} Using system Python.` 
                    : `Using system Python. For better results, configure 'nuke.pythonPath' or 'nuke.condaEnv'.`;
                return { success: true, command: 'python', warning };
            } else {
                errors.push(`System Python is missing: ${depCheck.missing.join(', ')}`);
            }
        } catch {
            // not found
        }

        // 7. Try 'python3' in PATH
        try {
            const { execSync } = await import('child_process');
            execSync('python3 --version', { stdio: 'ignore' });
            const depCheck = await testPythonWithDeps('python3');
            if (depCheck.success) {
                this.cachedPythonCommand = 'python3';
                const warning = warnings.length > 0 
                    ? `${warnings.join(' ')} Using system Python 3.` 
                    : `Using system Python 3. For better results, configure 'nuke.pythonPath' or 'nuke.condaEnv'.`;
                return { success: true, command: 'python3', warning };
            } else {
                errors.push(`System Python 3 is missing: ${depCheck.missing.join(', ')}`);
            }
        } catch {
            // not found
        }

        // No suitable Python found
        const errorMessage = `Unable to find a Python interpreter with required packages.\n\n` +
            `Required packages: ${requiredPackages.map(p => p.name).join(', ')}\n\n` +
            `Details:\n${errors.map(e => '  • ' + e).join('\n')}`;
        
        return {
            success: false,
            error: errorMessage
        };
    }

    async checkDependencies(packages: PackageDependency[], pythonPath?: string): Promise<DependencyCheckResult> {
        const targetPython = pythonPath || this.cachedPythonCommand || 'python';
        const missing: string[] = [];
        const versions: Record<string, string> = {};

        const { execSync } = await import('child_process');

        for (const pkg of packages) {
            try {
                // Try to get version
                const versionCmd = pkg.submodule 
                    ? `import ${pkg.name}.${pkg.submodule}; print(${pkg.name}.${pkg.submodule}.__version__)`
                    : `import ${pkg.name}; print(${pkg.name}.__version__)`;
                
                try {
                    const version = execSync(
                        `"${targetPython}" -c "${versionCmd}"`,
                        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
                    ).trim();
                    versions[pkg.name] = version;
                } catch {
                    // Version check failed, but package might still be importable
                    execSync(`"${targetPython}" -c "import ${pkg.name}${pkg.submodule ? '.' + pkg.submodule : ''}"`, 
                        { stdio: 'ignore' });
                    versions[pkg.name] = 'installed (version unknown)';
                }
            } catch {
                if (pkg.required !== false) {
                    missing.push(pkg.name);
                }
            }
        }

        return {
            available: missing.length === 0,
            missing,
            versions
        };
    }

    private async doDetectPython(): Promise<PythonDetectionResult> {
        // Use the new method with no requirements
        const result = await this.detectPythonWithRequirements({});
        return {
            success: result.success,
            command: result.command,
            warning: result.warning,
            error: result.error
        };
    }

    private async findCondaPython(envName: string): Promise<string | undefined> {
        const { execSync } = await import('child_process');
        const { existsSync } = await import('fs');
        const path = await import('path');
        const os = await import('os');
        
        // Try 1: Use conda info --base (most reliable if conda is available)
        try {
            const condaBase = execSync('conda info --base', { 
                encoding: 'utf-8', 
                stdio: ['pipe', 'pipe', 'ignore'] 
            }).trim();
            
            const isWindows = process.platform === 'win32';
            const pythonPath = isWindows
                ? path.join(condaBase, 'envs', envName, 'python.exe')
                : path.join(condaBase, 'envs', envName, 'bin', 'python');
            
            if (existsSync(pythonPath)) {
                return pythonPath;
            }
        } catch {
            // Conda command not available, fall through to hardcoded paths
        }
        
        // Try 2: Search common conda installation paths
        const homeDir = os.homedir();
        const isWindows = process.platform === 'win32';
        
        const condaBasePaths = isWindows ? [
            path.join(homeDir, '.conda', 'envs'),
            path.join(homeDir, 'Anaconda3', 'envs'),
            path.join(homeDir, 'Miniconda3', 'envs'),
            path.join(homeDir, 'mambaforge', 'envs'),
            path.join(homeDir, 'miniforge', 'envs'),
            'C:\\ProgramData\\Anaconda3\\envs',
            'C:\\ProgramData\\Miniconda3\\envs',
        ] : [
            path.join(homeDir, '.conda', 'envs'),
            path.join(homeDir, 'anaconda3', 'envs'),
            path.join(homeDir, 'miniconda3', 'envs'),
            path.join(homeDir, 'mambaforge', 'envs'),
            path.join(homeDir, 'miniforge', 'envs'),
            '/opt/conda/envs',
            '/opt/miniconda3/envs',
            '/opt/anaconda3/envs',
            '/opt/mambaforge/envs',
            '/opt/miniforge/envs',
            '/usr/local/conda/envs',
            '/usr/local/miniconda3/envs',
            '/usr/local/anaconda3/envs',
            '/usr/local/mambaforge/envs',
            '/usr/local/miniforge/envs',
        ];
        
        for (const condaPath of condaBasePaths) {
            const envPython = isWindows
                ? path.join(condaPath, envName, 'python.exe')
                : path.join(condaPath, envName, 'bin', 'python');
            if (existsSync(envPython)) {
                return envPython;
            }
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
            
            return {
                name: type === 'system' ? `System Python ${version || ''}`.trim() : pythonPath,
                pythonPath,
                type,
                version
            };
        } catch {
            return undefined;
        }
    }
}
