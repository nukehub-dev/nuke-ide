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
    PythonDetectionOptions,
    PackageInstallOptions,
    PackageInstallResult,
    HealthCheckResult,
    HealthCheckItem,
    ConfigValidationResult,
    ConfigValidationError,
    ConfigValidationWarning
} from '../common/nuke-core-protocol';

@injectable()
export class NukeCoreBackendServiceImpl implements NukeCoreBackendServiceInterface {
    
    private config: PythonConfig = {};
    private cachedPythonCommand?: string;
    private cachedEnvironment?: PythonEnvironment;
    private environmentsCache?: PythonEnvironment[];
    private environmentsCacheTime?: number;
    private readonly CACHE_TTL = 30000; // 30 seconds

    async setConfig(config: PythonConfig): Promise<void> {
        this.config = { ...config };
        this.clearCache();
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

    async listEnvironments(searchWorkspace = false): Promise<ListEnvironmentsResult> {
        // Use cache if available and not expired
        if (this.environmentsCache && this.environmentsCacheTime && 
            Date.now() - this.environmentsCacheTime < this.CACHE_TTL && !searchWorkspace) {
            return this.filterAndSortEnvironments(this.environmentsCache);
        }

        const environments: PythonEnvironment[] = [];
        
        // 1. Try configured Python path
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
        
        // 2. Try conda environments
        const condaEnvs = await this.listCondaEnvironments();
        for (const env of condaEnvs) {
            if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                environments.push(env);
            }
        }
        
        // 3. Try venv/virtualenv environments in workspace
        if (searchWorkspace) {
            const venvEnvs = await this.findWorkspaceVenvs();
            for (const env of venvEnvs) {
                if (!environments.find(e => e.pythonPath === env.pythonPath)) {
                    environments.push(env);
                }
            }
        }
        
        // 4. Try system Python
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

        // Update cache
        this.environmentsCache = environments;
        this.environmentsCacheTime = Date.now();
        
        return this.filterAndSortEnvironments(environments);
    }

