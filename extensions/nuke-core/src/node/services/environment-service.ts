// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

/**
 * Environment Service
 * 
 * Handles Python environment detection and management.
 * 
 * @module nuke-core/node
 */

import { injectable } from '@theia/core/shared/inversify';
import {
    PythonConfig,
    NukeEnvironment,
    PythonDetectionResult,
    ListEnvironmentsResult,
    PackageDependency,
    PythonDetectionOptions
} from '../../common/nuke-core-protocol';

@injectable()
export class EnvironmentService {
    
    private config: PythonConfig = {};
    private cachedPythonCommand?: string;
    private environmentsCache?: NukeEnvironment[];
    private environmentsCacheTime?: number;
    private readonly CACHE_TTL = 30000; // 30 seconds

    setConfig(config: PythonConfig): void {
        this.config = { ...config };
        this.clearCache();
    }

    getConfig(): PythonConfig {
        return { ...this.config };
    }

    clearCache(): void {
        this.cachedPythonCommand = undefined;
        // Environment cache cleared via cachedPythonCommand
        this.environmentsCache = undefined;
        this.environmentsCacheTime = undefined;
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

    private async doDetectPython(): Promise<PythonDetectionResult> {
        // Try configured path first
        if (this.config.pythonPath) {
            try {
                const { execSync } = await import('child_process');
                execSync(`"${this.config.pythonPath}" --version`, { stdio: 'ignore' });
                const env = await this.getEnvironmentInfo(this.config.pythonPath, 'system');
                if (env) {
                    this.cachePythonResult(this.config.pythonPath, env);
                    return { success: true, command: this.config.pythonPath, environment: env };
                }
            } catch {
                // Fall through to other methods
            }
        }

        // Try conda environment
        if (this.config.condaEnv) {
            const condaPython = await this.findCondaPython(this.config.condaEnv);
            if (condaPython) {
                const env = await this.getEnvironmentInfo(condaPython, 'conda');
                if (env) {
                    this.cachePythonResult(condaPython, env);
                    return { success: true, command: condaPython, environment: env };
                }
            }
        }

        // Try system Python
        for (const cmd of ['python3', 'python']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                const env = await this.getEnvironmentInfo(cmd, 'system');
                if (env) {
                    this.cachePythonResult(cmd, env);
                    return { success: true, command: cmd, environment: env };
                }
            } catch {
                // Try next
            }
        }

        return { success: false, error: 'No Python environment found' };
    }

    async detectPythonWithRequirements(
        options: PythonDetectionOptions
    ): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
        const { requiredPackages = [], autoDetectEnvs = [], searchWorkspaceVenvs = false } = options;
        const warnings: string[] = [];
        const errors: string[] = [];

        // Helper to test Python with dependencies
        const testPythonWithDeps = async (pythonPath: string): Promise<{
            success: boolean;
            missing: string[];
            mismatches: string[];
            env?: NukeEnvironment;
        }> => {
            try {
                const env = await this.getEnvironmentInfo(pythonPath, 'system');
                if (!env) {
                    return { success: false, missing: ['Python not valid'], mismatches: [] };
                }

                // Check each required package
                const missing: string[] = [];
                const mismatches: string[] = [];

                for (const pkg of requiredPackages) {
                    try {
                        const { execSync } = await import('child_process');
                        const versionCmd = pkg.submodule
                            ? `import ${pkg.name}.${pkg.submodule}; print(${pkg.name}.${pkg.submodule}.__version__)`
                            : `import ${pkg.name}; print(${pkg.name}.__version__)`;
                        
                        execSync(`"${pythonPath}" -c "${versionCmd}"`, { stdio: 'ignore' });
                    } catch {
                        if (pkg.required !== false) {
                            missing.push(pkg.name);
                        }
                    }
                }

                return { success: missing.length === 0, missing, mismatches, env };
            } catch {
                return { success: false, missing: ['Python check failed'], mismatches: [] };
            }
        };