    private filterAndSortEnvironments(environments: PythonEnvironment[]): ListEnvironmentsResult {
        // Mark selected environment
        let selected: PythonEnvironment | undefined;
        
        if (this.config.pythonPath) {
            selected = environments.find(e => e.pythonPath === this.config.pythonPath);
        } else if (this.config.condaEnv) {
            selected = environments.find(e => 
                e.type === 'conda' && e.name === this.config.condaEnv
            );
        }

        // Sort: selected first, then by type, then by name
        const sorted = [...environments].sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            const typeOrder = { 'conda': 0, 'venv': 1, 'virtualenv': 2, 'poetry': 3, 'pyenv': 4, 'system': 5 };
            if (typeOrder[a.type] !== typeOrder[b.type]) {
                return typeOrder[a.type] - typeOrder[b.type];
            }
            return a.name.localeCompare(b.name);
        });

        return { environments: sorted, selected };
    }

    async detectPythonWithRequirements(
        options: PythonDetectionOptions
    ): Promise<PythonDetectionResult & { missingPackages?: string[] }> {
        const { requiredPackages = [], autoDetectEnvs = [], searchWorkspaceVenvs = false } = options;
        const errors: string[] = [];
        const warnings: string[] = [];

        // Helper to test Python with dependencies
        const testPythonWithDeps = async (pythonPath: string): Promise<{ 
            success: boolean; 
            missing: string[];
            mismatches: string[];
            env?: PythonEnvironment;
        }> => {
            if (requiredPackages.length === 0) {
                const env = await this.getEnvironmentInfo(pythonPath, 'system');
                return { success: true, missing: [], mismatches: [], env };
            }
            const result = await this.checkDependencies(requiredPackages, pythonPath);
            const env = await this.getEnvironmentInfo(pythonPath, 'system');
            return { 
                success: result.available, 
                missing: result.missing,
                mismatches: result.versionMismatches.map(m => `${m.name} (found: ${m.found}, required: ${m.required})`),
                env
            };
        };

        // 1. Try explicitly configured Python path first
        if (this.config.pythonPath) {
            try {
                const { execSync } = await import('child_process');
                execSync(`"${this.config.pythonPath}" --version`, { stdio: 'ignore' });
                
                const depCheck = await testPythonWithDeps(this.config.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(this.config.pythonPath, depCheck.env);
                    return { success: true, command: this.config.pythonPath, environment: depCheck.env };
                } else {
                    if (depCheck.missing.length > 0) {
                        errors.push(`Configured Python at ${this.config.pythonPath} is missing: ${depCheck.missing.join(', ')}`);
                    }
                    if (depCheck.mismatches.length > 0) {
                        warnings.push(`Version mismatches: ${depCheck.mismatches.join(', ')}`);
                    }
                    warnings.push(`Configured environment is missing required packages. Using fallback.`);
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
                    this.cachePythonResult(condaPython, depCheck.env);
                    return { 
                        success: true, 
                        command: condaPython,
                        warning: warnings.length > 0 ? warnings.join(' ') : undefined,
                        environment: depCheck.env
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
                    this.cachePythonResult(condaPython, depCheck.env);
                    const envName = path.basename(condaPrefix);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using active conda environment '${envName}'.` 
                        : `Using active conda environment '${envName}'.`;
                    return { success: true, command: condaPython, warning, environment: depCheck.env };
                } else {
                    errors.push(`Active conda env '${path.basename(condaPrefix)}' is missing: ${depCheck.missing.join(', ')}`);
                }
            }
        }

        // 4. SMART AUTO-DETECTION: Search ALL environments for ones with required packages
        if (requiredPackages.length > 0) {
            const matchingEnvironments = await this.findEnvironmentsWithPackages(requiredPackages, autoDetectEnvs);
            
            if (matchingEnvironments.length > 0) {
                // Return the first (best) match
                const bestMatch = matchingEnvironments[0];
                this.cachePythonResult(bestMatch.pythonPath, bestMatch);
                const warning = warnings.length > 0 
                    ? `${warnings.join(' ')} Using '${bestMatch.name}' with all required packages.` 
                    : `Using '${bestMatch.name}' with all required packages. Configure 'nuke.condaEnv' or 'nuke.pythonPath' to use a specific environment.`;
                return { success: true, command: bestMatch.pythonPath, warning, environment: bestMatch };
            }
        }

        // 5. Legacy: Try auto-detect conda environments by name (for backwards compatibility)
        for (const envName of autoDetectEnvs) {
            const condaPython = await this.findCondaPython(envName);
            if (condaPython) {
                const depCheck = await testPythonWithDeps(condaPython);
                if (depCheck.success) {
                    this.cachePythonResult(condaPython, depCheck.env);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using auto-detected conda environment '${envName}'.` 
                        : `Using auto-detected conda environment '${envName}'. Configure 'nuke.condaEnv' to use a specific environment.`;
                    return { success: true, command: condaPython, warning, environment: depCheck.env };
                } else {
                    errors.push(`Auto-detected conda env '${envName}' is missing: ${depCheck.missing.join(', ')}`);
                }
            }
        }

        // 6. Try venvs in workspace if enabled
        if (searchWorkspaceVenvs) {
            const venvEnvs = await this.findWorkspaceVenvs();
            for (const env of venvEnvs) {
                const depCheck = await testPythonWithDeps(env.pythonPath);
                if (depCheck.success) {
                    this.cachePythonResult(env.pythonPath, depCheck.env);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using workspace venv '${env.name}'.` 
                        : `Using workspace venv '${env.name}'. Configure 'nuke.pythonPath' to use a specific environment.`;
                    return { success: true, command: env.pythonPath, warning, environment: depCheck.env };
                }
            }
        }

        // 7. Try 'python' in PATH
        for (const cmd of ['python', 'python3']) {
            try {
                const { execSync } = await import('child_process');
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                const depCheck = await testPythonWithDeps(cmd);
                if (depCheck.success) {
                    this.cachePythonResult(cmd, depCheck.env);
                    const warning = warnings.length > 0 
                        ? `${warnings.join(' ')} Using system Python.` 
                        : `Using system Python. For better results, configure 'nuke.pythonPath' or 'nuke.condaEnv'.`;
                    return { success: true, command: cmd, warning, environment: depCheck.env };
                } else {
                    errors.push(`System ${cmd} is missing: ${depCheck.missing.join(', ')}`);
                }
            } catch {
                // not found
            }
        }

        // No suitable Python found
        const errorMessage = `Unable to find an environment with required packages.\n\n` +
            `Required packages: ${requiredPackages.map(p => p.name).join(', ')}\n\n` +
            `Details:\n${errors.map(e => '  • ' + e).join('\n')}`;
        
        return {
            success: false,
            error: errorMessage,
            missingPackages: errors.filter(e => e.includes('missing')).map(e => e.split('missing: ')[1]?.split(', ')).flat().filter(Boolean)
        };
    }

    /**
     * Smart search: Find ALL environments that have the required packages.
     * Returns them sorted by best match (most packages, correct versions).
     */
    private async findEnvironmentsWithPackages(
        requiredPackages: PackageDependency[],
        preferredEnvNames: string[]
    ): Promise<Array<PythonEnvironment & { missingPackages: string[]; score: number }>> {
        const matchingEnvs: Array<PythonEnvironment & { missingPackages: string[]; score: number }> = [];
        
        // Get all environments
        const allEnvsResult = await this.listEnvironments(true);
        const allEnvs = allEnvsResult.environments;
        
        // Check each environment
        for (const env of allEnvs) {
            try {
                const result = await this.checkDependencies(requiredPackages, env.pythonPath);
                
                // Calculate score: higher is better
                // +10 for each package found
                // +5 for each correct version
                // +20 if environment name matches preferred names
                let score = 0;
                const foundPackages = Object.keys(result.versions);
                score += foundPackages.length * 10;
                score += (requiredPackages.length - result.missing.length) * 10;
                
                if (preferredEnvNames.includes(env.name)) {
                    score += 20;
                }
                
                // Even if not all packages are found, we track it (for install suggestions)
                matchingEnvs.push({
                    ...env,
                    missingPackages: result.missing,
                    score
                });
                
            } catch {
                // Environment check failed, skip it
            }
        }
        
        // Sort by score (descending), then by whether all packages are available
        return matchingEnvs.sort((a, b) => {
            // Prioritize environments with all packages
            const aComplete = a.missingPackages.length === 0;
            const bComplete = b.missingPackages.length === 0;
            
            if (aComplete && !bComplete) return -1;
            if (!aComplete && bComplete) return 1;
            
            // Then by score
            return b.score - a.score;
        });
    }

    async checkDependencies(packages: PackageDependency[], pythonPath?: string): Promise<DependencyCheckResult> {
        const targetPython = pythonPath || this.cachedPythonCommand || 'python';
        const missing: string[] = [];
        const versionMismatches: Array<{ name: string; found: string; required: string }> = [];
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

                    // Check minimum version if specified
                    if (pkg.minVersion && this.compareVersions(version, pkg.minVersion) < 0) {
                        versionMismatches.push({ name: pkg.name, found: version, required: `>=${pkg.minVersion}` });
                    }
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
            available: missing.length === 0 && versionMismatches.length === 0,
            missing,
            versionMismatches,
            versions
        };
    }

    async installPackages(options: PackageInstallOptions): Promise<PackageInstallResult> {
        const { packages, pythonPath, useConda = false, extraArgs = [] } = options;
        const targetPython = pythonPath || this.cachedPythonCommand || 'python';
        
        const installed: string[] = [];
        const failed: string[] = [];
        let output = '';

        try {
            const { execSync } = await import('child_process');

            if (useConda) {
                // Try conda install
                try {
                    const cmd = `conda install -y ${packages.join(' ')} ${extraArgs.join(' ')}`;
                    output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
                    installed.push(...packages);
                } catch (error: any) {
                    output = error.stdout || error.message;
                    // Fall back to pip
                    for (const pkg of packages) {
                        try {
                            const cmd = `"${targetPython}" -m pip install ${pkg} ${extraArgs.join(' ')}`;
                            execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
                            installed.push(pkg);
                        } catch (e: any) {
                            failed.push(pkg);
                            output += '\n' + (e.stdout || e.message);
                        }
                    }
                }
            } else {
                // Use pip
                const cmd = `"${targetPython}" -m pip install ${packages.join(' ')} ${extraArgs.join(' ')}`;
                output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
                installed.push(...packages);
            }

            // Clear cache since packages changed
            this.clearCache();

            return { success: failed.length === 0, installed, failed, output };
        } catch (error: any) {
            return { 
                success: false, 
                installed, 
                failed: failed.length > 0 ? failed : packages, 
                output,
                error: error.message 
            };
        }
    }

    async validateConfig(): Promise<ConfigValidationResult> {
        const errors: ConfigValidationError[] = [];
        const warnings: ConfigValidationWarning[] = [];

        // Validate pythonPath if set
        if (this.config.pythonPath) {
            const { existsSync } = await import('fs');
            if (!existsSync(this.config.pythonPath)) {
                errors.push({
                    field: 'nuke.pythonPath',
                    message: 'Python executable does not exist',
                    value: this.config.pythonPath
                });
            } else {
                // Try to execute it
                try {
                    const { execSync } = await import('child_process');
                    execSync(`"${this.config.pythonPath}" --version`, { stdio: 'ignore' });
                } catch {
                    errors.push({
                        field: 'nuke.pythonPath',
                        message: 'File exists but is not a valid Python executable',
                        value: this.config.pythonPath
                    });
                }
            }
        }

        // Validate condaEnv if set
        if (this.config.condaEnv) {
            const condaPython = await this.findCondaPython(this.config.condaEnv);
            if (!condaPython) {
                warnings.push({
                    field: 'nuke.condaEnv',
                    message: `Conda environment '${this.config.condaEnv}' not found. Will try to auto-detect on use.`,
                    value: this.config.condaEnv
                });
            }
        }

        // Validate cross sections path
        const crossSections = process.env.OPENMC_CROSS_SECTIONS;
        if (crossSections) {
            const { existsSync } = await import('fs');
            if (!existsSync(crossSections)) {
                warnings.push({
                    field: 'OPENMC_CROSS_SECTIONS',
                    message: 'Cross sections file does not exist',
                    value: crossSections
                });
            }
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }

    async healthCheck(packages?: string[]): Promise<HealthCheckResult> {
        const checks: HealthCheckItem[] = [];

        // Check 1: Python availability
        const pythonCheck = await this.checkPythonHealth();
        checks.push(pythonCheck);

        // Check 2: Configuration validity
        const configValidation = await this.validateConfig();
        checks.push({
            name: 'Configuration',
            passed: configValidation.valid,
            message: configValidation.valid ? 'Configuration is valid' : 'Configuration has errors',
            severity: configValidation.valid ? undefined : 'error',
            suggestion: configValidation.errors.length > 0 ? 'Fix configuration errors in Settings → Nuke Utils' : undefined
        });

        // Check 3: Package availability (generic - checks any packages provided)
        if (packages && packages.length > 0) {
            try {
                const python = await this.getPythonCommand();
                if (python) {
                    const packageDeps = packages.map(p => ({ name: p, required: false }));
                    const result = await this.checkDependencies(packageDeps, python);
                    
                    for (const pkg of packages) {
                        const version = result.versions[pkg];
                        checks.push({
                            name: `Package: ${pkg}`,
                            passed: version !== undefined,
                            message: version ? `${pkg} ${version} available` : `${pkg} not found`,
                            severity: version ? undefined : 'warning',
                            suggestion: version ? undefined : `Install ${pkg} in your environment`
                        });
                    }
                }
            } catch {
                // Skip package checks if no Python
            }
        }

        const healthy = checks.every(c => c.passed || c.severity !== 'error');

        return { healthy, checks };
    }

    private async checkPythonHealth(): Promise<HealthCheckItem> {
        try {
            const result = await this.detectPythonWithRequirements({});
            if (result.success) {
                return {
                    name: 'Python',
                    passed: true,
                    message: `Environment available: ${result.environment?.version || result.command}`,
                };
            } else {
                return {
                    name: 'Python',
                    passed: false,
                    message: 'No environment found',
                    severity: 'error',
                    suggestion: 'Install Python or configure environment in Settings → Nuke Utils'
                };
            }
        } catch (error) {
            return {
                name: 'Python',
                passed: false,
                message: `Error checking environment: ${error}`,
                severity: 'error'
            };
        }
    }

    async getDiagnostics(): Promise<Record<string, unknown>> {
        const { execSync } = await import('child_process');
        const path = await import('path');

        const diagnostics: Record<string, unknown> = {
            timestamp: new Date().toISOString(),
            platform: process.platform,
            arch: process.arch,
            nodeVersion: process.version,
        };

        // Python info
        try {
            const python = await this.getPythonCommand();
            diagnostics['python'] = {
                command: python,
                environment: this.cachedEnvironment,
            };

            if (python) {
                const pythonInfo = diagnostics['python'] as Record<string, unknown>;
                try {
                    const version = execSync(`"${python}" --version`, { encoding: 'utf-8' }).trim();
                    pythonInfo['version'] = version;
                } catch (e: any) {
                    pythonInfo['versionError'] = e.message;
                }

                // Check pip
                try {
                    const pipVersion = execSync(`"${python}" -m pip --version`, { encoding: 'utf-8' }).trim();
                    diagnostics['pip'] = { version: pipVersion };
                } catch (e: any) {
                    diagnostics['pip'] = { error: e.message };
                }
            }
        } catch (e: any) {
            diagnostics['python'] = { error: e.message };
        }

        // Conda info
        try {
            const condaInfo = execSync('conda info --json', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
            diagnostics['conda'] = JSON.parse(condaInfo);
        } catch (e: any) {
            diagnostics['conda'] = { available: false, error: e.message };
        }

        // Environment variables
        diagnostics['env'] = {
            CONDA_PREFIX: process.env.CONDA_PREFIX,
            CONDA_DEFAULT_ENV: process.env.CONDA_DEFAULT_ENV,
            OPENMC_CROSS_SECTIONS: process.env.OPENMC_CROSS_SECTIONS,
            OPENMC_CHAIN_FILE: process.env.OPENMC_CHAIN_FILE,
            PATH: process.env.PATH?.split(path.delimiter).slice(0, 5),
        };

        // Config
        diagnostics['config'] = this.config;

        // Available environments
        try {
            const envs = await this.listEnvironments(true);
            diagnostics['environments'] = {
                count: envs.environments.length,
                selected: envs.selected,
                list: envs.environments.map(e => ({ name: e.name, type: e.type, version: e.version }))
            };
        } catch (e: any) {
            diagnostics['environments'] = { error: e.message };
        }

        return diagnostics;
    }

    // Private helpers

    private cachePythonResult(command: string, env?: PythonEnvironment): void {
        this.cachedPythonCommand = command;
        this.cachedEnvironment = env;
    }

    private clearCache(): void {
        this.cachedPythonCommand = undefined;
        this.cachedEnvironment = undefined;
        this.environmentsCache = undefined;
        this.environmentsCacheTime = undefined;
    }

    private async doDetectPython(): Promise<PythonDetectionResult> {
        return this.detectPythonWithRequirements({});
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
                        envInfo.envPath = env;
                        environments.push(envInfo);
                    }
                }
            }
        } catch {
            // Conda not available
        }
        
        return environments;
    }

    private async findWorkspaceVenvs(): Promise<PythonEnvironment[]> {
        const environments: PythonEnvironment[] = [];
        const { existsSync } = await import('fs');
        const path = await import('path');
        const os = await import('os');

        // Common venv directory names
        const venvNames = ['.venv', 'venv', 'env', '.env', 'virtualenv'];
        
        // Search in home directory and common locations
        const searchPaths = [os.homedir(), process.cwd()];
        
        // Also check parent directories up to 3 levels
        let currentDir = process.cwd();
        for (let i = 0; i < 3 && currentDir !== path.dirname(currentDir); i++) {
            searchPaths.push(currentDir);
            currentDir = path.dirname(currentDir);
        }

        const searched = new Set<string>();

        for (const basePath of searchPaths) {
            for (const venvName of venvNames) {
                const venvPath = path.join(basePath, venvName);
                if (searched.has(venvPath)) continue;
                searched.add(venvPath);

                if (!existsSync(venvPath)) continue;

                const isWindows = process.platform === 'win32';
                const pythonPath = isWindows
                    ? path.join(venvPath, 'Scripts', 'python.exe')
                    : path.join(venvPath, 'bin', 'python');

                if (existsSync(pythonPath)) {
                    const env = await this.getEnvironmentInfo(pythonPath, 'venv');
                    if (env) {
                        env.name = venvName === '.venv' || venvName === '.env' 
                            ? `${path.basename(basePath)} (${venvName})`
                            : venvName;
                        env.envPath = venvPath;
                        environments.push(env);
                    }
                }
            }
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