        // Try configured Python path first
        if (this.config.pythonPath) {
            try {
                const depCheck = await testPythonWithDeps(this.config.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(this.config.pythonPath, depCheck.env!);
                    return { success: true, command: this.config.pythonPath, environment: depCheck.env };
                } else {
                    if (depCheck.missing.length > 0) {
                        errors.push(`Configured Python missing: ${depCheck.missing.join(', ')}`);
                    }
                    warnings.push(`Configured Python path does not have required packages.`);
                }
            } catch {
                errors.push(`Configured Python path not valid: ${this.config.pythonPath}`);
            }
        }

        // Try conda environment
        if (this.config.condaEnv) {
            const condaPython = await this.findCondaPython(this.config.condaEnv);
            if (condaPython) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachePythonResult(condaPython, depCheck.env!);
                    return { success: true, command: condaPython, warning: warnings.join(' '), environment: depCheck.env };
                } else {
                    errors.push(`Conda env '${this.config.condaEnv}' missing: ${depCheck.missing.join(', ')}`);
                    warnings.push(`Configured conda environment '${this.config.condaEnv}' does not have required packages.`);
                }
            } else {
                errors.push(`Conda environment '${this.config.condaEnv}' not found`);
            }
        }

        // Search ALL environments for ones with required packages
        if (requiredPackages.length > 0) {
            const matchingEnvironments = await this.findEnvironmentsWithPackages(requiredPackages, autoDetectEnvs);
            
            if (matchingEnvironments.length > 0) {
                const bestMatch = matchingEnvironments[0];
                this.cachePythonResult(bestMatch.pythonPath, bestMatch);
                const warning = warnings.length > 0 
                    ? `${warnings.join(' ')} Using '${bestMatch.name}' with all required packages.` 
                    : `Using '${bestMatch.name}' with all required packages. Configure 'nuke.condaEnv' or 'nuke.pythonPath' to use a specific environment.`;
                return { success: true, command: bestMatch.pythonPath, warning, environment: bestMatch };
            }
        }

        // Try auto-detect conda environments by name
        for (const envName of autoDetectEnvs) {
            const condaPython = await this.findCondaPython(envName);
            if (condaPython) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachePythonResult(condaPython, depCheck.env!);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using auto-detected conda environment '${envName}'.` 
                        : `Using auto-detected conda environment '${envName}'. Configure 'nuke.condaEnv' to use a specific environment.`;
                    return { success: true, command: condaPython, warning, environment: depCheck.env };
                } else {
                    errors.push(`Auto-detected conda env '${envName}' missing: ${depCheck.missing.join(', ')}`);
                }
            }
        }

        // Try venvs in workspace
        if (searchWorkspaceVenvs) {
            const venvEnvs = await this.findWorkspaceVenvs();
            for (const env of venvEnvs) {
                const depCheck = await testPythonWithDeps(env.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(env.pythonPath, depCheck.env!);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using workspace venv '${env.name}'.` 
                        : `Using workspace venv '${env.name}'. Configure 'nuke.pythonPath' to use a specific environment.`;
                    return { success: true, command: env.pythonPath, warning, environment: depCheck.env };
                }
            }
        }

        // Try system Python
        for (const cmd of ['python', 'python3']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                const depCheck = await testPythonWithDeps(cmd);
                if (depCheck.success) {
                    this.cachePythonResult(cmd, depCheck.env!);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using system Python.` 
                        : `Using system Python. For better results, configure 'nuke.pythonPath' or 'nuke.condaEnv'.`;
                    return { success: true, command: cmd, warning, environment: depCheck.env };
                }
            } catch {
                // not found
            }
        }

        // No suitable Python found
        const errorMessage = `Unable to find an environment with required packages.\n\n` +
            `Required: ${requiredPackages.map(p => p.name).join(', ')}\n\n` +
            `Details:\n${errors.map(e => '  • ' + e).join('\n')}`;
        
        return {
            success: false,
            error: errorMessage,
            missingPackages: errors.filter(e => e.includes('missing')).map(e => e.split('missing: ')[1]?.split(', ')).flat().filter(Boolean) as string[]
        };
    }

    private async findEnvironmentsWithPackages(
        requiredPackages: PackageDependency[],
        preferredEnvNames: string[]
    ): Promise<Array<NukeEnvironment & { missingPackages: string[]; score: number }>> {
        const matchingEnvs: Array<NukeEnvironment & { missingPackages: string[]; score: number }> = [];
        const allEnvsResult = await this.listEnvironments(true);
        const allEnvs = allEnvsResult.environments;

        for (const env of allEnvs) {
            try {
                const result = await this.checkPackages(requiredPackages, env.pythonPath);
                
                let score = 0;
                const foundPackages = Object.keys(result.versions);
                score += foundPackages.length * 10;
                score += (requiredPackages.length - result.missing.length) * 10;
                
                if (preferredEnvNames.includes(env.name)) {
                    score += 20;
                }
                
                matchingEnvs.push({
                    ...env,
                    missingPackages: result.missing,
                    score
                });
            } catch {
                // Skip failed environments
            }
        }
        
        return matchingEnvs.sort((a, b) => {
            const aComplete = a.missingPackages.length === 0;
            const bComplete = b.missingPackages.length === 0;
            
            if (aComplete && !bComplete) return -1;
            if (!aComplete && bComplete) return 1;
            
            return b.score - a.score;
        });
    }

    async checkPackages(packages: PackageDependency[], pythonPath: string): Promise<{
        available: boolean;
        missing: string[];
        versionMismatches: Array<{ name: string; found: string; required: string }>;
        versions: Record<string, string>;
    }> {
        const missing: string[] = [];
        const versionMismatches: Array<{ name: string; found: string; required: string }> = [];
        const versions: Record<string, string> = {};

        const { execSync } = await import('child_process');

        for (const pkg of packages) {
            try {
                const versionCmd = pkg.submodule
                    ? `import ${pkg.name}.${pkg.submodule}; print(${pkg.name}.${pkg.submodule}.__version__)`
                    : `import ${pkg.name}; print(${pkg.name}.__version__)`;
                
                try {
                    const version = execSync(
                        `"${pythonPath}" -c "${versionCmd}"`,
                        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
                    ).trim();
                    versions[pkg.name] = version;

                    if (pkg.minVersion && this.compareVersions(version, pkg.minVersion) < 0) {
                        versionMismatches.push({ name: pkg.name, found: version, required: `>=${pkg.minVersion}` });
                    }
                } catch {
                    execSync(`"${pythonPath}" -c "import ${pkg.name}${pkg.submodule ? '.' + pkg.submodule : ''}"`, 
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
            available: missing.length === 0 && versionMismatches.length === 0,
            missing,
            versionMismatches,
            versions
        };
    }

    async listEnvironments(searchWorkspace = false): Promise<ListEnvironmentsResult> {
        if (this.environmentsCache && this.environmentsCacheTime && 
            Date.now() - this.environmentsCacheTime < this.CACHE_TTL && !searchWorkspace) {
            return this.filterAndSortEnvironments(this.environmentsCache);
        }

        const environments: NukeEnvironment[] = [];
        
        // Try configured Python path
        if (this.config.pythonPath) {
            try {
                const env = await this.getEnvironmentInfo(this.config.pythonPath, 'system');
                if (env) {
                    env.isActive = true;
                    environments.push(env);
                }
            } catch {
                // Ignore
            }
        }
        
        // Try conda environments
        try {
            const condaEnvs = await this.findCondaEnvironments();
            for (const env of condaEnvs) {
                if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                    if (env.pythonPath === this.config.pythonPath || env.name === this.config.condaEnv) {
                        env.isActive = true;
                    }
                    environments.push(env);
                }
            }
        } catch {
            // Conda not available
        }
        
        // Try workspace venvs
        if (searchWorkspace) {
            try {
                const venvs = await this.findWorkspaceVenvs();
                for (const env of venvs) {
                    if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                        environments.push(env);
                    }
                }
            } catch {
                // Ignore
            }
        }
        
        // Cache results
        this.environmentsCache = environments;
        this.environmentsCacheTime = Date.now();
        
        return this.filterAndSortEnvironments(environments);
    }

    private filterAndSortEnvironments(environments: NukeEnvironment[]): ListEnvironmentsResult {
        const uniqueEnvs = environments.filter((env, index, self) =>
            index === self.findIndex(e => e.pythonPath === env.pythonPath)
        );
        
        const sortedEnvs = uniqueEnvs.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return a.name.localeCompare(b.name);
        });
        
        const selected = sortedEnvs.find(e => e.isActive) || sortedEnvs[0];
        
        return { environments: sortedEnvs, selected };
    }

    private async findCondaEnvironments(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        
        try {
            const { execSync } = await import('child_process');
            const output = execSync('conda env list --json', { encoding: 'utf-8' });
            const result = JSON.parse(output);
            
            for (const env of result.envs) {
                const path = await import('path');
                const name = path.basename(env);
                const pythonPath = path.join(env, 'bin', 'python');
                const fs = await import('fs');
                
                if (fs.existsSync(pythonPath)) {
                    const envInfo = await this.getEnvironmentInfo(pythonPath, 'conda');
                    if (envInfo) {
                        envInfo.name = name === 'bin' ? 'base' : name;
                        environments.push(envInfo);
                    }
                }
            }
        } catch {
            // Conda not available or error
        }
        
        return environments;
    }

    private async findCondaPython(envName: string): Promise<string | undefined> {
        try {
            const { execSync } = await import('child_process');
            const output = execSync(`conda run -n ${envName} which python`, { encoding: 'utf-8' });
            return output.trim();
        } catch {
            // Try direct path
            try {
                const path = await import('path');
                const os = await import('os');
                const homeDir = os.homedir();
                const pythonPath = path.join(homeDir, 'anaconda3', 'envs', envName, 'bin', 'python');
                const fs = await import('fs');
                if (fs.existsSync(pythonPath)) {
                    return pythonPath;
                }
            } catch {
                // Not found
            }
        }
        return undefined;
    }

    async findWorkspaceVenvs(): Promise<NukeEnvironment[]> {
        const environments: NukeEnvironment[] = [];
        
        try {
            const workspaceRoot = process.cwd();
            
            const commonVenvNames = ['venv', '.venv', 'env', '.env', 'virtualenv'];
            const fs = await import('fs');
            const path = await import('path');
            
            for (const venvName of commonVenvNames) {
                const venvPath = path.join(workspaceRoot, venvName);
                const pythonPath = path.join(venvPath, 'bin', 'python');
                
                if (fs.existsSync(pythonPath)) {
                    const env = await this.getEnvironmentInfo(pythonPath, 'venv');
                    if (env) {
                        env.name = `${venvName} (workspace)`;
                        environments.push(env);
                    }
                }
            }
        } catch {
            // Ignore errors
        }
        
        return environments;
    }

    private async getEnvironmentInfo(pythonPath: string, type: NukeEnvironment['type']): Promise<NukeEnvironment | undefined> {
        try {
            const { execSync } = await import('child_process');
            const versionOutput = execSync(`"${pythonPath}" --version`, { encoding: 'utf-8' }).trim();
            const versionMatch = versionOutput.match(/Python (\d+\.\d+\.\d+)/);
            const version = versionMatch ? versionMatch[1] : undefined;
            
            let name = type === 'system' ? 'system' : 'venv';
            
            // Try to get better name for conda environments
            if (type === 'conda') {
                try {
                    const path = await import('path');
                    name = path.basename(path.dirname(pythonPath));
                    if (name === 'bin') name = 'base';
                } catch {
                    // Use default
                }
            }
            
            const path = await import('path');
            const envPath = path.dirname(path.dirname(pythonPath));
            
            return {
                name,
                pythonPath,
                type,
                version,
                envPath
            };
        } catch {
            return undefined;
        }
    }

    private cachePythonResult(command: string, _env: NukeEnvironment): void {
        this.cachedPythonCommand = command;
    }

    private compareVersions(v1: string, v2: string): number {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);
        
        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;
            
            if (p1 < p2) return -1;
            if (p1 > p2) return 1;
        }
        
        return 0;
    }
}
